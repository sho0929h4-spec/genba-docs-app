// js/schedule-ui.js — 日程調整（Task 50。DB は migration 069、文言と判定は PhaseLogic の sched*）の画面の部品
//   schOfferForm  … 候補の日時の欄（1つ以上・開始と終わり）。1つなら「この日時で確定」、2つ以上なら「候補を送る」（管理者・自分で登録した案件の本人）
//   schCondForm   … 入居者の都合（いつでもよい／曜日と時間帯（複数）／自由記載）→ 作業担当者が候補を出す
//   schProposeForm… 作業担当者が候補を 1〜3 つ出す（入居者の都合の外なら注意。出すことはできる）
//   schStatusEl   … 今の日程調整の1行（案件ページの日時の欄・現場用のツールページ）
//   schCardEl     … トークのカード（候補・条件・希望・確定。今のカードだけボタンが押せる・処理済みは灰色）
//   schSheet      … 現場用の「日程を変える」のシート（× だけで閉じる）
//   schRun        … 関数を呼んで、管理者なら連絡メールの下書き（日時を決めた・消した）をそろえる
// Task 70: 手入力（スイッチ false）の欄は、調査なら終了予定に 開始＋N分、原因元工事・復旧工事なら見積書の工事時間（TravelUi）。
//   管理者が担当者のいる対応の日時を決めるときは、移動の時間の確認（TravelUi.check）を挟む
// 日時の欄は日本時間（phToInput / phFromInput は phase-ui.js）。mk は case-list.js、dBtn / errText は case-detail.js
// ユーザー入力は createElement + textContent / value で描画する（innerHTML は使わない）。alert/confirm は使わない

/* ---------- 共通 ---------- */
// Task 53: 作業担当者の確定した予定（全案件の case_summaries。20秒は使い回す）→ 重なりの判定（PhaseLogic.busyOf / startOptions）
let schBusyCache = null;
function schBusyRows() {
  if (!schBusyCache || Date.now() - schBusyCache.at > 20000) {
    schBusyCache = { at: Date.now(), p: CasesApi.listSummaries().catch(e => { console.warn('ほかの予定を読み込めませんでした', e); return []; }) };
  }
  return schBusyCache.p;
}
// 作業担当者の予定（この対応は除く）の Promise。作業担当者がいなければ []
const schBusyFor = (workerId, phaseId) => (workerId ? schBusyRows().then(rows => PhaseLogic.busyOf(rows, workerId, phaseId)) : Promise.resolve([]));

// 所要時間（Task 53。対応ごとに1つ）: 「時間」（30分きざみ）か「日数」（○日間・毎日 ○時〜○時）。o: { dur（初期値）, onChange }
//   → { el, mode() → 'mins'|'days', get() → dur か null, read() → { dur, err } }
function schDurEl(o) {
  const box = mk('div', 'sch-dur');
  box.appendChild(mk('b', 'sch-h', '所要時間'));
  const x0 = PhaseLogic.normDur(o.dur);
  let mode = x0 && x0.days ? 'days' : 'mins';
  const mkSel = (cls, label, items, v) => {
    const sel = document.createElement('select');
    sel.className = cls;
    sel.setAttribute('aria-label', label);
    items.forEach(([val, text]) => { const op = document.createElement('option'); op.value = val; op.textContent = text; sel.appendChild(op); });
    sel.value = v;
    return sel;
  };
  const mkTime = (cls, label, v) => { const i = document.createElement('input'); i.type = 'time'; i.step = 1800; i.className = cls; i.value = v; i.setAttribute('aria-label', label); return i; };
  const hours = mkSel('sch-dur-mins', '所要時間', [['', '選んでください']].concat(Array.from({ length: 24 }, (_, i) => [String((i + 1) * 30), PhaseLogic.durText({ mins: (i + 1) * 30 })])),
    x0 && x0.mins ? String(x0.mins) : '');
  const days = mkSel('sch-dur-days', '日数', Array.from({ length: 14 }, (_, i) => [String(i + 1), (i + 1) + '日間']), x0 && x0.days ? String(x0.days) : '2');
  const from = mkTime('sch-dur-from', '毎日 何時から', (x0 && x0.from) || '09:00');
  const to = mkTime('sch-dur-to', '毎日 何時まで', (x0 && x0.to) || '17:00');
  const dRow = mk('div', 'sch-dur-row');
  dRow.append(days, mk('span', 'sch-tilde', '毎日'), from, mk('span', 'sch-tilde', '〜'), to);
  const modes = mk('div', 'sch-dur-modes');
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', '所要時間の決め方');
  const changed = () => { if (o.onChange) o.onChange(); };
  const btns = [['mins', '時間'], ['days', '日数']].map(([m, label]) => {
    const b = dBtn(label, 'sch-chip sch-dur-mode', () => { if (mode !== m) { mode = m; sync(); changed(); } });
    b.dataset.mode = m;
    return b;
  });
  const sync = () => {
    btns.forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    hours.hidden = mode !== 'mins';
    dRow.hidden = mode !== 'days';
  };
  btns.forEach(b => modes.appendChild(b));
  [hours, days, from, to].forEach(i => i.addEventListener('change', changed));
  box.append(modes, hours, dRow);
  sync();
  const get = () => PhaseLogic.normDur(mode === 'mins' ? { mins: Number(hours.value) || 0 } : { days: Number(days.value) || 0, from: from.value, to: to.value });
  return {
    el: box,
    mode: () => mode,
    get,
    read() {
      const dur = get();
      if (dur) return { dur, err: '' };
      (mode === 'mins' ? hours : from).focus();
      return { dur: null, err: mode === 'mins' ? '所要時間を選んでください' : '毎日の時間（何時から何時まで）を入れてください' };
    }
  };
}

// 候補の行（いつから・いつまで = 空いている時間）。o: { max, start, end（最初の行の初期値 ISO）, cond（入居者の都合 → 外なら注意）,
//   dur（schDurEl。日数なら日付の欄になり、毎日の時刻を付ける）, busy（作業担当者の予定の Promise → 空きなし・重なりの注意）,
//   firstCls（最初の行の欄に既存の class: ph-sched-start / ph-sched-end）, plain（Task 58: スイッチ false の手入力。文言が「開始」「終わり」）, onChange }
//   → { el, read(need) → { slots: [{start, end}], err }, count(), check() }。need = 'offer'（いつまで必須）か 'confirm'
function schSlotRows(o) {
  const box = mk('div', 'sch-rows');
  const rows = [];
  let busy = null;
  const days = () => !!o.dur && o.dur.mode() === 'days';
  const dur = () => (o.dur ? o.dur.get() : null);
  const ymdAt = (v, hm) => (/^\d{4}-\d{2}-\d{2}$/.test(v) && /^\d{2}:\d{2}$/.test(hm || '') ? phFromInput(v + 'T' + hm) : null);
  // 行の値 → { start, end }（日数のときは 最初の日の from 〜 最後の日の to）
  const valOf = it => {
    if (o.plain) return { start: it.st.get(), end: it.en.get(it.st.date.value) }; // Task 67: 終了予定の日が空なら開始の日
    const d = dur();
    if (days()) return { start: ymdAt(it.st.value, d ? d.from : ''), end: it.en.value ? ymdAt(it.en.value, d ? d.to : '') : null };
    return { start: phFromInput(it.st.value), end: it.en.value ? phFromInput(it.en.value) : null };
  };
  const setType = it => {
    if (o.plain) return;
    const want = days() ? 'date' : 'datetime-local';
    [it.st, it.en].forEach(i => {
      if (i.type === want) return;
      const v = i.value;
      i.type = want;
      i.value = want === 'date' ? v.slice(0, 10) : v ? v + 'T09:00' : '';
    });
  };
  const checkRow = it => {
    const v = valOf(it);
    const d = dur();
    let text = o.cond && v.start ? PhaseLogic.schedOutside(o.cond, v.start, v.end) : '';
    if (busy && v.start) {
      if (v.end && d) {
        const opts = PhaseLogic.startOptions(v, d, busy);
        if (opts.length && !opts.some(x => !x.clash)) text = [text, '空きなし（' + PhaseLogic.clashText(opts[0].clash) + '）'].filter(Boolean).join('・');
      } else {
        const cl = PhaseLogic.clashOf(v.start, v.end || PhaseLogic.durEnd(v.start, d), busy);
        if (cl) text = [text, PhaseLogic.clashText(cl)].filter(Boolean).join('・');
      }
    }
    it.warn.textContent = text;
    it.warn.hidden = !text;
  };
  const add = (startIso, endIso) => {
    const r = mk('div', 'sch-row');
    const n = rows.length + 1;
    const mkIn = (cls, iso) => { const i = document.createElement('input'); i.type = 'datetime-local'; i.step = 1800; i.className = cls; i.value = phToInput(iso); return i; };
    // Task 67: スイッチ false は日付と時刻（30分きざみ）を別の欄に（DtInput）。終了予定は空のまま（自動で入れない）
    const mkDt = (cls, iso, label) => DtInput.el({ cls, iso, label });
    const cls = (c, i) => c + (rows.length === 0 && o.firstCls ? ' ' + o.firstCls[i] : '');
    const st = o.plain ? mkDt(cls('sch-start', 0), startIso, '開始') : mkIn(cls('sch-start', 0), startIso);
    const en = o.plain ? mkDt(cls('sch-end', 1), endIso, '終了予定') : mkIn(cls('sch-end', 1), endIso);
    // Task 58: スイッチ false（1つだけ・手で入れる）は「開始」「終了予定（任意）」。日付と時刻の2つの欄なので label ではなく div
    const l1 = mk(o.plain ? 'div' : 'label', null, o.max > 1 ? '候補' + n + ' いつから' : o.plain ? '開始' : 'いつから');
    l1.appendChild(o.plain ? st.el : st);
    const l2 = mk(o.plain ? 'div' : 'label', null, o.plain ? '終了予定（任意）' : 'いつまで');
    l2.appendChild(o.plain ? en.el : en);
    const warn = mk('div', 'sch-warn');
    warn.setAttribute('role', 'status');
    r.append(l1, l2, warn);
    const item = { r, st, en, warn };
    [st, en].forEach(i => (i.el || i).addEventListener('input', () => { checkRow(item); if (o.onChange) o.onChange(); }));
    if (o.plain) TravelUi.surveyEnd(st, en, () => o.kind); // Task 70: 調査だけ、開始を入れて終了予定が空なら 開始＋N分
    if (rows.length > 0) {
      r.appendChild(dBtn('この候補を消す', 'linkbtn sch-del', () => { rows.splice(rows.indexOf(item), 1); r.remove(); sync(); if (o.onChange) o.onChange(); }));
    }
    rows.push(item);
    setType(item);
    checkRow(item);
    box.insertBefore(r, more);
    sync();
    return item;
  };
  const more = dBtn('＋ 候補を足す', 'linkbtn sch-more', () => { const it = add(null, null); it.st.focus(); if (o.onChange) o.onChange(); });
  box.appendChild(more);
  const sync = () => { more.hidden = rows.length >= o.max; };
  add(o.start || null, o.end || null);
  if (o.busy) o.busy.then(b => { busy = b || []; rows.forEach(checkRow); }, () => {});
  return {
    el: box,
    count: () => rows.length,
    check() { rows.forEach(it => { setType(it); checkRow(it); }); },
    busy: () => busy,
    first: () => rows[0], // Task 70: 見積書の工事時間を入れる（手入力の1行目）
    read(need) {
      const slots = [];
      for (const it of rows) {
        const v = valOf(it);
        const n = rows.indexOf(it) + 1;
        if (!v.start) { it.st.focus(); return { err: o.plain ? '開始の日付と時刻を選んでください' : '候補の日時を入れてください（使わない欄は「この候補を消す」）' }; }
        if (need === 'offer' && !v.end) { it.en.focus(); return { err: (rows.length > 1 ? '候補' + n + 'の' : '') + '「いつまで」を入れてください（空いている時間の終わり）' }; }
        if (v.end && Date.parse(v.end) <= Date.parse(v.start)) { it.en.focus(); return { err: o.plain ? '終了予定は開始より後にしてください' : '「いつまで」は「いつから」より後にしてください' }; }
        if (need === 'offer' && dur() && !PhaseLogic.slotStarts(v, dur()).length) {
          it.en.focus();
          return { err: (rows.length > 1 ? '候補' + n + 'の' : '') + '空いている時間が所要時間（' + PhaseLogic.durText(dur()) + '）より短いです' };
        }
        slots.push(v);
      }
      return { slots, err: '' };
    }
  };
}

// 時間帯の中で始まりを選ぶ（Task 53。30分きざみ・日数は日ごと）。重なる始まりは灰色「○○ 501号室と重なります」、全部重なれば fullText。
//   o: { slot, dur, busy（作業担当者の予定の Promise。無ければ重なりを見ない）, cls, can（押せるか）, fullText, label(opt) → ボタンの文, err, onPick(opt, btn) → Promise }
function schPickEl(o) {
  const box = mk('div', 'sch-pickbox');
  box.appendChild(mk('div', 'sch-win', PhaseLogic.windowText(o.slot, o.dur)));
  const body = mk('div', 'sch-pick-body');
  box.appendChild(body);
  const draw = busy => {
    const opts = PhaseLogic.startOptions(o.slot, o.dur, busy || []);
    const free = opts.filter(x => !x.clash);
    body.replaceChildren();
    if (!free.length) {
      const first = opts[0] || o.slot;
      body.appendChild(mk('div', 'sch-full', o.fullText + (first.clash ? '（' + PhaseLogic.clashText(first.clash) + '）' : '')));
      const b = dBtn(o.label(first), 'sch-btn ' + o.cls, () => {});
      b.disabled = true;
      b.dataset.start = first.start || '';
      body.appendChild(b);
      box.dataset.full = '1';
      return;
    }
    delete box.dataset.full;
    let cur = free[0];
    const b = schBusyBtn(o.label(cur), 'sch-btn ' + o.cls, o.err, () => o.onPick(cur, b));
    b.dataset.start = cur.start;
    if (opts.length > 1) {
      // 始まりの時刻のボタン（30分きざみ。重なる時刻は灰色で押せない）。1日の中なら「9:30」、日をまたぐ・日数なら「10/30（金）9:30」
      const oneDay = PhaseLogic.jstYmd(opts[0].start) === PhaseLogic.jstYmd(opts[opts.length - 1].start) && !(o.dur && o.dur.days);
      const sts = mk('div', 'sch-sts');
      sts.setAttribute('role', 'group');
      sts.setAttribute('aria-label', '始まりの時刻');
      const chips = opts.map(x => {
        const c = dBtn(oneDay ? PhaseLogic.fmtMDHM(x.start).split(' ')[1] : PhaseLogic.fmtMDWHM(x.start), 'sch-st', () => {
          cur = x;
          chips.forEach(y => { y.classList.toggle('on', y === c); y.setAttribute('aria-pressed', y === c ? 'true' : 'false'); });
          b.textContent = o.label(cur);
          b.dataset.start = cur.start;
        });
        c.dataset.start = x.start;
        c.disabled = !!x.clash || !o.can;
        if (x.clash) c.title = PhaseLogic.clashText(x.clash);
        c.classList.toggle('on', x === cur);
        c.setAttribute('aria-pressed', x === cur ? 'true' : 'false');
        return c;
      });
      chips.forEach(c => sts.appendChild(c));
      body.appendChild(sts);
      const places = [...new Set(opts.filter(x => x.clash).map(x => x.clash.place))];
      if (places.length) body.appendChild(mk('div', 'sch-warn sch-clash', places.map(x => x + 'と重なります').join('・') + '（灰色の時刻は選べません）'));
    }
    if (!o.can) b.disabled = true;
    body.appendChild(b);
  };
  if (o.busy) {
    body.appendChild(mk('div', 'ph-sub sch-loading', 'ほかの予定を確かめています…'));
    o.busy.then(draw, () => draw([]));
  } else draw([]);
  return box;
}

// 関数を呼ぶ → 管理者なら、日時が決まった・消えたときに連絡メールの下書きをそろえる（失敗しても日程は保存済み）
async function schRun(fn, phase, caseRow) {
  const before = phase.scheduled_at || null;
  const res = await fn();
  schBusyCache = null; // Task 53: 予定が変わったので重なりの判定を読み直す
  const owner = !!(ctx && ctx.membership && ctx.membership.role === 'owner');
  if (owner && caseRow && (before || (res && res.scheduled_at))) {
    try {
      const caseId = phase.case_id || caseRow.id; // case_summaries の phases には case_id が無い
      const rows = (await PhasesApi.list(caseId)) || [];
      const row = rows.find(x => x.id === phase.id);
      if (row) await PhasesApi.syncScheduleDrafts(before, row, caseRow, await ReportsApi.listDrafts(caseId));
    } catch (e) { console.warn('連絡メールの下書きをそろえられませんでした', e); }
  }
  return res;
}

// 送るボタンの共通（二度押し防止・失敗は err に）
function schBusyBtn(label, cls, err, fn) {
  const b = dBtn(label, cls, async () => {
    if (b.disabled) return;
    err.textContent = '';
    b.disabled = true;
    try { await fn(b); }
    catch (e) { err.textContent = (e && e.userMsg) || '保存できませんでした: ' + errText(e); }
    if (b.isConnected) b.disabled = false;
  });
  return b;
}
const schErr = () => { const e = mk('div', 'err sch-err'); e.setAttribute('role', 'alert'); return e; };

/* ---------- 候補を出す（管理者・自分で登録した案件の本人） ---------- */
// o: { phase（所要時間の初期値・作業担当者の予定）, onConfirm(start, end, btn) → Promise, onOffer(slots, dur, btn) → Promise, onCancel, cancelLabel,
//   firstCls, saveCls, hint, extra（ボタンの横に足す要素）, start, end }
//   1つなら「この日時で確定」（いつまでが空なら 始まり＋所要時間）と「候補として送る」、2つ以上なら「候補を送る」（作業担当者が時間の中で始まりを選ぶ）
//   Task 58: スイッチ false は 開始と終わり（任意・空なら1時間扱い）の1行と「この日時で確定」だけ（所要時間・候補を足す・候補として送るは出さない）
function schOfferForm(o) {
  const p = o.phase || {};
  const on = PhaseLogic.schedOn();
  const form = mk('div', 'ph-form sch-form sch-offer');
  const err = schErr();
  const dur = schDurEl({ dur: PhaseLogic.schedDur(p) || PhaseLogic.durDefault(p), onChange: () => { rows.check(); } });
  const rows = schSlotRows({ max: on ? 5 : 1, plain: !on, kind: p.kind, start: o.start, end: o.end, firstCls: o.firstCls, dur: on ? dur : null, busy: schBusyFor(p.worker_id, p.id), onChange: () => sync() });
  if (on) form.appendChild(dur.el);
  form.appendChild(rows.el);
  // Task 70: 原因元工事・復旧工事は、時刻の欄が空なら最新の見積書の工事時間を入れる（日付は人が選ぶ・直せる）
  const wt = !on ? TravelUi.workTimes(p, rows.first().st, rows.first().en) : '';
  if (wt) form.appendChild(mk('div', 'ph-sub sch-worktime', wt));
  if (o.hint) form.appendChild(mk('div', 'ph-sub', o.hint));
  const acts = mk('div', 'ph-acts');
  if (o.onCancel) acts.appendChild(dBtn(o.cancelLabel || 'キャンセル', 'btn sm ghost inline', o.onCancel));
  (o.extra || []).forEach(x => acts.appendChild(x));
  const offer = async b => {
    const d = dur.read();
    if (d.err) { err.textContent = d.err; return; }
    const r = rows.read('offer');
    if (r.err) { err.textContent = r.err; return; }
    await o.onOffer(r.slots, d.dur, b);
  };
  const ok = schBusyBtn('', 'btn sm inline sch-ok' + (o.saveCls ? ' ' + o.saveCls : ''), err, async b => {
    if (rows.count() > 1) return offer(b);
    const r = rows.read('confirm');
    if (r.err) { err.textContent = r.err; return; }
    const d = on ? dur.get() : null;
    const st = r.slots[0].start;
    const en = on && dur.mode() === 'days' ? PhaseLogic.durEnd(st, d) : r.slots[0].end || PhaseLogic.durEnd(st, d);
    const cl = rows.busy() && PhaseLogic.clashOf(st, en, rows.busy());
    if (cl) { err.textContent = '保存できません。作業担当者のほかの予定 ' + PhaseLogic.clashText(cl) + '（先に決まった予定が優先です）'; return; } // DB の 23P01 と同じ言い方
    // Task 70: 管理者が担当者のいる対応の日時を決める → 同じ日の前後の予定との移動の時間を確かめる（前後に無ければ出さない）
    const owner = !!(ctx && ctx.membership && ctx.membership.role === 'owner');
    if (owner && p.worker_id && !(await TravelUi.check({ workerId: p.worker_id, phaseId: p.id, start: st, end: r.slots[0].end || null, who: 'admin' }))) return;
    await o.onConfirm(st, en, b);
  });
  const one = schBusyBtn('候補として送る（作業担当者が始まりを選ぶ）', 'btn sm ghost inline sch-offer-one', err, offer);
  const sync = () => {
    const n = rows.count();
    ok.textContent = n > 1 ? '候補を送る（' + n + '件・作業担当者が選ぶ）' : 'この日時で確定';
    ok.dataset.mode = n > 1 ? 'offer' : 'confirm';
    one.hidden = n > 1 || !on;
  };
  sync();
  acts.append(one, ok);
  form.append(acts, err);
  return form;
}

/* ---------- 入居者の都合 ---------- */
// o: { onSend(cond) → Promise, onCancel }
function schCondForm(o) {
  const form = mk('div', 'ph-form sch-form sch-cond-form');
  form.appendChild(mk('b', 'sch-h', '入居者の都合（作業担当者が見て、候補を1〜3つ出します）'));
  let any = false;
  const anyBtn = dBtn('いつでもよい', 'sch-chip sch-any', () => { any = !any; syncAny(); });
  form.appendChild(anyBtn);
  const bandsBox = mk('div', 'sch-bands');
  const bands = [];
  const addBand = (days, from, to) => {
    const r = mk('div', 'sch-band');
    const sel = document.createElement('select');
    sel.className = 'sch-days';
    sel.setAttribute('aria-label', '曜日');
    PhaseLogic.SCHED_DAYS.forEach(d => { const op = document.createElement('option'); op.value = d.key; op.textContent = d.label; sel.appendChild(op); });
    sel.value = days || 'weekday';
    const mkTime = (cls, label, v) => { const i = document.createElement('input'); i.type = 'time'; i.step = 300; i.className = cls; i.value = v || ''; i.setAttribute('aria-label', label); return i; };
    const f = mkTime('sch-from', '何時から（空 = 朝から）', from);
    const t = mkTime('sch-to', '何時まで（空 = 夜まで）', to);
    const x = dBtn('消す', 'linkbtn sch-band-del', () => { bands.splice(bands.indexOf(it), 1); r.remove(); });
    r.append(sel, f, mk('span', 'sch-tilde', '〜'), t, x);
    const it = { r, sel, f, t };
    bands.push(it);
    bandsBox.insertBefore(r, addBtn);
  };
  const addBtn = dBtn('＋ 曜日と時間帯を足す', 'linkbtn sch-band-add', () => addBand());
  bandsBox.appendChild(addBtn);
  form.appendChild(bandsBox);
  form.appendChild(mk('div', 'ph-sub', '例: 平日 18:00〜（空）＝平日の18:00以降、土日（空）〜（空）＝土日は終日'));
  const note = document.createElement('textarea');
  note.className = 'sch-note';
  note.rows = 2;
  note.maxLength = 200;
  note.placeholder = '自由記載（例: 犬がいるので午前中は避けたい）';
  const nl = mk('label', null, '自由記載（任意）');
  nl.appendChild(note);
  form.appendChild(nl);
  const syncAny = () => {
    anyBtn.classList.toggle('on', any);
    anyBtn.setAttribute('aria-pressed', any ? 'true' : 'false');
    bandsBox.hidden = any;
  };
  addBand('weekday', '18:00', '');
  syncAny();
  const err = schErr();
  const acts = mk('div', 'ph-acts');
  if (o.onCancel) acts.appendChild(dBtn('キャンセル', 'btn sm ghost inline', o.onCancel));
  acts.appendChild(schBusyBtn('作業担当者に候補を出してもらう', 'btn sm inline sch-cond-send', err, async b => {
    const cond = { any, bands: any ? [] : bands.map(b => ({ days: b.sel.value, from: b.f.value || '', to: b.t.value || '' })), note: note.value.trim() };
    if (!cond.any && !cond.bands.length && !cond.note) { err.textContent = '「いつでもよい」・曜日と時間帯・自由記載のどれかを入れてください'; return; }
    await o.onSend(cond, b);
  }));
  form.append(acts, err);
  return form;
}

/* ---------- 作業担当者が候補を出す ---------- */
// o: { cond, phase, onSend(slots, dur) → Promise, onCancel }
function schProposeForm(o) {
  const p = o.phase || {};
  const form = mk('div', 'ph-form sch-form sch-propose');
  if (o.cond) form.appendChild(mk('div', 'sch-condline', '入居者の都合: ' + PhaseLogic.condText(o.cond)));
  const dur = schDurEl({ dur: PhaseLogic.schedDur(p) || PhaseLogic.durDefault(p), onChange: () => rows.check() });
  const rows = schSlotRows({ max: 3, cond: o.cond, dur, busy: schBusyFor(p.worker_id, p.id) });
  form.append(dur.el, rows.el);
  form.appendChild(mk('div', 'ph-sub', '空いている時間（いつから〜いつまで）を1〜3つ。管理者がその中で始まりを決めます。入居者の都合の外でも出せます（注意が出ます）'));
  const err = schErr();
  const acts = mk('div', 'ph-acts');
  if (o.onCancel) acts.appendChild(dBtn('キャンセル', 'btn sm ghost inline', o.onCancel));
  acts.appendChild(schBusyBtn('候補を送る', 'btn sm inline sch-propose-send', err, async () => {
    const d = dur.read();
    if (d.err) { err.textContent = d.err; return; }
    const r = rows.read('offer');
    if (r.err) { err.textContent = r.err; return; }
    await o.onSend(r.slots, d.dur);
  }));
  form.append(acts, err);
  return form;
}

/* ---------- 今の日程調整の1行 ---------- */
// → 要素 or null。「日程調整中: 候補 3件（作業担当者が選ぶのを待っています・期限 10/26）」など
function schStatusText(p) {
  const s = PhaseLogic.schedOpen(p);
  if (!s) return '';
  const d = PhaseLogic.schedDue(s, new Date());
  const due = d.due ? '・期限 ' + PhaseLogic.fmtYmdMD(d.due) + (d.late ? '（過ぎています）' : '') : '';
  if (s.blocked_at) return '候補が埋まりました（作業担当者のほかの予定と重なります）。出し直してください'; // Task 53
  if (s.state === 'candidates') return '日程調整中: 候補 ' + (s.cands || []).length + '件' + (s.dur ? '・' + PhaseLogic.durText(s.dur) : '') + '（作業担当者が選ぶのを待っています' + due + '）';
  if (s.state === 'conditions') return '日程調整中: 入居者の都合「' + PhaseLogic.condText(s.cond) + '」（作業担当者が候補を出すのを待っています' + due + '）';
  return '希望あり: ' + (s.wish || []).map(PhaseLogic.slotText).join('・') + '（確定してください' + due + '）';
}

/* ---------- トークのカード ---------- */
// x = TalkLogic.items の { kind: 'sched', meta, phase, active, mine, fromName, text, at }。
// o: { me, canManage（管理者・自分で登録した案件の本人）, caseRow, onDone(text) → 描き直し }
function schCardEl(x, o) {
  const m = x.meta || {};
  const p = x.phase || {};
  const box = mk('div', 'talk-cond sch-card' + (x.active ? ' active' : ' done'));
  box.dataset.kind = 'sched';
  box.dataset.action = m.action || '';
  box.dataset.id = x.id;
  box.dataset.phaseId = p.id || '';
  box.appendChild(Icon.prepend(mk('b', 'talk-cond-h', x.text), 'calendar', 16));
  box.appendChild(mk('span', 'talk-at', (x.mine ? '' : x.fromName + '・') + PhaseLogic.fmtMDWHM(x.at)));
  const worker = !!o.me && p.worker_id === o.me;
  const err = schErr();
  const holder = mk('div', 'sch-holder');
  const run = (fn, done) => schRun(fn, p, o.caseRow).then(() => o.onDone(done));
  const btn = (label, cls, can, fn) => {
    const b = schBusyBtn(label, 'sch-btn ' + cls, err, fn);
    if (!x.active || !can) b.disabled = true;
    return b;
  };
  const list = Array.isArray(m.cands) ? m.cands : [];
  const dur = PhaseLogic.schedDur(p, m);
  // Task 53: 今のカードだけ作業担当者の予定と比べる（重なる始まりは灰色・全部重なれば「他の予定で埋まりました」）
  const busy = x.active ? schBusyFor(p.worker_id, p.id) : null;
  const pick = (c, cls, can, label, fn) => schPickEl({ slot: c, dur, busy, cls, can: x.active && can, err, fullText: '他の予定で埋まりました', label, onPick: fn });
  if (m.action === 'offer') {
    list.forEach(c => box.appendChild(pick(c, 'sch-pick', worker || o.canManage, opt => PhaseLogic.slotText(opt) + ' にする',
      opt => run(() => PhasesApi.schedPick(p.id, opt.start), o.canManage ? '日程を確定しました' : '希望を送りました（管理者が確定します）'))));
  } else if (m.action === 'conditions') {
    box.appendChild(mk('div', 'sch-condline', PhaseLogic.condText(m.cond)));
    box.appendChild(btn('候補を出す', 'sch-propose-open', worker || o.canManage, () => {
      holder.replaceChildren(schProposeForm({ cond: m.cond, phase: p, onCancel: () => holder.replaceChildren(),
        onSend: (slots, d) => run(() => PhasesApi.schedPropose(p.id, slots, d), '候補を送りました（管理者が確定します）') }));
    }));
  } else if (m.action === 'wish' || m.action === 'propose') {
    if (m.cond) box.appendChild(mk('div', 'sch-condline', '入居者の都合: ' + PhaseLogic.condText(m.cond)));
    list.forEach(c => {
      const warn = m.cond ? PhaseLogic.schedOutside(m.cond, c.start, c.end) : '';
      if (warn) box.appendChild(mk('div', 'sch-warn', PhaseLogic.slotText(c) + ': ' + warn));
      box.appendChild(pick(c, 'sch-confirm', o.canManage, opt => PhaseLogic.slotText(opt) + ' で確定',
        opt => run(() => PhasesApi.schedConfirm(p.id, opt.start, opt.end), '日程を確定しました')));
    });
  } else if (m.action === 'confirm') {
    box.appendChild(mk('div', 'sch-fixed', '確定 ' + list.map(PhaseLogic.slotText).join('・'))); // Task 53: 「確定 10/30（金）10:00〜12:00」
    // 一番新しい確定で、今もその日時なら「日程を変える」（管理者・自分で登録した案件の本人）
    const now = p.scheduled_at && list[0] && Date.parse(p.scheduled_at) === Date.parse(list[0].start);
    if (o.canManage && now && x.latest) box.appendChild(schChangeBtns(p, o, holder, run));
  }
  if (m.action !== 'confirm') {
    box.appendChild(mk('span', 'talk-cond-note', x.active
      ? (m.action === 'offer' || m.action === 'conditions' ? (worker ? '押して選んでください（期限は出した日の翌日）' : '作業担当者が選びます')
        : o.canManage ? '1つ押すと確定します' : '管理者が確定します')
      : '済み（ボタンは押せません）'));
  }
  box.append(holder, err);
  return box;
}
// 「日程を変える」「入居者の都合を伝える」のボタン（holder に欄を開く）
//   Task 58: スイッチ false は「日程を変える」（開始と終わりを手で入れて確定）だけ
function schChangeBtns(p, o, holder, run) {
  const on = PhaseLogic.schedOn();
  const row = mk('div', 'ph-acts sch-change');
  row.appendChild(dBtn('日程を変える', 'btn sm ghost inline sch-change-open', () => {
    holder.replaceChildren(schOfferForm({ phase: p, start: on ? null : p.scheduled_at, end: on ? null : p.scheduled_end, onCancel: o.onCancel || (() => holder.replaceChildren()),
      hint: !on ? '開始の日付と時刻を選んで「この日時で確定」。終了予定は空でもかまいません（1時間として扱います）。ほかの予定と重なると保存できません'
        : '候補は空いている時間（いつから〜いつまで）と所要時間。作業担当者がその中で始まりを選びます。今の日時は取り消されます（記録はトークに残ります）',
      onConfirm: (st, en) => run(() => PhasesApi.schedConfirm(p.id, st, en), '日程を確定しました'),
      onOffer: (slots, d) => run(() => PhasesApi.schedOffer(p.id, slots, d), '候補を送りました') }));
  }));
  if (on) {
    row.appendChild(dBtn('入居者の都合を伝える', 'btn sm ghost inline sch-cond-open', () => {
      holder.replaceChildren(schCondForm({ onCancel: () => holder.replaceChildren(),
        onSend: cond => run(() => PhasesApi.schedConditions(p.id, cond), '入居者の都合を送りました') }));
    }));
  }
  return row;
}

/* ---------- 現場用: 自分で登録した案件の「日程を変える」シート ---------- */
// × だけで閉じる（入力があるので外側・Esc では閉じない）。onDone(text) は閉じた後
function schSheet(p, caseRow, onDone) {
  const prev = document.getElementById('sch-sheet');
  if (prev) prev.remove();
  const bg = mk('div', 'lt-bg');
  bg.id = 'sch-sheet';
  const dlg = mk('div', 'lt-sheet sch-sheet');
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-labelledby', 'sch-sheet-title');
  const close = () => { bg.remove(); window.removeEventListener('hashchange', close); };
  const hd = mk('div', 'lt-hd');
  const h = mk('h3', null, '日程を決める・変える');
  h.id = 'sch-sheet-title';
  const x = dBtn('×', 'lt-x', close);
  x.id = 'sch-sheet-x';
  x.setAttribute('aria-label', '閉じる');
  hd.append(h, x);
  const holder = mk('div', 'sch-holder');
  const run = (fn, done) => schRun(fn, p, caseRow).then(() => { close(); onDone(done); });
  dlg.append(hd, mk('div', 'lt-sub', (PhaseLogic.placeName(caseRow) || '') + '。自分で登録した案件なので、日程を決められます。'
    + (p.scheduled_at ? '今は ' + PhaseLogic.fmtMDWHM(p.scheduled_at) + '。' : '')));
  // すぐ日時の欄を出す（間の「日程を変える」は押さなくてよい）。ボタンが「日程を変える」だけのときは列を隠し、キャンセルで閉じる
  const on = PhaseLogic.schedOn();
  const btns = schChangeBtns(p, { canManage: true, onCancel: on ? null : close }, holder, run);
  btns.hidden = !on;
  dlg.append(btns, holder);
  btns.querySelector('.sch-change-open').click();
  bg.appendChild(dlg);
  document.body.appendChild(bg);
  window.addEventListener('hashchange', close);
  x.focus();
}
