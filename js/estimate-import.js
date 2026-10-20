// js/estimate-import.js — 見積の編集画面の「📄 業者の見積PDFを読み込む」・利益率・粗利の枠（対応フェーズ Task 19。旧ツールの機能の移植）
// 読み込みは2段構え（どちらで読んだかを表示する）:
//   ① サーバー側の AI 読み取り（Supabase Edge Function parse-estimate-pdf。EstimatesApi.parsePdfAi）
//   ② ブラウザ側の文字抽出（pdf.js を cdnjs から SRI 付きで読む → EstimateLogic.pdfTextLines → parseEstimateText（旧 Strategy 2））
// 読み込んだ明細は「原価」（line.cost）として入り、販売金額 = 原価 × (1 + 利益率/100)（EstimateLogic.importToLines / applyMargin）。
// 粗利の枠（原価合計・販売合計・粗利 額と%）は EstimateLogic.profitSummary。PDF（紙面）には販売金額だけが出る。
// ユーザー入力は createElement + textContent で描く（innerHTML は使わない）。alert/confirm は使わない。mk / dBtn は case-list.js・case-detail.js
const EstimateImport = (() => {
  const MAX_BYTES = 20 * 1024 * 1024;
  const MAX_PAGES = 50;
  // pdf.js 3.11.174（cdnjs）。本体は <script integrity>、worker は fetch(integrity) で検証してから Blob の Worker にする
  const PDFJS = {
    src: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    sri: 'sha512-q+4liFwdPC/bNdhUpZx6aXDx/h77yEQtn4I1slHydcbZK34nLaR3cAeYSJshoxIOq3mjEf7xJE8YWIUHMn+oCQ==',
    worker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    workerSri: 'sha512-BbrZ76UNZq5BhH7LL7pn9A4TKQpQeNCHOo65/akfelcIBbcVvYWOFQKPXIrykE3qZxYjmDX573oa4Ywsc7rpTw==',
    cmaps: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/'
  };
  const METHOD_LABEL = { ai: 'AIで読み取り', text: '文字抽出で読み取り' };
  let libP = null;

  const L = () => EstimateLogic;
  const yen = n => L().yen(n);
  const errOf = e => (e && e.message ? e.message : String(e));

  /* ---------- pdf.js（文字抽出）---------- */
  function loadPdfJs() {
    if (libP) return libP;
    libP = new Promise((resolve, reject) => {
      if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
      const sc = document.createElement('script');
      sc.src = PDFJS.src;
      sc.integrity = PDFJS.sri;
      sc.crossOrigin = 'anonymous';
      sc.referrerPolicy = 'no-referrer';
      sc.onload = () => (window.pdfjsLib ? resolve(window.pdfjsLib) : reject(new Error('文字抽出の部品（pdf.js）を読み込めませんでした')));
      sc.onerror = () => reject(new Error('文字抽出の部品（pdf.js）を読み込めませんでした。電波の良いところでもう一度お試しください'));
      document.head.appendChild(sc);
    }).then(async lib => {
      if (!lib.GlobalWorkerOptions.workerPort) {
        const r = await fetch(PDFJS.worker, { integrity: PDFJS.workerSri, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!r.ok) throw new Error('文字抽出の部品（pdf.js の worker）を読み込めませんでした');
        const url = URL.createObjectURL(new Blob([await r.text()], { type: 'application/javascript' }));
        lib.GlobalWorkerOptions.workerPort = new Worker(url);
      }
      return lib;
    }).catch(e => { libP = null; throw e; });
    return libP;
  }
  // PDF → 行の配列（最大 50 ページ）
  async function extractLines(buf) {
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: new Uint8Array(buf.slice(0)), isEvalSupported: false, disableFontFace: true,
      cMapUrl: PDFJS.cmaps, cMapPacked: true }).promise;
    try {
      const pages = [];
      const n = Math.min(doc.numPages, MAX_PAGES);
      for (let i = 1; i <= n; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        pages.push(tc.items.map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width })));
      }
      return L().pdfTextLines(pages);
    } finally {
      try { await doc.destroy(); } catch (e) { /* 何もしない */ }
    }
  }

  /* ---------- 読み込み ---------- */
  function isPdf(file) {
    return !!file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
  }
  // buf の先頭が %PDF か
  function pdfHeader(buf) {
    const b = new Uint8Array(buf.slice(0, 1024));
    for (let i = 0; i + 4 < b.length; i++) if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46) return true;
    return false;
  }

  // ファイル1つを読む。s: 見積の編集セッション。hooks.apply(parsed, method) が明細に入れる
  async function readFile(s, file, hooks) {
    const st = s.imp;
    if (s.readOnly || st.busy) return;
    if (!file) return;
    if (!isPdf(file)) { setMsg(s, 'err', 'PDFファイルを選んでください（Excel の読み込みは後日対応します）'); return; }
    if (file.size > MAX_BYTES) { setMsg(s, 'err', 'PDFは20MBまでです（' + Math.ceil(file.size / 1024 / 1024) + 'MB）'); return; }
    if (!file.size) { setMsg(s, 'err', 'PDFファイルが空です'); return; }
    st.busy = true;
    syncBusy(s);
    setMsg(s, 'busy', '「' + file.name + '」を読み取っています…');
    let parsed = null, method = '', aiNote = '', textNote = '';
    try {
      const buf = await file.arrayBuffer();
      if (!pdfHeader(buf)) throw new Error('PDFファイルとして読めませんでした');
      // ① AI 読み取り（Edge Function）。準備ができていない・失敗したら ② へ
      if (typeof EstimatesApi.parsePdfAi === 'function') {
        try {
          setMsg(s, 'busy', '「' + file.name + '」を AI で読み取っています…（数十秒かかることがあります）');
          const r = await EstimatesApi.parsePdfAi(buf, file.name);
          if (r && Array.isArray(r.items) && L().importItems(r.items).length) { parsed = r; method = 'ai'; }
          else aiNote = 'AI は明細を見つけられませんでした';
        } catch (e) { aiNote = errOf(e); }
      }
      if (!parsed) {
        setMsg(s, 'busy', '「' + file.name + '」の文字を読み取っています…');
        let lines = [];
        try { lines = await extractLines(buf); } catch (e) { textNote = errOf(e); }
        const r = L().parseEstimateText(lines);
        if (r.items.length) { parsed = r; method = 'text'; }
        else if (!textNote) textNote = lines.length ? '明細の行を見つけられませんでした' : '文字の無いPDF（スキャンした画像など）は文字抽出では読めません';
      }
    } catch (e) { textNote = errOf(e); }
    if (!s.imp || s.imp !== st || s.left) return; // 読み取り中に画面を離れた
    st.busy = false;
    syncBusy(s);
    if (!parsed) {
      const parts = ['明細を読み取れませんでした。お手数ですが手で入力してください'];
      if (aiNote) parts.push('AI: ' + aiNote);
      if (textNote) parts.push('文字抽出: ' + textNote);
      setMsg(s, 'err', parts.join(' ／ '));
      return;
    }
    const n = hooks.apply(parsed, method);
    const v = L().verifyImport(parsed.items, parsed.total, parsed.totalEx);
    let tail = '';
    if (v.ok === true) tail = '（読み取った合計 ' + yen(v.sum) + ' ＝ PDFの金額 ' + yen(v.ref) + (v.basis === 'inc' ? '（税込）' : '') + '）';
    else if (v.ok === false) tail = '（⚠ 読み取った合計 ' + yen(v.sum) + ' と PDFの本体 ' + yen(v.ref) + ' が ' + yen(Math.abs(v.gap)) + ' 合いません。明細を確かめてください）';
    st.method = method;
    setMsg(s, v.ok === false ? 'warn' : 'ok', '✓ ' + n + '件の明細を原価として読み込みました' + tail, method, method === 'text' && aiNote ? 'AI は使えませんでした: ' + aiNote : '');
    // 元のPDFを非公開フォルダに保存（任意。失敗しても読み込みはそのまま）
    try {
      const path = await EstimatesApi.uploadSourcePdf(s.row, file);
      if (s.imp === st && !s.left) { hooks.source(path, file.name); setSrc(s, path); }
    } catch (e) { console.warn('仕入先PDFの保存に失敗', e); if (s.imp === st) setSrc(s, '', '元のPDFは保存できませんでした（' + errOf(e) + '）'); }
  }

  /* ---------- 画面 ---------- */
  function setMsg(s, kind, text, method, sub) {
    const el = s.imp && s.imp.msg;
    if (!el) return;
    el.className = 'eu-imp-msg ' + (kind || '');
    el.replaceChildren();
    if (!text) return;
    el.appendChild(mk('span', null, text));
    if (method) {
      const tag = mk('span', 'eu-imp-method m-' + method, METHOD_LABEL[method] || method);
      tag.id = 'eu-import-method';
      el.appendChild(tag);
    }
    if (sub) el.appendChild(mk('span', 'eu-imp-sub', sub));
  }
  function syncBusy(s) {
    const st = s.imp;
    if (!st || !st.box) return;
    st.box.classList.toggle('busy', !!st.busy);
    st.file.disabled = !!st.busy || !!s.readOnly;
    st.drop.setAttribute('aria-disabled', st.busy ? 'true' : 'false');
  }
  // 元のPDFの表示（保存先 path があれば「開く」）
  function setSrc(s, path, note) {
    const st = s.imp;
    if (!st || !st.src) return;
    st.src.replaceChildren();
    st.src.hidden = !path && !note;
    if (note) { st.src.appendChild(mk('span', 'rep-sub', note)); return; }
    if (!path) return;
    st.src.appendChild(mk('span', 'rep-sub', '📎 読み込んだ仕入先のPDF'));
    const open = dBtn('開く', 'linkbtn', async b => {
      b.disabled = true;
      try { window.open(await AppStorage.getUrl(path, 600), '_blank', 'noopener'); }
      catch (e) { setMsg(s, 'err', '元のPDFを開けませんでした: ' + errOf(e)); }
      b.disabled = false;
    });
    open.id = 'eu-import-src-open';
    st.src.appendChild(open);
  }

  // 「📄 業者の見積PDFを読み込む」の枠（ドラッグ＆ドロップ／タップで選ぶ）。読み取り専用では null
  function box(s, hooks) {
    if (s.readOnly) return null;
    const st = s.imp = { busy: false, method: '' };
    const wrap = mk('div', 'eu-imp');
    wrap.id = 'eu-import';
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'eu-import-file';
    input.accept = 'application/pdf,.pdf';
    input.className = 'eu-imp-input'; // 枠いっぱいに重ねた透明な選択欄（タップ・キーボードで選べる）
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      input.value = '';
      if (f) readFile(s, f, hooks);
    });
    const drop = mk('label', 'eu-imp-drop');
    drop.id = 'eu-import-drop';
    drop.htmlFor = input.id;
    drop.appendChild(mk('b', null, '📄 仕入先の見積PDFを読み込む'));
    drop.appendChild(mk('span', 'eu-imp-hint', 'ここにドラッグ＆ドロップ、またはタップして選ぶ（PDFのみ・20MBまで）。明細は「原価」として入ります'));
    const over = on => drop.classList.toggle('over', on);
    drop.addEventListener('dragenter', e => { e.preventDefault(); over(true); });
    drop.addEventListener('dragover', e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; over(true); });
    drop.addEventListener('dragleave', () => over(false));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      over(false);
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readFile(s, f, hooks);
    });
    const msg = mk('div', 'eu-imp-msg');
    msg.id = 'eu-import-msg';
    msg.setAttribute('role', 'status');
    const src = mk('div', 'eu-imp-src');
    src.id = 'eu-import-src';
    src.hidden = true;
    drop.appendChild(input);
    wrap.append(drop, msg, src);
    Object.assign(st, { box: wrap, file: input, drop, msg, src });
    if (s.sourcePdf) setSrc(s, s.sourcePdf);
    return wrap;
  }

  // 利益率（%）の欄。onChange(n) は正しい値のときだけ呼ぶ（空 = 0%）
  function marginRow(s, onChange) {
    const row = mk('div', 'eu-margin');
    row.id = 'eu-margin-row';
    const lb = mk('label', null, '利益率');
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'eu-margin';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.maxLength = 6;
    input.value = String(s.margin);
    lb.htmlFor = input.id;
    const mul = mk('span', 'eu-margin-mul');
    mul.id = 'eu-margin-mul';
    const err = mk('span', 'err eu-margin-err');
    err.id = 'eu-margin-err';
    const show = n => { mul.textContent = '販売金額 = 原価 × ' + (1 + n / 100).toFixed(2); };
    show(s.margin);
    input.addEventListener('input', () => {
      const t = String(input.value).replace(/[０-９．]/g, c => (c === '．' ? '.' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0))).replace(/[%％\s]/g, '');
      const n = t === '' ? 0 : L().normMargin(t);
      if (n === null) { err.textContent = '0〜999の数字で入力してください'; return; }
      err.textContent = '';
      show(n);
      onChange(n);
    });
    if (s.readOnly) input.disabled = true;
    row.append(lb, input, mk('span', null, '%'), mul, err);
    s.els.margin = input;
    return row;
  }

  // 原価合計・販売合計・粗利（額と%）の枠。原価のある行が無ければ隠す
  function profitBox(s) {
    const el = mk('div', 'eu-profit');
    el.id = 'eu-profit';
    el.setAttribute('aria-live', 'polite');
    s.els.profit = el;
    refresh(s);
    return el;
  }
  function refresh(s) {
    const el = s.els && s.els.profit;
    if (!el) return;
    const p = L().profitSummary(s.lines);
    el.hidden = !p;
    if (!p) { el.replaceChildren(); return; }
    const line = (k, v, cls, id) => {
      const r = mk('div', 'eu-profit-r' + (cls ? ' ' + cls : ''));
      const b = mk('b', null, v);
      if (id) b.id = id;
      r.append(mk('span', null, k), b);
      return r;
    };
    const notes = [];
    if (p.overrides) notes.push('個別に直した行 ' + p.overrides + '件');
    if (p.noCost) notes.push('原価の無い行 ' + p.noCost + '件（原価 0 として計算）');
    el.replaceChildren(
      line('仕入原価合計', yen(p.cost), null, 'eu-profit-cost'),
      line('販売金額合計（税抜）', yen(p.sell), 'sell', 'eu-profit-sell'),
      line('粗利', yen(p.profit) + '（' + p.pct + '%）', 'gross' + (p.profit < 0 ? ' minus' : ''), 'eu-profit-gross'),
      ...(notes.length ? [mk('div', 'eu-profit-note', notes.join(' ・ '))] : []));
  }

  // 見積の編集画面で、枠の外にファイルを落としたときにブラウザが PDF を開いて画面を離れないようにする
  const onEditor = e => {
    const scr = document.getElementById('screen-estimate');
    return scr && scr.classList.contains('active') && e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  };
  document.addEventListener('dragover', e => { if (onEditor(e)) e.preventDefault(); });
  document.addEventListener('drop', e => { if (onEditor(e)) e.preventDefault(); });

  return { box, marginRow, profitBox, refresh, readFile, extractLines, loadPdfJs, MAX_BYTES, METHOD_LABEL };
})();
