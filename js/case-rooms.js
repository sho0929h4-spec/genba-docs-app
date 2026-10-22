// js/case-rooms.js — 依頼元の欄の「関係する部屋」（加害部屋・被害部屋・その他。対応フェーズ Task 12 / migration 030）
//   - 一番上に「この案件の部屋（被害部屋）」（cases.room と入居者。編集は「依頼元を編集」）
//   - 行ごとに 役割の小さなラベル（加害部屋＝赤系／被害部屋＝青系／その他＝灰）・号室・居住者名・メール（mailto）・電話（tel）・メモ・編集・削除
//   - 「＋ 部屋を追加」/「編集」→ シート（役割・号室・居住者名・メール・電話・メモ）。入力があるので外側クリック・Esc では閉じない（× とキャンセルだけ）
//   - 削除はその行の中で確かめる（confirm は使わない）
//   ユーザー入力は createElement + textContent で描く（innerHTML は使わない）。alert / confirm は使わない。
// DB は CaseRoomsApi。mk は case-list.js、dBtn / errText は case-detail.js、withBusy は app.js のものを使う。
const CaseRooms = (() => {
  let uid = 0;
  const str = v => (v == null ? '' : String(v).trim());
  const PL = () => window.PhaseLogic;
  const roleCls = r => (CaseRoomsApi.ROLES.includes(r) ? r : 'other');
  function tag(role, text) {
    const t = mk('span', 'rm-tag ' + roleCls(role), text || PL().roomRoleLabel(role));
    return t;
  }
  function contactLinks(email, tel) {
    const out = [];
    if (email) {
      const a = Icon.prepend(mk('a', 'pty-mail', email), 'mail', 14);
      a.href = 'mailto:' + email;
      out.push(a);
    }
    if (tel) {
      const a = Icon.prepend(mk('a', 'pty-tel', tel), 'phone', 14);
      a.href = 'tel:' + String(tel).replace(/[^0-9+]/g, '');
      out.push(a);
    }
    return out;
  }

  // ── 依頼元の欄の中の「関係する部屋」 ───────────────────────────────────
  // 「この案件の部屋（被害部屋）」は依頼元の欄の号室の行（js/case-detail.js）に出す。
  // 「＋ 部屋を追加」は依頼元の見出しの横（addButton）。部屋が無いときは欄を出さない（案件ページを縦に伸ばさない）
  // caseRow: case_summaries の行（rooms 付き）。onChanged: 保存・削除の後に呼ぶ（案件を読み直して描き直す）
  function addButton(caseRow, onChanged) {
    const add = dBtn('＋ 部屋を追加', 'linkbtn rm-add', () => openSheet(caseRow || {}, null, onChanged));
    add.id = 'case-room-add';
    add.title = '上の階の加害部屋など、別の部屋を登録すると連絡メールの送る相手や工事掲示の号室に使えます';
    return add;
  }
  function section(caseRow, onChanged) {
    const c = caseRow || {};
    const rooms = PL().roomsOf(c);
    if (!rooms.length) return null;
    const box = mk('div', 'rm-box');
    box.id = 'case-rooms';
    box.appendChild(mk('div', 'pty-k rm-ttl', '関係する部屋'));
    rooms.forEach(r => box.appendChild(row(c, r, onChanged)));
    return box;
  }

  function row(c, r, onChanged) {
    const el = mk('div', 'rm-row');
    el.dataset.room = r.id;
    const main = mk('div', 'rm-main');
    main.appendChild(tag(r.role));
    main.appendChild(mk('b', 'rm-no', PL().roomLabel(r.room)));
    main.appendChild(mk('span', 'rm-name' + (str(r.resident_name) ? '' : ' pty-none'), str(r.resident_name) ? str(r.resident_name) + '様' : '（居住者名 未登録）'));
    const links = contactLinks(str(r.email), str(r.tel));
    if (links.length) main.append(...links);
    else main.appendChild(mk('span', 'pty-none rm-nocontact', 'メール・電話 未登録'));
    el.appendChild(main);
    const ops = mk('div', 'rm-ops');
    const msg = mk('div', 'err rm-err');
    msg.setAttribute('role', 'alert');
    const edit = dBtn('編集', 'linkbtn rm-edit', () => openSheet(c, r, onChanged));
    const del = dBtn('削除', 'linkbtn danger rm-del', () => {
      if (el.querySelector('.rm-confirm')) return;
      const cf = mk('div', 'rm-confirm');
      cf.setAttribute('role', 'group');
      cf.appendChild(mk('span', null, PL().roomTitle(r) + ' を削除しますか？（連絡メールの送る相手からも外れます）'));
      const no = dBtn('やめる', 'btn sm ghost inline rm-no-btn', () => { cf.remove(); del.disabled = false; });
      const yes = dBtn('削除する', 'btn sm inline rm-yes', b => withBusy(b, async () => {
        msg.textContent = '';
        no.disabled = true;
        try { await CaseRoomsApi.remove(r, c.id); }
        catch (e) { msg.textContent = '削除できませんでした: ' + errText(e); no.disabled = false; return; }
        await onChanged();
      }));
      cf.append(no, yes);
      el.insertBefore(cf, msg);
      del.disabled = true;
      no.focus();
    });
    ops.append(edit, del);
    el.appendChild(ops);
    if (str(r.note)) el.appendChild(mk('div', 'rm-note', str(r.note))); // メモは次の行（PC では編集・削除が1行目の右に並ぶ）
    el.appendChild(msg);
    return el;
  }

  // ── 追加・編集のシート ───────────────────────────────────────────────
  function input(type, value, max, placeholder) {
    const i = document.createElement('input');
    i.type = type;
    i.id = 'rm-f' + (++uid);
    i.value = value == null ? '' : String(value);
    i.maxLength = max;
    i.autocomplete = 'off';
    if (placeholder) i.placeholder = placeholder;
    return i;
  }
  function field(label, control, opt) {
    const w = mk('div', 'ff rm-ff');
    const l = mk('label', null, label);
    if (opt) l.appendChild(mk('span', 'opt', ' ' + opt));
    l.htmlFor = control.id;
    w.append(l, control);
    return w;
  }
  function openSheet(c, cur, onChanged) {
    const prev = document.getElementById('rm-sheet');
    if (prev) prev.remove();
    const bg = mk('div', 'modal-bg ph-sheet-bg rm-sheet-bg');
    bg.id = 'rm-sheet';
    const dlg = mk('div', 'modal ph-sheet rm-sheet');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'rm-sheet-title');
    const hd = mk('div', 'modal-hd');
    const h = mk('h3', null, cur ? '関係する部屋を編集' : '関係する部屋を追加');
    h.id = 'rm-sheet-title';
    const x = mk('button', 'modal-x', '×');
    x.type = 'button';
    x.id = 'rm-sheet-x';
    x.setAttribute('aria-label', '閉じる');
    hd.append(h, x);
    dlg.appendChild(hd);

    // 役割（3つから1つ。ボタン 40px・押したものが選ばれる）
    let role = cur ? roleCls(cur.role) : 'cause';
    const roleBox = mk('div', 'rm-roles');
    roleBox.setAttribute('role', 'radiogroup');
    roleBox.setAttribute('aria-label', '役割');
    const roleBtns = PL().ROOM_ROLES.map(rr => {
      const b = dBtn(rr.label, 'rm-role ' + rr.key, () => { role = rr.key; paint(); });
      b.dataset.role = rr.key;
      b.setAttribute('role', 'radio');
      return b;
    });
    const paint = () => roleBtns.forEach(b => {
      const on = b.dataset.role === role;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    paint();
    roleBox.append(...roleBtns);
    const roleW = mk('div', 'ff rm-ff');
    roleW.append(mk('label', null, '役割'), roleBox);

    const M = CaseRoomsApi.MAX;
    const fRoom = input('text', cur ? cur.room : '', M.room, '例: 402');
    fRoom.id = 'rm-f-room';
    const fName = input('text', cur ? cur.resident_name : '', M.resident_name, '例: 山本');
    fName.id = 'rm-f-name';
    const fMail = input('email', cur ? cur.email : '', M.email, '例: yamamoto@example.jp');
    fMail.id = 'rm-f-email';
    const fTel = input('tel', cur ? cur.tel : '', M.tel, '例: 090-1234-5678');
    fTel.id = 'rm-f-tel';
    const fNote = document.createElement('textarea');
    fNote.id = 'rm-f-note';
    fNote.maxLength = M.note;
    fNote.rows = 2;
    fNote.value = cur && cur.note ? cur.note : '';
    fNote.placeholder = '例: 浴室の真下が被害。平日の夕方なら在宅';
    const grid = mk('div', 'rm-grid');
    grid.append(field('号室', fRoom), field('居住者名', fName, '任意'), field('メール', fMail, '任意・連絡メールの宛先'),
      field('電話', fTel, '任意'));
    const err = mk('div', 'err');
    err.id = 'rm-sheet-err';
    err.setAttribute('role', 'alert');
    const act = mk('div', 'modal-act');
    const cancel = dBtn('キャンセル', 'btn ghost', () => close());
    cancel.id = 'rm-cancel';
    const save = dBtn(cur ? '保存する' : '追加する', 'btn', b => withBusy(b, async () => {
      err.textContent = '';
      const vals = { role, room: fRoom.value, resident_name: fName.value, email: fMail.value, tel: fTel.value, note: fNote.value };
      const ck = CaseRoomsApi.clean(vals);
      if (ck.error) { err.textContent = ck.error; (/^メール/.test(ck.error) ? fMail : /^居住者/.test(ck.error) ? fName : /^電話/.test(ck.error) ? fTel : /^メモ/.test(ck.error) ? fNote : fRoom).focus(); return; }
      cancel.disabled = true; x.disabled = true;
      try {
        if (cur) await CaseRoomsApi.update(cur, vals);
        else await CaseRoomsApi.create(c.id, vals, PL().roomsOf(c));
      } catch (e) {
        err.textContent = (cur ? '保存' : '追加') + 'できませんでした: ' + errText(e);
        cancel.disabled = false; x.disabled = false;
        return;
      }
      close();
      await onChanged();
    }));
    save.id = 'rm-save';
    act.append(cancel, save);
    dlg.append(roleW, grid, field('メモ', fNote, '任意'), act, err);
    bg.appendChild(dlg);
    // 外側のクリック・Esc では閉じない（入力のあるシート）。背景のスクロールだけ止める
    document.body.appendChild(bg);
    document.body.classList.add('rm-open');
    function close() {
      bg.remove();
      document.body.classList.remove('rm-open');
    }
    x.addEventListener('click', () => close());
    (cur ? fRoom : roleBtns[0]).focus();
    return bg;
  }

  return { section, addButton, openSheet };
})();
window.CaseRooms = CaseRooms;
