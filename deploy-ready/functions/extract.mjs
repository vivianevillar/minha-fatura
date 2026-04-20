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

  const { pdfBase64, pdfText, mode } = body;
  if (!pdfBase64 && !pdfText) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing pdfBase64 or pdfText" }) };
  }

  if (pdfBase64 && pdfBase64.length > 5_000_000) {
    return { statusCode: 413, body: JSON.stringify({ error: "PDF muito grande. Máximo ~3MB." }) };
  }

  const isSantanderNative = !!(body.pdfBase64);
  const isPortadorMode = mode === 'portador';

  // ============ PROMPT POR MODO ============
  let prompt;

  if (isPortadorMode) {
    // Modo chunked: um bloco de portador por chamada. Output pequeno, rápido.
    prompt = `Extraia as transações deste bloco de portador de fatura Itaú. Retorne SOMENTE JSON minificado.

FORMATO: {"portador":"NOME (final NNNN)","txs":[{"id":1,"data":"18/02","desc":"ESTABELECIMENTO","parc":null,"val":99.90,"neg":false}]}

REGRAS:
- portador: copie EXATAMENTE a linha "NOME (final NNNN)" que aparece no início do bloco
- id: número sequencial 1,2,3... começando em 1 neste bloco
- data: DD/MM conforme aparece (ex: "18/02", "10/03")
- desc: nome limpo do estabelecimento, SEM o código de parcela no final. Ex: "MERCADOLIVRE*5PROD01/02" → desc="MERCADOLIVRE*5PROD", parc="01/02"
- parc: string "NN/NN" se presente, senão null
- val: número decimal sem R$ (ex: 99.90)
- neg: true APENAS quando o valor aparece com sinal negativo ("- 52,50" ou "-0,04"). "-CT" ou "-CT L" na descrição NÃO indica estorno — é marcador de compra por aproximação NFC.
- Parcela embutida ao final do código: "MERCADOLIVRE*MERCA02/03" → parc="02/03". "ZEBRABABY 02/03" → parc="02/03"
- Cada linha DD/MM é uma transação independente — NUNCA combinar linhas
- IGNORAR linhas de totalizador: "Lançamentos no cartão (final NNNN)", "Total", sub-rótulos de categoria ("VESTUÁRIO", "ALIMENTAÇÃO" etc aparecem abaixo da linha de transação como metadata — não são transações)
- IGNORAR linhas de seção "Compras parceladas - próximas faturas" / "próxima fatura"
- Se o bloco tiver linhas como "Repasse de IOF em R$ X,XX" ou "OPENAI *CHATGPT" (lançamento internacional), incluir como transação normal com val=X.XX e data razoável
- Se a mesma compra parcelada aparecer duas vezes com N/M e N+1/M no bloco, manter apenas a MENOR (parcela atual)
- CRITICAL: MINIFIED JSON, single line, zero whitespace entre tokens.`;
  } else if (isSantanderNative) {
    prompt = `Extraia as transações desta fatura Santander. Retorne SOMENTE JSON válido, sem markdown.

{"banco":"Santander","titular":"Nome completo","mes_ano":"Abril 2026","vencimento":"21/04/2026","total":4547.66,"pessoas_detectadas":["Lucas","Viviane"],"grupos":[{"portador":"Nome portador","txs":[{"id":1,"data":"19/11","desc":"BELEZA NA WEB","parc":"05/06","val":80.87,"neg":false},{"id":2,"data":"26/03","desc":"IOF Despesa Exterior","parc":null,"val":21.18,"neg":false}]}],"pagamentos":[],"creditos":[{"id":"c1","data":"14/03","desc":"IFD*COMPANHIA BRASILEI","val":30.38}]}

REGRAS:
- Leia o PDF diretamente. Extraia TODAS as transações do "Detalhamento da Fatura".
- Portador: nome antes do " - XXXX XXXX XXXX NNNN". Remova "@" inicial se houver. Cada portador vira um grupo separado.
- Parcela: campo "Parcela" da tabela (ex: "05/06"). null se vazio.
- val: valor numérico do campo "R$". Nunca 0 a não ser que seja realmente 0.
- Ignorar linhas "PAGAMENTO DE FATURA" e "PAGAMENTO DE FATURA-INTERNET" (valores negativos de pagamento de fatura anterior).
- ANUIDADE DIFERENCIADA: incluir como transação normal se val > 0 (ex: 166,66). Ignorar SOMENTE se val = 0,00.
- IOF DESPESA NO EXTERIOR: cada linha "IOF DESPESA NO EXTERIOR" com valor (ex: 21,18) deve ser incluída como transação SEPARADA. Usar a mesma data da compra internacional acima dela. desc="IOF Despesa Exterior".
- COTAÇÃO DOLAR: ignorar (linha informativa, sem transação).
- Seção "Pagamento e Demais Créditos" de cada portador: ignorar "PAGAMENTO DE FATURA". Mas estornos/créditos de lojas (ex: "IFD*COMPANHIA BRASILEI -30,38") devem ir em creditos[] com id "c1","c2"..., data, desc, val (número positivo).
- neg: true apenas para estornos dentro da seção Despesas (valores negativos que NÃO sejam pagamento de fatura).
- pagamentos: vazio [] — pagamentos de fatura anterior são ignorados.
- pessoas_detectadas: primeiros nomes únicos de todos os portadores.
- total: "Total a Pagar" da fatura (número sem R$).
- mes_ano: mês/ano do vencimento (ex: "Abril 2026").
- CRITICAL: output MINIFIED JSON on a single line. Zero spaces, zero newlines, zero indentation. Example: {"a":1,"b":[2,3]} NOT { "a": 1 }`;
  } else {
    prompt = `Extraia as transações desta fatura de cartão brasileiro. Retorne SOMENTE JSON válido, sem markdown.

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
- NÃO incluir transações de próximas faturas. Se a mesma compra parcelada aparecer com parcela N/M e N+1/M, manter APENAS N/M (a parcela atual, menor número).
- Transação datada em 01/04 (dia de emissão da fatura) pertence a esta fatura — incluir normalmente. Ex: "01/04 ESTORNO DE ANUIDADE DIF - 52,50" → {data:"01/04", desc:"Estorno Anuidade", val:52.50, neg:true}. NÃO confundir com próxima fatura.
- Seção "Lançamentos: produtos e serviços" (ANUIDADE DIFERENCIADA, ESTORNO ANUIDADE) NÃO pertence a nenhum portador — deixar portador vazio ("").
- Seção "Lançamentos internacionais" (FLICKR, compras em moeda estrangeira): usar o portador da seção, mas se não houver portador ativo claro, deixar portador vazio ("").
- Linha "Repasse de IOF em R$ X,XX" (sem data DD/MM): OBRIGATÓRIO incluir como transação. Usar data "26/03", desc="Repasse IOF Internacional", parc=null, val=X.XX (número após "R$"), neg:false. Incluir no grupo LUCAS VILLAR (final 6857).
- "-CT" ou "-CT L" na descrição do estabelecimento indica compra por aproximação (NFC) — NÃO alterar a descrição, NÃO é estorno. neg:true SOMENTE quando o valor começa com "- " (traço-espaço-número), ex: "IFD COMPANHIA BRASILEI - 28,68" → neg:true, val=28.68. Exemplo correto: "XCA INOVA -CT 59,99" → desc="XCA INOVA -CT", neg:false, val=59.99
- Parcela embutida no código do estabelecimento: ex "BPP987221301/10" → parc="01/10" (leia os dois segmentos N/M ao FINAL do código, não os dígitos antes). "RN9872295610/10" → parc="10/10"
- NUNCA combine descrições de linhas adjacentes numa só transação. Cada linha DD/MM é uma transação independente.
- "Repasse de IOF em R$ X,XX": criar transação separada com desc="Repasse IOF Internacional", val=X,XX, neg:false, no grupo do portador que realizou a compra internacional
- CRITICAL: output MINIFIED JSON on a single line. Zero spaces, zero newlines, zero indentation. Example: {"a":1,"b":[2,3]} NOT { "a": 1 }`;
  }

  // Token cap menor para modo portador reduz tempo de geração (output é bem pequeno)
  const maxTokens = isPortadorMode ? 4096 : 16384;
  const systemMsg = isPortadorMode
    ? "Output ONLY minified JSON with portador and txs fields. Zero whitespace. Single line."
    : "Output ONLY minified JSON. Zero whitespace between tokens. No newlines. No indentation. No markdown. No explanation. Single line output.";

  try {
    const userContent = pdfText
      ? prompt + "\n\nTexto da fatura:\n" + pdfText
      : [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
          { type: "text", text: prompt }
        ];
    const messages = [
      { role: "user", content: userContent },
    ];

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: maxTokens,
        system: systemMsg,
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
    let stopReason = null;

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
          if (ev.type === "message_delta" && ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        } catch {}
      }
    }

    const wasTruncated = stopReason === "max_tokens";
    if (wasTruncated) {
      console.warn("Response truncated (max_tokens). Length:", fullText.length, "Attempting repair...");
    }
    console.log("Mode:", mode || "default", "| Stop reason:", stopReason, "| Response length:", fullText.length);

    let compacted = fullText.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();

    let parsed;
    try { parsed = JSON.parse(compacted); } catch {}

    if (!parsed) {
      const m = compacted.match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch {}
    }

    if (!parsed) {
      parsed = repairTruncatedJSON(compacted);
      if (parsed) console.log("JSON repaired successfully.");
    }

    if (!parsed) {
      console.error("Parse failed:", fullText.substring(0, 300));
      return { statusCode: 500, body: JSON.stringify({ error: "Falha ao interpretar resposta da IA. Tente novamente." }) };
    }

    // Estrutura mínima esperada conforme modo
    if (isPortadorMode) {
      if (!parsed.txs) parsed.txs = [];
      if (!parsed.portador) parsed.portador = '';
    } else {
      if (!parsed.grupos) parsed.grupos = [];
      if (!parsed.pagamentos) parsed.pagamentos = [];
      if (!parsed.creditos) parsed.creditos = [];
    }

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed) };

  } catch (err) {
    console.error("Error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

/**
 * Repair truncated JSON from LLM output by closing open brackets/braces.
 */
function repairTruncatedJSON(text) {
  let s = text;

  let inString = false;
  let lastQuoteIdx = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"' && (i === 0 || s[i-1] !== '\\')) {
      inString = !inString;
      if (inString) lastQuoteIdx = i;
    }
  }

  if (inString && lastQuoteIdx >= 0) {
    let cutPoint = lastQuoteIdx;
    while (cutPoint > 0 && s[cutPoint-1] !== ',' && s[cutPoint-1] !== '[' && s[cutPoint-1] !== '{') cutPoint--;
    if (cutPoint > 0 && s[cutPoint-1] === ',') cutPoint--;
    s = s.substring(0, cutPoint);
  }

  s = s.replace(/,\s*$/, '');

  const stack = [];
  inString = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"' && (i === 0 || s[i-1] !== '\\')) { inString = !inString; continue; }
    if (inString) continue;
    if (s[i] === '{') stack.push('}');
    if (s[i] === '[') stack.push(']');
    if (s[i] === '}' || s[i] === ']') {
      if (stack.length > 0) stack.pop();
    }
  }

  s = s + stack.reverse().join('');

  try {
    return JSON.parse(s);
  } catch (e) {
    console.error("Repair failed:", e.message, "| Tail:", s.slice(-200));
    return null;
  }
}
