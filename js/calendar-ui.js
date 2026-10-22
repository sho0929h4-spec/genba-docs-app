// js/calendar-ui.js — カレンダー表示（Task 38。見本: Googleカレンダーのスマホ画面 docs/mocks/ref/gcal-month.webp・gcal-week.webp。色はこのアプリの明るい配色）
// 管理者: 上の切替（案件一覧／チーム状況／やること／カレンダー）の #calendar。全員の予定・予定に担当者名。予定を押すとフェーズ詳細、＋は新規案件。
// 作業担当者: 「案件」タブ（#f）の上の「一覧／カレンダー」（js/field-ui.js が calMount を呼ぶ）。自分が担当の予定だけ。予定を押すとツールページ、
//   ＋は案件の登録（押した日があればその日を訪問日時の初期値）。
// 月表示: 「10月 ▾」・月のチップ（横にスクロール・年の区切り）・曜日の行・6週のマス・予定の帯（複数日は1本・はみ出す分は「+N」）・今日は丸。
//   日を押すとその週の週表示。週表示: 上に7日・複数日の帯の段・時間の枠（0:00〜23:00）・今の時刻の線。開くと今の時刻あたりまでスクロール。
// 「10月 ▾」→ 月／週。右上の今日のボタン（四角に今日の日付）。左右スワイプ（PC は ‹ ›）で前後。月／週の選択は端末に覚える（localStorage・try/catch）。
// 日時未定のフェーズは出さずに「日時未定 N件 ›」（押すと opts.onUndated）。配置の計算は js/calendar-logic.js（テストあり）
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。mk() は case-list.js、$ / showScreen / renderHeaders / setMsg は app.js

const CAL_HOUR_H = 44;   // 週表示の1時間の高さ（px）
const CAL_DAY_HEAD = 26; // 月のマスの日付の行の高さ
const CAL_BAR_H = 19;    // 帯1段の高さ（間を含む）
let cal = null;          // { root, opts, events, undated, mode, anchor, sel, timer }
const calMem = { mode: '', anchor: '', sel: null }; // 画面を離れても覚えておく（この画面を開いている間）

const calUid = () => (typeof ctx !== 'undefined' && ctx && ctx.user ? ctx.user.id : '');
const calModeKey = () => 'genba-docs.calmode.' + calUid();
function calModePref() {
  try { const v = localStorage.getItem(calModeKey()); return v === 'week' ? 'week' : v === 'month' ? 'month' : ''; } catch (e) { return ''; }
}
function setCalModePref(v) {
  try { localStorage.setItem(calModeKey(), v); } catch (e) { /* 使えない端末ではこの画面の間だけ */ }
}
const calToday = () => CalendarLogic.todayOf(Date.now());
const calBtn = (text, cls, onClick) => {
  const b = mk('button', cls, text);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
};
const calHM = min => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;

// host（画面に入っている要素）にカレンダーを出す。opts:
//   rows（case_summaries）, include(c, p), titleOf(c, p), showWho（担当者名を出す）, onEvent(ev), onUndated(undated), onAdd(sel),
//   bottom（下に固定のバーがあればその高さ px）, fab（＋を自分で出すか。現場用は field-ui の ＋ を使う）
function calMount(host, opts) {
  const o = opts || {};
  if (cal && cal.timer) clearInterval(cal.timer);
  const { events, undated } = CalendarLogic.eventsFrom(o.rows || [], { include: o.include, titleOf: o.titleOf });
  const root = mk('div', 'cal');
  root.id = 'cal';
  host.replaceChildren(root);
  cal = { root, opts: o, events, undated, mode: calMem.mode || calModePref() || 'month', anchor: calMem.anchor || calToday(), sel: calMem.sel, timer: null };
  calDraw();
  cal.timer = setInterval(() => {
    if (!cal || !cal.root.isConnected) { if (cal) clearInterval(cal.timer); return; }
    calNowLine();
  }, 60000);
  calSwipe(root);
  return root;
}
// ＋で使う押した日（無ければ null）→ { ymd, hour }
function calSelection() { return cal && cal.root.isConnected && cal.sel ? Object.assign({}, cal.sel) : null; }

function calSet(patch) {
  Object.assign(cal, patch);
  calMem.mode = cal.mode; calMem.anchor = cal.anchor; calMem.sel = cal.sel;
  calDraw(patch.mode !== undefined || patch.anchor !== undefined);
}
function calSetMode(mode) {
  setCalModePref(mode);
  calSet({ mode });
}
// 前後の月／週（押した日は消す）
function calStep(dir) {
  const L = CalendarLogic;
  if (cal.mode === 'week') calSet({ anchor: L.addDays(L.weekStart(cal.anchor), 7 * dir), sel: null });
  else {
    const p = L.parts(cal.anchor);
    const n = L.addMonths(p.y, p.m, dir);
    calSet({ anchor: L.ymdOf(n.y, n.m, 1), sel: null });
  }
}
function calGoToday() { calSet({ anchor: calToday(), sel: null }); }

function calSwipe(root) {
  let x0 = null, y0 = 0;
  root.addEventListener('touchstart', ev => {
    if (ev.touches.length !== 1 || ev.target.closest('.cal-chips')) { x0 = null; return; } // 月のチップは横にスクロールするので除く
    x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY;
  }, { passive: true });
  root.addEventListener('touchend', ev => {
    if (x0 == null) return;
    const t = ev.changedTouches[0];
    const d = CalendarLogic.swipeDir(t.clientX - x0, t.clientY - y0);
    x0 = null;
    if (d) calStep(d);
  }, { passive: true });
}

/* ---------- 描画 ---------- */
function calDraw(scrollToNow) {
  const L = CalendarLogic;
  const root = cal.root;
  const today = calToday();
  const tp = L.parts(today);
  const ap = L.parts(cal.anchor);
  const prevSc = root.querySelector('#cal-scroll');
  if (prevSc) cal.scrollTop = prevSc.scrollTop; // 描き直しても時間の枠のスクロール位置を保つ
  root.dataset.mode = cal.mode;
  root.replaceChildren();

  // 上の行: 「10月 ▾」 … 日時未定 N件 › ・ ‹ › ・ 今日
  const top = mk('div', 'cal-top');
  const title = cal.mode === 'week' ? L.weekTitle(L.weekStart(cal.anchor), Date.now()) : L.monthTitle(ap.y, ap.m, Date.now());
  const tb = calBtn('', 'cal-title', () => calMenu(top));
  tb.id = 'cal-title';
  tb.setAttribute('aria-haspopup', 'menu');
  tb.setAttribute('aria-label', title + '（月／週を切り替える）');
  tb.appendChild(mk('span', null, title));
  tb.appendChild(mk('span', 'cal-caret', '▾'));
  top.appendChild(tb);
  top.appendChild(mk('span', 'cal-sp'));
  if (cal.undated.length) {
    const u = calBtn('日時未定 ' + cal.undated.length + '件 ›', 'cal-undated', () => { if (cal.opts.onUndated) cal.opts.onUndated(cal.undated); });
    u.id = 'cal-undated';
    top.appendChild(u);
  }
  const prev = calBtn('‹', 'cal-nav', () => calStep(-1));
  prev.id = 'cal-prev';
  prev.setAttribute('aria-label', cal.mode === 'week' ? '前の週' : '前の月');
  const next = calBtn('›', 'cal-nav', () => calStep(1));
  next.id = 'cal-next';
  next.setAttribute('aria-label', cal.mode === 'week' ? '次の週' : '次の月');
  const td = calBtn('', 'cal-today', calGoToday);
  td.id = 'cal-today';
  td.setAttribute('aria-label', '今日（' + tp.m + '/' + tp.d + '）へ');
  td.title = '今日';
  td.appendChild(mk('span', 'cal-today-n', String(tp.d)));
  top.append(prev, next, td);
  root.appendChild(top);

  if (cal.mode === 'week') calDrawWeek(root, today, scrollToNow);
  else calDrawMonth(root, today);

  if (cal.opts.fab) {
    const fab = calBtn('＋', 'fd-fab cal-fab', () => { if (cal.opts.onAdd) cal.opts.onAdd(calSelection()); });
    fab.id = 'cal-add';
    fab.setAttribute('aria-label', cal.opts.addLabel || '追加');
    fab.title = cal.opts.addLabel || '追加';
    root.appendChild(fab);
  }
}

// 「10月 ▾」の下の 月／週（入力の無い小さなメニュー。外を押すと閉じる）
function calMenu(top) {
  const old = top.querySelector('.cal-menu');
  if (old) { old.remove(); return; }
  const m = mk('div', 'cal-menu');
  m.id = 'cal-menu';
  m.setAttribute('role', 'menu');
  [['month', '月'], ['week', '週']].forEach(([k, label]) => {
    const b = calBtn(label, 'cal-menu-i' + (cal.mode === k ? ' on' : ''), () => { m.remove(); if (cal.mode !== k) calSetMode(k); });
    b.dataset.mode = k;
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', cal.mode === k ? 'true' : 'false');
    m.appendChild(b);
  });
  top.appendChild(m);
  setTimeout(() => {
    const off = ev => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('click', off, true); } };
    document.addEventListener('click', off, true);
  }, 0);
}

// 画面の下までの高さ（px）
function calAvail(el) {
  const top = el.getBoundingClientRect().top + window.scrollY;
  return Math.floor(window.innerHeight - top - (cal.opts.bottom || 0) - 8);
}

function calBar(ev, cls) {
  const b = calBtn('', 'cal-ev k-' + ev.kind + (ev.done ? ' done' : '') + (cls ? ' ' + cls : ''), e => { e.stopPropagation(); if (cal.opts.onEvent) cal.opts.onEvent(ev); });
  b.dataset.phaseId = ev.id;
  b.dataset.caseId = ev.caseId;
  const label = ev.title || '（物件名なし）';
  b.appendChild(mk('span', 'cal-ev-t', label));
  if (cal.opts.showWho && ev.who) b.appendChild(mk('span', 'cal-ev-who', ev.who));
  const md = ymd => `${+ymd.slice(5, 7)}/${+ymd.slice(8, 10)}`;
  const when = ev.multi ? `${md(ev.startYmd)} ${calHM(ev.startMin)}〜${md(ev.endYmd)}` : calHM(ev.startMin) + (ev.hasEnd ? '〜' + calHM(ev.endMin) : '');
  const tip = [label, PhaseLogic.kindLabel(ev.kind), when, cal.opts.showWho ? '担当 ' + (ev.who || 'なし') : ''].filter(Boolean).join(' ・ ');
  b.title = tip;
  b.setAttribute('aria-label', tip);
  return b;
}

/* ---------- 月表示 ---------- */
function calDrawMonth(root, today) {
  const L = CalendarLogic;
  const ap = L.parts(cal.anchor);
  const tp = L.parts(today);
  // 月のチップ（横にスクロール。年の区切りに「2027」）
  const chips = mk('div', 'cal-chips');
  chips.id = 'cal-chips';
  L.monthChips({ y: tp.y, m: tp.m }, { y: ap.y, m: ap.m }, 3, 12).forEach(x => {
    if (x.type === 'year') { chips.appendChild(mk('span', 'cal-year', String(x.y))); return; }
    const c = calBtn(x.m + '月', 'cal-chip' + (x.on ? ' on' : ''), () => calSet({ anchor: L.ymdOf(x.y, x.m, 1), sel: null }));
    c.dataset.ym = x.y + '-' + String(x.m).padStart(2, '0');
    chips.appendChild(c);
  });
  root.appendChild(chips);
  const on = chips.querySelector('.cal-chip.on');
  if (on) chips.scrollLeft = Math.max(0, on.offsetLeft - chips.offsetLeft - 10);

  const grid = L.monthGrid(ap.y, ap.m);
  const inView = grid.some(w => w.some(d => d.ymd === today));
  root.appendChild(calWeekdays(inView ? L.dow(today) : -1, 'cal-wd'));

  const month = mk('div', 'cal-month');
  month.id = 'cal-month';
  root.appendChild(month);
  const minRow = window.innerWidth >= 700 ? 96 : 72;
  const rowH = Math.max(minRow, Math.floor(calAvail(month) / 6));
  const lanes = Math.max(1, Math.floor((rowH - CAL_DAY_HEAD - 2) / CAL_BAR_H));
  grid.forEach(week => {
    const ws = week[0].ymd;
    const lay = L.layoutWeek(cal.events, ws, lanes);
    const row = mk('div', 'cal-wk');
    row.dataset.week = ws;
    row.style.height = rowH + 'px';
    row.style.gridTemplateRows = `${CAL_DAY_HEAD}px repeat(${lanes}, ${CAL_BAR_H}px) 1fr`;
    week.forEach((d, i) => {
      const cell = calBtn('', 'cal-day' + (d.inMonth ? '' : ' out') + (d.ymd === today ? ' today' : '') + (cal.sel && cal.sel.ymd === d.ymd ? ' sel' : ''),
        () => calSet({ mode: 'week', anchor: d.ymd, sel: { ymd: d.ymd, hour: null } }));
      cell.style.gridColumn = String(i + 1);
      cell.dataset.ymd = d.ymd;
      cell.setAttribute('aria-label', `${d.m}月${d.d}日（${L.WEEK[i]}）の週を見る`);
      cell.appendChild(mk('span', 'cal-dn', String(d.d)));
      row.appendChild(cell);
    });
    lay.bars.forEach(b => {
      const el = calBar(b.ev, (b.contL ? 'cl' : '') + (b.contR ? ' cr' : ''));
      el.style.gridColumn = `${b.col + 1} / span ${b.span}`;
      el.style.gridRow = String(b.lane + 2);
      row.appendChild(el);
    });
    lay.more.forEach((n, i) => {
      if (!n) return;
      const d = week[i];
      const more = calBtn('+' + n, 'cal-more', () => calSet({ mode: 'week', anchor: d.ymd, sel: { ymd: d.ymd, hour: null } }));
      more.style.gridColumn = String(i + 1);
      more.style.gridRow = String(lanes + 1);
      more.dataset.ymd = d.ymd;
      more.setAttribute('aria-label', `ほか${n}件（${d.m}/${d.d}）`);
      row.appendChild(more);
    });
    month.appendChild(row);
  });
}

function calWeekdays(todayDow, cls) {
  const wd = mk('div', cls);
  CalendarLogic.WEEK.split('').forEach((w, i) => wd.appendChild(mk('span', i === todayDow ? 'on' : null, w)));
  return wd;
}

/* ---------- 週表示 ---------- */
function calDrawWeek(root, today, scrollToNow) {
  const L = CalendarLogic;
  const ws = L.weekStart(cal.anchor);
  const view = L.weekView(cal.events, ws, 3);
  const todayCol = view.days.indexOf(today);

  // 上の7日（今日は丸）
  const head = mk('div', 'cal-wh');
  head.id = 'cal-wh';
  head.appendChild(mk('span', 'cal-gut'));
  view.days.forEach((ymd, i) => {
    const p = L.parts(ymd);
    const b = calBtn('', 'cal-whd' + (ymd === today ? ' today' : '') + (cal.sel && cal.sel.ymd === ymd ? ' sel' : ''),
      () => calSet({ sel: { ymd, hour: null } }));
    b.dataset.ymd = ymd;
    b.setAttribute('aria-label', `${p.m}月${p.d}日（${L.WEEK[i]}）を選ぶ`);
    b.appendChild(mk('span', 'cal-whw', L.WEEK[i]));
    b.appendChild(mk('span', 'cal-whn', String(p.d)));
    head.appendChild(b);
  });
  root.appendChild(head);

  // 終日・複数日の帯の段
  const ad = mk('div', 'cal-allday');
  ad.id = 'cal-allday';
  const adLanes = view.allDay.lanes;
  ad.style.gridTemplateRows = adLanes ? `repeat(${adLanes}, ${CAL_BAR_H}px)` : '6px';
  view.allDay.bars.forEach(b => {
    const el = calBar(b.ev, (b.contL ? 'cl' : '') + (b.contR ? ' cr' : ''));
    el.style.gridColumn = `${b.col + 2} / span ${b.span}`;
    el.style.gridRow = String(b.lane + 1);
    ad.appendChild(el);
  });
  view.allDay.more.forEach((n, i) => {
    if (!n) return;
    const m = mk('span', 'cal-more', '+' + n);
    m.style.gridColumn = String(i + 2);
    m.style.gridRow = String(adLanes);
    ad.appendChild(m);
  });
  root.appendChild(ad);

  // 時間の枠（0:00〜23:00）
  const sc = mk('div', 'cal-scroll');
  sc.id = 'cal-scroll';
  root.appendChild(sc);
  sc.style.height = Math.max(240, calAvail(sc)) + 'px';
  const inner = mk('div', 'cal-tg');
  inner.style.height = (24 * CAL_HOUR_H + 16) + 'px';
  const gut = mk('div', 'cal-hours');
  for (let h = 0; h < 24; h++) {
    const t = mk('span', 'cal-hl', h + ':00');
    t.style.top = (8 + h * CAL_HOUR_H) + 'px';
    gut.appendChild(t);
  }
  inner.appendChild(gut);
  view.days.forEach((ymd, i) => {
    const col = mk('div', 'cal-col' + (ymd === today ? ' today' : ''));
    col.dataset.ymd = ymd;
    col.addEventListener('click', ev => {
      if (ev.target !== col) return;
      const y = ev.clientY - col.getBoundingClientRect().top - 8;
      const hour = Math.max(0, Math.min(23, Math.floor(y / CAL_HOUR_H)));
      calSet({ sel: { ymd, hour } });
    });
    if (cal.sel && cal.sel.ymd === ymd && cal.sel.hour != null) {
      const s = mk('div', 'cal-slot');
      s.style.top = (8 + cal.sel.hour * CAL_HOUR_H) + 'px';
      s.style.height = CAL_HOUR_H + 'px';
      s.appendChild(mk('span', null, calHM(cal.sel.hour * 60) + '〜'));
      col.appendChild(s);
    }
    const colW = (sc.clientWidth - 44) / 7;
    view.columns[i].forEach(x => {
      // 狭い箱（スマホで2つ以上並ぶ）は1文字ずつ折り返さず、行ごとに切る（縦書きのように見えないように）
      const el = calBar(x.ev, 'box' + (x.cols > 1 && colW / x.cols < 56 ? ' narrow' : ''));
      el.style.top = (8 + x.top * CAL_HOUR_H / 60) + 'px';
      el.style.height = Math.max(16, (x.bottom - x.top) * CAL_HOUR_H / 60 - 2) + 'px';
      el.style.left = `calc(${(x.col / x.cols) * 100}% + 1px)`;
      el.style.width = `calc(${100 / x.cols}% - 3px)`;
      if (x.bottom - x.top >= 45 && colW >= 80) el.appendChild(mk('span', 'cal-ev-tm', calHM(x.ev.startMin) + (x.ev.hasEnd ? '〜' + calHM(x.ev.endMin) : '')));
      col.appendChild(el);
    });
    if (i === todayCol) {
      const line = mk('div', 'cal-now');
      line.id = 'cal-now';
      col.appendChild(line);
    }
    inner.appendChild(col);
  });
  sc.appendChild(inner);
  calNowLine();
  // 開いたら今の時刻あたり（今日の週でなければ最初の予定か 8:00）までスクロール
  if (scrollToNow !== false) {
    let min = 8 * 60;
    if (todayCol >= 0) min = CalendarLogic.minOfMs(Date.now());
    else {
      const first = view.columns.flat().map(x => x.top).sort((a, b) => a - b)[0];
      if (first != null) min = first;
    }
    sc.scrollTop = Math.max(0, 8 + min * CAL_HOUR_H / 60 - sc.clientHeight / 3);
  } else if (cal.scrollTop != null) sc.scrollTop = cal.scrollTop;
}
function calNowLine() {
  const line = cal && cal.root.querySelector('#cal-now');
  if (!line) return;
  line.style.top = (8 + CalendarLogic.minOfMs(Date.now()) * CAL_HOUR_H / 60) + 'px';
}

// 画面の大きさが変わったら描き直す（スマホのアドレスバーの出入りのような小さな高さの変化では描き直さない。続けて来たら最後の1回）
let calSize = { w: window.innerWidth, h: window.innerHeight };
let calResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(calResizeTimer);
  calResizeTimer = setTimeout(() => {
    const w = window.innerWidth, h = window.innerHeight;
    if (w === calSize.w && Math.abs(h - calSize.h) < 80) return;
    calSize = { w, h };
    if (cal && cal.root.isConnected) calDraw(false);
  }, 150);
});

/* ---------- 管理者のカレンダー（#calendar） ---------- */
let calAdminSeq = 0;
async function openCalendar() {
  renderHeaders();
  showScreen('calendar');
  if (location.hash !== '#calendar') history.replaceState(null, '', location.pathname + location.search + '#calendar');
  setMsg('cal-msg', '');
  const seq = ++calAdminSeq;
  const host = $('cal-root');
  host.replaceChildren(mk('div', 'empty', '読み込み中…'));
  let rows = null;
  try { rows = (await CasesApi.listSummaries()) || []; }
  catch (e) {
    if (seq !== calAdminSeq) return;
    setMsg('cal-msg', 'カレンダーの読み込みに失敗しました: ' + (e && e.message ? e.message : e));
    host.replaceChildren(calBtn('再読み込み', 'btn sm ghost inline', () => openCalendar()));
    return;
  }
  if (seq !== calAdminSeq || !$('screen-calendar').classList.contains('active')) return;
  calMount(host, {
    rows,
    titleOf: c => PhaseLogic.placeName(c) || '（物件名なし）',
    showWho: true,
    fab: true,
    addLabel: '新規案件',
    onEvent: ev => { location.hash = '#case/' + ev.caseId + '/phase/' + ev.id; },
    onAdd: () => openCaseModal(null),
    onUndated: list => calUndatedSheet(list)
  });
}

// 管理者の「日時未定 N件 ›」: 一覧（物件名 号室・フェーズ・担当者 → 押すとフェーズ詳細）。入力の無いシート。閉じるのは ×
function calUndatedSheet(list) {
  const prev = document.getElementById('cal-undated-sheet');
  if (prev) prev.remove();
  const bg = mk('div', 'modal-bg ph-sheet-bg');
  bg.id = 'cal-undated-sheet';
  const dlg = mk('div', 'modal ph-sheet');
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-labelledby', 'cal-ud-title');
  const hd = mk('div', 'modal-hd');
  const h = mk('h3', null, '日時未定 ' + list.length + '件');
  h.id = 'cal-ud-title';
  const x = calBtn('×', 'modal-x', () => bg.remove());
  x.setAttribute('aria-label', '閉じる');
  hd.append(h, x);
  dlg.appendChild(hd);
  dlg.appendChild(mk('div', 'rep-sub', 'カレンダーに出ていない対応です。押すとその対応の詳しいページで日時を決められます'));
  const box = mk('div', 'cal-ud-list');
  list.forEach(({ caseRow: c, phase: p }) => {
    const b = calBtn('', 'cal-ud-row', () => { bg.remove(); location.hash = '#case/' + c.id + '/phase/' + p.id; });
    b.dataset.phaseId = p.id;
    const t = mk('span', 'cal-ud-top');
    t.appendChild(mk('span', 'ph-kind k-' + p.kind, PhaseLogic.kindLabel(p.kind)));
    t.appendChild(mk('b', null, PhaseLogic.placeName(c) || '（物件名なし）'));
    b.appendChild(t);
    b.appendChild(mk('span', 'rep-sub', PhaseLogic.phaseTitle(p) + ' ・ 担当 ' + (p.worker_name || 'なし')));
    box.appendChild(b);
  });
  dlg.appendChild(box);
  bg.appendChild(dlg);
  document.body.appendChild(bg);
  x.focus();
}
// 日時未定のシートを開いたまま戻る・進むをしたら閉じる（次の画面の上に残さない）
window.addEventListener('hashchange', () => { const s = document.getElementById('cal-undated-sheet'); if (s) s.remove(); });
