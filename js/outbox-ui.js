// js/outbox-ui.js — 送るメール（#outbox）と案件一覧の「✉️ 送るメールが n件あります」… openOutbox() / refreshOutboxBanner(rows, isAlive)
// 対応フェーズ Task 6。未送信の日程連絡（schedule）・リマインド（reminder）・送信待ちの報告書／見積書の下書きを案件ごとに出す。
// リマインドはサーバーの定期実行を使わず、案件一覧・この画面・案件詳細を開いたときに作る（PhasesApi.syncReminders）。
// 「確認して送る」→ mail-ui（⑨。戻り先はこの画面）、「今回は送らない」→ skipped_at（日程連絡・リマインド・調査結果のご報告だけ。元に戻せる）。
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。alert/confirm は使わない
// mk() は case-list.js、dBtn / errText は case-detail.js、openMailDraftFrom は mail-ui.js、showScreen / renderHeaders / setMsg / $ は app.js

let ob = null;   // { seq, rows, drafts, groups, undo: draft|null, busy: Set }
let obSeq = 0;

// 案件の一覧（case_summaries の行）→ リマインドを作ってから、未送信の下書きを読む → { drafts, errors }
async function outboxSync(rows) {
  const now = new Date();
  const entries = (rows || []).map(r => ({ caseRow: r, phases: Array.isArray(r.phases) ? r.phases : [] }));
  // 送信済み・送らないのリマインドも読むのは、これから作る可能性があるフェーズ（未完了・予定の時刻前）だけ
  const active = entries.flatMap(e => e.phases)
    .filter(p => p.scheduled_at && !p.done_at && Date.parse(p.scheduled_at) > now.getTime()).map(p => p.id);
  let drafts = await PhasesApi.listMailForOutbox(active);
  const res = await PhasesApi.syncReminders(entries, drafts, now);
  if (res.created.length || res.removed) drafts = await PhasesApi.listMailForOutbox(active);
  res.errors.forEach(m => console.warn(m));
  return { drafts, errors: res.errors };
}

// 送るメールの件数（未送信・送らないを除く。一覧にある案件の分）
function outboxCount(rows, drafts) {
  return PhaseLogic.groupOutbox(rows, drafts).reduce((a, g) => a + g.items.length, 0);
}

/* ---------- 案件一覧の上部のお知らせ ---------- */
// isAlive(): 一覧の読み込みが新しくなっていないか（古い応答は捨てる）
async function refreshOutboxBanner(rows, isAlive) {
  const el = $('case-outbox');
  if (!el) return;
  let n = 0;
  try {
    const { drafts } = await outboxSync(rows);
    n = outboxCount(rows, drafts);
  } catch (e) {
    console.warn('送るメールの確認に失敗', e);
    if (isAlive && !isAlive()) return;
    el.hidden = true;
    return;
  }
  if (isAlive && !isAlive()) return;
  el.replaceChildren(mk('span', null, '✉️ 送るメールが ' + n + '件あります'), mk('span', 'rep-sub', '確認して送る →'));
  el.hidden = n === 0;
}

/* ---------- #outbox ---------- */
// opts.field: 現場用の画面（#f/outbox。js/field-ui.js）のタブの中に出す（opts.root に描く。自分の担当の案件の分だけ・
//   戻るボタンなし・「案件を開く」は #f/case/{id}・送付メールの戻り先は #f/outbox）
async function openOutbox(opts) {
  const field = !!(opts && opts.field);
  if (!field) {
    renderHeaders();
    showScreen('outbox');
  }
  const seq = ++obSeq;
  ob = { seq, rows: [], drafts: [], groups: [], undo: null, busy: new Set(), loading: true, err: '', field, root: field ? opts.root : null, opts: opts || null };
  obRender();
  await obLoad(seq);
}

async function obLoad(seq) {
  let rows = [], drafts = [], err = '';
  try {
    rows = (await CasesApi.listSummaries()) || [];
    if (ob && ob.field) rows = rows.filter(r => PhaseLogic.fieldMine(r, ctx && ctx.user ? ctx.user.id : null));
    drafts = (await outboxSync(rows)).drafts;
  } catch (e) { err = '送るメールを読み込めませんでした: ' + errText(e); }
  if (!ob || ob.seq !== seq || seq !== obSeq) return;
  Object.assign(ob, { rows, drafts, loading: false, err });
  obRender();
}

const OB_PILL = { schedule: 'ob-p-sched', reminder: 'ob-p-rem', survey_result: 'ob-p-res', estimate: 'ob-p-doc', report: 'ob-p-doc', staff_notice: 'ob-p-rem' };

function obItemEl(it) {
  const d = it.draft;
  const row = mk('div', 'ob-item');
  row.dataset.draftId = d.id;
  row.dataset.purpose = d.purpose || (d.estimate_id ? 'estimate' : 'report');
  const top = mk('div', 'ob-top');
  top.appendChild(mk('span', 'ob-pill ' + (OB_PILL[row.dataset.purpose] || 'ob-p-doc'), it.label));
  if (it.title) top.appendChild(mk('span', 'ob-ph', it.title));
  row.appendChild(top);
  row.appendChild(mk('div', 'ob-subj', d.subject || '（件名なし）'));
  const info = [];
  if (it.phase && it.phase.scheduled_at && (d.purpose === 'schedule' || d.purpose === 'reminder' || d.purpose === 'staff_notice')) {
    info.push((it.phase.kind === 'survey' ? '調査日時 ' : '工事日 ') + PhaseLogic.fmtRange(it.phase.scheduled_at, it.phase.scheduled_end));
  }
  const who = PhaseLogic.recipientsLabel(d.recipients, it.caseRow);
  info.push('宛先: ' + (who || d.to_email || '未選択'));
  row.appendChild(mk('div', 'rep-sub', info.join(' ・ ')));
  const acts = mk('div', 'ob-acts');
  const busy = ob.busy.has(d.id);
  const open = dBtn('確認して送る', 'btn sm inline ob-open', () => openMailDraftFrom(d.id, ob.field ? '#f/outbox' : '#outbox'));
  open.disabled = busy;
  acts.appendChild(open);
  if (it.canSkip) {
    const skip = dBtn('今回は送らない', 'btn sm ghost inline ob-skip', () => obSkip(d, true));
    skip.disabled = busy;
    acts.appendChild(skip);
  }
  row.appendChild(acts);
  const err = mk('div', 'err');
  err.id = 'ob-err-' + d.id;
  row.appendChild(err);
  return row;
}

function obRender() {
  const root = ob && ob.field ? ob.root : $('outbox-root');
  if (!root || !ob) return;
  const nodes = ob.field ? [] : [dBtn('← 案件一覧', 'back', () => openCases())];
  if (!ob.field) nodes.push(mk('h2', 'ob-h', '✉️ 送るメール'));
  nodes.push(mk('div', 'rep-sub ob-lead', 'まだ送っていない連絡メール・リマインド・報告書や見積書の送付です。「確認して送る」で中身と宛先を確かめてから送ってください'));
  const msg = mk('div', 'ob-msg');
  msg.id = 'outbox-msg';
  msg.setAttribute('role', 'status');
  if (ob.undo) {
    msg.appendChild(mk('span', null, '「' + PhaseLogic.mailLabel(ob.undo.draft, ob.undo.phase) + '」を今回は送らないにしました'));
    const u = dBtn('元に戻す', 'linkbtn ob-undo', () => obSkip(ob.undo.draft, false));
    u.disabled = ob.busy.has(ob.undo.draft.id);
    msg.appendChild(u);
  }
  nodes.push(msg);
  if (ob.loading) nodes.push(mk('div', 'empty', '読み込み中…'));
  else if (ob.err) {
    nodes.push(mk('div', 'err', ob.err));
    nodes.push(dBtn('再読み込み', 'btn sm ghost inline', () => openOutbox(ob.opts)));
  } else {
    const groups = PhaseLogic.groupOutbox(ob.rows, ob.drafts);
    if (!groups.length) {
      const e = mk('div', 'empty', '送るメールはありません');
      e.id = 'outbox-empty';
      nodes.push(e);
    }
    groups.forEach(g => {
      const card = mk('div', 'rep-card ob-case');
      card.dataset.caseId = g.caseRow.id;
      const hd = mk('div', 'ob-case-h');
      hd.appendChild(mk('b', null, g.caseRow.name || '（物件名なし）'));
      hd.appendChild(dBtn('案件を開く', 'linkbtn', () => { location.hash = (ob.field ? '#f/case/' : '#case/') + g.caseRow.id; }));
      card.appendChild(hd);
      g.items.forEach(it => card.appendChild(obItemEl(it)));
      nodes.push(card);
    });
  }
  root.replaceChildren(...nodes);
}

// 今回は送らない（skip=true）／元に戻す（skip=false）
async function obSkip(draft, skip) {
  const s = ob;
  if (!s || s.busy.has(draft.id)) return;
  s.busy.add(draft.id);
  obRender();
  let row = null, err = '';
  try { row = await PhasesApi.skipMail(draft, skip); }
  catch (e) { err = (skip ? '「今回は送らない」にできませんでした: ' : '元に戻せませんでした: ') + errText(e); }
  if (ob !== s) return;
  s.busy.delete(draft.id);
  if (row) {
    s.drafts = s.drafts.map(d => (d.id === row.id ? row : d));
    const c = s.rows.find(r => r.id === row.case_id);
    const phase = c ? (c.phases || []).find(p => p.id === row.phase_id) || null : null;
    s.undo = skip ? { draft: row, phase } : null;
  }
  obRender();
  if (err) {
    const el = document.getElementById('ob-err-' + draft.id) || $('outbox-msg');
    if (el) el.textContent = err;
  }
}

function bindOutbox() {
  const b = $('case-outbox');
  if (b) b.addEventListener('click', () => { location.hash = '#outbox'; });
}
