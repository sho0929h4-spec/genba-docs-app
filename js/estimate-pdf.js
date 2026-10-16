// js/estimate-pdf.js — 見積書（A4縦）を描画し、PDF（Blob）にする
// グローバル: window.EstimatePdf = { buildPages, preview, fit, toBlob, fileName, displayNumber }
// 紙面は旧「見積書作成ツール」(freee-quote-builder/templates/invoice.html) の写し:
//   レイアウト :395-515（.pd-* の pt 実測値）、罫線と合計 :1984-2077（pdRules / renderPaper）、社印 :1773-1816（hankoSvg）。
//   1ページ目17行・2ページ目以降31行・行高18pt、列幅 294/61.5/68/86.7pt、合計表・内訳・備考は最終ページの下に固定。
//   罫線は旧と同じく CSS border ではなく塗りの矩形（ここでは div）で描く（細線 0.27pt / 備考枠 0.45pt）。
// 新規: ロゴがあるときは社印の位置にロゴ、無ければ社印 SVG（EstimateLogic.hankoCols）。登録番号は orgs.registration_number。
// ユーザー入力が入るので、描画はすべて createElement + textContent（innerHTML は使わない）。CSS は .es- 接頭辞。
// 依存: EstimateLogic、PDF 化だけ html2canvas 1.4.1 / jsPDF 2.5.1（index.html で読み込む）
(function () {
  const EL = () => window.EstimateLogic;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PAGE_W_PT = 595.28, PAGE_H_PT = 841.89;
  const A4_PX = 794;
  const ROWS_P1 = 17, ROWS_CONT = 31, ROW = 18;
  const L = 42.5, R = 552.7;
  const ITEMS_TOP_P1 = 353.6, ITEMS_TOP_CONT = 101.6;
  const IMG_TIMEOUT_MS = 20000;

  /* ===== CSS（旧 :395-515。.pd- → .es-） ===== */
  const CSS = `
.es-page{position:relative;box-sizing:border-box;width:595.28pt;height:841.89pt;background:#fff;color:#000;font-family:'IPAPGothic','Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic','Noto Sans JP',sans-serif;font-size:9pt;line-height:1;font-weight:400;overflow:hidden;flex-shrink:0;text-align:left;box-shadow:0 4px 20px rgba(0,0,0,.14);-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.es-page *{box-sizing:border-box;font-weight:400;margin:0;padding:0;}
.es-page>*{position:absolute;}
.es-page table{border-collapse:collapse;table-layout:fixed;}
.es-page td,.es-page th{padding:0;border:0;vertical-align:middle;background:transparent;text-align:center;}
.es-rules{left:0;top:0;width:595.28pt;height:841.89pt;pointer-events:none;}
.es-rules>div{position:absolute;background:#000;}
.es-title{left:0;right:0;top:42.5pt;text-align:center;font-size:16pt;}
.es-client{left:42.5pt;top:100pt;font-size:14pt;white-space:nowrap;max-width:310pt;overflow:hidden;}
.es-client .es-hon{margin-left:3.8pt;}
.es-meta{left:360pt;top:101pt;width:192.7pt;}
.es-meta td{border:0;height:16pt;vertical-align:top;white-space:nowrap;text-align:left;}
.es-meta td.es-v{text-align:right;}
.es-co-name{left:360pt;top:190pt;width:192.7pt;font-size:12pt;overflow-wrap:anywhere;line-height:1.1;}
.es-co-body{left:360pt;top:208.45pt;width:192.7pt;line-height:12.7pt;}
.es-co-body>div{white-space:nowrap;overflow:hidden;}
.es-hanko-box{left:493pt;top:190pt;width:60pt;height:60pt;line-height:0;display:flex;justify-content:flex-end;align-items:flex-start;}
.es-hanko{width:60pt;height:60pt;display:block;}
.es-logo{display:block;max-width:60pt;max-height:60pt;width:auto;height:auto;}
.es-greeting{left:42.5pt;top:237pt;}
.es-subject-l{left:42.5pt;top:255pt;font-size:12pt;}
.es-subject-v{left:78.5pt;top:255pt;width:258pt;height:28pt;font-size:12pt;line-height:14pt;overflow:hidden;overflow-wrap:anywhere;word-break:break-all;}
.es-summary{left:42.5pt;top:287.6pt;width:294pt;}
.es-summary th{height:18pt;}
.es-summary td{height:25.3pt;text-align:right;padding-right:4pt;}
.es-summary td.es-sum-total{font-size:16pt;}
.es-items{left:42.5pt;top:353.6pt;width:510.2pt;}
.es-items.es-cont{top:101.6pt;}
.es-items th,.es-items td{height:18pt;padding:0 4pt;white-space:nowrap;overflow:hidden;}
.es-items td.es-c-desc{text-align:left;}
.es-fit{overflow:hidden;white-space:nowrap;}
.es-items td.es-two .es-fit{line-height:10pt;}
.es-fit-sub{line-height:7.5pt;font-size:6.5pt;color:#444;overflow:hidden;white-space:nowrap;}
.es-items td.es-c-qty{text-align:right;padding-right:18pt;}
.es-items td.es-c-price,.es-items td.es-c-amt{text-align:right;}
.es-bd{left:336.5pt;top:696.9pt;width:216.2pt;}
.es-bd td{vertical-align:top;padding-top:4pt;text-align:left;}
.es-bd .es-r1 td{height:16pt;}
.es-bd .es-r2 td{height:14.4pt;font-size:6pt;}
.es-bd td.es-num{text-align:right;padding-right:4.7pt;}
.es-notes{left:42.5pt;top:737.3pt;width:510.2pt;height:62pt;padding:4pt 16pt !important;overflow:hidden;}
.es-notes-b{margin-top:3pt !important;height:42pt;line-height:12.9pt;white-space:pre-wrap;overflow:hidden;overflow-wrap:anywhere;}
.es-pageno{left:0;right:0;top:812pt;text-align:center;}
.es-run-l{left:42.5pt;top:42.5pt;width:290pt;white-space:nowrap;overflow:hidden;}
.es-run-r{left:342.5pt;top:42.5pt;width:210.2pt;text-align:right;white-space:nowrap;}
.es-preview{display:flex;flex-direction:column;align-items:center;gap:28px;padding:24px;background:#d8dfe8;overflow-x:hidden;}
.es-capture .es-page{box-shadow:none;}
@media (max-width:640px){.es-preview{padding:12px;gap:18px;align-items:flex-start;}}
`;
  function injectCss() {
    if (document.getElementById('es-style')) return;
    const s = document.createElement('style');
    s.id = 'es-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ===== 小物 ===== */
  const str = v => (v == null ? '' : String(v));
  const trim = v => str(v).trim();
  const BLANK = '　'; // 旧: 空欄は全角スペース
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null && text !== '') e.textContent = String(text);
    return e;
  }
  function pos(e, style) { Object.assign(e.style, style); return e; }
  const fmt = n => EL().fmt(n);
  function displayNumber(est) {
    const n = trim(est && est.number);
    if (!n) return '';
    const v = Number(est.version) || 1;
    return v >= 2 ? `${n}-v${v}` : n;
  }
  const isAdjust = l => l && l.description === '値引き' && !!l.postTax;
  // 旧 cleanDesc :2252（先頭の箇条書き記号・連番を落とす。【】は残す）
  function cleanDesc(s) {
    return str(s)
      .replace(/^[\s　・•●■□▶▸→⇒▼▽◆◇※◎○「」〔〕（）]+/, '')
      .replace(/^[0-9０-９]{1,3}[.．、)）:：]?[\s　]+/, '')
      .replace(/^[0-9０-９]{1,3}[.．、)）][\s　]*(?![0-9０-９])/, '')
      .replace(/[\s　]+/g, ' ')
      .trim();
  }

  /* ===== 罫線（旧 pdRules / pdItemRules。座標は線の中心） ===== */
  function rules(parts) {
    const box = el('div', 'es-rules');
    const rect = (x, y, w, h) => box.appendChild(pos(el('div'), { left: x + 'pt', top: y + 'pt', width: w + 'pt', height: h + 'pt' }));
    const H = (x0, x1, y, w) => rect(x0 - w / 2, y - w / 2, (x1 - x0) + w, w);
    const V = (x, y0, y1, w) => rect(x - w / 2, y0 - w / 2, w, (y1 - y0) + w);
    parts.forEach(p => {
      const w = p.w || 0.27;
      H(p.x0, p.x1, p.y0, w); H(p.x0, p.x1, p.y1, w);
      V(p.x0, p.y0, p.y1, w); V(p.x1, p.y0, p.y1, w);
      (p.vs || []).forEach(x => V(x, p.y0, p.y1, w));
      (p.hs || []).forEach(y => H(p.x0, p.x1, y, w));
    });
    return box;
  }
  function itemRules(top, n) {
    const hs = [];
    for (let k = 1; k <= n; k++) hs.push(top + ROW * k);
    return { x0: L, x1: R, y0: top, y1: top + ROW * (n + 1), vs: [336.5, 398.0, 466.0], hs };
  }

  /* ===== 社印（旧 hankoSvg :1806。座標は EstimateLogic.hankoCols） ===== */
  function hankoSvg(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'es-hanko');
    svg.setAttribute('width', '80');
    svg.setAttribute('height', '80');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('aria-label', '社印');
    const r = document.createElementNS(SVG_NS, 'rect');
    [['x', 5], ['y', 5], ['width', 90], ['height', 90], ['rx', 7], ['fill', 'none'], ['stroke', '#c2202a'], ['stroke-width', 4]]
      .forEach(([k, v]) => r.setAttribute(k, String(v)));
    svg.appendChild(r);
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('fill', '#c2202a');
    g.setAttribute('font-family', "'Hiragino Mincho Pro','Hiragino Mincho ProN','Yu Mincho',serif");
    g.setAttribute('font-weight', '700');
    g.setAttribute('text-anchor', 'middle');
    const cols = EL().hankoCols(name);
    [cols.left, cols.right].forEach(col => col.chars.forEach(ch => {
      const tx = document.createElementNS(SVG_NS, 'text');
      tx.setAttribute('x', String(col.x));
      tx.setAttribute('y', String(ch.y));
      tx.setAttribute('font-size', String(ch.fs));
      tx.textContent = ch.c;
      g.appendChild(tx);
    }));
    svg.appendChild(g);
    return svg;
  }

  /* ===== 入力の正規化・ページ分割 ===== */
  function prepare(est, caseRow, org, logoUrl) {
    injectCss();
    const e = est || {};
    const d = e.data || {};
    const lines = Array.isArray(e.lines) ? e.lines : [];
    const tt = EL().totals(lines);
    // 金額0の値引き調整行（端数が無くなった状態）は紙に出さない
    const items = lines.filter(EL().isRealLine).filter(l => !(isAdjust(l) && !Number(l.amount)));
    const chunks = [items.slice(0, ROWS_P1)];
    for (let i = ROWS_P1; i < items.length; i += ROWS_CONT) chunks.push(items.slice(i, i + ROWS_CONT));
    return {
      est: e, d, caseRow: caseRow || {}, org: org || {}, logoUrl: trim(logoUrl),
      totals: tt, chunks, nPages: chunks.length,
      no: displayNumber(e), notes: EL().buildNotes(d.notes || {})
    };
  }

  /* ===== 明細表（旧 itemsTable / cell） ===== */
  function itemCells(tr, it) {
    const desc = el('td', 'es-c-desc');
    const qty = el('td', 'es-c-qty'), price = el('td', 'es-c-price'), amt = el('td', 'es-c-amt');
    if (it) {
      const sub = trim(it.detail);
      const main = cleanDesc(it.description);
      if (main) {
        if (sub) desc.classList.add('es-two');
        desc.appendChild(el('div', 'es-fit', main));
        if (sub) desc.appendChild(el('div', 'es-fit-sub', sub));
      } else {
        desc.appendChild(el('div', 'es-fit-sub es-only', sub));
      }
      // 0円の内訳行は数量・単価・金額を刷らない（旧と同じ）
      if (Number(it.amount)) {
        qty.textContent = `${str(it.quantity)} ${str(it.unit)}`;
        price.textContent = fmt(EL().unitPrice(it));
        amt.textContent = fmt(it.amount);
      }
    }
    tr.append(desc, qty, price, amt);
  }
  function itemsTable(rows, cap, cont) {
    const tbl = el('table', 'es-items' + (cont ? ' es-cont' : ''));
    const cg = el('colgroup');
    ['294pt', '61.5pt', '68pt', '86.7pt'].forEach(w => { const c = el('col'); c.style.width = w; cg.appendChild(c); });
    tbl.appendChild(cg);
    const th = el('thead'), htr = el('tr');
    ['摘要', '数量', '単価', '明細金額'].forEach(h => htr.appendChild(el('th', '', h)));
    th.appendChild(htr);
    tbl.appendChild(th);
    const tb = el('tbody');
    for (let i = 0; i < cap; i++) { const tr = el('tr'); itemCells(tr, rows[i]); tb.appendChild(tr); }
    tbl.appendChild(tb);
    return tbl;
  }

  /* ===== 1ページ（旧 renderPaper の pages.map） ===== */
  function buildPage(pr, i) {
    const first = i === 0, last = i === pr.nPages - 1;
    const d = pr.d, org = pr.org, tt = pr.totals;
    const subject = trim(d.subject) || BLANK;
    const page = el('div', 'es-page');
    page.dataset.page = String(i + 1);

    const parts = [];
    if (first) parts.push({ x0: L, x1: 336.5, y0: 287.6, y1: 330.9, vs: [128.5, 202.0], hs: [305.6] });
    parts.push(itemRules(first ? ITEMS_TOP_P1 : ITEMS_TOP_CONT, first ? ROWS_P1 : ROWS_CONT));
    if (last) {
      parts.push({ x0: 336.5, x1: R, y0: 696.9, y1: 727.3 });
      parts.push({ x0: L, x1: R, y0: 737.3, y1: 799.3, w: 0.45 });
    }
    page.appendChild(rules(parts));

    if (first) {
      page.appendChild(el('div', 'es-title', '見積書'));
      const cl = el('div', 'es-client');
      cl.appendChild(el('span', 'es-client-name', trim(d.client) || BLANK));
      cl.appendChild(el('span', 'es-hon', trim(d.honorific) || '御中'));
      page.appendChild(cl);

      const meta = el('table', 'es-meta');
      const mb = el('tbody');
      [['見積日', d.issueDate, 'es-m-date'], ['見積書番号', pr.no, 'es-m-no'], ['有効期限', d.validUntil, 'es-m-due'],
        ['登録番号', org.registration_number, 'es-m-reg']].forEach(([k, v, cls]) => {
        const tr = el('tr');
        tr.appendChild(el('td', '', k));
        tr.appendChild(el('td', 'es-v ' + cls, trim(v) || BLANK));
        mb.appendChild(tr);
      });
      meta.appendChild(mb);
      page.appendChild(meta);

      page.appendChild(el('div', 'es-co-name', trim(org.name)));
      const body = el('div', 'es-co-body');
      body.appendChild(el('div', '', '営業担当：' + trim(d.manager)));
      [org.address, org.tel, org.email].map(trim).filter(Boolean).forEach(v => body.appendChild(el('div', '', v)));
      page.appendChild(body);

      const hb = el('span', 'es-hanko-box');
      if (pr.logoUrl) {
        const img = document.createElement('img');
        img.className = 'es-logo';
        img.alt = '';
        if (/^https?:/i.test(pr.logoUrl)) img.crossOrigin = 'anonymous';
        img.dataset.company = trim(org.name);
        img.addEventListener('error', () => logoFailed(img), { once: true });
        img.src = pr.logoUrl;
        hb.appendChild(img);
      } else if (trim(org.name)) {
        hb.appendChild(hankoSvg(org.name));
      }
      page.appendChild(hb);

      page.appendChild(el('div', 'es-greeting', '下記の通りお見積り申し上げます。'));
      page.appendChild(el('div', 'es-subject-l', '件名'));
      page.appendChild(el('div', 'es-subject-v', subject));

      const sum = el('table', 'es-summary');
      const cg = el('colgroup');
      ['86pt', '73.5pt', '134.5pt'].forEach(w => { const c = el('col'); c.style.width = w; cg.appendChild(c); });
      sum.appendChild(cg);
      const sh = el('thead'), shr = el('tr');
      ['小計', '消費税', '見積金額'].forEach(h => shr.appendChild(el('th', '', h)));
      sh.appendChild(shr);
      sum.appendChild(sh);
      const sb_ = el('tbody'), str_ = el('tr');
      str_.appendChild(el('td', 'es-sum-sub', fmt(tt.subtotal) + '円'));
      str_.appendChild(el('td', 'es-sum-tax', fmt(tt.tax) + '円'));
      str_.appendChild(el('td', 'es-sum-total', fmt(tt.total) + '円'));
      sb_.appendChild(str_);
      sum.appendChild(sb_);
      page.appendChild(sum);
    } else {
      page.appendChild(el('div', 'es-run-l', '件名　' + subject));
      page.appendChild(el('div', 'es-run-r', '見積書番号　' + (pr.no || BLANK)));
    }

    page.appendChild(itemsTable(pr.chunks[i], first ? ROWS_P1 : ROWS_CONT, !first));

    if (last) {
      const bd = el('table', 'es-bd');
      const cg = el('colgroup');
      ['34.5pt', '100pt', '81.7pt'].forEach(w => { const c = el('col'); c.style.width = w; cg.appendChild(c); });
      bd.appendChild(cg);
      const tb = el('tbody');
      const r1 = el('tr', 'es-r1');
      r1.append(el('td', '', '内訳'), el('td', '', '10%対象(税抜)'), el('td', 'es-num es-bd-sub', fmt(tt.subtotal) + '円'));
      const r2 = el('tr', 'es-r2');
      r2.append(el('td'), el('td', '', '10%消費税'), el('td', 'es-num es-bd-tax', fmt(tt.tax) + '円'));
      tb.append(r1, r2);
      bd.appendChild(tb);
      page.appendChild(bd);
      const notes = el('div', 'es-notes');
      notes.appendChild(el('div', '', '備考'));
      notes.appendChild(el('div', 'es-notes-b', pr.notes));
      page.appendChild(notes);
    }
    page.appendChild(el('div', 'es-pageno', `${i + 1} / ${pr.nPages}`));
    return page;
  }
  // ロゴが読めなければ社印に差し替える
  function logoFailed(img) {
    const box = img.parentNode;
    const name = img.dataset.company || '';
    img.remove();
    if (box && name && !box.querySelector('.es-hanko')) box.appendChild(hankoSvg(name));
  }

  /* ===== はみ出しを級数で収める（旧 shrinkOverflow。切り詰めはしない）。DOM に入れてから呼ぶ ===== */
  function shrink(e, fs0, min, step, extra) {
    let fs = fs0;
    e.style.fontSize = '';
    while (e.scrollWidth > e.clientWidth + 0.5 && fs > min) {
      fs -= step;
      e.style.fontSize = fs + 'pt';
      if (extra) extra(fs);
    }
  }
  function fitText(root) {
    root.querySelectorAll('.es-fit').forEach(e => { if (e.textContent) shrink(e, 9, 5.5, 0.25); });
    root.querySelectorAll('.es-fit-sub').forEach(e => { if (e.textContent) shrink(e, 6.5, 4, 0.25); });
    root.querySelectorAll('.es-client').forEach(e => shrink(e, 14, 8, 0.5));
    root.querySelectorAll('.es-co-body>div').forEach(e => shrink(e, 9, 6, 0.25));
    root.querySelectorAll('.es-subject-v').forEach(e => {
      let fs = 12, lh = 14;
      e.style.fontSize = ''; e.style.lineHeight = '';
      while (e.scrollHeight > e.clientHeight + 0.5 && fs > 7) {
        fs -= 0.5; lh -= 0.5;
        e.style.fontSize = fs + 'pt'; e.style.lineHeight = lh + 'pt';
      }
    });
    root.querySelectorAll('.es-notes-b').forEach(e => {
      let fs = 9, lh = 12.9;
      e.style.fontSize = ''; e.style.lineHeight = '';
      while (e.scrollHeight > e.clientHeight + 0.5 && lh > fs * 1.15) {
        lh = Math.max(fs * 1.15, lh - 0.3);
        e.style.lineHeight = lh + 'pt';
      }
      while (e.scrollHeight > e.clientHeight + 0.5 && fs > 5.5) {
        fs -= 0.25; lh = fs * 1.15;
        e.style.fontSize = fs + 'pt'; e.style.lineHeight = lh + 'pt';
      }
    });
  }

  /* ===== 公開: ページ一式 ===== */
  function buildPages(est, caseRow, org, logoUrl) {
    const pr = prepare(est, caseRow, org, logoUrl);
    return pr.chunks.map((_, i) => buildPage(pr, i));
  }

  /* ===== 公開: プレビュー ===== */
  function preview(container, est, caseRow, org, logoUrl) {
    injectCss();
    container.classList.add('es-preview');
    const pages = buildPages(est, caseRow, org, logoUrl);
    container.replaceChildren(...pages);
    pages.forEach(p => { p.style.transform = ''; });
    fitText(container);
    fit(container);
    return pages;
  }
  // 幅が A4 未満なら transform で縮小し、縮んだ分の高さを margin-bottom で詰める（ReportPdf.fit と同じ）
  function fit(container) {
    if (!container) return;
    const pages = Array.from(container.children).filter(p => p.classList && p.classList.contains('es-page'));
    const cs = getComputedStyle(container);
    const avail = container.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (window.innerWidth > 640 && avail >= A4_PX) {
      container.style.alignItems = '';
      pages.forEach(p => { p.style.transform = ''; p.style.transformOrigin = ''; p.style.marginBottom = ''; });
      return;
    }
    container.style.alignItems = 'flex-start';
    const ratio = Math.min(1, avail / A4_PX);
    pages.forEach(p => {
      const h = p.offsetHeight;
      p.style.transformOrigin = 'top left';
      p.style.transform = 'scale(' + ratio + ')';
      p.style.marginBottom = (-(h * (1 - ratio)) + 18) + 'px';
    });
  }

  /* ===== 画像待ち ===== */
  function waitImg(img) {
    const done = new Promise(resolve => {
      if (img.complete) return resolve();
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    });
    const timeout = new Promise(resolve => setTimeout(resolve, IMG_TIMEOUT_MS));
    return Promise.race([done, timeout]).then(() => {
      if (img.parentNode && (!img.complete || !img.naturalWidth)) logoFailed(img);
    });
  }

  /* ===== 公開: PDF（Blob） ===== */
  // 画面外に原寸で1ページずつ描画 → html2canvas → jsPDF A4縦 JPEG。画面外DOMは必ず消す。
  // opts.onPage(jpgDataUrl, index) / opts.onPageDom(pageEl, index)（撮影直前の DOM。検証用）
  async function renderPdf(est, caseRow, org, logoUrl, opts, quality, scale) {
    if (typeof window.html2canvas !== 'function' || !window.jspdf || !window.jspdf.jsPDF) {
      throw new Error('PDFライブラリを読み込めませんでした。通信状況を確認して再読み込みしてください');
    }
    const pr = prepare(est, caseRow, org, logoUrl);
    const host = document.createElement('div');
    host.className = 'es-capture';
    host.setAttribute('aria-hidden', 'true');
    Object.assign(host.style, { position: 'absolute', left: '-10000px', top: '0', width: '595.28pt', zIndex: '-1', pointerEvents: 'none' });
    document.body.appendChild(host);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
    try {
      for (let i = 0; i < pr.nPages; i++) {
        const page = buildPage(pr, i);
        host.replaceChildren(page);
        await Promise.all(Array.from(page.querySelectorAll('img')).map(waitImg));
        if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) { /* 無視 */ } }
        fitText(page);
        if (typeof opts.onPageDom === 'function') opts.onPageDom(page, i);
        const canvas = await window.html2canvas(page, {
          scale, useCORS: true, allowTaint: false, backgroundColor: '#ffffff', logging: false, scrollX: 0, scrollY: 0
        });
        const jpg = canvas.toDataURL('image/jpeg', quality);
        if (i > 0) doc.addPage('a4', 'portrait');
        doc.addImage(jpg, 'JPEG', 0, 0, PAGE_W_PT, PAGE_H_PT);
        if (typeof opts.onPage === 'function') opts.onPage(jpg, i);
        canvas.width = canvas.height = 0;
        page.querySelectorAll('img').forEach(img => img.removeAttribute('src'));
        host.replaceChildren();
      }
      const blob = doc.output('blob');
      return blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
    } finally {
      host.remove();
    }
  }

  // Storage のバケット上限は 20MB。19MB を超えたら画質→解像度の順に落として作り直す（ReportPdf と同じ）
  const PDF_MAX_BYTES = 19 * 1024 * 1024;
  const PDF_ATTEMPTS = [[0.92, 2], [0.75, 2], [0.75, 1.5]];
  async function toBlob(est, caseRow, org, logoUrl, opts) {
    opts = opts || {};
    const max = Number.isFinite(opts.maxBytes) ? opts.maxBytes : PDF_MAX_BYTES;
    let blob;
    for (const [quality, scale] of PDF_ATTEMPTS) {
      if (typeof opts.onAttempt === 'function') opts.onAttempt(quality, scale);
      blob = await renderPdf(est, caseRow, org, logoUrl, opts, quality, scale);
      if (blob.size <= max) return blob;
    }
    throw new Error('PDFが大きすぎます（20MBまで）。明細を減らしてください');
  }

  const fileName = est => EL().fileName(est);

  window.EstimatePdf = { buildPages, preview, fit, fitText, toBlob, fileName, displayNumber };
})();
