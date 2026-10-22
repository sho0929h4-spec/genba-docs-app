// js/phase-ui.js — 対応フェーズ（調査・原因元工事・復旧工事）の画面
//   renderPhases(rootEl)              … 案件ページの「対応フェーズ」欄（case-detail.js の buildDetail から）。Task 10: 表
//                                       （行 = フェーズ、列 = 日時・対応状況・報告書・見積・請求・入金日・確認。各セルを押すとその場で編集。
//                                       セルのデータは PhaseLogic.phaseRow / workerCell）と、上部の「今の状態」1行（#case-now。PhaseLogic.caseNow）
//   renderPhaseDetail(container, phase) … フェーズ詳細ページ #case/{caseId}/phase/{phaseId} の中身（js/phase-detail.js から）。
//                                       今までカードに縦に並んでいた中身（日時・連絡メール・リマインド・作業担当者・現場担当への指示・調査した（報告書の流れ）・
//                                       調査結果・報告書/見積・工事掲示・請求/精算・削除）を全部ここに出す
// 段階・文面・日本時間の計算は js/phase-logic.js（PhaseLogic）、
// DB は js/phases-api.js（PhasesApi）と既存の ReportsApi / EstimatesApi / NoticesApi。
// ユーザー入力は createElement + textContent / value で描画する（innerHTML は使わない）。alert/confirm は使わない（カード内で確認）
// mk() は case-list.js、dBtn / errText / notifyTimeline / currentCase / caseGen / caseDetailId は case-detail.js、withBusy / $ は app.js
//
// 詳細ページの段（ワイヤーフレーム docs/mocks/mock-phases.html の 3・6）:
//   調査: 調査日時 → 作業担当者 → 現場担当への指示 → 調査した（報告書の流れの2択。Task 16）→ 調査結果（Task 5b）→ 報告書 → 見積書 → 精算
//   工事: 見積（この工事の分）→ 工事日の調整（工事掲示も）→ 作業担当者 → 現場担当への指示 → 完了報告（報告書。2択）→ 請求（Task 7）
//   Task 16: 「調査済みにする」「完了にする」「取り消す」は無い。done_at は報告書が提出されたとき DB（migration 034）が入れる。
//     Task 25: フェーズを作ったら報告書（下書き）と担当者URLが自動でできる（既存のフェーズは詳細ページを開いたときに作る）。
//     報告書の段は「報告書を開く」1つ（phReportFlow）。Task 26: 担当者URLの欄は出さない（URL は担当者への確認依頼メールの本文と ⑦ だけ）
//   現場担当への指示（case_phases.plan。Task 9）の段の中身は js/phase-detail.js（phBriefBody）
// 日時の入力は日本時間（端末のタイムゾーンに関係なく、入力欄の値を日本時間として読む）

const PH_WORK_TYPE = { survey: 'investigate', cause: 'repair', repair: 'restore', other: 'repair' }; // 報告書の作業区分（Task 37: その他は設備修繕）
const PH_STEP_INDEX = {
  survey: { schedule: 0, visit: 1, waiting: 1, write: 1, check: 3, report: 3, approval: 4, done: 5 }, // 2 = 調査結果（段階 check / report で未入力なら 2）
  work: { estimate: 0, issued: 0, approval: 0, schedule: 1, work: 1, report: 3, bill: 4, payment: 4, done: 5 } // 2（完了の段）は Task 16 で無くした
};
const PH_REMIND_STATE = { planned: '予定', due: '時刻を過ぎました（まもなく下書きができます）', draft: '下書きあり', sent: '送信済み', skipped: '送らない' };
// 報告書の状態の文（Task 23: 社内が提出したものは確認待ちにしない＝「提出済み（未送付）」。ReportLogic.statusLabel と同じ）
const phReportStatus = r => (typeof ReportLogic !== 'undefined' ? ReportLogic.statusLabel(r.status, r.submitted_via) : r.status);

let ph = null;     // { gen, caseId, phaseId（詳細ページ。案件ページは null）, root, data: {phases, estimates, reports, notices, drafts}, editing: Set, confirmDel, adding, loadErr }
let phSeq = 0;     // 読み込みのたびに増やす（古い応答を捨てる）

/* ---------- 日本時間の入力欄 ---------- */
const PH_JST = 9 * 3600 * 1000;
function phToInput(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + PH_JST);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
function phFromInput(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(v || ''));
  if (!m) return null;
  return PhaseLogic.jstAt(+m[1], +m[2], +m[3], +m[4], +m[5]).toISOString();
}
const phHm = iso => phToInput(iso).slice(11, 16);
const phYmd = iso => phToInput(iso).slice(0, 10);

/* ---------- 読み込み ---------- */
function phState(root, phaseId) {
  return { gen: caseGen, caseId: currentCase.id, phaseId: phaseId || null, root, data: null, editing: new Set(), amountEdit: new Set(), billForm: new Set(),
    dueEdit: new Set(), confirmDel: null, adding: false, loadErr: '', running: new Set(), cell: null, ensured: new Set() };
}
// 段階は見ている人で変わる（Task 25: 作業担当者が別の人 → 🟡 報告待ち（名前）、別の人の提出 → 報告書を確認する）
const phStageOpts = () => ({ me: phMyId(), members: phMembers() });
// 案件ページ（対応フェーズの表）
function renderPhases(root) {
  ph = phState(root, null);
  phDraw();
  return phLoad();
}
// フェーズ詳細ページの中身（phase: case_phases の行か { id }。currentCase はその案件）
//   opts.openWhen: 日時の入力欄を開いた状態で出す（やること #tasks の「工事日を決める」から。Task 17）
function renderPhaseDetail(container, phase, opts) {
  ph = phState(container, String(phase && phase.id || '').toLowerCase());
  if (opts && opts.openWhen && ph.phaseId) { ph.editing.add(ph.phaseId); ph.focusWhen = true; }
  phDraw();
  return phLoad();
}

const phAlive = s => s && ph === s && s.gen === caseGen && s.caseId === caseDetailId;

async function phLoad() {
  const s = ph;
  if (!s) return '';
  const seq = ++phSeq;
  let res;
  try {
    res = await Promise.all([
      PhasesApi.list(s.caseId),
      EstimatesApi.listByCase(s.caseId),
      ReportsApi.listByCase(s.caseId),
      NoticesApi.listByCase(s.caseId),
      ReportsApi.listDrafts(s.caseId),
      // Task 43: 作業担当者のタスクの削除・差し戻し（読めなくても表は出す）
      PhasesApi.listTaskFlags(s.caseId).catch(e => { console.warn('タスクの記録を読み込めませんでした', e); return []; })
    ]);
  } catch (e) {
    if (!phAlive(s) || seq !== phSeq) return '';
    s.loadErr = errText(e);
    phDraw();
    return s.loadErr;
  }
  if (!phAlive(s) || seq !== phSeq) return '';
  const [phases, series, reports] = res;
  const notices = res[3];
  let drafts = res[4];
  PhasesApi.attachTaskFlags(phases || [], res[5]);
  // 担当者URL（URL が使えるか = share_active。case_summaries の reports と同じ形にそろえる）
  let shares = [];
  try { shares = await ReportsApi.listSharesByReports((reports || []).map(r => r.id)); }
  catch (e) { console.warn('担当者URLの読み込みに失敗', e); }
  (reports || []).forEach(r => {
    const act = (shares || []).find(sh => sh.report_id === r.id && ReportsApi.shareActive(sh));
    r.share_active = !!act;
    r.share_name = act ? act.vendor_name || '' : '';
  });
  // Task 27: 担当者URLから提出された調査の報告書 → 「調査結果のご報告」を作り直す（管理者。案件一覧と同じ）
  if (ctx && ctx.membership && ctx.membership.role === 'owner' && currentCase) {
    try { if (await ReportsApi.syncSharedSurveyResults([currentCase])) drafts = await ReportsApi.listDrafts(s.caseId); }
    catch (e) { console.warn('調査結果のご報告の確認に失敗', e); }
    if (!phAlive(s) || seq !== phSeq) return '';
  }
  // 時刻を過ぎたリマインドの下書きを作る・古い未送信のリマインドを消す（案件一覧と同じ。二重作成は DB の unique で防ぐ）
  try {
    const r = await PhasesApi.syncReminders([{ caseRow: currentCase, phases: phases || [] }], drafts || [], new Date());
    r.errors.forEach(m => console.warn(m));
    if (r.created.length || r.removed) drafts = await ReportsApi.listDrafts(s.caseId);
  } catch (e) { console.warn('リマインドの確認に失敗', e); }
  if (!phAlive(s) || seq !== phSeq) return '';
  // Task 25: 詳細ページのフェーズに報告書・担当者URLが無ければ作る（既存のフェーズは開いたときに作る＝遅延作成。1回だけ試す）
  if (s.phaseId && !s.ensured.has(s.phaseId)) {
    s.ensured.add(s.phaseId);
    const p0 = (phases || []).find(x => x.id === s.phaseId);
    if (p0) {
      try {
        const own = (reports || []).filter(r => r.phase_id === p0.id);
        const same = (phases || []).filter(x => x.kind === p0.kind);
        const r = await ReportsApi.ensurePhaseReport(p0, currentCase, { reports: own, shares: shares.filter(sh => own.some(x => x.id === sh.report_id)),
          title: PhaseLogic.phaseTitle(p0, same.indexOf(p0) + 1) });
        if (r && r.made) { if (phAlive(s) && seq === phSeq) return phLoad(); return ''; }
      } catch (e) { console.warn('報告書と担当者URLを用意できませんでした', e); }
      if (!phAlive(s) || seq !== phSeq) return '';
    }
  }
  s.loadErr = '';
  s.data = {
    phases: phases || [],
    estimates: (series || []).flatMap(x => x.versions || []),
    reports: reports || [],
    notices: notices || [],
    drafts: drafts || [],
    shares: shares || []
  };
  phDraw();
  if (s.focusWhen) {
    s.focusWhen = false;
    const i = s.root.querySelector('.ph-sched-start');
    if (i) { if (i.scrollIntoView) i.scrollIntoView({ block: 'center' }); i.focus({ preventScroll: true }); }
  }
  if (typeof syncCaseMailBanner === 'function') syncCaseMailBanner(s.caseId, s.data.drafts);
  if (!s.phaseId && typeof syncCaseTools === 'function') syncCaseTools(s.caseId, s.data); // 案件ページの「ツール」（Task 19）
  return '';
}

// 操作の共通: 失敗はカード（無ければ欄）に表示。成功・失敗とも読み込み直す
async function phRun(btn, errId, label, fn) {
  const s = ph;
  if (!phAlive(s) || s.running.has(errId)) return; // 保存中の二度押しを防ぐ（描き直しで新しいボタンになっても）
  phMsg(errId, '');
  let msg = '';
  s.running.add(errId);
  await withBusy(btn, async () => {
    try { await fn(); }
    catch (e) { msg = label + 'に失敗しました: ' + errText(e); }
    finally { s.running.delete(errId); }
    if (!phAlive(s)) return;
    const m = await phLoad();
    if (m && !msg) msg = label + 'は完了しましたが、最新の表示に更新できませんでした: ' + m;
    notifyTimeline();
  });
  if (phAlive(s) && msg) phMsg(errId, msg);
}
function phMsg(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text || '';
}

/* ---------- このフェーズの書類 ---------- */
function phDocs(p) {
  const d = ph.data;
  const est = d.estimates.filter(e => e.phase_id === p.id);
  const latest = [];
  for (const e of est) {
    const cur = latest.find(x => x.series_id === e.series_id);
    if (!cur) latest.push(e);
    else if ((Number(e.version) || 0) > (Number(cur.version) || 0)) latest[latest.indexOf(cur)] = e;
  }
  latest.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const reports = d.reports.filter(r => r.phase_id === p.id)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const notices = d.notices.filter(n => n.phase_id === p.id)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const mails = d.drafts.filter(m => m.phase_id === p.id);
  return { estimates: est, latest, reports, notices, mails };
}
// 同じ種類の何回目（作成順）
function phSeqOf(p) {
  const same = ph.data.phases.filter(x => x.kind === p.kind);
  return same.indexOf(p) + 1;
}
const phTitle = p => PhaseLogic.phaseTitle(p, phSeqOf(p));

/* ---------- 描画 ---------- */
function phDraw() {
  const s = ph;
  if (!s || !s.root) return;
  // 調査結果・現場担当への指示の入力欄は描き直しても同じ要素を使う（入力中の値・カーソル位置を失わない）。
  // カードを作る時点で要素が付け替わってフォーカスが外れるので、先に覚えて最後に戻す
  const ae = document.activeElement;
  const keep = ae && s.root.contains(ae) && ae.closest && ae.closest('.ph-result, .ph-brief')
    ? { el: ae, a: ae.selectionStart, b: ae.selectionEnd } : null;
  if (s.phaseId) { phDrawDetail(s, keep); return; }
  // 編集欄の入力中の値は描き直しても残す（保存に失敗して読み込み直したとき等）。表示だけの欄（readonly: 担当者URL）は読み直した値
  const kept = [...s.root.querySelectorAll('.ph-panel input:not([readonly])')].map(i => ({ id: i.closest('[data-phase-id]').dataset.phaseId, cls: i.className, v: i.value }));
  const head = mk('div', 'taio-head ph-head');
  head.appendChild(mk('b', null, '対応フェーズ'));
  head.appendChild(mk('span', 'ph-hint', 'フェーズ名を押すと詳細、各欄を押すとその場で変えられます'));
  const adds = mk('div', 'ph-adds');
  PhaseLogic.KINDS.forEach(k => {
    // Task 37: 「＋ その他」は名前の欄を開く（名前を入れて「追加」）
    const b = dBtn('＋ ' + k.label, 'ph-add k-' + k.key, btn => (k.key === 'other' ? phOtherOpen() : phAdd(btn, k.key)));
    b.dataset.kind = k.key;
    if (!s.data || s.adding) b.disabled = true;
    if (k.key === 'other') b.setAttribute('aria-expanded', s.otherForm ? 'true' : 'false');
    adds.appendChild(b);
  });
  if (s.otherForm && s.data) adds.appendChild(phOtherForm(s));
  const nodes = [head];
  const err = mk('div', 'err ph-box-err');
  err.id = 'case-phases-err';
  phSyncNow(s);
  if (!s.data) {
    if (s.loadErr) {
      nodes.push(mk('div', 'err', '対応フェーズを読み込めませんでした: ' + s.loadErr));
      nodes.push(dBtn('再読み込み', 'btn sm ghost inline', () => phLoad()));
    } else nodes.push(mk('div', 'nx-empty', '読み込み中…'));
    s.root.replaceChildren(...nodes, adds, err);
    return;
  }
  if (s.cell && !s.data.phases.some(p => p.id === s.cell.id)) s.cell = null;
  // 日時・請求した の入力欄は保存・キャンセルで閉じたら編集欄も閉じる
  if (s.cell && ((s.cell.col === 'when' && !s.editing.has(s.cell.id)) || (s.cell.col === 'bill' && !s.billForm.has(s.cell.id)
    && !(s.data.phases.find(p => p.id === s.cell.id) || {}).billed_at))) s.cell = null;
  if (s.data.phases.length === 0) {
    nodes.push(mk('div', 'ph-empty', 'まだありません。調査に行くときは「＋ 調査」、工事をするときは「＋ 原因元工事」「＋ 復旧工事」、点検・清掃などは「＋ その他」を押してください（同じ種類を何回でも追加できます）'));
  } else {
    nodes.push(phTable());
  }
  nodes.push(adds);
  if (s.loadErr) nodes.push(mk('div', 'err', '最新の表示に更新できませんでした: ' + s.loadErr));
  s.root.replaceChildren(...nodes, err);
  kept.forEach(k => {
    const i = s.root.querySelector('[data-phase-id="' + k.id + '"] .ph-panel input[class="' + k.cls + '"]');
    if (i) i.value = k.v;
  });
  phKeepFocus(keep);
}
function phKeepFocus(keep) {
  if (keep && keep.el.isConnected && document.activeElement !== keep.el) {
    try {
      keep.el.focus({ preventScroll: true });
      if (typeof keep.a === 'number' && keep.el.setSelectionRange) keep.el.setSelectionRange(keep.a, keep.b);
    } catch (e) { /* type によっては選択範囲を持たない */ }
  }
}

// Task 37: 「＋ その他」の名前の欄（画面内の行。名前は1〜40字・例: 点検・清掃）
function phOtherOpen() {
  const s = ph;
  if (!s || !s.data) return;
  s.otherForm = !s.otherForm;
  phDraw();
  const i = s.otherForm && s.root.querySelector('#ph-other-name');
  if (i) i.focus();
}
function phOtherForm(s) {
  const box = mk('div', 'ph-other-form');
  box.id = 'ph-other-form';
  const lb = mk('label', 'ph-other-lb', 'その他の名前');
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.id = 'ph-other-name';
  inp.maxLength = PhaseLogic.LABEL_MAX;
  inp.placeholder = '例: 点検・清掃';
  inp.value = s.otherName || '';
  inp.addEventListener('input', () => { s.otherName = inp.value; });
  lb.htmlFor = inp.id;
  const add = dBtn('追加', 'btn sm', btn => {
    const name = String(inp.value || '').trim();
    if (!name) { phMsg('case-phases-err', '「その他」の名前を入れてください（例: 点検・清掃）'); inp.focus(); return; }
    if (Array.from(name).length > PhaseLogic.LABEL_MAX) { phMsg('case-phases-err', '「その他」の名前は' + PhaseLogic.LABEL_MAX + '文字までです'); return; }
    return phAdd(btn, 'other', name);
  });
  add.id = 'ph-other-add';
  const cancel = dBtn('キャンセル', 'btn sm ghost', () => { s.otherForm = false; s.otherName = ''; phMsg('case-phases-err', ''); phDraw(); });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add.click(); } });
  box.append(lb, inp, add, cancel);
  return box;
}

function phAdd(btn, kind, label) {
  const s = ph;
  return phRun(btn, 'case-phases-err', '追加', async () => {
    const n = s.data ? s.data.phases.filter(x => x.kind === kind).length + 1 : 1;
    const title = kind === 'other' ? PhaseLogic.phaseTitle({ kind, label }) : PhaseLogic.kindLabel(kind) + ' ' + n + '回目';
    const row = await PhasesApi.create(s.caseId, kind, currentCase, title, kind === 'other' ? label : null);
    s.newId = row.id;
    if (kind === 'other') { s.otherForm = false; s.otherName = ''; }
  }).then(() => {
    if (!phAlive(s) || !s.newId) return;
    const card = s.root.querySelector('[data-phase-id="' + s.newId + '"]');
    s.newId = null;
    if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (card) { card.classList.add('ph-new'); setTimeout(() => card.classList.remove('ph-new'), 3000); }
  });
}

// 詳細ページ: そのフェーズのカード1枚（中身は全部）。読み込み前・見つからないときは案内
function phDrawDetail(s, keep) {
  const err = mk('div', 'err');
  err.id = 'case-phases-err';
  if (!s.data) {
    const nodes = [];
    if (s.loadErr) {
      nodes.push(mk('div', 'err', 'フェーズを読み込めませんでした: ' + s.loadErr));
      nodes.push(dBtn('再読み込み', 'btn sm ghost inline', () => phLoad()));
    } else nodes.push(mk('div', 'nx-empty', '読み込み中…'));
    s.root.replaceChildren(...nodes, err);
    return;
  }
  const p = s.data.phases.find(x => x.id === s.phaseId);
  if (!p) {
    s.root.replaceChildren(mk('div', 'empty ph-gone', 'このフェーズは見つかりません（削除された可能性があります）'), err);
    return;
  }
  const nodes = [phCard(p)];
  if (s.loadErr) nodes.push(mk('div', 'err', '最新の表示に更新できませんでした: ' + s.loadErr));
  s.root.replaceChildren(...nodes, err);
  if (typeof pdSyncHead === 'function') pdSyncHead(p, phTitle(p)); // 詳細ページの見出し（js/phase-detail.js）
  phKeepFocus(keep);
}

/* ---------- 案件ページの表（Task 10） ---------- */
// 行 = フェーズ（調査／原因元工事／復旧工事。同じ種類が複数なら「調査 2回目」）、列 = 日時・対応状況・報告書・見積・請求・入金日・確認。
// PC（900px 以上）は1行1フェーズの表、スマホは1フェーズ = 2行の小さなカード（1行目 名前・日時・対応状況、2行目 チップ）。
// DOM は1つで、CSS の grid / flex だけで形を変える（同じ id を2つ作らない）。各セルはボタンで、押すとその行の下に
// 小さな編集欄（ph-panel）が開く。入力のある編集欄（日時・請求した・入金期限）は × とキャンセルでだけ閉じる（外側・Esc では閉じない）。
const PH_COLS = [
  { key: 'when', label: '日時' }, { key: 'status', label: '対応状況' }, { key: 'worker', label: '担当者' }, { key: 'report', label: '報告書' },
  { key: 'estimate', label: '見積' }, { key: 'notice', label: '工事掲示' }, // Task 29: 工事掲示（見積の提出で自動の下書き）
  { key: 'bill', label: '請求' }, { key: 'pay', label: '入金日' }, { key: 'confirm', label: '確認' }
];
const PH_COL_LABEL = Object.fromEntries(PH_COLS.map(c => [c.key, c.label]));
const PH_CHIP_LABEL = { worker: '担当', report: '報告書', estimate: '見積', notice: '掲示', bill: '請求', pay: '入金', confirm: '' }; // スマホのチップの頭

// 入力のある編集欄が開いているか（開いている間は、ほかのセルを押しても切り替えない）
function phFormOpen(s) {
  const c = s && s.cell;
  if (!c) return false;
  return (c.col === 'when' && s.editing.has(c.id)) || (c.col === 'bill' && s.billForm.has(c.id)) || (c.col === 'pay' && s.dueEdit.has(c.id));
}
function phCloseCell(s) {
  const c = s.cell;
  if (c) { s.editing.delete(c.id); s.billForm.delete(c.id); s.dueEdit.delete(c.id); phMsg('ph-err-' + c.id, ''); }
  s.cell = null;
}
// セルを押した: 編集欄を開く（同じセルなら閉じる）。入力中の欄があれば切り替えずに知らせる
function phOpenCell(p, col) {
  const s = ph;
  if (!phAlive(s)) return;
  const cur = s.cell;
  if (cur && cur.id === p.id && cur.col === col) {
    if (phFormOpen(s)) { phFocusPanel(s); return; }
    phCloseCell(s); phDraw(); return;
  }
  if (phFormOpen(s)) {
    phMsg('ph-err-' + cur.id, '入力中の欄があります。「保存」か「キャンセル」で閉じてから、ほかの欄を押してください');
    phFocusPanel(s);
    return;
  }
  phCloseCell(s);
  s.cell = { id: p.id, col };
  if (col === 'when') s.editing.add(p.id);
  if (col === 'bill' && !p.billed_at) s.billForm.add(p.id);
  phDraw();
  phFocusPanel(s);
}
function phFocusPanel(s) {
  const el = s.root && s.root.querySelector('.ph-panel');
  if (!el) return;
  if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  const f = el.querySelector('input, select, button:not(.ph-panel-x)');
  if (f) f.focus({ preventScroll: true });
}

// 「今の状態」1行（案件ページの上部 #case-now）
function phSyncNow(s) {
  const el = document.getElementById('case-now');
  if (!el) return;
  if (!s.data) { el.hidden = true; return; }
  const phases = s.data.phases.map(p => { const d = phDocs(p); return Object.assign({}, p, { estimates: d.estimates, reports: d.reports }); });
  const now = PhaseLogic.caseNow(phases, new Date(), phStageOpts());
  el.hidden = false;
  el.dataset.us = String(now.us);
  el.dataset.them = String(now.them);
  const us = mk('span', 'cn-us' + (now.us ? ' on' : ''), '自社の番 ' + now.us + '件');
  const them = mk('span', 'cn-them' + (now.them ? ' on' : ''), '相手待ち ' + now.them + '件');
  const tail = now.text.slice(now.text.indexOf('次: '));
  const next = mk('span', 'cn-next' + (now.next && now.next.late ? ' late' : ''), tail);
  el.replaceChildren(us, mk('span', 'cn-sep', '・'), them, mk('span', 'cn-sep', '・'), next);
  // Task 23: 現場からの連絡の未読（自分あて）。押すとこの案件の連絡
  const unread = currentCase && currentCase.id === s.caseId ? Number(currentCase.staff_unread) || 0 : 0;
  if (unread > 0) {
    const b = dBtn('現場からの連絡 ' + unread + '件', 'cn-msg', () => { location.hash = '#messages/' + s.caseId; });
    b.id = 'case-now-messages';
    el.append(mk('span', 'cn-sep', '・'), b);
  }
  el.setAttribute('aria-label', '今の状態: ' + now.text + (unread > 0 ? ' ・ 現場からの連絡 ' + unread + '件' : ''));
}

function phTable() {
  const s = ph;
  const tbl = mk('div', 'ph-tbl');
  const head = mk('div', 'ph-tr ph-thead');
  head.setAttribute('aria-hidden', 'true');
  head.appendChild(mk('span', 'ph-th', 'フェーズ'));
  PH_COLS.forEach(c => head.appendChild(mk('span', 'ph-th', c.label)));
  tbl.appendChild(head);
  const count = {};
  s.data.phases.forEach(p => { count[p.kind] = (count[p.kind] || 0) + 1; });
  s.data.phases.forEach(p => tbl.appendChild(phTableRow(p, count[p.kind] > 1)));
  return tbl;
}

function phTableRow(p, multi) {
  const s = ph;
  const docs = phDocs(p);
  const seq = phSeqOf(p);
  const row = PhaseLogic.phaseRow(p, seq, { estimates: docs.estimates, reports: docs.reports, mails: docs.mails }, new Date(), phStageOpts());
  const st = row.stage;
  const errId = 'ph-err-' + p.id;
  const busy = s.running.has(errId);
  const tr = mk('div', 'ph-tr ph-row-p');
  tr.dataset.phaseId = p.id;
  tr.dataset.kind = p.kind;
  tr.dataset.stage = st.key;
  const open = s.cell && s.cell.id === p.id ? s.cell.col : '';
  if (open) tr.classList.add('open');

  // フェーズ名 → 詳細ページ
  const name = mk('button', 'ph-c ph-c-name');
  name.type = 'button';
  name.append(mk('span', 'ph-kind k-' + p.kind, PhaseLogic.kindLabel(p.kind)));
  if (p.kind === 'other') name.appendChild(mk('span', 'ph-n ph-label', String(p.label || '').trim())); // Task 37: その他は名前（回目なし）
  else if (multi) name.appendChild(mk('span', 'ph-n', seq + '回目'));
  name.appendChild(mk('span', 'ph-go', '›'));
  name.setAttribute('aria-label', row.title + 'の詳細を開く');
  name.title = row.title + 'の詳細（日時・調査結果・作業担当者への指示・書類・請求の全部）';
  name.addEventListener('click', () => { location.hash = '#case/' + s.caseId + '/phase/' + p.id; });
  tr.appendChild(name);

  // mobileText: スマホのチップで短く出す文（PC の表は text）
  const cell = (col, text, cls, aria, onClick, mobileText) => {
    const b = mk('button', 'ph-c ph-cell' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    b.dataset.col = col;
    if (PH_CHIP_LABEL[col]) b.appendChild(mk('span', 'ph-cl', PH_CHIP_LABEL[col]));
    const v = mk('span', 'ph-cv', '');
    if (mobileText && mobileText !== text) v.append(mk('span', 'ph-pc', text), mk('span', 'ph-sm', mobileText));
    else v.textContent = text;
    b.appendChild(v);
    b.setAttribute('aria-label', row.title + 'の' + PH_COL_LABEL[col] + ': ' + text + (aria ? '（' + aria + '）' : ''));
    if (open === col) { b.classList.add('on'); b.setAttribute('aria-expanded', 'true'); }
    if (busy) b.disabled = true;
    b.addEventListener('click', () => onClick(b));
    tr.appendChild(b);
    return b;
  };
  const isSurvey = p.kind === 'survey';
  // 日時
  cell('when', row.when.text, row.when.at ? 'num' : 'none', row.when.at ? '変更する' : (isSurvey ? '調査日時を決める' : '工事日を決める'), () => phOpenCell(p, 'when'));
  // 対応状況
  const stCls = 'ph-stage ' + (st.ball === 'us' ? 'us' : st.ball === 'them' ? 'them' : 'done') + (st.late ? ' late' : '');
  const sb = cell('status', row.short, 'ph-c-status', '次にやること', () => phOpenCell(p, 'status'));
  sb.querySelector('.ph-cv').className = 'ph-cv ' + stCls;
  sb.title = '対応状況: ' + st.label;
  // Task 29: 見積書提案期日が2日より先の理由（作業担当者が報告書で入れたもの）。見積がまだ送付されていない間だけ
  const why = PhaseLogic.estimateDueReasonText(p);
  if (why && p.estimate_due && (st.key === 'estimate' || st.key === 'issued' || PhaseLogic.estimateTodo(Object.assign({}, p, { estimates: docs.estimates }), new Date()))) {
    const w = mk('span', 'ph-why', why);
    sb.appendChild(w);
    sb.title += ' ' + why;
  }
  // Task 28: 担当者（作業担当者。押すとその場でメンバーを選ぶ）。スマホは1行目に「担当 鈴木」
  const wk = PhaseLogic.workerCol(p, phMembers());
  cell('worker', wk.text, wk.set ? 'ph-c-worker' : 'ph-c-worker none', '作業担当者を選ぶ', () => phOpenCell(p, 'worker'));
  // スマホの改行（2行目にチップ）
  tr.appendChild(mk('span', 'ph-br'));
  // 報告書（Task 25: 無ければ報告書と担当者URLを作って開く。あればこのフェーズの一番新しい報告書を開く＝Task 23 M5）
  const rep = row.report;
  const rb = cell('report', rep.state === 'none' ? '＋ 作る' : rep.text, rep.state === 'none' ? 'none add' : (rep.state === 'shared' || rep.state === 'viewed') ? 'ok' : '',
    'このフェーズの報告書を開く', b => phOpenReport(b, p, docs, errId), rep.state === 'none' ? '未' : '');
  phReeditTag(rb, rep.reedit);
  // 見積（無ければ作る／あれば一覧へ）。Task 35: 金額は PC・スマホとも2段（売上 = 見積の税込合計／原価 = 原価の税込合計。無ければ「原価 —」）
  const est = row.estimate;
  const eb = cell('estimate', est.state === 'none' ? '＋ 作る' : est.text, est.state === 'none' ? 'none add' : est.state === 'accepted' ? 'ok' : est.state === 'sent' ? 'wait' : '',
    est.state === 'none' ? '見積書を作る' : '見積書の一覧へ',
    b => est.state === 'none' ? phMakeEstimate(b, p, errId) : (location.hash = '#case/' + s.caseId + '/estimates'), est.state === 'none' ? '未' : '');
  if (est.amount != null) {
    eb.classList.add('ph-2amt');
    const yen = mk('span', 'ph-yen2');
    const sale = mk('span', 'ph-sale num', '売上 ' + PhaseLogic.yen(est.amount));
    const cost = mk('span', 'ph-cost num' + (est.cost == null ? ' none' : ''), '原価 ' + (est.cost == null ? '—' : PhaseLogic.yen(est.cost)));
    yen.append(sale, cost);
    eb.appendChild(yen);
    eb.setAttribute('aria-label', eb.getAttribute('aria-label') + '（売上 ' + PhaseLogic.yen(est.amount) + '・原価 ' + (est.cost == null ? 'なし' : PhaseLogic.yen(est.cost)) + '・税込）');
  }
  phReeditTag(eb, est.reedit);
  // 工事掲示（Task 29）: 調査は「—」（押せない）。無ければ作る・1件なら開く・複数なら一覧。見積の提出で自動で作った下書きは「下書き（自動）」
  const nc = PhaseLogic.noticeCell(p, docs.notices);
  const nb = cell('notice', nc.state === 'none' ? '＋ 作る' : nc.text, nc.state === 'none' ? 'none add' : nc.state === 'na' ? 'none' : nc.state === 'auto' ? 'wait' : 'ok',
    nc.state === 'none' ? '工事掲示を作る' : nc.state === 'na' ? '調査には工事掲示はありません' : '工事掲示を開く',
    b => nc.state === 'none' ? phMakeNotice(b, p, errId) : nc.open ? (location.hash = '#notice/' + nc.open.id) : (location.hash = '#case/' + s.caseId + '/notices'),
    nc.state === 'none' ? '未' : nc.state === 'auto' ? '自動' : '');
  if (nc.state === 'na') { nb.disabled = true; nb.classList.add('ph-na'); }
  // 請求
  cell('bill', row.bill.text, row.bill.state === 'unbilled' ? '' : 'ok', p.billed_at ? '請求の記録' : '請求した', () => phOpenCell(p, 'bill'),
    p.billed_at ? PhaseLogic.fmtMD(p.billed_at) : '');
  // 入金日（請求前は押せない）
  const pay = row.payment;
  const pb = cell('pay', pay.text, pay.state === 'overdue' ? 'red' : pay.state === 'paid' ? 'ok' : pay.state === 'none' ? 'none' : 'wait',
    pay.state === 'paid' ? '入金の記録' : pay.state === 'none' ? '請求した後に入れられます' : '入金確認', () => phOpenCell(p, 'pay'),
    pay.state === 'paid' ? '✓ ' + PhaseLogic.fmtMD(p.paid_at) : '');
  if (pay.state === 'none') pb.disabled = true;
  if (pay.state === 'overdue') pb.title = '入金期限を過ぎています';
  // 確認（作業担当者）。Task 28: 期限を過ぎて未提出・作業担当者が自分以外 →「⚠ 催促する」を赤で。催促したら「催促 M/D（n回）」
  const wc = PhaseLogic.workerCell(p, phMembers());
  const nd = phNudgeState(p, docs);
  const cb = cell('confirm', nd.urge ? '催促する' : wc.text, nd.urge ? 'red ph-urge' : wc.key === 'ack' ? 'ok' : wc.key === 'notified' ? 'wait' : 'none',
    nd.urge ? '期限を過ぎています。担当者に催促する' : '担当者に知らせる', () => phOpenCell(p, 'confirm'), nd.urge ? '催促する' : wc.short);
  const nt = PhaseLogic.nudgeText(p);
  if (nt) { cb.appendChild(mk('span', 'ph-nudged', nt)); cb.dataset.nudged = String(p.nudge_count || 0); }
  if (row.brief) cb.classList.add('brief');

  if (open) tr.appendChild(phPanel(p, open, docs, errId, row));
  const fl = phFlagsEl(p, errId);
  if (fl) tr.appendChild(fl);
  const err = mk('div', 'err ph-row-err');
  err.id = errId;
  err.setAttribute('role', 'alert');
  tr.appendChild(err);
  return tr;
}

// Task 43: 作業担当者がこの対応のタスクを削除した・差し戻した（有効なものだけ）。管理者は「戻す」「済みにする」（rpc task_flag_close）
function phFlagsEl(p, errId) {
  const list = p.task_flags || [];
  if (!list.length) return null;
  const owner = !!(ctx && ctx.membership && ctx.membership.role === 'owner');
  const box = mk('div', 'ph-flags');
  list.forEach(f => {
    const m = phMembers().find(x => x.user_id === f.created_by);
    const who = (m && m.display_name) || '作業担当者';
    const todo = PhaseLogic.TASK_TODO[f.task] || '';
    const el = mk('div', 'ph-flag ' + f.action);
    el.dataset.flagId = f.id;
    el.dataset.action = f.action;
    const t = mk('span', 'ph-flag-t');
    if (f.action === 'sendback') {
      t.append(mk('span', 'ph-flag-tag', '差し戻し'), document.createTextNode(who + '「' + todo + '」' + PhaseLogic.fmtMD(f.created_at) + ': ' + f.body));
    } else {
      t.append(mk('span', 'ph-flag-tag', '削除'), document.createTextNode(who + 'が「' + todo + '」のタスクを削除（' + PhaseLogic.fmtMD(f.created_at) + '）。対応はそのままです'));
    }
    el.appendChild(t);
    if (owner) {
      const label = f.action === 'sendback' ? '済みにする' : '戻す';
      const b = dBtn(label, 'linkbtn ph-flag-close', btn => phRun(btn, errId, f.action === 'sendback' ? '差し戻しを済みにする' : 'タスクを戻す', () => PhasesApi.closeTaskFlag(f.id)));
      b.setAttribute('aria-label', label + ': ' + who + 'の「' + todo + '」');
      el.appendChild(b);
    }
    box.appendChild(el);
  });
  return box;
}

// Task 35: 表のセルに再編集の小さな札（「再編集中」「再編集あり」。いつ・誰がは title と読み上げ）
function phReeditTag(b, m) {
  if (!b || !m || !m.short) return;
  const t = mk('span', 'reedit-tag ph-reedit', m.short);
  t.title = m.text;
  b.appendChild(t);
  b.dataset.reedit = m.key;
  b.setAttribute('aria-label', b.getAttribute('aria-label') + '（' + m.text + '）');
}

// セルの下に開く編集欄
function phPanel(p, col, docs, errId, row) {
  const s = ph;
  const box = mk('div', 'ph-panel');
  box.dataset.col = col;
  const hd = mk('div', 'ph-panel-hd');
  hd.appendChild(mk('b', null, row.title + ' ・ ' + PH_COL_LABEL[col]));
  const x = dBtn('×', 'ph-panel-x', () => { phCloseCell(s); phDraw(); });
  x.setAttribute('aria-label', '閉じる');
  hd.appendChild(x);
  box.appendChild(hd);
  const body = mk('div', 'ph-panel-b');
  const caseRow = currentCase || {};
  const title = phTitle(p);
  if (col === 'when') {
    body.appendChild(phScheduleForm(p, errId));
  } else if (col === 'status') {
    const st = row.stage;
    const now = body.appendChild(mk('div', 'ph-sub ph-st-now', '対応状況: '));
    if (st.ball) now.appendChild(Icon.dot(st.ball));
    now.append(st.ball ? st.label : '✓ ' + st.label);
    phStatusBody(p, st, docs, errId).forEach(el => body.appendChild(el));
  } else if (col === 'report') {
    phReportFlow(p, docs, errId, true).forEach(el => body.appendChild(el));
  } else if (col === 'bill') {
    const amount = PhaseLogic.billingAmount(p, docs.estimates);
    if (!p.billed_at && s.billForm.has(p.id)) {
      body.appendChild(mk('div', 'ph-sub', '金額: ' + (amount == null ? '未定（詳細ページの請求の段で直せます）' : PhaseLogic.yen(amount)) + ' ・ 請求先: ' + PhaseLogic.billToLabel(p, caseRow)));
      body.appendChild(phDueForm(p, errId, PhaseLogic.paymentDueDefault(p, new Date()), '請求した（記録する）', 'ph-bill-ok', '請求の記録', async due => {
        await phBillOne(PhasesApi.setBilled, p, true, { title, amount, billTo: PhaseLogic.billToLabel(p, caseRow) }, due);
        if (phAlive(s)) { s.billForm.delete(p.id); s.cell = null; }
      }, () => { s.billForm.delete(p.id); s.cell = null; },
      '入金期限の初期値: ' + (p.billing_mode === 'monthly' ? '請求月の翌月末' : '請求日の30日後') + '（変えられます）'));
    } else if (p.billed_at) {
      const line = mk('div', 'ph-row ph-bill-state');
      line.appendChild(mk('span', 'ph-bl-on', '請求 ' + PhaseLogic.fmtMD(p.billed_at)));
      if (!p.paid_at) line.appendChild(dBtn('請求を取り消す', 'btn sm ghost inline ph-billed-undo', b => phRun(b, errId, '請求の取り消し',
        () => phBillOne(PhasesApi.setBilled, p, false, { title }))));
      else line.appendChild(mk('span', 'ph-sub', '入金確認済みです（取り消すときは入金日の欄から）'));
      body.appendChild(line);
    }
  } else if (col === 'pay') {
    const amount = PhaseLogic.billingAmount(p, docs.estimates);
    if (s.dueEdit.has(p.id)) {
      body.appendChild(phDueForm(p, errId, p.payment_due || PhaseLogic.paymentDueDefault(p, p.billed_at), '保存', 'ph-due-save', '入金期限の保存',
        async due => { await PhasesApi.setPaymentDue(p, due, title); if (phAlive(s)) s.dueEdit.delete(p.id); },
        () => s.dueEdit.delete(p.id), ''));
    } else if (p.paid_at) {
      const line = mk('div', 'ph-row');
      line.appendChild(mk('span', 'ph-bl-on paid', '入金確認 ' + PhaseLogic.fmtMD(p.paid_at)));
      line.appendChild(dBtn('入金確認を取り消す', 'btn sm ghost inline ph-paid-undo', b => phRun(b, errId, '入金確認の取り消し',
        () => phBillOne(PhasesApi.setPaid, p, false, { title }))));
      body.appendChild(line);
    } else if (p.billed_at) {
      const over = PhaseLogic.isOverdue(p, new Date());
      const dl = mk('div', 'ph-row ph-bill-due' + (over ? ' over' : ''));
      dl.appendChild(mk('span', 'ph-bl-k', '入金期限'));
      dl.appendChild(mk('b', 'ph-bl-v num', p.payment_due ? PhaseLogic.fmtYmdMD(p.payment_due) : '未入力'));
      if (over) dl.appendChild(mk('span', 'ph-over', '入金期限超過'));
      dl.appendChild(dBtn('期限を変える', 'linkbtn ph-due-edit', () => { s.dueEdit.add(p.id); phMsg(errId, ''); phDraw(); phFocusPanel(s); }));
      body.appendChild(dl);
      const acts = mk('div', 'ph-acts');
      acts.appendChild(dBtn('入金確認', 'btn sm inline ph-paid', b => phRun(b, errId, '入金確認',
        async () => { await phBillOne(PhasesApi.setPaid, p, true, { title, amount }); if (phAlive(s)) s.cell = null; })));
      body.appendChild(acts);
    }
  } else if (col === 'confirm') {
    phWorkerBody(p, docs, errId).forEach(el => body.appendChild(el));
  } else if (col === 'worker') {
    body.appendChild(phWorkerSelect(p, errId));
    body.appendChild(mk('div', 'ph-sub', '変えると、このフェーズの未提出の報告書の作業者も同じ人になります。知らせる・催促は「確認」の欄から'));
  }
  box.appendChild(body);
  return box;
}

// 報告書・見積書をこのフェーズで作る（詳細ページの「＋ 報告書を作る」「＋ 見積書を作る」と同じ）
function phMakeReport(btn, p, errId) {
  const s = ph;
  if (!phAlive(s) || s.running.has(errId)) return;
  phMsg(errId, '');
  s.running.add(errId);
  return withBusy(btn, async () => {
    try {
      // Task 26: 作業担当者の初期値 = このフェーズの作業担当者（未設定なら空欄。編集画面で選べる。以後は DB が作業担当者にそろえる: migration 046）
      const f = PhaseLogic.reportFields(p, currentCase, { title: phTitle(p) });
      // 調査で作る報告書（調査区分）は、この調査の調査結果を 原因／原因と判断した理由／次の対応方針 の初期値に（作成時だけ）
      if (p.kind === 'survey') {
        await phResSettle();
        f.init = PhaseLogic.reportInit(phResultOf(p), f.room);
      }
      if (!phAlive(s)) return;
      const row = await ReportsApi.create(s.caseId, f);
      if (phAlive(s)) location.hash = '#report/' + row.id;
    } catch (e) { if (phAlive(s)) phMsg(errId, '報告書を作れませんでした: ' + errText(e)); }
    finally { s.running.delete(errId); }
  });
}
function phMakeEstimate(btn, p, errId) {
  const s = ph;
  if (!phAlive(s) || s.running.has(errId)) return;
  phMsg(errId, '');
  s.running.add(errId);
  return withBusy(btn, async () => {
    try {
      // 工事で作る見積は、この案件の調査結果の注意事項を備考の初期値に（作成時だけ）
      const opts = { phase_id: p.id, phaseTitle: phTitle(p) };
      if (p.kind !== 'survey') {
        await phResSettle();
        const r = PhaseLogic.latestSurveyResult(phLivePhases());
        if (r) opts.noteExtra = PhaseLogic.estimateNoteExtra(r);
      }
      if (!phAlive(s)) return;
      const row = await EstimatesApi.create(s.caseId, currentCase, opts);
      if (phAlive(s)) location.hash = '#estimate/' + row.id;
    } catch (e) { if (phAlive(s)) phMsg(errId, '見積書を作れませんでした: ' + errText(e)); }
    finally { s.running.delete(errId); }
  });
}

// 工事掲示をこのフェーズで作る（工事日・調査結果の注意事項を初期値に）。roomNo: 号室の初期値（省略すると案件の号室。Task 19 の案件ページのツールからも）
function phMakeNotice(btn, p, errId, roomNo) {
  const s = ph;
  if (!phAlive(s) || s.running.has(errId)) return;
  phMsg(errId, '');
  s.running.add(errId);
  return withBusy(btn, async () => {
    try {
      const data = {};
      const room = roomNo !== undefined ? roomNo : (currentCase && currentCase.room ? String(currentCase.room) : '');
      if (room) data.roomNo = room;
      if (p.scheduled_at) {
        data.workDate = phYmd(p.scheduled_at);
        data.timeStart = phHm(p.scheduled_at);
        if (p.scheduled_end) {
          if (phYmd(p.scheduled_end) !== data.workDate) data.workDateEnd = phYmd(p.scheduled_end);
          data.timeEnd = phHm(p.scheduled_end);
        }
      }
      // この案件の調査結果の注意事項を工事内容のチェックの初期値に（作成時だけ）
      await phResSettle();
      const r = PhaseLogic.latestSurveyResult(phLivePhases());
      if (r) Object.assign(data, PhaseLogic.noticeInit(r));
      if (!phAlive(s)) return;
      const row = await NoticesApi.create(s.caseId, currentCase, { phase_id: p.id, phaseTitle: phTitle(p), data });
      if (phAlive(s)) location.hash = '#notice/' + row.id;
    } catch (e) { if (phAlive(s)) phMsg(errId, '工事掲示を作れませんでした: ' + errText(e)); }
    finally { s.running.delete(errId); }
  });
}

// 請求の段の見出しの横に「未請求／請求済み・入金待ち／入金済み」（期限を過ぎて未入金なら「入金期限超過」）
function phBillTagged(st, p) {
  const t = st.querySelector('.ph-t');
  if (t) {
    const row = mk('div', 'ph-th');
    t.replaceWith(row);
    row.append(t, phBillTag(p));
  }
  return st;
}
function phBillTag(p) {
  const status = PhaseLogic.billStatus(p);
  const over = PhaseLogic.isOverdue(p, new Date());
  const tag = mk('span', 'bl-tag ' + (over ? 'over' : status), over ? '入金期限超過' : BL_STATUS_LABEL[status]);
  tag.dataset.status = over ? 'overdue' : status;
  return tag;
}
const BL_STATUS_LABEL = { unbilled: '未請求', billed: '請求済み・入金待ち', paid: '入金済み' };

function phStep(state, n, title, body) {
  const st = mk('div', 'ph-st ' + state);
  st.dataset.n = String(n);
  st.appendChild(mk('span', 'ph-dot', state === 'done' ? '✓' : String(n)));
  const d = mk('div', 'ph-d');
  d.appendChild(mk('div', 'ph-t', title));
  body.filter(Boolean).forEach(x => d.appendChild(x));
  st.appendChild(d);
  return st;
}

// カードのステップの状態（'done' | 'now' | 'later'）。i はステップの番号（0 から）
//   日時の段は日時が入っていないと済にしない（調査済みにした後で日時が未定のままのとき等）。
//   調査結果の段は何か入っていれば済（調査前に入れても済）、調査済みで未入力なら「今」
function phStepState(p, docs, i) {
  const isSurvey = p.kind === 'survey';
  const st = PhaseLogic.stage(p, { estimates: docs.estimates, reports: docs.reports }, new Date(), phStageOpts());
  const map = isSurvey ? PH_STEP_INDEX.survey : PH_STEP_INDEX.work;
  const hasRes = isSurvey && PhaseLogic.hasResult(phResultOf(p));
  let cur = map[st.key] != null ? map[st.key] : 0;
  if (isSurvey && (st.key === 'report' || st.key === 'check') && !hasRes) cur = 2;
  const schedIdx = isSurvey ? 0 : 1;
  const resIdx = isSurvey ? 2 : -1;
  if (i === resIdx && hasRes) return 'done';
  if (i < cur) return (i === schedIdx && !p.scheduled_at) || i === resIdx ? 'later' : 'done';
  return i === cur ? 'now' : 'later';
}

function phCard(p) {
  const docs = phDocs(p);
  const isSurvey = p.kind === 'survey';
  const st = PhaseLogic.stage(p, { estimates: docs.estimates, reports: docs.reports }, new Date(), phStageOpts());
  const stateOf = i => phStepState(p, docs, i);
  const errId = 'ph-err-' + p.id;

  const card = mk('div', 'ph-card k-' + p.kind);
  card.dataset.phaseId = p.id;
  card.dataset.kind = p.kind;
  card.dataset.stage = st.key;

  const hd = mk('div', 'ph-hd');
  hd.appendChild(mk('span', 'ph-kind k-' + p.kind, PhaseLogic.kindLabel(p.kind)));
  hd.appendChild(mk('b', 'ph-n', p.kind === 'other' ? String(p.label || '').trim() : phSeqOf(p) + '回目'));
  hd.appendChild(mk('span', 'ph-sp'));
  const tag = mk('span', 'ph-stage ' + (st.ball === 'us' ? 'us' : st.ball === 'them' ? 'them' : 'done'),
    st.ball ? st.label : '✓ ' + st.label); // 自社の番・相手待ちの丸は CSS（.ph-stage.us/.them::before）
  tag.title = '今の段階';
  hd.appendChild(tag);
  card.appendChild(hd);

  const steps = mk('div', 'ph-steps');
  // 作業担当者の段（Task 6b）は日時の段の次。番号は並び順で振り直す（段階の判定 phStepState の i は今までどおり）
  let n = 0;
  const add = (state, title, body) => steps.appendChild(phStep(state, ++n, title, body));
  if (isSurvey) {
    add(stateOf(0), '調査日時', phScheduleBody(p, docs, errId));
    // Task 28: 作業担当者の段 = ①選ぶ → ②現場への指示（号室ごと）→ ③担当者に知らせる
    add(phWorkerStepState(p), '作業担当者', phWorkerBody(p, docs, errId, { brief: true }));
    add(stateOf(1), '調査した', phSurveyDoneBody(p, docs, errId).concat([phContactEl(p, docs.mails)]));
    add(stateOf(2), '調査結果', phResultBody(p, docs));
    add(stateOf(3), '報告書', phReportsBody(p, docs, errId));
    add(stateOf(4), '見積書（この調査の分）', phEstimatesBody(p, docs, errId));
    // 精算（調査費用の請求）: 見積の有無にかかわらず常に出す（見積が無ければ金額は手入力）。見出しの横に請求の状態
    const bs = p.paid_at ? 'done' : p.done_at || p.billed_at ? 'now' : 'later';
    steps.appendChild(phBillTagged(phStep(bs, ++n, '精算', phBillingBody(p, docs, errId)), p));
  } else {
    add(stateOf(0), '見積（この工事の分）', phEstimatesBody(p, docs, errId));
    add(stateOf(1), '工事日の調整', phScheduleBody(p, docs, errId).concat(phNoticesBody(p, docs, errId)));
    add(phWorkerStepState(p), '作業担当者', phWorkerBody(p, docs, errId, { brief: true }));
    // Task 16: 「完了」の段（完了にする・取り消す）は無い。報告書が提出されると完了になる
    add(stateOf(3), '完了報告（報告書）', phWorkDoneBody(p, docs, errId).concat(phReportsBody(p, docs, errId)));
    steps.appendChild(phBillTagged(phStep(stateOf(4), ++n, '請求', phBillingBody(p, docs, errId)), p));
  }
  card.appendChild(steps);
  card.appendChild(phFoot(p, docs, errId));
  const err = mk('div', 'err ph-err');
  err.id = errId;
  card.appendChild(err);
  return card;
}


/* ---- 日時と連絡メール・リマインド ---- */
function phScheduleBody(p, docs, errId) {
  const out = [];
  const isSurvey = p.kind === 'survey';
  const editing = ph.editing.has(p.id);
  if (editing) {
    out.push(phScheduleForm(p, errId));
  } else {
    const line = mk('div', 'ph-row');
    const when = mk('span', 'ph-when' + (p.scheduled_at ? '' : ' none'), p.scheduled_at
      ? PhaseLogic.fmtRange(p.scheduled_at, p.scheduled_end) : '未定');
    line.appendChild(when);
    const eb = dBtn(p.scheduled_at ? '変更' : (isSurvey ? '調査日時を決める' : '工事日を決める'),
      p.scheduled_at ? 'linkbtn ph-sched-edit' : 'btn sm inline ph-sched-edit', () => {
        ph.editing.add(p.id);
        phDraw();
        const i = ph.root.querySelector('[data-phase-id="' + p.id + '"] .ph-sched-start');
        if (i) i.focus();
      });
    line.appendChild(eb);
    out.push(line);
  }
  if (!p.scheduled_at) return out;

  // 日程連絡のメール（purpose schedule）
  const sched = docs.mails.filter(m => m.purpose === 'schedule')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const draft = sched.find(m => m.status === 'draft');
  const sent = sched.find(m => m.status === 'sent');
  const what = isSurvey ? '調査日のご連絡' : '工事日のご連絡';
  const ml = mk('div', 'ph-mail');
  if (draft) {
    const who = PhaseLogic.recipientsLabel(draft.recipients, currentCase).split('・').filter(Boolean);
    ml.appendChild(Icon.prepend(mk('span', null, what + ': ' + (draft.skipped_at ? '今回は送らない' : '下書きあり') +
      (who.length ? '（' + who.join('・') + '）' : '（宛先のメール未登録）')), 'mail', 14));
    const b = dBtn('確認して送る', 'btn sm inline ph-mail-open', () => openMailDraft(draft.id));
    b.dataset.draftId = draft.id;
    ml.appendChild(b);
  } else if (sent) {
    ml.appendChild(Icon.prepend(mk('span', null, what + ' ' + PhaseLogic.fmtMD(sent.sent_at) + ' 送信済み'), 'mail', 14));
  } else {
    ml.appendChild(Icon.prepend(mk('span', 'ph-sub', what + ': 下書きがありません（日時を保存し直すと作られます）'), 'mail', 14));
  }
  out.push(ml);

  // リマインド（3日前・前日の 18:00 に、入居者・物件オーナー宛ての下書きを作る。作るのはアプリを開いたとき）
  const open = !p.done_at && Date.parse(p.scheduled_at) > Date.now();
  const rs = PhaseLogic.reminderState(p, docs.mails, new Date());
  if (open || !rs.none) {
    const rm = mk('div', 'ph-remind');
    if (rs.none) {
      Icon.prepend(rm, 'clock', 14).append('リマインドなし（日時を入れたのが前日18:00より後のため）');
    } else {
      rm.appendChild(Icon.prepend(mk('div', 'ph-rm-t', 'リマインド（3日前・前日の18:00に下書きを作ります）'), 'clock', 14));
      rs.slots.forEach(x => {
        const row = mk('div', 'ph-rm');
        row.dataset.slot = x.slot;
        row.dataset.state = x.state;
        row.appendChild(mk('span', null, x.label + ' ' + PhaseLogic.fmtMDWHM(x.at)));
        row.appendChild(mk('span', 'ph-rm-s', PH_REMIND_STATE[x.state] +
          (x.state === 'sent' && x.draft && x.draft.sent_at ? ' ' + PhaseLogic.fmtMD(x.draft.sent_at) : '')));
        if (x.state === 'draft' || x.state === 'skipped') {
          const b = dBtn(x.state === 'draft' ? '確認して送る' : '開く', (x.state === 'draft' ? 'btn sm inline' : 'linkbtn') + ' ph-rm-open',
            () => openMailDraft(x.draft.id));
          b.dataset.draftId = x.draft.id;
          row.appendChild(b);
        }
        rm.appendChild(row);
      });
    }
    out.push(rm);
  }
  return out;
}

function phScheduleForm(p, errId) {
  const isSurvey = p.kind === 'survey';
  const form = mk('div', 'ph-form');
  const start = document.createElement('input');
  start.type = 'datetime-local';
  start.className = 'ph-sched-start';
  start.value = phToInput(p.scheduled_at);
  start.step = 300;
  const l1 = mk('label', null, isSurvey ? '調査日時（日本時間）' : '工事の開始（日本時間）');
  l1.appendChild(start);
  form.appendChild(l1);
  let end = null;
  if (!isSurvey) {
    end = document.createElement('input');
    end.type = 'datetime-local';
    end.className = 'ph-sched-end';
    end.value = phToInput(p.scheduled_end);
    end.step = 300;
    const l2 = mk('label', null, '終わり（任意）');
    l2.appendChild(end);
    form.appendChild(l2);
  }
  form.appendChild(mk('div', 'ph-sub', '保存すると、依頼元への連絡メールの下書きができます（送るのは「確認して送る」から）'));
  const acts = mk('div', 'ph-acts');
  acts.appendChild(dBtn('キャンセル', 'btn sm ghost inline', () => { ph.editing.delete(p.id); phMsg(errId, ''); phDraw(); }));
  if (p.scheduled_at) {
    acts.appendChild(dBtn('未定に戻す', 'btn sm ghost inline ph-sched-clear', b => phSaveSchedule(b, p, null, null, errId)));
  }
  acts.appendChild(dBtn('保存', 'btn sm inline ph-sched-save', b => {
    const s = phFromInput(start.value);
    if (!s) { phMsg(errId, (isSurvey ? '調査日時' : '工事の開始') + 'を入力してください'); start.focus(); return; }
    let e = null;
    if (end && end.value) {
      e = phFromInput(end.value);
      if (!e || Date.parse(e) < Date.parse(s)) { phMsg(errId, '終わりは開始より後にしてください'); end.focus(); return; }
    }
    return phSaveSchedule(b, p, s, e, errId);
  }));
  form.appendChild(acts);
  return form;
}

function phSaveSchedule(btn, p, startIso, endIso, errId) {
  const s = ph;
  return phRun(btn, errId, '日時の保存', async () => {
    try {
      await PhasesApi.saveSchedule(p, startIso, endIso, currentCase, s.data.drafts, phTitle(p));
    } finally {
      if (phAlive(s)) s.editing.delete(p.id);
    }
  });
}

/* ---- 調査した・完了報告（Task 16: 報告書の流れ。手で「調査済み」「完了」にするボタンは無い） ---- */
// 調査の「調査した」の段: 調査済みの日（報告書の提出で自動）＋ 報告書を開く（Task 25）
function phSurveyDoneBody(p, docs, errId) {
  const line = mk('div', 'ph-row ph-done-line');
  if (p.done_at) line.appendChild(mk('span', 'ph-done', PhaseLogic.fmtMD(p.done_at) + ' 調査済み（報告書の提出）'));
  else line.appendChild(mk('span', 'ph-sub', '報告書が提出されると、自動で「調査した」になります'));
  return [line].concat(phReportFlow(p, docs, errId, false));
}
// 工事の「完了報告（報告書）」の段: 完了の日（報告書の提出で自動）＋ 報告書を開く
function phWorkDoneBody(p, docs, errId) {
  const line = mk('div', 'ph-row ph-done-line');
  if (p.done_at) line.appendChild(mk('span', 'ph-done', PhaseLogic.fmtMD(p.done_at) + ' 完了（報告書の提出）'));
  else line.appendChild(mk('span', 'ph-sub', '工事が終わったら報告書を作ってください。報告書が提出されると、自動で完了になります'));
  return [line].concat(phReportFlow(p, docs, errId, false));
}

// 表の「対応状況」の欄: 今の段階の次にやること（段階は画面の操作から自動で決まる。ここで段階を変えるボタンは無い）
function phStatusBody(p, st, docs, errId) {
  const s = ph;
  const out = [];
  const hint = t => out.push(mk('div', 'ph-sub ph-st-hint', t));
  const reportKeys = ['visit', 'waiting', 'write', 'check', 'report'];
  if (p.kind === 'survey' && st.key === 'waiting') hint('作業担当者の報告を待っています（担当者URLか報告書の画面から提出されます）');
  if (p.kind === 'survey') {
    if (st.key === 'schedule') {
      hint('調査日時を決めてください（日時の欄から）。先に報告書の用意をするときは下から');
    } else if (st.key === 'approval') hint('発注待ちです（見積の欄から開けます）');
    else if (st.key === 'payment') hint('入金を待っています（入金日の欄から入金確認）');
    else if (st.key === 'done') hint('このフェーズは完了しています');
    if (st.key === 'schedule' || reportKeys.includes(st.key)) out.push(...phReportFlow(p, docs, errId, true));
    return out;
  }
  if (st.key === 'estimate') {
    hint('このフェーズの見積書を作ってください');
    out.push(dBtn('＋ 見積書を作る', 'btn sm inline ph-st-est', b => phMakeEstimate(b, p, errId)));
  } else if (st.key === 'issued' || st.key === 'approval') {
    hint(st.key === 'issued' ? '見積書は提出（番号付き）済みです。見積書を開いて依頼元に送付してください' : '依頼元からの発注（見積の承諾）を待っています');
    out.push(dBtn('見積書の一覧へ', 'btn sm ghost inline ph-st-est', () => { location.hash = '#case/' + s.caseId + '/estimates'; }));
  } else if (st.key === 'schedule') {
    hint('工事日を決めてください');
    out.push(dBtn('工事日を入れる', 'btn sm inline ph-st-when', () => { phCloseCell(s); phOpenCell(p, 'when'); }));
  } else if (st.key === 'work') {
    hint('工事日を過ぎると「完了報告必要」になります。先に報告書の用意をするときは下から');
    out.push(...phReportFlow(p, docs, errId, true));
  } else if (st.key === 'report') {
    out.push(...phReportFlow(p, docs, errId, true));
  } else if (st.key === 'bill') hint('報告書は送付済みです。請求の欄から「請求した」を記録してください');
  else if (st.key === 'payment') hint('入金を待っています（入金日の欄から入金確認）');
  else if (st.key === 'done') hint('このフェーズは完了しています');
  return out;
}

// 報告書の流れ（このフェーズの報告書の状態に合わせて出す）。Task 25: 2択（担当者へURLを渡す／自社で作る）は廃止し「報告書を開く」1つ
//   提出前（下書き・無い）→ 「報告書を開く」（無ければ報告書と担当者URLを作って開く）。担当者URLは確認依頼メールの本文と ⑦（Task 26）
//   提出済み・確認済み → 開く（contact = true なら 報告連絡 の行も。詳細ページは下の「報告書」の段に出る）
function phReportFlow(p, docs, errId, contact) {
  const out = [];
  const box = mk('div', 'ph-flow');
  box.dataset.phaseId = p.id;
  const reps = docs.reports;
  const me = phMyId();
  const sent = reps.find(r => r.status === 'sent');
  const confirmed = reps.find(r => r.status === 'confirmed');
  const submitted = reps.find(r => r.status === 'submitted');
  const open = (r, label) => dBtn(label, 'btn sm ghost inline ph-flow-open', () => { location.hash = '#report/' + r.id; });
  const done = sent || confirmed || submitted;
  if (done) {
    const check = typeof ReportLogic !== 'undefined' ? ReportLogic.needsCheck(done, me) : done.submitted_via === 'share';
    box.dataset.state = done.status;
    const line = mk('div', 'ph-row');
    line.appendChild(mk('span', 'ph-sub', done.status === 'sent' ? '報告書は送付済みです'
      : done.status === 'confirmed' ? '報告書は確認済みです。依頼元に送ってください'
        : '報告書が提出されました（' + (done.submitted_at ? PhaseLogic.fmtMD(done.submitted_at) + '・' : '') + (done.worker_name || '社内') + '）。'
          + (check ? '内容を確認してください' : '依頼元に送ってください')));
    line.appendChild(open(done, check ? '報告書を開いて確認' : '報告書を開く'));
    box.appendChild(line);
    if (contact && done.status !== 'sent') {
      const rc = phReportContactEl(done, PhaseLogic.docTrack(done, docs.mails), errId);
      if (rc) box.appendChild(rc);
    } else if (done.status !== 'sent') box.appendChild(mk('div', 'ph-sub', '下の「報告書」の段から確認して報告連絡できます'));
  } else {
    box.dataset.state = reps.length ? 'draft' : 'none';
    const st = PhaseLogic.stage(p, { estimates: docs.estimates, reports: reps }, new Date(), phStageOpts());
    if (st.key === 'waiting') box.appendChild(mk('div', 'ph-flow-wait')).append(Icon.dot('them'), st.label + (st.due ? '・期限 ' + PhaseLogic.fmtYmdMD(st.due) : ''));
    box.appendChild(mk('div', 'ph-sub', '作業担当者が担当者URL（確認依頼のメールに入ります）か報告書の画面から入力・提出します。提出すると次へ進みます'));
    const acts = mk('div', 'ph-flow-acts');
    acts.appendChild(dBtn('報告書を開く', 'btn sm inline ph-flow-open', b => phOpenReport(b, p, docs, errId)));
    box.appendChild(acts);
  }
  out.push(box);
  return out;
}
// 「報告書を開く」: このフェーズの一番新しい報告書を開く。無ければ報告書と担当者URLを作ってから開く（Task 25）
function phOpenReport(btn, p, docs, errId) {
  const s = ph;
  const last = docs.reports.slice().sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''))).pop();
  if (last) { location.hash = '#report/' + last.id; return; }
  if (!phAlive(s) || s.running.has(errId)) return;
  phMsg(errId, '');
  s.running.add(errId);
  return withBusy(btn, async () => {
    try {
      if (p.kind === 'survey') await phResSettle();
      const cur = Object.assign({}, p, p.kind === 'survey' ? { result: phResultOf(p) } : {});
      const r = await ReportsApi.ensurePhaseReport(cur, currentCase, { reports: [], title: phTitle(p), force: true });
      if (phAlive(s) && r && r.report) location.hash = '#report/' + r.report.id;
    } catch (e) { if (phAlive(s)) phMsg(errId, '報告書を作れませんでした: ' + errText(e)); }
    finally { s.running.delete(errId); }
  });
}
/* ---- 調査した → 依頼元へ報告連絡（「調査結果のご報告」purpose survey_result の下書き。Task 5b の仕組み） ---- */
// 未作成（調査結果を入れると下書きができる）／下書きあり → 確認して送る／送信済み M/D（宛先）
function phContactEl(p, mails) {
  const el = mk('div', 'ph-contact' + (p.done_at ? ' on' : ''));
  el.dataset.phaseId = p.id;
  const rs = phRes.get(p.id);
  const own = (mails || []).filter(m => m.phase_id === p.id && m.purpose === 'survey_result')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (rs && rs.draft && !own.some(m => m.id === rs.draft.id)) own.unshift(rs.draft);
  const draft = own.find(m => m.status === 'draft');
  const sent = own.find(m => m.status === 'sent');
  el.appendChild(Icon.prepend(mk('b', 'ph-ct-t', '依頼元へ報告連絡'), 'mail'));
  if (draft) {
    const who = PhaseLogic.recipientsLabel(draft.recipients, currentCase);
    el.dataset.state = draft.skipped_at ? 'skipped' : 'draft';
    el.appendChild(mk('span', null, '調査結果のご報告: ' + (draft.skipped_at ? '今回は送らない' : '下書きあり') + (who ? '（' + who + '）' : '（宛先のメール未登録）')));
    const b = dBtn('確認して送る', 'btn sm inline ph-ct-open', async btn => {
      btn.disabled = true;
      try { await phResSettle(); } finally { btn.disabled = false; }
      openMailDraft(btn.dataset.draftId);
    });
    b.dataset.draftId = draft.id;
    el.appendChild(b);
  } else if (sent) {
    const who = PhaseLogic.recipientsLabel(sent.recipients, currentCase);
    el.dataset.state = 'sent';
    el.appendChild(mk('span', 'ph-ct-sent', '調査結果のご報告 ' + PhaseLogic.fmtMD(sent.sent_at) + ' 送信済み' + (who ? '（' + who + '）' : '')));
  } else {
    el.dataset.state = 'none';
    el.appendChild(mk('span', 'ph-sub', '未作成です。下の「調査結果」を入れると「調査結果のご報告」の下書きができます'));
    el.appendChild(dBtn('調査結果を入れる', 'linkbtn ph-ct-go', () => {
      const ta = ph && ph.root && ph.root.querySelector('.ph-result[data-phase-id="' + p.id + '"] .ph-res-cause, .ph-result[data-phase-id="' + p.id + '"] .pd-room');
      if (ta) { ta.scrollIntoView({ block: 'center' }); ta.focus({ preventScroll: true }); }
    }));
  }
  return el;
}

/* ---- 書類 ---- */
function phTrackEl(t) {
  const tr = mk('div', 'ph-track');
  t.steps.forEach(x => {
    const c = mk('span', x.done ? 'on' : null, x.label + (x.done && x.date ? ' ' + PhaseLogic.fmtMD(x.date) : ''));
    c.dataset.step = x.key;
    tr.appendChild(c);
  });
  return tr;
}
function phSentToText(t) {
  const who = t.sentTo.map(k => (PhaseLogic.RECIPIENTS.find(r => r.key === k) || {}).label).filter(Boolean);
  const shared = t.steps.find(x => x.key === 'shared');
  if (!shared || !shared.done) return 'まだ誰にも送っていません';
  return (shared.date ? PhaseLogic.fmtMD(shared.date) + ' ' : '') + (who.length ? who.join('・') + 'に送付' : '送付済み');
}

function phEstimatesBody(p, docs, errId) {
  const out = [];
  docs.latest.forEach(e => {
    const t = PhaseLogic.docTrack(e, docs.mails);
    const box = mk('div', 'ph-doc');
    box.dataset.docType = 'estimate';
    box.dataset.docId = e.id;
    box.dataset.track = t.current;
    const top = mk('div', 'ph-row');
    const subj = e.data && typeof e.data.subject === 'string' && e.data.subject.trim() ? e.data.subject.trim() : '御見積';
    top.appendChild(mk('b', 'ph-doc-t', subj + ' v' + e.version));
    top.appendChild(mk('span', 'ph-sp'));
    top.appendChild(dBtn(e.status === 'draft' ? '開いて編集' : '開く', 'linkbtn', () => { location.hash = '#estimate/' + e.id; }));
    box.appendChild(top);
    box.appendChild(phTrackEl(t));
    const yen = typeof EstimateLogic !== 'undefined' ? EstimateLogic.yen(e.total) : String(e.total);
    box.appendChild(mk('div', 'ph-sub', yen + ' ・ ' + phSentToText(t)));
    out.push(box);
  });
  const b = dBtn('＋ 見積書を作る', 'ph-mkdoc ph-mk-estimate', btn => phMakeEstimate(btn, p, errId));
  out.push(b);
  return out;
}

function phReportsBody(p, docs, errId) {
  const out = [];
  docs.reports.forEach(r => {
    const t = PhaseLogic.docTrack(r, docs.mails);
    const box = mk('div', 'ph-doc');
    box.dataset.docType = 'report';
    box.dataset.docId = r.id;
    box.dataset.track = t.current;
    const top = mk('div', 'ph-row');
    const label = (typeof ReportLogic !== 'undefined' && ReportLogic.WORK_TYPE_LABEL[r.work_type]) || '';
    top.appendChild(mk('b', 'ph-doc-t', '作業報告書' + (label ? '（' + label + '）' : '') + (r.room ? ' ' + r.room : '')));
    top.appendChild(mk('span', 'ph-sp'));
    top.appendChild(dBtn(r.status === 'draft' ? '開いて入力' : '開く', 'linkbtn', () => { location.hash = '#report/' + r.id; }));
    box.appendChild(top);
    box.appendChild(phTrackEl(t));
    box.appendChild(mk('div', 'ph-sub', phReportStatus(r) + ' ・ ' + phSentToText(t)));
    const rc = phReportContactEl(r, t, errId);
    if (rc) box.appendChild(rc);
    out.push(box);
  });
  // 報告書が無いときは「調査した」（工事は「完了報告」）の段の「報告書を開く」で作る。あるときだけ追加の「＋ 報告書を作る」
  if (!docs.reports.length) {
    out.push(mk('div', 'ph-sub', 'まだありません。上の「報告書を開く」で作れます'));
    return out;
  }
  const b = dBtn('＋ 報告書を作る', 'ph-mkdoc ph-mk-report', btn => phMakeReport(btn, p, errId));
  out.push(b);
  return out;
}

// 報告書の「報告連絡」: 提出済み以降なら、既存の送付メール（purpose report の下書き）を開く／作る（既存の報告書送付の流れを呼ぶだけ）。
//   提出済み（確認待ち）→ 確認して下書きを作る（ReportsApi.confirm）／確認済み → 下書きを作る（createDraft）か開く／送付済み → 「M/D に送付（宛先）」
function phReportContactEl(r, t, errId) {
  if (!r || r.status === 'draft') return null;
  const row = mk('div', 'ph-row ph-rep-contact');
  row.dataset.reportId = r.id;
  const mails = ph.data.drafts.filter(m => m.report_id === r.id);
  const draft = mails.filter(m => m.status === 'draft').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  const shared = t.steps.find(x => x.key === 'shared');
  if (shared && shared.done) {
    const who = PhaseLogic.recipientsLabel(t.sentTo);
    row.dataset.state = 'sent';
    row.appendChild(mk('span', 'ph-ct-sent', (shared.date ? PhaseLogic.fmtMD(shared.date) + ' に' : '') + '送付' + (who ? '（' + who + '）' : '')));
    if (draft) row.appendChild(dBtn('もう一度送る（下書きを開く）', 'linkbtn ph-rep-ct', () => openMailDraft(draft.id)));
    return row;
  }
  const s = ph;
  const openNew = async (btn, make) => {
    phMsg(errId, '');
    await withBusy(btn, async () => {
      try {
        const d = await make();
        if (phAlive(s) && d && d.id) openMailDraft(d.id);
      } catch (e) { if (phAlive(s)) { phMsg(errId, '報告連絡の下書きを作れませんでした: ' + errText(e)); phLoad(); } }
    });
  };
  if (draft) {
    row.dataset.state = 'draft';
    row.appendChild(dBtn('報告連絡（確認して送る）', 'btn sm inline ph-rep-ct', () => openMailDraft(draft.id)));
  } else if (r.status === 'submitted') {
    // 担当者URL・別の人の提出は「確認して」。自分の提出はそのまま送る（Task 23・25）
    const share = typeof ReportLogic !== 'undefined' ? ReportLogic.needsCheck(r, phMyId()) : r.submitted_via === 'share';
    row.dataset.state = 'submitted';
    row.appendChild(dBtn(share ? '確認して報告連絡' : '報告書を送る', 'btn sm inline ph-rep-ct', b => openNew(b, async () => {
      const d = await ReportsApi.confirm(r, currentCase);
      notifyTimeline();
      return d;
    })));
    row.appendChild(mk('span', 'ph-sub', share ? '確認済みにして、依頼元への送付メールの下書きを開きます' : '依頼元への送付メールの下書きを開きます'));
  } else {
    row.dataset.state = 'none';
    row.appendChild(dBtn('報告連絡', 'btn sm inline ph-rep-ct', b => openNew(b, () => ReportsApi.createDraft(r, currentCase))));
  }
  return row;
}

function phNoticesBody(p, docs, errId) {
  const out = [];
  docs.notices.forEach(n => {
    const box = mk('div', 'ph-doc');
    box.dataset.docType = 'notice';
    box.dataset.docId = n.id;
    const top = mk('div', 'ph-row');
    top.appendChild(Icon.prepend(mk('b', 'ph-doc-t', '工事掲示 ' + ((typeof NoticeLogic !== 'undefined' && NoticeLogic.normalizeRoom(n.room)) || n.room || '号室未入力')), 'megaphone', 14));
    top.appendChild(mk('span', 'ph-sp'));
    top.appendChild(dBtn('開く', 'linkbtn', () => { location.hash = '#notice/' + n.id; }));
    box.appendChild(top);
    box.appendChild(mk('div', 'ph-sub', n.work_date_tbd ? '工事日 未定' : n.work_date ? '工事日 ' + n.work_date.replace(/^\d{4}-0?(\d+)-0?(\d+)$/, '$1/$2') : '工事日 未入力'));
    out.push(box);
  });
  // 号室の初期値（この案件の部屋／関係する部屋。候補が無ければ出さない。Task 12。js/notice-ui.js ntlRoomPicker）
  const pick = typeof ntlRoomPicker === 'function' ? ntlRoomPicker(currentCase, 'ph-notice-room-' + p.id) : null;
  if (pick) { pick.el.classList.add('ph-notice-room'); out.push(pick.el); }
  const b = dBtn('工事掲示を作る', 'ph-mkdoc ph-mk-notice', btn => phMakeNotice(btn, p, errId, pick && pick.value() ? pick.value() : ''));
  out.push(b);
  return out;
}

/* ---- 請求（対応フェーズ Task 7） ---- */
// 請求先（元請／物件オーナー／入居者／その他）・請求のしかた（単発／月ごと＋請求月）・金額（承諾された見積 → 送付済みの最新版 → 手入力）・
// 「請求した」（billed_at）・「入金確認」（paid_at）。どれも取り消せる。請求先の変更はシート（phBillToSheet）。記録は PhasesApi がタイムラインへ
const PH_BASIS = { override: '手入力', accepted: '承諾された見積', sent: '送付済みの見積（承諾前）' };

// 請求月の選択肢（'' = 完了月）。base の前後と、今の値・完了月を必ず含む
function phMonthSelect(p, value) {
  const sel = document.createElement('select');
  const doneYm = p.done_at ? PhaseLogic.jstYm(p.done_at) : '';
  const base = value || doneYm || PhaseLogic.jstYm(new Date());
  sel.appendChild(new Option(doneYm ? '完了した月（' + PhaseLogic.ymLabel(doneYm) + '）' : '完了した月（まだ完了していません）', ''));
  const months = new Set();
  for (let i = -3; i <= 6; i++) months.add(PhaseLogic.addMonth(base, i));
  if (value) months.add(value);
  [...months].sort().forEach(ym => sel.appendChild(new Option(PhaseLogic.ymLabel(ym), ym)));
  sel.value = value || '';
  return sel;
}

function phBillingBody(p, docs, errId) {
  const out = [];
  const title = phTitle(p);
  const caseRow = currentCase || {};
  const amount = PhaseLogic.billingAmount(p, docs.estimates);
  const basis = PhaseLogic.billingBasis(p, docs.estimates);
  const box = mk('div', 'ph-bill');
  box.dataset.status = PhaseLogic.billStatus(p);

  // 請求先
  const who = mk('div', 'ph-row ph-bill-to');
  who.appendChild(mk('span', 'ph-bl-k', '請求先'));
  who.appendChild(mk('b', 'ph-bl-v', PhaseLogic.billToLabel(p, caseRow)));
  who.appendChild(dBtn('請求先を変える', 'linkbtn ph-bill-change', () => phBillToSheet(p, errId)));
  box.appendChild(who);

  // 請求のしかた（月ごとなら請求月）
  const mode = mk('div', 'ph-row ph-bill-mode');
  mode.appendChild(mk('span', 'ph-bl-k', '請求のしかた'));
  mode.appendChild(mk('span', 'ph-bl-v', PhaseLogic.BILLING_MODE_LABEL[p.billing_mode === 'monthly' ? 'monthly' : 'single']));
  box.appendChild(mode);
  if (p.billing_mode === 'monthly') {
    const ml = mk('label', 'ph-bill-month');
    ml.appendChild(mk('span', 'ph-bl-k', '請求月'));
    const sel = phMonthSelect(p, p.billing_month ? String(p.billing_month).slice(0, 7) : '');
    sel.className = 'ph-bill-month-sel';
    sel.addEventListener('change', () => phRun(sel, errId, '請求月の保存', () => PhasesApi.setBillingMonth(p, sel.value || null)));
    ml.appendChild(sel);
    box.appendChild(ml);
  } else if (p.done_at) {
    box.appendChild(mk('div', 'ph-sub', '請求の一覧では完了した月（' + PhaseLogic.ymLabel(PhaseLogic.jstYm(p.done_at)) + '）に出ます'));
  }

  // 金額
  if (ph.amountEdit.has(p.id)) {
    box.appendChild(phAmountForm(p, amount, basis, errId, title));
  } else {
    const am = mk('div', 'ph-row ph-bill-amount');
    am.appendChild(mk('span', 'ph-bl-k', '金額'));
    am.appendChild(mk('b', 'ph-bl-yen num' + (amount == null ? ' none' : ''), amount == null ? '未定' : PhaseLogic.yen(amount)));
    am.appendChild(mk('span', 'ph-sub', amount == null ? '（承諾・送付した見積がありません）' : '（' + PH_BASIS[basis] + '）'));
    am.appendChild(dBtn('金額を直す', 'linkbtn ph-bill-amount-edit', () => { ph.amountEdit.add(p.id); phMsg(errId, ''); phDraw(); }));
    box.appendChild(am);
  }

  // 請求した（入金期限を入れて記録）・入金期限・入金確認
  const st = mk('div', 'ph-row ph-bill-state');
  const s = ph;
  if (!p.billed_at && ph.billForm.has(p.id)) {
    box.appendChild(phDueForm(p, errId, PhaseLogic.paymentDueDefault(p, new Date()), '請求した（記録する）', 'ph-bill-ok', '請求の記録', async due => {
      await phBillOne(PhasesApi.setBilled, p, true, { title, amount, billTo: PhaseLogic.billToLabel(p, caseRow) }, due);
      if (phAlive(s)) s.billForm.delete(p.id);
    }, () => s.billForm.delete(p.id),
    '入金期限の初期値: ' + (p.billing_mode === 'monthly' ? '請求月の翌月末' : '請求日の30日後') + '（変えられます）'));
  } else if (!p.billed_at) {
    st.appendChild(dBtn('請求した', 'btn sm inline ph-billed', () => { ph.billForm.add(p.id); phMsg(errId, ''); phDraw(); }));
    st.appendChild(mk('span', 'ph-sub', p.billing_mode === 'monthly'
      ? '月ごとの元請は、請求の一覧（右上の円のボタン）で同じ月の分をまとめて「請求した」にもできます'
      : '請求書を出したら押してください（入金期限を入れて記録します。間違えたら取り消せます）'));
  } else {
    st.appendChild(mk('span', 'ph-bl-on', '請求 ' + PhaseLogic.fmtMD(p.billed_at)));
    if (!p.paid_at) {
      st.appendChild(dBtn('取り消す', 'linkbtn ph-billed-undo', b => phRun(b, errId, '請求の取り消し',
        () => phBillOne(PhasesApi.setBilled, p, false, { title }))));
      st.appendChild(dBtn('入金確認', 'btn sm inline ph-paid', b => phRun(b, errId, '入金確認',
        () => phBillOne(PhasesApi.setPaid, p, true, { title, amount }))));
    } else {
      st.appendChild(mk('span', 'ph-bl-on paid', '入金確認 ' + PhaseLogic.fmtMD(p.paid_at)));
      st.appendChild(dBtn('取り消す', 'linkbtn ph-paid-undo', b => phRun(b, errId, '入金確認の取り消し',
        () => phBillOne(PhasesApi.setPaid, p, false, { title }))));
    }
  }
  box.appendChild(st);
  // 入金期限（請求後）。期限を過ぎて未入金なら赤で「入金期限超過」
  if (p.billed_at) {
    if (ph.dueEdit.has(p.id)) {
      box.appendChild(phDueForm(p, errId, p.payment_due || PhaseLogic.paymentDueDefault(p, p.billed_at), '保存', 'ph-due-save', '入金期限の保存',
        async due => { await PhasesApi.setPaymentDue(p, due, title); if (phAlive(s)) s.dueEdit.delete(p.id); },
        () => s.dueEdit.delete(p.id), ''));
    } else {
      const over = PhaseLogic.isOverdue(p, new Date());
      const dl = mk('div', 'ph-row ph-bill-due' + (over ? ' over' : ''));
      dl.appendChild(mk('span', 'ph-bl-k', '入金期限'));
      dl.appendChild(mk('b', 'ph-bl-v num', p.payment_due ? PhaseLogic.fmtYmdMD(p.payment_due) : '未入力'));
      if (over) dl.appendChild(mk('span', 'ph-over', '入金期限超過'));
      if (!p.paid_at) dl.appendChild(dBtn('変更', 'linkbtn ph-due-edit', () => { ph.dueEdit.add(p.id); phMsg(errId, ''); phDraw(); }));
      box.appendChild(dl);
    }
  }
  out.push(box);
  return out;
}

// 入金期限の入力（請求したとき・変えるとき）。onOk(due) で保存、onCancel で閉じる
function phDueForm(p, errId, initial, okLabel, okCls, opLabel, onOk, onCancel, hint) {
  const form = mk('div', 'ph-form ph-due-form');
  const input = document.createElement('input');
  input.type = 'date';
  input.className = 'ph-due-input';
  input.value = initial || '';
  const l = mk('label', null, '入金期限');
  l.appendChild(input);
  form.appendChild(l);
  if (hint) form.appendChild(mk('div', 'ph-sub', hint));
  const acts = mk('div', 'ph-acts');
  acts.appendChild(dBtn('やめる', 'btn sm ghost inline ph-due-cancel', () => { onCancel(); phMsg(errId, ''); phDraw(); }));
  acts.appendChild(dBtn(okLabel, 'btn sm inline ' + okCls, b => {
    const v = input.value;
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { phMsg(errId, '入金期限の日付を正しく入れてください'); input.focus(); return; }
    return phRun(b, errId, opLabel, () => onOk(v || null));
  }));
  form.appendChild(acts);
  return form;
}

// 1フェーズの請求・入金の記録。別の人が先に記録していた等で変わらなかったら知らせる
async function phBillOne(fn, p, on, info, due) {
  const rows = await fn([Object.assign({ phase: p }, info)], on, due);
  if (!rows.length) throw new Error('記録できませんでした（ほかの人が先に記録したか、入金確認済みの可能性があります。表示を更新しました）');
}

function phAmountForm(p, amount, basis, errId, title) {
  const form = mk('div', 'ph-form ph-amount-form');
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.autocomplete = 'off';
  input.className = 'ph-amount-input num';
  input.maxLength = 20;
  input.placeholder = '例: 116800';
  input.value = amount != null ? String(amount) : '';
  const l = mk('label', null, '請求額（円）');
  l.appendChild(input);
  form.appendChild(l);
  form.appendChild(mk('div', 'ph-sub', '見積と違う金額で請求するときに入れます（値引き・追加など）。見積の金額は変わりません'));
  const acts = mk('div', 'ph-acts');
  acts.appendChild(dBtn('キャンセル', 'btn sm ghost inline ph-amount-cancel', () => { ph.amountEdit.delete(p.id); phMsg(errId, ''); phDraw(); }));
  const s = ph;
  if (basis === 'override') {
    acts.appendChild(dBtn('見積の金額に戻す', 'btn sm ghost inline ph-amount-reset', b => phRun(b, errId, '金額の保存', async () => {
      await PhasesApi.setAmount(p, null, title);
      if (phAlive(s)) s.amountEdit.delete(p.id);
    })));
  }
  acts.appendChild(dBtn('保存', 'btn sm inline ph-amount-save', b => {
    const v = PhaseLogic.parseYen(input.value);
    if (!v.ok || v.value == null) { phMsg(errId, '金額は 0 以上の整数（円）で入れてください'); input.focus(); return; }
    return phRun(b, errId, '金額の保存', async () => {
      await PhasesApi.setAmount(p, v.value, title);
      if (phAlive(s)) s.amountEdit.delete(p.id);
    });
  }));
  form.appendChild(acts);
  return form;
}

// 「請求先を変える」シート。入力があるので外側のクリック・Esc では閉じない（× とキャンセルだけ）
function phBillToSheet(p, errId) {
  const s = ph;
  const caseRow = currentCase || {};
  const title = phTitle(p);
  const prev = document.getElementById('ph-billto-sheet');
  if (prev) prev.remove();
  const bg = mk('div', 'modal-bg ph-sheet-bg');
  bg.id = 'ph-billto-sheet';
  const dlg = mk('div', 'modal ph-sheet');
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-labelledby', 'ph-bt-title');
  const close = () => { bg.remove(); const b = s.root && s.root.querySelector('[data-phase-id="' + p.id + '"] .ph-bill-change'); if (b) b.focus(); };
  const hd = mk('div', 'modal-hd');
  const h = mk('h3', null, '請求先を変える');
  h.id = 'ph-bt-title';
  const x = mk('button', 'modal-x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', '閉じる');
  x.addEventListener('click', close);
  hd.append(h, x);
  dlg.appendChild(hd);
  dlg.appendChild(mk('div', 'rep-sub ph-bt-sub', title + ' ・ 今の請求先: ' + PhaseLogic.billToLabel(p, caseRow)));

  const cur = p.bill_to_type || 'client';
  const opts = [
    ['client', PhaseLogic.billToLabel({ bill_to_type: 'client' }, caseRow)],
    ['owner', PhaseLogic.billToLabel({ bill_to_type: 'owner' }, caseRow) + (caseRow.owner_name ? '' : '（名前未登録）')],
    ['resident', PhaseLogic.billToLabel({ bill_to_type: 'resident' }, caseRow) + (caseRow.resident_name ? '' : '（名前未登録）')],
    ['other', 'その他（名前を入れる）']
  ];
  const g1 = mk('div', 'ph-bt-group');
  g1.setAttribute('role', 'radiogroup');
  g1.setAttribute('aria-label', '請求先');
  const radios = {};
  opts.forEach(([key, label]) => {
    const l = mk('label', 'ph-bt-opt');
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = 'ph-bt-to';
    r.value = key;
    r.checked = key === cur;
    radios[key] = r;
    l.appendChild(r);
    l.appendChild(mk('span', null, label + (key === cur ? '（今の請求先）' : '')));
    g1.appendChild(l);
  });
  dlg.appendChild(g1);
  const otherWrap = mk('label', 'ph-bt-other');
  otherWrap.appendChild(mk('span', null, '請求先の名前'));
  const other = document.createElement('input');
  other.type = 'text';
  other.maxLength = 100;
  other.autocomplete = 'off';
  other.className = 'ph-bt-other-name';
  other.placeholder = '例: 株式会社〇〇（保険会社など）';
  other.value = p.bill_to_name || '';
  otherWrap.appendChild(other);
  dlg.appendChild(otherWrap);

  dlg.appendChild(mk('div', 'ph-bt-t', '請求のしかた'));
  const g2 = mk('div', 'ph-bt-group');
  g2.setAttribute('role', 'radiogroup');
  g2.setAttribute('aria-label', '請求のしかた');
  const modes = {};
  [['single', '単発（案件ごとに請求書を出す）'], ['monthly', '月ごと（同じ元請の1か月分をまとめて請求）']].forEach(([key, label]) => {
    const l = mk('label', 'ph-bt-opt');
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = 'ph-bt-mode';
    r.value = key;
    r.checked = key === (p.billing_mode === 'monthly' ? 'monthly' : 'single');
    modes[key] = r;
    l.appendChild(r);
    l.appendChild(mk('span', null, label));
    g2.appendChild(l);
  });
  dlg.appendChild(g2);
  const monthWrap = mk('label', 'ph-bt-month');
  monthWrap.appendChild(mk('span', null, '請求月'));
  const month = phMonthSelect(p, p.billing_month ? String(p.billing_month).slice(0, 7) : '');
  month.className = 'ph-bt-month-sel';
  monthWrap.appendChild(month);
  dlg.appendChild(monthWrap);
  const note = mk('div', 'ph-sub ph-bt-note', '');
  dlg.appendChild(note);

  const sync = () => {
    const to = Object.keys(radios).find(k => radios[k].checked) || 'client';
    otherWrap.hidden = to !== 'other';
    const isClient = to === 'client';
    modes.monthly.disabled = !isClient;
    if (!isClient) modes.single.checked = true;
    monthWrap.hidden = !(isClient && modes.monthly.checked);
    note.textContent = isClient ? '元請マスタの請求のしかた: ' +
      PhaseLogic.BILLING_MODE_LABEL[caseRow.client_billing_mode === 'monthly' ? 'monthly' : 'single']
      : '元請以外への請求は単発（案件ごと）になります';
  };
  Object.values(radios).forEach(r => r.addEventListener('change', () => {
    // 元請に戻したときは、元請マスタの請求のしかたを初期値に
    if (r.value === 'client' && r.checked && cur !== 'client') {
      (caseRow.client_id && caseRow.client_billing_mode === 'monthly' ? modes.monthly : modes.single).checked = true;
    }
    sync();
  }));
  Object.values(modes).forEach(r => r.addEventListener('change', sync));
  sync();

  const err = mk('div', 'err ph-bt-err');
  err.setAttribute('role', 'alert');
  const acts = mk('div', 'modal-act');
  const cancel = dBtn('キャンセル', 'btn ghost ph-bt-cancel', close);
  const save = dBtn('変更する', 'btn ph-bt-save', async b => {
    err.textContent = '';
    const to = Object.keys(radios).find(k => radios[k].checked) || 'client';
    const next = { bill_to_type: to, bill_to_name: to === 'other' ? other.value.trim() : null,
      billing_mode: modes.monthly.checked && to === 'client' ? 'monthly' : 'single', billing_month: month.value || null };
    if (to === 'other' && !next.bill_to_name) { err.textContent = '請求先の名前を入れてください'; other.focus(); return; }
    const same = to === cur && (to !== 'other' || next.bill_to_name === (p.bill_to_name || '')) &&
      next.billing_mode === (p.billing_mode || 'single') &&
      (next.billing_mode !== 'monthly' || (next.billing_month || '') === (p.billing_month ? String(p.billing_month).slice(0, 7) : ''));
    if (same) { close(); return; }
    cancel.disabled = true;
    x.disabled = true;
    let ok = false;
    await withBusy(b, async () => {
      try { await PhasesApi.changeBillTo(p, next, caseRow, title); ok = true; }
      catch (e) { err.textContent = '変更できませんでした: ' + errText(e); }
    });
    cancel.disabled = false;
    x.disabled = false;
    if (!ok) return;
    close();
    if (!phAlive(s)) return;
    const m = await phLoad();
    notifyTimeline();
    if (m) phMsg(errId, '請求先は変更しましたが、最新の表示に更新できませんでした: ' + m);
  });
  acts.append(cancel, save);
  dlg.append(acts, err);
  bg.appendChild(dlg);
  document.body.appendChild(bg);
  (radios[cur] || x).focus();
}
// 画面を離れたら請求先のシートは閉じる（入力途中でも。案件の画面と一緒に消える）
window.addEventListener('hashchange', () => { const el = document.getElementById('ph-billto-sheet'); if (el) el.remove(); });

/* ---- 削除（中身が無いときだけ。カードの中で確認） ---- */
function phFoot(p, docs, errId) {
  const foot = mk('div', 'ph-foot');
  const sentMail = docs.mails.some(m => m.status !== 'draft');
  // Task 25: 自動で作った報告書（下書き・写真なし）と担当者URLは一緒に消せる
  const has = docs.estimates.length || docs.reports.some(r => !PhaseLogic.isBlankReport(r)) || docs.notices.length || sentMail;
  if (ph.confirmDel === p.id && !has) {
    const box = mk('div', 'ph-confirm');
    box.appendChild(mk('div', null, '「' + phTitle(p) + '」を削除しますか？（元に戻せません。未送信の連絡メールの下書き' +
      (docs.reports.length ? '・下書きの報告書（写真なし）と担当者URL' : '') + 'も消えます）'));
    const acts = mk('div', 'ph-acts');
    acts.appendChild(dBtn('やめる', 'btn sm ghost inline ph-del-cancel', () => { ph.confirmDel = null; phDraw(); }));
    acts.appendChild(dBtn('削除する', 'btn sm inline ph-del-ok', b => {
      const s = ph;
      return phRun(b, errId, '削除', async () => {
        await PhasesApi.remove(p, phTitle(p), docs.reports);
        if (phAlive(s)) s.confirmDel = null;
      }).then(() => {
        // 詳細ページで消したら案件ページへ戻る（消えたフェーズのページに残らない）
        if (phAlive(s) && s.phaseId === p.id && !s.data.phases.some(x => x.id === p.id)) location.hash = '#case/' + s.caseId;
      });
    }));
    box.appendChild(acts);
    foot.appendChild(box);
    return foot;
  }
  const del = dBtn('このフェーズを削除', 'linkbtn danger ph-del', () => { ph.confirmDel = p.id; phMsg(errId, ''); phDraw(); });
  if (has) {
    del.disabled = true;
    foot.append(del, mk('span', 'ph-sub', '見積書・報告書（写真や提出のあるもの）・工事掲示・送ったメールがあるため削除できません'));
  } else foot.appendChild(del);
  return foot;
}

/* ---------- 調査結果と注意事項（対応フェーズ Task 5b） ---------- */
// 調査カードの「調査結果」: 3つの文章欄と注意事項のボタン（押すとオン/オフ）。入力から1.5秒で自動保存（PhasesApi.saveResult）し、
// 「調査結果のご報告」（purpose survey_result）の下書きを作る/更新する。
// 入力の状態はフェーズごとのセッション（phRes）に持ち、カードを描き直しても同じ入力欄の要素を使う（入力中の値・カーソルを失わない）。
// 保存の後はカードを描き直さず、メールの行とステップの丸だけを書き換える（入力中に要素が付け替わらない）。
// 保存は1フェーズにつき直列（rs.chain）。保存中の入力は rs.dirty で次の保存に回す。画面を離れる・隠れるときは保留中の保存を flush する
const PH_RES_DELAY = 1500;
// Task 25: 原因・被害箇所は号室ごと（phResRoomEl）。ここは案件全体で1つの欄
const PH_RES_TEXTS = [
  { key: 'why', label: 'なぜそうなったか', ph: '例: 築20年で防水層が硬化し、目地から浸水' },
  { key: 'scope', label: '復旧工事の範囲', ph: '例: 302 の天井ボード張替え・クロス貼替え（約6㎡）' }
];
const PH_RES_MAX = { text: 2000, drainRooms: 100, cautionOther: 200 };
const phRes = new Map(); // phaseId → セッション（同じ案件を開き直しても入力中の値を引き継ぐ）

const phResJson = v => JSON.stringify(PhaseLogic.normalizeResult(v));
// 今の調査結果（入力中ならその値）
function phResultOf(p) {
  const rs = phRes.get(p.id);
  return rs && rs.caseId === p.case_id ? rs.v : PhaseLogic.normalizeResult(p.result);
}
// 入力中の調査結果を反映したフェーズの並び（工事カードの引き継ぎ用）
function phLivePhases() {
  return ((ph && ph.data && ph.data.phases) || []).map(x => (phRes.has(x.id) ? Object.assign({}, x, { result: phResultOf(x) }) : x));
}

function phResSession(p) {
  let rs = phRes.get(p.id);
  const server = phResJson(p.result);
  if (rs && rs.caseId !== p.case_id) rs = null;
  if (!rs) {
    rs = { id: p.id, caseId: p.case_id, kind: p.kind, v: PhaseLogic.normalizeResult(p.result), server: p.result || {},
      serverJson: server, dirty: false, saving: false, timer: null, chain: Promise.resolve(), state: '', err: '',
      lastSaved: null, draft: null, el: null, els: {} };
    phRes.set(p.id, rs);
  } else if (!rs.dirty && !rs.saving && !rs.timer && rs.serverJson !== server) {
    // 別の画面・別の人が変えた（こちらに未保存の入力は無い）→ サーバーの値で作り直す
    Object.assign(rs, { v: PhaseLogic.normalizeResult(p.result), server: p.result || {}, serverJson: server, el: null, els: {} });
  }
  rs.title = phTitle(p);
  return rs;
}

function phResultBody(p, docs) {
  const rs = phResSession(p);
  if (!rs.el) phResBuild(rs);
  else if (rs.els.picker) rs.els.picker.repaint(); // 号室の候補（関係する部屋）が変わっていれば出し直す
  phResFillMail(rs, docs.mails);
  phResSetState(rs, rs.state);
  return [rs.el];
}

function phResBuild(rs) {
  const box = mk('div', 'ph-result');
  box.dataset.phaseId = rs.id;
  rs.els = {};
  box.appendChild(mk('div', 'ph-sub', 'お客様に「どこからどこまで対応するか」「何に気をつけてもらうか」を伝えるための記録です。' +
    '入れると「調査結果のご報告」メールの下書きができ、この調査で作る報告書・工事の見積書の備考・工事掲示に引き継がれます（作るときの初期値）'));
  // Task 25: 号室ごとの区画（原因・被害箇所）。号室は指示と同じ選び方（js/phase-detail.js pdRoomPicker）
  box.appendChild(mk('div', 'ph-cau-t', '号室を選ぶ（押すと ✓）・号室ごとに原因と被害箇所'));
  const blocks = mk('div', 'pd-room-blocks ph-res-rooms');
  const addBlock = c => {
    if (rs.v.rooms.some(b => b.room === c.room)) return;
    rs.v.rooms.push({ room: c.room, role: c.role || '', cause: '', damage: '' });
    phResRoomsFill(rs);
    phResChanged(rs);
  };
  if (typeof pdRoomPicker === 'function') {
    const picker = pdRoomPicker({
      label: '調査結果の号室',
      rooms: () => rs.v.rooms,
      onAdded: addBlock,
      onToggle: async (c, on, btn) => {
        if (on) { addBlock(c); return; }
        const b = rs.v.rooms.find(x => x.room === c.room);
        if (b && (String(b.cause).trim() || String(b.damage).trim())) {
          const ok = await askInline(blocks, PhaseLogic.briefRoomHead(b) + 'の原因・被害箇所を消しますか？', { okLabel: '消す', id: 'ph-res-room-ask', prepend: true });
          if (!ok) { edSetOn(btn, true); return; }
        }
        rs.v.rooms = rs.v.rooms.filter(x => x.room !== c.room);
        phResRoomsFill(rs);
        rs.els.picker.repaint();
        phResChanged(rs);
      }
    });
    box.appendChild(picker);
    rs.els.picker = picker;
  }
  box.appendChild(blocks);
  rs.els.blocks = blocks;
  phResRoomsFill(rs);
  PH_RES_TEXTS.forEach(t => {
    const ta = document.createElement('textarea');
    ta.className = 'ph-res-' + t.key;
    ta.rows = 2;
    ta.maxLength = PH_RES_MAX.text;
    ta.placeholder = t.ph;
    ta.value = rs.v[t.key];
    ta.addEventListener('input', () => { rs.v[t.key] = ta.value; phResChanged(rs); });
    const l = mk('label', 'ph-rl', t.label);
    l.appendChild(ta);
    box.appendChild(l);
    rs.els[t.key] = ta;
  });
  box.appendChild(mk('div', 'ph-cau-t', '注意事項（よくある項目。押して選ぶ）'));
  const wrap = mk('div', 'ph-caus');
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', '注意事項');
  const extras = [];
  PhaseLogic.cautionChoices().forEach(c => {
    const b = mk('button', 'ph-cau', c.label);
    b.type = 'button';
    b.dataset.key = c.key;
    b.setAttribute('aria-pressed', rs.v.cautions.includes(c.key) ? 'true' : 'false');
    b.addEventListener('click', () => {
      const on = !rs.v.cautions.includes(c.key);
      const set = new Set(rs.v.cautions);
      if (on) set.add(c.key); else set.delete(c.key);
      rs.v.cautions = PhaseLogic.cautionChoices().map(x => x.key).filter(k => set.has(k));
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      phResSyncExtras(rs);
      phResChanged(rs);
    });
    wrap.appendChild(b);
    if (c.extra) extras.push(c);
  });
  box.appendChild(wrap);
  // 排水制限オンで号室の欄、その他オンで自由記入（オフにしても値は残す。文章・引き継ぎには使わない）
  extras.forEach(c => {
    const key = c.key === 'drain' ? 'drainRooms' : 'cautionOther';
    const i = document.createElement('input');
    i.type = 'text';
    i.className = 'ph-res-' + key;
    i.maxLength = PH_RES_MAX[key];
    i.placeholder = c.extra.placeholder || '';
    i.autocomplete = 'off';
    i.value = rs.v[key];
    i.addEventListener('input', () => { rs.v[key] = i.value; phResChanged(rs); });
    const l = mk('label', 'ph-rl ph-res-x', c.key === 'drain' ? c.extra.label : 'その他の注意事項（自由記入）');
    l.dataset.for = c.key;
    l.appendChild(i);
    box.appendChild(l);
    rs.els[key] = i;
    rs.els['x_' + c.key] = l;
  });
  const sv = mk('div', 'ph-res-save');
  const save = mk('span', 'rep-save');
  save.setAttribute('role', 'status');
  const retry = dBtn('再試行', 'btn sm ghost inline ph-res-retry', () => phResFlush(rs));
  retry.hidden = true;
  sv.append(save, retry);
  box.appendChild(sv);
  const mail = mk('div', 'ph-mail ph-res-mail');
  box.appendChild(mail);
  Object.assign(rs.els, { save, retry, mail });
  rs.el = box;
  phResSyncExtras(rs);
}

// 号室の区画（原因・被害箇所の自由記載）
function phResRoomsFill(rs) {
  const host = rs.els.blocks;
  if (!host) return;
  const area = (b, key, label, ph) => {
    const ta = document.createElement('textarea');
    ta.className = 'ph-res-' + key;
    ta.rows = 2;
    ta.maxLength = PH_RES_MAX.text;
    ta.placeholder = ph;
    ta.value = b[key];
    ta.addEventListener('input', () => { b[key] = ta.value; phResChanged(rs); });
    const l = mk('label', 'ph-rl', label);
    l.appendChild(ta);
    return l;
  };
  host.replaceChildren(...rs.v.rooms.map(b => {
    const el = mk('div', 'pd-room-block');
    el.dataset.room = b.room;
    el.appendChild(mk('div', 'pd-room-hd', PhaseLogic.briefRoomHead(b)));
    el.append(area(b, 'cause', '原因', '例: 浴室防水の劣化による漏水'), area(b, 'damage', '被害箇所', '例: 天井ボード・洗面所の壁クロス（約6㎡）'));
    return el;
  }));
  if (!rs.v.rooms.length) host.appendChild(mk('div', 'ph-sub pd-room-none', '上で号室を選ぶと、その号室の原因・被害箇所を書く欄が出ます'));
}

function phResSyncExtras(rs) {
  ['drain', 'other'].forEach(k => { if (rs.els['x_' + k]) rs.els['x_' + k].hidden = !rs.v.cautions.includes(k); });
}

function phResSetState(rs, state) {
  rs.state = state;
  const el = rs.els.save;
  if (!el) return;
  rs.els.retry.hidden = state !== 'error';
  el.className = 'rep-save' + (state === 'saved' ? '' : state === 'error' ? ' err' : ' busy');
  if (state === 'pending') el.textContent = '保存待ち…';
  else if (state === 'saving') el.textContent = '保存中…';
  else if (state === 'saved') el.textContent = '自動保存 ' + PhaseLogic.fmtMDHM(rs.lastSaved || new Date()).split(' ')[1];
  else if (state === 'error') el.textContent = '保存できませんでした: ' + (rs.err || '');
  else el.textContent = '';
}

// 「調査結果のご報告」の行（未送信の下書き → 確認して送る／送信済み／まだ無い）
function phResFillMail(rs, mails) {
  const el = rs.els.mail;
  if (!el) return;
  const own = (mails || []).filter(m => m.phase_id === rs.id && m.purpose === 'survey_result')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (rs.draft && !own.some(m => m.id === rs.draft.id)) own.unshift(rs.draft);
  const draft = own.find(m => m.status === 'draft');
  const sent = own.find(m => m.status === 'sent');
  const nodes = [];
  if (draft) {
    const who = PhaseLogic.recipientsLabel(draft.recipients, currentCase);
    nodes.push(Icon.prepend(mk('span', null, '調査結果のご報告: ' + (draft.skipped_at ? '今回は送らない' : '下書きあり') +
      (who ? '（' + who + '）' : '（宛先のメール未登録）')), 'mail', 14));
    const b = dBtn('確認して送る', 'btn sm inline ph-res-open', async btn => {
      btn.disabled = true;
      try { await phResSettle(); } finally { btn.disabled = false; }
      openMailDraft(btn.dataset.draftId);
    });
    b.dataset.draftId = draft.id;
    nodes.push(b);
  } else if (sent) {
    nodes.push(Icon.prepend(mk('span', null, '調査結果のご報告 ' + PhaseLogic.fmtMD(sent.sent_at) + ' 送信済み'), 'mail', 14));
    nodes.push(mk('span', 'ph-sub', '（内容を直すと、新しい下書きができます）'));
  } else {
    nodes.push(Icon.prepend(mk('span', 'ph-sub', '入力すると「調査結果のご報告」メールの下書きができます（宛先は依頼元から選びます）'), 'mail', 14));
  }
  el.replaceChildren(...nodes);
}

function phResChanged(rs) {
  rs.dirty = true;
  if (typeof currentCase !== 'undefined' && currentCase && currentCase.id === rs.caseId) rs.caseRow = currentCase; // 画面を離れた直後の保存用
  phResSetState(rs, 'pending');
  clearTimeout(rs.timer);
  rs.timer = setTimeout(() => phResFlush(rs), PH_RES_DELAY);
}
// 保留中の保存を今すぐ実行し、終わるまで待つ（直列。失敗しても throw しない: rs.dirty が残る）
function phResFlush(rs) {
  clearTimeout(rs.timer);
  rs.timer = null;
  rs.chain = rs.chain.then(() => phResDoSave(rs)).catch(e => {
    rs.dirty = true;
    rs.err = errText(e);
    phResSetState(rs, 'error');
  });
  return rs.chain;
}
// 表示中の案件の保存を全部終わらせる（書類を作る・メールを開く前。初期値・本文を最新にするため）
function phResSettle() {
  const list = [...phRes.values()].filter(rs => ph && rs.caseId === ph.caseId);
  return Promise.all(list.map(rs => (rs.dirty || rs.timer ? phResFlush(rs) : rs.chain)));
}

async function phResDoSave(rs) {
  if (!rs.dirty) return;
  const val = JSON.parse(JSON.stringify(rs.v));
  rs.dirty = false;
  rs.saving = true;
  phResSetState(rs, 'saving');
  const caseRow = typeof currentCase !== 'undefined' && currentCase && currentCase.id === rs.caseId ? currentCase : null;
  let saved = null, msg = '';
  try {
    const r = await PhasesApi.saveResult({ id: rs.id, case_id: rs.caseId, kind: rs.kind, result: rs.server,
      scheduled_at: phResPhase(rs, 'scheduled_at'), done_at: phResPhase(rs, 'done_at') },
    val, caseRow || rs.caseRow || { id: rs.caseId }, rs.title || '調査');
    saved = r.phase;
    rs.draft = r.draft || null;
    if (r.first) notifyTimeline();
  } catch (e) {
    saved = (e && e.phase) || null; // 調査結果は保存できて、下書きだけ失敗したときは e.phase がある
    msg = errText(e);
  }
  rs.saving = false;
  if (saved) {
    rs.server = saved.result || {};
    rs.serverJson = phResJson(saved.result);
    rs.lastSaved = new Date();
    phResApply(rs, saved);
  }
  if (msg) { // 失敗: 次の保存（再試行・次の入力）でもう一度送る
    rs.dirty = true;
    rs.err = msg;
    phResSetState(rs, 'error');
    return;
  }
  phResSetState(rs, rs.dirty ? 'pending' : 'saved');
}
const phResPhase = (rs, key) => {
  const p = ph && ph.data && ph.data.phases.find(x => x.id === rs.id);
  return p ? p[key] : null;
};

// 保存の結果を表示中のデータに入れ、メールの行・ステップの丸・送信待ちの数だけ書き換える（カードは描き直さない）
function phResApply(rs, saved) {
  const s = ph;
  if (!s || !s.data || s.caseId !== rs.caseId) return;
  const p = s.data.phases.find(x => x.id === rs.id);
  if (!p) return;
  p.result = saved.result;
  if (saved.updated_at) p.updated_at = saved.updated_at;
  if (rs.draft) {
    const i = s.data.drafts.findIndex(d => d.id === rs.draft.id);
    if (i >= 0) s.data.drafts[i] = rs.draft; else s.data.drafts.unshift(rs.draft);
  }
  const docs = phDocs(p);
  phResFillMail(rs, docs.mails);
  const ct = rs.el && rs.el.closest('.ph-card') && rs.el.closest('.ph-card').querySelector('.ph-contact');
  if (ct) ct.replaceWith(phContactEl(p, docs.mails));
  const st = rs.el && rs.el.closest('.ph-st');
  if (st) {
    const state = phStepState(p, docs, 2);
    st.className = 'ph-st ' + state;
    const dot = st.querySelector('.ph-dot');
    if (dot) dot.textContent = state === 'done' ? '✓' : st.dataset.n || '4';
  }
  if (typeof syncCaseMailBanner === 'function') syncCaseMailBanner(s.caseId, s.data.drafts);
}

function phResFlushAll() {
  phRes.forEach(rs => { if (rs.dirty || rs.timer) phResFlush(rs); });
  if (typeof pdBriefFlushAll === 'function') pdBriefFlushAll(); // 現場担当への指示（js/phase-detail.js）
}
window.addEventListener('hashchange', phResFlushAll);
window.addEventListener('beforeunload', phResFlushAll);
document.addEventListener('visibilitychange', () => { if (document.hidden) phResFlushAll(); });

/* ---------- 作業担当者への確認依頼（対応フェーズ Task 6b） ---------- */
// カードの「作業担当者」: 担当者（社内メンバーから選ぶ。初期値は案件の担当者）・状態（未通知／知らせた／確認済み）・
// 「担当者に知らせる」（担当者のアプリに 🔔 が出て、メールの下書きもできる）・担当者本人にだけ「確認した」
const phMembers = () => (typeof caseMembers !== 'undefined' && Array.isArray(caseMembers) ? caseMembers : []);
const phMyId = () => (ctx && ctx.user ? ctx.user.id : null);
function phWorkerStepState(p) {
  if (p.ack_at) return 'done';
  return p.worker_id && (p.notified_at || (p.scheduled_at && !p.done_at)) ? 'now' : 'later';
}
// opts.brief: 詳細ページの段（Task 28: 選択 → 現場への指示（号室ごとの区画。js/phase-detail.js phBriefBody）→ 担当者に知らせる）。
//   無ければ表の「確認」セルのポップオーバー（指示は「指示を書く（詳細ページへ）」のリンクと要約だけ）
function phWorkerBody(p, docs, errId, opts) {
  const withBrief = !!(opts && opts.brief) && typeof phBriefBody === 'function';
  const out = [];
  const members = phMembers();
  const st = PhaseLogic.workerState(Object.assign({}, p, {
    ack_by_name: p.ack_by ? ((members.find(m => m.user_id === p.ack_by) || {}).display_name || '') : ''
  }));
  const box = mk('div', 'ph-worker');
  box.dataset.state = st.key;
  const row = mk('div', 'ph-row ph-wk-row');
  row.appendChild(phWorkerSelect(p, errId));
  const tag = mk('span', 'ph-wk-tag ' + st.key, st.label);
  row.appendChild(tag);
  box.appendChild(row);

  // ② 現場への指示（Task 28: 知らせる前に書く）
  const hasBrief = typeof pdBriefHas === 'function' ? pdBriefHas(p) : PhaseLogic.hasBrief(p.plan);
  if (withBrief) {
    const bb = mk('div', 'ph-wk-briefbox');
    if (typeof phVisitBody === 'function') bb.appendChild(phVisitBody(p)); // Task 31: 指示の上に「今回行く部屋」
    bb.appendChild(mk('div', 'ph-t2', '現場への指示（担当者に知らせる前に書く）'));
    bb.appendChild(phBriefBody(p));
    box.appendChild(bb);
  } else {
    // 現場担当への指示の要約（担当者への確認依頼のメール・🔔 の一覧にも入る）
    const bs = mk('div', 'ph-wk-brief');
    bs.dataset.phaseId = p.id;
    phFillWorkerBrief(bs, p);
    box.appendChild(bs);
  }

  if (p.worker_id) {
    const acts = mk('div', 'ph-acts');
    const again = !!p.notified_at;
    if (!withBrief) {
      const go = dBtn('指示を書く（詳細ページへ）', 'linkbtn ph-wk-golink', () => {
        location.hash = '#case/' + (p.case_id || (ph && ph.caseId)) + '/phase/' + p.id;
      });
      acts.appendChild(go);
    }
    // 指示が空なら1行の注意（押せる）
    const empty = mk('div', 'ph-wk-empty', withBrief ? '指示が空のまま知らせます（上の「現場への指示」に書くと、確認依頼のメールと担当者の画面に入ります）' : '指示が空のまま知らせます（「指示を書く」から書けます）');
    Icon.prepend(empty, 'alert', 14);
    empty.dataset.phaseId = p.id;
    empty.hidden = hasBrief;
    acts.appendChild(dBtn(again ? 'もう一度知らせる' : '担当者に知らせる', (again ? 'btn sm ghost inline' : 'btn sm inline') + ' ph-wk-notify',
      b => phRun(b, errId, '担当者に知らせる操作', async () => {
        if (typeof pdBriefSettle === 'function') await pdBriefSettle(); // 指示の保存待ちを先に（確認依頼の本文に入るため）
        const cur = (ph && ph.data && ph.data.phases.find(x => x.id === p.id)) || p;
        return PhasesApi.notifyWorker(cur, currentCase, phTitle(p), members);
      })));
    box.appendChild(empty);
    // Task 28: 催促する（作業担当者が自分以外のとき。期限を過ぎて未提出なら赤）
    if (p.worker_id !== phMyId()) {
      const nd = phNudgeState(p, docs);
      const nb = dBtn('催促する', 'btn sm inline ph-wk-nudge' + (nd.urge ? ' red' : ' ghost'), () => phNudgeSheet(p, nd, errId));
      if (nd.urge) nb.title = '期限を過ぎています（' + (nd.info ? nd.info.text : '') + '）';
      acts.appendChild(nb);
      const nt = PhaseLogic.nudgeText(p);
      if (nt) { const ns = mk('span', 'ph-sub ph-wk-nudged', nt); acts.appendChild(ns); }
    }
    if (p.worker_id === phMyId() && p.notified_at && !p.ack_at) {
      acts.appendChild(dBtn('確認した', 'btn sm inline ph-wk-ack', b => phRun(b, errId, '確認した操作', () => PhasesApi.ack(p, phTitle(p)))));
    }
    box.appendChild(acts);
    // 担当者への確認依頼のメール（下書き → 確認して送る／送信済み）
    const own = docs.mails.filter(m => m.purpose === 'staff_notice' && !m.remind_slot && (!m.worker_id || m.worker_id === p.worker_id)) // 027: 前の担当者に送った分は出さない
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const draft = own.find(m => m.status === 'draft');
    const sent = own.find(m => m.status === 'sent');
    if (draft || sent) {
      const ml = mk('div', 'ph-mail ph-wk-mail');
      if (draft) {
        ml.appendChild(Icon.prepend(mk('span', null, '担当者への確認依頼: ' + (draft.skipped_at ? '今回は送らない' : '下書きあり') + (draft.to_email ? '' : '（担当者のメール未登録）')), 'mail', 14));
        const b = dBtn('確認して送る', 'btn sm inline ph-wk-open', async btn => {
          btn.disabled = true;
          try { if (typeof pdBriefSettle === 'function') await pdBriefSettle(); } finally { btn.disabled = false; }
          openMailDraft(draft.id);
        });
        b.dataset.draftId = draft.id;
        ml.appendChild(b);
      } else ml.appendChild(Icon.prepend(mk('span', null, '担当者への確認依頼 ' + PhaseLogic.fmtMD(sent.sent_at) + ' 送信済み'), 'mail', 14));
      box.appendChild(ml);
    }
  }
  box.appendChild(mk('div', 'ph-sub', p.worker_id
    ? '「担当者に知らせる」を押すと、担当者のアプリに「確認してください」が出て、メールの下書きもできます。担当者が「確認した」を押すとここに戻ってきます'
    : '作業する人を選んでください（社内メンバー）'));
  out.push(box);
  return out;
}

// 作業担当者の選択（詳細ページの段・表の「担当者」の列で共通。Task 28）。変えると報告書の作業者も DB がそろえる（migration 046）
function phWorkerSelect(p, errId) {
  const members = phMembers();
  const sel = document.createElement('select');
  sel.className = 'ph-wk-sel';
  sel.setAttribute('aria-label', '作業担当者');
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '未定';
  sel.appendChild(none);
  members.forEach(m => {
    const o = document.createElement('option');
    o.value = m.user_id;
    o.textContent = (m.display_name || '（名前なし）') + (m.user_id === phMyId() ? '（自分）' : '') + memberTel(m); // Task 32: 電話番号
    sel.appendChild(o);
  });
  if (p.worker_id && !members.some(m => m.user_id === p.worker_id)) {
    const o = document.createElement('option');
    o.value = p.worker_id;
    o.textContent = '（退会したメンバー）';
    sel.appendChild(o);
  }
  sel.value = p.worker_id || '';
  sel.addEventListener('change', () => {
    const v = sel.value || null;
    phRun(sel, errId, '担当者の変更', () => PhasesApi.setWorker(p, v, phTitle(p), members));
  });
  return sel;
}

/* ---------- 催促（Task 28） ---------- */
// 今の段階（作業担当者から見た文・期限）と、赤で強調するか（期限を過ぎて未提出・作業担当者が自分以外）
function phNudgeState(p, docs) {
  const info = p.worker_id ? PhaseLogic.nudgeInfo(p, { estimates: docs.estimates, reports: docs.reports }, new Date()) : null;
  return { info, urge: !!(info && info.late && p.worker_id && p.worker_id !== phMyId()) };
}
// シート: 一言（任意）→「催促する」→ 担当者の 🔔 の一番上に「⚠️ 催促: …」。外側クリック・Esc では閉じない
function phNudgeSheet(p, nd, errId) {
  const prev = document.getElementById('ph-nudge-sheet');
  if (prev) prev.remove();
  const who = PhaseLogic.workerCol(p, phMembers()).text;
  const text = (nd.info && nd.info.text) || '対応をお願いします';
  const opener = document.activeElement;
  let busy = false;
  const bg = mk('div', 'lt-bg');
  bg.id = 'ph-nudge-sheet';
  const dlg = mk('div', 'lt-sheet');
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-labelledby', 'ph-nudge-title');
  const close = () => { if (busy) return; bg.remove(); if (opener && opener.isConnected) opener.focus(); };
  const hd = mk('div', 'lt-hd');
  const h = mk('h3', null, who + 'さんに催促する');
  h.id = 'ph-nudge-title';
  const x = dBtn('×', 'lt-x', close);
  x.setAttribute('aria-label', '閉じる');
  hd.append(h, x);
  dlg.appendChild(hd);
  const pv = mk('div', 'ph-nudge-pv', '催促: ' + text);
  pv.id = 'ph-nudge-preview';
  dlg.appendChild(mk('div', 'lt-sub', phTitle(p) + '。' + who + 'さんの「確認してください」の一番上に次の文が出ます（読んだら消えます）'));
  dlg.appendChild(pv);
  const note = document.createElement('input');
  note.type = 'text';
  note.id = 'ph-nudge-note';
  note.maxLength = 500;
  note.autocomplete = 'off';
  note.placeholder = '例: 今日中にお願いします';
  const nl = mk('label', 'lt-f', '一言（任意）');
  nl.appendChild(note);
  dlg.appendChild(nl);
  const err = mk('div', 'lt-err');
  err.id = 'ph-nudge-err';
  err.setAttribute('role', 'alert');
  dlg.appendChild(err);
  const acts = mk('div', 'lt-acts');
  const cancel = dBtn('キャンセル', 'lt-cancel', close);
  const send = dBtn('催促する', 'lt-send ph-nudge-send', async () => {
    if (busy) return;
    busy = true;
    [x, cancel, send, note].forEach(e => { e.disabled = true; });
    send.textContent = '送っています…';
    let e2 = '';
    try { await PhasesApi.nudge(p.id, text, note.value.trim()); }
    catch (e) { e2 = '催促できませんでした: ' + errText(e); }
    busy = false;
    if (e2) {
      err.textContent = e2;
      [x, cancel, send, note].forEach(e => { e.disabled = false; });
      send.textContent = '催促する';
      return;
    }
    bg.remove();
    const s = ph;
    if (phAlive(s)) { await phLoad(); notifyTimeline(); }
  });
  acts.append(cancel, send);
  dlg.appendChild(acts);
  bg.appendChild(dlg);
  document.body.appendChild(bg);
  note.focus();
}

// 作業担当者の段の「指示あり: …」（plan は入力中ならその値: js/phase-detail.js pdBriefValue）
function phFillWorkerBrief(el, p) {
  const v = typeof pdBriefValue === 'function' ? pdBriefValue(p) : p.plan;
  const sum = PhaseLogic.briefSummary(v);
  el.dataset.state = sum ? 'on' : 'off';
  el.replaceChildren(Icon.prepend(sum ? mk('span', null, '指示あり: ' + sum)
    : mk('span', 'ph-sub', '現場への指示はまだありません（詳細ページの作業担当者の段で書くと、確認依頼のメールにも入ります）'), 'pen', 14));
}
