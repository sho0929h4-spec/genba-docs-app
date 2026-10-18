// js/phase-ui.js — 案件詳細の「対応フェーズ」欄（調査・原因元工事・復旧工事のカード）… renderPhases(rootEl)
// case-detail.js の buildDetail から呼ばれる。段階・文面・日本時間の計算は js/phase-logic.js（PhaseLogic）、
// DB は js/phases-api.js（PhasesApi）と既存の ReportsApi / EstimatesApi / NoticesApi。
// ユーザー入力は createElement + textContent / value で描画する（innerHTML は使わない）。alert/confirm は使わない（カード内で確認）
// mk() は case-list.js、dBtn / errText / notifyTimeline / currentCase / caseGen / caseDetailId は case-detail.js、withBusy / $ は app.js
//
// カード（ワイヤーフレーム docs/mocks/mock-phases.html の 3・6）:
//   調査: 調査日時 → 調査した → 調査結果（Task 5b）→ 報告書 → 見積書
//   工事: 見積（この工事の分）→ 工事日の調整（工事掲示も）→ 完了 → 報告書 → 請求（Task 7。調査は調査費用の見積があるときだけ請求の段）
// 日時の入力は日本時間（端末のタイムゾーンに関係なく、入力欄の値を日本時間として読む）

const PH_WORK_TYPE = { survey: 'investigate', cause: 'repair', repair: 'restore' }; // 報告書の作業区分
const PH_STEP_INDEX = {
  survey: { schedule: 0, visit: 1, report: 3, approval: 4, done: 5 }, // 2 = 調査結果（段階 report で未入力なら 2）
  work: { estimate: 0, approval: 0, schedule: 1, work: 2, report: 3, bill: 4, payment: 4, done: 5 }
};
const PH_REMIND_STATE = { planned: '予定', due: '時刻を過ぎました（まもなく下書きができます）', draft: '下書きあり', sent: '送信済み', skipped: '送らない' };
const PH_REPORT_STATUS = { draft: '下書き', submitted: '提出済み・確認待ち', confirmed: '確認済み', sent: '送付済み' };

let ph = null;     // { gen, caseId, root, data: {phases, estimates, reports, notices, drafts}, editing: Set, confirmDel, adding, loadErr }
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
function renderPhases(root) {
  ph = { gen: caseGen, caseId: currentCase.id, root, data: null, editing: new Set(), amountEdit: new Set(), billForm: new Set(), dueEdit: new Set(), confirmDel: null, adding: false, loadErr: '' };
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
      ReportsApi.listDrafts(s.caseId)
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
  // 時刻を過ぎたリマインドの下書きを作る・古い未送信のリマインドを消す（案件一覧と同じ。二重作成は DB の unique で防ぐ）
  try {
    const r = await PhasesApi.syncReminders([{ caseRow: currentCase, phases: phases || [] }], drafts || [], new Date());
    r.errors.forEach(m => console.warn(m));
    if (r.created.length || r.removed) drafts = await ReportsApi.listDrafts(s.caseId);
  } catch (e) { console.warn('リマインドの確認に失敗', e); }
  if (!phAlive(s) || seq !== phSeq) return '';
  s.loadErr = '';
  s.data = {
    phases: phases || [],
    estimates: (series || []).flatMap(x => x.versions || []),
    reports: reports || [],
    notices: notices || [],
    drafts: drafts || []
  };
  phDraw();
  if (typeof syncCaseMailBanner === 'function') syncCaseMailBanner(s.caseId, s.data.drafts);
  return '';
}

// 操作の共通: 失敗はカード（無ければ欄）に表示。成功・失敗とも読み込み直す
async function phRun(btn, errId, label, fn) {
  const s = ph;
  if (!phAlive(s)) return;
  phMsg(errId, '');
  let msg = '';
  await withBusy(btn, async () => {
    try { await fn(); }
    catch (e) { msg = label + 'に失敗しました: ' + errText(e); }
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
  // 調査結果・内容詳細の入力欄は描き直しても同じ要素を使う（入力中の値・カーソル位置を失わない）。
  // カードを作る時点で要素が付け替わってフォーカスが外れるので、先に覚えて最後に戻す
  const ae = document.activeElement;
  const keep = ae && s.root.contains(ae) && ae.closest && ae.closest('.ph-result, .ph-plan')
    ? { el: ae, a: ae.selectionStart, b: ae.selectionEnd } : null;
  const head = mk('div', 'taio-head');
  head.appendChild(mk('b', null, '対応フェーズ'));
  const adds = mk('div', 'ph-adds');
  PhaseLogic.KINDS.forEach(k => {
    const b = dBtn('＋ ' + k.label, 'ph-add k-' + k.key, btn => phAdd(btn, k.key));
    b.dataset.kind = k.key;
    if (!s.data || s.adding) b.disabled = true;
    adds.appendChild(b);
  });
  const nodes = [head, adds];
  const err = mk('div', 'err');
  err.id = 'case-phases-err';
  if (!s.data) {
    if (s.loadErr) {
      nodes.push(mk('div', 'err', '対応フェーズを読み込めませんでした: ' + s.loadErr));
      nodes.push(dBtn('再読み込み', 'btn sm ghost inline', () => phLoad()));
    } else nodes.push(mk('div', 'nx-empty', '読み込み中…'));
    s.root.replaceChildren(...nodes, err);
    return;
  }
  if (s.data.phases.length === 0) {
    nodes.push(mk('div', 'ph-empty', 'まだありません。調査に行くときは「＋ 調査」、工事をするときは「＋ 原因元工事」「＋ 復旧工事」を押してください（同じ種類を何回でも追加できます）'));
  } else {
    const list = mk('div', 'ph-list');
    s.data.phases.forEach(p => list.appendChild(phCard(p)));
    nodes.push(list);
  }
  if (s.loadErr) nodes.push(mk('div', 'err', '最新の表示に更新できませんでした: ' + s.loadErr));
  s.root.replaceChildren(...nodes, err);
  if (phFocusId) phApplyFocus();
  if (keep && keep.el.isConnected && document.activeElement !== keep.el) {
    try {
      keep.el.focus({ preventScroll: true });
      if (typeof keep.a === 'number' && keep.el.setSelectionRange) keep.el.setSelectionRange(keep.a, keep.b);
    } catch (e) { /* type によっては選択範囲を持たない */ }
  }
}

function phAdd(btn, kind) {
  const s = ph;
  return phRun(btn, 'case-phases-err', '追加', async () => {
    const row = await PhasesApi.create(s.caseId, kind, currentCase);
    s.newId = row.id;
  }).then(() => {
    if (!phAlive(s) || !s.newId) return;
    const card = s.root.querySelector('[data-phase-id="' + s.newId + '"]');
    s.newId = null;
    if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
  const st = PhaseLogic.stage(p, { estimates: docs.estimates, reports: docs.reports }, new Date());
  const map = isSurvey ? PH_STEP_INDEX.survey : PH_STEP_INDEX.work;
  const hasRes = isSurvey && PhaseLogic.hasResult(phResultOf(p));
  let cur = map[st.key] != null ? map[st.key] : 0;
  if (isSurvey && st.key === 'report' && !hasRes) cur = 2;
  const schedIdx = isSurvey ? 0 : 1;
  const resIdx = isSurvey ? 2 : -1;
  if (i === resIdx && hasRes) return 'done';
  if (i < cur) return (i === schedIdx && !p.scheduled_at) || i === resIdx ? 'later' : 'done';
  return i === cur ? 'now' : 'later';
}

function phCard(p) {
  const docs = phDocs(p);
  const isSurvey = p.kind === 'survey';
  const st = PhaseLogic.stage(p, { estimates: docs.estimates, reports: docs.reports }, new Date());
  const stateOf = i => phStepState(p, docs, i);
  const errId = 'ph-err-' + p.id;

  const card = mk('div', 'ph-card k-' + p.kind);
  card.dataset.phaseId = p.id;
  card.dataset.kind = p.kind;
  card.dataset.stage = st.key;

  const hd = mk('div', 'ph-hd');
  hd.appendChild(mk('span', 'ph-kind k-' + p.kind, PhaseLogic.kindLabel(p.kind)));
  hd.appendChild(mk('b', 'ph-n', phSeqOf(p) + '回目'));
  hd.appendChild(mk('span', 'ph-sp'));
  const tag = mk('span', 'ph-stage ' + (st.ball === 'us' ? 'us' : st.ball === 'them' ? 'them' : 'done'),
    st.ball ? PhaseLogic.MARK[st.ball] + ' ' + st.label : '✓ ' + st.label);
  tag.title = '今の段階';
  hd.appendChild(tag);
  card.appendChild(hd);

  const steps = mk('div', 'ph-steps');
  // 作業担当者の段（Task 6b）は日時の段の次。番号は並び順で振り直す（段階の判定 phStepState の i は今までどおり）
  let n = 0;
  const add = (state, title, body) => steps.appendChild(phStep(state, ++n, title, body));
  if (isSurvey) {
    add(stateOf(0), '調査日時', phScheduleBody(p, docs, errId));
    add(phWorkerStepState(p), '作業担当者', phWorkerBody(p, docs, errId));
    add(stateOf(1), '調査した', phDoneBody(p, errId).concat([phContactEl(p, docs.mails)]));
    add(stateOf(2), '調査結果', phResultBody(p, docs));
    add(stateOf(3), '報告書', phReportsBody(p, docs, errId));
    add(stateOf(4), '見積書（この調査の分）', phEstimatesBody(p, docs, errId));
    // 精算（調査費用の請求）: 見積の有無にかかわらず常に出す（見積が無ければ金額は手入力）。見出しの横に請求の状態
    const bs = p.paid_at ? 'done' : p.done_at || p.billed_at ? 'now' : 'later';
    steps.appendChild(phBillTagged(phStep(bs, ++n, '精算', phBillingBody(p, docs, errId)), p));
  } else {
    add(stateOf(0), '見積（この工事の分）', phEstimatesBody(p, docs, errId));
    add(stateOf(1), '工事日の調整', phScheduleBody(p, docs, errId).concat(phNoticesBody(p, docs, errId)));
    add(phWorkerStepState(p), '作業担当者', phWorkerBody(p, docs, errId));
    add(stateOf(2), '完了', phDoneBody(p, errId));
    add(stateOf(3), '報告書', phReportsBody(p, docs, errId));
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
  const planEl = phPlanBody(p);
  if (!p.scheduled_at) { out.push(planEl); return out; }

  // 日程連絡のメール（purpose schedule）
  const sched = docs.mails.filter(m => m.purpose === 'schedule')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const draft = sched.find(m => m.status === 'draft');
  const sent = sched.find(m => m.status === 'sent');
  const what = isSurvey ? '調査日のご連絡' : '工事日のご連絡';
  const ml = mk('div', 'ph-mail');
  if (draft) {
    const who = (draft.recipients || []).map(k => (PhaseLogic.RECIPIENTS.find(r => r.key === k) || {}).label).filter(Boolean);
    ml.appendChild(mk('span', null, '✉️ ' + what + ': ' + (draft.skipped_at ? '今回は送らない' : '下書きあり') +
      (who.length ? '（' + who.join('・') + '）' : '（宛先のメール未登録）')));
    const b = dBtn('確認して送る', 'btn sm inline ph-mail-open', btn => phOpenAfterPlan(btn, draft.id));
    b.dataset.draftId = draft.id;
    ml.appendChild(b);
  } else if (sent) {
    ml.appendChild(mk('span', null, '✉️ ' + what + ' ' + PhaseLogic.fmtMD(sent.sent_at) + ' 送信済み'));
  } else {
    ml.appendChild(mk('span', 'ph-sub', '✉️ ' + what + ': 下書きがありません（日時を保存し直すと作られます）'));
  }
  out.push(ml, planEl);

  // リマインド（3日前・前日の 18:00 に、入居者・物件オーナー宛ての下書きを作る。作るのはアプリを開いたとき）
  const open = !p.done_at && Date.parse(p.scheduled_at) > Date.now();
  const rs = PhaseLogic.reminderState(p, docs.mails, new Date());
  if (open || !rs.none) {
    const rm = mk('div', 'ph-remind');
    if (rs.none) {
      rm.textContent = '⏰ リマインドなし（日時を入れたのが前日18:00より後のため）';
    } else {
      rm.appendChild(mk('div', 'ph-rm-t', '⏰ リマインド（3日前・前日の18:00に下書きを作ります）'));
      rs.slots.forEach(x => {
        const row = mk('div', 'ph-rm');
        row.dataset.slot = x.slot;
        row.dataset.state = x.state;
        row.appendChild(mk('span', null, x.label + ' ' + PhaseLogic.fmtMDWHM(x.at)));
        row.appendChild(mk('span', 'ph-rm-s', PH_REMIND_STATE[x.state] +
          (x.state === 'sent' && x.draft && x.draft.sent_at ? ' ' + PhaseLogic.fmtMD(x.draft.sent_at) : '')));
        if (x.state === 'draft' || x.state === 'skipped') {
          const b = dBtn(x.state === 'draft' ? '確認して送る' : '開く', (x.state === 'draft' ? 'btn sm inline' : 'linkbtn') + ' ph-rm-open',
            btn => phOpenAfterPlan(btn, x.draft.id));
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

// 内容詳細の保存待ちを終わらせてから連絡メールを開く（本文に最新の内容詳細が入るように）
async function phOpenAfterPlan(btn, id) {
  btn.disabled = true;
  try { await phPlanSettle(); } finally { btn.disabled = false; }
  openMailDraft(id);
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
  form.appendChild(mk('div', 'ph-sub', '保存すると、関係者への連絡メールの下書きができます（送るのは「確認して送る」から）'));
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
      await phPlanSettle(); // 内容詳細の保存待ちを先に（連絡メールの本文に入るため）
      await PhasesApi.saveSchedule(p, startIso, endIso, currentCase, s.data.drafts, phTitle(p));
    } finally {
      if (phAlive(s)) s.editing.delete(p.id);
    }
  });
}

/* ---- 調査した・完了 ---- */
function phDoneBody(p, errId) {
  const isSurvey = p.kind === 'survey';
  const line = mk('div', 'ph-row');
  if (p.done_at) {
    line.appendChild(mk('span', 'ph-done', PhaseLogic.fmtMD(p.done_at) + (isSurvey ? ' 調査済み' : ' 完了')));
    line.appendChild(dBtn('取り消す', 'linkbtn ph-undone', b => phRun(b, errId, '取り消し', () => PhasesApi.setDone(p, false, phTitle(p)))));
    return [line];
  }
  line.appendChild(dBtn(isSurvey ? '調査済みにする' : '完了にする', 'btn sm inline ph-done-btn',
    b => phRun(b, errId, isSurvey ? '調査済みにする操作' : '完了にする操作', () => PhasesApi.setDone(p, true, phTitle(p)))));
  return [line, mk('div', 'ph-sub', isSurvey ? '調査に行ったら押してください（間違えたら取り消せます）' : '工事が終わったら押してください（間違えたら取り消せます）')];
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
  el.appendChild(mk('b', 'ph-ct-t', '📨 依頼元へ報告連絡'));
  if (draft) {
    const who = PhaseLogic.recipientsLabel(draft.recipients);
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
    const who = PhaseLogic.recipientsLabel(sent.recipients);
    el.dataset.state = 'sent';
    el.appendChild(mk('span', 'ph-ct-sent', '調査結果のご報告 ' + PhaseLogic.fmtMD(sent.sent_at) + ' 送信済み' + (who ? '（' + who + '）' : '')));
  } else {
    el.dataset.state = 'none';
    el.appendChild(mk('span', 'ph-sub', '未作成です。下の「調査結果」を入れると「調査結果のご報告」の下書きができます'));
    el.appendChild(dBtn('調査結果を入れる', 'linkbtn ph-ct-go', () => {
      const ta = ph && ph.root && ph.root.querySelector('.ph-result[data-phase-id="' + p.id + '"] .ph-res-cause');
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
  const b = dBtn('＋ 見積書を作る', 'ph-mkdoc ph-mk-estimate', btn => {
    const s = ph;
    phMsg(errId, '');
    return withBusy(btn, async () => {
      try {
        // 工事カードから作る見積は、この案件の調査結果の注意事項を備考の初期値に（作成時だけ）
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
    });
  });
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
    box.appendChild(mk('div', 'ph-sub', (PH_REPORT_STATUS[r.status] || r.status) + ' ・ ' + phSentToText(t)));
    const rc = phReportContactEl(r, t, errId);
    if (rc) box.appendChild(rc);
    out.push(box);
  });
  const b = dBtn('＋ 報告書を作る', 'ph-mkdoc ph-mk-report', btn => {
    const s = ph;
    phMsg(errId, '');
    return withBusy(btn, async () => {
      try {
        const meId = ctx && ctx.user ? ctx.user.id : null;
        const f = { work_type: PH_WORK_TYPE[p.kind], worker_id: meId, phase_id: p.id, phaseTitle: phTitle(p) };
        // 調査カードから作る報告書（調査区分）は、この調査の調査結果を 原因／原因と判断した理由／次の対応方針 の初期値に（作成時だけ）
        if (p.kind === 'survey') {
          await phResSettle();
          f.init = PhaseLogic.reportInit(phResultOf(p));
        }
        if (!phAlive(s)) return;
        const row = await ReportsApi.create(s.caseId, f);
        if (phAlive(s)) location.hash = '#report/' + row.id;
      } catch (e) { if (phAlive(s)) phMsg(errId, '報告書を作れませんでした: ' + errText(e)); }
    });
  });
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
    row.appendChild(mk('span', 'ph-ct-sent', '📨 ' + (shared.date ? PhaseLogic.fmtMD(shared.date) + ' に' : '') + '送付' + (who ? '（' + who + '）' : '')));
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
    row.appendChild(dBtn('📨 報告連絡（確認して送る）', 'btn sm inline ph-rep-ct', () => openMailDraft(draft.id)));
  } else if (r.status === 'submitted') {
    row.dataset.state = 'submitted';
    row.appendChild(dBtn('📨 確認して報告連絡', 'btn sm inline ph-rep-ct', b => openNew(b, async () => {
      const d = await ReportsApi.confirm(r, currentCase);
      notifyTimeline();
      return d;
    })));
    row.appendChild(mk('span', 'ph-sub', '確認済みにして、依頼元への送付メールの下書きを開きます'));
  } else {
    row.dataset.state = 'none';
    row.appendChild(dBtn('📨 報告連絡', 'btn sm inline ph-rep-ct', b => openNew(b, () => ReportsApi.createDraft(r, currentCase))));
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
    top.appendChild(mk('b', 'ph-doc-t', '📢 工事掲示 ' + ((typeof NoticeLogic !== 'undefined' && NoticeLogic.normalizeRoom(n.room)) || n.room || '号室未入力')));
    top.appendChild(mk('span', 'ph-sp'));
    top.appendChild(dBtn('開く', 'linkbtn', () => { location.hash = '#notice/' + n.id; }));
    box.appendChild(top);
    box.appendChild(mk('div', 'ph-sub', n.work_date_tbd ? '工事日 未定' : n.work_date ? '工事日 ' + n.work_date.replace(/^\d{4}-0?(\d+)-0?(\d+)$/, '$1/$2') : '工事日 未入力'));
    out.push(box);
  });
  const b = dBtn('📢 工事掲示を作る', 'ph-mkdoc ph-mk-notice', btn => {
    const s = ph;
    phMsg(errId, '');
    return withBusy(btn, async () => {
      try {
        const data = {};
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
    });
  });
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
      ? '月ごとの元請は、請求の一覧（💴）で同じ月の分をまとめて「請求した」にもできます'
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
  box.appendChild(st);
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
  const has = docs.estimates.length || docs.reports.length || docs.notices.length || sentMail;
  if (ph.confirmDel === p.id && !has) {
    const box = mk('div', 'ph-confirm');
    box.appendChild(mk('div', null, '「' + phTitle(p) + '」のカードを削除しますか？（元に戻せません。未送信の連絡メールの下書きも消えます）'));
    const acts = mk('div', 'ph-acts');
    acts.appendChild(dBtn('やめる', 'btn sm ghost inline ph-del-cancel', () => { ph.confirmDel = null; phDraw(); }));
    acts.appendChild(dBtn('削除する', 'btn sm inline ph-del-ok', b => {
      const s = ph;
      return phRun(b, errId, '削除', async () => {
        await PhasesApi.remove(p, phTitle(p));
        if (phAlive(s)) s.confirmDel = null;
      });
    }));
    box.appendChild(acts);
    foot.appendChild(box);
    return foot;
  }
  const del = dBtn('このカードを削除', 'linkbtn danger ph-del', () => { ph.confirmDel = p.id; phMsg(errId, ''); phDraw(); });
  if (has) {
    del.disabled = true;
    foot.append(del, mk('span', 'ph-sub', '見積書・報告書・工事掲示・送ったメールがあるため削除できません'));
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
const PH_RES_TEXTS = [
  { key: 'cause', label: '原因は何か', ph: '例: 上階 402 の浴室防水の劣化による漏水' },
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
    const who = PhaseLogic.recipientsLabel(draft.recipients);
    nodes.push(mk('span', null, '✉️ 調査結果のご報告: ' + (draft.skipped_at ? '今回は送らない' : '下書きあり') +
      (who ? '（' + who + '）' : '（宛先のメール未登録）')));
    const b = dBtn('確認して送る', 'btn sm inline ph-res-open', async btn => {
      btn.disabled = true;
      try { await phResSettle(); } finally { btn.disabled = false; }
      openMailDraft(btn.dataset.draftId);
    });
    b.dataset.draftId = draft.id;
    nodes.push(b);
  } else if (sent) {
    nodes.push(mk('span', null, '✉️ 調査結果のご報告 ' + PhaseLogic.fmtMD(sent.sent_at) + ' 送信済み'));
    nodes.push(mk('span', 'ph-sub', '（内容を直すと、新しい下書きができます）'));
  } else {
    nodes.push(mk('span', 'ph-sub', '✉️ 入力すると「調査結果のご報告」メールの下書きができます（宛先は依頼元から選びます）'));
  }
  el.replaceChildren(...nodes);
}

function phResChanged(rs) {
  rs.dirty = true;
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
    val, caseRow || { id: rs.caseId }, rs.title || '調査');
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
  phPlan.forEach(ps => { if (ps.dirty || ps.timer) phPlanFlush(ps); });
}
window.addEventListener('hashchange', phResFlushAll);
window.addEventListener('beforeunload', phResFlushAll);
document.addEventListener('visibilitychange', () => { if (document.hidden) phResFlushAll(); });

/* ---------- 内容詳細（対応フェーズ Task 6c。case_phases.plan） ---------- */
// 調査日時（工事は工事日の調整）の枠内: 調査箇所（複数）・所要時間（1つ。もう一度押すと外れる）・ご協力のお願い（複数）の選択式ボタンと補足の欄。
// 入力から1.5秒で自動保存（PhasesApi.savePlan）し、未送信の日程連絡・リマインドの下書きの「■ 内容詳細」を書き換える。
// 調査結果（phRes）と同じく、フェーズごとのセッションで同じ要素を使い回す（描き直しても入力中の値・カーソルを失わない）
const PH_PLAN_MAX = 200; // 補足の欄の文字数
const phPlan = new Map(); // phaseId → セッション
const phPlanJson = v => JSON.stringify(PhaseLogic.normalizePlan(v));

function phPlanSession(p) {
  let ps = phPlan.get(p.id);
  const server = phPlanJson(p.plan);
  if (ps && ps.caseId !== p.case_id) ps = null;
  if (!ps) {
    ps = { id: p.id, caseId: p.case_id, kind: p.kind, v: PhaseLogic.normalizePlan(p.plan), serverJson: server,
      dirty: false, saving: false, timer: null, chain: Promise.resolve(), state: '', err: '', lastSaved: null, el: null, els: {} };
    phPlan.set(p.id, ps);
  } else if (!ps.dirty && !ps.saving && !ps.timer && ps.serverJson !== server) {
    Object.assign(ps, { v: PhaseLogic.normalizePlan(p.plan), serverJson: server, el: null, els: {} });
  }
  return ps;
}

function phPlanBody(p) {
  const ps = phPlanSession(p);
  if (!ps.el) phPlanBuild(ps);
  phPlanSetState(ps, ps.state);
  return ps.el;
}

// 選択式ボタンの並び。multi: 複数選べる（配列）／単一（文字列。もう一度押すと外す）
function phPlanGroup(ps, title, key, list, multi) {
  const box = document.createDocumentFragment();
  box.appendChild(mk('div', 'ph-cau-t', title));
  const wrap = mk('div', 'ph-caus ph-plan-g');
  wrap.dataset.group = key;
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', title);
  const btns = [];
  const on = k => (multi ? ps.v[key].includes(k) : ps.v[key] === k);
  const sync = () => btns.forEach(b => b.setAttribute('aria-pressed', on(b.dataset.key) ? 'true' : 'false'));
  list.forEach(c => {
    const b = mk('button', 'ph-cau', c.label);
    b.type = 'button';
    b.dataset.key = c.key;
    b.addEventListener('click', () => {
      if (multi) {
        const set = new Set(ps.v[key]);
        if (set.has(c.key)) set.delete(c.key); else set.add(c.key);
        ps.v[key] = list.map(x => x.key).filter(k => set.has(k));
      } else ps.v[key] = ps.v[key] === c.key ? '' : c.key;
      sync();
      phPlanSyncExtras(ps);
      phPlanChanged(ps);
    });
    btns.push(b);
    wrap.appendChild(b);
  });
  sync();
  box.appendChild(wrap);
  return box;
}
function phPlanText(ps, key, label, placeholder) {
  const i = document.createElement('input');
  i.type = 'text';
  i.className = 'ph-plan-' + key;
  i.maxLength = PH_PLAN_MAX;
  i.placeholder = placeholder;
  i.autocomplete = 'off';
  i.value = ps.v[key];
  i.addEventListener('input', () => { ps.v[key] = i.value; phPlanChanged(ps); });
  const l = mk('label', 'ph-rl', label);
  l.appendChild(i);
  ps.els[key] = l;
  return l;
}

function phPlanBuild(ps) {
  const box = mk('div', 'ph-plan');
  box.dataset.phaseId = ps.id;
  ps.els = {};
  const work = ps.kind !== 'survey';
  box.appendChild(mk('div', 'ph-plan-t', '内容詳細（押して選ぶ。連絡メールに自動で入ります）'));
  box.appendChild(phPlanGroup(ps, work ? '工事箇所' : '調査箇所', 'spots', PhaseLogic.PLAN_SPOTS, true));
  box.appendChild(phPlanText(ps, 'spotNote', '補足（任意）', work ? '例: 302 の天井' : '例: 上階 402 の浴室下'));
  box.appendChild(phPlanGroup(ps, '所要時間', 'duration', PhaseLogic.PLAN_DURATIONS, false));
  box.appendChild(phPlanText(ps, 'durationNote', '所要時間（自由記入）', '例: 2〜3時間'));
  box.appendChild(phPlanGroup(ps, 'ご協力のお願い', 'asks', PhaseLogic.PLAN_ASKS, true));
  box.appendChild(phPlanText(ps, 'askNote', 'その他のお願い（自由記入）', '例: 管理人室への声かけ'));
  const sv = mk('div', 'ph-res-save');
  const save = mk('span', 'rep-save ph-plan-save');
  save.setAttribute('role', 'status');
  const retry = dBtn('再試行', 'btn sm ghost inline ph-plan-retry', () => phPlanFlush(ps));
  retry.hidden = true;
  sv.append(save, retry);
  box.appendChild(sv);
  Object.assign(ps.els, { save, retry });
  ps.el = box;
  phPlanSyncExtras(ps);
}
// 所要時間の自由記入は「その他」のとき、その他のお願いは「その他」がオンのときだけ（オフにしても値は残す。文面には使わない）
function phPlanSyncExtras(ps) {
  if (ps.els.durationNote) ps.els.durationNote.hidden = ps.v.duration !== 'other';
  if (ps.els.askNote) ps.els.askNote.hidden = !ps.v.asks.includes('other');
}

function phPlanSetState(ps, state) {
  ps.state = state;
  const el = ps.els.save;
  if (!el) return;
  ps.els.retry.hidden = state !== 'error';
  el.className = 'rep-save ph-plan-save' + (state === 'saved' ? '' : state === 'error' ? ' err' : ' busy');
  el.dataset.state = state;
  if (state === 'pending') el.textContent = '保存待ち…';
  else if (state === 'saving') el.textContent = '保存中…';
  else if (state === 'saved') el.textContent = '自動保存 ' + PhaseLogic.fmtMDHM(ps.lastSaved || new Date()).split(' ')[1] + (ps.mailNote || '');
  else if (state === 'error') el.textContent = '保存できませんでした: ' + (ps.err || '');
  else el.textContent = '';
}

function phPlanChanged(ps) {
  ps.dirty = true;
  phPlanSetState(ps, 'pending');
  clearTimeout(ps.timer);
  ps.timer = setTimeout(() => phPlanFlush(ps), PH_RES_DELAY);
}
function phPlanFlush(ps) {
  clearTimeout(ps.timer);
  ps.timer = null;
  ps.chain = ps.chain.then(() => phPlanDoSave(ps)).catch(e => {
    ps.dirty = true;
    ps.err = errText(e);
    phPlanSetState(ps, 'error');
  });
  return ps.chain;
}
// 表示中の案件の内容詳細の保存を全部終わらせる（連絡メールを開く前。本文を最新にするため）
function phPlanSettle() {
  const list = [...phPlan.values()].filter(ps => ph && ps.caseId === ph.caseId);
  return Promise.all(list.map(ps => (ps.dirty || ps.timer ? phPlanFlush(ps) : ps.chain)));
}

async function phPlanDoSave(ps) {
  if (!ps.dirty) return;
  const val = JSON.parse(JSON.stringify(ps.v));
  ps.dirty = false;
  ps.saving = true;
  phPlanSetState(ps, 'saving');
  const caseRow = typeof currentCase !== 'undefined' && currentCase && currentCase.id === ps.caseId ? currentCase : { id: ps.caseId };
  let saved = null, drafts = [], msg = '';
  try {
    const r = await PhasesApi.savePlan({ id: ps.id, case_id: ps.caseId, kind: ps.kind }, val, caseRow);
    saved = r.phase;
    drafts = r.drafts || [];
  } catch (e) {
    saved = (e && e.phase) || null;
    msg = errText(e);
  }
  ps.saving = false;
  if (saved) {
    ps.serverJson = phPlanJson(saved.plan);
    ps.lastSaved = new Date();
    ps.mailNote = drafts.length ? '（連絡メールの下書きにも反映しました）' : '';
    const s = ph;
    if (s && s.data && s.caseId === ps.caseId) {
      const p = s.data.phases.find(x => x.id === ps.id);
      if (p) { p.plan = saved.plan; if (saved.updated_at) p.updated_at = saved.updated_at; }
      drafts.forEach(d => { const i = s.data.drafts.findIndex(x => x.id === d.id); if (i >= 0) s.data.drafts[i] = d; });
    }
  }
  if (msg) {
    ps.dirty = true;
    ps.err = msg;
    phPlanSetState(ps, 'error');
    return;
  }
  phPlanSetState(ps, ps.dirty ? 'pending' : 'saved');
}

/* ---------- 作業担当者への確認依頼（対応フェーズ Task 6b） ---------- */
// カードの「作業担当者」: 担当者（社内メンバーから選ぶ。初期値は案件の担当者）・状態（未通知／知らせた／確認済み）・
// 「担当者に知らせる」（担当者のアプリに 🔔 が出て、メールの下書きもできる）・担当者本人にだけ「確認した」
const phMembers = () => (typeof caseMembers !== 'undefined' && Array.isArray(caseMembers) ? caseMembers : []);
const phMyId = () => (ctx && ctx.user ? ctx.user.id : null);
function phWorkerStepState(p) {
  if (p.ack_at) return 'done';
  return p.worker_id && (p.notified_at || (p.scheduled_at && !p.done_at)) ? 'now' : 'later';
}
function phWorkerBody(p, docs, errId) {
  const out = [];
  const members = phMembers();
  const st = PhaseLogic.workerState(Object.assign({}, p, {
    ack_by_name: p.ack_by ? ((members.find(m => m.user_id === p.ack_by) || {}).display_name || '') : ''
  }));
  const box = mk('div', 'ph-worker');
  box.dataset.state = st.key;
  const row = mk('div', 'ph-row ph-wk-row');
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
    o.textContent = (m.display_name || '（名前なし）') + (m.user_id === phMyId() ? '（自分）' : '');
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
  row.appendChild(sel);
  const tag = mk('span', 'ph-wk-tag ' + st.key, st.label);
  row.appendChild(tag);
  box.appendChild(row);

  if (p.worker_id) {
    const acts = mk('div', 'ph-acts');
    const again = !!p.notified_at;
    acts.appendChild(dBtn(again ? 'もう一度知らせる' : '担当者に知らせる', (again ? 'btn sm ghost inline' : 'btn sm inline') + ' ph-wk-notify',
      b => phRun(b, errId, '担当者に知らせる操作', () => PhasesApi.notifyWorker(p, currentCase, phTitle(p), members))));
    if (p.worker_id === phMyId() && p.notified_at && !p.ack_at) {
      acts.appendChild(dBtn('確認した', 'btn sm inline ph-wk-ack', b => phRun(b, errId, '確認した操作', () => PhasesApi.ack(p, phTitle(p)))));
    }
    box.appendChild(acts);
    // 担当者への確認依頼のメール（下書き → 確認して送る／送信済み）
    const own = docs.mails.filter(m => m.purpose === 'staff_notice' && !m.remind_slot)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const draft = own.find(m => m.status === 'draft');
    const sent = own.find(m => m.status === 'sent');
    if (draft || sent) {
      const ml = mk('div', 'ph-mail ph-wk-mail');
      if (draft) {
        ml.appendChild(mk('span', null, '✉️ 担当者への確認依頼: ' + (draft.skipped_at ? '今回は送らない' : '下書きあり') + (draft.to_email ? '' : '（担当者のメール未登録）')));
        const b = dBtn('確認して送る', 'btn sm inline ph-wk-open', () => openMailDraft(draft.id));
        b.dataset.draftId = draft.id;
        ml.appendChild(b);
      } else ml.appendChild(mk('span', null, '✉️ 担当者への確認依頼 ' + PhaseLogic.fmtMD(sent.sent_at) + ' 送信済み'));
      box.appendChild(ml);
    }
  }
  box.appendChild(mk('div', 'ph-sub', p.worker_id
    ? '「担当者に知らせる」を押すと、担当者のアプリに「🔔 確認してください」が出て、メールの下書きもできます。担当者が「確認した」を押すとここに戻ってきます'
    : '作業する人を選んでください（社内メンバー）'));
  out.push(box);
  return out;
}

// #case/{caseId}/phase/{phaseId}: 案件を開いて、そのフェーズのカードまでスクロールして強調する
let phFocusId = null;
function openCasePhase(caseId, phaseId) {
  phFocusId = String(phaseId).toLowerCase();
  if (caseDetailId === caseId && $('screen-case').classList.contains('active') && ph && ph.data) { phApplyFocus(); return; }
  showScreen('case');
  renderHeaders();
  return loadCase(caseId);
}
function phApplyFocus() {
  if (!phFocusId || !ph || !ph.data || !ph.root) return;
  const card = ph.root.querySelector('.ph-card[data-phase-id="' + phFocusId + '"]');
  phFocusId = null;
  if (!card) return;
  card.classList.add('ph-focus');
  card.scrollIntoView({ block: 'start' });
  setTimeout(() => card.classList.remove('ph-focus'), 6000);
}
