// js/notice-pdf.js — 工事掲示の A4 縦1枚を描画し、プレビュー・PDF（Blob）にする
// グローバル: window.NoticePdf = { buildSheet, fit, check, preview, fitPreview, dispose, toBlob, fileName }
// レイアウト・文言・書式は旧「工事掲示PDF作成ツール」(/Users/s/koji-keiji-pdf/ styles.css 277-376 / app.js 396-464, 646-666, 1206-1238)
// を写したもの。CSS は .nt- 接頭辞に付け替えている。
// ユーザー入力が入るので、描画はすべて createElement + textContent（innerHTML は使わない）。
// 依存: NoticeLogic（js/notice-logic.js）、PDF 化だけ html2canvas 1.4.1 / jsPDF 2.5.1（index.html で読み込む）
(function () {
  const NL = () => window.NoticeLogic;
  const A4_PX = 794; // 210mm @96dpi
  const MIN_SCALE = 0.8, SCALE_STEP = 0.02;

  /* ===== CSS（旧 styles.css 277-376。--scale は --nt-scale。強調色の設定は廃止＝太字は黒の .nt-strong） ===== */
  const CSS = `
.nt-sheet,.nt-sheet *{box-sizing:border-box;}
.nt-sheet{width:210mm;height:297mm;padding:20mm;background:#fff;color:#000;overflow:hidden;text-align:left;flex-shrink:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.nt-inner{--nt-scale:1;height:100%;font-family:"Hiragino Mincho ProN","Yu Mincho","MS Mincho","Noto Serif JP",serif;font-size:calc(11.5pt * var(--nt-scale));line-height:1.75;color:#000;}
.nt-top{display:flex;align-items:flex-start;justify-content:space-between;gap:1em;margin-bottom:1.2em;}
.nt-addressee{font-size:1.05em;font-weight:600;}
.nt-notice-date{white-space:nowrap;}
.nt-greeting{margin:0 0 1.3em;text-align:center;font-size:1.35em;font-weight:700;letter-spacing:.12em;}
.nt-opening{margin:0 0 1em;}
.nt-subject{margin:0 0 1.1em;text-align:center;font-size:1.25em;font-weight:700;letter-spacing:.06em;}
.nt-body{margin:0 0 .9em;}
.nt-body p{margin:0 0 .55em;}
.nt-body p:last-child{margin-bottom:0;}
.nt-line{display:block;}
.nt-closing{margin:0 0 1.2em;text-align:right;}
.nt-ki{margin:0 0 .9em;text-align:center;letter-spacing:.5em;font-weight:600;}
.nt-details{margin:0 auto 1.2em;padding:.9em 1.2em;border:1px solid #000;}
.nt-row{display:flex;align-items:flex-start;gap:.6em;}
.nt-row + .nt-row{margin-top:.35em;}
.nt-label{flex:0 0 6.2em;font-weight:600;white-space:nowrap;}
.nt-value{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;}
.nt-notes{margin-top:.15em;}
.nt-note{display:block;padding-left:1em;text-indent:-1em;}
.nt-strong{font-weight:700;color:#000;}
.nt-contact{margin-top:1.4em;padding-top:.7em;border-top:1px solid #000;text-align:right;}
.nt-contact-title{margin:0 0 .35em;font-weight:700;}
.nt-contact-line{display:block;white-space:pre-line;overflow-wrap:anywhere;}
.nt-preview{display:flex;flex-direction:column;align-items:flex-start;padding:16px;background:#d8dfe8;overflow:hidden;}
.nt-outer{margin:0 auto;overflow:hidden;background:#fff;box-shadow:0 4px 20px rgba(0,0,0,.14);flex-shrink:0;}
.nt-scaler{transform-origin:top left;}
@media (max-width:640px){.nt-preview{padding:12px;}}
`;
  function injectCss() {
    if (document.getElementById('nt-css')) return;
    const st = document.createElement('style');
    st.id = 'nt-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const line = (text, cls) => el('span', cls || 'nt-line', text);
  // 号室の所だけ <span class="nt-strong"> にして parent に足す（NoticeLogic.strongParts）
  function withParts(parent, text, d) {
    NL().strongParts(text, d).forEach(p => {
      if (!p.text) return;
      parent.appendChild(p.strong ? el('span', 'nt-strong', p.text) : document.createTextNode(p.text));
    });
    return parent;
  }

  // 描画用のデータ。物件名が空なら案件名で補う（ファイル名と同じ扱い。保存データは変えない）
  function viewData(data, caseRow) {
    const d = Object.assign({}, data || {});
    if (!String(d.propertyName || '').trim() && caseRow && caseRow.name) d.propertyName = String(caseRow.name).trim();
    return d;
  }

  /* ===== 公開: シート ===== */
  // 旧 A:396-464 の構造。太字（.nt-strong・黒）は常に: 号室（件名・本文・【工事場所】）、※注記、【排水制限】の行。
  // 保存データの emphasis* は読まない
  function buildSheet(data, caseRow) {
    injectCss();
    const L = NL();
    const d = viewData(data, caseRow);
    const T = L.FIXED_TEXTS;

    const sheet = el('div', 'nt-sheet');
    const inner = el('div', 'nt-inner');
    sheet.appendChild(inner);

    // 左上 宛名 / 右上 通知日
    const top = el('div', 'nt-top');
    top.appendChild(el('div', 'nt-addressee', L.addresseeText(d)));
    top.appendChild(el('div', 'nt-notice-date', L.formatNoticeDate(d)));
    inner.appendChild(top);

    inner.appendChild(el('p', 'nt-greeting', T.greeting));
    inner.appendChild(el('p', 'nt-opening', T.opening));
    inner.appendChild(withParts(el('p', 'nt-subject'), L.subjectText(d), d));

    // 本文3段落。導入文「○○号室にて」の号室を太字（第2・第3段落は定型文で号室を含まない）
    const body = el('div', 'nt-body');
    L.bodyParagraphs(d).forEach((lines, pi) => {
      const p = el('p');
      lines.forEach((t, li) => {
        p.appendChild(pi === 0 && li === 0 ? withParts(line(null), t, d) : line(t));
      });
      body.appendChild(p);
    });
    inner.appendChild(body);

    inner.appendChild(el('p', 'nt-closing', T.closing));
    inner.appendChild(el('p', 'nt-ki', T.ki));

    // 記書き枠
    const details = el('div', 'nt-details');
    L.detailRows(d).forEach(r => {
      const row = el('div', 'nt-row');
      const lab = el('div', 'nt-label', r.label);
      const val = el('div', 'nt-value');
      val.appendChild(r.key === 'place' ? withParts(line(null), r.value, d) : line(r.value));
      if (r.strong) { lab.classList.add('nt-strong'); val.classList.add('nt-strong'); }
      if (r.notes && r.notes.length) {
        const notes = el('div', 'nt-notes');
        r.notes.forEach(n => notes.appendChild(line(n, 'nt-note nt-strong')));
        val.appendChild(notes);
      }
      row.appendChild(lab);
      row.appendChild(val);
      details.appendChild(row);
    });
    inner.appendChild(details);

    // お問い合わせ先（入力がある場合だけ）
    const c = d.contact || {};
    const cl = [c.company, c.address, c.tel].map(v => String(v || '').trim()).filter(Boolean);
    if (cl.length) {
      const box = el('div', 'nt-contact');
      box.appendChild(el('p', 'nt-contact-title', T.contactTitle));
      cl.forEach(t => box.appendChild(line(t, 'nt-contact-line')));
      inner.appendChild(box);
    }
    return sheet;
  }

  /* ===== 公開: 1ページ収め（旧 A:646-666） ===== */
  // sheet は DOM に載っていること。内容が収まるまで文字サイズを 1.0 → 0.8 まで 0.02 刻みで縮める。
  // 戻り値 { scale, overflow }。0.8 でも収まらなければ overflow:true
  function fit(sheet) {
    const inner = sheet.firstElementChild;
    const cs = getComputedStyle(sheet);
    const avail = sheet.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    let scale = 1;
    inner.style.setProperty('--nt-scale', '1');
    while (inner.scrollHeight > avail + 1 && scale > MIN_SCALE + 1e-9) {
      scale = Math.round((scale - SCALE_STEP) * 100) / 100;
      inner.style.setProperty('--nt-scale', String(scale));
    }
    return { scale, overflow: inner.scrollHeight > avail + 1 };
  }

  // 画面外に原寸で組んで fit 結果だけ返す（保存前の警告用）。画面外DOMは必ず消す
  function check(data, caseRow) {
    const host = makeHost();
    try {
      const sheet = buildSheet(data, caseRow);
      host.appendChild(sheet);
      return fit(sheet);
    } finally {
      host.remove();
    }
  }

  function makeHost() {
    injectCss();
    const host = document.createElement('div');
    host.className = 'nt-capture';
    host.setAttribute('aria-hidden', 'true');
    // absolute（スクロール位置に依存しない）。fixed だとスクロール中に撮影位置がずれる
    Object.assign(host.style, { position: 'absolute', left: '-10000px', top: '0', width: '210mm', zIndex: '-1', pointerEvents: 'none' });
    document.body.appendChild(host);
    return host;
  }

  /* ===== 公開: プレビュー ===== */
  // container に A4 を幅に合わせて縮小して出す。戻り値 { sheet, scale, overflow }
  function preview(container, data, caseRow) {
    injectCss();
    container.classList.add('nt-preview');
    const sheet = buildSheet(data, caseRow);
    const scaler = el('div', 'nt-scaler');
    scaler.appendChild(sheet);
    const outer = el('div', 'nt-outer');
    outer.appendChild(scaler);
    container.replaceChildren(outer);
    const r = fit(sheet); // 等倍のまま測る（transform は layout に影響しない）
    fitPreview(container);
    if (typeof ResizeObserver === 'function' && !container._ntRo) {
      container._ntRo = new ResizeObserver(() => fitPreview(container));
      container._ntRo.observe(container);
    }
    return { sheet, scale: r.scale, overflow: r.overflow };
  }

  // 画面幅に合わせて表示倍率を決める（レイアウトは等倍のまま transform で縮小。左寄せなので左が欠けない）
  function fitPreview(container) {
    const outer = container && container.querySelector('.nt-outer');
    if (!outer) return;
    const scaler = outer.firstElementChild, sheet = scaler.firstElementChild;
    const cs = getComputedStyle(container);
    const avail = container.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const w = sheet.offsetWidth || A4_PX, h = sheet.offsetHeight;
    const s = Math.max(0.1, Math.min(1, avail / w));
    scaler.style.transform = s === 1 ? '' : 'scale(' + s + ')';
    outer.style.width = Math.floor(w * s) + 'px';
    outer.style.height = Math.ceil(h * s) + 'px';
  }

  /* ===== 公開: PDF（Blob） ===== */
  // 画面外に原寸で描画 → fit → html2canvas(scale 3) → jsPDF A4縦 1枚。画面外DOMは必ず消す。
  // opts.onFit({scale, overflow}) は検証用。opts.onImage(dataUrl) も検証用
  async function toBlob(data, caseRow, opts) {
    opts = opts || {};
    if (typeof window.html2canvas !== 'function' || !window.jspdf || !window.jspdf.jsPDF) {
      throw new Error('PDFライブラリを読み込めませんでした。通信状況を確認して再読み込みしてください');
    }
    const host = makeHost();
    try {
      const sheet = buildSheet(data, caseRow);
      host.appendChild(sheet);
      if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) { /* 無視 */ } }
      const f = fit(sheet);
      if (typeof opts.onFit === 'function') opts.onFit(f);
      const canvas = await window.html2canvas(sheet, {
        scale: 3, backgroundColor: '#ffffff', logging: false, useCORS: true, scrollX: 0, scrollY: 0
      });
      const png = canvas.toDataURL('image/png');
      canvas.width = canvas.height = 0;
      if (typeof opts.onImage === 'function') opts.onImage(png);
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      // 第8引数 'FAST' が無いと画像が無圧縮になり PDF が約30MBに膨らむ（有ると約0.4MB）
      doc.addImage(png, 'PNG', 0, 0, 210, 297, undefined, 'FAST');
      const blob = doc.output('blob');
      return blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
    } finally {
      host.remove();
    }
  }

  const fileName = (data, caseRow) => NL().fileName(viewData(data, caseRow), (caseRow || {}).name);

  // 画面を離れるとき: preview() が container に付けた ResizeObserver を解除する（残すと消えた要素を見張り続ける）
  function dispose(container) {
    if (container && container._ntRo) {
      container._ntRo.disconnect();
      container._ntRo = null;
    }
  }

  window.NoticePdf = { buildSheet, fit, check, preview, fitPreview, dispose, toBlob, fileName };
})();
