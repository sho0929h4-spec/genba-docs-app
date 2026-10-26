// js/estimate-presets.js — 見積の「よく使う明細」（定型）の画面（対応フェーズ Task 11 / migration 029、Task 22、Task 49 / migration 068）
//   2段: 自分専用（owner_user_id = 自分。本人だけが読む・書く）と 会社共通（owner_user_id = null。全員が読む・管理者だけが書く）
//   見積画面（⑭ #estimate/{id}）の明細の下に置く（明細の下の唯一の追加候補。固定のクイック追加は Task 22 で廃止）:
//     - ボタン列: 自分専用 → 会社共通 の順（ある段だけ見出しつき）。今の見積のフェーズの種類（estimates.phase_id → case_phases.kind）＋共通。
//       各ボタンは「＋ 名前 ¥金額」。押すと行を末尾に足す（hooks.add → estimate-ui の eueAddPreset。自動保存・合計・諸経費の自動行の再計算はそちら）
//       行は定型の写し。後で定型を変えても作った見積書は変わらない。金額の「−」「＋」（Task 22 の刻み）は Task 49 で廃止
//     - 「よく使う明細に登録」シート（明細行の「…」から）: 名前＝摘要が初期値、種類＝今のフェーズの種類が初期値（共通なども選べる）。
//       登録先は作業担当者なら自分専用だけ、管理者は 自分専用／会社共通 を選べる
//     - 「よく使う明細を編集」シート（全員）: 上の「自分専用／会社共通」の切替。段ごと・種類ごとの一覧・名前／種類／摘要／詳細／数量／単位／金額の変更・
//       ↑↓・削除（画面内で確かめる）・「＋ 候補を追加」（空の候補。保存で登録。摘要が空なら名前を摘要にする）。
//       作業担当者の会社共通は見るだけ（入力欄・ボタンなし）
//   シートは入力があるので、外側のクリック・Esc では閉じない（× とキャンセル／閉じるだけ）。
//   ユーザー入力は createElement + textContent で描く（innerHTML は使わない）。alert / confirm は使わない。
// 計算・判定は EstimateLogic（presetToLine / lineToPreset / validatePreset / presetsFor / groupPresets / movePreset）、
// DB は EstimatePresetsApi。mk は case-list.js、dBtn / errText は case-detail.js のものを使う。
const EstimatePresets = (() => {
  const EL = () => window.EstimateLogic;
  const KL = k => EL().PRESET_KIND_LABEL[k] || k;
  let list = null;          // 会社の定型（読み込み済みなら配列）
  let loading = null;       // 読み込み中の Promise
  let cur = null;           // 表示中の見積画面 { s, hooks, root, btns, msg, kind }
  let uid = 0;
  const TIER_LABEL = { mine: '自分専用', company: '会社共通' };
  const tierOf = p => EL().presetTier(p);
  const canCompany = () => !!(typeof ctx !== 'undefined' && ctx && ctx.membership && ctx.membership.role === 'owner'); // 会社共通を書けるのは管理者だけ（068）
  const myId = () => (typeof ctx !== 'undefined' && ctx && ctx.user ? ctx.user.id : null);
  // 登録・編集で最初に選ぶ段: 管理者の管理画面は会社共通、それ以外（作業担当者・現場用）は自分専用
  const defaultTier = () => (canCompany() && !(typeof fieldHidesAdmin === 'function' && fieldHidesAdmin()) ? 'company' : 'mine');
  const tierList = t => (list || []).filter(p => tierOf(p) === t);

  // ── 小物 ──────────────────────────────────────────────────────────────
  const str = v => (v == null ? '' : String(v));
  const yen = n => EL().yen(n);
  function normNum(v) {
    return str(v).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[．。]/g, '.').replace(/[－−ー‐]/g, '-').replace(/[,，¥￥円\s]/g, '');
  }
  // 数の入力 → Number（正しくなければ NaN）
  function parseNum(v) {
    const t = normNum(v);
    if (!/^-?\d*\.?\d*$/.test(t) || !/\d/.test(t)) return NaN;
    return Number(t);
  }
  function input(cls, value, extra) {
    const i = document.createElement('input');
    i.type = 'text';
    i.className = cls;
    i.id = 'eu-pr-f' + (++uid);
    i.value = value == null ? '' : String(value);
    i.autocomplete = 'off';
    const x = extra || {};
    if (x.maxLength) i.maxLength = x.maxLength;
    if (x.inputMode) i.inputMode = x.inputMode;
    if (x.placeholder) i.placeholder = x.placeholder;
    if (x.list) i.setAttribute('list', x.list);
    return i;
  }
  function field(label, control, cls) {
    const w = mk('div', 'eu-pr-ff' + (cls ? ' ' + cls : ''));
    const l = mk('label', null, label);
    l.htmlFor = control.id;
    w.append(l, control);
    return w;
  }
  function kindSelect(value, id) {
    const sel = document.createElement('select');
    sel.className = 'eu-pr-kind';
    sel.id = id || ('eu-pr-f' + (++uid));
    EL().PRESET_KINDS.forEach(k => sel.appendChild(new Option(KL(k), k)));
    sel.value = EL().PRESET_KINDS.includes(value) ? value : 'common';
    return sel;
  }
  // 行の短い説明「給水管補修 ・ 1 式 ・ ¥35,000」
  function lineText(line) {
    const l = line || {};
    const amt = Number.isFinite(Number(l.unitPrice)) && l.unitPrice !== undefined && l.unitPrice !== null
      ? yen(Math.round(Number(l.unitPrice) * (Number(l.quantity) || 0))) + '（単価 ' + yen(l.unitPrice) + '）'
      : (Number(l.amount) ? yen(l.amount) : '金額は入力待ち');
    return [str(l.description), str(l.quantity) + ' ' + str(l.unit), amt].filter(Boolean).join(' ・ ');
  }
  function sheet(id, title) {
    const prev = document.getElementById(id);
    if (prev) prev.remove();
    const bg = mk('div', 'modal-bg ph-sheet-bg eu-pr-bg');
    bg.id = id;
    const dlg = mk('div', 'modal ph-sheet eu-pr-sheet');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', id + '-title');
    const hd = mk('div', 'modal-hd');
    const h = mk('h3', null, title);
    h.id = id + '-title';
    const x = mk('button', 'modal-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', '閉じる');
    hd.append(h, x);
    dlg.appendChild(hd);
    bg.appendChild(dlg);
    // 外側のクリック・Esc では閉じない（入力のあるシート）。背景のスクロールだけ止める
    document.body.appendChild(bg);
    document.body.classList.add('eu-pr-open');
    const close = () => {
      bg.remove();
      if (!document.querySelector('.eu-pr-bg')) document.body.classList.remove('eu-pr-open');
    };
    return { bg, dlg, x, close };
  }

  // ── 読み込み ───────────────────────────────────────────────────────────
  async function load(force) {
    if (list && !force) return list;
    if (loading && !force) return loading;
    const p = EstimatePresetsApi.list().then(rows => { list = rows || []; return list; });
    loading = p;
    try { return await p; } finally { if (loading === p) loading = null; }
  }
  function replaceInList(row) {
    if (!list) return;
    const i = list.findIndex(p => p.id === row.id);
    if (i >= 0) list[i] = row; else list.push(row);
  }

  // 見積のフェーズの種類: 案件の要約（case_summaries.phases）にあればそれ、無ければ case_phases から
  async function phaseKind(s) {
    const pid = s && s.row && s.row.phase_id;
    if (!pid) return null;
    const ph = ((s.caseRow && s.caseRow.phases) || []).find(p => p && p.id === pid);
    if (ph && ph.kind) return ph.kind;
    try { return await EstimatePresetsApi.phaseKind(pid); } catch (e) { return null; }
  }

  // ── 見積画面のボタン列 ──────────────────────────────────────────────────
  // s: estimate-ui の編集セッション。hooks: { add(preset, amount) }
  function section(s, hooks) {
    const root = mk('div', 'eu-pr');
    root.id = 'eu-presets';
    const ttl = mk('div', 'rep-group-ttl eu-pr-ttl');
    const t1 = mk('span', null, 'よく使う明細');
    const t2 = mk('span', 'eu-pr-kinds', '');
    t2.id = 'eu-presets-kinds';
    ttl.append(t1, t2);
    const btns = mk('div', 'eu-pr-btns');
    btns.id = 'eu-presets-btns';
    btns.appendChild(mk('span', 'rep-sub', '読み込み中…'));
    const acts = mk('div', 'eu-pr-acts');
    // 編集シートは全員（Task 49: 作業担当者は自分専用を増やす・直す。会社共通を直せるのは管理者だけ＝DB も 068）
    const edit = dBtn('よく使う明細を編集', 'btn sm ghost inline', () => openEditor());
    edit.id = 'eu-presets-edit';
    acts.appendChild(edit);
    const msg = mk('div', 'rep-sub eu-pr-msg');
    msg.id = 'eu-presets-msg';
    msg.setAttribute('role', 'status');
    root.append(ttl, btns, acts, msg);
    const me = { s, hooks, root, btns, msg, kinds: t2, kind: undefined };
    cur = me;
    (async () => {
      me.kind = await phaseKind(s);
      if (cur !== me) return;
      try { await load(); } catch (e) {
        if (cur !== me) return;
        btns.replaceChildren(mk('span', 'err', 'よく使う明細を読み込めませんでした: ' + errText(e)));
        const retry = dBtn('再読み込み', 'btn sm ghost inline', async () => { list = null; renderButtons(); try { await load(true); } catch (_) { /* 下で出す */ } renderButtons(); });
        retry.id = 'eu-presets-retry';
        btns.appendChild(retry);
        return;
      }
      if (cur !== me) return;
      renderButtons();
    })();
    return root;
  }
  function presetButton(me, p) {
    const amt = EL().presetAmount(p);
    const name = str(p.label);
    const b = mk('button', 'btn sm ghost inline eu-pr-btn');
    b.type = 'button';
    b.dataset.presetId = p.id;
    b.appendChild(mk('span', 'eu-pr-name', '＋ ' + name));
    if (amt) b.appendChild(mk('span', 'eu-pr-amt', yen(amt)));
    b.title = lineText(p.line) + ' ・ ' + KL(p.kind) + ' ・ ' + TIER_LABEL[tierOf(p)];
    b.setAttribute('aria-label', name + (amt ? ' ' + yen(amt) : '') + ' を明細に追加（' + TIER_LABEL[tierOf(p)] + '）');
    b.addEventListener('click', () => {
      if (me.s.readOnly) return;
      me.hooks.add(p);
      me.msg.textContent = '「' + name + '」' + (amt ? yen(amt) + ' ' : '') + 'を明細の最後に足しました';
    });
    return b;
  }
  function renderButtons(note) {
    const me = cur;
    if (!me) return;
    const kinds = EL().presetKindsFor(me.kind);
    me.kinds.textContent = '（' + kinds.map(KL).join('・') + '）';
    if (!list) { me.btns.replaceChildren(mk('span', 'rep-sub', '読み込み中…')); return; }
    const ps = EL().presetsFor(list, me.kind);
    if (!ps.length) {
      const e = mk('span', 'rep-sub eu-pr-empty', 'まだありません。「よく使う明細を編集」の「＋ 候補を追加」か、明細の「…」→「よく使う明細に登録」で増やせます');
      e.id = 'eu-presets-empty';
      me.btns.replaceChildren(e);
    } else {
      const focused = document.activeElement && me.btns.contains(document.activeElement) ? document.activeElement.dataset.presetId : null;
      // 自分専用 → 会社共通（ある段だけ。presetsFor が自分専用を先に並べる）
      me.btns.replaceChildren(...['mine', 'company'].map(t => {
        const items = ps.filter(p => tierOf(p) === t);
        if (!items.length) return null;
        const row = mk('div', 'eu-pr-tier');
        row.dataset.tier = t;
        row.appendChild(mk('span', 'eu-pr-tier-h', TIER_LABEL[t]));
        items.forEach(p => row.appendChild(presetButton(me, p)));
        return row;
      }).filter(Boolean));
      if (focused) {
        const el = me.btns.querySelector('button[data-preset-id="' + focused + '"]');
        if (el) el.focus({ preventScroll: true });
      }
    }
    if (note !== undefined) me.msg.textContent = note;
  }

  // ── 登録シート（明細行の「…」→「よく使う明細に登録」）───────────────────────
  function openRegister(s, line) {
    const pl = EL().lineToPreset(line);
    const sh = sheet('eu-pr-reg', 'よく使う明細に登録');
    const { dlg, x, close } = sh;
    let busy = false;
    const back = () => { close(); const b = document.querySelector('[data-id="' + (line && line.id) + '"] .more'); if (b) b.focus({ preventScroll: true }); };
    x.addEventListener('click', () => { if (!busy) back(); });
    dlg.appendChild(mk('div', 'rep-sub eu-pr-sub', '見積画面の「よく使う明細」にボタンで出ます。押すとこの行と同じ内容の行が増えます'));
    if (!pl) {
      dlg.appendChild(mk('div', 'err', line && (line.isAutoShokehi || line.postTax)
        ? '諸経費の自動行・税対象外の行は登録できません'
        : '摘要が空の行は登録できません。摘要を入れてから登録してください'));
      const ok = dBtn('閉じる', 'btn ghost', back);
      ok.id = 'eu-pr-reg-cancel';
      const a = mk('div', 'modal-act');
      a.appendChild(ok);
      dlg.appendChild(a);
      return;
    }
    const pv = mk('div', 'eu-pr-pv', lineText(pl));
    pv.id = 'eu-pr-reg-line';
    dlg.appendChild(pv);
    if (pl.detail) dlg.appendChild(mk('div', 'rep-sub eu-pr-pv-d', '詳細: ' + pl.detail));
    const label = input('eu-pr-label', EL().presetDefaultLabel(pl), { maxLength: EL().PRESET_LABEL_MAX });
    label.id = 'eu-pr-reg-label';
    dlg.appendChild(field('名前（ボタンに出ます・' + EL().PRESET_LABEL_MAX + '字まで）', label));
    const k0 = cur && cur.s === s ? cur.kind : null;
    const kind = kindSelect(k0 || 'common', 'eu-pr-reg-kind');
    dlg.appendChild(field('種類（その種類のフェーズの見積に出ます。共通はすべての見積に出ます）', kind));
    // 登録先: 作業担当者は自分専用だけ。管理者は選べる（会社共通は社内の全員に出る）
    let tierSel = null;
    if (canCompany()) {
      tierSel = document.createElement('select');
      tierSel.className = 'eu-pr-kind';
      tierSel.id = 'eu-pr-reg-tier';
      tierSel.append(new Option('自分専用（自分の見積書だけに出ます）', 'mine'), new Option('会社共通（社内の全員の見積書に出ます）', 'company'));
      tierSel.value = defaultTier();
      dlg.appendChild(field('登録先', tierSel));
    } else {
      const tn = mk('div', 'rep-sub eu-pr-tier-note', '「自分専用」に登録します（ほかの人には見えません）');
      tn.id = 'eu-pr-reg-tier-note';
      dlg.appendChild(tn);
    }
    const err = mk('div', 'err eu-pr-err');
    err.id = 'eu-pr-reg-err';
    err.setAttribute('role', 'alert');
    dlg.appendChild(err);
    const a = mk('div', 'modal-act');
    const cancel = dBtn('キャンセル', 'btn ghost', () => { if (!busy) back(); });
    cancel.id = 'eu-pr-reg-cancel';
    const save = dBtn('登録する', 'btn', async () => {
      if (busy) return;
      const row = { kind: kind.value, label: label.value.trim(), line: pl };
      const v = EL().validatePreset(row);
      if (!v.ok) { err.textContent = v.errors.join('・'); label.focus(); return; }
      busy = true;
      save.disabled = cancel.disabled = x.disabled = true;
      save.textContent = '登録中…';
      err.textContent = '';
      let made = null;
      const tier = tierSel ? tierSel.value : 'mine';
      try {
        if (!list) await load();
        row.sort = EL().nextPresetSort(tierList(tier), row.kind);
        made = await EstimatePresetsApi.create(Object.assign({}, row, tier === 'mine' ? { owner_user_id: myId() } : {}));
      } catch (e) { err.textContent = '登録できませんでした: ' + errText(e); }
      busy = false;
      save.disabled = cancel.disabled = x.disabled = false;
      save.textContent = '登録する';
      if (!made) return;
      replaceInList(made);
      back();
      if (cur && cur.s === s) {
        const shown = EL().presetKindsFor(cur.kind).includes(made.kind);
        renderButtons('「' + made.label + '」を' + TIER_LABEL[tierOf(made)] + 'に登録しました' + (shown ? '' : '（' + KL(made.kind) + 'の見積に出ます）'));
      }
    });
    save.id = 'eu-pr-reg-save';
    a.append(cancel, save);
    dlg.appendChild(a);
    label.focus();
    label.select();
  }

  // ── 編集シート ─────────────────────────────────────────────────────────
  // drafts: 保存していない入力（描き直しても残す）id → { label, description, detail, quantity, unit, amount, kind }
  // news: 「＋ 候補を追加」で足した、まだ保存していない候補の仮の id（'new-1' …）。newTier: 仮の id → 段
  // tier: 見ている段（上の「自分専用／会社共通」の切替）
  function openEditor() {
    const sh = sheet('eu-pr-edit', 'よく使う明細を編集');
    const { dlg, x, close } = sh;
    dlg.classList.add('eu-pr-wide');
    const st = { drafts: new Map(), busy: new Set(), armDel: null, armClose: false, news: [], newNo: 0, newTier: new Map(), tier: defaultTier() };
    const editable = () => st.tier === 'mine' || canCompany();
    const tryClose = () => {
      if (st.busy.size) return;
      if (st.drafts.size && !st.armClose) {
        st.armClose = true;
        foot.textContent = '保存していない変更があります。もう一度「閉じる」を押すと、変更を捨てて閉じます';
        foot.className = 'err eu-pr-foot';
        return;
      }
      close();
      const b = document.getElementById('eu-presets-edit');
      if (b) b.focus({ preventScroll: true });
    };
    x.addEventListener('click', tryClose);
    const howTo = mk('div', 'rep-sub eu-pr-sub', '変えたら各明細の「保存」を押してください。↑↓ と削除はすぐに反映されます');
    dlg.appendChild(howTo);
    const sw = mk('div', 'eu-choice eu-pr-tiers');
    sw.id = 'eu-pr-tiers';
    sw.setAttribute('role', 'group');
    sw.setAttribute('aria-label', '見る明細');
    const tierBtns = ['mine', 'company'].map(t => {
      const b = dBtn(TIER_LABEL[t], 'eu-choice-b', () => { if (st.tier === t) return; st.tier = t; st.armDel = null; render(); });
      b.dataset.tier = t;
      sw.appendChild(b);
      return b;
    });
    const tierNote = mk('div', 'rep-sub eu-pr-tier-note');
    tierNote.id = 'eu-pr-tier-note';
    dlg.append(sw, tierNote);
    const body = mk('div', 'eu-pr-list');
    body.id = 'eu-pr-list';
    body.appendChild(mk('div', 'rep-sub', '読み込み中…'));
    dlg.appendChild(body);
    // 空の候補を足す（保存するまで DB には入らない）
    const addNew = dBtn('＋ 候補を追加', 'btn sm ghost inline eu-pr-add', () => {
      if (!list) return;
      if (!editable()) return;
      const tid = 'new-' + (++st.newNo);
      st.news.push(tid);
      st.newTier.set(tid, st.tier);
      render();
      const f = body.querySelector('[data-preset-id="' + tid + '"] .eu-pr-i-label');
      if (f) { f.scrollIntoView({ block: 'center' }); f.focus({ preventScroll: true }); }
      say('新しい候補の名前と金額を入れて「保存」を押してください');
    });
    addNew.id = 'eu-pr-add';
    dlg.appendChild(addNew);
    const foot = mk('div', 'rep-sub eu-pr-foot');
    foot.id = 'eu-pr-edit-msg';
    foot.setAttribute('role', 'status');
    dlg.appendChild(foot);
    const a = mk('div', 'modal-act');
    const done = dBtn('閉じる', 'btn ghost', tryClose);
    done.id = 'eu-pr-edit-close';
    a.appendChild(done);
    dlg.appendChild(a);
    const say = (t, bad) => { foot.textContent = t; foot.className = (bad ? 'err' : 'rep-sub') + ' eu-pr-foot'; st.armClose = false; };

    const render = () => {
      tierBtns.forEach(b => { const on = b.dataset.tier === st.tier; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      tierNote.textContent = st.tier === 'mine' ? '自分専用: 自分の見積書だけに出ます（ほかの人には見えません）'
        : '会社共通: 社内の全員の見積書に出ます' + (canCompany() ? '' : '。変えられるのは管理者だけです（見るだけ）');
      addNew.hidden = howTo.hidden = !editable();
      if (!list) return;
      const groups = EL().groupPresets(tierList(st.tier));
      const nodes = [];
      groups.forEach(g => {
        const sec = mk('section', 'eu-pr-grp');
        sec.dataset.kind = g.kind;
        sec.appendChild(mk('div', 'eu-pr-grp-h', g.label + '（' + g.items.length + '件）'));
        if (!g.items.length) sec.appendChild(mk('div', 'rep-sub eu-pr-none', 'なし'));
        g.items.forEach((p, i) => sec.appendChild(editable() ? item(p, i, g.items.length) : viewItem(p)));
        nodes.push(sec);
      });
      const news = st.news.filter(tid => st.newTier.get(tid) === st.tier);
      if (news.length) {
        const sec = mk('section', 'eu-pr-grp eu-pr-grp-new');
        sec.id = 'eu-pr-new';
        sec.appendChild(mk('div', 'eu-pr-grp-h', '追加する候補（まだ保存していません）'));
        news.forEach(tid => sec.appendChild(item(blank(tid), 0, 1)));
        nodes.push(sec);
      }
      body.replaceChildren(...nodes);
    };
    // 見るだけ（作業担当者の会社共通）: 名前と行の中身だけ
    const viewItem = p => {
      const box = mk('div', 'eu-pr-item view');
      box.dataset.presetId = p.id;
      box.append(mk('div', 'eu-pr-v-name', str(p.label)), mk('div', 'rep-sub eu-pr-v-line', lineText(p.line)));
      if (p.line && p.line.detail) box.appendChild(mk('div', 'rep-sub eu-pr-v-line', '詳細: ' + p.line.detail));
      return box;
    };
    const blank = tid => ({ id: tid, isNew: true, kind: (cur && cur.kind) || 'common', label: '',
      line: { description: '', quantity: 1, unit: '式', amount: 0 } });
    const dropNew = tid => { st.news = st.news.filter(t => t !== tid); st.newTier.delete(tid); st.drafts.delete(tid); };
    const item = (p, i, n) => {
      const d = st.drafts.get(p.id) || {};
      const l = p.line || {};
      const hasUp = l.unitPrice != null && Number.isFinite(Number(l.unitPrice));
      const val = (k, v) => (d[k] !== undefined ? d[k] : v);
      const box = mk('div', 'eu-pr-item' + (st.drafts.has(p.id) ? ' dirty' : '') + (p.isNew ? ' new' : ''));
      box.dataset.presetId = p.id;
      const f = {
        label: input('eu-pr-i-label', val('label', p.label), { maxLength: EL().PRESET_LABEL_MAX }),
        description: input('eu-pr-i-desc', val('description', l.description), { maxLength: 200 }),
        detail: input('eu-pr-i-detail', val('detail', l.detail || ''), { maxLength: 500, placeholder: '詳細（任意）' }),
        quantity: input('eu-pr-i-qty eu-num', val('quantity', l.quantity), { inputMode: 'decimal' }),
        unit: input('eu-pr-i-unit', val('unit', l.unit), { maxLength: 10, list: 'eu-units' }),
        amount: input('eu-pr-i-amt eu-num', val('amount', EL().fmt(hasUp ? l.unitPrice : l.amount)), { inputMode: 'numeric' }),
        kind: kindSelect(val('kind', p.kind))
      };
      const grid = mk('div', 'eu-pr-grid');
      grid.append(
        field('名前（ボタン）', f.label, 'g-label'),
        field('種類', f.kind, 'g-kind'),
        field('摘要', f.description, 'g-desc'),
        field('詳細（任意）', f.detail, 'g-detail'),
        field('数量', f.quantity, 'g-qty'),
        field('単位', f.unit, 'g-unit'),
        field(hasUp ? '単価（金額＝単価×数量）' : '金額（円）', f.amount, 'g-amt'));
      if (p.isNew) f.description.placeholder = '空なら名前と同じ';
      box.appendChild(grid);
      const mark = () => {
        st.drafts.set(p.id, { label: f.label.value, description: f.description.value, detail: f.detail.value,
          quantity: f.quantity.value, unit: f.unit.value, amount: f.amount.value, kind: f.kind.value });
        box.classList.add('dirty');
        st.armClose = false;
      };
      Object.values(f).forEach(el => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', mark));
      const err = mk('div', 'err eu-pr-err');
      err.setAttribute('role', 'alert');
      const ops = mk('div', 'eu-pr-ops eu-ops');
      const op = (t, cls, label, fn, dis) => {
        const b = mk('button', cls, t);
        b.type = 'button';
        b.setAttribute('aria-label', label);
        b.disabled = !!dis;
        b.addEventListener('click', fn);
        ops.appendChild(b);
        return b;
      };
      const busy = () => st.busy.has(p.id);
      const nm = p.label || '新しい候補';
      if (!p.isNew) {
        op('↑', 'up', nm + ' を上へ', () => move(p, -1), i <= 0);
        op('↓', 'down', nm + ' を下へ', () => move(p, 1), i >= n - 1);
      }
      const sv = op('保存', 'save', nm + ' を保存', async () => {
        if (busy()) return;
        const qty = parseNum(f.quantity.value), amt = parseNum(f.amount.value);
        const label = f.label.value.trim();
        // 新しい候補は摘要が空なら名前を摘要にする
        const description = f.description.value.trim() || (p.isNew ? label : '');
        const line = { description, unit: f.unit.value.trim(),
          quantity: Number.isFinite(qty) ? qty : NaN, postTax: false };
        if (f.detail.value.trim()) line.detail = f.detail.value.trim();
        if (hasUp) { line.unitPrice = Number.isFinite(amt) ? amt : NaN; line.amount = Math.round(num0(l.amount)); }
        else line.amount = Number.isFinite(amt) ? Math.round(amt) : NaN;
        const row = { kind: f.kind.value, label, line };
        const v = EL().validatePreset(row);
        // 新しい候補で名前も摘要も空: 摘要は名前から作るので「名前を入力」だけ出す
        if (p.isNew && !description) v.errors = v.errors.filter(e => e !== '摘要を入力してください');
        if (hasUp && !Number.isFinite(line.unitPrice)) v.errors.push('単価が正しくありません');
        if (v.errors.length) { err.textContent = v.errors.join('・'); return; }
        st.busy.add(p.id);
        sv.disabled = true;
        sv.textContent = '保存中…';
        err.textContent = '';
        let saved = null;
        try {
          if (p.isNew) {
            const t = st.newTier.get(p.id) || 'mine';
            saved = await EstimatePresetsApi.create(Object.assign({}, row, { sort: EL().nextPresetSort(tierList(t), row.kind) }, t === 'mine' ? { owner_user_id: myId() } : {}));
          } else saved = await EstimatePresetsApi.update(p, Object.assign({}, row, row.kind !== p.kind ? { sort: EL().nextPresetSort(tierList(tierOf(p)), row.kind) } : {}));
        } catch (e) { err.textContent = (p.isNew ? '追加' : '保存') + 'できませんでした: ' + errText(e); }
        st.busy.delete(p.id);
        sv.disabled = false;
        sv.textContent = '保存';
        if (!saved) return;
        if (p.isNew) dropNew(p.id); else st.drafts.delete(p.id);
        replaceInList(saved);
        render();
        renderButtons();
        say('「' + saved.label + '」を' + (p.isNew ? '追加' : '保存') + 'しました');
      });
      const del = op(p.isNew ? 'やめる' : '削除', 'del', nm + (p.isNew ? ' の追加をやめる' : ' を削除'), () => {
        if (busy()) return;
        if (p.isNew) { dropNew(p.id); render(); say('追加をやめました'); return; }
        st.armDel = st.armDel === p.id ? null : p.id;
        render();
      });
      if (st.armDel === p.id) {
        del.hidden = true;
        const cf = mk('div', 'eu-pr-confirm');
        cf.appendChild(mk('span', null, '「' + str(p.label) + '」を削除しますか？（作った見積の行は消えません）'));
        const yes = dBtn('削除する', 'btn sm ghost inline danger', async () => {
          if (busy()) return;
          st.busy.add(p.id);
          yes.disabled = no.disabled = true;
          yes.textContent = '削除中…';
          let ok = false;
          try { await EstimatePresetsApi.remove(p.id); ok = true; }
          catch (e) { err.textContent = '削除できませんでした: ' + errText(e); }
          st.busy.delete(p.id);
          yes.disabled = no.disabled = false;
          yes.textContent = '削除する';
          if (!ok) return;
          st.armDel = null;
          st.drafts.delete(p.id);
          list = list.filter(q => q.id !== p.id);
          render();
          renderButtons();
          say('「' + str(p.label) + '」を削除しました');
        });
        yes.classList.add('eu-pr-del-yes');
        const no = dBtn('やめる', 'btn sm ghost inline', () => { st.armDel = null; render(); });
        no.classList.add('eu-pr-del-no');
        cf.append(yes, no);
        box.append(ops, cf, err);
      } else box.append(ops, err);
      return box;
    };
    const num0 = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const move = async (p, dir) => {
      if (st.busy.size) return;
      const changes = EL().movePreset(list, p.id, dir);
      if (!changes.length) return;
      st.busy.add(p.id);
      let ok = false;
      try { await EstimatePresetsApi.setSorts(changes); ok = true; }
      catch (e) { say('並び替えできませんでした: ' + errText(e), true); }
      st.busy.delete(p.id);
      if (ok) changes.forEach(c => { const q = list.find(r => r.id === c.id); if (q) q.sort = c.sort; });
      else { try { await load(true); } catch (_) { /* そのまま */ } }
      render();
      renderButtons();
      const b = body.querySelector('[data-preset-id="' + p.id + '"] .' + (dir < 0 ? 'up' : 'down'));
      if (b && !b.disabled) b.focus({ preventScroll: true });
    };

    (async () => {
      try { await load(); } catch (e) { body.replaceChildren(mk('div', 'err', '読み込めませんでした: ' + errText(e))); return; }
      render();
    })();
  }

  return {
    section, openRegister, openEditor,
    // テスト・別画面から: 次に開いたとき読み直す
    reset() { list = null; loading = null; cur = null; }
  };
})();
