// js/report-ui.js — 報告書まわりの画面
//   ⑤ 案件内の報告書一覧（#case/{id}/reports）… openReports(caseId)  ← このファイルの本体（Task 5a）
//   ⑥ 報告書の入力（#report/{id}）           … openReport(id)       ← js/report-edit.js（Task 5b）
//   ⑩ PDFプレビュー（#report/{id}/pdf）       … openReportPdf(id)    ← このファイルの末尾（Task 5c）
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）
// mk() は case-list.js、dBtn / dField / dSelect / errText は case-detail.js、
// withBusy / setMsg / showScreen / renderHeaders / $ は app.js のものを使う
//
// 画面遷移はすべて location.hash の変更で行う（hashchange → routeFromHash → openXxx）。
// 他タスクが定義すれば使うフック（未定義なら該当UIを出さない）:
//   openShareScreen(caseId)  … Task 6: 協力業者に作成を依頼（URL発行）の画面
//   openMailDraft(draftId)   … Task 7: 送付メール下書きの確認・送信画面

/* ======================= ⑤ 案件内の報告書一覧 ======================= */
let repCaseId = null;     // 表示中（または読み込み中）の案件ID
let repSeq = 0;           // 読み込み/再読み込みのたびに増やす。古い応答を捨てる
let repSummary = null;    // case_summaries の1行
let repReports = [];
let repMembers = [];      // [{user_id, display_name}]
let repDrafts = [];       // mail_drafts（案件内の全部）
let repShares = [];       // report_shares（案件内の報告書の分。URL が使えるか）
let repBusy = false;      // 確認・下書き作成の実行中（二重実行を防ぐ）
const REP_VENDOR = '__vendor__';

function repMemberName(id) {
  const m = repMembers.find(x => x.user_id === id);
  return m ? (m.display_name || '(名前なし)') : '不明';
}

// 作業者の表示名: worker_id があればメンバー名、なければ worker_name（協力業者）
function repWorkerText(r) {
  const base = r.worker_id ? repMemberName(r.worker_id) : (r.worker_name || '未設定');
  return r.submitted_via === 'share' ? base + '（URLから提出）' : base;
}

function repStamp(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function repBackToCase() {
  const fb = (typeof fieldBack === 'function' ? fieldBack(repCaseId) : null); // 現場用から開いたときは「‹ ツール」（js/field-ui.js。Task 18）
  return dBtn(fb ? fb.label : '← ' + (repSummary ? repSummary.name : '案件へ'), 'back', () => {
    location.hash = fb ? fb.hash : '#case/' + repCaseId;
  });
}

function renderRepMessage(text, isErr, retryId) {
  const nodes = [repBackToCase()];
  nodes.push(mk('div', isErr ? 'err' : 'empty', text));
  if (retryId) nodes.push(dBtn('再読み込み', 'btn sm ghost inline', () => loadReports(retryId)));
  $('reports-root').replaceChildren(...nodes);
}

// 一覧の行クリック等 → location.hash 変更 → hashchange → routeFromHash → openReports が2回走るので、
// 同じ案件を表示中/読み込み中なら何もしない。再読み込みは loadReports / refreshReports を直接呼ぶ
function openReports(caseId) {
  if (!caseId) return;
  if (repCaseId === caseId && $('screen-reports').classList.contains('active')) return;
  showScreen('reports');
  renderHeaders();
  const h = '#case/' + caseId + '/reports';
  if (location.hash !== h) location.hash = h;
  return loadReports(caseId);
}

async function loadReports(caseId) {
  const seq = ++repSeq;
  repCaseId = caseId;
  repSummary = null;
  repReports = [];
  repMembers = [];
  repDrafts = [];
  repShares = [];
  repBusy = false;
  renderRepMessage('読み込み中…', false);
  let res;
  try {
    res = await Promise.all([
      CasesApi.getSummary(caseId),
      ReportsApi.listByCase(caseId),
      CasesApi.listMembers(),
      ReportsApi.listDrafts(caseId)
    ]);
    if (seq === repSeq) res.push(await ReportsApi.listSharesByReports((res[1] || []).map(r => r.id)));
  } catch (e) {
    if (seq !== repSeq) return;
    renderRepMessage('報告書の読み込みに失敗しました: ' + errText(e), true, caseId);
    return;
  }
  if (seq !== repSeq) return; // より新しい読み込みが始まっている
  if (!res[0]) { renderRepMessage('案件が見つかりません', false); return; }
  [repSummary, repReports, repMembers, repDrafts, repShares] = [res[0], res[1] || [], res[2] || [], res[3] || [], res[4] || []];
  buildReports();
}

// 操作の後の再読み込み。'' = 成功 or 古い応答として破棄 / 文字列 = 失敗メッセージ
async function refreshReports() {
  const seq = ++repSeq;
  const id = repCaseId;
  let res;
  try {
    res = await Promise.all([CasesApi.getSummary(id), ReportsApi.listByCase(id), ReportsApi.listDrafts(id)]);
    res.push(await ReportsApi.listSharesByReports((res[1] || []).map(r => r.id)));
  } catch (e) {
    return seq === repSeq ? errText(e) : '';
  }
  if (seq !== repSeq) return '';
  if (res[0]) repSummary = res[0];
  repReports = res[1] || [];
  repDrafts = res[2] || [];
  repShares = res[3] || [];
  renderRepCount();
  renderRepList();
  renderRepDrafts();
  return '';
}

/* ---- 骨組み ---- */
function buildReports() {
  const head = mk('div', 'rep-between');
  head.appendChild(mk('h3', null, '報告書'));
  const cnt = mk('span', 'rep-sub');
  cnt.id = 'rep-count';
  head.appendChild(cnt);

  const acts = mk('div', 'rep-acts rep-top-acts');
  acts.appendChild(dBtn('＋ 報告書を作成', 'btn inline', () => toggleRepForm()));
  if (typeof openShareScreen === 'function' && !(typeof fieldHidesAdmin === 'function' && fieldHidesAdmin())) { // 現場用では出さない
    acts.appendChild(Icon.prepend(dBtn('担当者URL', 'btn inline ghost', () => openShareScreen(repCaseId)), 'link'));
  }

  const formBox = mk('div');
  formBox.id = 'rep-form-box';
  const err = mk('div', 'err');
  err.id = 'rep-err';
  const list = mk('div');
  list.id = 'rep-list';

  const card = mk('div', 'rep-card');
  card.append(head, acts, formBox, err, list);

  const drafts = mk('div');
  drafts.id = 'rep-drafts';

  $('reports-root').replaceChildren(repBackToCase(), card, drafts);
  renderRepCount();
  renderRepList();
  renderRepDrafts();
}

function renderRepCount() {
  const el = $('rep-count');
  if (el) el.textContent = 'この案件の報告書 ' + repReports.length + '件';
}

/* ---- 作成フォーム ---- */
function toggleRepForm() {
  const box = $('rep-form-box');
  if (box.firstChild) { box.replaceChildren(); return; }
  setMsg('rep-err', '');

  const form = mk('div', 'addform');
  form.style.marginTop = '0';
  form.style.marginBottom = '10px';
  form.appendChild(mk('div', 'af-ttl', '＋ 報告書を作成'));
  const grid = mk('div', 'af-grid');

  const type = dSelect(Object.entries(ReportLogic.WORK_TYPE_LABEL).filter(([k]) => !ReportLogic.isRecord(k)), 'investigate'); // Task 65: 記録は対応から作る
  const workerOpts = repMembers.map(m => [m.user_id, (m.display_name || '(名前なし)') + (m.user_id === ctx.user.id ? '（自分）' : '')]);
  workerOpts.push([REP_VENDOR, 'その他（名前を入力）']);
  const worker = dSelect(workerOpts, repMembers.some(m => m.user_id === ctx.user.id) ? ctx.user.id : REP_VENDOR);
  const vendor = document.createElement('input');
  vendor.type = 'text';
  vendor.autocomplete = 'off';
  vendor.maxLength = 60;
  vendor.placeholder = '担当者名';
  const vendorField = dField('担当者名', vendor);
  vendorField.className = 'span-all';
  const syncVendor = () => { vendorField.hidden = worker.value !== REP_VENDOR; };
  worker.addEventListener('change', () => { syncVendor(); if (!vendorField.hidden) vendor.focus(); });
  syncVendor();
  grid.append(dField('作業区分', type), dField('作業担当者', worker), vendorField);
  form.appendChild(grid);

  const msg = mk('div', 'err');
  msg.id = 'rep-form-err';
  form.appendChild(msg);

  const acts = mk('div', 'af-act');
  acts.appendChild(dBtn('キャンセル', 'btn sm ghost inline', () => $('rep-form-box').replaceChildren()));
  acts.appendChild(dBtn('作成して入力へ', 'btn sm inline', b => {
    const isVendor = worker.value === REP_VENDOR;
    const vname = vendor.value.trim();
    if (isVendor && !vname) { setMsg('rep-form-err', '担当者名を入力してください'); vendor.focus(); return; }
    const caseId = repCaseId;
    return withBusy(b, async () => {
      setMsg('rep-form-err', '');
      try {
        const row = await ReportsApi.create(caseId, {
          work_type: type.value,
          worker_id: isVendor ? null : worker.value,
          worker_name: isVendor ? vname : null,
          room: repSummary && repSummary.room ? String(repSummary.room) : null, // Task 23 I11: 号室の初期値は案件の号室
          work_date: PhaseLogic.jstYmd(new Date()) // 作業日は今日（号室を入れると「何も入力していない下書き」の扱いにならないので先に入れる）
        });
        location.hash = '#report/' + row.id; // → openReport
      } catch (e) {
        setMsg('rep-form-err', '報告書を作成できませんでした: ' + errText(e));
      }
    });
  }));
  form.appendChild(acts);
  box.replaceChildren(form);
}

/* ---- 一覧 ---- */
function renderRepList() {
  const box = $('rep-list');
  if (!box) return;
  if (repReports.length === 0) {
    box.replaceChildren(mk('div', 'empty', 'この案件の報告書はまだありません'));
    return;
  }
  box.replaceChildren(...repReports.map(repRowEl));
  setRepBusy(repBusy);
}

const REP_PILL = { draft: 'p-draft', submitted: 'p-wait', confirmed: 'p-ok', sent: 'p-sent' };

function repRowEl(r) {
  const RL = ReportLogic;
  const row = mk('div', 'rep-row');
  row.dataset.id = r.id;
  row.dataset.status = r.status;

  const dateText = r.work_date
    ? RL.fmtDateJa(r.work_date) + (RL.timeRange(r.time_start, r.time_end) ? ' ' + RL.timeRange(r.time_start, r.time_end) : '')
    : '作業日未入力';
  const title = [RL.WORK_TYPE_LABEL[r.work_type] || r.work_type, r.room, dateText].filter(Boolean).join(' ・ ');
  const top = mk('div', 'rep-between');
  top.appendChild(mk('b', null, title));
  const me = ctx && ctx.user ? ctx.user.id : null;
  const pills = mk('span', 'rep-pills');
  pills.appendChild(mk('span', 'rep-pill ' + (REP_PILL[r.status] || 'p-draft'), RL.statusLabel(r.status, r.submitted_via, RL.submittedByOther(r, me))));
  // Task 35: 再編集の印（再編集中／再編集あり。いつ・誰が は下の行）
  const rm = typeof PhaseLogic !== 'undefined' ? PhaseLogic.reeditMark(r) : null;
  if (rm && rm.short) pills.appendChild(mk('span', 'reedit-tag rep-reedit-tag', rm.short));
  top.appendChild(pills);
  row.appendChild(top);

  let sub = '作業担当者: ' + repWorkerText(r);
  if (rm) sub += ' ・ ' + rm.text;
  if (r.status === 'draft' && r.updated_at) sub += ' ・ 最終更新 ' + repStamp(r.updated_at);
  row.appendChild(mk('div', 'rep-sub', sub));

  const acts = mk('div', 'rep-acts');
  acts.style.marginTop = '6px';
  // Task 24・25: 担当者URL付きの下書きも社内で続きを書ける（入力中ロックは廃止。「調査報告待ち」の表示もやめた）
  const waiting = r.status === 'draft' && repShares.some(sh => sh.report_id === r.id && ReportsApi.shareActive(sh));
  const field = typeof fieldHidesAdmin === 'function' && fieldHidesAdmin(); // 現場用（Task 18）: 確認・送付・担当者URLは管理者側
  if (field && r.status !== 'draft') {
    acts.appendChild(dBtn('開く', 'btn sm ghost inline', () => { location.hash = '#report/' + r.id; }));
  } else if (r.status === 'draft') {
    acts.appendChild(dBtn('続きを書く', 'btn sm ghost inline', () => { location.hash = '#report/' + r.id; }));
    if (waiting && !field && typeof openShareScreen === 'function') acts.appendChild(dBtn('担当者URL', 'btn sm ghost inline rep-share-url', () => openShareScreen(repCaseId, r.id)));
  } else if (r.status === 'submitted') {
    // 担当者URL・別の人の提出は「確認する」、自分の提出は確認を飛ばして「報告書を送る」（Task 23・25）
    acts.appendChild(dBtn(RL.needsCheck(r, me) ? '確認する' : '報告書を送る', 'btn sm inline', () => onRepConfirm(r)));
  } else {
    acts.appendChild(dBtn('開く', 'btn sm ghost inline', () => { location.hash = '#report/' + r.id; }));
  }
  // 確認済みなのに送付メールの下書きが無い（確認時に下書き作成だけ失敗した）→ 作り直せるようにする
  if (!field && r.status === 'confirmed' && !repDrafts.some(d => d.report_id === r.id)) {
    acts.appendChild(dBtn('送付メールの下書きを作る', 'btn sm inline', () => onRepCreateDraft(r)));
  }
  acts.appendChild(dBtn('PDF', 'btn sm ghost inline', () => { location.hash = '#report/' + r.id + '/pdf'; }));
  row.appendChild(acts);
  return row;
}

// 実行中は一覧のボタンを全部無効にする（別の行の操作が割り込まないように）
function setRepBusy(on) {
  repBusy = on;
  const box = $('rep-list');
  if (box) box.querySelectorAll('button').forEach(b => { b.disabled = on; });
}

// 操作の共通ラッパー: 成功/失敗にかかわらず最後に一覧を最新にし、エラーはその後で表示する
async function runRepOp(label, fn) {
  if (repBusy) return;
  const id = repCaseId;
  setMsg('rep-err', '');
  setRepBusy(true);
  let errMsg = '';
  try {
    await fn();
  } catch (e) {
    errMsg = e && e.report ? errText(e) : label + 'に失敗しました: ' + errText(e);
  }
  if (id !== repCaseId) { repBusy = false; return; } // 操作中に別の案件へ移った
  const m = await refreshReports(); // 最新になるまでボタンは無効のまま
  if (id !== repCaseId) return;
  setRepBusy(false);
  const parts = [errMsg, m ? '最新の表示に更新できませんでした: ' + m : ''].filter(Boolean);
  if (parts.length) setMsg('rep-err', parts.join('\n'));
}

async function onRepConfirm(r) {
  if (repBusy) return;
  // 画面内の確認（confirm() は使わない。Task 23 M6）。担当者URL・別の人の提出は確認、自分の提出はそのまま送る（Task 25）
  const share = ReportLogic.needsCheck(r, ctx && ctx.user ? ctx.user.id : null);
  const row = document.querySelector('#rep-list .rep-row[data-id="' + r.id + '"]');
  const ok = await askInline(row, share ? 'この報告書を確認済みにしますか？\n確認すると、依頼元へ送る報告メールの下書きが作られます。'
    : '依頼元へ送る報告メールの下書きを作りますか？', { okLabel: share ? '確認済みにする' : '下書きを作る', id: 'rep-ask' });
  if (!ok || repBusy) return;
  const caseId = repCaseId;
  let draft = null;
  return runRepOp('確認', async () => { draft = await ReportsApi.confirm(r, repSummary); }).then(() => {
    // 確認できて下書きができたら、そのまま送付メールの下書き（⑨）へ
    if (draft && draft.id && caseId === repCaseId && typeof openMailDraft === 'function') openMailDraft(draft.id);
  });
}

function onRepCreateDraft(r) {
  return runRepOp('送付メールの下書き作成', () => ReportsApi.createDraft(r, repSummary));
}

/* ---- 送信待ちの下書き（Task 7 の画面があるときだけ） ---- */
function renderRepDrafts() {
  const box = $('rep-drafts');
  if (!box) return;
  const pending = repDrafts.filter(d => d.status === 'draft');
  if (typeof openMailDraft !== 'function' || pending.length === 0) { box.replaceChildren(); return; }
  const card = mk('div', 'rep-card rep-drafts');
  const head = mk('div', 'rep-between');
  head.appendChild(mk('b', null, '送信待ちの下書き ' + pending.length + '件'));
  head.appendChild(mk('span', 'rep-pill p-sent', '確認して送信するだけ'));
  card.appendChild(head);
  pending.forEach(d => {
    const line = mk('div', 'rep-draft-line');
    line.appendChild(mk('span', 'rep-sub', d.subject || '（件名なし）'));
    line.appendChild(dBtn('下書きを確認する', 'btn sm inline', () => openMailDraft(d.id)));
    card.appendChild(line);
  });
  box.replaceChildren(card);
}

/* ======================= ⑩ PDFプレビュー（#report/{id}/pdf） ======================= */
// 表示は ReportPdf.preview（js/report-pdf.js）。ここは取得・切替・ダウンロードのつなぎだけ
let rpdfSeq = 0;      // 開くたびに増やす。古い読み込み・古いPDF作成の結果を捨てる
let rpdf = null;      // { gen, opts, busy }（Task 26: 写真は 4枚/ページ・全体表示に固定。切替は無い）

function rpdfMessage(text, isErr, retry) {
  const box = $('rpdf-preview');
  box.classList.remove('rp-preview');
  const note = mk('div', 'rep-note', text);
  if (isErr) note.style.color = 'var(--red)';
  const kids = [note];
  if (retry) kids.push(dBtn('もう一度読み込む', 'btn sm ghost inline', retry));
  box.replaceChildren(...kids);
}

function rpdfSyncControls() {
  const busy = !!(rpdf && rpdf.busy);
  const ready = !!(rpdf && rpdf.opts);
  const dl = $('rpdf-download');
  dl.disabled = !ready || busy;
  dl.textContent = busy ? 'PDFを作成中…' : 'PDFをダウンロード';
}

function rpdfRender() {
  if (!rpdf || !rpdf.opts) return;
  ReportPdf.preview($('rpdf-preview'), rpdf.opts);
  rpdfSyncControls();
}

async function rpdfDownload() {
  const st = rpdf;
  if (!st || !st.opts || st.busy) return;
  st.busy = true;
  setMsg('rpdf-msg', '');
  rpdfSyncControls();
  let blob = null, errMsg = '';
  try {
    blob = await ReportPdf.toBlob(Object.assign({}, st.opts, { onStep: t => { if (st === rpdf) $('rpdf-download').textContent = 'PDFを作成中…（' + t + '）'; } }));
  } catch (e) {
    errMsg = 'PDFを作成できませんでした: ' + errText(e);
  }
  st.busy = false;
  if (st !== rpdf) return; // 作成中に別の画面へ移った
  rpdfSyncControls();
  if (errMsg) { setMsg('rpdf-msg', errMsg); return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = ReportPdf.fileName(st.opts.caseRow, st.opts.report);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

window.addEventListener('resize', () => {
  const sc = $('screen-report-pdf');
  if (rpdf && rpdf.opts && sc && sc.classList.contains('active')) ReportPdf.fit($('rpdf-preview'));
});

// PDFを作るのに必要な材料（案件・ロゴ・写真URL・作業者名）を集める。⑩ のプレビューと ⑨ の送信時のPDF作成で共有
async function rpdfLoadOpts(report) {
  const photos = Array.isArray(report.photos) ? report.photos : [];
  const org = ctx.org;
  const [c, m, logo, urls] = await Promise.all([
    CasesApi.getSummary(report.case_id),
    report.worker_id ? CasesApi.listMembers().catch(() => []) : Promise.resolve([]),
    org && org.logo_path ? AppStorage.getUrl(org.logo_path).catch(() => '') : Promise.resolve(''),
    Promise.all(photos.map(p => (p && p.path ? ReportsApi.photoUrl(p.path).catch(() => '') : Promise.resolve(''))))
  ]);
  const caseRow = c || { name: '（案件情報を取得できません）' };
  const mem = report.worker_id ? (m || []).find(x => x.user_id === report.worker_id) : null;
  return {
    report, caseRow, org: ctx.org || {}, logoUrl: logo || '', photoUrls: urls,
    caseNo: String(caseRow.id || report.case_id || '').replace(/-/g, '').slice(0, 8).toUpperCase(),
    workerName: report.worker_id ? (mem ? (mem.display_name || '') : '') : (report.worker_name || '')
  };
}

async function openReportPdf(id) {
  const gen = ++rpdfSeq;
  const st = rpdf = { gen, opts: null, busy: false };
  showScreen('report-pdf');
  renderHeaders();
  setMsg('rpdf-msg', '');
  $('rpdf-back').onclick = () => { location.hash = '#report/' + id; };
  CaseBand.set($('rpdf-place'), null); // Task 30: 物件名と号室の帯（読み込んだら入れる）
  $('rpdf-download').onclick = rpdfDownload;
  rpdfSyncControls();
  ShareUi.mount($('rpdf-share'), {}); // Task 68: 読み込むまで共有は出さない
  rpdfMessage('読み込み中…', false);

  let opts;
  try {
    const report = await ReportsApi.get(id);
    if (gen !== rpdfSeq) return;
    if (!report) { rpdfMessage('報告書が見つかりません', false); return; }
    opts = await rpdfLoadOpts(report);
  } catch (e) {
    if (gen !== rpdfSeq) return;
    rpdfMessage('PDFプレビューを読み込めませんでした: ' + errText(e), true, () => openReportPdf(id));
    return;
  }
  if (gen !== rpdfSeq) return;
  st.opts = opts;
  CaseBand.set($('rpdf-place'), opts.caseRow);
  rpdfRender();
  // Task 68・72: 「LINEで共有」「メールで共有」。管理者・その対応の作業担当者・現場用で自分が登録した案件の本人（js/share-ui.js）
  ShareUi.mount($('rpdf-share'), { doc: 'report', row: opts.report, caseRow: opts.caseRow, makeBlob: onStep => ReportPdf.toBlob(Object.assign({}, opts, { onStep })),
    onChange: () => { if (gen === rpdfSeq) openReportPdf(id); } });
}
