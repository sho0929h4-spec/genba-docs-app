// js/phase-ui.js — 案件詳細の「対応フェーズ」欄（調査・原因元工事・復旧工事のカード）… renderPhases(rootEl)
// case-detail.js の buildDetail から呼ばれる。段階・文面・日本時間の計算は js/phase-logic.js（PhaseLogic）、
// DB は js/phases-api.js（PhasesApi）と既存の ReportsApi / EstimatesApi / NoticesApi。
// ユーザー入力は createElement + textContent / value で描画する（innerHTML は使わない）。alert/confirm は使わない（カード内で確認）
// mk() は case-list.js、dBtn / errText / notifyTimeline / currentCase / caseGen / caseDetailId は case-detail.js、withBusy / $ は app.js
//
// カード（ワイヤーフレーム docs/mocks/mock-phases.html の 3・6）:
//   調査: 調査日時 → 調査した → 報告書 → 見積書
//   工事: 見積（この工事の分）→ 工事日の調整（工事掲示も）→ 完了 → 報告書 → 請求（準備中。Task 7）
// 日時の入力は日本時間（端末のタイムゾーンに関係なく、入力欄の値を日本時間として読む）

const PH_WORK_TYPE = { survey: 'investigate', cause: 'repair', repair: 'restore' }; // 報告書の作業区分
const PH_STEP_INDEX = {
  survey: { schedule: 0, visit: 1, report: 2, approval: 3, done: 4 },
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
  ph = { gen: caseGen, caseId: currentCase.id, root, data: null, editing: new Set(), confirmDel: null, adding: false, loadErr: '' };
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

function phStep(state, n, title, body) {
  const st = mk('div', 'ph-st ' + state);
  st.appendChild(mk('span', 'ph-dot', state === 'done' ? '✓' : String(n)));
  const d = mk('div', 'ph-d');
  d.appendChild(mk('div', 'ph-t', title));
  body.filter(Boolean).forEach(x => d.appendChild(x));
  st.appendChild(d);
  return st;
}

function phCard(p) {
  const docs = phDocs(p);
  const isSurvey = p.kind === 'survey';
  const st = PhaseLogic.stage(p, { estimates: docs.estimates, reports: docs.reports }, new Date());
  const map = isSurvey ? PH_STEP_INDEX.survey : PH_STEP_INDEX.work;
  const cur = map[st.key] != null ? map[st.key] : 0;
  // 日時の段は日時が入っていないと済にしない（調査済みにした後で日時が未定のままのとき等）
  const schedIdx = isSurvey ? 0 : 1;
  const stateOf = i => (i < cur ? (i === schedIdx && !p.scheduled_at ? 'later' : 'done') : i === cur ? 'now' : 'later');
  const errId = 'ph-err-' + p.id;

  const card = mk('div', 'ph-card k-' + p.kind);
  card.dataset.phaseId = p.id;
  card.dataset.kind = p.kind;
  card.dataset.stage = st.key;

  const hd = mk('div', 'ph-hd');
  hd.appendChild(mk('span', 'ph-kind k-' + p.kind, PhaseLogic.kindLabel(p.kind)));
  const n = phSeqOf(p);
  hd.appendChild(mk('b', 'ph-n', n + '回目'));
  hd.appendChild(mk('span', 'ph-sp'));
  const tag = mk('span', 'ph-stage ' + (st.ball === 'us' ? 'us' : st.ball === 'them' ? 'them' : 'done'),
    st.ball ? PhaseLogic.MARK[st.ball] + ' ' + st.label : '✓ ' + st.label);
  tag.title = '今の段階';
  hd.appendChild(tag);
  card.appendChild(hd);

  const steps = mk('div', 'ph-steps');
  if (isSurvey) {
    steps.append(
      phStep(stateOf(0), 1, '調査日時', phScheduleBody(p, docs, errId)),
      phStep(stateOf(1), 2, '調査した', phDoneBody(p, errId)),
      phStep(stateOf(2), 3, '報告書', phReportsBody(p, docs, errId)),
      phStep(stateOf(3), 4, '見積書（この調査の分）', phEstimatesBody(p, docs, errId)));
  } else {
    steps.append(
      phStep(stateOf(0), 1, '見積（この工事の分）', phEstimatesBody(p, docs, errId)),
      phStep(stateOf(1), 2, '工事日の調整', phScheduleBody(p, docs, errId).concat(phNoticesBody(p, docs, errId))),
      phStep(stateOf(2), 3, '完了', phDoneBody(p, errId)),
      phStep(stateOf(3), 4, '報告書', phReportsBody(p, docs, errId)),
      phStep(stateOf(4), 5, '請求', [mk('div', 'ph-sub', '請求の記録は準備中です（請求先・請求日・入金の記録は次の更新で使えるようになります）')]));
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
    const who = (draft.recipients || []).map(k => (PhaseLogic.RECIPIENTS.find(r => r.key === k) || {}).label).filter(Boolean);
    ml.appendChild(mk('span', null, '✉️ ' + what + ': ' + (draft.skipped_at ? '今回は送らない' : '下書きあり') +
      (who.length ? '（' + who.join('・') + '）' : '（宛先のメール未登録）')));
    const b = dBtn('確認して送る', 'btn sm inline ph-mail-open', () => openMailDraft(draft.id));
    b.dataset.draftId = draft.id;
    ml.appendChild(b);
  } else if (sent) {
    ml.appendChild(mk('span', null, '✉️ ' + what + ' ' + PhaseLogic.fmtMD(sent.sent_at) + ' 送信済み'));
  } else {
    ml.appendChild(mk('span', 'ph-sub', '✉️ ' + what + ': 下書きがありません（日時を保存し直すと作られます）'));
  }
  out.push(ml);

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
        const row = await EstimatesApi.create(s.caseId, currentCase, { phase_id: p.id, phaseTitle: phTitle(p) });
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
    out.push(box);
  });
  const b = dBtn('＋ 報告書を作る', 'ph-mkdoc ph-mk-report', btn => {
    const s = ph;
    phMsg(errId, '');
    return withBusy(btn, async () => {
      try {
        const meId = ctx && ctx.user ? ctx.user.id : null;
        const row = await ReportsApi.create(s.caseId, { work_type: PH_WORK_TYPE[p.kind], worker_id: meId, phase_id: p.id, phaseTitle: phTitle(p) });
        if (phAlive(s)) location.hash = '#report/' + row.id;
      } catch (e) { if (phAlive(s)) phMsg(errId, '報告書を作れませんでした: ' + errText(e)); }
    });
  });
  out.push(b);
  return out;
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
        const row = await NoticesApi.create(s.caseId, currentCase, { phase_id: p.id, phaseTitle: phTitle(p), data });
        if (phAlive(s)) location.hash = '#notice/' + row.id;
      } catch (e) { if (phAlive(s)) phMsg(errId, '工事掲示を作れませんでした: ' + errText(e)); }
    });
  });
  out.push(b);
  return out;
}

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
