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

  const isSantanderNative = !!(body.pdfBase64);

  const prompt = isSantanderNative
  ? `Extraia as transações desta fatura Santander. Retorne SOMENTE JSON válido, sem markdown.

{"banco":"Santander","titular":"Nome completo","mes_ano":"Abril 2026","vencimento":"08/04/2026","total":1473.89,"pessoas_detectadas":["Lucas","Viviane","Duda"],"grupos":[{"portador":"Nome portador","txs":[{"id":1,"data":"19/11","desc":"BELEZA NA WEB","parc":"05/06","val":80.87,"neg":false}]}],"pagamentos":[],"creditos":[]}

REGRAS:
- Leia o PDF diretamente. Extraia TODAS as transações do "Detalhamento da Fatura".
- Portador: nome antes do " - XXXX XXXX XXXX NNNN". Remova "@" inicial se houver. Cada portador vira um grupo separado.
- Parcela: campo "Parcela" da tabela (ex: "05/06"). null se vazio.
- val: valor numérico do campo "R$". Nunca 0 a não ser que seja realmente 0.
- Ignorar linha "PAGAMENTO DE FATURA" e "ANUIDADE DIFERENCIADA 0,00".
- neg: true apenas para estornos (valores negativos que NÃO sejam pagamento de fatura).
- pagamentos: vazio [] — pagamentos de fatura anterior são ignorados.
- pessoas_detectadas: primeiros nomes únicos de todos os portadores.
- total: "Total a Pagar" da fatura (número sem R$).
- mes_ano: mês/ano do vencimento (ex: "Abril 2026").`
  : `Extraia as transações desta fatura de cartão brasileiro. Retorne SOMENTE JSON válido, sem markdown.

{"banco":"Nome","titular":"Nome completo","mes_ano":"Março 2026","vencimento":"26/03/2026","total":1234.56,"pessoas_detectadas":["Nome1","Nome2"],"grupos":[{"portador":"Nome portador","txs":[{"id":1,"data":"18/02","desc":"Estabelecimento","parc":null,"val":99.90,"neg":false}]}],"pagamentos":[{"id":"p1","data":"25/02","desc":"Pagamento","val":3631.79}],"creditos":[]}

REGRAS GERAIS:
- portador = nome de pessoa (nunca CPF/CNPJ/número de cartão)
- desc = nome limpo sem prefixos técnicos
- neg = true apenas para estornos/créditos dentro de grupos; pagamentos de fatura vão em pagamentos[]
- NÃO incluir transações da seção "Compras parceladas - próximas faturas"; toda transação listada em portadores é da fatura atual
- id deve ser número único sequencial para txs; string "p1","p2"... para pagamentos; "c1","c2"... para créditos
- data: use o formato exato do PDF (ex: "10/03" ou "18 FEV")
- parc: null se não parcelado, ou a string exata da parcela (ex: "05/06" ou "02/04")
- total: valor total a pagar da fatura atual (número, sem R$)

ITAÚ / NUBANK:
- Portador identificado por "(final NNNN)" ou nome de seção
- Transações no formato "DD/MM DESCRIÇÃO [parc XX/YY] VALOR"
- Pagamentos identificados por linha com valor negativo ou seção "Pagamentos"
- IMPORTANTE: transações datadas em 01/04 ou qualquer data presente na seção de portadores pertencem a esta fatura atual — NÃO excluir por data
- NÃO incluir transações da seção "Compras parceladas - próximas faturas"
- "Repasse de IOF em R$ X,XX": incluir como transação do portador que fez a compra internacional, com desc "Repasse IOF Internacional", neg:false`;

  try {
    const messages = pdfText
      ? [{ role: "user", content: prompt + "\n\nTexto da fatura:\n" + pdfText }]
      : [{ role: "user", content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
          { type: "text", text: prompt }
        ]}];
    // For native PDF: use higher token budget to capture all transactions
    const maxTokens = pdfBase64 ? 8000 : 6000;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
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
