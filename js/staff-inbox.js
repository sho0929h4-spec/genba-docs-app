// js/staff-inbox.js — 作業担当者の「🔔 確認してください」（対応フェーズ Task 6b）… refreshStaffBanner(rows, isAlive) / openStaffInbox()
// 案件一覧の上に「🔔 確認してください n件」（自分が作業担当者で、知らせてもらって未確認のもの ＋ 自分の明日の予定）→ #inbox-staff の一覧
// （カードを開く = #case/{id}/phase/{phaseId} でそのカードまでスクロールして強調／確認した = PhasesApi.ack）。
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
async function openStaffInbox() {
  renderHeaders();
  showScreen('inbox-staff');
  const seq = ++siSeq;
  si = { seq, rows: [], loading: true, err: '', msg: '', busy: new Set() };
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
  const row = mk('div', 'si-item' + (it.type === 'tomorrow' ? ' tomorrow' : ''));
  row.dataset.phaseId = p.id;
  row.dataset.type = it.type;
  const top = mk('div', 'si-top');
  top.appendChild(mk('span', 'ph-kind k-' + p.kind, PhaseLogic.kindLabel(p.kind)));
  top.appendChild(mk('b', 'si-case', PhaseLogic.placeName(it.caseRow) || '（物件名なし）'));
  top.appendChild(mk('span', 'ob-ph', it.title));
  row.appendChild(top);
  row.appendChild(mk('div', 'si-label', (it.type === 'tomorrow' ? '⏰ ' : '') + it.label));
  if (it.type === 'notice') {
    row.appendChild(mk('div', 'rep-sub', [it.from ? it.from + 'さんから' : '', PhaseLogic.fmtMDHM(it.fromAt)].filter(Boolean).join(' ') +
      (it.tomorrow ? ' ・ 明日の予定です' : '')));
  } else if (it.caseRow.address) {
    row.appendChild(mk('div', 'rep-sub', '📍 ' + it.caseRow.address));
  }
  const acts = mk('div', 'si-acts');
  const busy = si.busy.has(p.id);
  const open = dBtn('カードを開く', 'btn sm inline si-open', () => { location.hash = '#case/' + it.caseRow.id + '/phase/' + p.id; });
  open.disabled = busy;
  acts.appendChild(open);
  if (it.type === 'notice') {
    const ack = dBtn('確認した', 'btn sm ghost inline si-ack', () => siAck(it));
    ack.disabled = busy;
    acts.appendChild(ack);
  }
  row.appendChild(acts);
  const err = mk('div', 'err');
  err.id = 'si-err-' + p.id;
  row.appendChild(err);
  return row;
}

function siRender() {
  const root = $('staff-inbox-root');
  if (!root || !si) return;
  const nodes = [dBtn('← 案件一覧', 'back', () => openCases())];
  nodes.push(mk('h2', 'ob-h', '🔔 確認してください'));
  nodes.push(mk('div', 'rep-sub ob-lead', 'あなたが作業担当者の予定です。内容を確かめたら「確認した」を押してください（頼んだ人の画面に「確認済み」と出ます）。明日の予定もここに出ます'));
  const msg = mk('div', 'ob-msg', si.msg || '');
  msg.id = 'staff-inbox-msg';
  msg.setAttribute('role', 'status');
  nodes.push(msg);
  if (si.loading) nodes.push(mk('div', 'empty', '読み込み中…'));
  else if (si.err) {
    nodes.push(mk('div', 'err', si.err));
    nodes.push(dBtn('再読み込み', 'btn sm ghost inline', () => openStaffInbox()));
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

(() => {
  const b = document.getElementById('case-staff');
  if (b) b.addEventListener('click', () => { location.hash = '#inbox-staff'; });
})();
