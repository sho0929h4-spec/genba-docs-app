// js/calendar-logic.js — カレンダー表示（Task 38）の純粋関数（ブラウザ: window.CalendarLogic / node: module.exports）
// 月表示（6週・日曜はじまり）のマス・週の行に予定の帯を段（lane）に並べる・はみ出す分の「+N」・週表示の時間の枠で重なる予定を横に並べる。
// 予定 = フェーズの日時（scheduled_at〜scheduled_end。終わりが無い・開始より前なら1時間）。日時の無いフェーズは出さずに数える。
// 時刻はすべて日本時間（UTC+9 固定）。日は 'YYYY-MM-DD' の文字列で扱う（実行環境のタイムゾーンに依存しない）
(function (root) {
  const JST_MS = 9 * 3600 * 1000;
  const DAY_MS = 86400000;
  const DEFAULT_MIN = 60;  // 終わりの無い予定の長さ（分）
  const MIN_BOX_MIN = 30;  // 週表示の箱の最小の高さ（分）。短い予定も読めるように
  const WEEK = '日月火水木金土';
  const pad = n => String(n).padStart(2, '0');
  const str = v => String(v == null ? '' : v).trim();

  function toMs(v) {
    if (v == null || v === '') return null;
    const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  // 日本時間の日 'YYYY-MM-DD'・その日の 0:00 からの分
  function ymdOfMs(t) {
    const d = new Date(t + JST_MS);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  function minOfMs(t) {
    const d = new Date(t + JST_MS);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
  function parts(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  const ymdOf = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
  const utc = ymd => { const p = parts(ymd); return Date.UTC(p.y, p.m - 1, p.d); };
  const addDays = (ymd, n) => { const p = parts(ymd); return ymdOf(p.y, p.m, p.d + n); };
  const dow = ymd => new Date(utc(ymd)).getUTCDay(); // 0 = 日
  const diffDays = (a, b) => Math.round((utc(b) - utc(a)) / DAY_MS); // b - a（日）
  const weekStart = ymd => addDays(ymd, -dow(ymd));  // その週の日曜
  // 日本時間の y/m/d h:min の瞬間（ミリ秒）
  const atMs = (ymd, min) => utc(ymd) - JST_MS + (min || 0) * 60000;
  function addMonths(y, m, n) {
    const i = y * 12 + (m - 1) + n;
    return { y: Math.floor(i / 12), m: (i % 12) + 1 };
  }
  const todayOf = now => ymdOfMs(toMs(now) != null ? toMs(now) : Date.now());

  /* ---------- 月表示 ---------- */
  // 6週（42日）・日曜はじまり。その月の1日を含む週から → [[{ ymd, y, m, d, dow, inMonth }×7]×6]
  function monthGrid(y, m) {
    const first = ymdOf(y, m, 1);
    let day = weekStart(first);
    const weeks = [];
    for (let w = 0; w < 6; w++) {
      const row = [];
      for (let i = 0; i < 7; i++) {
        const p = parts(day);
        row.push({ ymd: day, y: p.y, m: p.m, d: p.d, dow: i, inMonth: p.y === y && p.m === m });
        day = addDays(day, 1);
      }
      weeks.push(row);
    }
    return weeks;
  }
  // 上の月のチップ（横に並べる）: 今の月の before か月前 〜 after か月後（表示中の月が外なら広げる）。
  //   年が変わる所（と、最初の月が今年でないとき）に年の区切り { type: 'year', y }。表示中の月は on
  function monthChips(today, shown, before, after) {
    const t = typeof today === 'object' ? today : (() => { const p = parts(todayOf(today)); return { y: p.y, m: p.m }; })();
    const idx = x => x.y * 12 + x.m - 1;
    let from = addMonths(t.y, t.m, -(before == null ? 3 : before));
    let to = addMonths(t.y, t.m, after == null ? 12 : after);
    if (shown && idx(shown) < idx(from)) from = { y: shown.y, m: shown.m };
    if (shown && idx(shown) > idx(to)) to = { y: shown.y, m: shown.m };
    const out = [];
    for (let i = idx(from); i <= idx(to); i++) {
      const y = Math.floor(i / 12), m = (i % 12) + 1;
      if ((m === 1 && i !== idx(from)) || (i === idx(from) && y !== t.y)) out.push({ type: 'year', y });
      out.push({ type: 'month', y, m, on: !!shown && shown.y === y && shown.m === m, today: y === t.y && m === t.m });
    }
    return out;
  }
  // 見出し: 「10月」（今年でなければ「2027年1月」）。週表示は木曜の月（週が月をまたぐときは多い方）
  function monthTitle(y, m, today) {
    const p = parts(todayOf(today));
    return (p && p.y !== y ? `${y}年` : '') + `${m}月`;
  }
  function weekTitle(ws, today) {
    const p = parts(addDays(ws, 4));
    return monthTitle(p.y, p.m, today);
  }

  /* ---------- 予定 ---------- */
  // { id, start, end, ...ほか } → 予定（ミリ秒・日・分）。開始が読めなければ null
  //   end が無い・開始以前 → 開始＋1時間。最後の日は「終わりの1ミリ秒前」の日（0:00 ちょうどに終わるなら前の日まで）
  function eventOf(x) {
    const s = toMs(x && x.start);
    if (s == null) return null;
    const e0 = toMs(x.end);
    const hasEnd = e0 != null && e0 > s;
    const e = hasEnd ? e0 : s + DEFAULT_MIN * 60000;
    const startYmd = ymdOfMs(s);
    const endYmd = ymdOfMs(e - 1);
    const endMin = ymdOfMs(e) === endYmd ? minOfMs(e) : 1440;
    const out = Object.assign({}, x, { startMs: s, endMs: e, hasEnd, startYmd, endYmd, startMin: minOfMs(s), endMin, multi: startYmd !== endYmd });
    delete out.start;
    delete out.end;
    return out;
  }
  const caseOpen = c => !c.status || c.status === 'open';
  const phaseOpen = p => !p.done_at && !p.billed_at && !p.paid_at;
  // case_summaries の行 → { events（開始の早い順）, undated（日時未定: 進行中の案件の済んでいないフェーズ [{ caseRow, phase }]）}
  //   opts.include(caseRow, phase) で絞る（作業担当者は自分の分だけ）。opts.titleOf(caseRow, phase) で帯の文（既定「物件名 号室」）。
  //   削除した案件は出さない。完了した案件・済んだフェーズも日時があれば出す（過去の予定）
  function eventsFrom(caseRows, opts) {
    const o = opts || {};
    const titleOf = o.titleOf || ((c) => [str(c.name), str(c.room)].filter(Boolean).join(' '));
    const events = [], undated = [];
    for (const c of Array.isArray(caseRows) ? caseRows : []) {
      if (!c || c.deleted_at) continue;
      for (const p of Array.isArray(c.phases) ? c.phases : []) {
        if (!p || (o.include && !o.include(c, p))) continue;
        if (toMs(p.scheduled_at) == null) {
          if (caseOpen(c) && phaseOpen(p)) undated.push({ caseRow: c, phase: p });
          continue;
        }
        events.push(eventOf({ id: p.id, caseId: c.id, kind: p.kind, title: titleOf(c, p), who: str(p.worker_name), workerId: p.worker_id || null, done: !!(p.done_at || p.paid_at),
          start: p.scheduled_at, end: p.scheduled_end }));
      }
    }
    events.sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs || String(a.id).localeCompare(String(b.id)));
    return { events, undated };
  }
  // 日の範囲 [from, to]（両端を含む）にかかる予定
  const overlapping = (events, from, to) => (events || []).filter(e => e.startYmd <= to && e.endYmd >= from);
  const onDay = (events, ymd) => overlapping(events, ymd, ymd);

  // 1週（日曜 ws から7日）の帯の並べ方。複数日の予定は日をまたぐ1本の帯。
  //   並び: 始まる列 → 長い帯 → 開始の早い順。段（lane）は空いている一番上（区間グラフの貪欲法 = 必要な段数が最小）。
  //   maxLanes（マスに入る段数）を超える分は隠して、その列の一番下の段に「+N」（N = その列で隠れた予定の数）。
  //   一番下の段の帯は、かかる列のどこかで隠れる予定があれば隠す（「+N」と重ならないように）
  //   → { bars: [{ ev, col, span, lane, contL（前の週から続く）, contR（次の週へ続く）}], more: [7つの数], lanes（使う段数。+N を含む）}
  function layoutWeek(events, ws, maxLanes) {
    const we = addDays(ws, 6);
    const limit = maxLanes == null ? Infinity : Math.max(1, maxLanes);
    const items = overlapping(events, ws, we).map(ev => {
      const col = Math.max(0, diffDays(ws, ev.startYmd));
      const last = Math.min(6, diffDays(ws, ev.endYmd));
      return { ev, col, span: last - col + 1, lane: 0, contL: ev.startYmd < ws, contR: ev.endYmd > we };
    });
    items.sort((a, b) => a.col - b.col || b.span - a.span || a.ev.startMs - b.ev.startMs || String(a.ev.id).localeCompare(String(b.ev.id)));
    const used = []; // used[lane][col]
    for (const it of items) {
      let lane = 0;
      for (;; lane++) {
        const row = used[lane] || (used[lane] = []);
        let free = true;
        for (let c = it.col; c < it.col + it.span; c++) if (row[c]) { free = false; break; }
        if (free) break;
      }
      for (let c = it.col; c < it.col + it.span; c++) used[lane][c] = true;
      it.lane = lane;
    }
    const covers = (it, c) => c >= it.col && c < it.col + it.span;
    const over = [0, 1, 2, 3, 4, 5, 6].map(c => items.some(it => it.lane >= limit && covers(it, c)));
    const shown = it => it.lane < limit - 1 || (it.lane === limit - 1 && !over.slice(it.col, it.col + it.span).some(Boolean));
    const bars = items.filter(shown);
    const more = [0, 1, 2, 3, 4, 5, 6].map(c => items.filter(it => !shown(it) && covers(it, c)).length);
    const lanes = Math.max(0, ...bars.map(b => b.lane + 1), more.some(n => n > 0) ? Math.min(limit, used.length) : 0);
    return { bars, more, lanes };
  }

  /* ---------- 週表示 ---------- */
  // その日の時間の予定（1日の中で終わるもの。複数日は上の帯の段）を時間の枠に置く。重なる予定は横に並べる:
  //   開始の早い順（同じなら長い方）に、重なりの続くまとまりごとに、空いている一番左の列へ。cols = そのまとまりの列の数（幅 = 1/cols）
  //   → [{ ev, col, cols, top（分）, bottom（分。最小 30分）}]
  function dayColumns(events, ymd) {
    const items = onDay(events, ymd).filter(e => !e.multi)
      .map(ev => ({ ev, top: ev.startMin, bottom: Math.min(1440, Math.max(ev.endMin, ev.startMin + MIN_BOX_MIN)), col: 0, cols: 1 }))
      .sort((a, b) => a.top - b.top || b.bottom - a.bottom || String(a.ev.id).localeCompare(String(b.ev.id)));
    let group = [], colEnds = [], groupEnd = -1;
    const close = () => { group.forEach(it => { it.cols = colEnds.length; }); group = []; colEnds = []; };
    for (const it of items) {
      if (group.length && it.top >= groupEnd) close();
      let c = colEnds.findIndex(end => end <= it.top);
      if (c < 0) { c = colEnds.length; colEnds.push(it.bottom); } else colEnds[c] = it.bottom;
      it.col = c;
      group.push(it);
      groupEnd = Math.max(group.length > 1 ? groupEnd : -1, it.bottom);
    }
    close();
    return items;
  }
  // 週表示の全部: 上の帯の段（複数日の予定）と7日の時間の枠
  function weekView(events, ws, maxLanes) {
    const multi = (events || []).filter(e => e.multi);
    return { days: [0, 1, 2, 3, 4, 5, 6].map(i => addDays(ws, i)), allDay: layoutWeek(multi, ws, maxLanes),
      columns: [0, 1, 2, 3, 4, 5, 6].map(i => dayColumns(events, addDays(ws, i))) };
  }

  /* ---------- 操作 ---------- */
  // 左右のスワイプ: 横に 50px 以上・縦の 1.5 倍より大きい → 1（次へ = 左に払う）/ -1（前へ）/ 0（何もしない）
  function swipeDir(dx, dy) {
    if (Math.abs(dx) < 50 || Math.abs(dx) <= Math.abs(dy) * 1.5) return 0;
    return dx < 0 ? 1 : -1;
  }
  // 案件の登録の訪問日時の初期値（datetime-local）: 押した日の hour 時（既定 9時）
  function prefillAt(ymd, hour) {
    if (!parts(ymd)) return '';
    const h = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 9;
    return `${ymd}T${pad(h)}:00`;
  }
  const weekdayOf = ymd => WEEK[dow(ymd)];

  const api = { DEFAULT_MIN, MIN_BOX_MIN, WEEK, ymdOfMs, minOfMs, parts, ymdOf, addDays, dow, diffDays, weekStart, atMs, addMonths, todayOf,
    monthGrid, monthChips, monthTitle, weekTitle, eventOf, eventsFrom, overlapping, onDay, layoutWeek, dayColumns, weekView,
    swipeDir, prefillAt, weekdayOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CalendarLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
