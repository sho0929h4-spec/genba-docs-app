// js/estimate-templates.js — 見積書のテンプレート（何行かをまとめてワンタップで入れる。Task 78 / migration 092）
//   「よく使う明細」（1行ずつ・js/estimate-presets.js）とは別のもの。持ち主の決まりは同じ（自分専用＝本人だけ／会社共通＝全員が読む・管理者だけが書く）
//   見積画面（#estimate/{id}・編集できるときだけ）:
//     - 明細の上「テンプレートから作る」: 明細が空（初期の空行だけ）のときだけ。自分専用 → 会社共通。各ボタン「名前 ¥合計（税抜）」。
//       押すと明細をテンプレートの行で置き換える（hooks.apply → estimate-ui の eueApplyTemplate。自動保存・合計・諸経費の自動行はそちら）。明細が入ったら出さない
//     - 明細の下「この明細をテンプレートに登録」（明細が入っているとき）と「テンプレートを編集」
//   登録シート: 名前（初期値＝1行目の摘要・40字まで）・登録先（作業担当者は自分専用だけ）。写すのは明細の行だけ（原価・諸経費の自動行・値引きの行・備考は入れない）
//   編集シート: 自分専用／会社共通の切替・名前の変更・↑↓・削除（画面内で確かめる）・中身の行は見るだけ。作業担当者の会社共通は見るだけ
//   シートは × とキャンセル／閉じるだけで閉じる（外側のクリック・Esc では閉じない）。innerHTML・alert・confirm は使わない
// 計算・判定は EstimateLogic、DB は EstimateTemplatesApi、シート・入力欄・段の決まりは EstimatePresets.ui。mk / dBtn / errText は既存のもの
const EstimateTemplates = (() => {
  const EL = () => window.EstimateLogic;
  const U = () => EstimatePresets.ui;
  let list = null, loading = null, cur = null;
  const str = v => (v == null ? '' : String(v));
  const yen = n => EL().yen(n);
  const tierOf = t => EL().presetTier(t);
  const order = (a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || str(a.created_at).localeCompare(str(b.created_at)) || str(a.id).localeCompare(str(b.id));
  const tierList = t => (list || []).filter(x => tierOf(x) === t).sort(order);

  async function load(force) {
    if (list && !force) return list;
    if (loading && !force) return loading;
    const p = EstimateTemplatesApi.list().then(rows => { list = rows || []; return list; });
    loading = p;
    try { return await p; } finally { if (loading === p) loading = null; }
  }

  // 中身の行の一覧（見るだけ）
  function linesView(t) {
    const box = mk('div', 'eu-tpl-lines');
    (t.lines || []).forEach(l => box.appendChild(mk('div', 'rep-sub eu-pr-v-line', U().lineText(l) + (l.detail ? '（' + l.detail + '）' : ''))));
    box.appendChild(mk('div', 'eu-tpl-sum', '合計 ' + yen(EL().templateTotal(t)) + '（税抜）・' + (t.lines || []).length + '行'));
    return box;
  }

  // ── 見積画面: 明細の上の「テンプレートから作る」と、明細の下のボタン ─────────────────
  // hooks: { apply(tpl) }
  function section(s, hooks) {
    const root = mk('div', 'eu-pr eu-tpl');
    root.id = 'eu-tpl';
    root.hidden = true;
    root.appendChild(mk('div', 'rep-group-ttl eu-pr-ttl', 'テンプレートから作る'));
    const btns = mk('div', 'eu-pr-btns');
    btns.id = 'eu-tpl-btns';
    root.appendChild(btns);
    const acts = mk('div', 'eu-pr-acts eu-tpl-acts');
    acts.id = 'eu-tpl-acts';
    const reg = dBtn('この明細をテンプレートに登録', 'btn sm ghost inline', () => openRegister(s));
    reg.id = 'eu-tpl-reg';
    const edit = dBtn('テンプレートを編集', 'btn sm ghost inline', () => openEditor());
    edit.id = 'eu-tpl-edit';
    const msg = mk('div', 'rep-sub eu-pr-msg');
    msg.id = 'eu-tpl-msg';
    msg.setAttribute('role', 'status');
    acts.append(reg, edit, msg);
    const me = { s, hooks, root, btns, acts, reg, msg };
    cur = me;
    load().then(() => { if (cur === me) render(); }).catch(() => { /* 読めなければ「テンプレートから作る」を出さないだけ（編集シートで理由を出す） */ });
    sync(s);
    return { picker: root, actions: acts };
  }
  function render() {
    const me = cur;
    if (!me) return;
    me.btns.replaceChildren(...['mine', 'company'].map(t => {
      const items = tierList(t);
      if (!items.length) return null;
      const row = mk('div', 'eu-pr-tier');
      row.dataset.tier = t;
      row.appendChild(mk('span', 'eu-pr-tier-h', U().TIER_LABEL[t]));
      items.forEach(x => {
        const b = mk('button', 'btn sm ghost inline eu-pr-btn eu-tpl-btn');
        b.type = 'button';
        b.dataset.tplId = x.id;
        const total = yen(EL().templateTotal(x)) + '（税抜）';
        b.append(mk('span', 'eu-pr-name', str(x.name)), mk('span', 'eu-pr-amt', total));
        b.setAttribute('aria-label', str(x.name) + ' ' + total + ' の行で明細を作る（' + U().TIER_LABEL[t] + '）');
        b.addEventListener('click', () => {
          if (me.s.readOnly || !EL().isBlankEstimate(me.s.lines)) return;
          me.hooks.apply(x);
          me.msg.textContent = '「' + str(x.name) + '」の行を入れました。行を足す・直すのは今まで通りできます';
        });
        row.appendChild(b);
      });
      return row;
    }).filter(Boolean));
    sync(me.s);
  }
  // 明細が変わるたびに（estimate-ui の eueTotals から）: 空なら「テンプレートから作る」、入っていれば「登録」
  function sync(s) {
    const me = cur;
    if (!me || me.s !== s) return;
    const blank = EL().isBlankEstimate(s.lines);
    me.root.hidden = !blank || !(list && list.length);
    me.reg.hidden = blank;
  }

  // ── 登録シート ───────────────────────────────────────────────────────────
  function openRegister(s) {
    const tl = EL().linesToTemplate(s.lines);
    const { dlg, x, close } = U().sheet('eu-tpl-reg-sheet', 'この明細をテンプレートに登録');
    let busy = false;
    const back = () => { close(); const b = document.getElementById('eu-tpl-reg'); if (b) b.focus({ preventScroll: true }); };
    x.addEventListener('click', () => { if (!busy) back(); });
    dlg.appendChild(mk('div', 'rep-sub eu-pr-sub', '明細が空の見積書の上に「テンプレートから作る」のボタンで出ます。押すとこの行がまとめて入ります（備考・原価は入りません）'));
    const lineErr = EL().validateTemplate({ name: 'x', lines: tl });
    const a = mk('div', 'modal-act');
    const cancel = dBtn(lineErr.ok ? 'キャンセル' : '閉じる', 'btn ghost', () => { if (!busy) back(); });
    cancel.id = 'eu-tpl-reg-cancel';
    a.appendChild(cancel);
    if (!lineErr.ok) {
      const e = mk('div', 'err', lineErr.errors.join('・'));
      e.id = 'eu-tpl-reg-err';
      dlg.append(e, a);
      return;
    }
    const pv = linesView({ lines: tl });
    pv.id = 'eu-tpl-reg-lines';
    pv.classList.add('eu-pr-pv');
    dlg.appendChild(pv);
    if (s.lines.some(l => l.isAutoShokehi || l.postTax)) dlg.appendChild(mk('div', 'rep-sub eu-tpl-skip', '諸経費の自動行・値引きの行は入りません'));
    const name = U().input('eu-pr-label', EL().templateDefaultName(tl), { maxLength: EL().TEMPLATE_NAME_MAX });
    name.id = 'eu-tpl-reg-name';
    dlg.appendChild(U().field('名前（ボタンに出ます・' + EL().TEMPLATE_NAME_MAX + '字まで）', name));
    let tierSel = null;
    if (U().canCompany()) {
      tierSel = document.createElement('select');
      tierSel.className = 'eu-pr-kind';
      tierSel.id = 'eu-tpl-reg-tier';
      tierSel.append(new Option('自分専用（自分の見積書だけに出ます）', 'mine'), new Option('会社共通（社内の全員の見積書に出ます）', 'company'));
      tierSel.value = U().defaultTier();
      dlg.appendChild(U().field('登録先', tierSel));
    } else {
      const tn = mk('div', 'rep-sub eu-pr-tier-note', '「自分専用」に登録します（ほかの人には見えません）');
      tn.id = 'eu-tpl-reg-tier-note';
      dlg.appendChild(tn);
    }
    const err = mk('div', 'err eu-pr-err');
    err.id = 'eu-tpl-reg-err';
    err.setAttribute('role', 'alert');
    dlg.appendChild(err);
    const save = dBtn('登録する', 'btn', async () => {
      if (busy) return;
      const v = EL().validateTemplate({ name: name.value.trim(), lines: tl });
      if (!v.ok) { err.textContent = v.errors.join('・'); name.focus(); return; }
      busy = true;
      save.disabled = cancel.disabled = x.disabled = true;
      save.textContent = '登録中…';
      err.textContent = '';
      const tier = tierSel ? tierSel.value : 'mine';
      let made = null;
      try {
        if (!list) await load();
        made = await EstimateTemplatesApi.create({ name: name.value, lines: tl, sort: EL().nextPresetSort(tierList(tier), undefined),
          owner_user_id: tier === 'mine' ? U().myId() : null });
      } catch (e) { err.textContent = '登録できませんでした: ' + errText(e); }
      busy = false;
      save.disabled = cancel.disabled = x.disabled = false;
      save.textContent = '登録する';
      if (!made) return;
      list.push(made);
      back();
      if (cur && cur.s === s) { render(); cur.msg.textContent = '「' + made.name + '」を' + U().TIER_LABEL[tierOf(made)] + 'のテンプレートに登録しました。明細が空の見積書の上に出ます'; }
    });
    save.id = 'eu-tpl-reg-save';
    a.appendChild(save);
    dlg.appendChild(a);
    name.focus();
    name.select();
  }

  // ── 編集シート ───────────────────────────────────────────────────────────
  function openEditor() {
    const { dlg, x, close } = U().sheet('eu-tpl-edit-sheet', 'テンプレートを編集');
    dlg.classList.add('eu-pr-wide');
    const st = { drafts: new Map(), busy: new Set(), armDel: null, armClose: false, tier: U().defaultTier() };
    const editable = () => st.tier === 'mine' || U().canCompany();
    const say = (t, bad) => { foot.textContent = t; foot.className = (bad ? 'err' : 'rep-sub') + ' eu-pr-foot'; st.armClose = false; };
    const tryClose = () => {
      if (st.busy.size) return;
      if (st.drafts.size && !st.armClose) {
        st.armClose = true;
        foot.textContent = '保存していない名前の変更があります。もう一度「閉じる」を押すと、変更を捨てて閉じます';
        foot.className = 'err eu-pr-foot';
        return;
      }
      close();
      const b = document.getElementById('eu-tpl-edit');
      if (b) b.focus({ preventScroll: true });
    };
    x.addEventListener('click', tryClose);
    const howTo = mk('div', 'rep-sub eu-pr-sub', '名前を変えたら「保存」を押してください。↑↓ と削除はすぐに反映されます。中身の行を直すときは、見積書で直してから登録し直してください');
    const sw = mk('div', 'eu-choice eu-pr-tiers');
    sw.id = 'eu-tpl-tiers';
    sw.setAttribute('role', 'group');
    sw.setAttribute('aria-label', '見るテンプレート');
    const tierBtns = ['mine', 'company'].map(t => {
      const b = dBtn(U().TIER_LABEL[t], 'eu-choice-b', () => { if (st.tier === t) return; st.tier = t; st.armDel = null; draw(); });
      b.dataset.tier = t;
      sw.appendChild(b);
      return b;
    });
    const tierNote = mk('div', 'rep-sub eu-pr-tier-note');
    tierNote.id = 'eu-tpl-tier-note';
    const body = mk('div', 'eu-pr-list');
    body.id = 'eu-tpl-list';
    body.appendChild(mk('div', 'rep-sub', '読み込み中…'));
    const foot = mk('div', 'rep-sub eu-pr-foot');
    foot.id = 'eu-tpl-edit-msg';
    foot.setAttribute('role', 'status');
    const a = mk('div', 'modal-act');
    const done = dBtn('閉じる', 'btn ghost', tryClose);
    done.id = 'eu-tpl-edit-close';
    a.appendChild(done);
    dlg.append(howTo, sw, tierNote, body, foot, a);

    const draw = () => {
      tierBtns.forEach(b => { const on = b.dataset.tier === st.tier; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      tierNote.textContent = st.tier === 'mine' ? '自分専用: 自分の見積書だけに出ます（ほかの人には見えません）'
        : '会社共通: 社内の全員の見積書に出ます' + (U().canCompany() ? '' : '。変えられるのは管理者だけです（見るだけ）');
      howTo.hidden = !editable();
      if (!list) return;
      const items = tierList(st.tier);
      if (!items.length) {
        const e = mk('div', 'rep-sub eu-pr-none', 'まだありません。明細を入れた見積書で「この明細をテンプレートに登録」を押すと増えます');
        e.id = 'eu-tpl-empty';
        body.replaceChildren(e);
        return;
      }
      body.replaceChildren(...items.map((t, i) => (editable() ? item(t, i, items.length) : viewItem(t))));
    };
    const viewItem = t => {
      const box = mk('div', 'eu-pr-item view');
      box.dataset.tplId = t.id;
      box.append(mk('div', 'eu-pr-v-name', str(t.name)), linesView(t));
      return box;
    };
    const item = (t, i, n) => {
      const box = mk('div', 'eu-pr-item' + (st.drafts.has(t.id) ? ' dirty' : ''));
      box.dataset.tplId = t.id;
      const name = U().input('eu-tpl-i-name', st.drafts.has(t.id) ? st.drafts.get(t.id) : t.name, { maxLength: EL().TEMPLATE_NAME_MAX });
      name.addEventListener('input', () => { st.drafts.set(t.id, name.value); box.classList.add('dirty'); st.armClose = false; });
      box.append(U().field('名前（ボタン）', name), linesView(t));
      const err = mk('div', 'err eu-pr-err');
      err.setAttribute('role', 'alert');
      const ops = mk('div', 'eu-pr-ops eu-ops');
      const op = (txt, cls, label, fn, dis) => {
        const b = mk('button', cls, txt);
        b.type = 'button';
        b.setAttribute('aria-label', label);
        b.disabled = !!dis;
        b.addEventListener('click', fn);
        ops.appendChild(b);
        return b;
      };
      const nm = str(t.name);
      op('↑', 'up', nm + ' を上へ', () => move(t, -1), i <= 0);
      op('↓', 'down', nm + ' を下へ', () => move(t, 1), i >= n - 1);
      const sv = op('保存', 'save', nm + ' の名前を保存', async () => {
        if (st.busy.has(t.id)) return;
        const v = EL().validateTemplate({ name: name.value.trim(), lines: t.lines });
        if (!v.ok) { err.textContent = v.errors.join('・'); return; }
        st.busy.add(t.id);
        sv.disabled = true;
        sv.textContent = '保存中…';
        err.textContent = '';
        let saved = null;
        try { saved = await EstimateTemplatesApi.rename(t, name.value); } catch (e) { err.textContent = '保存できませんでした: ' + errText(e); }
        st.busy.delete(t.id);
        sv.disabled = false;
        sv.textContent = '保存';
        if (!saved) return;
        st.drafts.delete(t.id);
        list = list.map(q => (q.id === saved.id ? saved : q));
        draw();
        render();
        say('「' + saved.name + '」を保存しました');
      });
      const del = op('削除', 'del', nm + ' を削除', () => {
        if (st.busy.has(t.id)) return;
        st.armDel = st.armDel === t.id ? null : t.id;
        draw();
      });
      if (st.armDel === t.id) {
        del.hidden = true;
        const cf = mk('div', 'eu-pr-confirm');
        cf.appendChild(mk('span', null, '「' + nm + '」を削除しますか？（作った見積書の行は消えません）'));
        const yes = dBtn('削除する', 'btn sm ghost inline danger', async () => {
          if (st.busy.has(t.id)) return;
          st.busy.add(t.id);
          yes.disabled = no.disabled = true;
          yes.textContent = '削除中…';
          let ok = false;
          try { await EstimateTemplatesApi.remove(t.id); ok = true; } catch (e) { err.textContent = '削除できませんでした: ' + errText(e); }
          st.busy.delete(t.id);
          yes.disabled = no.disabled = false;
          yes.textContent = '削除する';
          if (!ok) return;
          st.armDel = null;
          st.drafts.delete(t.id);
          list = list.filter(q => q.id !== t.id);
          draw();
          render();
          say('「' + nm + '」を削除しました');
        });
        yes.classList.add('eu-tpl-del-yes');
        const no = dBtn('やめる', 'btn sm ghost inline', () => { st.armDel = null; draw(); });
        no.classList.add('eu-tpl-del-no');
        cf.append(yes, no);
        box.append(ops, cf, err);
      } else box.append(ops, err);
      return box;
    };
    const move = async (t, dir) => {
      if (st.busy.size) return;
      const changes = EL().movePreset(list, t.id, dir);
      if (!changes.length) return;
      st.busy.add(t.id);
      let ok = false;
      try { await EstimateTemplatesApi.setSorts(changes); ok = true; } catch (e) { say('並び替えできませんでした: ' + errText(e), true); }
      st.busy.delete(t.id);
      if (ok) changes.forEach(c => { const q = list.find(r => r.id === c.id); if (q) q.sort = c.sort; });
      else { try { await load(true); } catch (_) { /* そのまま */ } }
      draw();
      render();
      const b = body.querySelector('[data-tpl-id="' + t.id + '"] .' + (dir < 0 ? 'up' : 'down'));
      if (b && !b.disabled) b.focus({ preventScroll: true });
    };
    load().then(draw).catch(e => body.replaceChildren(mk('div', 'err', '読み込めませんでした: ' + errText(e))));
  }

  return {
    section, sync, openRegister, openEditor,
    reset() { list = null; loading = null; cur = null; }
  };
})();
