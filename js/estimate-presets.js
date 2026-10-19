// js/estimate-presets.js — 見積の「よく使う明細」（定型）の画面（対応フェーズ Task 11 / migration 029）
//   見積画面（⑭ #estimate/{id}）の「クイック追加」の下に置く:
//     - ボタン列: 今の見積のフェーズの種類（estimates.phase_id → case_phases.kind）＋共通。フェーズが無ければ共通だけ。
//       押すと行を末尾に足す（hooks.add → estimate-ui の eueAddPreset。自動保存・合計・諸経費の自動行の再計算はそちら）
//     - 「よく使う明細に登録」シート（明細行の「…」から）: 名前＝摘要が初期値、種類＝今のフェーズの種類が初期値（共通なども選べる）
//     - 「よく使う明細を編集」シート: 種類ごとの一覧・名前／摘要／詳細／数量／単位／金額の変更・↑↓・削除（画面内で確かめる）
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
  // s: estimate-ui の編集セッション。hooks: { add(preset) }
  function section(s, hooks) {
    const root = mk('div', 'eu-pr');
    root.id = 'eu-presets';
    const ttl = mk('div', 'rep-group-ttl eu-pr-ttl');
    const t1 = mk('span', null, 'よく使う明細');
    const t2 = mk('span', 'eu-pr-kinds', '');
    t2.id = 'eu-presets-kinds';
    ttl.append(t1, t2);
    const btns = mk('div', 'eu-quick eu-pr-btns');
    btns.id = 'eu-presets-btns';
    btns.appendChild(mk('span', 'rep-sub', '読み込み中…'));
    const acts = mk('div', 'eu-pr-acts');
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
  function renderButtons(note) {
    const me = cur;
    if (!me) return;
    const kinds = EL().presetKindsFor(me.kind);
    me.kinds.textContent = '（' + kinds.map(KL).join('・') + '）';
    if (!list) { me.btns.replaceChildren(mk('span', 'rep-sub', '読み込み中…')); return; }
    const ps = EL().presetsFor(list, me.kind);
    if (!ps.length) {
      const e = mk('span', 'rep-sub eu-pr-empty', 'まだありません。明細の「…」→「よく使う明細に登録」で増やせます');
      e.id = 'eu-presets-empty';
      me.btns.replaceChildren(e);
    } else {
      me.btns.replaceChildren(...ps.map(p => {
        const b = mk('button', 'btn sm ghost inline eu-pr-btn');
        b.type = 'button';
        b.dataset.presetId = p.id;
        b.appendChild(mk('span', null, '＋ ' + str(p.label)));
        const l = p.line || {};
        const amt = l.unitPrice != null && Number.isFinite(Number(l.unitPrice)) ? Math.round(Number(l.unitPrice) * (Number(l.quantity) || 0)) : Number(l.amount) || 0;
        if (amt) b.appendChild(mk('span', 'eu-pr-amt', yen(amt)));
        if (me.kind && p.kind === 'common') b.classList.add('common');
        b.title = lineText(l) + ' ・ ' + KL(p.kind);
        b.setAttribute('aria-label', str(p.label) + ' を明細に追加（' + KL(p.kind) + '）');
        b.addEventListener('click', () => {
          if (me.s.readOnly) return;
          me.hooks.add(p);
          me.msg.textContent = '「' + str(p.label) + '」を明細の最後に足しました';
        });
        return b;
      }));
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
      try {
        if (!list) await load();
        row.sort = EL().nextPresetSort(list, row.kind);
        made = await EstimatePresetsApi.create(row);
      } catch (e) { err.textContent = '登録できませんでした: ' + errText(e); }
      busy = false;
      save.disabled = cancel.disabled = x.disabled = false;
      save.textContent = '登録する';
      if (!made) return;
      replaceInList(made);
      back();
      if (cur && cur.s === s) {
        const shown = EL().presetKindsFor(cur.kind).includes(made.kind);
        renderButtons('「' + made.label + '」を登録しました' + (shown ? '' : '（' + KL(made.kind) + 'の見積に出ます）'));
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
  function openEditor() {
    const sh = sheet('eu-pr-edit', 'よく使う明細を編集');
    const { dlg, x, close } = sh;
    dlg.classList.add('eu-pr-wide');
    const st = { drafts: new Map(), busy: new Set(), armDel: null, armClose: false };
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
    dlg.appendChild(mk('div', 'rep-sub eu-pr-sub', '変えたら各明細の「保存」を押してください。↑↓ と削除はすぐに反映されます'));
    const body = mk('div', 'eu-pr-list');
    body.id = 'eu-pr-list';
    body.appendChild(mk('div', 'rep-sub', '読み込み中…'));
    dlg.appendChild(body);
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
      if (!list) return;
      const groups = EL().groupPresets(list);
      const nodes = [];
      groups.forEach(g => {
        const sec = mk('section', 'eu-pr-grp');
        sec.dataset.kind = g.kind;
        sec.appendChild(mk('div', 'eu-pr-grp-h', g.label + '（' + g.items.length + '件）'));
        if (!g.items.length) sec.appendChild(mk('div', 'rep-sub eu-pr-none', 'なし'));
        g.items.forEach((p, i) => sec.appendChild(item(p, i, g.items.length)));
        nodes.push(sec);
      });
      body.replaceChildren(...nodes);
    };
    const item = (p, i, n) => {
      const d = st.drafts.get(p.id) || {};
      const l = p.line || {};
      const hasUp = l.unitPrice != null && Number.isFinite(Number(l.unitPrice));
      const val = (k, v) => (d[k] !== undefined ? d[k] : v);
      const box = mk('div', 'eu-pr-item' + (st.drafts.has(p.id) ? ' dirty' : ''));
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
      op('↑', 'up', p.label + ' を上へ', () => move(p, -1), i <= 0);
      op('↓', 'down', p.label + ' を下へ', () => move(p, 1), i >= n - 1);
      const sv = op('保存', 'save', p.label + ' を保存', async () => {
        if (busy()) return;
        const qty = parseNum(f.quantity.value), amt = parseNum(f.amount.value);
        const line = { description: f.description.value.trim(), unit: f.unit.value.trim(),
          quantity: Number.isFinite(qty) ? qty : NaN, postTax: false };
        if (f.detail.value.trim()) line.detail = f.detail.value.trim();
        if (hasUp) { line.unitPrice = Number.isFinite(amt) ? amt : NaN; line.amount = Math.round(num0(l.amount)); }
        else line.amount = Number.isFinite(amt) ? Math.round(amt) : NaN;
        const row = { kind: f.kind.value, label: f.label.value.trim(), line };
        const v = EL().validatePreset(row);
        if (hasUp && !Number.isFinite(line.unitPrice)) v.errors.push('単価が正しくありません');
        if (v.errors.length) { err.textContent = v.errors.join('・'); return; }
        st.busy.add(p.id);
        sv.disabled = true;
        sv.textContent = '保存中…';
        err.textContent = '';
        let saved = null;
        try { saved = await EstimatePresetsApi.update(p, Object.assign({}, row, row.kind !== p.kind ? { sort: EL().nextPresetSort(list, row.kind) } : {})); }
        catch (e) { err.textContent = '保存できませんでした: ' + errText(e); }
        st.busy.delete(p.id);
        sv.disabled = false;
        sv.textContent = '保存';
        if (!saved) return;
        st.drafts.delete(p.id);
        replaceInList(saved);
        render();
        renderButtons();
        say('「' + saved.label + '」を保存しました');
      });
      const del = op('削除', 'del', p.label + ' を削除', () => {
        if (busy()) return;
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
