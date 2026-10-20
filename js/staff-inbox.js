// js/staff-inbox.js — 作業担当者の「🔔 確認してください」（対応フェーズ Task 6b）… refreshStaffBanner(rows, isAlive) / openStaffInbox()
// 案件一覧の上に「🔔 確認してください n件」（自分が作業担当者で、知らせてもらって未確認のもの ＋ 自分の明日の予定）→ #inbox-staff の一覧
// （詳しく見る = フェーズ詳細ページ #case/{id}/phase/{phaseId}／確認した = PhasesApi.ack）。現場担当への指示（Task 9）があれば要約を出す。
// 一覧の中身は PhaseLogic.staffInbox（日本時間で「明日」を判定）。
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。alert/confirm は使わない
// mk() は case-list.js、dBtn / errText は case-detail.js、showScreen / renderHeaders / $ は app.js

let si = null;   // { seq, rows, loading, err, msg, busy: Set }
let siSeq = 0;

const siMyId = () => (ctx && ctx.user ? ctx.user.id : null);

/* ---------- 案件一覧の上部のお知らせ ---------- */
function refreshStaffBanner(rows, isAlive) {
  const el = $('case-staff');
  if (!el) return;
  if (isAlive && !isAlive()) return;
  const n = PhaseLogic.staffInbox(rows || [], siMyId(), new Date()).length;
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

async function siLoad(seq) {
  let rows = [], err = '';
  try { rows = (await CasesApi.listSummaries()) || []; }
  catch (e) { err = '読み込めませんでした: ' + errText(e); }
  if (!si || si.seq !== seq || seq !== siSeq) return;
  Object.assign(si, { rows, loading: false, err });
  siRender();
}

function siItemEl(it) {
  const p = it.phase;
  const row = mk('div', 'si-item' + (it.type === 'tomorrow' ? ' tomorrow' : '') + (it.type === 'estimate' ? ' estimate' + (it.late ? ' late' : '') : ''));
  row.dataset.phaseId = p.id;
  row.dataset.type = it.type;
  const top = mk('div', 'si-top');
  top.appendChild(mk('span', 'ph-kind k-' + p.kind, PhaseLogic.kindLabel(p.kind)));
  top.appendChild(mk('b', 'si-case', PhaseLogic.placeName(it.caseRow) || '（物件名なし）'));
  top.appendChild(mk('span', 'ob-ph', it.title));
  row.appendChild(top);
  row.appendChild(mk('div', 'si-label', (it.type === 'tomorrow' ? '⏰ ' : it.type === 'estimate' ? '🧾 ' : '') + it.label +
    (it.type === 'estimate' && it.late ? '（期限を過ぎています）' : '')));
  if (it.type === 'notice') {
    row.appendChild(mk('div', 'rep-sub', [it.from ? it.from + 'さんから' : '', PhaseLogic.fmtMDHM(it.fromAt)].filter(Boolean).join(' ') +
      (it.tomorrow ? ' ・ 明日の予定です' : '')));
  } else if (it.type === 'estimate') {
    row.appendChild(mk('div', 'rep-sub', '調査報告の「次の対応方針」で決まった期限です'));
  } else if (it.caseRow.address) {
    row.appendChild(mk('div', 'rep-sub', '📍 ' + it.caseRow.address));
  }
  if (it.brief) row.appendChild(mk('div', 'si-brief', '📝 指示: ' + it.brief)); // 現場担当への指示の要約（Task 9）
  const acts = mk('div', 'si-acts');
  const bkey = it.type === 'estimate' ? 'est-' + p.id : p.id;
  const busy = si.busy.has(bkey);
  const open = si.field
    ? dBtn('案件を開く', 'btn sm inline si-open', () => {
      if (typeof fdSel !== 'undefined') fdSel.set(it.caseRow.id, p.id); // その対応を選んでツールページを開く
      location.hash = '#f/case/' + it.caseRow.id;
    })
    : dBtn('詳しく見る', 'btn sm inline si-open', () => { location.hash = '#case/' + it.caseRow.id + '/phase/' + p.id; });
  open.disabled = busy;
  acts.appendChild(open);
  if (it.type === 'estimate') {
    // Task 21: 見積を作る（phase_id 付き）→ 見積書の画面へ
    const mkb = dBtn('見積を作る', 'btn sm inline si-make-est', () => siMakeEstimate(it));
    mkb.disabled = busy;
    acts.insertBefore(mkb, open);
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
  nodes.push(mk('div', 'rep-sub ob-lead', 'あなたが作業担当者の予定です。内容を確かめたら「確認した」を押してください（頼んだ人の画面に「確認済み」と出ます）。明日の予定と、期限のある見積書もここに出ます'));
  const msg = mk('div', 'ob-msg', si.msg || '');
  msg.id = 'staff-inbox-msg';
  msg.setAttribute('role', 'status');
  nodes.push(msg);
  if (si.loading) nodes.push(mk('div', 'empty', '読み込み中…'));
  else if (si.err) {
    nodes.push(mk('div', 'err', si.err));
    nodes.push(dBtn('再読み込み', 'btn sm ghost inline', () => openStaffInbox(si.opts)));
  } else {
    const items = PhaseLogic.staffInbox(si.rows, siMyId(), new Date());
    if (!items.length) {
      const e = mk('div', 'empty', '確認することはありません');
      e.id = 'staff-inbox-empty';
      nodes.push(e);
    } else {
      const card = mk('div', 'rep-card');
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
  if (!err) await siLoad(s.seq);
  else siRender();
  if (err) {
    const el = document.getElementById('si-err-' + it.phase.id) || $('staff-inbox-msg');
    if (el) el.textContent = err;
  }
}

// 見積書を作る（Task 21）: そのフェーズの見積を作って見積書の画面へ（やること・現場用ツールの「見積を作る」と同じ初期値）
async function siMakeEstimate(it) {
  const s = si;
  const key = 'est-' + it.phase.id;
  if (!s || s.busy.has(key)) return;
  s.busy.add(key);
  s.msg = '';
  siRender();
  let err = '', row = null;
  try {
    const c = it.caseRow, p = it.phase;
    const opts = { phase_id: p.id, phaseTitle: it.title };
    if (p.kind !== 'survey') {
      const r = PhaseLogic.latestSurveyResult(c.phases);
      if (r) opts.noteExtra = PhaseLogic.estimateNoteExtra(r);
    }
    row = await EstimatesApi.create(c.id, c, opts);
  } catch (e) { err = '見積書を作れませんでした: ' + errText(e); }
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
