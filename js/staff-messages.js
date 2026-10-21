// js/staff-messages.js — 現場からの連絡（Task 23。DB は staff_messages / migration 041。API は js/messages-api.js）
//   現場用: #f/contact（管理者とのやり取り。Task 29 でタブから外した＝タスクの「やり取りを見る」から）… 自分が送った連絡と返事の一覧・
//           「＋ 連絡する」（案件・対応・件名の候補・本文・写真）。ツールページ・タスクの「📨 管理者に連絡」からも同じシート
//   管理者: 案件一覧の上の「📨 現場からの連絡 n件」（#case-messages）→ #messages（案件ページの「今の状態」からは #messages/{caseId}）
//           既読にする・返事を書く（返事は宛先のスタッフの 🔔 に出る）・案件を開く
//   アプリ内だけ（メールは送らない＝Ruling）。タイムラインには DB のトリガーが残す
//   Task 27: 調査報告の提出（次の対応方針が原因元工事／再調査）で DB が自動の連絡を入れる（source = report_submit。「自動」の札）。
//   Task 28: 現場用・担当者URLの「🕒 到着が遅れそう」でも自動の連絡が入る（source = late。「自動」の札）。
//           担当者URLからの提出は送った人が空 →「担当者URL」と出す。返事の相手（社内の人）がいないやり取りには「返事を書く」を出さない
//   Task 29: 報告書の期限超過（source = overdue。送った人なし →「自動のお知らせ」）と日報（source = daily。案件なし →「📝 日報」・返事は案件なし）。
//           管理者の「📨 現場からの連絡 n件」は案件ごとの未読（case_summaries.staff_unread）＋案件の無い未読（日報）。
//           overdueSync(rows): アプリを開いたときに報告書の期限超過を管理者に知らせる（PhaseLogic.overdueReports → rpc phase_report_overdue。1回だけは DB が判定）
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。alert/confirm は使わない
// 入力のあるシートは外側クリック・Esc で閉じない（× とキャンセルだけ）
// mk() は case-list.js、dBtn / errText は case-detail.js、showScreen / renderHeaders / $ は app.js

let sm = null;   // { seq, field, caseId, root, rows, msgs, members, loading, err, msg, busy: Set, reply: rootId|null, replyErr }
let smSeq = 0;
const SM_HASH_RE = /^#messages(?:\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/i;

const smMe = () => (ctx && ctx.user ? ctx.user.id : null);
const smIsOwner = () => !!(ctx && ctx.membership && ctx.membership.role === 'owner');

/* ---------- 案件一覧の上部（管理者） ---------- */
async function refreshMessagesBanner(rows, isAlive) {
  const el = $('case-messages');
  if (!el) return;
  if (isAlive && !isAlive()) return;
  let n = smIsOwner() ? (rows || []).reduce((a, r) => a + (Number(r.staff_unread) || 0), 0) : 0;
  // Task 29: 案件の無い未読（日報）も数える
  if (smIsOwner()) {
    try { n += (await StaffMessagesApi.list({ noCase: true, unread: true })).filter(m => PhaseLogic.messageForMe(m, smMe(), true)).length; }
    catch (e) { console.warn('日報の読み込みに失敗', e); }
    if (isAlive && !isAlive()) return;
  }
  el.replaceChildren(mk('span', null, '📨 現場からの連絡 ' + n + '件'), mk('span', 'rep-sub', '見る →'));
  el.hidden = n === 0;
}

/* ---------- 報告書の期限超過（Task 29） ---------- */
// アプリを開いたとき（案件一覧・現場用の読み込み）に、期限を過ぎて未提出の報告書を管理者に知らせる。1回だけ（DB の report_overdue_at）。
// 1回の読み込みで10件まで（残りは次に開いたとき）。作った数を返す
let smOverdueRunning = false;
async function overdueSync(rows) {
  if (smOverdueRunning || typeof PhasesApi === 'undefined' || !PhasesApi.reportOverdue) return 0;
  const list = PhaseLogic.overdueReports(rows || [], new Date()).slice(0, 10);
  if (!list.length) return 0;
  smOverdueRunning = true;
  let n = 0;
  try {
    for (const x of list) {
      try {
        const r = await PhasesApi.reportOverdue(x.phase.id);
        if (r && r.ok) n += 1;
        if (r && (r.ok || r.reason === 'already')) x.phase.report_overdue_at = x.phase.report_overdue_at || new Date().toISOString();
      } catch (e) { console.warn('報告書の期限超過を知らせられませんでした', e); }
    }
  } finally { smOverdueRunning = false; }
  return n;
}

/* ---------- 画面を開く ---------- */
// 管理者: #messages（opts.caseId で案件を絞る）／現場用: openFieldContact（field-ui のタブの中）
async function openMessages(caseId) {
  renderHeaders();
  showScreen('messages');
  return smOpen({ field: false, caseId: caseId ? String(caseId).toLowerCase() : null, root: $('messages-root') });
}
async function openFieldContact(root) {
  return smOpen({ field: true, caseId: null, root });
}
async function smOpen(o) {
  const seq = ++smSeq;
  sm = { seq, field: o.field, caseId: o.caseId, root: o.root, rows: [], msgs: [], members: [], loading: true, err: '', msg: '',
    busy: new Set(), reply: null, replyErr: '' };
  smRender();
  await smLoad(seq);
}
async function smLoad(seq) {
  let rows = [], msgs = [], members = [], err = '';
  try {
    [rows, msgs, members] = await Promise.all([
      sm && sm.field && typeof fieldRows === 'function' ? fieldRows() : CasesApi.listSummaries(), // 現場用はタブ間で使い回す（60秒）
      StaffMessagesApi.list(sm && sm.caseId ? { caseId: sm.caseId } : {}),
      CasesApi.listMembers()
    ]);
  } catch (e) { err = '連絡を読み込めませんでした: ' + errText(e); }
  if (!sm || sm.seq !== seq || seq !== smSeq) return;
  Object.assign(sm, { rows: rows || [], msgs: msgs || [], members: members || [], loading: false, err });
  smRender();
}
const smAlive = s => sm === s && s.root && s.root.isConnected;

function smName(id) {
  if (!id) return '不明';
  const m = (sm.members || []).find(x => x.user_id === id);
  return m ? (m.display_name || '(名前なし)') : '不明';
}
function smCaseOf(id) { return (sm.rows || []).find(r => r.id === id) || null; }
function smPhaseTitle(c, phaseId) {
  if (!c || !phaseId) return '案件全体';
  const ch = PhaseLogic.fieldPhaseChips(c.phases, new Date()).find(x => x.id === phaseId);
  return ch ? ch.title : '案件全体';
}
// 現場用で見るやり取り: 自分が送ったか、自分あてのものがあるもの（日報は「日報作成」のタブの履歴に出すので除く）
function smThreads() {
  const me = smMe();
  const all = PhaseLogic.messageThreads(sm.msgs, me, smIsOwner() && !sm.field);
  if (!sm.field) return all;
  return all.filter(g => g.root.source !== 'daily' && [g.root].concat(g.replies).some(m => m.from_user === me || m.to_user === me));
}

/* ---------- 描画 ---------- */
function smRender() {
  const s = sm;
  if (!s || !s.root) return;
  const nodes = [];
  if (!s.field) {
    nodes.push(dBtn(s.caseId ? '← 案件ページ' : '← 案件一覧', 'back', () => {
      if (s.caseId) location.hash = '#case/' + s.caseId; else openCases();
    }));
    nodes.push(mk('h2', 'ob-h', '📨 現場からの連絡'));
    nodes.push(mk('div', 'rep-sub ob-lead', 'スタッフが現場用の画面から送った連絡・日報と、調査報告の提出・報告書の期限超過などの自動のお知らせです。読んだら「既読にする」、返事は「返事を書く」（スタッフの「タスク」に出ます。メールは送りません）'));
    if (s.caseId) {
      const c = smCaseOf(s.caseId);
      const f = mk('div', 'sm-filter');
      f.appendChild(mk('span', 'rep-sub', 'この案件だけ: ' + ((c && PhaseLogic.placeName(c)) || '（物件名なし）')));
      f.appendChild(dBtn('すべての案件を見る', 'btn sm ghost inline', () => { location.hash = '#messages'; }));
      nodes.push(f);
    }
  } else {
    nodes.push(mk('div', 'rep-sub ob-lead', '案件の管理者に連絡できます（アプリの中だけ。メールは送りません）。返事は「タスク」とこの画面に出ます'));
    const nb = dBtn('＋ 連絡する', 'btn sm-new-btn', () => smOpenSheet({ rows: s.rows, onSent: () => smAfterSend(s) }));
    nb.id = 'sm-new';
    nb.disabled = s.loading || !!s.err;
    nodes.push(nb);
  }
  const msg = mk('div', 'ob-msg', s.msg || '');
  msg.id = 'sm-msg';
  msg.setAttribute('role', 'status');
  nodes.push(msg);
  if (s.loading) nodes.push(mk('div', 'empty', '読み込み中…'));
  else if (s.err) {
    nodes.push(mk('div', 'err', s.err));
    nodes.push(dBtn('再読み込み', 'btn sm ghost inline', () => smOpen({ field: s.field, caseId: s.caseId, root: s.root })));
  } else {
    const threads = smThreads();
    if (!threads.length) {
      const e = mk('div', 'empty', s.field ? 'まだ連絡はありません' : '現場からの連絡はありません');
      e.id = 'sm-empty';
      nodes.push(e);
    } else {
      const list = mk('div', 'sm-list');
      list.id = 'sm-list';
      threads.forEach(g => list.appendChild(smThreadEl(g)));
      nodes.push(list);
    }
  }
  s.root.replaceChildren(...nodes);
}

function smMsgEl(m, isRoot) {
  const me = smMe();
  const box = mk('div', 'sm-msg' + (isRoot ? ' root' : ' reply'));
  box.dataset.msgId = m.id;
  const head = mk('div', 'sm-head');
  const auto = m.source === 'report_submit' || m.source === 'late' || m.source === 'overdue'; // 052: 到着が遅れそう・053: 報告書の期限超過も自動
  head.appendChild(mk('b', 'sm-from', m.from_user === me ? 'あなた' : m.source === 'overdue' ? '自動のお知らせ' : !m.from_user && auto ? '担当者URL' : smName(m.from_user)));
  if (auto) head.appendChild(mk('span', 'sm-auto', '自動'));
  head.appendChild(mk('span', 'sm-at', PhaseLogic.fmtMDHM(m.created_at)));
  if (PhaseLogic.messageForMe(m, me, smIsOwner() && !sm.field)) head.appendChild(mk('span', 'sm-new', '未読'));
  else if (m.from_user === me && m.read_at) head.appendChild(mk('span', 'sm-read', '既読'));
  box.appendChild(head);
  if (isRoot) box.appendChild(mk('div', 'sm-subj', m.subject));
  if (String(m.body || '').trim()) box.appendChild(mk('div', 'sm-body', m.body));
  const atts = Array.isArray(m.attachments) ? m.attachments : [];
  if (atts.length) {
    const g = mk('div', 'sm-photos');
    atts.forEach(a => {
      const im = document.createElement('img');
      im.alt = a.name || '写真';
      im.className = 'sm-photo';
      im.loading = 'lazy';
      StaffMessagesApi.photoUrl(a.path).then(u => { im.src = u; }, () => { im.alt = '写真を開けませんでした'; });
      g.appendChild(im);
    });
    box.appendChild(g);
  }
  return box;
}

function smThreadEl(g) {
  const s = sm;
  const r = g.root;
  const c = smCaseOf(r.case_id);
  const daily = !r.case_id; // Task 29: 日報（案件なし）
  const card = mk('div', 'sm-thread' + (g.unread ? ' unread' : '') + (daily ? ' daily' : '') + (r.source === 'overdue' ? ' overdue' : ''));
  card.dataset.threadId = r.id;
  card.dataset.source = r.source || 'staff';
  const top = mk('div', 'sm-top');
  top.appendChild(mk('b', 'sm-case', daily ? '📝 日報' : (c && PhaseLogic.placeName(c)) || '（案件）'));
  if (!daily) top.appendChild(mk('span', 'ob-ph', smPhaseTitle(c, r.phase_id)));
  card.appendChild(top);
  card.appendChild(smMsgEl(r, true));
  g.replies.forEach(m => card.appendChild(smMsgEl(m, false)));
  const busy = s.busy.has(r.id);
  const acts = mk('div', 'sm-acts');
  if (g.unread) {
    const rd = dBtn('既読にする', 'btn sm inline sm-read-btn', () => smMarkRead(g));
    rd.disabled = busy;
    acts.appendChild(rd);
  }
  // 返事の相手: 現場用は管理者（宛先なし）。管理者は自分以外の送った人（担当者URLだけのやり取りには相手がいない）
  const canReply = s.field || [r].concat(g.replies).some(m => m.from_user && m.from_user !== smMe());
  if (s.reply !== r.id && canReply) {
    const rp = dBtn('返事を書く', 'btn sm ghost inline sm-reply-btn', () => { s.reply = r.id; s.replyErr = ''; smRender(); smFocusReply(); });
    rp.disabled = busy || (s.reply != null);
    acts.appendChild(rp);
  }
  if (!daily) {
    const open = dBtn('案件を開く', 'btn sm ghost inline sm-open', () => {
      if (s.field) {
        if (typeof fdSel !== 'undefined' && r.phase_id) fdSel.set(r.case_id, r.phase_id);
        location.hash = '#f/case/' + r.case_id;
      } else location.hash = '#case/' + r.case_id;
    });
    acts.appendChild(open);
  }
  card.appendChild(acts);
  if (s.reply === r.id) card.appendChild(smReplyForm(g));
  const err = mk('div', 'err');
  err.id = 'sm-err-' + r.id;
  card.appendChild(err);
  return card;
}

function smFocusReply() {
  const t = sm && sm.root && sm.root.querySelector('.sm-reply-text');
  if (t) { t.scrollIntoView({ block: 'center' }); t.focus({ preventScroll: true }); }
}

function smReplyForm(g) {
  const s = sm;
  const r = g.root;
  const box = mk('div', 'ph-form sm-reply');
  const l = mk('label', null, '返事');
  const ta = document.createElement('textarea');
  ta.className = 'sm-reply-text';
  ta.rows = 3;
  ta.maxLength = StaffMessagesApi.BODY_MAX;
  ta.value = s.replyDraft && s.replyDraft.id === r.id ? s.replyDraft.text : '';
  ta.addEventListener('input', () => { s.replyDraft = { id: r.id, text: ta.value }; });
  l.appendChild(ta);
  box.appendChild(l);
  const busy = s.busy.has(r.id);
  ta.disabled = busy;
  const acts = mk('div', 'ph-acts');
  const cancel = dBtn('やめる', 'btn sm ghost inline sm-reply-cancel', () => { if (s.busy.has(r.id)) return; s.reply = null; s.replyDraft = null; s.replyErr = ''; smRender(); });
  const ok = dBtn('返事を送る', 'btn sm inline sm-reply-send', () => smSendReply(g, ta.value));
  cancel.disabled = busy; ok.disabled = busy;
  acts.append(cancel, ok);
  box.appendChild(acts);
  const e = mk('div', 'err', s.replyErr || '');
  e.setAttribute('role', 'alert');
  box.appendChild(e);
  return box;
}

/* ---------- 操作 ---------- */
async function smMarkRead(g) {
  const s = sm;
  const r = g.root;
  if (!s || s.busy.has(r.id)) return;
  s.busy.add(r.id);
  s.msg = '';
  smRender();
  let err = '';
  const me = smMe(), owner = smIsOwner() && !s.field;
  try {
    for (const m of [r].concat(g.replies)) if (PhaseLogic.messageForMe(m, me, owner)) await StaffMessagesApi.markRead(m.id);
  } catch (e) { err = '既読にできませんでした: ' + errText(e); }
  s.busy.delete(r.id);
  if (typeof fieldRowsInvalidate === 'function') fieldRowsInvalidate();
  if (!smAlive(s)) return;
  if (!err) s.msg = '「' + r.subject + '」を既読にしました';
  await smLoad(s.seq);
  if (err) { const el = document.getElementById('sm-err-' + r.id); if (el) el.textContent = err; }
}

async function smSendReply(g, text) {
  const s = sm;
  const r = g.root;
  if (!s || s.busy.has(r.id)) return;
  const body = String(text || '').trim();
  if (!body) { s.replyErr = '返事を入れてください'; smRender(); smFocusReply(); return; }
  s.busy.add(r.id);
  s.replyErr = '';
  s.msg = '';
  smRender();
  const me = smMe();
  // 宛先: 管理者からはもとの連絡を送ったスタッフ、スタッフからは管理者全員（宛先なし）
  const last = [r].concat(g.replies).filter(m => m.from_user && m.from_user !== me).pop();
  const toUser = s.field ? null : (last ? last.from_user : r.from_user);
  let err = '';
  try {
    await StaffMessagesApi.send({ caseId: r.case_id, phaseId: r.phase_id, toUser,
      subject: ('Re: ' + String(r.subject || '').replace(/^(Re:\s*)+/, '')).slice(0, StaffMessagesApi.SUBJECT_MAX), body, replyTo: r.id });
    // 返事をしたら、このやり取りの自分あての未読は既読にする
    const owner = smIsOwner() && !s.field;
    for (const m of [r].concat(g.replies)) if (PhaseLogic.messageForMe(m, me, owner)) await StaffMessagesApi.markRead(m.id);
  } catch (e) { err = '返事を送れませんでした: ' + errText(e); }
  s.busy.delete(r.id);
  if (typeof fieldRowsInvalidate === 'function') fieldRowsInvalidate();
  if (!smAlive(s)) return;
  if (err) { s.replyErr = err; smRender(); return; }
  s.reply = null;
  s.replyDraft = null;
  s.msg = '返事を送りました' + (s.field ? '（管理者の画面に出ます）' : '（スタッフの「タスク」に出ます）');
  await smLoad(s.seq);
}

function smAfterSend(s) {
  if (typeof fieldRowsInvalidate === 'function') fieldRowsInvalidate();
  if (!smAlive(s)) return;
  s.msg = '管理者に連絡しました（管理者の画面の「📨 現場からの連絡」に出ます）';
  smLoad(s.seq);
}

/* ---------- 「＋ 連絡する」のシート（現場用） ---------- */
// o: { rows: case_summaries の行, caseId, phaseId（初期選択）, onSent }
function smOpenSheet(o) {
  const prev = document.getElementById('sm-sheet');
  if (prev) prev.remove();
  const me = smMe();
  const cases = PhaseLogic.fieldCases(o.rows || [], me, new Date()).map(x => x.caseRow);
  if (o.caseId && !cases.some(c => c.id === o.caseId)) {
    const c = (o.rows || []).find(r => r.id === o.caseId);
    if (c) cases.unshift(c);
  }
  const st = { busy: false, files: [] };
  const opener = document.activeElement;
  const bg = mk('div', 'modal-bg ph-sheet-bg');
  bg.id = 'sm-sheet';
  const dlg = mk('div', 'modal ph-sheet sm-sheet');
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-labelledby', 'sm-sheet-title');
  const close = () => { if (st.busy) return; bg.remove(); if (opener && opener.isConnected) opener.focus(); };
  const hd = mk('div', 'modal-hd');
  const h = mk('h3', null, '管理者に連絡');
  h.id = 'sm-sheet-title';
  const x = mk('button', 'modal-x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', '閉じる');
  x.addEventListener('click', close);
  hd.append(h, x);
  dlg.appendChild(hd);
  dlg.appendChild(mk('div', 'rep-sub', 'アプリの中だけで届きます（メールは送りません）'));

  if (!cases.length) {
    dlg.appendChild(mk('div', 'empty', '担当の案件がありません'));
    const acts0 = mk('div', 'ph-acts');
    acts0.appendChild(dBtn('閉じる', 'btn sm ghost inline', close));
    dlg.appendChild(acts0);
    bg.appendChild(dlg);
    document.body.appendChild(bg);
    return;
  }
  // 案件
  const caseSel = document.createElement('select');
  caseSel.id = 'sm-case';
  cases.forEach(c => caseSel.appendChild(new Option(PhaseLogic.placeName(c) || '（物件名なし）', c.id)));
  caseSel.value = o.caseId && cases.some(c => c.id === o.caseId) ? o.caseId : cases[0].id;
  const lc = mk('label', 'sm-f', '案件');
  lc.appendChild(caseSel);
  dlg.appendChild(lc);
  // 対応（調査・工事。任意）
  const phSel = document.createElement('select');
  phSel.id = 'sm-phase';
  const fillPhases = want => {
    const c = cases.find(k => k.id === caseSel.value);
    phSel.replaceChildren(new Option('案件全体', ''));
    PhaseLogic.fieldPhaseChips(c ? c.phases : [], new Date()).forEach(ch => phSel.appendChild(new Option(ch.text, ch.id)));
    phSel.value = want && [...phSel.options].some(op => op.value === want) ? want : (phSel.options[1] ? phSel.options[1].value : '');
  };
  fillPhases(o.phaseId);
  caseSel.addEventListener('change', () => fillPhases(''));
  const lp = mk('label', 'sm-f', 'どの対応の分か');
  lp.appendChild(phSel);
  dlg.appendChild(lp);
  // 件名（候補のボタン＋入力）
  dlg.appendChild(mk('div', 'ph-bt-t', '件名'));
  const subj = document.createElement('input');
  subj.type = 'text';
  subj.id = 'sm-subject';
  subj.maxLength = StaffMessagesApi.SUBJECT_MAX;
  subj.autocomplete = 'off';
  subj.placeholder = '下の候補から選ぶか、入れてください';
  const chips = mk('div', 'sm-subj-chips');
  chips.id = 'sm-subject-chips';
  const syncChips = () => {
    const e0 = document.getElementById('sm-sheet-err');
    if (e0 && subj.value.trim()) e0.textContent = '';
    chips.querySelectorAll('button').forEach(b => {
      const on = b.dataset.subject === subj.value.trim();
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  };
  PhaseLogic.MESSAGE_SUBJECTS.forEach(t => {
    const b = dBtn(t, 'chip sm-subj-chip', () => { subj.value = t; syncChips(); });
    b.dataset.subject = t;
    chips.appendChild(b);
  });
  subj.addEventListener('input', syncChips);
  dlg.appendChild(chips);
  dlg.appendChild(subj);
  // 本文
  const body = document.createElement('textarea');
  body.id = 'sm-body';
  body.rows = 5;
  body.maxLength = StaffMessagesApi.BODY_MAX;
  const lb = mk('label', 'sm-f', '本文');
  lb.appendChild(body);
  dlg.appendChild(lb);
  // 写真
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/*';
  file.multiple = true;
  file.id = 'sm-file';
  file.className = 'sr-only';
  const pick = dBtn('📷 写真を添付', 'btn sm ghost inline sm-pick', () => file.click());
  const picked = mk('span', 'rep-sub sm-picked', '');
  const clear = dBtn('写真を外す', 'linkbtn sm-clear', () => { st.files = []; syncFiles(); });
  const syncFiles = () => {
    picked.textContent = st.files.length ? '写真 ' + st.files.length + '枚' : '写真なし';
    clear.hidden = !st.files.length;
  };
  file.addEventListener('change', () => {
    st.files = st.files.concat(Array.from(file.files || [])).slice(0, StaffMessagesApi.FILES_MAX);
    file.value = '';
    syncFiles();
  });
  syncFiles();
  const pr = mk('div', 'sm-filerow');
  pr.append(pick, picked, clear, file);
  dlg.appendChild(pr);

  const err = mk('div', 'err');
  err.id = 'sm-sheet-err';
  err.setAttribute('role', 'alert');
  const acts = mk('div', 'ph-acts');
  const cancel = dBtn('キャンセル', 'btn sm ghost inline sm-cancel', close);
  const send = dBtn('送る', 'btn sm inline sm-send', async () => {
    if (st.busy) return;
    const subject = subj.value.trim();
    if (!subject) { err.textContent = '件名を入れてください（候補から選べます）'; subj.focus(); return; }
    st.busy = true;
    err.textContent = '';
    [caseSel, phSel, subj, body, pick, clear, cancel, send, x].forEach(el => { el.disabled = true; });
    chips.querySelectorAll('button').forEach(b => { b.disabled = true; });
    send.textContent = '送っています…';
    let e2 = '';
    try {
      await StaffMessagesApi.send({ caseId: caseSel.value, phaseId: phSel.value || null, toUser: null, subject, body: body.value, files: st.files });
    } catch (e) { e2 = '送れませんでした: ' + errText(e); }
    st.busy = false;
    if (e2) {
      err.textContent = e2;
      [caseSel, phSel, subj, body, pick, clear, cancel, send, x].forEach(el => { el.disabled = false; });
      chips.querySelectorAll('button').forEach(b => { b.disabled = false; });
      send.textContent = '送る';
      return;
    }
    bg.remove();
    if (typeof o.onSent === 'function') o.onSent();
  });
  acts.append(cancel, send);
  dlg.appendChild(err);
  dlg.appendChild(acts);
  bg.appendChild(dlg);
  document.body.appendChild(bg);
  subj.focus();
}

(() => {
  const b = document.getElementById('case-messages');
  if (b) b.addEventListener('click', () => { location.hash = '#messages'; });
})();
