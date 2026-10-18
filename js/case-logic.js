// js/case-logic.js — 画面に依存しない純粋関数（ブラウザ: window.CaseLogic / node: module.exports）
(function (root) {
  const ENTRY_TYPES = [
    { key: 'memo', label: 'メモ' },
    { key: 'request', label: '依頼' },
    { key: 'decision', label: '決定' },
    { key: 'system', label: '自動' }
  ];
  const find = (list, key) => list.find(x => x.key === key);
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
  // 案件一覧のチップ。「次:」・自分の番・相手待ち・入金待ちは対応フェーズの段階（PhaseLogic.caseFlags）から（2026-10-18）
  //   旧い次やること（case_actions）・対応履歴（case_works）は使わない
  const PL = () => (typeof module !== 'undefined' && module.exports ? require('./phase-logic.js') : root.PhaseLogic);
  const FILTERS = {
    open: r => r.status === 'open',
    mine_turn: (r, me, f) => r.status === 'open' && f().mineTurn,
    waiting: (r, me, f) => r.status === 'open' && f().them,
    mine: (r, me, f) => r.status === 'open' && f().mine,
    requests: r => r.status === 'open' && r.open_requests > 0,
    unpaid: (r, me, f) => f().unpaid > 0,
    done: r => r.status === 'done'
  };
  // 1行分のフラグを必要になったときだけ1回計算する
  const lazyFlags = (r, me, now) => { let v = null; return () => (v || (v = PL().caseFlags(r, me, now))); };
  function matchesQuery(r, q) {
    if (!q) return true;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return [r.name, r.address, r.client_name].some(v => (v || '').toLowerCase().includes(needle));
  }
  function filterCases(rows, filterKey, query, me, now) {
    const f = FILTERS[filterKey] || FILTERS.open;
    return sortCases(rows.filter(r => f(r, me, lazyFlags(r, me, now)) && matchesQuery(r, query)));
  }
  function countByFilter(rows, me, now) {
    const out = {};
    Object.keys(FILTERS).forEach(k => { out[k] = 0; });
    rows.forEach(r => {
      const f = lazyFlags(r, me, now);
      Object.keys(FILTERS).forEach(k => { if (FILTERS[k](r, me, f)) out[k]++; });
    });
    return out;
  }

  const sys = {
    status: s => (s === 'done' ? '案件を完了にした' : '案件を再開した')
  };

  const api = { ENTRY_TYPES, entryLabel,
    todayStr, daysBetween, dueState, formatMD, formatDateTime, mapUrls,
    sortCases, filterCases, countByFilter, sys };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CaseLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
