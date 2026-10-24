// js/case-detail.js — 案件詳細画面（ヘッダ・住所と地図・依頼元・依頼内容（Task 28: js/case-request.js）・対応フェーズ・書類）
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）
// mk() は case-list.js、withBusy / setMsg / showScreen / $ は app.js のものを使う
//
// グローバル（timeline.js が使う）:
//   currentCase   … case_summaries の1行（表示中の案件。読み込み前/失敗時は null）
//   caseMembers   … [{user_id, display_name}]（投稿者名の解決用）
// timeline.js 側が定義すれば呼ばれるフック:
//   renderTimeline(rootEl)  … 詳細の初回描画時に1回
//   refreshTimeline()       … フェーズの操作・状態変更などで自動記録が増えた後
// phase-ui.js 側が定義すれば呼ばれるフック:
//   renderPhases(rootEl)    … 詳細の初回描画時に1回（「対応フェーズ」欄。依頼元の下）
let currentCase = null;
let caseMembers = [];

let caseDetailId = null;   // 表示中（または読み込み中）の案件ID
let caseGen = 0;           // 案件を開くたびに増やす。古い応答/操作結果を捨てる
const casePartSeq = { head: 0 }; // 部分更新ごとの番号

const errText = e => (e && e.message ? e.message : String(e));

function memberName(id) {
  if (!id) return '';
  const m = caseMembers.find(x => x.user_id === id);
  return m ? (m.display_name || '(名前なし)') : '不明';
}

function dBtn(text, cls, onClick) {
  const b = mk('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', () => onClick(b));
  return b;
}

function dField(labelText, control) {
  const l = mk('label', null, labelText);
  l.appendChild(control);
  return l;
}

function dSelect(options, value) {
  const s = document.createElement('select');
  options.forEach(o => s.appendChild(new Option(o[1], o[0])));
  s.value = value;
  if (s.value !== value) s.value = options.length ? options[0][0] : '';
  return s;
}

// 自動記録(system)が増える操作の後に呼ぶ。timeline.js が refreshTimeline を定義していれば再読み込みさせる
// 「↩ 1つ前に戻す」（js/case-undo.js）も、直近の編集を読み直す
function notifyTimeline() {
  try { if (typeof refreshTimeline === 'function') refreshTimeline(); }
  catch (e) { console.warn('タイムラインの更新に失敗', e); }
  try { if (typeof CaseUndo !== 'undefined') CaseUndo.refresh(); }
  catch (e) { console.warn('「1つ前に戻す」の更新に失敗', e); }
}

// ---- 開く / 読み込み ----
// 一覧の行クリック → location.hash 変更 → hashchange → routeFromHash → openCase が2回走るので、
// 同じ案件を表示中/読み込み中なら何もしない。再読み込みは loadCase を直接呼ぶ
function openCase(id) {
  if (!id) return;
  if (caseDetailId === id && $('screen-case').classList.contains('active')) return;
  showScreen('case');
  renderHeaders();
  const h = '#case/' + id;
  if (location.hash !== h) location.hash = h;
  return loadCase(id);
}

function detailBackBtn() {
  return dBtn('← 案件一覧', 'back', () => openCases());
}

function renderDetailMessage(text, isErr, retryId) {
  const root = $('case-detail-root');
  const nodes = [detailBackBtn()];
  if (isErr) nodes.push(mk('div', 'err', text));
  else nodes.push(mk('div', 'empty', text));
  if (retryId) nodes.push(dBtn('再読み込み', 'btn sm ghost inline', () => loadCase(retryId)));
  root.replaceChildren(...nodes);
}

async function loadCase(id) {
  const gen = ++caseGen;
  caseDetailId = id;
  currentCase = null;
  caseMembers = [];
  renderDetailMessage('読み込み中…', false);

  let results;
  try {
    results = await Promise.all([
      CasesApi.getSummary(id),
      CasesApi.listMembers()
    ]);
  } catch (e) {
    if (gen !== caseGen) return;
    renderDetailMessage('案件の読み込みに失敗しました: ' + errText(e), true, id);
    return;
  }
  if (gen !== caseGen) return; // より新しい読み込みが始まっている
  const [row, members] = results;
  if (!row) {
    renderDetailMessage('案件が見つかりません', false);
    return;
  }
  currentCase = row;
  caseMembers = members || [];
  buildDetail();
}

// 部分更新。'' = 成功 or 古い応答として破棄 / 文字列 = 失敗メッセージ
async function refreshPart(part) {
  const gen = caseGen;
  const id = caseDetailId;
  const seq = ++casePartSeq[part];
  let data;
  try {
    data = await CasesApi.getSummary(id);
    if (!data) throw new Error('案件が見つかりません');
  } catch (e) {
    return gen === caseGen && seq === casePartSeq[part] ? errText(e) : '';
  }
  if (gen !== caseGen || seq !== casePartSeq[part]) return '';
  currentCase = data; renderHead(); renderParties(); renderPhaseBand();
  if (typeof CaseRequest !== 'undefined') CaseRequest.refresh(currentCase); // 入力中は描き直さない
  return '';
}

// 操作の共通ラッパー。fn が throw したら errId に表示。成功したら part を再取得して描画
async function runOp(b, errId, part, label, fn) {
  const gen = caseGen;
  setMsg(errId, '');
  await withBusy(b, async () => {
    try {
      await fn();
    } catch (e) {
      if (gen === caseGen) setMsg(errId, label + 'に失敗しました: ' + errText(e));
      return;
    }
    if (gen !== caseGen) return;
    const m = await refreshPart(part);
    if (m && gen === caseGen) setMsg(errId, label + 'は完了しましたが、最新の表示に更新できませんでした: ' + m);
  });
}

// ---- 全体の骨組み ----
function buildDetail() {
  const root = $('case-detail-root');

  const headBox = mk('div');
  headBox.id = 'case-head-box';

  // 依頼元（元請／物件オーナー／入居者）。編集は案件のポップアップ
  const parties = mk('div', 'taio');
  parties.id = 'case-parties';
  // Task 52: 今のフェーズ（依頼元の下の小さな帯）
  const band = mk('div', 'taio pb-box');
  band.id = 'case-phase-band';
  pbOpen.clear();

  // 依頼内容（Task 28。依頼元の下。js/case-request.js）
  let request = null;
  if (typeof CaseRequest !== 'undefined') {
    try { request = CaseRequest.section(currentCase); }
    catch (e) { console.warn('依頼内容の欄の表示に失敗', e); }
  }

  // 対応フェーズ（調査・原因元工事・復旧工事のカード。js/phase-ui.js）
  let phases = null;
  if (typeof renderPhases === 'function') {
    phases = mk('div', 'taio ph-box');
    phases.id = 'case-phases';
  }

  // ツール（日程調整・報告書作成・見積書作成・工事掲示。並びは対応の種類ごと（Task 59）。現場用と同じ大きなカード＋対応の切替チップ。Task 19）。中身は renderCaseTools
  const tools = mk('div', 'taio ctools');
  tools.id = 'case-tools';

  const tl = mk('div'); tl.id = 'case-timeline';

  // 依頼者へ送るメール（報告書・見積書）の下書きが残っているとき（⑨ のある版だけ）。行き先:
  //   1件 → その⑨ / 報告書の下書きだけ → ⑤の「送信待ちの下書き」 /
  //   見積書の下書きを含む（見積書一覧には送信待ちの表示がない）→ 案件詳細の中に下書きの一覧を出す / 取得できない → ⑤
  const pendingMails = Number(currentCase.drafts_to_send) || 0;
  let mailBanner = null, mailList = null;
  if (pendingMails > 0 && typeof openMailDraft === 'function') {
    mailList = mk('div', 'rep-card rep-drafts');
    mailList.id = 'case-mail-list';
    mailList.hidden = true;
    mailBanner = dBtn('', 'rep-banner', async b => {
      const cid = currentCase.id;
      const toReports = () => { location.hash = '#case/' + cid + '/reports'; };
      b.disabled = true;
      let ds = null;
      // 「今回は送らない」にした日程連絡・リマインドは除く
      try { ds = (await ReportsApi.listDrafts(cid)).filter(d => d.status === 'draft' && !d.skipped_at); } catch (e) { /* ⑤へ */ }
      if (caseDetailId !== cid) return; // 取得中に別の画面へ移った
      b.disabled = false;
      if (!ds || ds.length === 0) { toReports(); return; }
      if (ds.length === 1) { openMailDraft(ds[0].id); return; }
      const isNote = d => d.purpose === 'schedule' || d.purpose === 'reminder' || d.purpose === 'survey_result';
      if (!ds.some(d => d.estimate_id || isNote(d))) { toReports(); return; }
      mailList.replaceChildren(mk('b', null, '送信待ちの下書き ' + ds.length + '件'));
      ds.forEach(d => {
        const line = mk('div', 'rep-draft-line');
        const ph = (currentCase.phases || []).find(p => p.id === d.phase_id) || null;
        const kind = isNote(d) && typeof PhaseLogic !== 'undefined' ? PhaseLogic.mailLabel(d, ph) : d.estimate_id ? '見積書' : '報告書';
        line.appendChild(mk('span', 'rep-sub', kind + '・' + (d.subject || '（件名なし）')));
        line.appendChild(dBtn('下書きを確認する', 'btn sm inline', () => openMailDraft(d.id)));
        mailList.appendChild(line);
      });
      mailList.hidden = false;
    });
    mailBanner.id = 'case-mail-banner';
    const cnt = mk('span', null, '送信待ちの下書き ' + pendingMails + '件');
    cnt.id = 'case-mail-count';
    const lead = mk('span', 'rb-lead');
    lead.append(Icon.el('mail'), cnt);
    mailBanner.append(lead, mk('span', 'rep-sub', 'メールを確認して送る →'));
  }

  // 一番下に小さく「この案件を削除」（管理者だけ。js/case-trash.js）
  const trash = typeof CaseTrash !== 'undefined' ? CaseTrash.section(currentCase) : null;
  ctState = { caseId: currentCase.id, data: null, busy: '', err: '', banner: mailBanner };
  root.replaceChildren(...[detailBackBtn(), headBox, parties, band, request, phases, tools, mailList, tl, trash].filter(Boolean));

  renderHead();
  renderParties();
  renderPhaseBand();
  renderCaseTools();
  if (phases) {
    try { renderPhases(phases); }
    catch (e) { console.warn('対応フェーズ欄の表示に失敗', e); phases.replaceChildren(mk('div', 'err', '対応フェーズ欄を表示できませんでした: ' + errText(e))); }
  }
  if (typeof renderTimeline === 'function') renderTimeline(tl);
}

// ---- ツール（Task 19）----
// 対応フェーズ欄の読み込み（js/phase-ui.js phLoad）が、この案件のフェーズ・書類を渡して syncCaseTools を呼ぶ（同じデータを使う。読み込みを増やさない）。
// 件数（一覧ボタン）は case_summaries の report_count / reports_to_confirm / estimate_count / latest_estimate_total / notice_count（案件全体）、
// 状態の1行は選んだ対応の書類（PhaseLogic.fieldTools。現場用のツールページと同じ）。対応が無い案件は案件全体の書類
let ctState = null;               // { caseId, data: {phases, reports, estimates, notices} | null, busy, err, banner（送信待ちの下書きのボタン） }
const ctSel = new Map();          // 案件ごとに選んだ対応（この画面を開いている間だけ覚える。書類から戻ったとき同じ対応を選ぶ）
const CT_TOOLS = {
  report: { key: 'report', icon: 'report', title: '報告書作成', id: 'case-tool-reports', list: 'reports', name: '報告書' },
  estimate: { key: 'estimate', icon: 'receipt', title: '見積書作成', id: 'case-tool-estimates', list: 'estimates', name: '見積書' },
  notice: { key: 'notice', icon: 'megaphone', title: '工事掲示', id: 'case-tool-notices', list: 'notices', name: '工事掲示' }
};

function syncCaseTools(caseId, data) {
  if (!ctState || ctState.caseId !== caseId || caseDetailId !== caseId) return;
  ctState.data = data;
  renderCaseTools();
  renderPhaseBand();
}

function ctPhases() {
  const d = ctState && ctState.data;
  return d ? (d.phases || []) : (Array.isArray(currentCase.phases) ? currentCase.phases : []);
}
function ctSelected() {
  const phases = ctPhases();
  if (!phases.length) return null;
  const want = ctSel.get(currentCase.id);
  return phases.find(p => p.id === want) || PhaseLogic.fieldDefaultPhase(phases, new Date());
}

function renderCaseTools() {
  const box = $('case-tools');
  if (!box || !currentCase || !ctState) return;
  const c = currentCase;
  const s = ctState;
  const head = mk('div', 'taio-head ctools-head');
  head.appendChild(mk('b', null, 'ツール'));
  const phases = ctPhases();
  const sel = ctSelected();
  const chips = mk('div', 'ctools-chips');
  chips.id = 'case-tool-chips';
  if (phases.length) {
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'どの対応の書類か');
    PhaseLogic.fieldPhaseChips(phases, new Date()).forEach(ch => {
      const on = !!sel && ch.id === sel.id;
      const b = dBtn('', 'chip ctools-chip' + (on ? ' on' : ''), () => {
        ctSel.set(c.id, ch.id);
        s.err = '';
        renderCaseTools();
      });
      b.appendChild(mk('span', null, ch.title));
      if (ch.text !== ch.title) b.appendChild(mk('span', 'ctools-chip-when', ch.text.slice(ch.title.length))); // スマホでは日時を省く
      b.dataset.phaseId = ch.id;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      chips.appendChild(b);
    });
  } else {
    chips.appendChild(mk('span', 'ctools-none', '対応（調査・工事）がまだ無いので、案件全体の書類として作ります'));
  }
  head.appendChild(chips);
  // 「✉ 送信待ちの下書き n件」は見出しの行の右に（PC。スマホは折り返す）
  if (s.banner) head.appendChild(s.banner);

  // 選んだ対応の書類（読み込み前は null）
  let t = null;
  if (s.data) {
    const of = list => (list || []).filter(x => !sel || x.phase_id === sel.id);
    t = PhaseLogic.fieldTools({ reports: of(s.data.reports), estimates: of(s.data.estimates), notices: of(s.data.notices) });
  }
  // Task 59: 並びは対応の種類ごと（PhaseLogic.toolOrder）。対応が無い案件は日程調整を出さない（日時を入れる対応が無い）
  const grid = mk('div', 'ctools-grid');
  PhaseLogic.toolOrder(sel && sel.kind).forEach(k => {
    if (k === 'schedule') { if (sel) grid.appendChild(ctSchedCard(sel)); }
    else grid.appendChild(ctCard(CT_TOOLS[k], t ? t[k] : null, sel));
  });
  const nodes = [head, grid];
  // 調査に付いた工事掲示（前のデータ）はカードを出さないので、一覧への入口だけ残す（消さない）
  const old = sel && sel.kind === 'survey' && s.data ? (s.data.notices || []).filter(n => n.phase_id === sel.id).length : 0;
  if (old) {
    const ln = dBtn('この調査に付いている工事掲示 ' + old + '件（前のデータ）を一覧で見る ›', 'linkbtn ctools-old-notice', () => { location.hash = '#case/' + c.id + '/notices'; });
    ln.id = 'case-tool-old-notices';
    nodes.push(ln);
  }
  const err = mk('div', 'err', s.err || '');
  err.id = 'case-tools-err';
  box.replaceChildren(...nodes, err);
}

// Task 59: 日程調整のカード。押すと対応の表のその行の「日時」の欄を開く（Task 58 の手入力。スイッチ true なら Task 50 の日程調整の欄）
function ctSchedCard(sel) {
  const s = ctState;
  const card = mk('div', 'ctool');
  card.dataset.tool = 'schedule';
  card.dataset.state = !s.data ? 'loading' : sel.scheduled_at ? 'done' : 'none';
  const main = dBtn('', 'ctool-main', () => phOpenCell(sel, 'when'));
  main.dataset.open = 'schedule';
  main.disabled = !s.data || !!s.busy || typeof phOpenCell !== 'function';
  main.appendChild(mk('span', 'ctool-ic')).appendChild(Icon.el('calendar', { size: 20 }));
  const body = mk('span', 'ctool-t');
  body.appendChild(mk('b', null, '日程調整'));
  const open = PhaseLogic.schedOpen(sel);
  body.appendChild(mk('span', 'ctool-st', !s.data ? '読み込み中…' : open && typeof schStatusText === 'function' ? schStatusText(sel) : PhaseLogic.schedText(sel)));
  main.appendChild(body);
  main.setAttribute('aria-label', '日程調整：' + PhaseLogic.schedText(sel) + '・日時を入れる・変える');
  card.appendChild(main);
  return card;
}

// 見積の件数（系列の数。case_summaries.estimate_count と同じ数え方）
const estSeriesCount = list => new Set((list || []).map(e => e.series_id || e.id)).size;

function ctCard(def, state, sel) {
  const c = currentCase;
  const s = ctState;
  const card = mk('div', 'ctool');
  card.dataset.tool = def.key;
  card.dataset.state = state ? state.state : 'loading';
  // 大きなボタン（現場用のツールボタンと同じ）: 書類があれば最新を開く／複数の工事掲示は一覧／無ければ新しく作る
  const go = !state ? null
    : state.open ? () => { location.hash = (def.key === 'report' ? '#report/' : def.key === 'estimate' ? '#estimate/' : '#notice/') + state.open.id; }
      : state.count > 1 ? () => { location.hash = '#case/' + c.id + '/' + def.list; }
        : null;
  const main = dBtn('', 'ctool-main', b => (go ? go() : ctCreate(b, def, sel)));
  main.dataset.open = def.key;
  main.disabled = !state || !!s.busy;
  main.appendChild(mk('span', 'ctool-ic')).appendChild(Icon.el(def.icon, { size: 20 }));
  const body = mk('span', 'ctool-t');
  body.appendChild(mk('b', null, def.title));
  let stText = '読み込み中…';
  if (state) {
    // 「下書きあり ・ 続きを書く」の後ろ（押したときの動き）は読み上げとツールチップに
    const [label, action] = String(state.text).split(' ・ ');
    stText = (sel ? '' : '案件全体: ') + (s.busy === def.key ? '作っています…' : label);
    if (action) { main.title = action; main.setAttribute('aria-label', def.title + '：' + label + '・' + action); }
  }
  body.appendChild(mk('span', 'ctool-st', stText));
  main.appendChild(body);
  card.appendChild(main);

  const acts = mk('div', 'ctool-acts');
  const mkNew = dBtn('＋ 新しく作る', 'btn sm inline ctool-new', b => ctCreate(b, def, sel));
  mkNew.dataset.create = def.key;
  mkNew.disabled = !!s.busy;
  acts.appendChild(mkNew);
  // 一覧（案件全体の件数。case_summaries）。読み上げは「報告書の一覧 n件」
  const list = mk('button', 'btn sm ghost inline ctool-list');
  list.type = 'button';
  list.id = def.id;
  list.appendChild(mk('span', 'sr-only', def.name + 'の'));
  list.appendChild(mk('span', 'nm', '一覧'));
  const ct = mk('span', 'ct');
  if (def.key === 'report') {
    // 件数は表と同じ読み込み結果（ctState.data）から数える。確認待ちは協力業者URLから提出されたものだけ（Task 23）
    const reps = ctState && ctState.data ? ctState.data.reports || [] : null;
    const total = reps ? reps.length : Number(c.report_count) || 0;
    const wait = reps ? reps.filter(r => r.status === 'submitted' && r.submitted_via === 'share').length : Number(c.reports_to_confirm) || 0;
    ct.textContent = wait > 0 ? '確認待ち ' + wait : total + '件';
    if (wait > 0) ct.classList.add('hot');
  } else if (def.key === 'estimate') {
    ct.textContent = (ctState && ctState.data ? estSeriesCount(ctState.data.estimates) : Number(c.estimate_count) || 0) + '件';
  } else {
    ct.textContent = (ctState && ctState.data ? (ctState.data.notices || []).length : Number(c.notice_count) || 0) + '件';
  }
  list.appendChild(ct);
  if (def.key === 'estimate' && Number(c.estimate_count) > 0 && c.latest_estimate_total != null && typeof EstimateLogic !== 'undefined') {
    const yen = mk('span', 'ct ct-yen', EstimateLogic.yen(c.latest_estimate_total));
    yen.id = 'case-tool-estimates-total';
    list.appendChild(yen);
  }
  list.addEventListener('click', () => { location.hash = '#case/' + c.id + '/' + def.list; });
  acts.appendChild(list);
  card.appendChild(acts);
  return card;
}

// 「＋ 新しく作る」: 対応を選んでいれば phase_id 付きで（フェーズ詳細ページの「＋ 報告書を作る」等と同じ。js/phase-ui.js）、
// 対応が無い案件は案件全体の書類として作る（報告書は作業区分・担当を選ぶ必要があるので一覧の作成欄へ）
async function ctCreate(btn, def, sel) {
  const s = ctState;
  const c = currentCase;
  if (!s || s.busy) return;
  s.err = '';
  setMsg('case-tools-err', '');
  if (sel && typeof phMakeReport === 'function') {
    ctSel.set(c.id, sel.id);
    const fn = def.key === 'report' ? phMakeReport : def.key === 'estimate' ? phMakeEstimate : phMakeNotice;
    return fn(btn, sel, 'case-tools-err');
  }
  if (def.key === 'report') { location.hash = '#case/' + c.id + '/reports'; return; }
  s.busy = def.key;
  renderCaseTools();
  let row = null;
  try {
    row = def.key === 'estimate' ? await EstimatesApi.create(c.id, c)
      : await NoticesApi.create(c.id, c, c.room ? { data: { roomNo: String(c.room) } } : {});
  } catch (e) { s.err = def.name + 'を作れませんでした: ' + errText(e); }
  if (ctState !== s || caseDetailId !== c.id) return;
  s.busy = '';
  if (row) { location.hash = (def.key === 'estimate' ? '#estimate/' : '#notice/') + row.id; return; }
  renderCaseTools();
}

// 「送信待ちの下書き n件」を実際の下書きに合わせる（case_summaries.drafts_to_send は「今回は送らない」も数えるため）。
// 対応フェーズ欄の読み込み（js/phase-ui.js）が、この案件の mail_drafts を渡して呼ぶ
function syncCaseMailBanner(caseId, drafts) {
  const b = $('case-mail-banner');
  if (!b || caseDetailId !== caseId) return;
  const n = (drafts || []).filter(d => d.status === 'draft' && !d.skipped_at).length;
  const c = $('case-mail-count');
  if (c) c.textContent = '送信待ちの下書き ' + n + '件';
  b.hidden = n === 0;
  if (n === 0 && $('case-mail-list')) $('case-mail-list').hidden = true;
}

// ---- ヘッダ ----
function renderHead() {
  const c = currentCase;
  const done = c.status === 'done';
  const card = mk('div', 'case-head');

  const t = mk('div', 't');
  t.appendChild(mk('h2', null, c.name));
  t.appendChild(mk('span', 'st ' + (done ? 'done' : 'open'), done ? '完了' : '進行中'));
  card.appendChild(t);

  const meta = mk('div', 'meta');
  meta.appendChild(Icon.prepend(mk('span', null, c.assignee_name || '担当者未設定'), 'user', 14));
  const ds = CaseLogic.dueState(c.due_date, CaseLogic.todayStr());
  const hot = !done && (ds === 'overdue' || ds === 'near');
  const due = Icon.prepend(mk('span', hot ? 'hot' : null, c.due_date ? '期日 ' + CaseLogic.formatMD(c.due_date) : '期日未設定'), 'calendar', 14);
  meta.appendChild(due);
  card.appendChild(meta); // 元請・連絡先は下の「依頼元」欄（renderParties）

  const act = mk('div', 'head-act');
  act.appendChild(dBtn('編集', 'linkbtn', () => {
    openCaseModal(currentCase, async () => {
      const m = await refreshPart('head');
      notifyTimeline(); // 依頼元を変えたときの自動記録を出す
      if (m) setMsg('case-head-err', '保存しましたが、最新の表示に更新できませんでした: ' + m);
    });
  }));
  act.appendChild(dBtn(done ? '再開する' : '完了にする', 'btn sm ghost inline', b => {
    const gen = caseGen;
    const id = c.id;
    const next = done ? 'open' : 'done';
    runOp(b, 'case-head-err', 'head', '状態の変更', async () => {
      await CasesApi.setStatus(id, next);
      if (gen === caseGen) notifyTimeline();
    });
  }));
  card.appendChild(act);

  const urls = CaseLogic.mapUrls(c.address);
  const addr = mk('div', 'addr');
  if (urls) {
    addr.appendChild(Icon.prepend(mk('span', null, c.address), 'pin', 14));
    const links = mk('span', 'maplinks');
    const a1 = mk('a', null, 'Googleマップ');
    a1.href = urls.google; a1.target = '_blank'; a1.rel = 'noopener';
    const a2 = mk('a', null, '標準マップ');
    a2.href = urls.apple; a2.target = '_blank'; a2.rel = 'noopener';
    links.append(a1, document.createTextNode('｜'), a2);
    addr.appendChild(links);
  } else {
    addr.appendChild(Icon.prepend(mk('span', 'muted', '住所未設定（編集から追加）'), 'pin', 14));
  }
  card.appendChild(addr);

  // 今の状態 1行（自社の番 n件・相手待ち n件。Task 54 で「次: …」は消した）。中身は対応フェーズの読み込み後に js/phase-ui.js（phSyncNow）が入れる。
  // ヘッダを描き直しても同じ要素を使う（中身を失わない）
  let nowLine = $('case-now');
  if (!nowLine) {
    nowLine = mk('div', 'case-now');
    nowLine.id = 'case-now';
    nowLine.hidden = true;
    nowLine.setAttribute('role', 'status');
  }
  // 「今の状態」の行の右に「↩ 1つ前に戻す」（js/case-undo.js）。確かめる欄はその下
  const nowRow = mk('div', 'case-now-row');
  nowRow.appendChild(nowLine);
  // Task 46: この案件のメッセージ（LINE 風のトーク。js/talk-ui.js）。行を増やさないよう「今の状態」の行の右
  const talkBtn = Icon.prepend(dBtn('メッセージ', 'linkbtn case-talk', () => { location.hash = '#talk/' + c.id; }), 'chat', 14);
  talkBtn.id = 'case-talk-open';
  nowRow.appendChild(talkBtn);
  let undoPanel = null;
  if (typeof CaseUndo !== 'undefined') {
    const u = CaseUndo.mount();
    nowRow.appendChild(u.btn);
    undoPanel = u.panel;
  }
  card.appendChild(nowRow);
  if (undoPanel) card.appendChild(undoPanel);

  const err = mk('div', 'err'); err.id = 'case-head-err';
  card.appendChild(err);
  $('case-head-box').replaceChildren(card);
}

// ---- 依頼元 ----
// 元請は元請マスタ（担当者名・メール・電話は case_summaries の client_contact / client_master_email / client_tel。migration 022）、
// 物件オーナー・入居者は案件の列
function partyContact(email, tel) {
  const sub = mk('div', 'pty-sub');
  if (email) {
    const a = Icon.prepend(mk('a', 'pty-mail', email), 'mail', 14);
    a.href = 'mailto:' + email;
    sub.appendChild(a);
  }
  if (tel) {
    const a = Icon.prepend(mk('a', 'pty-tel', tel), 'phone', 14);
    a.href = 'tel:' + String(tel).replace(/[^0-9+]/g, '');
    sub.appendChild(a);
  }
  if (!email && !tel) sub.appendChild(mk('span', 'pty-none', 'メール・電話 未登録'));
  return sub;
}

function partyRow(key, label, value) {
  const r = mk('div', 'pty-row');
  r.dataset.party = key;
  r.appendChild(mk('div', 'pty-k', label));
  r.appendChild(value);
  return r;
}

function renderParties() {
  const box = $('case-parties');
  if (!box || !currentCase) return;
  const c = currentCase;
  const head = mk('div', 'taio-head');
  head.style.marginBottom = '0';
  head.appendChild(mk('b', null, '依頼元'));
  // 関係する部屋（加害部屋・被害部屋。migration 030 / Task 12。js/case-rooms.js）の保存・削除の後
  const roomsChanged = async () => {
    const m = await refreshPart('head');
    notifyTimeline(); // 部屋の追加・変更・削除の自動記録を出す
    if (m) setMsg('case-head-err', '保存しましたが、最新の表示に更新できませんでした: ' + m);
  };
  const headActs = mk('span', 'pty-head-acts');
  if (typeof CaseRooms !== 'undefined') headActs.appendChild(CaseRooms.addButton(c, roomsChanged));
  head.appendChild(headActs);
  headActs.appendChild(dBtn('依頼元を編集', 'linkbtn', () => {
    openCaseModal(currentCase, async () => {
      const m = await refreshPart('head');
      notifyTimeline(); // 依頼元を変えたときの自動記録を出す
      if (m) setMsg('case-head-err', '保存しましたが、最新の表示に更新できませんでした: ' + m);
    }, { focus: 'parties' });
  }));

  // 元請
  const gc = mk('div', 'pty-v');
  const master = !!c.client_id && !!c.client_master_name;
  const gcName = c.client_master_name || c.client_name;
  if (gcName) {
    const line = mk('div');
    line.appendChild(mk('b', null, gcName + (master && c.client_contact ? ' ' + c.client_contact + '様' : '')));
    if (c.client_id && c.client_billing_mode) {
      const m = c.client_billing_mode === 'monthly' ? 'monthly' : 'single';
      line.appendChild(mk('span', 'pty-tag ' + m, ClientsApi.BILLING_LABEL[m]));
    }
    if (!c.client_id) line.appendChild(mk('span', 'pty-tag', '元請マスタに未登録'));
    gc.appendChild(line);
    gc.appendChild(partyContact(master ? (c.client_master_email || c.client_email) : c.client_email, master ? c.client_tel : null));
  } else {
    gc.appendChild(mk('span', 'pty-none', '未選択（「依頼元を編集」から元請マスタで選ぶ）'));
  }

  const person = (nm, email, tel) => {
    const v = mk('div', 'pty-v');
    if (!nm && !email && !tel) { v.appendChild(mk('span', 'pty-none', '未登録')); return v; }
    v.appendChild(mk('b', null, nm ? nm + '様' : '（お名前未登録）'));
    v.appendChild(partyContact(email, tel));
    return v;
  };
  // 号室（migration 025）: 依頼元の上。連絡メールの件名・宛名・場所に入る
  const roomV = mk('div', 'pty-v');
  const roomText = typeof PhaseLogic !== 'undefined' ? PhaseLogic.roomLabel(c.room) : String(c.room || '').trim();
  roomV.appendChild(roomText ? mk('b', null, roomText) : mk('span', 'pty-none', '未登録（「依頼元を編集」から入れられます）'));
  // 依頼元の部屋は「この案件の部屋（被害部屋）」という扱い（Task 12。加害部屋などは下の「関係する部屋」）
  if (roomText) roomV.appendChild(mk('span', 'rm-own-note', ' この案件の部屋（被害部屋）'));
  const roomRow = partyRow('room', '号室', roomV);
  roomRow.id = 'case-room';
  roomRow.classList.add('pty-room');
  // 関係する部屋の一覧（部屋が無ければ出さない）
  let rooms = null;
  if (typeof CaseRooms !== 'undefined') {
    try { rooms = CaseRooms.section(c, roomsChanged); } catch (e) { console.warn('関係する部屋の表示に失敗', e); }
  }
  box.replaceChildren(...[roomRow, head,
    partyRow('client', '元請', gc),
    partyRow('owner', '物件オーナー', person(c.owner_name, c.owner_email, c.owner_tel)),
    partyRow('resident', '入居者', person(c.resident_name, c.resident_email, c.resident_tel)), rooms].filter(Boolean));
}

// ---- Task 52: 今のフェーズ（依頼元の下の小さな帯）----
// 対応ごとに1行「原因元工事 ｜ 発注待ち（10/25 送付・3日）」と、自社の番 = 赤・相手待ち = 黄の点。押すとその対応の矢羽が開く（初めは閉じる）。
// データは対応フェーズ欄の読み込み（syncCaseTools）があればそれ、無ければ case_summaries の phases（読み込みは増やさない）
const pbOpen = new Set(); // 矢羽を開いている対応（案件を開き直すと閉じる）
function pbData() {
  const d = ctState && ctState.caseId === currentCase.id ? ctState.data : null;
  if (!d) return { phases: Array.isArray(currentCase.phases) ? currentCase.phases : [], docs: null };
  return { phases: d.phases || [], docs: p => ({ estimates: (d.estimates || []).filter(e => e.phase_id === p.id), reports: (d.reports || []).filter(r => r.phase_id === p.id) }) };
}
function renderPhaseBand() {
  const box = $('case-phase-band');
  if (!box || !currentCase || typeof PhaseLogic === 'undefined') return;
  const { phases, docs } = pbData();
  const rows = PhaseLogic.phaseChevrons(phases, new Date(), { me: ctx && ctx.user ? ctx.user.id : null, members: caseMembers }, docs);
  box.hidden = !rows.length;
  const kids = [mk('div', 'pb-h', '今のフェーズ')];
  rows.forEach(r => {
    const wrap = mk('div', 'pb-row' + (r.child ? ' child' : '') + (r.lost ? ' lost' : ''));
    wrap.dataset.phaseId = r.id;
    const line = dBtn('', 'pb-line', () => {
      const on = !pbOpen.has(r.id);
      if (on) pbOpen.add(r.id); else pbOpen.delete(r.id);
      draw(on);
    });
    const dot = r.ball ? Icon.dot(r.ball, r.ball === 'them' ? '相手待ち' : '自社の番') : mk('span', 'dot none');
    if (!r.ball) dot.setAttribute('aria-hidden', 'true');
    line.append(dot, mk('b', 'pb-name', r.name), mk('span', 'pb-sep', '｜'), mk('span', 'pb-cur', r.label + (r.note ? '（' + r.note + '）' : '')));
    if (r.lost) line.appendChild(mk('span', 'chv-lost', '失注'));
    const ic = Icon.el('down', { size: 16 });
    ic.classList.add('pb-ic');
    line.appendChild(ic);
    wrap.appendChild(line);
    const draw = on => {
      line.setAttribute('aria-expanded', String(on));
      const old = wrap.querySelector('.pb-chv');
      if (old) old.remove();
      if (!on) return;
      const pane = mk('div', 'pb-chv');
      pane.appendChild(chevronEl(r));
      wrap.appendChild(pane);
      chevronScroll(pane);
    };
    draw(pbOpen.has(r.id));
    kids.push(wrap);
  });
  box.replaceChildren(...kids);
  if (box.isConnected) chevronScroll(box);
}
