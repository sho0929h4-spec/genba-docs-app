// js/schedule-ui.js — 日程調整（Task 50。DB は migration 069、文言と判定は PhaseLogic の sched*）の画面の部品
//   schOfferForm  … 候補の日時の欄（1つ以上・開始と終わり）。1つなら「この日時で確定」、2つ以上なら「候補を送る」（管理者・自分で登録した案件の本人）
//   schCondForm   … 入居者の都合（いつでもよい／曜日と時間帯（複数）／自由記載）→ 作業担当者が候補を出す
//   schProposeForm… 作業担当者が候補を 1〜3 つ出す（入居者の都合の外なら注意。出すことはできる）
//   schStatusEl   … 今の日程調整の1行（案件ページの日時の欄・現場用のツールページ）
//   schCardEl     … トークのカード（候補・条件・希望・確定。今のカードだけボタンが押せる・処理済みは灰色）
//   schSheet      … 現場用の「日程を変える」のシート（× だけで閉じる）
//   schRun        … 関数を呼んで、管理者なら連絡メールの下書き（日時を決めた・消した）をそろえる
// 日時の欄は日本時間（phToInput / phFromInput は phase-ui.js）。mk は case-list.js、dBtn / errText は case-detail.js
// ユーザー入力は createElement + textContent / value で描画する（innerHTML は使わない）。alert/confirm は使わない

/* ---------- 共通 ---------- */
// 候補の日時の行（開始・終わり）。o: { max, survey（終わりの欄なし）, start, end（最初の行の初期値 ISO）, cond（入居者の都合 → 外なら注意）,
//   firstCls（最初の行の欄に既存の class: ph-sched-start / ph-sched-end）, onChange }
//   → { el, read() → { slots: [{start, end}], err }, count() }
function schSlotRows(o) {
  const box = mk('div', 'sch-rows');
  const rows = [];
  const add = (startIso, endIso) => {
    const r = mk('div', 'sch-row');
    const n = rows.length + 1;
    const st = document.createElement('input');
    st.type = 'datetime-local';
    st.step = 300;
    st.className = 'sch-start' + (rows.length === 0 && o.firstCls ? ' ' + o.firstCls[0] : '');
    st.value = phToInput(startIso);
    const l1 = mk('label', null, (o.max > 1 ? '候補' + n + ' ' : '') + (o.survey ? '日時' : '開始') + '（日本時間）');
    l1.appendChild(st);
    r.appendChild(l1);
    let en = null;
    if (!o.survey) {
      en = document.createElement('input');
      en.type = 'datetime-local';
      en.step = 300;
      en.className = 'sch-end' + (rows.length === 0 && o.firstCls ? ' ' + o.firstCls[1] : '');
      en.value = phToInput(endIso);
      const l2 = mk('label', null, '終わり（任意）');
      l2.appendChild(en);
      r.appendChild(l2);
    }
    const warn = mk('div', 'sch-warn');
    warn.setAttribute('role', 'status');
    const check = () => {
      const s = phFromInput(st.value);
      const e = en && en.value ? phFromInput(en.value) : null;
      warn.textContent = o.cond && s ? PhaseLogic.schedOutside(o.cond, s, e) : '';
      warn.hidden = !warn.textContent;
    };
    [st, en].filter(Boolean).forEach(i => i.addEventListener('input', () => { check(); if (o.onChange) o.onChange(); }));
    check();
    r.appendChild(warn);
    if (rows.length > 0) {
      const x = dBtn('この候補を消す', 'linkbtn sch-del', () => { rows.splice(rows.indexOf(item), 1); r.remove(); sync(); if (o.onChange) o.onChange(); });
      r.appendChild(x);
    }
    const item = { r, st, en };
    rows.push(item);
    box.insertBefore(r, more);
    sync();
    return item;
  };
  const more = dBtn('＋ 候補を足す', 'linkbtn sch-more', () => { const it = add(null, null); it.st.focus(); if (o.onChange) o.onChange(); });
  box.appendChild(more);
  const sync = () => { more.hidden = rows.length >= o.max; };
  add(o.start || null, o.end || null);
  return {
    el: box,
    count: () => rows.length,
    read() {
      const slots = [];
      for (const it of rows) {
        const s = phFromInput(it.st.value);
        if (!s) { it.st.focus(); return { err: '候補の日時を入れてください（使わない欄は「この候補を消す」）' }; }
        let e = null;
        if (it.en && it.en.value) {
          e = phFromInput(it.en.value);
          if (!e || Date.parse(e) <= Date.parse(s)) { it.en.focus(); return { err: '終わりは開始より後にしてください' }; }
        }
        slots.push({ start: s, end: e });
      }
      return { slots, err: '' };
    }
  };
}

// 関数を呼ぶ → 管理者なら、日時が決まった・消えたときに連絡メールの下書きをそろえる（失敗しても日程は保存済み）
async function schRun(fn, phase, caseRow) {
  const before = phase.scheduled_at || null;
  const res = await fn();
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
// o: { phase, survey, onConfirm(start, end) → Promise, onOffer(slots) → Promise, onCancel, cancelLabel, firstCls, saveCls, hint, extra（ボタンの横に足す要素） }
function schOfferForm(o) {
  const form = mk('div', 'ph-form sch-form sch-offer');
  const err = schErr();
  let ok = null;
  const rows = schSlotRows({ max: 5, survey: !!o.survey, start: o.start, end: o.end, firstCls: o.firstCls, onChange: () => sync() });
  form.appendChild(rows.el);
  if (o.hint) form.appendChild(mk('div', 'ph-sub', o.hint));
  const acts = mk('div', 'ph-acts');
  if (o.onCancel) acts.appendChild(dBtn(o.cancelLabel || 'キャンセル', 'btn sm ghost inline', o.onCancel));
  (o.extra || []).forEach(x => acts.appendChild(x));
  ok = schBusyBtn('', 'btn sm inline sch-ok' + (o.saveCls ? ' ' + o.saveCls : ''), err, async () => {
    const r = rows.read();
    if (r.err) { err.textContent = r.err; return; }
    if (r.slots.length === 1) await o.onConfirm(r.slots[0].start, r.slots[0].end, ok);
    else await o.onOffer(r.slots, ok);
  });
  const sync = () => {
    const n = rows.count();
    ok.textContent = n > 1 ? '候補を送る（' + n + '件・作業担当者が選ぶ）' : 'この日時で確定';
    ok.dataset.mode = n > 1 ? 'offer' : 'confirm';
  };
  sync();
  acts.appendChild(ok);
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
// o: { cond, survey, onSend(slots) → Promise, onCancel }
function schProposeForm(o) {
  const form = mk('div', 'ph-form sch-form sch-propose');
  if (o.cond) form.appendChild(mk('div', 'sch-condline', '入居者の都合: ' + PhaseLogic.condText(o.cond)));
  const rows = schSlotRows({ max: 3, survey: !!o.survey, cond: o.cond });
  form.appendChild(rows.el);
  form.appendChild(mk('div', 'ph-sub', '候補は1〜3つ。入居者の都合の外でも出せます（注意が出ます）'));
  const err = schErr();
  const acts = mk('div', 'ph-acts');
  if (o.onCancel) acts.appendChild(dBtn('キャンセル', 'btn sm ghost inline', o.onCancel));
  acts.appendChild(schBusyBtn('候補を送る', 'btn sm inline sch-propose-send', err, async () => {
    const r = rows.read();
    if (r.err) { err.textContent = r.err; return; }
    await o.onSend(r.slots);
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
  if (s.state === 'candidates') return '日程調整中: 候補 ' + (s.cands || []).length + '件（作業担当者が選ぶのを待っています' + due + '）';
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
  const survey = p.kind === 'survey';
  if (m.action === 'offer') {
    list.forEach(c => {
      const b = btn(PhaseLogic.slotText(c) + ' にする', 'sch-pick', worker || o.canManage,
        () => run(() => PhasesApi.schedPick(p.id, c.start), o.canManage ? '日程を確定しました' : '希望を送りました（管理者が確定します）'));
      b.dataset.start = c.start;
      box.appendChild(b);
    });
  } else if (m.action === 'conditions') {
    box.appendChild(mk('div', 'sch-condline', PhaseLogic.condText(m.cond)));
    box.appendChild(btn('候補を出す', 'sch-propose-open', worker || o.canManage, () => {
      holder.replaceChildren(schProposeForm({ cond: m.cond, survey, onCancel: () => holder.replaceChildren(),
        onSend: slots => run(() => PhasesApi.schedPropose(p.id, slots), '候補を送りました（管理者が確定します）') }));
    }));
  } else if (m.action === 'wish' || m.action === 'propose') {
    if (m.cond) box.appendChild(mk('div', 'sch-condline', '入居者の都合: ' + PhaseLogic.condText(m.cond)));
    list.forEach(c => {
      const warn = m.cond ? PhaseLogic.schedOutside(m.cond, c.start, c.end) : '';
      if (warn) box.appendChild(mk('div', 'sch-warn', PhaseLogic.slotText(c) + ': ' + warn));
      const b = btn(PhaseLogic.slotText(c) + ' で確定', 'sch-confirm', o.canManage,
        () => run(() => PhasesApi.schedConfirm(p.id, c.start, c.end), '日程を確定しました'));
      b.dataset.start = c.start;
      box.appendChild(b);
    });
  } else if (m.action === 'confirm') {
    box.appendChild(mk('div', 'sch-fixed', list.map(PhaseLogic.slotText).join('・')));
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
function schChangeBtns(p, o, holder, run) {
  const row = mk('div', 'ph-acts sch-change');
  const survey = p.kind === 'survey';
  row.appendChild(dBtn('日程を変える', 'btn sm ghost inline sch-change-open', () => {
    holder.replaceChildren(schOfferForm({ survey, onCancel: () => holder.replaceChildren(),
      hint: '1つなら「この日時で確定」、2つ以上なら作業担当者が選びます。今の日時は取り消されます（記録はトークに残ります）',
      onConfirm: (st, en) => run(() => PhasesApi.schedConfirm(p.id, st, en), '日程を確定しました'),
      onOffer: slots => run(() => PhasesApi.schedOffer(p.id, slots), '候補を送りました') }));
  }));
  row.appendChild(dBtn('入居者の都合を伝える', 'btn sm ghost inline sch-cond-open', () => {
    holder.replaceChildren(schCondForm({ onCancel: () => holder.replaceChildren(),
      onSend: cond => run(() => PhasesApi.schedConditions(p.id, cond), '入居者の都合を送りました') }));
  }));
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
    + (p.scheduled_at ? '今は ' + PhaseLogic.fmtMDWHM(p.scheduled_at) + '。' : '')), schChangeBtns(p, { canManage: true }, holder, run), holder);
  bg.appendChild(dlg);
  document.body.appendChild(bg);
  window.addEventListener('hashchange', close);
  x.focus();
}
