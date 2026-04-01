export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "API key not configured" }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { pdfBase64, pdfText } = body;
  if (!pdfBase64 && !pdfText) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing pdfBase64 or pdfText" }) };
  }

  if (pdfBase64 && pdfBase64.length > 5_000_000) {
    return { statusCode: 413, body: JSON.stringify({ error: "PDF muito grande. Máximo ~3MB." }) };
  }

  const prompt = `Extraia as transações desta fatura de cartão brasileiro. Retorne SOMENTE JSON válido, sem markdown.

FORMATO DE SAÍDA:
{"banco":"Nome","titular":"Nome completo","mes_ano":"Março 2026","vencimento":"26/03/2026","total":1234.56,"pessoas_detectadas":["Nome1","Nome2"],"grupos":[{"portador":"Nome portador","txs":[{"id":1,"data":"18/02","desc":"Estabelecimento","parc":null,"val":99.90,"neg":false}]}],"pagamentos":[{"id":"p1","data":"25/02","desc":"Pagamento","val":3631.79}],"creditos":[]}

REGRAS GERAIS:
- portador = nome de pessoa (nunca CPF/CNPJ/número de cartão)
- desc = nome limpo sem prefixos técnicos
- neg = true apenas para estornos/créditos dentro de grupos; pagamentos de fatura vão em pagamentos[]
- NÃO incluir transações de próximas faturas
- id deve ser número único sequencial para txs; string "p1","p2"... para pagamentos; "c1","c2"... para créditos
- data: use o formato exato do PDF (ex: "10/03" ou "18 FEV")
- parc: null se não parcelado, ou a string exata da parcela (ex: "05/06" ou "02/04")
- total: valor total a pagar da fatura atual (número, sem R$)

ITAÚ / NUBANK:
- Portador identificado por "(final NNNN)" ou nome de seção
- Transações no formato "DD/MM DESCRIÇÃO [parc XX/YY] VALOR"
- Pagamentos identificados por linha com valor negativo ou seção "Pagamentos"

SANTANDER:
- Portador: linha no formato "NOME SOBRENOME - XXXX XXXX XXXX NNNN" (pode ter "@" no início, que indica cartão adicional — remova o "@" e use só o nome antes do " - ")
- Agrupe portadores com "@" como portadores separados; não mescle com o titular
- Transação: "DD/MM DESCRIÇÃO [PARC] VALOR" — PARC é opcional (ex: "05/06" = parcela 5 de 6)
- Linha com valor negativo (ex: "09/03 PAGAMENTO DE FATURA-INTERNET -1.522,20") → vai em pagamentos[], val=positivo
- Ignorar linhas com valor 0,00 (ex: ANUIDADE DIFERENCIADA)
- banco = "Santander"
- titular = nome do primeiro portador que NÃO tem "@"
- vencimento: buscar linha "Vencimento DD/MM/YYYY" ou "08/04/2026"
- total: buscar "Total a Pagar R$X.XXX,XX" ou "R$ 1.473,89" próximo a "Total"
- pessoas_detectadas: primeiros nomes únicos de todos os portadores`;

  try {
    const messages = pdfText
      ? [{ role: "user", content: prompt + "\n\nTexto da fatura:\n" + pdfText }]
      : [{ role: "user", content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
          { type: "text", text: prompt }
        ]}];

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 8000,
        stream: true,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return { statusCode: response.status, body: JSON.stringify({ error: `API error ${response.status}: ${err.substring(0,100)}` }) };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        try {
          const ev = JSON.parse(data);
          if (ev.type === "content_block_delta" && ev.delta?.text) fullText += ev.delta.text;
        } catch {}
      }
    }

    let parsed;
    for (const attempt of [
      fullText.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim(),
      (fullText.match(/\{[\s\S]*\}/) || [])[0],
    ]) {
      if (!attempt) continue;
      try { parsed = JSON.parse(attempt); break; } catch {}
    }

    if (!parsed) {
      console.error("Parse failed:", fullText.substring(0, 200));
      return { statusCode: 500, body: JSON.stringify({ error: "Falha ao interpretar resposta da IA. Tente novamente." }) };
    }

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed) };

  } catch (err) {
    console.error("Error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
