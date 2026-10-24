// js/estimate-import.js — 見積の編集画面の「他社の見積もり読み込み」・利益率・粗利の枠（対応フェーズ Task 19。旧ツールの機能の移植）
// Task 61: PDF に加えて Excel（.xlsx・.xls）と CSV。Excel は端末の中で読む（SheetJS 0.18.5 を cdnjs から。選んだときだけ読み込み、
//   fetch の integrity で確かめてから Blob の Worker の中で動かす＝他社のファイルを読む部品を画面と切り離す）。CSV は文字コード（UTF-8／Shift_JIS）を見て自前で読む。
//   表から 摘要・数量・単位・単価・金額 の列を見出しで探し（EstimateLogic.detectColumns → rowsToItems）、分からなければ列を選ぶ画面。元のファイルも保存する。
// PDF の読み込みは2段構え（どちらで読んだかを表示する）:
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
  const METHOD_LABEL = { ai: 'AIで読み取り', text: '文字抽出で読み取り', excel: 'Excelから読み取り', csv: 'CSVから読み取り' };
  let libP = null;
  // SheetJS 0.18.5（cdnjs・バージョン固定）。sha512 は cdnjs の公開値
  const XLSXJS = {
    src: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
    sri: 'sha512-r22gChDnGvBylk90+2e/ycr3RVrDi8DIOkIGNhJlKfuyQM4tIRAI062MaV8sfjQKYVGjOBaZBOA87z+IhZE9DA=='
  };
  const SHEET_TYPES = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', csv: 'text/csv' };
  const SHEET_MAX_ROWS = 2000;
  let xlsxP = null;

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

  /* ---------- Excel・CSV（Task 61） ---------- */
  const extOf = file => ((/\.([a-z0-9]+)$/i.exec((file && file.name) || '') || [])[1] || '').toLowerCase();
  const sheetExt = file => (SHEET_TYPES[extOf(file)] ? extOf(file) : '');
  function loadXlsxText() {
    if (!xlsxP) {
      xlsxP = fetch(XLSXJS.src, { integrity: XLSXJS.sri, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' })
        .then(r => { if (!r.ok) throw new Error(); return r.text(); })
        .catch(() => { xlsxP = null; throw new Error('Excel を読む部品を読み込めませんでした。電波の良いところでもう一度お試しください'); });
    }
    return xlsxP;
  }
  // Excel → シートごとの行の配列（値だけ。Worker の中で読む）
  async function excelSheets(buf) {
    const lib = await loadXlsxText();
    const code = lib + '\n;onmessage=function(e){try{var wb=XLSX.read(e.data,{type:"array"});postMessage({ok:true,sheets:wb.SheetNames.map(function(n){'
      + 'return XLSX.utils.sheet_to_json(wb.Sheets[n],{header:1,raw:true,defval:""}).slice(0,' + SHEET_MAX_ROWS + ');})});}'
      + 'catch(err){postMessage({ok:false,err:String(err&&err.message||err)});}};';
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    const w = new Worker(url);
    try {
      return await new Promise((resolve, reject) => {
        w.onmessage = e => (e.data && e.data.ok ? resolve(e.data.sheets) : reject(new Error('Excel ファイルとして読めませんでした')));
        w.onerror = () => reject(new Error('Excel ファイルとして読めませんでした'));
        w.postMessage(buf, [buf]);
      });
    } finally { w.terminate(); URL.revokeObjectURL(url); }
  }
  // CSV の文字コード: UTF-8 として読めなければ Shift_JIS（Excel の「CSV」の既定）
  function csvText(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (e) { return new TextDecoder('shift_jis').decode(buf); }
  }

  async function readSheet(s, file, hooks, ext) {
    const st = s.imp;
    st.busy = true;
    syncBusy(s);
    setMsg(s, 'busy', '「' + file.name + '」を読み取っています…');
    let sheets = null, err = '';
    try {
      const buf = await file.arrayBuffer();
      sheets = ext === 'csv' ? [L().parseCsv(csvText(buf))] : await excelSheets(buf);
    } catch (e) { err = errOf(e); }
    if (!s.imp || s.imp !== st || s.left) return; // 読み取り中に画面を離れた
    st.busy = false;
    syncBusy(s);
    if (!sheets) { setMsg(s, 'err', '読み取れませんでした: ' + err); return; }
    sheets = sheets.filter(r => Array.isArray(r) && r.some(row => Array.isArray(row) && row.some(c => String(c).trim())));
    if (!sheets.length) { setMsg(s, 'err', '表が空です'); return; }
    // 見出しが見つかったシート（無ければ最初のシート）。明細が取れなければ列を選んでもらう
    let rows = sheets[0], m = null;
    for (const r of sheets) { const d = L().detectColumns(r); if (d && L().rowsToItems(r, d).length) { rows = r; m = d; break; } }
    if (!m) {
      setMsg(s, 'busy', 'どの列が何かを選んでください');
      m = await pickColumns(rows, L().detectColumns(rows));
      if (!s.imp || s.imp !== st || s.left) return;
      if (!m) { setMsg(s, '', ''); return; }
    }
    const items = L().rowsToItems(rows, m);
    if (!items.length) { setMsg(s, 'err', '明細の行を見つけられませんでした。お手数ですが手で入力してください'); return; }
    const method = ext === 'csv' ? 'csv' : 'excel';
    const n = hooks.apply({ items }, method);
    st.method = method;
    setMsg(s, 'ok', '✓ ' + n + '件の明細を原価として読み込みました', method);
    await saveSource(s, st, file, hooks, ext);
  }

  // 元のファイルを非公開フォルダに保存（任意。失敗しても読み込みはそのまま）
  async function saveSource(s, st, file, hooks, ext) {
    try {
      const path = await EstimatesApi.uploadSourcePdf(s.row, file, ext, ext === 'pdf' ? 'application/pdf' : SHEET_TYPES[ext]);
      if (s.imp === st && !s.left) { hooks.source(path, file.name); setSrc(s, path); }
    } catch (e) { console.warn('他社の見積もりの保存に失敗', e); if (s.imp === st) setSrc(s, '', '元のファイルは保存できませんでした（' + errOf(e) + '）'); }
  }

  // 列を選ぶ画面（見出しの行・摘要・数量・単位・単価・金額）。× とキャンセルでだけ閉じる → { header, cols } か null
  const COL_LABEL = { description: '摘要（品名） *', quantity: '数量', unit: '単位', unit_price: '単価', amount: '金額' };
  const colName = i => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + (i % 26));
  function pickColumns(rows, guess) {
    return new Promise(resolve => {
      const width = Math.min(52, Math.max(1, ...rows.slice(0, 60).map(r => (Array.isArray(r) ? r.length : 0))));
      const firstRow = Math.max(0, rows.findIndex(r => Array.isArray(r) && r.some(c => String(c).trim())));
      const m = guess ? { header: guess.header, cols: Object.assign({}, guess.cols) } : { header: firstRow, cols: {} };
      const bg = mk('div', 'modal-bg');
      bg.id = 'eu-colpick';
      const dlg = mk('div', 'modal eu-colpick');
      dlg.setAttribute('role', 'dialog');
      dlg.setAttribute('aria-modal', 'true');
      dlg.setAttribute('aria-labelledby', 'eu-colpick-title');
      const hd = mk('div', 'modal-hd');
      const h = mk('h3', null, '列を選んでください');
      h.id = 'eu-colpick-title';
      const x = dBtn('×', 'modal-x', () => done(null));
      x.id = 'eu-colpick-x';
      x.setAttribute('aria-label', '閉じる');
      hd.append(h, x);
      const lead = mk('p', 'rep-sub', 'どの列が何かが分かりませんでした。見出しの行と、それぞれの列を選んでください（摘要と、金額か単価は必ず選びます）。');
      const sel = (id, label, opts, val, onChange) => {
        const w = mk('div', 'rep-ff');
        const l = mk('label', null, label);
        l.htmlFor = id;
        const e = document.createElement('select');
        e.id = id;
        opts.forEach(([v, t]) => { const o = document.createElement('option'); o.value = String(v); o.textContent = t; e.appendChild(o); });
        e.value = String(val);
        e.addEventListener('change', () => onChange(Number(e.value)));
        w.append(l, e);
        return w;
      };
      const rowText = r => (Array.isArray(rows[r]) ? rows[r] : []).map(c => String(c).trim()).filter(Boolean).join(' ／ ').slice(0, 40);
      const headSel = sel('eu-colpick-head', '見出しの行', rows.slice(0, 30).map((_, i) => [i, (i + 1) + '行目: ' + (rowText(i) || '（空）')]), m.header, v => { m.header = v; renderCols(); });
      const colsBox = mk('div', 'eu-colpick-cols');
      const count = mk('div', 'rep-sub eu-colpick-count');
      count.id = 'eu-colpick-count';
      const act = mk('div', 'modal-act');
      const no = dBtn('キャンセル', 'btn ghost', () => done(null));
      no.id = 'eu-colpick-no';
      const ok = dBtn('読み込む', 'btn', () => done({ header: m.header, cols: Object.assign({}, m.cols) }));
      ok.id = 'eu-colpick-ok';
      act.append(no, ok);
      function renderCols() {
        const head = Array.isArray(rows[m.header]) ? rows[m.header] : [];
        const sample = Array.isArray(rows[m.header + 1]) ? rows[m.header + 1] : [];
        const opts = [[-1, '（使わない）']];
        for (let i = 0; i < width; i++) opts.push([i, colName(i) + '列: ' + (String(head[i] == null ? '' : head[i]).trim() || String(sample[i] == null ? '' : sample[i]).trim() || '（空）').slice(0, 20)]);
        colsBox.replaceChildren(...Object.keys(COL_LABEL).map(k => sel('eu-colpick-' + k, COL_LABEL[k], opts, m.cols[k] >= 0 ? m.cols[k] : -1, v => { m.cols[k] = v; sync(); })));
        sync();
      }
      function sync() {
        const c = m.cols;
        const valid = c.description >= 0 && (c.amount >= 0 || c.unit_price >= 0);
        const n = valid ? L().rowsToItems(rows, m).length : 0;
        count.textContent = valid ? '読み込める明細: ' + n + '行' : '摘要と、金額か単価の列を選んでください';
        ok.disabled = !n;
      }
      const prev = document.activeElement;
      function done(v) { bg.remove(); if (prev && prev.focus && prev.isConnected) prev.focus({ preventScroll: true }); resolve(v); }
      dlg.append(hd, lead, headSel, colsBox, count, act);
      bg.appendChild(dlg);
      document.body.appendChild(bg);
      renderCols();
      headSel.querySelector('select').focus({ preventScroll: true });
    });
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
    const sx = isPdf(file) ? '' : sheetExt(file);
    if (!isPdf(file) && !sx) { setMsg(s, 'err', 'PDF・Excel（.xlsx・.xls）・CSV のファイルを選んでください'); return; }
    if (file.size > MAX_BYTES) { setMsg(s, 'err', 'ファイルは20MBまでです（' + Math.ceil(file.size / 1024 / 1024) + 'MB）'); return; }
    if (!file.size) { setMsg(s, 'err', 'ファイルが空です'); return; }
    if (sx) return readSheet(s, file, hooks, sx);
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
    else if (v.ok === false) tail = '（注意: 読み取った合計 ' + yen(v.sum) + ' と PDFの本体 ' + yen(v.ref) + ' が ' + yen(Math.abs(v.gap)) + ' 合いません。明細を確かめてください）';
    st.method = method;
    setMsg(s, v.ok === false ? 'warn' : 'ok', '✓ ' + n + '件の明細を原価として読み込みました' + tail, method, method === 'text' && aiNote ? 'AI は使えませんでした: ' + aiNote : '');
    await saveSource(s, st, file, hooks, 'pdf');
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
    const kind = /\.pdf$/i.test(path) ? 'PDF' : /\.csv$/i.test(path) ? 'CSV' : 'Excel';
    st.src.appendChild(Icon.prepend(mk('span', 'rep-sub', '読み込んだ他社の見積もり（' + kind + '）'), 'clip', 14));
    const open = dBtn('開く', 'linkbtn', async b => {
      b.disabled = true;
      try { window.open(await AppStorage.getUrl(path, 600), '_blank', 'noopener'); }
      catch (e) { setMsg(s, 'err', '元のファイルを開けませんでした: ' + errOf(e)); }
      b.disabled = false;
    });
    open.id = 'eu-import-src-open';
    st.src.appendChild(open);
  }

  // 「他社の見積もり読み込み」の枠（ドラッグ＆ドロップ／タップで選ぶ。PDF・Excel・CSV）。読み取り専用では null
  function box(s, hooks) {
    if (s.readOnly) return null;
    const st = s.imp = { busy: false, method: '' };
    const wrap = mk('div', 'eu-imp');
    wrap.id = 'eu-import';
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'eu-import-file';
    input.accept = 'application/pdf,.pdf,.xlsx,.xls,.csv,' + Object.values(SHEET_TYPES).join(',');
    input.className = 'eu-imp-input'; // 枠いっぱいに重ねた透明な選択欄（タップ・キーボードで選べる）
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      input.value = '';
      if (f) readFile(s, f, hooks);
    });
    const drop = mk('label', 'eu-imp-drop');
    drop.id = 'eu-import-drop';
    drop.htmlFor = input.id;
    drop.appendChild(Icon.prepend(mk('b', null, '他社の見積もり読み込み'), 'report'));
    drop.appendChild(mk('span', 'eu-imp-hint', 'ここにドラッグ＆ドロップ、またはタップして選ぶ（PDF・Excel（.xlsx・.xls）・CSV。20MBまで）。明細は「原価」として入ります'));
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

  return { box, marginRow, profitBox, refresh, readFile, extractLines, loadPdfJs, MAX_BYTES, METHOD_LABEL, XLSXJS };
})();
