// js/staff-inbox.js — 作業担当者の「🔔 確認してください」（対応フェーズ Task 6b）… refreshStaffBanner(rows, isAlive) / openStaffInbox()
// 案件一覧の上に「🔔 確認してください n件」（自分が作業担当者で、知らせてもらって未確認のもの ＋ 自分の明日の予定）→ #inbox-staff の一覧
// （詳しく見る = フェーズ詳細ページ #case/{id}/phase/{phaseId}／確認した = PhasesApi.ack）。現場担当への指示（Task 9）があれば要約を出す。
// 一覧の中身は PhaseLogic.staffInbox（日本時間で「明日」を判定）。
// Task 29: 現場用の「タスク」タブ（#f/tasks）もここで描く（opts.field）。並び = ① 管理者からの連絡（催促・返事・日報への返事）→
//   ② 報告書の作成・提出（期限超過が先・赤「期限超過」）→ ③ 見積書の作成（期限順）→ ④ 確認依頼 → ⑤ 明日の予定。
//   Task 33 追加: 各行は4項目だけ（物件名 号室／フェーズ／やること／期限。PhaseLogic.fieldTaskRow）の行全体ボタン（右端「›」）。押すと続き
//   （見積を作る・報告書を書く・ツールページ・連絡は既読にしてやり取り）。0件は「今やることはありません」。
//   上に1行の小さなボタン「📨 管理者に連絡」（シート）と「やり取りを見る」（#f/contact）。説明の段落は無い。管理画面の #inbox-staff は今まで通り
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。alert/confirm は使わない
// mk() は case-list.js、dBtn / errText は case-detail.js、showScreen / renderHeaders / $ は app.js

let si = null;   // { seq, rows, loading, err, msg, busy: Set }
let siSeq = 0;

const siMyId = () => (ctx && ctx.user ? ctx.user.id : null);

/* ---------- 案件一覧の上部のお知らせ ---------- */
async function refreshStaffBanner(rows, isAlive) {
  const el = $('case-staff');
  if (!el) return;
  if (isAlive && !isAlive()) return;
  let msgs = [];
  try { msgs = await siLoadMessages(rows); } catch (e) { console.warn('連絡の読み込みに失敗', e); }
  if (isAlive && !isAlive()) return;
  const n = PhaseLogic.staffInbox(rows || [], siMyId(), new Date(), { messages: msgs }).length;
  el.replaceChildren(mk('span', null, '🔔 確認してください ' + n + '件'), mk('span', 'rep-sub', '見る →'));
  el.hidden = n === 0;
}

/* ---------- #inbox-staff ---------- */
// opts.field: 現場用の画面（#f/inbox。js/field-ui.js）のタブの中に出す（opts.root に描く。戻るボタンなし・「案件を開く」は #f/case/{id}）
async function openStaffInbox(opts) {
  const field = !!(opts && opts.field);
  if (!field) {
    renderHeaders();
    showScreen('inbox-staff');
  }
  const seq = ++siSeq;
  si = { seq, rows: [], loading: true, err: '', msg: '', busy: new Set(), field, root: field ? opts.root : null, opts: opts || null };
  siRender();
  await siLoad(seq);
}

// 自分あての未読の連絡（管理者からの返事・催促。Task 23）。Task 29: 日報への返事（案件なし）もあるので、いつも読む
async function siLoadMessages(rows) {
  if (typeof StaffMessagesApi === 'undefined') return [];
  return (await StaffMessagesApi.list({ toUser: siMyId(), unread: true })) || [];
}

async function siLoad(seq) {
  let rows = [], msgs = [], err = '';
  try {
    // 現場用ではタブ間で集計を使い回す（60秒。field-ui.js の fieldRows）
    rows = si && si.field && typeof fieldRows === 'function' ? await fieldRows() : (await CasesApi.listSummaries()) || [];
    msgs = await siLoadMessages(rows);
  } catch (e) { err = '読み込めませんでした: ' + errText(e); }
  if (!si || si.seq !== seq || seq !== siSeq) return;
  Object.assign(si, { rows, msgs, loading: false, err });
  siRender();
  // Task 29: 報告書の期限超過を管理者に知らせる（現場用。自分の担当の案件の分）
  if (!err && si.field && typeof overdueSync === 'function') {
    try {
      if (await overdueSync(rows.filter(r => PhaseLogic.fieldMine(r, siMyId()))) && typeof fieldRowsInvalidate === 'function') fieldRowsInvalidate();
    } catch (e) { console.warn('期限超過の確認に失敗', e); }
  }
}

// 管理者からの返事（Task 23）: 件名・本文の頭・「読んだ」「連絡を開く」
function siMessageEl(it) {
  const m = it.message;
  const row = mk('div', 'si-item message' + (it.nudge ? ' nudge' : ''));
  row.dataset.type = 'message';
  row.dataset.msgId = m.id;
  const top = mk('div', 'si-top');
  top.appendChild(mk('span', 'si-reply-tag', it.nudge ? '催促' : '管理者から')); // Task 28: 管理者からの催促（source = nudge）
  if (it.phase) top.appendChild(mk('span', 'ph-kind k-' + it.phase.kind, PhaseLogic.kindLabel(it.phase.kind)));
  top.appendChild(mk('b', 'si-case', it.caseRow ? PhaseLogic.placeName(it.caseRow) || '（物件名なし）' : '📝 日報'));
  top.appendChild(mk('span', 'ob-ph', it.title));
  row.appendChild(top);
  row.appendChild(mk('div', 'si-label', it.label));
  const body = String(m.body || '').trim();
  if (body) row.appendChild(mk('div', 'rep-sub si-msg-body', body.length > 80 ? body.slice(0, 80) + '…' : body));
  row.appendChild(mk('div', 'rep-sub', PhaseLogic.fmtMDHM(m.created_at)));
  const key = 'msg-' + m.id;
  const busy = si.busy.has(key);
  const acts = mk('div', 'si-acts');
  const rd = dBtn('読んだ', 'btn sm inline si-msg-read', () => siReadMessage(it));
  rd.disabled = busy;
  // 開く: 現場用は案件のツールページ（日報への返事は日報作成のタブ）。管理画面はその案件の連絡
  const op = dBtn(si.field ? '開く' : '連絡を開く', 'btn sm ghost inline si-msg-open', () => {
    if (!si.field) { location.hash = it.caseRow ? '#messages/' + it.caseRow.id : '#messages'; return; }
    if (!it.caseRow) { location.hash = '#f/daily'; return; }
    // Task 31: 対応のある連絡はその対応のツールページ（無ければ直近の対応へ振り向ける）
    location.hash = '#f/case/' + it.caseRow.id + (it.phase ? '/phase/' + it.phase.id : '');
  });
  op.disabled = busy;
  acts.append(rd, op);
  row.appendChild(acts);
  const err = mk('div', 'err');
  err.id = 'si-err-' + key;
  row.appendChild(err);
  return row;
}

async function siReadMessage(it) {
  const s = si;
  const key = 'msg-' + it.message.id;
  if (!s || s.busy.has(key)) return;
  s.busy.add(key);
  s.msg = '';
  siRender();
  let err = '';
  try { await StaffMessagesApi.markRead(it.message.id); }
  catch (e) { err = '既読にできませんでした: ' + errText(e); }
  s.busy.delete(key);
  if (si !== s) return;
  if (typeof fieldRowsInvalidate === 'function') fieldRowsInvalidate();
  if (!err) { s.msg = '「' + it.message.subject + '」を読んだにしました'; await siLoad(s.seq); return; }
  siRender();
  const el = document.getElementById('si-err-' + key);
  if (el) el.textContent = err;
}

// Task 33 追加: 現場用の「タスク」タブの1行（4項目だけ: 物件名 号室／フェーズ／やること／期限。PhaseLogic.fieldTaskRow）。
//   行全体がボタン。押すとそのタスクの続き（siFieldOpen）。右端に「›」。説明文・今回行く部屋・依頼内容・指示の要約・個別のボタンは出さない
function siFieldItemEl(it) {
  const r = PhaseLogic.fieldTaskRow(it);
  const p = it.phase;
  const key = siKey(it);
  const dueItem = it.type === 'estimate' || it.type === 'report';
  const row = dBtn('', 'si-item si-frow' + (dueItem ? ' estimate' : '') + (it.type === 'report' ? ' report' : '') + (it.type === 'message' ? ' message' : '')
    + (it.nudge ? ' nudge' : '') + (r.late ? ' late' : ''), () => siFieldOpen(it));
  row.dataset.type = it.type;
  if (p) row.dataset.phaseId = p.id;
  if (it.message) row.dataset.msgId = it.message.id;
  row.disabled = si.busy.has(key);
  const main = mk('span', 'si-fmain');
  main.appendChild(mk('b', 'si-case', r.place));
  const sub = mk('span', 'si-fsub');
  if (r.kind) sub.appendChild(mk('span', 'ph-kind k-' + r.kind, r.kindText));
  sub.appendChild(mk('span', 'si-todo', r.todo));
  if (r.due) sub.appendChild(mk('span', 'si-due' + (r.late ? ' late' : ''), r.due));
  main.appendChild(sub);
  row.appendChild(main);
  row.appendChild(mk('span', 'si-chev', '›'));
  row.setAttribute('aria-label', [r.place, r.kindText, r.todo, r.due].filter(Boolean).join(' '));
  return row;
}
const siKey = it => (it.type === 'message' ? 'msg-' + it.message.id : it.type === 'estimate' ? 'est-' + it.phase.id : it.type === 'report' ? 'rep-' + it.phase.id : it.phase.id);
// 行を押した → そのタスクの続き（今までの「その場で進めるボタン」と同じ行き先）
//   見積書作成 → 見積の作成／続き、報告書作成 → 報告書の作成／続き、確認依頼・翌日の予定 → その対応のツールページ（「確認した」は依頼内容の一番下）、
//   管理者からの返事・催促 → 既読にして、やり取り（#f/contact。日報への返事は日報作成のタブ）
async function siFieldOpen(it) {
  if (it.type === 'estimate') return siMakeEstimate(it);
  if (it.type === 'report') return siMakeReport(it);
  if (it.type === 'message') return siOpenMessage(it);
  location.hash = '#f/case/' + it.caseRow.id + '/phase/' + it.phase.id;
}
async function siOpenMessage(it) {
  const s = si;
  const key = 'msg-' + it.message.id;
  if (!s || s.busy.has(key)) return;
  s.busy.add(key);
  s.msg = '';
  siRender();
  let err = '';
  try { await StaffMessagesApi.markRead(it.message.id); }
  catch (e) { err = '既読にできませんでした: ' + errText(e); }
  s.busy.delete(key);
  if (si !== s) return;
  if (typeof fieldRowsInvalidate === 'function') fieldRowsInvalidate();
  if (!err) { location.hash = it.caseRow ? '#f/contact' : '#f/daily'; return; }
  s.msg = err;
  siRender();
}

function siItemEl(it) {
  if (si.field) return siFieldItemEl(it);
  if (it.type === 'message') return siMessageEl(it);
  const p = it.phase;
  const dueItem = it.type === 'estimate' || it.type === 'report'; // 期限のある行（Task 23。過ぎたら赤）
  const row = mk('div', 'si-item' + (it.type === 'tomorrow' ? ' tomorrow' : '') + (dueItem ? ' estimate' + (it.late ? ' late' : '') : '') + (it.type === 'report' ? ' report' : ''));
  row.dataset.phaseId = p.id;
  row.dataset.type = it.type;
  const top = mk('div', 'si-top');
  top.appendChild(mk('span', 'ph-kind k-' + p.kind, PhaseLogic.kindLabel(p.kind)));
  top.appendChild(mk('b', 'si-case', PhaseLogic.placeName(it.caseRow) || '（物件名なし）'));
  top.appendChild(mk('span', 'ob-ph', it.title));
  row.appendChild(top);
  const lb = mk('div', 'si-label', (it.type === 'tomorrow' ? '⏰ ' : it.type === 'estimate' ? '🧾 ' : it.type === 'report' ? '📋 ' : '') + it.label);
  if (dueItem && it.late) lb.appendChild(mk('span', 'si-late', '期限超過')); // Task 29: 過ぎたら赤の「期限超過」
  row.appendChild(lb);
  if (it.type === 'notice') {
    row.appendChild(mk('div', 'rep-sub', [it.from ? it.from + 'さんから' : '', PhaseLogic.fmtMDHM(it.fromAt)].filter(Boolean).join(' ') +
      (it.tomorrow ? ' ・ 前日のお知らせ' : '')));
  } else if (it.type === 'estimate') {
    row.appendChild(mk('div', 'rep-sub', '調査報告の「次の対応方針」で決まった期限です。見積書を提出するまで残ります'));
  } else if (it.type === 'report') {
    row.appendChild(mk('div', 'rep-sub', (p.kind === 'survey' ? '作業が終わってから1時間以内が期限です（作業終了時間が無ければ、調査日時の3時間後を作業の終わりとみなします）'
      : '工事日の翌日が期限です') + '。報告書を提出するまで残ります' + (it.late ? '（管理者にも知らせています）' : '')));
  } else if (it.caseRow.address) {
    row.appendChild(mk('div', 'rep-sub', '📍 ' + it.caseRow.address));
  }
  if (it.visit) row.appendChild(mk('div', 'si-visit', '🚪 ' + it.visit)); // Task 31: 今回行く部屋
  if (it.request) row.appendChild(mk('div', 'si-req', '■ 依頼内容: ' + it.request)); // Task 28: 案件の依頼内容の要約（指示の前）
  if (it.brief) row.appendChild(mk('div', 'si-brief', '📝 指示: ' + it.brief)); // 現場担当への指示の要約（Task 9）
  const acts = mk('div', 'si-acts');
  const bkey = it.type === 'estimate' ? 'est-' + p.id : it.type === 'report' ? 'rep-' + p.id : p.id;
  const busy = si.busy.has(bkey);
  const open = si.field
    ? dBtn('開く', 'btn sm ghost inline si-open', () => {
      location.hash = '#f/case/' + it.caseRow.id + '/phase/' + p.id; // Task 31: その対応のツールページ
    })
    : dBtn('詳しく見る', 'btn sm inline si-open', () => { location.hash = '#case/' + it.caseRow.id + '/phase/' + p.id; });
  open.disabled = busy;
  acts.appendChild(open);
  if (it.type === 'estimate') {
    // Task 21: 見積を作る（phase_id 付き）→ 見積書の画面へ。下書きがあれば続きを開く（Task 23: 提出するまで残る）
    const mkb = dBtn(siEstDraft(it) ? '見積の続きを書く' : '見積を作る', 'btn sm inline si-make-est', () => siMakeEstimate(it));
    mkb.disabled = busy;
    acts.insertBefore(mkb, open);
  }
  if (it.type === 'report') {
    // Task 23: 報告書を書く（下書きがあれば続き。無ければこのフェーズで作る。作業担当者 = このフェーズの作業担当者）
    const rd = siRepDraft(it);
    const rb = dBtn(rd ? '報告書の続きを書く' : '報告書を書く', 'btn sm inline si-make-rep', () => siMakeReport(it));
    rb.disabled = busy;
    acts.insertBefore(rb, open);
  }
  if (it.type === 'notice') {
    const ack = dBtn('確認した', 'btn sm ghost inline si-ack', () => siAck(it));
    ack.disabled = busy;
    acts.appendChild(ack);
  }
  row.appendChild(acts);
  const err = mk('div', 'err');
  err.id = 'si-err-' + bkey;
  row.appendChild(err);
  return row;
}

function siRender() {
  const root = si && si.field ? si.root : $('staff-inbox-root');
  if (!root || !si) return;
  const nodes = si.field ? [] : [dBtn('← 案件一覧', 'back', () => openCases())];
  if (!si.field) nodes.push(mk('h2', 'ob-h', '🔔 確認してください'));
  // Task 33 追加: 現場用は説明の段落を出さない（並び: ① 管理者からの連絡 → ② 報告書 → ③ 見積書 → ④ 確認依頼 → ⑤ 翌日の予定。超過は赤）
  if (!si.field) nodes.push(mk('div', 'rep-sub ob-lead', 'あなたが作業担当者の予定です。内容を確かめたら「確認した」を押してください（頼んだ人の画面に「確認済み」と出ます）。翌日の予定と、期限のある見積書・報告書（提出するまで）、管理者からの返事もここに出ます'));
  if (si.field) {
    // 管理者に連絡（Task 29: タブから外したので、ここから）。Task 33 追加: 1行の小さなボタン2つ
    const bar = mk('div', 'si-contact');
    const nb = dBtn('📨 管理者に連絡', 'btn sm inline si-contact-new', () => smOpenSheet({ rows: si.rows, onSent: () => {
      if (si && si.field) { si.msg = '管理者に連絡しました（返事はこのタスクに出ます）'; siRender(); }
    } }));
    nb.id = 'si-contact-new';
    nb.disabled = si.loading || !!si.err;
    const hb = dBtn('やり取りを見る ›', 'btn sm ghost inline si-contact-list', () => { location.hash = '#f/contact'; });
    hb.id = 'si-contact-list';
    bar.append(nb, hb);
    nodes.push(bar);
  }
  const msg = mk('div', 'ob-msg', si.msg || '');
  msg.id = 'staff-inbox-msg';
  msg.setAttribute('role', 'status');
  nodes.push(msg);
  if (si.loading) nodes.push(mk('div', 'empty', '読み込み中…'));
  else if (si.err) {
    nodes.push(mk('div', 'err', si.err));
    nodes.push(dBtn('再読み込み', 'btn sm ghost inline', () => openStaffInbox(si.opts)));
  } else {
    const items = PhaseLogic.staffInbox(si.rows, siMyId(), new Date(), { messages: si.msgs });
    if (!items.length) {
      const e = mk('div', 'empty', si.field ? '今やることはありません' : '確認することはありません');
      e.id = 'staff-inbox-empty';
      nodes.push(e);
    } else {
      const card = mk('div', si.field ? 'si-flist' : 'rep-card');
      card.id = 'staff-inbox-list';
      items.forEach(it => card.appendChild(siItemEl(it)));
      nodes.push(card);
    }
  }
  root.replaceChildren(...nodes);
}

async function siAck(it) {
  const s = si;
  if (!s || s.busy.has(it.phase.id)) return;
  s.busy.add(it.phase.id);
  s.msg = '';
  siRender();
  let err = '';
  try {
    await PhasesApi.ack(Object.assign({ case_id: it.caseRow.id }, it.phase), it.title);
    s.msg = PhaseLogic.placeName(it.caseRow) + ' の' + it.title + 'を「確認した」にしました';
  } catch (e) { err = '「確認した」にできませんでした: ' + errText(e); }
  s.busy.delete(it.phase.id);
  if (si !== s) return;
  if (typeof fieldRowsInvalidate === 'function') fieldRowsInvalidate();
  if (!err) await siLoad(s.seq);
  else siRender();
  if (err) {
    const el = document.getElementById('si-err-' + it.phase.id) || $('staff-inbox-msg');
    if (el) el.textContent = err;
  }
}

// このフェーズの見積の下書き（取り消し済みでない最新）・報告書の下書き（case_summaries の phases[] の中身）
function siEstDraft(it) {
  const list = (it.phase.estimates || []).filter(e => e.status === 'draft' && e.id);
  return list[list.length - 1] || null;
}
function siRepDraft(it) {
  const list = (it.phase.reports || []).filter(r => r.status === 'draft' && r.id && !r.share_active);
  return list[list.length - 1] || null;
}

// 報告書を書く（Task 23）: 下書きがあれば開く。無ければこのフェーズで作って報告書の画面へ（作業担当者 = フェーズの作業担当者・無ければ自分）
async function siMakeReport(it) {
  const s = si;
  const key = 'rep-' + it.phase.id;
  if (!s || s.busy.has(key)) return;
  const d = siRepDraft(it);
  if (s.field && typeof fdSel !== 'undefined') fdSel.set(it.caseRow.id, it.phase.id);
  if (d) { location.hash = '#report/' + d.id; return; }
  s.busy.add(key);
  s.msg = '';
  siRender();
  let err = '', row = null;
  try {
    const c = it.caseRow, p = it.phase;
    row = await ReportsApi.create(c.id, PhaseLogic.reportFields(p, c, { meId: siMyId(), title: it.title }));
  } catch (e) { err = '報告書を作れませんでした: ' + errText(e); }
  s.busy.delete(key);
  if (si !== s) return;
  if (row) { location.hash = '#report/' + row.id; return; }
  siRender();
  const el = document.getElementById('si-err-' + key) || $('staff-inbox-msg');
  if (el) el.textContent = err;
}

// フェーズの見積を作る（phase_id 付き。工事なら調査結果の注意事項を備考に）→ 作った見積の行。🔔 と現場用トップのカード（Task 27）で共通
async function makePhaseEstimate(c, p, title) {
  const opts = { phase_id: p.id, phaseTitle: title };
  if (p.kind !== 'survey') {
    const r = PhaseLogic.latestSurveyResult(c.phases);
    if (r) opts.noteExtra = PhaseLogic.estimateNoteExtra(r);
  }
  return EstimatesApi.create(c.id, c, opts);
}

// 見積書を作る（Task 21）: そのフェーズの見積を作って見積書の画面へ（やること・現場用ツールの「見積を作る」と同じ初期値）
async function siMakeEstimate(it) {
  const s = si;
  const key = 'est-' + it.phase.id;
  if (!s || s.busy.has(key)) return;
  const d = siEstDraft(it);
  if (d) {
    if (s.field && typeof fdSel !== 'undefined') fdSel.set(it.caseRow.id, it.phase.id);
    location.hash = '#estimate/' + d.id;
    return;
  }
  s.busy.add(key);
  s.msg = '';
  siRender();
  let err = '', row = null;
  try { row = await makePhaseEstimate(it.caseRow, it.phase, it.title); }
  catch (e) { err = '見積書を作れませんでした: ' + errText(e); }
  s.busy.delete(key);
  if (si !== s) return;
  if (row) {
    if (s.field && typeof fdSel !== 'undefined') fdSel.set(it.caseRow.id, it.phase.id);
    location.hash = '#estimate/' + row.id;
    return;
  }
  siRender();
  const el = document.getElementById('si-err-' + key) || $('staff-inbox-msg');
  if (el) el.textContent = err;
}

(() => {
  const b = document.getElementById('case-staff');
  if (b) b.addEventListener('click', () => { location.hash = '#inbox-staff'; });
})();
