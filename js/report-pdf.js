// js/report-pdf.js — 報告書の A4 表紙＋写真ページを描画し、PDF（Blob）にする
// グローバル: window.ReportPdf = { buildPages, preview, fit, toBlob, fileName }
// レイアウト・寸法・文言・色は旧ツール（claude code/report-tool/index.html 1017–1099行の buildReportContent /
// buildPhotoPage と 1019–1054行の .rp-* CSS）から写したもの。新規はワイヤーフレーム⑩（ロゴ＋会社名、
// 現場住所・元請け・作業者、フッタの会社連絡先とページ番号 n / N）。
// ユーザー入力が入るので、描画はすべて createElement + textContent（innerHTML は使わない）。
// 依存: ReportLogic（js/report-logic.js）、写真の印は PhotoMarks（js/photo-marks.js。無ければ印なし）、PDF 化だけ html2canvas 1.4.1 / jsPDF 2.5.1（index.html で読み込む）
(function () {
  const RL = () => window.ReportLogic;
  const A4_PX = 794;       // 210mm @96dpi（旧 fitReportToWidth 913行）
  const PAGE_W_MM = 210, PAGE_H_MM = 297;
  const PAD_TOP_MM = 14, PAD_BOTTOM_MM = 12; // .rp-page の padding 14mm 15mm 12mm
  const IMG_TIMEOUT_MS = 20000;
  const IMG_FAIL_TEXT = '画像を読み込めませんでした';

  /* ===== CSS（旧 1019–1054行。.rp- 接頭辞のまま。新規は ★） ===== */
  const CSS = `
.rp-page,.rp-page *{box-sizing:border-box;margin:0;padding:0;}
.rp-page{background:#fff;width:210mm;min-height:297mm;padding:14mm 15mm 12mm;box-shadow:0 4px 20px rgba(0,0,0,.14);display:flex;flex-direction:column;font-size:10pt;line-height:1.6;color:#1e293b;font-family:'Noto Sans JP','Yu Gothic','Hiragino Kaku Gothic ProN',sans-serif;text-align:left;-webkit-print-color-adjust:exact;print-color-adjust:exact;flex-shrink:0;}
.rp-photo-page{min-height:unset;height:297mm;overflow:hidden;}
.rp-cover-head{display:flex;align-items:center;padding-bottom:6mm;border-bottom:3px solid #1a3a5c;margin-bottom:6mm;}
.rp-co-co{font-size:10.5pt;font-weight:700;color:#1a3a5c;min-width:90px;max-width:62mm;flex-shrink:0;display:flex;align-items:center;gap:2.5mm;line-height:1.35;overflow-wrap:anywhere;}
.rp-co-logo{display:block;max-height:11mm;max-width:24mm;width:auto;height:auto;flex-shrink:0;}
.rp-co-title{flex:1;text-align:center;font-size:19pt;font-weight:700;color:#1a3a5c;letter-spacing:.22em;white-space:nowrap;}
.rp-co-meta{min-width:110px;text-align:right;flex-shrink:0;}
.rp-mr{display:flex;justify-content:flex-end;gap:6px;margin-bottom:3px;font-size:8.5pt;}
.rp-mk{color:#94a3b8;}.rp-mv{font-weight:700;color:#1e293b;}
.rp-info-tbl{width:100%;border-collapse:collapse;margin-bottom:5mm;}
.rp-info-tbl td{border:1px solid #c8d6e5;padding:7px 12px;font-size:10pt;vertical-align:middle;}
.rp-ik{background:#eef3f9;color:#1a3a5c;font-weight:700;text-align:center;white-space:nowrap;width:80px;letter-spacing:.05em;}
.rp-iv{line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;}.rp-prop-name{font-size:11.5pt;font-weight:700;}
.rp-sec{background:#1a3a5c;color:#fff;padding:6px 12px;font-size:9.5pt;font-weight:700;letter-spacing:.12em;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.rp-items{border:1px solid #c8d6e5;border-top:none;padding:8px 12px;background:#f7fafc;display:flex;flex-wrap:wrap;gap:6px;margin-bottom:5mm;}
.rp-badge{display:inline-flex;padding:3px 11px;background:#1a3a5c;color:#fff;border-radius:4px;font-size:9pt;font-weight:500;overflow-wrap:anywhere;}
.rp-nodata{color:#94a3b8;font-size:9pt;}
.rp-res-tbl{width:100%;border-collapse:collapse;margin-bottom:5mm;}
.rp-res-tbl td{border:1px solid #c8d6e5;padding:9px 12px;font-size:10pt;vertical-align:top;line-height:1.75;white-space:pre-wrap;overflow-wrap:anywhere;}
.rp-res-tbl td.rp-rc-none{padding:10px 12px;color:#94a3b8;font-size:9pt;}
.rp-rc-lbl{background:#eef3f9;color:#1a3a5c;font-weight:700;text-align:center;white-space:nowrap !important;width:72px;letter-spacing:.06em;}
.rp-rc-next-lbl{background:#fffbe6;color:#b45309;}.rp-rc-next-cell{background:#fffbe6;}
.rp-cl{border:1px solid #c8d6e5;border-top:none;padding:8px 12px;background:#f7fafc;margin-bottom:5mm;display:flex;flex-direction:column;gap:4px;}
.rp-cl-item{font-size:9pt;color:#1e293b;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;}
.rp-cl-off{color:#94a3b8;}
.rp-cl-key{margin-top:4px;padding-top:6px;border-top:1px dashed #c8d6e5;font-weight:700;color:#1a3a5c;}
.rp-cover-foot{margin-top:auto;padding-top:4mm;border-top:1px solid #e2e8f0;font-size:8.5pt;color:#64748b;display:flex;justify-content:space-between;align-items:baseline;gap:4mm;}
.rp-cf-co{font-weight:700;flex-shrink:0;max-width:55mm;overflow-wrap:anywhere;}
.rp-cf-contact{flex:1;min-width:0;text-align:center;overflow-wrap:anywhere;}
.rp-pno{flex-shrink:0;white-space:nowrap;}
.rp-pp-head{display:flex;justify-content:space-between;align-items:baseline;padding-bottom:3mm;margin-bottom:3mm;border-bottom:2.5px solid #1a3a5c;flex-shrink:0;}
.rp-pp-co{font-size:9.5pt;font-weight:700;color:#1a3a5c;}.rp-pp-title{font-size:11pt;font-weight:700;color:#1a3a5c;letter-spacing:.1em;}
.rp-pgrid{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:121mm 121mm;gap:4mm;min-height:0;min-width:0;width:100%;}
.rp-pcell{border:1px solid #c8d6e5;border-radius:5px;overflow:hidden;display:flex;flex-direction:column;min-height:0;min-width:0;}
.rp-pcell-empty{border:1px dashed #e2e8f0;background:#f8fafc;border-radius:5px;min-height:0;min-width:0;}
.rp-chead{padding:4px 9px;background:#eef3f9;border-bottom:1px solid #c8d6e5;display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex-shrink:0;}
.rp-cnum{font-weight:700;color:#1a3a5c;font-size:10pt;white-space:nowrap;}
.rp-pbadge{color:#fff;font-size:7.5pt;padding:1px 8px;border-radius:3px;font-weight:700;white-space:nowrap;}
.rp-ccap{font-size:8.5pt;color:#334155;flex:1;line-height:1.4;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rp-cimg{flex:1;overflow:hidden;min-height:0;min-width:0;display:block;background:#f4f7fb;position:relative;}
.rp-cimg img{width:100%;height:100%;object-fit:contain;display:block;max-width:100%;}
.rp-imgfail{position:absolute;inset:3mm;border:1px dashed #c8d6e5;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:9pt;text-align:center;}
.rp-pfoot{flex-shrink:0;margin-top:auto;padding-top:3mm;border-top:1px solid #e2e8f0;font-size:8pt;color:#94a3b8;display:flex;justify-content:space-between;gap:4mm;}
.rp-preview{display:flex;flex-direction:column;align-items:center;gap:28px;padding:24px;background:#d8dfe8;overflow-x:hidden;}
.rp-capture .rp-page{box-shadow:none;}
@media (max-width:640px){.rp-preview{padding:12px;gap:18px;align-items:flex-start;}}
`;
  function injectCss() {
    if (document.getElementById('rp-style')) return;
    const s = document.createElement('style');
    s.id = 'rp-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ===== 小物 ===== */
  const str = v => (v == null ? '' : String(v));
  const trim = v => str(v).trim();
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null && text !== '') e.textContent = String(text);
    return e;
  }
  // 旧 today()（1125行）: 作成日は出力日 `YYYY年M月D日`
  function todayJa() {
    const d = new Date();
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }
  // 案件No: 呼び出し側が渡せばそれ。無ければ案件IDの先頭8桁（表示用）
  function caseNoOf(opts, caseRow) {
    if (trim(opts.caseNo)) return trim(opts.caseNo);
    if (trim(caseRow.case_no)) return trim(caseRow.case_no);
    return trim(caseRow.id).replace(/-/g, '').slice(0, 8).toUpperCase();
  }
  // 写真の区分（Task 21: 作業前／作業中／作業後／鍵返却／自由記載。旧区分は読み替え・自由記載は phaseNote）
  function phaseOf(ph) {
    return RL().photoPhase(ph);
  }
  const spaced = s => Array.from(s).join(' '); // 旧の &ensp; 区切り

  function imgEl(src, cls, alt) {
    const img = document.createElement('img');
    if (cls) img.className = cls;
    img.alt = alt || '';
    img.decoding = 'async';
    if (/^https?:/i.test(src)) img.crossOrigin = 'anonymous'; // html2canvas useCORS 用（Supabase Storage は CORS 可）
    img.src = src;
    return img;
  }
  // 読めなかった写真は枠＋文言に差し替える（ロゴは消すだけ）
  function markFailed(img) {
    if (!img.parentNode) return;
    if (img.classList.contains('rp-co-logo')) { img.remove(); return; }
    const box = el('div', 'rp-imgfail', IMG_FAIL_TEXT);
    img.replaceWith(box);
  }
  function watchFail(img) {
    img.addEventListener('error', () => markFailed(img), { once: true });
  }

  /* ===== 表紙（旧 buildReportContent 993–1080行） ===== */
  function buildCover(o) {
    const { report, caseRow, org, logoUrl } = o;
    const cfg = RL().MODES[report.work_type] || RL().MODES.investigate;
    const d = RL().normalizeData(report.data);
    const company = trim(org.name);

    const page = el('div', 'rp-page rp-cover');

    // ヘッダ: 左=ロゴ＋会社名 / 中央=タイトル / 右=案件No・作成日
    const head = el('div', 'rp-cover-head');
    const co = el('div', 'rp-co-co');
    if (trim(logoUrl)) {
      const logo = imgEl(trim(logoUrl), 'rp-co-logo', '');
      watchFail(logo);
      co.appendChild(logo);
    }
    if (company) co.appendChild(el('span', 'rp-co-name', company));
    head.appendChild(co);
    head.appendChild(el('div', 'rp-co-title', spaced('作業写真報告書')));
    const meta = el('div', 'rp-co-meta');
    [['案件No', caseNoOf(o, caseRow)], ['作成日', trim(o.createdDate) || todayJa()]].forEach(([k, v]) => {
      const r = el('div', 'rp-mr');
      r.appendChild(el('span', 'rp-mk', k));
      r.appendChild(el('span', 'rp-mv', v));
      meta.appendChild(r);
    });
    head.appendChild(meta);
    page.appendChild(head);

    // 情報表（★現場住所・元請け・作業者は値があるときだけ）
    const info = el('table', 'rp-info-tbl');
    const ib = el('tbody');
    const dateStr = [RL().fmtDateJa(report.work_date), RL().timeRange(report.time_start, report.time_end)]
      .filter(Boolean).join('　');
    const rows = [
      { k: '物件名', v: trim(caseRow.name), cls: 'rp-prop-name' },
      { k: spaced('号室'), v: RL().roomsText(report) }, // Task 39: 「402号室（加害部屋）・302号室（被害部屋）」
      { k: '現場住所', v: trim(caseRow.address), opt: true },
      { k: '元請', v: trim(caseRow.client_name), opt: true },
      { k: '作業内容', v: RL().WORK_TYPE_LABEL[report.work_type] || RL().WORK_TYPE_LABEL.investigate },
      { k: '作業日時', v: dateStr },
      { k: '作業担当者', v: trim(o.workerName) || trim(report.worker_name), opt: true }
    ];
    rows.forEach(r => {
      if (r.opt && !r.v) return;
      const tr = el('tr');
      tr.appendChild(el('td', 'rp-ik', r.k));
      tr.appendChild(el('td', 'rp-iv' + (r.cls ? ' ' + r.cls : ''), r.v));
      ib.appendChild(tr);
    });
    info.appendChild(ib);
    page.appendChild(info);

    // 作業実施項目 / 施工範囲（チップが無い区分は出さない）
    if (cfg.checkCardTitle) {
      page.appendChild(el('div', 'rp-sec', cfg.checkCardTitle));
      const items = el('div', 'rp-items');
      const chips = RL().chipsForPdf(report);
      if (chips.length) chips.forEach(c => items.appendChild(el('span', 'rp-badge', '☑ ' + c)));
      else items.appendChild(el('span', 'rp-nodata', RL().TEXT.noData));
      page.appendChild(items);
    }

    // 結果表（値がある行だけ。次の対応方針は黄色）
    page.appendChild(el('div', 'rp-sec', cfg.rSection));
    const res = el('table', 'rp-res-tbl');
    const rb = el('tbody');
    const rr = RL().resultRows(report);
    if (rr.length) {
      rr.forEach(r => {
        const tr = el('tr');
        tr.appendChild(el('td', 'rp-rc-lbl' + (r.next ? ' rp-rc-next-lbl' : ''), r.label));
        tr.appendChild(el('td', r.next ? 'rp-rc-next-cell' : '', r.value));
        rb.appendChild(tr);
      });
    } else {
      const tr = el('tr');
      const td = el('td', 'rp-rc-none', RL().TEXT.noData);
      td.colSpan = 2;
      tr.appendChild(td);
      rb.appendChild(tr);
    }
    res.appendChild(rb);
    page.appendChild(res);

    // チェックリスト（作業＋鍵を借りたときだけ 借りた・返却・返却方法。Task 21。どれも無ければ出さない）
    const cl = RL().checklistLines(d);
    const keyReturn = RL().keyInfo(d).comment;
    if (cl.length || keyReturn) {
      page.appendChild(el('div', 'rp-sec', RL().TEXT.checklistTitle));
      const box = el('div', 'rp-cl');
      cl.forEach(i => box.appendChild(el('div', 'rp-cl-item' + (i.key ? ' rp-cl-keyline' : '') + (i.on ? '' : ' rp-cl-off'), (i.on ? '☑ ' : '☐ ') + i.text)));
      if (keyReturn) box.appendChild(el('div', 'rp-cl-item rp-cl-key', `🔑 ${RL().TEXT.keyReturnLabel}：${keyReturn}`));
      page.appendChild(box);
    }

    // フッタ: 会社名 / ★住所 ／ 電話 ／ メール / ★ページ番号
    const foot = el('div', 'rp-cover-foot');
    foot.appendChild(el('span', 'rp-cf-co', company));
    foot.appendChild(el('span', 'rp-cf-contact', [trim(org.address), trim(org.tel), trim(org.email)].filter(Boolean).join(' ／ ')));
    foot.appendChild(el('span', 'rp-pno'));
    page.appendChild(foot);
    return page;
  }

  /* ===== 写真ページ（旧 buildPhotoPage 1082–1099行） ===== */
  function buildPhotoPage(chunk, startIdx, perPage, company, fit) {
    const cols = perPage === 1 ? 1 : 2;
    const rows = Math.ceil(perPage / cols);
    const rowH = rows === 1 ? '246mm' : '121mm';
    const page = el('div', 'rp-page rp-photo-page');

    const head = el('div', 'rp-pp-head');
    head.appendChild(el('span', 'rp-pp-co', company));
    head.appendChild(el('span', 'rp-pp-title', '作業報告書'));
    page.appendChild(head);

    const grid = el('div', 'rp-pgrid');
    grid.style.gridTemplateColumns = `repeat(${cols},1fr)`;
    grid.style.gridTemplateRows = `repeat(${rows},${rowH})`;
    for (let j = 0; j < perPage; j++) {
      const ph = chunk[j];
      if (!ph) { grid.appendChild(el('div', 'rp-pcell rp-pcell-empty')); continue; }
      const num = startIdx + j + 1;
      const cell = el('div', 'rp-pcell');
      const ch = el('div', 'rp-chead');
      ch.appendChild(el('span', 'rp-cnum', `No.${num}`));
      const p = phaseOf(ph);
      if (p) {
        const b = el('span', 'rp-pbadge', p.label);
        b.style.background = p.color;
        ch.appendChild(b);
      }
      ch.appendChild(el('span', 'rp-ccap', trim(ph.caption)));
      cell.appendChild(ch);
      const box = el('div', 'rp-cimg');
      if (trim(ph.url)) {
        const img = imgEl(trim(ph.url), '', `No.${num}`);
        img.style.objectFit = fit;
        img.dataset.fit = fit;
        // 印（Task 14）: 元の写真はそのまま。applyMarks が写真に印を重ねた画像に差し替える
        const marks = window.PhotoMarks ? window.PhotoMarks.normalize(ph.marks) : [];
        if (marks.length) { img._marks = marks; img.dataset.marks = String(marks.length); }
        watchFail(img);
        box.appendChild(img);
      } else {
        box.appendChild(el('div', 'rp-imgfail', IMG_FAIL_TEXT));
      }
      cell.appendChild(box);
      grid.appendChild(cell);
    }
    page.appendChild(grid);

    const foot = el('div', 'rp-pfoot');
    foot.appendChild(el('span', '', company));
    foot.appendChild(el('span', 'rp-pno'));
    page.appendChild(foot);
    return page;
  }

  /* ===== 写真の印（Task 14） ===== */
  // 印のある写真を、canvas で印を重ねた画像（data URL）に差し替える（丸＝楕円、矢印＝線＋三角、コメント＝白地に赤文字の札。
  // 線は写真の短辺の 1%・最低 3px。描き方は js/photo-marks.js の drawMarks）。元の写真（Storage のファイル）は変えない。
  // 合成できなかったとき（読み込み失敗など）は元の写真のまま（読み込み失敗は watchFail の表示になる）。
  const MARK_MAX_EDGE = 2400; // 合成画像の長辺の上限（PDF の写真枠には十分。メモリ節約）
  function applyMarks(root) {
    if (!window.PhotoMarks) return Promise.resolve();
    const jobs = Array.from(root.querySelectorAll('.rp-cimg img')).filter(img => img._marks && !img._marking).map(img => {
      img._marking = true;
      const src = img.getAttribute('src');
      return window.PhotoMarks.compose(src, img._marks, { maxEdge: MARK_MAX_EDGE, quality: 0.92 })
        .then(url => { if (img.getAttribute('src') === src) { img.src = url; img.dataset.marked = '1'; } })
        .catch(() => { /* 元の写真のまま */ });
    });
    return Promise.all(jobs);
  }

  /* ===== 公開: ページ一式 ===== */
  // 入力の正規化と写真ページの分割。toBlob は写真ページを1枚ずつ作るためにこれを使う（画像の読み込みを遅らせる）
  function prepare(opts) {
    injectCss();
    const o = Object.assign({}, opts || {});
    o.report = o.report || {};
    o.caseRow = o.caseRow || {};
    o.org = o.org || {};
    // Task 26: 写真は 4枚/ページ・全体表示（contain）に固定（2枚・1枚・切り抜きの切替は廃止。o.perPage / o.fit は見ない）
    const perPage = 4;
    const fit = 'contain';
    const company = trim(o.org.name);
    const urls = Array.isArray(o.photoUrls) ? o.photoUrls : [];
    const photos = (Array.isArray(o.report.photos) ? o.report.photos : [])
      .map((p, i) => Object.assign({}, p || {}, { url: urls[i] || '' }));
    return { o, perPage, fit, company, photos, nPhotoPages: Math.ceil(photos.length / perPage) };
  }
  function photoPageAt(pr, k) {
    const i = k * pr.perPage;
    return buildPhotoPage(pr.photos.slice(i, i + pr.perPage), i, pr.perPage, pr.company, pr.fit);
  }

  function buildPages(opts) {
    const pr = prepare(opts);
    const pages = [buildCover(pr.o)];
    for (let k = 0; k < pr.nPhotoPages; k++) pages.push(photoPageAt(pr, k));
    numberPages(pages, pages.map(() => 1));
    return pages;
  }

  function numberPages(pages, counts) {
    const total = counts.reduce((a, b) => a + b, 0);
    let n = 0;
    pages.forEach((p, i) => {
      n += counts[i];
      const s = p.querySelector('.rp-pno');
      if (s) s.textContent = `${n} / ${total}`; // 複数ページに分かれた表紙はフッタのある最後のページ番号
    });
  }

  /* ===== A4 を超えた表紙の分割位置（DOM の行の境目で切る。transform なしの状態で呼ぶ） =====
     返り値: [{y, h, off}]（CSS px。y=元の上端からの位置、h=高さ、off=PDFページ上の配置位置） */
  function slicesOf(page) {
    const W = page.offsetWidth, H = page.offsetHeight;
    if (!W || !H) return [{ y: 0, h: H, off: 0 }];
    const mm = W / PAGE_W_MM;
    const pageH = PAGE_H_MM * mm;
    if (H <= pageH + 2 || !page.classList.contains('rp-cover')) return [{ y: 0, h: Math.min(H, pageH), off: 0 }];
    const top = PAD_TOP_MM * mm, bot = PAD_BOTTOM_MM * mm, maxBack = 80 * mm;
    const base = page.getBoundingClientRect().top;

    // 切ってはいけない帯（テキストの各行・バッジ・画像・見出し帯）と、切ってよい位置の候補
    const atoms = [], cands = [];
    const range = document.createRange();
    const tw = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
    for (let t = tw.nextNode(); t; t = tw.nextNode()) {
      if (!t.nodeValue.trim()) continue;
      range.selectNodeContents(t);
      for (const r of range.getClientRects()) {
        if (r.height <= 0) continue;
        atoms.push([r.top - base, r.bottom - base]);
        cands.push(r.bottom - base + 1);
      }
    }
    page.querySelectorAll('.rp-badge,.rp-sec,.rp-mr,img,.rp-co-co,.rp-cover-foot').forEach(e => {
      const r = e.getBoundingClientRect();
      atoms.push([r.top - base, r.bottom - base]);
      cands.push(r.bottom - base + 1);
    });
    // 見出し帯だけがページ末に残らないように、見出し＋次の要素の頭（最大15mm）を切らない
    page.querySelectorAll('.rp-sec').forEach(e => {
      const n = e.nextElementSibling;
      if (!n) return;
      const a = e.getBoundingClientRect(), b = n.getBoundingClientRect();
      atoms.push([a.top - base, Math.min(b.bottom, b.top + 15 * mm) - base]);
    });
    page.querySelectorAll('tr,.rp-items,.rp-cl,.rp-cl-item,table').forEach(e => {
      const r = e.getBoundingClientRect();
      cands.push(r.bottom - base);
      cands.push(r.top - base);
    });
    const ok = c => !atoms.some(([a, b]) => a < c - 0.5 && b > c + 0.5);
    cands.sort((a, b) => b - a);
    const pick = (from, limit) => {
      const c = cands.find(x => x <= limit && x > from + 1 && x >= limit - maxBack && ok(x));
      return c != null ? c : limit;
    };

    const out = [];
    let y = 0, first = true;
    for (let guard = 0; guard < 60; guard++) {
      const room = first ? pageH : pageH - top;
      if (H - y <= room + 1) { out.push({ y, h: H - y, off: first ? 0 : top }); break; }
      const limit = y + (first ? pageH - bot : pageH - top - bot);
      const c = pick(y, limit);
      out.push({ y, h: c - y, off: first ? 0 : top });
      y = c;
      first = false;
    }
    // フッタ（会社名・ページ番号）だけが次のページに残るときは、最後の見出し（例: チェックリスト）から次のページへ送る（Task 21）
    if (out.length >= 2) {
      const last = out[out.length - 1], prev = out[out.length - 2];
      const foot = page.querySelector('.rp-cover-foot');
      const body = Array.from(page.children).filter(e => e !== foot)
        .reduce((m, e) => Math.max(m, e.getBoundingClientRect().bottom - base), 0);
      if (foot && body <= last.y + 1) {
        const secs = Array.from(page.querySelectorAll('.rp-sec')).map(e => e.getBoundingClientRect().top - base - 1)
          .filter(t => t > prev.y + 40 * mm && t < last.y);
        const cut = secs.length ? secs[secs.length - 1] : null;
        if (cut != null && H - cut <= pageH - top - bot + 1) {
          prev.h = cut - prev.y;
          last.y = cut;
          last.h = H - cut;
        }
      }
    }
    return out;
  }

  /* ===== 画像の読み込み待ち ===== */
  function waitImg(img) {
    const done = new Promise(resolve => {
      const settle = () => resolve();
      const viaEvents = () => {
        if (img.complete) return settle();
        img.addEventListener('load', settle, { once: true });
        img.addEventListener('error', settle, { once: true });
      };
      if (typeof img.decode === 'function') img.decode().then(settle, viaEvents);
      else viaEvents();
    });
    const timeout = new Promise(resolve => setTimeout(resolve, IMG_TIMEOUT_MS));
    return Promise.race([done, timeout]).then(() => {
      if (!img.complete || !img.naturalWidth) markFailed(img);
    });
  }
  function waitImages(root) {
    return Promise.all(Array.from(root.querySelectorAll('img')).map(waitImg));
  }
  // html2canvas は object-fit を描かないので、キャプチャ前に contain / cover の寸法を自分で付ける
  function layoutPhotos(root) {
    root.querySelectorAll('.rp-cimg img').forEach(img => {
      const box = img.parentNode;
      const bw = box.clientWidth, bh = box.clientHeight, nw = img.naturalWidth, nh = img.naturalHeight;
      if (!bw || !bh || !nw || !nh) return;
      const r = img.dataset.fit === 'cover' ? Math.max(bw / nw, bh / nh) : Math.min(bw / nw, bh / nh);
      const w = nw * r, h = nh * r;
      Object.assign(img.style, {
        position: 'absolute', width: w + 'px', height: h + 'px', maxWidth: 'none',
        left: (bw - w) / 2 + 'px', top: (bh - h) / 2 + 'px', objectFit: 'fill'
      });
    });
  }

  // html2canvas は text-overflow:ellipsis を描かないので、はみ出すキャプションは文字数で切って「…」を付ける
  function fitCaptions(root) {
    root.querySelectorAll('.rp-ccap').forEach(e => {
      if (e.scrollWidth <= e.clientWidth + 0.5) return;
      const chars = Array.from(e.textContent);
      let lo = 0, hi = chars.length - 1; // 末尾の「…」込みで収まる最大の文字数
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        e.textContent = chars.slice(0, mid).join('') + '…';
        if (e.scrollWidth <= e.clientWidth + 0.5) lo = mid; else hi = mid - 1;
      }
      e.textContent = chars.slice(0, lo).join('').trimEnd() + '…';
    });
  }

  /* ===== 公開: プレビュー ===== */
  function preview(container, opts) {
    injectCss();
    container.classList.add('rp-preview');
    const pages = buildPages(opts);
    container.replaceChildren(...pages);
    numberPages(pages, pages.map(slicesOf).map(s => s.length)); // 表紙が A4 を超えるときも PDF と同じ番号に
    pages.forEach(p => p.querySelectorAll('img').forEach(img => {
      if (!img.complete) img.addEventListener('load', () => fit(container), { once: true });
    }));
    fit(container);
    applyMarks(container);
    return pages;
  }

  // 旧 fitReportToWidth（909–926行）: 幅640px以下は transform で縮小し、縮んだ分の高さを margin-bottom で詰める。
  // 640px超でも枠が A4 より狭いとき（タブレット縦など）は同じ方法で縮小する
  function fit(container) {
    if (!container) return;
    const pages = Array.from(container.children).filter(p => p.classList && p.classList.contains('rp-page'));
    const cs = getComputedStyle(container);
    const avail = container.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (window.innerWidth > 640 && avail >= A4_PX) {
      container.style.alignItems = '';
      pages.forEach(p => { p.style.transform = ''; p.style.transformOrigin = ''; p.style.marginBottom = ''; });
      return;
    }
    // 縮小するときは左寄せ（中央寄せだと原寸幅のページが左右にはみ出し、左が欠ける）
    container.style.alignItems = 'flex-start';
    const ratio = Math.min(1, avail / A4_PX);
    pages.forEach(p => {
      const h = p.offsetHeight;
      p.style.transformOrigin = 'top left';
      p.style.transform = 'scale(' + ratio + ')';
      p.style.marginBottom = (-(h * (1 - ratio)) + 18) + 'px';
    });
  }

  /* ===== 公開: PDF（Blob） ===== */
  // 画面外に原寸で描画 → 画像待ち → html2canvas → jsPDF A4縦 → Blob。画面外DOMは必ず消す。
  // メモリ節約のため、表紙→写真ページの順に1ページずつ host に入れて撮影し、撮り終えたら取り除く。
  // opts.onPage(dataUrl, index) は検証用（各PDFページの JPEG を受け取れる）
  async function renderPdf(opts, quality, scale) {
    if (typeof window.html2canvas !== 'function' || !window.jspdf || !window.jspdf.jsPDF) {
      throw new Error('PDFライブラリを読み込めませんでした。通信状況を確認して再読み込みしてください');
    }
    const pr = prepare(opts);
    const host = document.createElement('div');
    host.className = 'rp-capture';
    host.setAttribute('aria-hidden', 'true');
    // absolute（スクロール位置に依存しない）。fixed だとスクロール中に撮影位置がずれる
    Object.assign(host.style, {
      position: 'absolute', left: '-10000px', top: '0', width: '210mm', zIndex: '-1', pointerEvents: 'none'
    });
    document.body.appendChild(host);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    let pdfPage = 0;
    const setPno = (page, n, total) => {
      const e = page.querySelector('.rp-pno');
      if (e) e.textContent = `${n} / ${total}`;
    };
    // host 内の1ページを撮影して PDF に足す。slices=[{y,h,off}]
    const capture = async (page, slices) => {
      const canvas = await window.html2canvas(page, {
        scale, useCORS: true, allowTaint: false, backgroundColor: '#ffffff', logging: false,
        scrollX: 0, scrollY: 0
      });
      const s = canvas.width / page.offsetWidth;
      const outW = canvas.width, outH = Math.round(canvas.width * PAGE_H_MM / PAGE_W_MM);
      for (const sl of slices) {
        const c = document.createElement('canvas');
        c.width = outW; c.height = outH;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, outW, outH);
        const sy = Math.round(sl.y * s), sh = Math.min(Math.round(sl.h * s), canvas.height - sy, outH - Math.round(sl.off * s));
        if (sh > 0) ctx.drawImage(canvas, 0, sy, outW, sh, 0, Math.round(sl.off * s), outW, sh);
        const jpg = c.toDataURL('image/jpeg', quality);
        if (pdfPage > 0) doc.addPage('a4', 'portrait');
        doc.addImage(jpg, 'JPEG', 0, 0, PAGE_W_MM, PAGE_H_MM);
        if (typeof opts.onPage === 'function') opts.onPage(jpg, pdfPage);
        pdfPage++;
        c.width = c.height = 0;
      }
      canvas.width = canvas.height = 0;
    };
    const ready = async () => {
      await applyMarks(host); // 印のある写真は印を重ねた画像に差し替えてから撮る
      await waitImages(host);
      if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) { /* 無視 */ } }
      layoutPhotos(host);
      fitCaptions(host);
    };
    try {
      // 表紙だけ先に置いて分割数（=ページ番号の総数）を決める。写真ページは必ず1ページ
      const cover = buildCover(pr.o);
      host.replaceChildren(cover);
      await ready();
      const coverSlices = slicesOf(cover);
      const total = coverSlices.length + pr.nPhotoPages;
      setPno(cover, coverSlices.length, total); // 複数ページに分かれた表紙はフッタのある最後のページ番号
      await capture(cover, coverSlices);
      host.replaceChildren();
      for (let k = 0; k < pr.nPhotoPages; k++) {
        const page = photoPageAt(pr, k);
        setPno(page, coverSlices.length + k + 1, total);
        host.replaceChildren(page);
        await ready();
        await capture(page, [{ y: 0, h: Math.min(page.offsetHeight, PAGE_H_MM * (page.offsetWidth / PAGE_W_MM)), off: 0 }]);
        page.querySelectorAll('img').forEach(img => { img.removeAttribute('src'); });
        host.replaceChildren();
      }
      const blob = doc.output('blob');
      return blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
    } finally {
      host.remove();
    }
  }

  // Storage のバケット上限は 20MB。19MB を超えたら画質→解像度の順に落として作り直し、それでも超えるなら止める。
  // opts.maxBytes（テスト用に閾値を下げる）/ opts.onAttempt(quality, scale)（作り直しの検証用）
  const PDF_MAX_BYTES = 19 * 1024 * 1024;
  const PDF_ATTEMPTS = [[0.92, 2], [0.75, 2], [0.75, 1.5]];
  async function toBlob(opts) {
    opts = opts || {};
    const max = Number.isFinite(opts.maxBytes) ? opts.maxBytes : PDF_MAX_BYTES;
    let blob;
    for (const [quality, scale] of PDF_ATTEMPTS) {
      if (typeof opts.onAttempt === 'function') opts.onAttempt(quality, scale);
      blob = await renderPdf(opts, quality, scale);
      if (blob.size <= max) return blob;
    }
    throw new Error('写真が多すぎてPDFが大きすぎます（20MBまで）。写真を減らしてください');
  }

  const fileName = (caseRow, report) => RL().fileName((caseRow || {}).name, (report || {}).room);

  window.ReportPdf = { buildPages, preview, fit, toBlob, fileName };
})();
