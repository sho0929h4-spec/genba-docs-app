// js/report-form.js — 報告書の入力フォーム（⑥ 社内の入力画面と ⑧ 協力業者ページ r.html で共有）
// ここは「入力欄の描画と表示切替」だけ。保存・写真のアップロード・提出は呼び出し側（report-edit.js / vendor.js）。
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。
// 依存: ReportLogic（js/report-logic.js）のみ。社内アプリの関数（mk / dBtn / ReportsApi / ctx …）は使わない。
//
// 状態 s（呼び出し側が作る）:
//   s.f       … 入力値 { work_type, room, work_date, time_start, time_end, data, (worker_*) }
//   s.report  … { photos: [{ path, name, caption, phase, ... }] }
//   s.ro      … 読み取り専用
//   s.els     … 描画した要素（ここで詰める）
//   s.onDirty(s, photos) … 入力が変わったとき（photos=true は写真のキャプション/区分）
//   s.alive() … まだこの画面を表示中か（音声入力の結果を捨てる判定。省略可）

const rfMk = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
};
const rfDirty = (s, photos) => { if (s.onDirty) s.onDirty(s, photos); };
const edPad = n => String(n).padStart(2, '0');
const edHm = d => edPad(d.getHours()) + ':' + edPad(d.getMinutes());

/* ---------- 部品 ---------- */
let edUid = 0;
function edField(label, control, hint, cls) {
  const wrap = rfMk('div', 'rep-ff' + (cls ? ' ' + cls : ''));
  if (control.id === '') control.id = 'rp-auto-' + (++edUid);
  const l = rfMk('label', null, label);
  l.htmlFor = control.id;
  wrap.appendChild(l);
  if (hint) wrap.appendChild(rfMk('span', 'rep-hint', hint));
  wrap.appendChild(control);
  return wrap;
}
function edInput(id, type, value, onInput, extra) {
  const i = document.createElement('input');
  i.type = type;
  i.id = id;
  i.value = value || '';
  if (extra && extra.placeholder) i.placeholder = extra.placeholder;
  if (extra && extra.autocomplete) i.autocomplete = extra.autocomplete;
  if (extra && extra.maxLength) i.maxLength = extra.maxLength;
  const h = () => onInput(i.value);
  i.addEventListener('input', h);
  if (type !== 'text') i.addEventListener('change', h);
  return i;
}
function edSelect(id, options, value, onChange) {
  const sel = document.createElement('select');
  sel.id = id;
  options.forEach(o => sel.appendChild(new Option(o[1], o[0])));
  sel.value = value;
  if (sel.value !== value) sel.value = options.length ? options[0][0] : '';
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}
function edTextarea(id, value, short, placeholder, onInput) {
  const t = document.createElement('textarea');
  t.id = id;
  t.className = short ? 'short' : '';
  t.value = value || '';
  if (placeholder) t.placeholder = placeholder;
  t.addEventListener('input', () => onInput(t.value));
  return t;
}
function edChip(text, on, disabled, onToggle) {
  const b = rfMk('button', 'chip' + (on ? ' on' : ''), text);
  b.type = 'button';
  b.disabled = disabled;
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.addEventListener('click', () => {
    const now = !b.classList.contains('on');
    b.classList.toggle('on', now);
    b.setAttribute('aria-pressed', now ? 'true' : 'false');
    onToggle(now);
  });
  return b;
}
// 押すと☑になる行（Task 20: チェックリスト・原因）。左に四角のチェック（空 → ☑）、押した行は塗り。radio = 丸（1つだけ選ぶ）
function edCheck(text, on, disabled, onToggle, radio) {
  const b = rfMk('button', 'rep-check' + (radio ? ' radio' : '') + (on ? ' on' : ''));
  b.type = 'button';
  b.disabled = disabled;
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  const box = rfMk('span', 'rep-check-box');
  box.setAttribute('aria-hidden', 'true');
  b.append(box, rfMk('span', 'rep-check-t', text));
  b.addEventListener('click', () => {
    const now = !b.classList.contains('on');
    b.classList.toggle('on', now);
    b.setAttribute('aria-pressed', now ? 'true' : 'false');
    onToggle(now, b);
  });
  return b;
}
const edSetOn = (b, on) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); };
// data[field] の配列に値を入れる/抜く
function edToggleIn(s, field, value, on) {
  const cur = Array.isArray(s.f.data[field]) ? s.f.data[field] : [];
  s.f.data[field] = on ? (cur.includes(value) ? cur : [...cur, value]) : cur.filter(x => x !== value);
  rfDirty(s);
}

/* ---------- 音声入力 ---------- */
let edRec = null;   // 音声入力中 { rec, btn }
const edSR = () => window.SpeechRecognition || window.webkitSpeechRecognition;
function edStopVoice() { if (edRec) { try { edRec.rec.stop(); } catch (e) { /* 何もしない */ } } }
function edMic(s, key, ta) {
  const b = rfMk('button', 'rep-mic', '🎤');
  b.type = 'button';
  b.title = '音声入力';
  b.setAttribute('aria-label', '音声入力');
  const SR = edSR();
  if (!SR || s.ro) { b.disabled = true; if (!SR) b.title = 'この端末・ブラウザでは音声入力を使えません'; return b; }
  b.addEventListener('click', () => {
    if (edRec) { edStopVoice(); return; }
    const rec = new SR();
    rec.lang = 'ja-JP';
    rec.continuous = true;
    rec.interimResults = false;
    const done = () => { b.classList.remove('on'); if (edRec && edRec.rec === rec) edRec = null; };
    rec.onstart = () => { edRec = { rec, btn: b }; b.classList.add('on'); b.title = '録音中（もう一度押すと停止）'; };
    rec.onresult = ev => {
      if (s.alive && !s.alive()) return;
      const txt = Array.from(ev.results).slice(ev.resultIndex).map(r => r[0].transcript).join('');
      if (!txt) return;
      ta.value += (ta.value ? '\n' : '') + txt;
      s.f.data[key] = ta.value;
      rfDirty(s);
    };
    rec.onend = () => { done(); b.title = '音声入力'; };
    rec.onerror = done;
    try { rec.start(); } catch (e) { done(); }
  });
  return b;
}

/* ---------- フォームの組み立て ---------- */
function edPhaseOptions() {
  return Object.entries(ReportLogic.PHASES).map(([k, v]) => [k, v]);
}

// 入力フォーム全体（基本・区分ごとのチップ・作業内容・写真・チェックリスト）のカード配列を返す
// opts:
//   infoTitle / infoRows … 基本カードの見出しと自動入力欄（[[項目, 値], ...]。省略すると出さない）
//   afterRoom(g2, basic) … 号室の右/下に欄を足す（⑥の作業者）
//   fixedMode            … true なら作業区分の切替を出さない（⑧: 区分は発行時に社内で決める）
//   photoHint            … 写真カードの説明（省略時は既定文）
function rfBuildForm(s, opts) {
  const o = opts || {};
  const L = ReportLogic, T = L.TEXT, d = s.f.data, els = s.els;
  const ro = s.ro;
  const nodes = [];

  // ---- 基本 ----
  const basic = rfMk('div', 'rep-card');
  basic.appendChild(rfMk('h3', null, o.infoTitle || '作業の基本'));
  if (o.infoRows && o.infoRows.length) {
    const dl = rfMk('dl', 'rep-auto');
    o.infoRows.forEach(([k, v]) => { dl.appendChild(rfMk('dt', null, k)); dl.appendChild(rfMk('dd', null, v || '—')); });
    basic.appendChild(dl);
  }

  const g2 = rfMk('div', 'rep-g2');
  g2.style.marginTop = '12px';
  els.room = edInput('rp-room', 'text', s.f.room, v => { s.f.room = v; rfDirty(s); }, { placeholder: '例：302', autocomplete: 'off', maxLength: 40 });
  g2.appendChild(edField('号室 *', els.room));
  basic.appendChild(g2);
  if (o.afterRoom) o.afterRoom(g2, basic);

  // 作業区分（セグメント）。fixedLabel: フェーズ付きの報告書は区分が決まっている（表示だけ。Task 20）
  els.seg = null;
  if (o.fixedMode && o.fixedLabel) {
    const fx = rfMk('div', 'rep-fixed', o.fixedLabel);
    fx.id = 'rp-fixed-type';
    const fxField = rfMk('div', 'rep-ff');
    fxField.append(rfMk('label', null, '作業区分'), fx);
    if (o.fixedHint) fxField.appendChild(rfMk('span', 'rep-hint rep-fixed-hint', o.fixedHint));
    basic.appendChild(fxField);
  }
  if (!o.fixedMode) {
    els.seg = rfMk('div', 'rep-seg');
    els.seg.id = 'rp-seg';
    els.seg.setAttribute('role', 'group');
    Object.keys(L.MODES).forEach(k => {
      const b = rfMk('button', null, L.MODES[k].label);
      b.type = 'button';
      b.dataset.mode = k;
      b.disabled = ro;
      b.addEventListener('click', () => {
        if (s.f.work_type === k) return;
        s.f.work_type = k;
        edApplyMode(s);
        rfDirty(s);
      });
      els.seg.appendChild(b);
    });
    const segField = rfMk('div', 'rep-ff');
    segField.append(rfMk('label', null, '作業区分'), els.seg);
    basic.appendChild(segField);
  }

  els.date = edInput('rp-date', 'date', s.f.work_date, v => { s.f.work_date = v; rfDirty(s); });
  basic.appendChild(edField('作業日 *', els.date));

  const timeRow = (id, label, key) => {
    const inp = edInput(id, 'time', s.f[key], v => { s.f[key] = v; rfDirty(s); });
    const now = rfMk('button', 'rep-now', '現在時刻');
    now.type = 'button';
    now.id = id + '-now';
    now.disabled = ro;
    now.addEventListener('click', () => { inp.value = edHm(new Date()); s.f[key] = inp.value; rfDirty(s); });
    const row = rfMk('div', 'rep-time');
    row.append(inp, now);
    const wrap = rfMk('div', 'rep-ff');
    const l = rfMk('label', null, label);
    l.htmlFor = id;
    wrap.append(l, row);
    return { wrap, inp };
  };
  const ts = timeRow('rp-ts', '作業開始時間', 'time_start');
  const te = timeRow('rp-te', '作業終了時間', 'time_end');
  els.ts = ts.inp;
  els.te = te.inp;
  basic.append(ts.wrap, te.wrap);
  nodes.push(basic);

  // ---- 区分ごとのチップカード（区分ごとに1枚。使う区分だけ表示） ----
  els.chipCards = {};
  Object.keys(L.MODES).forEach(k => {
    const cfg = L.MODES[k];
    if (!cfg.checkGroups.length) return;
    if (o.fixedMode && k !== s.f.work_type) return;
    const card = rfMk('div', 'rep-card');
    card.dataset.mode = k;
    card.appendChild(rfMk('h3', null, cfg.checkCardTitle));
    cfg.checkGroups.forEach(g => card.appendChild(edGroup(s, g)));
    // 古い報告書の項目（旧ツールの12項目。入力はできないが PDF には出る）
    const legacy = L.legacyChips({ work_type: k, data: d });
    if (legacy.length) {
      const lg = rfMk('div', 'rep-legacy', T.legacyItems + '（PDFにも出ます）: ' + legacy.join('、'));
      lg.dataset.legacy = 'items';
      card.appendChild(lg);
    }
    els.chipCards[k] = card;
    nodes.push(card);
  });

  // ---- 作業内容 ----
  const content = rfMk('div', 'rep-card');
  content.appendChild(rfMk('h3', null, '作業内容'));

  const labelRow = (id, labelText, ta, key) => {
    const row = rfMk('div', 'rep-lbl-row');
    const l = rfMk('label', null, labelText);
    l.htmlFor = id;
    row.append(l, edMic(s, key, ta));
    return { row, label: l };
  };

  els.f1 = edTextarea('rp-f1', d.f1, false, '', v => { d.f1 = v; rfDirty(s); });
  const f1Row = labelRow('rp-f1', '', els.f1, 'f1');
  els.f1Label = f1Row.label;
  els.f1Hint = rfMk('span', 'rep-hint', T.f1Hint);
  const f1 = rfMk('div', 'rep-ff');
  f1.append(f1Row.row, els.f1Hint, els.f1);
  content.appendChild(f1);

  // 漏水の状況・対応・元栓の号室（調査のみ）
  els.leakWrap = rfMk('div');
  els.leak = edSelect('rp-leak', [['', T.selectPlaceholder], ...L.LEAK_STATUS.map(x => [x, x])], d.leak || '', v => { d.leak = v; edApplyLeak(s); rfDirty(s); });
  els.leakWrap.appendChild(edField(T.leakLabel, els.leak));
  els.leakActionWrap = rfMk('div');
  els.leakAction = edSelect('rp-leakaction', [['', T.selectPlaceholder], ...L.LEAK_ACTIONS.map(a => [a.value, a.label])], d.leakAction || '', v => { d.leakAction = v; edApplyLeak(s); rfDirty(s); });
  els.leakActionWrap.appendChild(edField(T.leakActionLabel, els.leakAction));
  els.leakRoomWrap = rfMk('div', 'rep-free');
  els.leakRoom = edInput('rp-leakroom', 'text', d.leakRoom, v => { d.leakRoom = v; rfDirty(s); }, { placeholder: T.leakRoomPlaceholder, autocomplete: 'off' });
  els.leakRoomWrap.appendChild(els.leakRoom);
  els.leakActionWrap.lastChild.appendChild(els.leakRoomWrap);
  els.leakWrap.appendChild(els.leakActionWrap);
  content.appendChild(els.leakWrap);

  // 対応後の状況（設備修繕のみ）
  els.afterWrap = rfMk('div');
  els.after = edSelect('rp-after', [['', T.selectPlaceholder], ...L.AFTER_STATUS.map(x => [x, x])], d.afterSel || '', v => { d.afterSel = v; rfDirty(s); });
  els.afterNote = edTextarea('rp-afternote', d.afterNote, true, T.afterNotePlaceholder, v => { d.afterNote = v; rfDirty(s); });
  const afterField = edField(T.afterLabel, els.after);
  afterField.appendChild(els.afterNote);
  els.afterNote.style.marginTop = '8px';
  els.afterWrap.appendChild(afterField);
  content.appendChild(els.afterWrap);

  const longField = (id, key, label, hint, wrapKey) => {
    const ta = edTextarea(id, d[key], true, '', v => { d[key] = v; rfDirty(s); });
    els[key] = ta;
    const row = labelRow(id, label, ta, key);
    const f = rfMk('div', 'rep-ff');
    f.append(row.row, rfMk('span', 'rep-hint', hint), ta);
    els[wrapKey] = f;
    content.appendChild(f);
  };
  // 調査の原因・次の対応方針は選択式（Task 20）。古い報告書の自由記載（f2 / f4）は、値があるときだけ「以前の書き方の記載」として残す
  s.legacy = { f2: !!String(d.f2 || '').trim(), f4: !!String(d.f4 || '').trim() };
  edCausePicker(s, content);
  longField('rp-f2', 'f2', T.legacyF2, T.f2Hint, 'f2Wrap');
  longField('rp-reason', 'reason', T.reasonLabel, T.reasonHint, 'reasonWrap');
  edNextPicker(s, content);
  longField('rp-f4', 'f4', T.legacyF4, T.f4Hint, 'f4Wrap');
  nodes.push(content);

  // ---- 写真（枠だけ。一覧の中身は rfRenderPhotos、追加の処理は呼び出し側が els.photoInput の change で行う） ----
  const ph = rfMk('div', 'rep-card');
  const phHead = rfMk('div', 'rep-between');
  els.photoTitle = rfMk('h3', null, '写真');
  els.photoAdd = rfMk('button', 'btn sm ghost inline', '📷 写真を追加');
  els.photoAdd.type = 'button';
  els.photoAdd.id = 'rp-photo-add';
  els.photoInput = document.createElement('input');
  els.photoInput.type = 'file';
  els.photoInput.id = 'rp-photo-input';
  els.photoInput.accept = 'image/*';
  els.photoInput.multiple = true;
  els.photoInput.hidden = true;
  els.photoAdd.addEventListener('click', () => { if (!s.photoBusy && !ro) els.photoInput.click(); });
  phHead.append(els.photoTitle, els.photoAdd, els.photoInput);
  ph.appendChild(phHead);
  ph.appendChild(rfMk('div', 'rep-hint', o.photoHint || (T.ctxPhotoHint + '。写真は自動で圧縮して保存します')));
  els.photoMsg = rfMk('div', 'rep-photo-msg');
  els.photoMsg.id = 'rp-photo-msg';
  els.photoMsg.setAttribute('role', 'status');
  ph.appendChild(els.photoMsg);
  els.photoList = rfMk('div');
  els.photoList.id = 'rp-photos';
  ph.appendChild(els.photoList);
  nodes.push(ph);

  // ---- チェックリスト ----
  const cl = rfMk('div', 'rep-card');
  cl.appendChild(rfMk('h3', null, T.checklistTitle));
  cl.appendChild(rfMk('div', 'rep-group-ttl', T.workChecklistTitle));
  els.workChips = rfMk('div', 'rep-checks');
  els.workChips.id = 'rp-work-chips';
  cl.appendChild(els.workChips);
  cl.appendChild(rfMk('div', 'rep-group-ttl', T.keyChecklistTitle));
  const kc = rfMk('div', 'rep-checks');
  kc.id = 'rp-key-checks';
  const keySel = Array.isArray(d.keyChecklist) ? d.keyChecklist : [];
  L.KEY_CHECKLIST.forEach(t => kc.appendChild(edCheck(t, keySel.includes(t), ro, on => edToggleIn(s, 'keyChecklist', t, on))));
  cl.appendChild(kc);
  els.keyReturn = edInput('rp-keyreturn', 'text', d.keyReturn, v => { d.keyReturn = v; rfDirty(s); }, { placeholder: T.keyReturnPlaceholder, autocomplete: 'off' });
  const kr = edField(T.keyReturnLabel, els.keyReturn);
  kr.style.marginTop = '10px';
  cl.appendChild(kr);
  nodes.push(cl);

  return nodes;
}

// チップのグループ（調査: 作業実施項目 / 復旧工事: 場所・部位）。自由記載チップ ON で入力欄を出す
function edGroup(s, g) {
  const L = ReportLogic, T = L.TEXT, d = s.f.data;
  const box = rfMk('div');
  if (g.title) box.appendChild(rfMk('div', 'rep-group-ttl', g.title));
  const sel = Array.isArray(d[g.field]) ? d[g.field] : [];
  const chips = rfMk('div', 'rep-chips');
  g.items.forEach(it => chips.appendChild(edChip(it, sel.includes(it), s.ro, on => edToggleIn(s, g.field, it, on))));
  let free = null;
  if (g.free) {
    const fc = g.freeChip || L.FREE_CHIP; // 調査の7項目は「その他」（Task 20）
    free = rfMk('div', 'rep-free');
    const inp = edInput('rp-free-' + g.freeField, 'text', d[g.freeField], v => { d[g.freeField] = v; rfDirty(s); },
      { placeholder: g.freeChip ? T.workItemOtherPlaceholder : T.freePlaceholder, autocomplete: 'off', maxLength: 1000 });
    inp.setAttribute('aria-label', g.freePrefix + '（自由記載）');
    free.appendChild(inp);
    free.hidden = !sel.includes(fc);
    chips.appendChild(edChip(fc, sel.includes(fc), s.ro, on => {
      free.hidden = !on;
      edToggleIn(s, g.field, fc, on);
      if (on) inp.focus();
    }));
  }
  box.appendChild(chips);
  if (free) box.appendChild(free);
  return box;
}

/* ---------- 原因（複数選択・押すと☑。Task 20） ---------- */
// 選んだ項目のうち「詳細」「理由」「自由記載」のある項目だけ、下に1行の入力欄を出す（定義順）
function edCausePicker(s, parent) {
  const L = ReportLogic, T = L.TEXT, d = s.f.data, els = s.els;
  els.causeWrap = rfMk('div', 'rep-ff');
  els.causeWrap.id = 'rp-cause-wrap';
  const ttl = rfMk('div', 'rep-lbl-row');
  ttl.appendChild(rfMk('label', null, T.f2Label));
  els.causeWrap.append(ttl, rfMk('span', 'rep-hint', T.f2Pick + '。' + T.f2Hint));
  const grid = rfMk('div', 'rep-checks grid');
  grid.id = 'rp-causes';
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', T.f2Label);
  s.causeKeep = s.causeKeep || {}; // 外した項目の詳細（もう一度押したら戻す）
  L.CAUSES.forEach(c => {
    const on = d.causes.some(x => x.key === c.key);
    const b = edCheck(c.label, on, s.ro, now => {
      const cur = L.normalizeCauses(d.causes);
      if (now) {
        if (!cur.some(x => x.key === c.key)) cur.push({ key: c.key, detail: c.input === 'detail' ? (s.causeKeep[c.key] || '') : '' });
      } else {
        const was = cur.find(x => x.key === c.key);
        if (was && was.detail) s.causeKeep[c.key] = was.detail;
      }
      d.causes = now ? cur : cur.filter(x => x.key !== c.key);
      edRenderCauseInputs(s);
      rfDirty(s);
      if (now && c.input) { const inp = els.causeInputs.querySelector('[data-cause="' + c.key + '"]'); if (inp) inp.focus(); }
    });
    b.dataset.cause = c.key;
    grid.appendChild(b);
  });
  els.causeInputs = rfMk('div', 'rep-sub-fields');
  els.causeInputs.id = 'rp-cause-inputs';
  els.causeWrap.append(grid, els.causeInputs);
  parent.appendChild(els.causeWrap);
  edRenderCauseInputs(s);
}
function edRenderCauseInputs(s) {
  const L = ReportLogic, T = L.TEXT, d = s.f.data;
  const rows = [];
  L.CAUSES.forEach(c => {
    const sel = d.causes.find(x => x.key === c.key);
    if (!sel || !c.input) return;
    let label, value, set, ph;
    if (c.input === 'tenant') { label = T.tenantReasonLabel; value = d.causeTenantReason; set = v => { d.causeTenantReason = v; }; ph = T.tenantReasonPlaceholder; }
    else if (c.input === 'other') { label = T.causeOtherLabel; value = d.causeOther; set = v => { d.causeOther = v; }; ph = T.freePlaceholder; }
    else {
      label = c.label + 'の詳細'; value = sel.detail; ph = T.detailPlaceholder;
      set = v => { const x = d.causes.find(y => y.key === c.key); if (x) x.detail = v; };
    }
    const inp = edInput('rp-cause-' + c.key, 'text', value, v => { set(v); rfDirty(s); }, { placeholder: ph, autocomplete: 'off', maxLength: c.input === 'detail' ? 200 : 1000 });
    inp.dataset.cause = c.key;
    inp.disabled = s.ro;
    rows.push(edField(label, inp, null, 'rep-ff-sub'));
  });
  s.els.causeInputs.replaceChildren(...rows);
  s.els.causeInputs.hidden = rows.length === 0;
}

/* ---------- 次の対応方針（1つ選ぶ。Task 20） ---------- */
// 原因元工事 → 見積書提案期日（必須）／再調査 → 理由・再調査の内容（必須）／その他 → 自由記載。選んだものをもう一度押すと選ばない状態に
function edNextPicker(s, parent) {
  const L = ReportLogic, T = L.TEXT, d = s.f.data, els = s.els;
  const n = d.nextAction;
  els.nextWrap = rfMk('div', 'rep-ff');
  els.nextWrap.id = 'rp-next-wrap';
  const ttl = rfMk('div', 'rep-lbl-row');
  ttl.appendChild(rfMk('label', null, T.f4Label));
  els.nextWrap.append(ttl, rfMk('span', 'rep-hint', T.f4Pick + '。' + T.f4Hint));
  const grid = rfMk('div', 'rep-checks grid3');
  grid.id = 'rp-next';
  grid.setAttribute('role', 'radiogroup');
  grid.setAttribute('aria-label', T.f4Label);
  const btns = {};
  L.NEXT_ACTIONS.forEach(a => {
    const b = edCheck(a.label, n.type === a.key, s.ro, now => {
      n.type = now ? a.key : '';
      Object.keys(btns).forEach(k => edSetOn(btns[k], n.type === k));
      edApplyNext(s);
      rfDirty(s);
      const first = now && els.nextFields[a.key] && els.nextFields[a.key].querySelector('input,textarea');
      if (first) first.focus();
    }, true);
    b.dataset.next = a.key;
    b.setAttribute('role', 'radio');
    btns[a.key] = b;
    grid.appendChild(b);
  });
  els.nextWrap.appendChild(grid);
  // 選んだときだけ出る欄
  const sub = (key, ...fields) => { const w = rfMk('div', 'rep-sub-fields'); w.dataset.next = key; w.append(...fields); els.nextWrap.appendChild(w); return w; };
  const ta = (id, key, ph) => {
    const t = edTextarea(id, n[key], true, ph, v => { n[key] = v; rfDirty(s); });
    t.maxLength = 1000;
    return t;
  };
  els.nextFields = {};
  els.nextDue = edInput('rp-next-due', 'date', n.estimateDue, v => { n.estimateDue = v; rfDirty(s); });
  els.nextFields.cause = sub('cause', edField(T.estimateDueLabel + ' *', els.nextDue, T.estimateDueHint, 'rep-ff-sub'));
  els.nextReason = ta('rp-next-reason', 'reason', '例：天井裏まで確認できなかった');
  els.nextDetail = ta('rp-next-detail', 'detail', '例：点検口を開けて給水管の継手を確認する');
  els.nextFields.resurvey = sub('resurvey', edField(T.resurveyReasonLabel + ' *', els.nextReason, null, 'rep-ff-sub'),
    edField(T.resurveyDetailLabel + ' *', els.nextDetail, null, 'rep-ff-sub'));
  els.nextOther = ta('rp-next-other', 'other', T.freePlaceholder);
  els.nextFields.other = sub('other', edField(T.nextOtherLabel, els.nextOther, null, 'rep-ff-sub'));
  parent.appendChild(els.nextWrap);
  edApplyNext(s);
}
function edApplyNext(s) {
  const t = s.f.data.nextAction.type;
  Object.keys(s.els.nextFields).forEach(k => { s.els.nextFields[k].hidden = k !== t; });
}

function edRenderWorkChips(s) {
  const L = ReportLogic, d = s.f.data;
  const sel = Array.isArray(d.workChecklist) ? d.workChecklist : [];
  const list = L.WORK_CHECKLISTS[s.f.work_type] || [];
  s.els.workChips.replaceChildren(...list.map(t => edCheck(t, sel.includes(t), s.ro, on => edToggleIn(s, 'workChecklist', t, on))));
}

// 漏水の対応・元栓の号室の表示条件（旧 onLeakChange 620–622行 / onLeakActionChange 623–626行）
function edApplyLeak(s) {
  const L = ReportLogic, e = s.els, d = s.f.data;
  const cfg = L.MODES[s.f.work_type];
  const leaking = cfg.showLeak && String(d.leak || '').startsWith('漏れている');
  e.leakWrap.hidden = !cfg.showLeak;
  e.leakActionWrap.hidden = !leaking;
  e.leakRoomWrap.hidden = !(leaking && d.leakAction === L.LEAK_ACTION_MAIN_VALVE);
}

// 作業区分を切り替えたときの表示（他の区分の入力は消さず、隠すだけ）
function edApplyMode(s) {
  const L = ReportLogic, e = s.els;
  const k = s.f.work_type, cfg = L.MODES[k];
  if (e.seg) {
    e.seg.querySelectorAll('button').forEach(b => {
      const on = b.dataset.mode === k;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  Object.keys(e.chipCards).forEach(m => { e.chipCards[m].hidden = m !== k; });
  e.f1Label.textContent = cfg.f1Label + (cfg.f1Req ? ' *' : '');
  e.f1.placeholder = cfg.f1ph;
  edApplyLeak(s);
  e.afterWrap.hidden = !cfg.showAfter;
  e.causeWrap.hidden = !cfg.pickCause;
  e.nextWrap.hidden = !cfg.pickNext;
  e.f2Wrap.hidden = !cfg.showF2 || (cfg.pickCause && !s.legacy.f2);
  e.reasonWrap.hidden = !cfg.showReason;
  e.f4Wrap.hidden = !cfg.showF4 || (cfg.pickNext && !s.legacy.f4);
  e.photoAdd.textContent = '📷 ' + cfg.ctxPhotoLabel + 'を追加';
  edRenderWorkChips(s);
}

/* ---------- 写真の一覧 ---------- */
// h: { thumb(p, i) → 要素, move(i, dir), remove(i), after(), mark(i)（印の編集シートを開く。任意）, canMark(p)（任意） }
//   キャプション/区分の変更は p を直接書き換えて onDirty(s, true)
function rfRenderPhotos(s, h) {
  const T = ReportLogic.TEXT;
  const photos = s.report.photos || [];
  s.els.photoTitle.textContent = '写真 ' + photos.length + '枚';
  s.els.photoAdd.hidden = s.ro;
  if (!photos.length) {
    s.els.photoList.replaceChildren(rfMk('div', 'rep-sub rep-ph-empty', '写真はまだありません'));
    if (h.after) h.after();
    return;
  }
  const rows = photos.map((p, i) => {
    const row = rfMk('div', 'rep-ph' + (s.ro ? ' ro' : ''));
    row.dataset.i = String(i);
    // サムネイル＋「印を付ける」（Task 14。h.mark があり、読み取り専用でなく、h.canMark(p) が真のとき）
    const tw = rfMk('div', 'rep-ph-t');
    const th = h.thumb(p, i);
    tw.appendChild(th);
    if (h.mark && !s.ro && (!h.canMark || h.canMark(p))) {
      const n = Array.isArray(p.marks) ? p.marks.length : 0;
      const mb = rfMk('button', 'rep-ph-mark' + (n ? ' has' : ''), n ? '✏ 印 ' + n + '個' : '✏ 印を付ける');
      mb.type = 'button';
      mb.dataset.mv = 'mark';
      mb.setAttribute('aria-label', 'No.' + (i + 1) + ' に印を付ける');
      mb.addEventListener('click', () => h.mark(i));
      tw.appendChild(mb);
      th.classList.add('pme-open');
      th.addEventListener('click', () => { if (!mb.disabled) h.mark(i); });
    }
    row.appendChild(tw);

    const f = rfMk('div', 'rep-ph-f');
    const cap = document.createElement('input');
    cap.type = 'text';
    cap.className = 'rp-cap';
    cap.value = p.caption || '';
    cap.maxLength = 200;
    cap.placeholder = T.photoCaptionPlaceholder;
    cap.setAttribute('aria-label', 'No.' + (i + 1) + ' キャプション');
    cap.addEventListener('input', () => { p.caption = cap.value; rfDirty(s, true); });
    const phase = edSelect('', edPhaseOptions(), p.phase || '', v => { p.phase = v; rfDirty(s, true); });
    phase.removeAttribute('id');
    phase.className = 'rp-phase';
    phase.setAttribute('aria-label', 'No.' + (i + 1) + ' 区分');
    f.append(cap, phase);
    row.appendChild(f);

    if (!s.ro) {
      const mv = rfMk('div', 'rep-ph-mv');
      const up = rfMk('button', null, '↑'); up.type = 'button'; up.dataset.mv = 'up'; up.setAttribute('aria-label', 'No.' + (i + 1) + ' を上へ');
      up.addEventListener('click', () => h.move(i, -1));
      const dn = rfMk('button', null, '↓'); dn.type = 'button'; dn.dataset.mv = 'down'; dn.setAttribute('aria-label', 'No.' + (i + 1) + ' を下へ');
      dn.addEventListener('click', () => h.move(i, 1));
      const del = rfMk('button', 'del', '🗑'); del.type = 'button'; del.dataset.mv = 'del'; del.setAttribute('aria-label', 'No.' + (i + 1) + ' を削除');
      del.addEventListener('click', () => h.remove(i));
      mv.append(up, dn, del);
      row.appendChild(mv);
    }
    return row;
  });
  s.els.photoList.replaceChildren(...rows);
  if (h.after) h.after();
}

// 写真まわりの操作の有効/無効（busy なら全部無効。端の ↑ ↓ は押せない）
function rfSyncPhotoRows(s, busy) {
  s.els.photoAdd.disabled = busy;
  const rows = s.els.photoList.querySelectorAll('.rep-ph');
  rows.forEach((row, i) => {
    row.querySelectorAll('input,select,button').forEach(e => { e.disabled = busy; });
    if (busy) return;
    const up = row.querySelector('[data-mv="up"]'), dn = row.querySelector('[data-mv="down"]');
    if (up) up.disabled = i === 0;
    if (dn) dn.disabled = i === rows.length - 1;
  });
}
