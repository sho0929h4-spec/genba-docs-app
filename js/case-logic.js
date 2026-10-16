// js/case-logic.js — 画面に依存しない純粋関数（ブラウザ: window.CaseLogic / node: module.exports）
(function (root) {
  const WORK_KINDS = [
    { key: 'genchou', label: '現調' },
    { key: 'chousa', label: '調査' },
    { key: 'gen_in', label: '原因元工事' },
    { key: 'fukkyu', label: '復旧工事' },
    { key: 'other', label: 'その他' }
  ];
  const ACTION_KINDS = [
    { key: 'estimate', label: '見積作成', ball: 'us', title: '見積を作成する' },
    { key: 'approval', label: '承諾待ち', ball: 'them', title: '見積の承諾待ち' },
    { key: 'schedule', label: '日程待ち', ball: 'them', title: '日程の連絡待ち' },
    { key: 'insurance', label: '保険待ち', ball: 'them', title: '保険の結果待ち' },
    { key: 'other', label: 'その他', ball: 'us', title: '' }
  ];
  const ENTRY_TYPES = [
    { key: 'memo', label: 'メモ' },
    { key: 'request', label: '依頼' },
    { key: 'decision', label: '決定' },
    { key: 'system', label: '自動' }
  ];
  const find = (list, key) => list.find(x => x.key === key);
  const workLabel = k => (find(WORK_KINDS, k) || {}).label || k;
  const actionKind = k => find(ACTION_KINDS, k) || find(ACTION_KINDS, 'other');
  const entryLabel = t => (find(ENTRY_TYPES, t) || {}).label || t;

  const pad = n => String(n).padStart(2, '0');
  function todayStr(d) {
    d = d || new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function ymdToUtc(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }
  function daysBetween(fromYmd, toYmd) {
    return Math.round((ymdToUtc(toYmd) - ymdToUtc(fromYmd)) / 86400000);
  }
  function dueState(ymd, todayYmd) {
    if (!ymd) return 'none';
    const diff = daysBetween(todayYmd, ymd);
    if (diff < 0) return 'overdue';
    if (diff <= 3) return 'near';
    return 'normal';
  }
  function formatMD(ymd) {
    if (!ymd) return '';
    const [, m, d] = ymd.split('-').map(Number);
    return `${m}/${d}`;
  }
  function formatDateTime(v) {
    const d = v instanceof Date ? v : new Date(v);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function mapUrls(address) {
    const a = (address || '').trim();
    if (!a) return null;
    const q = encodeURIComponent(a);
    return {
      google: 'https://www.google.com/maps/search/?api=1&query=' + q,
      apple: 'https://maps.apple.com/?q=' + q
    };
  }

  function sortCases(rows) {
    return rows.slice().sort((a, b) => {
      if (a.due_date && b.due_date && a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
      if (a.due_date && !b.due_date) return -1;
      if (!a.due_date && b.due_date) return 1;
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
  }
  const FILTERS = {
    open: r => r.status === 'open',
    mine_turn: r => r.status === 'open' && r.my_open_actions > 0,
    mine: (r, me) => r.status === 'open' && r.assignee_id === me,
    requests: r => r.status === 'open' && r.open_requests > 0,
    unsettled: r => r.unsettled_works > 0,
    done: r => r.status === 'done'
  };
  function matchesQuery(r, q) {
    if (!q) return true;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return [r.name, r.address, r.client_name].some(v => (v || '').toLowerCase().includes(needle));
  }
  function filterCases(rows, filterKey, query, me) {
    const f = FILTERS[filterKey] || FILTERS.open;
    return sortCases(rows.filter(r => f(r, me) && matchesQuery(r, query)));
  }
  function countByFilter(rows, me) {
    const out = {};
    Object.keys(FILTERS).forEach(k => { out[k] = rows.filter(r => FILTERS[k](r, me)).length; });
    return out;
  }

  // チーム状況: 未完了の次やること（case_actions + cases(name,status)）を「誰がどこで止まっているか」に分ける
  //   ball=us かつ担当あり → byMember（0件の人は出さない） / ball=us かつ担当なし → unassigned / ball=them → waiting
  //   summary.overdue は表示対象の全行（us と them）のうち期限（次回確認日）が過ぎている数
  //   summary.us は ball=us の全行（担当なしを含む）、summary.them は ball=them の全行
  function groupTeamActions(actions, members, todayYmd) {
    const nameOf = new Map((members || []).map(m => [m.user_id, m.display_name || '(名前なし)']));
    const byDue = (a, b) => {
      if (a.due_date && b.due_date && a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
      if (a.due_date && !b.due_date) return -1;
      if (!a.due_date && b.due_date) return 1;
      return (a.created_at || '').localeCompare(b.created_at || '') || String(a.id).localeCompare(String(b.id));
    };
    const rows = (actions || [])
      .filter(a => !a.done_at && !(a.cases && a.cases.status !== 'open'))
      .sort(byDue)
      .map(a => ({
        id: a.id, case_id: a.case_id, case_name: (a.cases && a.cases.name) || '', kind: a.kind, title: a.title, ball: a.ball,
        due_date: a.due_date || null, due_state: dueState(a.due_date, todayYmd), started_on: a.started_on || null,
        assignee_id: a.assignee_id || null,
        assignee_name: a.assignee_id ? (nameOf.get(a.assignee_id) || '不明') : '',
        created_at: a.created_at
      }));
    const us = rows.filter(r => r.ball === 'us');
    const mine = new Map();
    us.filter(r => r.assignee_id).forEach(r => {
      if (!mine.has(r.assignee_id)) mine.set(r.assignee_id, []);
      mine.get(r.assignee_id).push(r);
    });
    const order = (members || []).map(m => m.user_id).filter(id => mine.has(id));
    mine.forEach((_, id) => { if (!order.includes(id)) order.push(id); }); // 退会済み等はメンバー順の後ろ
    const byMember = order.map(id => {
      const items = mine.get(id);
      return { user_id: id, name: nameOf.get(id) || '不明', items, overdue: items.filter(i => i.due_state === 'overdue').length };
    });
    const unassigned = us.filter(r => !r.assignee_id);
    const waiting = rows.filter(r => r.ball === 'them');
    return {
      summary: {
        overdue: rows.filter(r => r.due_state === 'overdue').length,
        us: us.length, them: waiting.length, unassigned: unassigned.length
      },
      byMember, unassigned, waiting
    };
  }

  const sys = {
    actionDone: title => `次やること「${title}」を済にした`,
    workAdded: (kind, label, workedAt) =>
      `${workLabel(kind)}を記録した（${formatDateTime(workedAt)}${label ? '・' + label : ''}）`,
    settled: kind => `${workLabel(kind)}の精算を確認した`,
    status: s => (s === 'done' ? '案件を完了にした' : '案件を再開した')
  };

  const api = { WORK_KINDS, ACTION_KINDS, ENTRY_TYPES, workLabel, actionKind, entryLabel,
    todayStr, daysBetween, dueState, formatMD, formatDateTime, mapUrls,
    sortCases, filterCases, countByFilter, groupTeamActions, sys };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CaseLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
