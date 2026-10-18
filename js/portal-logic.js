// js/portal-logic.js — お客様ページの画面に依存しない純粋関数（ブラウザ: window.PortalLogic / node: module.exports）
// 社内側（案件詳細の「👥 お客様ページ」欄・お客様へのお知らせ）と お客様側（p.html）の両方で使う。
// 見せる範囲の絞り込みはサーバー側（portal_open。migration 018/019）。ここは表示の整形だけ。
(function (root) {
  // 相手の種類。label = 画面に出す名前、short = 一覧で並べるときの短い名前（「・」でつなぐため）
  const AUDIENCES = [
    { key: 'gc', label: '元請', short: '元請' },
    { key: 'owner', label: '物件オーナー', short: 'オーナー' },
    { key: 'resident', label: '入居者', short: '入居者' }
  ];
  const AUDIENCE_KEYS = AUDIENCES.map(a => a.key);
  const LABEL_MAX = 100; // DB: length(btrim(label)) between 1 and 100（文字数）
  const find = key => AUDIENCES.find(a => a.key === key) || null;
  const isAudience = key => AUDIENCE_KEYS.includes(key);
  const audienceLabel = key => (find(key) || {}).label || '';
  const chars = s => Array.from(String(s == null ? '' : s)).length;

  // 宛名の初期値。gc は案件の「元請け・発注者」（cases.client_name）
  function defaultLabel(audience, caseRow) {
    if (audience === 'gc') {
      const name = String((caseRow && caseRow.client_name) || '').trim();
      if (!name) return '元請 御中';
      return /(御中|様)$/.test(name) ? name : name + ' 御中';
    }
    if (audience === 'owner') return 'オーナー様';
    if (audience === 'resident') return '入居者の皆様';
    return '';
  }

  // 宛名の入力チェック。'' = OK
  function labelError(label) {
    const s = String(label == null ? '' : label).trim();
    if (!s) return '宛名を入力してください';
    if (chars(s) > LABEL_MAX) return `宛名は${LABEL_MAX}文字以内で入力してください`;
    return '';
  }

  // お客様へのお知らせの「見せる相手」のチェック。'' = OK
  function audiencesError(keys) {
    const list = Array.isArray(keys) ? keys : [];
    if (list.length === 0) return 'お知らせを見せる相手を1つ以上選んでください';
    if (list.some(k => !isAudience(k))) return '見せる相手の指定が正しくありません';
    return '';
  }

  // index.html と同じ階層の p.html#<token>（サブパス配信でも動くように baseHref 基準で組み立てる）
  function portalUrl(baseHref, token) {
    return new URL('p.html', baseHref).href + '#' + token;
  }

  // LINE・メールに貼る文面。入居者には書類が出ないので「お知らせ」と書く
  function shareText({ audience, label, caseName, orgName, url } = {}) {
    const lines = [];
    const to = String(label || '').trim();
    if (to) lines.push(to);
    const org = String(orgName || '').trim();
    const cn = String(caseName || '').trim();
    const intro = (org ? org + 'です。' : '') + (cn ? cn + 'の件でご連絡します。' : '');
    if (intro) lines.push(intro);
    lines.push(audience === 'resident'
      ? '工事の進み具合とお知らせは、こちらでいつでもご確認いただけます。'
      : '工事の進み具合とお送りした書類は、こちらでいつでもご確認いただけます。');
    lines.push(String(url || ''));
    lines.push('ログインは不要です。');
    return lines.join('\n');
  }

  // 日付（Date / ISO文字列）→ 'M/D'。年が now と違えば 'YYYY/M/D'。不正なら ''
  function mdText(v, now) {
    const d = v instanceof Date ? v : new Date(v);
    if (v == null || v === '' || isNaN(d.getTime())) return '';
    const n = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    const md = (d.getMonth() + 1) + '/' + d.getDate();
    return !isNaN(n.getTime()) && n.getFullYear() !== d.getFullYear() ? d.getFullYear() + '/' + md : md;
  }

  // 「まだ開かれていません」/「M/D に見られました」（端末の時刻帯で日付を出す）
  function openedText(lastOpenedAt, now) {
    const t = mdText(lastOpenedAt, now);
    return t ? t + ' に見られました' : 'まだ開かれていません';
  }

  const ts = v => { const x = Date.parse(v); return isNaN(x) ? -Infinity : x; };
  const bySentDesc = (a, b) => ts(b.sent_at) - ts(a.sent_at);

  // 送付済みの書類（portal_open の docs）を並べる。
  //   estimates: 見積の系列（series_id）ごとに1つ。最新版（版が大きい→送付日が新しい）を先頭の項目にし、それ以前は older に
  //              （older も同じ順）。同じ版の送り直しは送付日が新しい1件だけ。系列は最新版の送付日の新しい順。
  //              series_id が無い見積は1件で1系列
  //   reports:   報告書を送付日の新しい順。送り直しはまとめない（portal_open は報告書の id を返さず、
  //              同じ種類の別の報告書＝同じ題名と区別できない。まとめると別の報告書が消える）
  function groupDocs(docs) {
    const list = Array.isArray(docs) ? docs.filter(d => d && typeof d === 'object') : [];
    const reports = list.filter(d => d.kind === 'report').slice().sort(bySentDesc);
    const series = new Map();
    list.filter(d => d.kind === 'estimate').forEach((d, i) => {
      const key = d.series_id ? 's:' + d.series_id : 'i:' + i;
      if (!series.has(key)) series.set(key, []);
      series.get(key).push(d);
    });
    const byVersion = (a, b) => (Number(b.version) || 0) - (Number(a.version) || 0) || bySentDesc(a, b);
    // 同じ系列の同じ版（DB で (org, series_id, version) は一意＝同じ見積）を送り直したものは、送付日が新しい1件だけ残す。
    // 版番号が無いものは同じ見積か分からないのでまとめない
    const dedupe = s => {
      const seen = new Set();
      return s.filter(d => {
        const v = Number(d.version);
        if (!(v > 0)) return true;
        if (seen.has(v)) return false;
        seen.add(v);
        return true;
      });
    };
    const estimates = Array.from(series.values()).map(g => {
      const s = dedupe(g.slice().sort(byVersion));
      return Object.assign({}, s[0], { older: s.slice(1) });
    }).sort(bySentDesc);
    return { estimates, reports };
  }

  // 'YYYY-MM-DD'（日付だけ）→ 'M/D'。不正なら ''
  function ymdText(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v == null ? '' : v));
    return m ? (+m[2]) + '/' + (+m[3]) : '';
  }

  // 進み具合（portal_open の stages）→ 表示用。state: done=済（✓）/ planned=予定日あり（●）/ todo=まだ（○）
  //   工事で日付が無いものは「日程未定」
  function stageView(stages) {
    const list = Array.isArray(stages) ? stages.filter(s => s && typeof s === 'object') : [];
    return list.map(s => {
      const date = ymdText(s.date);
      let state, dateText;
      if (s.done) { state = 'done'; dateText = date; }
      else if (date) { state = 'planned'; dateText = date + ' 予定'; }
      else { state = 'todo'; dateText = s.key === 'work' ? '日程未定' : ''; }
      return { key: s.key, label: String(s.label || ''), state, mark: { done: '✓', planned: '●', todo: '○' }[state], dateText };
    });
  }

  // ['gc','resident'] → '元請・入居者'（決まった順・重複と不明は除く）
  function audienceNames(keys) {
    const set = new Set(Array.isArray(keys) ? keys : []);
    return AUDIENCES.filter(a => set.has(a.key)).map(a => a.short).join('・');
  }

  // 発行済みの一覧（新しい順）を 有効 / 取り消し済み に分ける（順序は保つ）
  function splitPortals(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return { active: list.filter(r => r && !r.revoked_at), revoked: list.filter(r => r && r.revoked_at) };
  }

  const api = { AUDIENCES, AUDIENCE_KEYS, LABEL_MAX, isAudience, audienceLabel, defaultLabel, labelError,
    audiencesError, portalUrl, shareText, mdText, openedText, groupDocs, stageView, audienceNames, splitPortals };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PortalLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
