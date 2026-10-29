// js/team.js — チーム状況（管理者向け「誰の番で止まっているか」）
// 対応フェーズ（case_summaries.phases）の 🔴 の段階を担当者（フェーズの作業担当者。無ければ案件の担当）ごとに数える（PhaseLogic.teamStages）。
// 🟡（相手待ち）は別のカードに一覧。旧い次やること（case_actions）は使わない（2026-10-18）
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）
// mk() は case-list.js、$ / setMsg / showScreen / renderHeaders は app.js のものを使う

let teamCases = [];         // case_summaries の行（phases つき）
let teamMembers = [];       // [{user_id, display_name}]
let teamSeq = 0;            // 読み込みのリクエスト番号。古い応答を捨てる
let teamLoading = false;
let teamLoadFailed = false;
const teamBusy = new Set(); // 作業担当者を保存中の phaseId

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
    results = await Promise.all([CasesApi.listSummaries(), CasesApi.listMembers()]);
  } catch (e) {
    errMsg = 'チーム状況の読み込みに失敗しました: ' + teamErr(e);
  }
  if (seq !== teamSeq) return; // より新しい読み込みが始まっている/別の画面に移った
  teamLoading = false;
  if (errMsg) {
    teamCases = [];
    teamMembers = [];
    teamLoadFailed = true;
    setMsg('team-msg', errMsg);
  } else {
    teamCases = results[0] || [];
    teamMembers = results[1] || [];
  }
  renderTeam();
}

function teamOpenBtn(it) {
  const b = mk('button', 'poke', '詳しく見る');
  b.type = 'button';
  b.addEventListener('click', () => { location.hash = '#case/' + it.caseId + '/phase/' + it.phaseId; });
  return b;
}

// 1行: 「● 10/20 9:00 調査に行く」（● は自社の番＝赤・相手待ち＝琥珀の小さな丸。Task 44）/「サンプルハイツ 101 ・ 調査 1回目」
function teamRowEl(it, kind) {
  const row = mk('div', 'mt-row');
  row.dataset.phase = it.phaseId || '';
  const l = mk('div', 'mt-l');
  l.appendChild(mk('b', it.late ? 'hot' : null)).append(Icon.dot(it.ball || (kind === 'waiting' ? 'them' : 'us')), it.text);
  let sub = (it.caseName || '(案件名なし)') + ' ・ ' + it.title;
  if (kind === 'waiting') sub += ' ・ 担当 ' + (it.whoName || 'なし');
  l.appendChild(mk('span', 'mt-case', sub));
  row.appendChild(l);

  const r = mk('div', 'mt-r');
  if (it.late) r.appendChild(mk('span', 'nx-due near', it.key === 'payment' ? '期限切れ' : it.due ? '期限を過ぎています' : '予定を過ぎています')); // Task 23: 見積・報告書の期限
  if (kind === 'unassigned') r.appendChild(teamAssignSelect(it));
  r.appendChild(teamOpenBtn(it));
  row.appendChild(r);
  return row;
}

function teamAssignSelect(it) {
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', '作業担当者を選ぶ: ' + it.caseName + ' ' + it.title);
  sel.appendChild(new Option('作業担当者を選ぶ', ''));
  teamMembers.forEach(m => {
    sel.appendChild(new Option((m.display_name || '(名前なし)') + (m.user_id === ctx.user.id ? '（自分）' : '') + memberTel(m), m.user_id));
  });
  sel.value = '';
  sel.disabled = teamBusy.has(it.phaseId);
  sel.addEventListener('change', () => { if (sel.value) assignTeamWorker(it, sel.value); });
  return sel;
}

// 担当なしの段階に作業担当者を付ける → case_phases.worker_id（PhasesApi.setWorker。タイムラインに記録）→ 再描画（担当者カードへ移る）
async function assignTeamWorker(it, userId) {
  if (teamBusy.has(it.phaseId)) return;
  const seq = teamSeq;
  teamBusy.add(it.phaseId);
  setMsg('team-msg', '');
  renderTeam();
  let saved = null;
  let errMsg = '';
  try {
    saved = await PhasesApi.setWorker({ id: it.phaseId, case_id: it.caseId }, userId, it.title, teamMembers);
  } catch (e) {
    errMsg = '作業担当者を保存できませんでした: ' + teamErr(e);
  }
  teamBusy.delete(it.phaseId);
  if (seq !== teamSeq) return; // 別の読み込みが始まった。そちらの結果が正
  if (errMsg) {
    setMsg('team-msg', errMsg);
  } else {
    const c = teamCases.find(x => x.id === it.caseId);
    const p = c && (c.phases || []).find(x => x.id === it.phaseId);
    if (p) {
      p.worker_id = saved && saved.worker_id !== undefined ? saved.worker_id : userId;
      const m = teamMembers.find(x => x.user_id === p.worker_id);
      p.worker_name = m ? m.display_name : null;
      p.notified_at = null; p.ack_at = null;
    }
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
  const g = PhaseLogic.teamStages(teamCases, teamMembers, new Date());
  const shown = !teamLoading && !teamLoadFailed;

  const tiles = [
    ['予定・期限切れ', g.summary.late, g.summary.late > 0],
    ['自社の番', g.summary.us, false, 'us'],
    ['相手待ち', g.summary.them, false, 'them'],
    ['担当なし', g.summary.unassigned, g.summary.unassigned > 0]
  ];
  $('team-sum').replaceChildren(...tiles.map(([label, n, alert, ball]) => {
    const el = mk('div', 'ts' + (alert ? ' alert' : ''));
    el.appendChild(mk('b', null, String(n)));
    if (ball) el.appendChild(Icon.dot(ball));
    el.appendChild(document.createTextNode(label));
    return el;
  }));
  $('team-sum').hidden = !shown;

  const cards = [];
  if (shown) {
    g.byMember.forEach(m => {
      const sub = mk('span', 'mh-sub');
      sub.append(Icon.dot('us', '自社の番'), m.items.length + '件');
      if (m.late > 0) {
        sub.appendChild(document.createTextNode('・'));
        sub.appendChild(mk('span', 'hot', '予定を過ぎた ' + m.late));
      }
      // Task 32: 担当者の電話番号（設定で本人が入れたもの）を名前の横に小さく
      const head = mk('span', 'mh-name');
      head.appendChild(Icon.prepend(mk('b', null, m.name), 'user'));
      const tm = teamMembers.find(x => x.user_id === m.user_id);
      if (tm && tm.phone) head.appendChild(Icon.prepend(mk('span', 'mh-tel', tm.phone), 'phone', 12));
      const card = teamCard('', head, sub);
      card.dataset.member = m.user_id;
      m.items.forEach(it => card.appendChild(teamRowEl(it, 'member')));
      cards.push(card);
    });
    if (g.unassigned.length > 0) {
      const card = teamCard('warn', Icon.prepend(mk('b', null, '担当なし'), 'alert'), mk('span', 'mh-sub', '作業担当者を決めてください'));
      card.dataset.group = 'unassigned';
      g.unassigned.forEach(it => card.appendChild(teamRowEl(it, 'unassigned')));
      cards.push(card);
    }
    if (g.waiting.length > 0) {
      const wh = mk('b', null);
      wh.append(Icon.dot('them'), '相手待ち');
      const card = teamCard('', wh, mk('span', 'mh-sub', '期限を過ぎたもの・日付の早い順'));
      card.dataset.group = 'waiting';
      g.waiting.forEach(it => card.appendChild(teamRowEl(it, 'waiting')));
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
  // 表示切替タブ（案件一覧 ⇔ チーム状況 ⇔ やること ⇔ カレンダー ⇔ 募集）。5つの画面それぞれにある（Task 38: カレンダー・Task 71: 募集）
  document.querySelectorAll('.viewtabs .vt').forEach(b => b.addEventListener('click', () => {
    if (b.classList.contains('on')) return;
    if (b.dataset.view === 'team') openTeam();
    else if (b.dataset.view === 'tasks' && typeof openTasks === 'function') openTasks();
    else if (b.dataset.view === 'calendar' && typeof openCalendar === 'function') openCalendar();
    else if (b.dataset.view === 'calls' && typeof openCallsScreen === 'function') openCallsScreen(); // Task 71
    else openCases();
  }));
}
