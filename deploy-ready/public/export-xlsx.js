/**
 * Minha Fatura Organizada — export Excel formatado
 * ====================================================
 *
 * Requer xlsx-js-style. No seu index.html, adicione ANTES deste script:
 *
 *   <script src="https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js"></script>
 *   <script src="export-xlsx.js"></script>
 *
 * Uso:
 *   MinhaFaturaExport.exportFatura(fatura, state);
 *
 * onde:
 *   fatura = objeto retornado pela API: { banco, mes_ano, total, titular, vencimento,
 *                                         grupos: [{portador, txs:[{id,data,desc,val,parc,neg}]}],
 *                                         pagamentos: [{id,data,desc,val}],
 *                                         creditos:   [{id,data,desc,val}] }
 *   state  = { people, assigns, payAssigns, payDeduct, creditAssigns,
 *              txCats, txNotes, txAlias }
 *
 * Gera 4 abas: Despesas · Pagamentos e Créditos · Por Pessoa · Por Categoria
 */

(function (global) {
  'use strict';

  // ---------- Paleta por banco ----------
  const BANK_COLORS = {
    nubank:    { primary: '820AD1', light: 'F3E8FB' },
    'itaú':    { primary: '003087', light: 'E6ECF5' },
    itau:      { primary: '003087', light: 'E6ECF5' },
    santander: { primary: 'EC0000', light: 'FDE7E7' },
    bradesco:  { primary: 'CC092F', light: 'F9E5EA' },
    inter:     { primary: 'FF7A00', light: 'FFEEE0' },
    default:   { primary: '1F2937', light: 'F3F4F6' }
  };

  // Paleta de cores por pessoa (mesmas do app)
  const PERSON_PALETTE = [
    { fg: '0C3D7A', bg: 'E8F1FC' },
    { fg: '7A4800', bg: 'FEF3E2' },
    { fg: '1A4A10', bg: 'EAF5E6' },
    { fg: '6A1545', bg: 'FCE8F3' },
    { fg: '0A4A3E', bg: 'E2F5F0' },
    { fg: '6A2808', bg: 'FDF0E8' }
  ];

  const MESES_PT = {
    jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
    jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
    janeiro: 1, fevereiro: 2, 'março': 3, marco: 3, abril: 4,
    maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9,
    outubro: 10, novembro: 11, dezembro: 12
  };

  // ---------- Helpers ----------
  function colorsFor(bank) {
    if (!bank) return BANK_COLORS.default;
    const k = String(bank).toLowerCase();
    for (const key of Object.keys(BANK_COLORS)) {
      if (key !== 'default' && k.indexOf(key) >= 0) return BANK_COLORS[key];
    }
    return BANK_COLORS.default;
  }

  function parseMesAno(s) {
    if (!s || typeof s !== 'string') return null;
    const parts = s.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const mes = MESES_PT[parts[0].toLowerCase()];
    const ano = parseInt(parts[parts.length - 1], 10);
    if (!mes || isNaN(ano)) return null;
    return { month: mes, year: ano };
  }

  function parseTxDate(raw, faturaRef) {
    if (raw instanceof Date) return raw;
    if (!raw || typeof raw !== 'string') return raw;
    const s = raw.trim();

    // "14 MAR" ou "14 Mar"
    const m1 = s.match(/^(\d{1,2})\s+([A-Za-zÇçãõéêíóÁÉÍÓÚ]+)\.?$/);
    if (m1 && faturaRef) {
      const dia = parseInt(m1[1], 10);
      const mes = MESES_PT[m1[2].toLowerCase().replace('.', '')];
      if (mes && dia >= 1 && dia <= 31) {
        let ano = faturaRef.year;
        if (mes > faturaRef.month) ano = faturaRef.year - 1;
        return new Date(ano, mes - 1, dia);
      }
    }

    // "14/03" ou "14/03/2026"
    const m2 = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (m2) {
      const dia = parseInt(m2[1], 10);
      const mes = parseInt(m2[2], 10);
      let ano = m2[3] ? parseInt(m2[3], 10)
                      : (faturaRef ? faturaRef.year : new Date().getFullYear());
      if (ano < 100) ano += 2000;
      if (faturaRef && !m2[3] && mes > faturaRef.month) ano = faturaRef.year - 1;
      if (mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31) {
        return new Date(ano, mes - 1, dia);
      }
    }

    return s;
  }

  function sanitizeFilename(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  }

  function r2(v) { return Math.round(v * 100) / 100; }

  // ---------- Cálculo de totais (réplica de buildTotals do index.html) ----------
  function buildTotals(fatura, state) {
    const totals = {};
    (state.people || []).forEach(p => {
      totals[p.name] = { spend: 0, paid: 0, credit: 0, n: 0, cats: {} };
    });

    function add(name, val, cat, tx) {
      if (!totals[name]) return;
      totals[name].spend += val;
      totals[name].n++;
      if (!totals[name].cats[cat]) totals[name].cats[cat] = { val: 0, txs: [] };
      totals[name].cats[cat].val += val;
      totals[name].cats[cat].txs.push(tx);
    }

    (fatura.grupos || []).forEach(g => {
      (g.txs || []).forEach(t => {
        const a = state.assigns[t.id];
        if (!a) return;
        const cat = state.txCats[t.id] || 'Sem categoria';
        const v = t.neg ? -Math.abs(t.val) : Math.abs(t.val);
        if (a.type === 'single') add(a.person, v, cat, t);
        else if (a.type === 'split') {
          a.splits.forEach(s => {
            add(s.name, t.neg ? -Math.abs(s.val) : s.val, cat, t);
          });
        }
      });
    });

    (fatura.pagamentos || []).forEach(p => {
      if (!state.payDeduct[p.id]) return;
      const n = state.payAssigns[p.id];
      if (n && totals[n]) totals[n].paid += p.val;
    });

    (fatura.creditos || []).forEach(c => {
      const n = state.creditAssigns[c.id];
      if (n && totals[n]) totals[n].credit += c.val;
    });

    return totals;
  }

  // ---------- Estilos ----------
  function thinBorder(rgb) {
    const s = { style: 'thin', color: { rgb } };
    return { top: s, bottom: s, left: s, right: s };
  }
  function mediumTB(rgb) {
    const s = { style: 'medium', color: { rgb } };
    return { top: s, bottom: s };
  }

  function makeStyles(bankColor) {
    const BRL = 'R$ #,##0.00;[Red]-R$ #,##0.00';
    const PCT = '0.0%';
    const DATE = 'dd/mm/yyyy';

    return {
      BRL, PCT, DATE,
      title: {
        font: { bold: true, sz: 16, color: { rgb: bankColor.primary } },
        alignment: { horizontal: 'left', vertical: 'center' }
      },
      header: {
        font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
        fill: { fgColor: { rgb: bankColor.primary } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: thinBorder('FFFFFF')
      },
      cell:         { alignment: { vertical: 'center' }, border: thinBorder('E5E7EB') },
      cellAlt:      { fill: { fgColor: { rgb: 'F9FAFB' } }, alignment: { vertical: 'center' }, border: thinBorder('E5E7EB') },
      cellBRL:      { numFmt: BRL, alignment: { vertical: 'center', horizontal: 'right' }, border: thinBorder('E5E7EB') },
      cellBRLAlt:   { numFmt: BRL, fill: { fgColor: { rgb: 'F9FAFB' } }, alignment: { vertical: 'center', horizontal: 'right' }, border: thinBorder('E5E7EB') },
      cellDate:     { numFmt: DATE, alignment: { vertical: 'center', horizontal: 'center' }, border: thinBorder('E5E7EB') },
      cellDateAlt:  { numFmt: DATE, fill: { fgColor: { rgb: 'F9FAFB' } }, alignment: { vertical: 'center', horizontal: 'center' }, border: thinBorder('E5E7EB') },
      cellPct:      { numFmt: PCT, alignment: { vertical: 'center', horizontal: 'right' }, border: thinBorder('E5E7EB') },
      cellCenter:   { alignment: { vertical: 'center', horizontal: 'center' }, border: thinBorder('E5E7EB') },
      cellCenterAlt:{ fill: { fgColor: { rgb: 'F9FAFB' } }, alignment: { vertical: 'center', horizontal: 'center' }, border: thinBorder('E5E7EB') },
      total:        { font: { bold: true, sz: 11 }, fill: { fgColor: { rgb: bankColor.light } }, alignment: { vertical: 'center' }, border: mediumTB(bankColor.primary) },
      totalBRL:     { font: { bold: true, sz: 11 }, fill: { fgColor: { rgb: bankColor.light } }, numFmt: BRL, alignment: { vertical: 'center', horizontal: 'right' }, border: mediumTB(bankColor.primary) },
      totalPct:     { font: { bold: true, sz: 11 }, fill: { fgColor: { rgb: bankColor.light } }, numFmt: PCT, alignment: { vertical: 'center', horizontal: 'right' }, border: mediumTB(bankColor.primary) },
      totalCenter:  { font: { bold: true, sz: 11 }, fill: { fgColor: { rgb: bankColor.light } }, alignment: { vertical: 'center', horizontal: 'center' }, border: mediumTB(bankColor.primary) },
      infoLabel:    { font: { bold: true, color: { rgb: '6B7280' }, sz: 10 }, alignment: { vertical: 'center' } },
      infoValue:    { font: { sz: 11 }, alignment: { vertical: 'center' } },
      infoBRL:      { font: { bold: true, sz: 12 }, numFmt: BRL, alignment: { vertical: 'center', horizontal: 'left' } },
      personTag: (fg, bg) => ({
        fill: { fgColor: { rgb: bg } },
        font: { color: { rgb: fg }, bold: true, sz: 10 },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: thinBorder('E5E7EB')
      })
    };
  }

  // ---------- ABA 1: Despesas ----------
  function buildDespesasSheet(fatura, state, styles, faturaRef) {
    const XLSX = global.XLSX;
    const headers = ['Data', 'Descrição', 'Apelido', 'Parcela', 'Valor', 'Pessoa', 'Divisão', 'Categoria', 'Nota'];
    const tituloLinha = `Despesas — ${fatura.banco || ''} · ${fatura.mes_ano || ''}`;
    const aoa = [[tituloLinha], [], headers];

    const personIdx = {};
    (state.people || []).forEach((p, i) => { personIdx[p.name] = i % PERSON_PALETTE.length; });

    const rows = [];

    (fatura.grupos || []).forEach(g => {
      (g.txs || []).forEach(t => {
        const a = state.assigns[t.id];
        const dt = parseTxDate(t.data, faturaRef);
        const valor = t.neg ? -Math.abs(t.val) : Math.abs(t.val);
        const parc = t.parc || '';
        const cat = state.txCats[t.id] || '';
        const nota = state.txNotes[t.id] || '';
        const alias = state.txAlias[t.id] || '';

        if (!a) {
          rows.push({
            data: dt, desc: t.desc, alias, parc, valor,
            pessoa: '— sem atribuição', divisao: '', cat, nota,
            personIdx: null
          });
        } else if (a.type === 'single') {
          rows.push({
            data: dt, desc: t.desc, alias, parc, valor,
            pessoa: a.person, divisao: '100%', cat, nota,
            personIdx: personIdx[a.person]
          });
        } else if (a.type === 'split') {
          const totalTx = Math.abs(t.val);
          a.splits.forEach(s => {
            const vSplit = t.neg ? -Math.abs(s.val) : s.val;
            const pct = totalTx > 0 ? (s.val / totalTx) : 0;
            rows.push({
              data: dt, desc: t.desc, alias, parc, valor: vSplit,
              pessoa: s.name,
              divisao: (pct * 100).toFixed(0) + '%',
              cat, nota,
              personIdx: personIdx[s.name]
            });
          });
        }
      });
    });

    rows.sort((a, b) => {
      const da = a.data instanceof Date ? a.data.getTime() : Infinity;
      const db = b.data instanceof Date ? b.data.getTime() : Infinity;
      return da - db;
    });

    rows.forEach(r => {
      aoa.push([r.data, r.desc, r.alias, r.parc, r.valor, r.pessoa, r.divisao, r.cat, r.nota]);
    });

    const total = rows.reduce((s, r) => s + r.valor, 0);
    aoa.push([]);
    aoa.push(['', 'TOTAL', '', '', total, '', '', '', '']);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }];

    const tRef = XLSX.utils.encode_cell({ r: 0, c: 0 });
    if (ws[tRef]) ws[tRef].s = styles.title;

    const headerRow = 2;
    for (let c = 0; c < headers.length; c++) {
      const ref = XLSX.utils.encode_cell({ r: headerRow, c });
      if (ws[ref]) ws[ref].s = styles.header;
    }

    const dataStart = 3;
    const dataEnd = dataStart + rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      const r = dataStart + i;
      const isAlt = i % 2 === 1;
      const row = rows[i];

      const dRef = XLSX.utils.encode_cell({ r, c: 0 });
      if (ws[dRef]) {
        if (row.data instanceof Date) {
          ws[dRef].s = isAlt ? styles.cellDateAlt : styles.cellDate;
        } else {
          ws[dRef].s = isAlt ? styles.cellAlt : styles.cell;
        }
      }
      for (const c of [1, 2]) {
        const ref = XLSX.utils.encode_cell({ r, c });
        if (ws[ref]) ws[ref].s = isAlt ? styles.cellAlt : styles.cell;
      }
      const pcRef = XLSX.utils.encode_cell({ r, c: 3 });
      if (ws[pcRef]) ws[pcRef].s = isAlt ? styles.cellCenterAlt : styles.cellCenter;
      const vRef = XLSX.utils.encode_cell({ r, c: 4 });
      if (ws[vRef]) {
        ws[vRef].t = 'n';
        ws[vRef].s = isAlt ? styles.cellBRLAlt : styles.cellBRL;
      }
      const pRef = XLSX.utils.encode_cell({ r, c: 5 });
      if (ws[pRef]) {
        if (row.personIdx !== null && row.personIdx !== undefined) {
          const pal = PERSON_PALETTE[row.personIdx];
          ws[pRef].s = styles.personTag(pal.fg, pal.bg);
        } else {
          ws[pRef].s = {
            ...(isAlt ? styles.cellAlt : styles.cell),
            font: { italic: true, color: { rgb: '9CA3AF' } },
            alignment: { horizontal: 'center', vertical: 'center' }
          };
        }
      }
      const divRef = XLSX.utils.encode_cell({ r, c: 6 });
      if (ws[divRef]) ws[divRef].s = isAlt ? styles.cellCenterAlt : styles.cellCenter;
      for (const c of [7, 8]) {
        const ref = XLSX.utils.encode_cell({ r, c });
        if (ws[ref]) ws[ref].s = isAlt ? styles.cellAlt : styles.cell;
      }
    }

    const totalRow = dataEnd + 2;
    for (let c = 0; c < headers.length; c++) {
      const ref = XLSX.utils.encode_cell({ r: totalRow, c });
      if (!ws[ref]) continue;
      if (c === 4) ws[ref].s = styles.totalBRL;
      else ws[ref].s = styles.total;
    }

    ws['!cols'] = [
      { wch: 11 }, { wch: 34 }, { wch: 20 }, { wch: 8 }, { wch: 13 },
      { wch: 18 }, { wch: 9 }, { wch: 16 }, { wch: 28 }
    ];
    ws['!rows'] = [];
    ws['!rows'][0] = { hpt: 26 };
    ws['!rows'][headerRow] = { hpt: 26 };

    if (rows.length > 0) {
      ws['!autofilter'] = {
        ref: XLSX.utils.encode_range({
          s: { r: headerRow, c: 0 },
          e: { r: dataEnd, c: headers.length - 1 }
        })
      };
    }

    return ws;
  }

  // ---------- ABA 2: Pagamentos e Créditos ----------
  function buildPagCredSheet(fatura, state, styles, faturaRef) {
    const XLSX = global.XLSX;
    const pays = fatura.pagamentos || [];
    const creds = fatura.creditos || [];
    if (pays.length === 0 && creds.length === 0) return null;

    const headers = ['Data', 'Tipo', 'Descrição', 'Valor', 'Pessoa', 'Abatido da fatura?'];
    const aoa = [['Pagamentos e Créditos'], [], headers];

    const personIdx = {};
    (state.people || []).forEach((p, i) => { personIdx[p.name] = i % PERSON_PALETTE.length; });

    const rows = [];
    pays.forEach(p => {
      rows.push({
        data: parseTxDate(p.data, faturaRef),
        tipo: 'Pagamento', desc: p.desc,
        valor: -Math.abs(p.val),
        pessoa: state.payAssigns[p.id] || '— sem atribuição',
        abatido: state.payDeduct[p.id] ? 'Sim' : 'Não',
        personIdx: state.payAssigns[p.id] ? personIdx[state.payAssigns[p.id]] : null
      });
    });
    creds.forEach(c => {
      rows.push({
        data: parseTxDate(c.data, faturaRef),
        tipo: 'Crédito', desc: c.desc,
        valor: -Math.abs(c.val),
        pessoa: state.creditAssigns[c.id] || '— sem atribuição',
        abatido: '—',
        personIdx: state.creditAssigns[c.id] ? personIdx[state.creditAssigns[c.id]] : null
      });
    });

    rows.sort((a, b) => {
      const da = a.data instanceof Date ? a.data.getTime() : Infinity;
      const db = b.data instanceof Date ? b.data.getTime() : Infinity;
      return da - db;
    });

    rows.forEach(r => aoa.push([r.data, r.tipo, r.desc, r.valor, r.pessoa, r.abatido]));

    const total = rows.reduce((s, r) => s + r.valor, 0);
    aoa.push([]);
    aoa.push(['', 'TOTAL', '', total, '', '']);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }];
    const tRef = XLSX.utils.encode_cell({ r: 0, c: 0 });
    if (ws[tRef]) ws[tRef].s = styles.title;

    const headerRow = 2;
    for (let c = 0; c < headers.length; c++) {
      const ref = XLSX.utils.encode_cell({ r: headerRow, c });
      if (ws[ref]) ws[ref].s = styles.header;
    }

    const dataStart = 3;
    const dataEnd = dataStart + rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      const r = dataStart + i;
      const isAlt = i % 2 === 1;
      const row = rows[i];

      const dRef = XLSX.utils.encode_cell({ r, c: 0 });
      if (ws[dRef]) {
        if (row.data instanceof Date) {
          ws[dRef].s = isAlt ? styles.cellDateAlt : styles.cellDate;
        } else {
          ws[dRef].s = isAlt ? styles.cellAlt : styles.cell;
        }
      }
      const tpRef = XLSX.utils.encode_cell({ r, c: 1 });
      if (ws[tpRef]) ws[tpRef].s = isAlt ? styles.cellCenterAlt : styles.cellCenter;
      const descRef = XLSX.utils.encode_cell({ r, c: 2 });
      if (ws[descRef]) ws[descRef].s = isAlt ? styles.cellAlt : styles.cell;
      const vRef = XLSX.utils.encode_cell({ r, c: 3 });
      if (ws[vRef]) {
        ws[vRef].t = 'n';
        ws[vRef].s = isAlt ? styles.cellBRLAlt : styles.cellBRL;
      }
      const pRef = XLSX.utils.encode_cell({ r, c: 4 });
      if (ws[pRef]) {
        if (row.personIdx !== null && row.personIdx !== undefined) {
          const pal = PERSON_PALETTE[row.personIdx];
          ws[pRef].s = styles.personTag(pal.fg, pal.bg);
        } else {
          ws[pRef].s = {
            ...(isAlt ? styles.cellAlt : styles.cell),
            font: { italic: true, color: { rgb: '9CA3AF' } },
            alignment: { horizontal: 'center', vertical: 'center' }
          };
        }
      }
      const abRef = XLSX.utils.encode_cell({ r, c: 5 });
      if (ws[abRef]) ws[abRef].s = isAlt ? styles.cellCenterAlt : styles.cellCenter;
    }

    const totalRow = dataEnd + 2;
    for (let c = 0; c < headers.length; c++) {
      const ref = XLSX.utils.encode_cell({ r: totalRow, c });
      if (!ws[ref]) continue;
      if (c === 3) ws[ref].s = styles.totalBRL;
      else ws[ref].s = styles.total;
    }

    ws['!cols'] = [{ wch: 11 }, { wch: 12 }, { wch: 36 }, { wch: 13 }, { wch: 18 }, { wch: 18 }];
    ws['!rows'] = [];
    ws['!rows'][0] = { hpt: 26 };
    ws['!rows'][headerRow] = { hpt: 26 };

    return ws;
  }

  // ---------- ABA 3: Por Pessoa ----------
  function buildPorPessoaSheet(fatura, state, styles) {
    const XLSX = global.XLSX;
    const totals = buildTotals(fatura, state);
    const people = state.people || [];

    const aoa = [
      ['Resumo por Pessoa'], [],
      ['Banco',          fatura.banco || '—'],
      ['Mês',            fatura.mes_ano || '—'],
      ['Vencimento',     fatura.vencimento || '—'],
      ['Titular',        fatura.titular || '—'],
      ['Total da fatura', typeof fatura.total === 'number' ? fatura.total : 0],
      [],
      ['Pessoa', 'Nº Lançamentos', 'Gastos', 'Pagou', 'Crédito', 'Líquido a pagar']
    ];

    const personIdx = {};
    people.forEach((p, i) => { personIdx[p.name] = i % PERSON_PALETTE.length; });

    const sorted = people.slice().sort((a, b) => {
      const la = r2(totals[a.name].spend - totals[a.name].paid - totals[a.name].credit);
      const lb = r2(totals[b.name].spend - totals[b.name].paid - totals[b.name].credit);
      return lb - la;
    });

    sorted.forEach(p => {
      const data = totals[p.name];
      const liquido = r2(data.spend - data.paid - data.credit);
      aoa.push([p.name, data.n, data.spend, data.paid, data.credit, liquido]);
    });

    const totSpend = people.reduce((s, p) => s + totals[p.name].spend, 0);
    const totPaid  = people.reduce((s, p) => s + totals[p.name].paid, 0);
    const totCred  = people.reduce((s, p) => s + totals[p.name].credit, 0);
    const totLiq   = r2(totSpend - totPaid - totCred);
    const totN     = people.reduce((s, p) => s + totals[p.name].n, 0);
    aoa.push([]);
    aoa.push(['TOTAL', totN, totSpend, totPaid, totCred, totLiq]);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }];

    const tRef = XLSX.utils.encode_cell({ r: 0, c: 0 });
    if (ws[tRef]) ws[tRef].s = styles.title;

    // Info rows (r=2..6)
    for (let r = 2; r <= 6; r++) {
      const labelRef = XLSX.utils.encode_cell({ r, c: 0 });
      const valRef = XLSX.utils.encode_cell({ r, c: 1 });
      if (ws[labelRef]) ws[labelRef].s = styles.infoLabel;
      if (ws[valRef]) {
        if (r === 6) {
          ws[valRef].t = 'n';
          ws[valRef].s = styles.infoBRL;
        } else {
          ws[valRef].s = styles.infoValue;
        }
      }
    }

    const headerRow = 8;
    for (let c = 0; c < 6; c++) {
      const ref = XLSX.utils.encode_cell({ r: headerRow, c });
      if (ws[ref]) ws[ref].s = styles.header;
    }

    const dataStart = 9;
    const dataEnd = dataStart + sorted.length - 1;
    for (let i = 0; i < sorted.length; i++) {
      const r = dataStart + i;
      const isAlt = i % 2 === 1;
      const name = sorted[i].name;
      const pal = PERSON_PALETTE[personIdx[name]];

      const pRef = XLSX.utils.encode_cell({ r, c: 0 });
      if (ws[pRef]) ws[pRef].s = styles.personTag(pal.fg, pal.bg);

      const qRef = XLSX.utils.encode_cell({ r, c: 1 });
      if (ws[qRef]) ws[qRef].s = isAlt ? styles.cellCenterAlt : styles.cellCenter;

      for (const c of [2, 3, 4, 5]) {
        const ref = XLSX.utils.encode_cell({ r, c });
        if (ws[ref]) {
          ws[ref].t = 'n';
          ws[ref].s = isAlt ? styles.cellBRLAlt : styles.cellBRL;
        }
      }
    }

    const totalRow = dataEnd + 2;
    for (let c = 0; c < 6; c++) {
      const ref = XLSX.utils.encode_cell({ r: totalRow, c });
      if (!ws[ref]) continue;
      if (c === 1) ws[ref].s = styles.totalCenter;
      else if (c >= 2) ws[ref].s = styles.totalBRL;
      else ws[ref].s = styles.total;
    }

    ws['!cols'] = [{ wch: 22 }, { wch: 15 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 18 }];
    ws['!rows'] = [];
    ws['!rows'][0] = { hpt: 26 };
    ws['!rows'][headerRow] = { hpt: 28 };

    return ws;
  }

  // ---------- ABA 4: Por Categoria ----------
  function buildPorCategoriaSheet(fatura, state, styles) {
    const XLSX = global.XLSX;
    const totals = buildTotals(fatura, state);
    const people = state.people || [];

    const catAgg = {};
    people.forEach(p => {
      const cats = totals[p.name].cats || {};
      Object.keys(cats).forEach(catName => {
        if (!catAgg[catName]) catAgg[catName] = { val: 0, count: 0 };
        catAgg[catName].val += cats[catName].val;
        catAgg[catName].count += cats[catName].txs.length;
      });
    });

    const totalGasto = Object.values(catAgg).reduce((s, c) => s + c.val, 0);
    const sorted = Object.entries(catAgg).sort((a, b) => b[1].val - a[1].val);

    const headers = ['Categoria', 'Qtd Lançamentos', 'Total', '% do Gasto'];
    const aoa = [['Resumo por Categoria'], [], headers];

    sorted.forEach(([cat, data]) => {
      aoa.push([cat, data.count, data.val, totalGasto > 0 ? data.val / totalGasto : 0]);
    });

    const totN = sorted.reduce((s, [, d]) => s + d.count, 0);
    aoa.push([]);
    aoa.push(['TOTAL', totN, totalGasto, totalGasto > 0 ? 1 : 0]);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }];
    const tRef = XLSX.utils.encode_cell({ r: 0, c: 0 });
    if (ws[tRef]) ws[tRef].s = styles.title;

    const headerRow = 2;
    for (let c = 0; c < headers.length; c++) {
      const ref = XLSX.utils.encode_cell({ r: headerRow, c });
      if (ws[ref]) ws[ref].s = styles.header;
    }

    const dataStart = 3;
    const dataEnd = dataStart + sorted.length - 1;
    for (let i = 0; i < sorted.length; i++) {
      const r = dataStart + i;
      const isAlt = i % 2 === 1;
      const cRef = XLSX.utils.encode_cell({ r, c: 0 });
      if (ws[cRef]) ws[cRef].s = isAlt ? styles.cellAlt : styles.cell;
      const qRef = XLSX.utils.encode_cell({ r, c: 1 });
      if (ws[qRef]) ws[qRef].s = isAlt ? styles.cellCenterAlt : styles.cellCenter;
      const tRef2 = XLSX.utils.encode_cell({ r, c: 2 });
      if (ws[tRef2]) {
        ws[tRef2].t = 'n';
        ws[tRef2].s = isAlt ? styles.cellBRLAlt : styles.cellBRL;
      }
      const pRef = XLSX.utils.encode_cell({ r, c: 3 });
      if (ws[pRef]) {
        ws[pRef].t = 'n';
        ws[pRef].s = styles.cellPct;
      }
    }

    const totalRow = dataEnd + 2;
    for (let c = 0; c < headers.length; c++) {
      const ref = XLSX.utils.encode_cell({ r: totalRow, c });
      if (!ws[ref]) continue;
      if (c === 1) ws[ref].s = styles.totalCenter;
      else if (c === 2) ws[ref].s = styles.totalBRL;
      else if (c === 3) ws[ref].s = styles.totalPct;
      else ws[ref].s = styles.total;
    }

    ws['!cols'] = [{ wch: 22 }, { wch: 16 }, { wch: 14 }, { wch: 14 }];
    ws['!rows'] = [];
    ws['!rows'][0] = { hpt: 26 };
    ws['!rows'][headerRow] = { hpt: 26 };

    return ws;
  }

  // ---------- Principal ----------
  function exportFatura(fatura, state, opts = {}) {
    const XLSX = global.XLSX;
    if (!XLSX || !XLSX.utils) {
      throw new Error(
        'xlsx-js-style não carregado. Adicione <script src="https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js"></script> antes de export-xlsx.js'
      );
    }
    if (!fatura || !state) {
      throw new Error('exportFatura: fatura e state são obrigatórios');
    }

    const bankColor = colorsFor(fatura.banco);
    const styles = makeStyles(bankColor);
    const faturaRef = parseMesAno(fatura.mes_ano);

    const wb = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(wb, buildDespesasSheet(fatura, state, styles, faturaRef), 'Despesas');

    const pagCred = buildPagCredSheet(fatura, state, styles, faturaRef);
    if (pagCred) XLSX.utils.book_append_sheet(wb, pagCred, 'Pagamentos e Créditos');

    XLSX.utils.book_append_sheet(wb, buildPorPessoaSheet(fatura, state, styles), 'Por Pessoa');
    XLSX.utils.book_append_sheet(wb, buildPorCategoriaSheet(fatura, state, styles), 'Por Categoria');

    const fileName = opts.fileName || (
      `fatura_${sanitizeFilename(fatura.banco)}_${sanitizeFilename(fatura.mes_ano)}.xlsx`
    );

    XLSX.writeFile(wb, fileName);
    return fileName;
  }

  global.MinhaFaturaExport = {
    exportFatura,
    _internal: { BANK_COLORS, PERSON_PALETTE, parseMesAno, parseTxDate, buildTotals }
  };

})(typeof window !== 'undefined' ? window : globalThis);
