import { getStore } from "@netlify/blobs";

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

  const { pdfBase64, jobId } = body;
  if (!pdfBase64 || !jobId) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing fields" }) };
  }

  const store = getStore("jobs");

  const prompt = `Extraia as transações desta fatura de cartão brasileiro. Retorne SOMENTE JSON válido, sem markdown.

{"banco":"Nome","titular":"Nome completo","mes_ano":"Março 2026","vencimento":"26/03/2026","total":1234.56,"pessoas_detectadas":["Nome1"],"grupos":[{"portador":"Nome portador","txs":[{"id":1,"data":"18 FEV","desc":"Estabelecimento","parc":null,"val":99.90,"neg":false}]}],"pagamentos":[{"id":"p1","data":"25 FEV","desc":"Pagamento","val":3631.79}],"creditos":[]}

Regras: portador=nome de pessoa em seção da fatura (nunca CPF/CNPJ). desc=nome limpo sem prefixos. neg=true para estornos. NÃO incluir próximas faturas.`;

  try {
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
        messages: [{ role: "user", content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
          { type: "text", text: prompt }
        ]}]
      }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split("\n")) {
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
    for (const a of [
      fullText.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim(),
      (fullText.match(/\{[\s\S]*\}/) || [])[0],
    ]) {
      if (!a) continue;
      try { parsed = JSON.parse(a); break; } catch {}
    }

    if (!parsed) {
      await store.setJSON(jobId, { status: "error", error: "Falha ao interpretar resposta da IA." });
    } else {
      await store.setJSON(jobId, { status: "done", result: parsed });
    }
  } catch (err) {
    await store.setJSON(jobId, { status: "error", error: err.message });
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
}
