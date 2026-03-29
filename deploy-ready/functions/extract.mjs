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
  const prompt = `Voce e um extrator de faturas de cartao de credito brasileiro. Analise o texto abaixo e retorne SOMENTE no formato especificado, sem markdown, sem JSON, sem explicacoes.

FORMATO DE SAIDA:
BANCO:<nome do banco>
TITULAR:<nome do titular principal>
MES:<mes e ano, ex: Abril 2026>
VENC:<DD/MM/AAAA>
TOTAL:<valor numerico com ponto, ex: 3148.70>
===
PORTADOR:<nome exato do portador como aparece na fatura>
DD/MM|Descricao limpa|parcela ou vazio|valor|N ou S
DD/MM|Descricao limpa||valor|S
===
PORTADOR:<proximo portador se houver>
DD/MM|Descricao limpa||valor|N

INSTRUCOES:
- Extraia TODAS as transacoes de compras. Nao invente dados.
- PORTADOR no Nubank: linha tipo "Viviane Villar R$ 3.148,69" -> use "Viviane Villar"
- PORTADOR no Itau: linha tipo "AUGUSTO DO V S ROZA (final 5140)" -> use exatamente esse texto
- Datas: converter mes abreviado para numero (JAN=01 FEV=02 MAR=03 ABR=04 MAI=05 JUN=06 JUL=07 AGO=08 SET=09 OUT=10 NOV=11 DEZ=12)
- Parcela: se vier "Parcela 2/4" na descricao, coloque 02/04 no campo parcela e remova da descricao
- Ultima coluna: N=compra normal, S=estorno ou credito (valor negativo)
- val: sempre positivo com ponto decimal
- desc: remover "••••XXXX", "Parcela X/Y", "Estorno de", aspas, IOF de
- NAO incluir: pagamentos recebidos, proximas faturas, encargos, IOF de compra
- NAO repetir transacoes ja listadas`;

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

    console.log("INPUT CHARS:", pdfText ? pdfText.length : "base64");
    console.log("INPUT PREVIEW:", pdfText ? pdfText.substring(0, 400) : "n/a");
    console.log("RAW OUTPUT:", fullText.substring(0, 800));

    // Converter formato CSV para JSON esperado pelo frontend
    const parsed = parseCsvFormat(fullText.trim());
    if (!parsed) {
      console.error("Parse failed:", fullText.substring(0, 300));
      return { statusCode: 500, body: JSON.stringify({ error: "Falha ao interpretar resposta da IA. Tente novamente." }) };
    }

    // Deduplicar: mesma data+desc+valor com parcelas diferentes = manter so a menor parcela
    deduplicar(parsed);

    // Ordenar transações por data dentro de cada grupo
    const mesAtual = parsed.vencimento ? parseInt(parsed.vencimento.split("/")[1]) : 3;
    parsed.grupos.forEach(g => {
      g.txs.sort((a, b) => {
        const toNum = d => {
          if (!d || !d.includes("/")) return 9999;
          const [dia, mes] = d.split("/").map(Number);
          // Meses maiores que o mês de vencimento são do ano anterior
          const m = mes > mesAtual ? mes - 12 : mes;
          return m * 100 + dia;
        };
        return toNum(a.data) - toNum(b.data);
      });
    });

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

function deduplicar(parsed) {
  // Dedup global: chave = data + valor + inicio da desc
  // Mantém a transação com menor numero de parcela (a da fatura atual)
  const global = new Map();

  parsed.grupos.forEach(grupo => {
    const unicas = [];
    grupo.txs.forEach(tx => {
      const descKey = tx.desc.toLowerCase().replace(/\s+/g," ").substring(0,20);
      const key = `${tx.data}|${Math.round(tx.val*100)}|${descKey}`;
      const parcNum = tx.parc ? parseInt(tx.parc.split("/")[0]) || 99 : 99;

      if (!global.has(key)) {
        global.set(key, { tx, parcNum, grupo: unicas });
        unicas.push(tx);
      } else {
        const prev = global.get(key);
        if (parcNum < prev.parcNum) {
          // Esta parcela é menor (mais atual) — substituir
          const idx = prev.grupo.indexOf(prev.tx);
          if (idx >= 0) prev.grupo.splice(idx, 1, tx);
          global.set(key, { tx, parcNum, grupo: unicas });
          unicas.push(tx);
          // Remover do grupo anterior se for diferente
          if (prev.grupo !== unicas) {
            const i2 = prev.grupo.indexOf(tx);
            if (i2 >= 0) prev.grupo.splice(i2, 1);
          }
        }
        // se parcela maior ou igual, descartar
      }
    });
    grupo.txs = unicas;
  });

  // Renumerar IDs sequencialmente
  let id = 1;
  parsed.grupos.forEach(g => g.txs.forEach(t => { t.id = id++; }));
  console.log("Apos dedup:", id - 1, "transacoes");
}
