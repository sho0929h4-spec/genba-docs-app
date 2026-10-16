// js/team.js — チーム状況（管理者向け「誰がどこで止まっているか」）
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）
// mk() は case-list.js、$ / setMsg / showScreen / renderHeaders は app.js のものを使う
// メンバーは caseMembers（案件詳細のグローバル）に頼らず、ここで CasesApi.listMembers() から取る

let teamActions = [];       // 進行中案件の未完了の次やること（cases(name,status) つき）
let teamMembers = [];       // [{user_id, display_name}]
let teamSeq = 0;            // 読み込みのリクエスト番号。古い応答を捨てる
let teamLoading = false;
let teamLoadFailed = false;
const teamBusy = new Set(); // 担当を保存中の action.id

const teamErr = e => (e && e.message ? e.message : String(e));

async function openTeam() {
  renderHeaders();
  showScreen('team');
  if (location.hash !== '#team') history.replaceState(null, '', location.pathname + location.search + '#team');
  setMsg('team-msg', '');
  const seq = ++teamSeq;
  teamLoading = true;
  teamLoadFailed = false;
  renderTeam();
  let results = null;
  let errMsg = '';
  try {
    results = await Promise.all([CasesApi.listOpenActionsAll(), CasesApi.listMembers()]);
  } catch (e) {
    errMsg = 'チーム状況の読み込みに失敗しました: ' + teamErr(e);
  }
  if (seq !== teamSeq) return; // より新しい読み込みが始まっている/別の画面に移った
  teamLoading = false;
  if (errMsg) {
    teamActions = [];
    teamMembers = [];
    teamLoadFailed = true;
    setMsg('team-msg', errMsg);
  } else {
    teamActions = results[0] || [];
    teamMembers = results[1] || [];
  }
  renderTeam();
}

function teamDueEl(it, today) {
  const us = it.ball === 'us';
  if (!it.due_date) return mk('span', 'nx-due', us ? '期限未設定' : '次回確認日未設定');
  const hot = it.due_state === 'overdue' || it.due_state === 'near';
  let text = (us ? '期限 ' : '次回確認 ') + CaseLogic.formatMD(it.due_date);
  if (it.due_state === 'overdue') text += '（' + CaseLogic.daysBetween(it.due_date, today) + '日超過）';
  return mk('span', 'nx-due' + (hot ? ' near' : ''), text);
}

function teamOpenBtn(it) {
  const b = mk('button', 'poke', '案件を開く');
  b.type = 'button';
  b.addEventListener('click', () => openCase(it.case_id));
  return b;
}

function teamRowEl(it, today, kind) {
  const row = mk('div', 'mt-row');
  row.dataset.id = it.id;
  const l = mk('div', 'mt-l');
  const t = mk('b', null, it.title);
  if (kind === 'waiting' && it.started_on) {
    const days = CaseLogic.daysBetween(it.started_on, today);
    t.appendChild(document.createTextNode(' '));
    t.appendChild(mk('span', 'nx-sub',
      CaseLogic.formatMD(it.started_on) + (it.kind === 'insurance' ? '申請' : '開始') + (days >= 0 ? '・' + days + '日経過' : '')));
  }
  l.appendChild(t);
  let sub = it.case_name || '(案件名なし)';
  if (kind === 'waiting') sub += ' ・ 確認担当 ' + (it.assignee_name || 'なし');
  l.appendChild(mk('span', 'mt-case', sub));
  row.appendChild(l);

  const r = mk('div', 'mt-r');
  if (kind === 'unassigned') {
    r.appendChild(teamDueEl(it, today));
    r.appendChild(teamAssignSelect(it));
  } else {
    r.appendChild(teamDueEl(it, today));
  }
  r.appendChild(teamOpenBtn(it));
  row.appendChild(r);
  return row;
}

function teamAssignSelect(it) {
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', '担当を選ぶ: ' + it.title);
  sel.appendChild(new Option('担当を選ぶ', ''));
  teamMembers.forEach(m => {
    sel.appendChild(new Option((m.display_name || '(名前なし)') + (m.user_id === ctx.user.id ? '（自分）' : ''), m.user_id));
  });
  sel.value = '';
  sel.disabled = teamBusy.has(it.id);
  sel.addEventListener('change', () => { if (sel.value) assignTeamAction(it.id, sel.value); });
  return sel;
}

// 担当なしの行に担当を振る → case_actions.assignee_id を更新 → 再描画（担当者カードへ移る）
async function assignTeamAction(actionId, userId) {
  if (teamBusy.has(actionId)) return;
  const seq = teamSeq;
  teamBusy.add(actionId);
  setMsg('team-msg', '');
  renderTeam();
  let saved = null;
  let errMsg = '';
  try {
    saved = await CasesApi.updateAction(actionId, { assignee_id: userId });
  } catch (e) {
    errMsg = '担当を保存できませんでした: ' + teamErr(e);
  }
  teamBusy.delete(actionId);
  if (seq !== teamSeq) return; // 別の読み込みが始まった。そちらの結果が正
  if (errMsg) {
    setMsg('team-msg', errMsg);
  } else {
    const a = teamActions.find(x => x.id === actionId);
    if (a) a.assignee_id = saved && saved.assignee_id !== undefined ? saved.assignee_id : userId;
  }
  renderTeam();
}

function teamCard(cls, head, sub) {
  const card = mk('div', 'member' + (cls ? ' ' + cls : ''));
  const h = mk('div', 'member-h');
  h.appendChild(head);
  if (sub) h.appendChild(sub);
  card.appendChild(h);
  return card;
}

function renderTeam() {
  const today = CaseLogic.todayStr();
  const g = CaseLogic.groupTeamActions(teamActions, teamMembers, today);
  const shown = !teamLoading && !teamLoadFailed;

  const tiles = [
    ['期限切れ', g.summary.overdue, g.summary.overdue > 0],
    ['社内の対応待ち', g.summary.us, false],
    ['相手の返事待ち', g.summary.them, false],
    ['担当なし', g.summary.unassigned, g.summary.unassigned > 0]
  ];
  $('team-sum').replaceChildren(...tiles.map(([label, n, alert]) => {
    const el = mk('div', 'ts' + (alert ? ' alert' : ''));
    el.appendChild(mk('b', null, String(n)));
    el.appendChild(document.createTextNode(label));
    return el;
  }));
  $('team-sum').hidden = !shown;

  const cards = [];
  if (shown) {
    g.byMember.forEach(m => {
      const sub = mk('span', 'mh-sub', '対応待ち ' + m.items.length + '件');
      if (m.overdue > 0) {
        sub.appendChild(document.createTextNode('・'));
        sub.appendChild(mk('span', 'hot', '期限切れ ' + m.overdue));
      }
      const card = teamCard('', mk('b', null, '👤 ' + m.name), sub);
      card.dataset.member = m.user_id;
      m.items.forEach(it => card.appendChild(teamRowEl(it, today, 'member')));
      cards.push(card);
    });
    if (g.unassigned.length > 0) {
      const card = teamCard('warn', mk('b', null, '⚠️ 担当なし'), mk('span', 'mh-sub', '振り分けてください'));
      card.dataset.group = 'unassigned';
      g.unassigned.forEach(it => card.appendChild(teamRowEl(it, today, 'unassigned')));
      cards.push(card);
    }
    if (g.waiting.length > 0) {
      const card = teamCard('', mk('b', null, '🟡 相手の返事待ち'), mk('span', 'mh-sub', '次回確認日が近い順'));
      card.dataset.group = 'waiting';
      g.waiting.forEach(it => card.appendChild(teamRowEl(it, today, 'waiting')));
      cards.push(card);
    }
  }
  $('team-body').replaceChildren(...cards);
  $('team-loading').hidden = !teamLoading;
  $('team-empty').hidden = !shown || cards.length > 0;
  $('team-retry').hidden = !teamLoadFailed;
}

function bindTeam() {
  $('team-retry').addEventListener('click', () => openTeam());
  // 表示切替タブ（案件一覧 ⇔ チーム状況）。一覧画面とチーム状況画面の両方にある
  document.querySelectorAll('.viewtabs .vt').forEach(b => b.addEventListener('click', () => {
    if (b.classList.contains('on')) return;
    if (b.dataset.view === 'team') openTeam();
    else openCases();
  }));
}
