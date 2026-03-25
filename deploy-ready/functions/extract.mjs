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

  // Formato compacto CSV-like para reduzir tokens de output em ~60%
  const prompt = `Extraia os dados desta fatura de cartao brasileiro.
Retorne SOMENTE neste formato exato, sem markdown, sem JSON, sem texto extra:

BANCO:Itau
TITULAR:Nome Sobrenome
MES:Marco 2026
VENC:26/03/2026
TOTAL:1234.56
===
PORTADOR:Nome (final 5140)
18/02|Estabelecimento|01/03|99.90|N
20/02|Outro Gasto||45.00|N
21/02|Estorno Loja||30.00|S
===
PORTADOR:Outro Nome (final 3433)
15/02|Mercado||200.00|N

Regras:
- Ultima coluna: S=estorno/negativo, N=normal
- Parcela: formato 01/03 ou vazio se nao parcelado
- PORTADOR: nome da pessoa (nunca CPF/CNPJ/numero)
- NÃO incluir proximas faturas
- desc: nome curto e limpo`;

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
        max_tokens: 6000,
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

    // Converter formato CSV para JSON esperado pelo frontend
    const parsed = parseCsvFormat(fullText.trim());
    if (!parsed) {
      console.error("Parse failed:", fullText.substring(0, 300));
      return { statusCode: 500, body: JSON.stringify({ error: "Falha ao interpretar resposta da IA. Tente novamente." }) };
    }

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed) };

  } catch (err) {
    console.error("Error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

function parseCsvFormat(text) {
  try {
    const result = {
      banco: "", titular: "", mes_ano: "", vencimento: "",
      total: 0, pessoas_detectadas: [], grupos: [], pagamentos: [], creditos: []
    };

    const sections = text.split(/^===$/m).map(s => s.trim()).filter(Boolean);
    if (!sections.length) return null;

    // Cabeçalho
    const header = sections[0];
    for (const line of header.split("\n")) {
      const [key, ...rest] = line.split(":");
      const val = rest.join(":").trim();
      if (key === "BANCO") result.banco = val;
      else if (key === "TITULAR") result.titular = val;
      else if (key === "MES") result.mes_ano = val;
      else if (key === "VENC") result.vencimento = val;
      else if (key === "TOTAL") result.total = parseFloat(val.replace(",", ".")) || 0;
    }

    // Portadores
    let txId = 1;
    for (let i = 1; i < sections.length; i++) {
      const lines = sections[i].split("\n").filter(Boolean);
      if (!lines.length) continue;

      const portadorLine = lines[0];
      if (!portadorLine.startsWith("PORTADOR:")) continue;
      const portador = portadorLine.replace("PORTADOR:", "").trim();

      if (!result.pessoas_detectadas.includes(portador.split(" (")[0].split(" ")[0])) {
        result.pessoas_detectadas.push(portador.split(" (")[0].split(" ")[0]);
      }

      const txs = [];
      for (let j = 1; j < lines.length; j++) {
        const parts = lines[j].split("|");
        if (parts.length < 4) continue;
        const [data, desc, parc, valStr, negFlag] = parts;
        const val = parseFloat(valStr.replace(",", ".")) || 0;
        if (!val) continue;
        txs.push({
          id: txId++,
          data: data.trim(),
          desc: desc.trim(),
          parc: parc.trim() || null,
          val: val,
          neg: (negFlag || "").trim().toUpperCase() === "S"
        });
      }

      result.grupos.push({ portador, txs });
    }

    if (!result.grupos.length) return null;
    return result;
  } catch (e) {
    console.error("parseCsvFormat error:", e.message);
    return null;
  }
}
