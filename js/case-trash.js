// js/case-trash.js — 案件の削除（ゴミ箱）。対応フェーズ Task 13 / migration 031
//   - 案件ページの一番下に小さく「この案件を削除」（管理者＝オーナーだけ。管理画面の案件ページ。DB でも cases の update は管理者だけ）
//   - 押すと確認シート（Task 42 で2段階）: ①「本当に削除しますか？」「管理者なら30日は戻せます」→「削除に進む」
//     ② 本人の今のパスワード →「削除する」（赤）。パスワードは sb.auth.signInWithPassword（本人のメール）で確かめ、違えば「パスワードが違います」。
//     パスワードは保存・記録・URL に入れない。使ったら欄を空にする。入力があるので外側クリック・Esc では閉じない（× とキャンセルだけ）
//   - Task 42: 現場用のツールページの一番下にも（fieldSection。自分が登録した案件だけ。rpc field_trash_case / migration 062）
//   - 削除後は案件一覧に戻り「削除しました。設定 → 削除した案件 から30日以内なら戻せます」
//   - 設定の「削除した案件」（管理者だけ）: 一覧と「元に戻す」（画面内で確かめる）。30日を過ぎた分の自動削除は後日（docs/phase0-deferred.md）
//   ユーザー入力は createElement + textContent で描く（innerHTML は使わない）。alert / confirm は使わない。
// DB は CasesApi（trashCase / restoreCase / listTrashed）。mk は case-list.js、dBtn / errText は case-detail.js、withBusy / setMsg / $ は app.js
const CaseTrash = (() => {
  const str = v => (v == null ? '' : String(v).trim());
  const isOwner = () => !!(ctx && ctx.membership && ctx.membership.role === 'owner');
  const KEEP_DAYS = 30;


  // ── 案件ページの一番下（管理者） ──────────────────────────────────────
  function section(caseRow) {
    if (!isOwner() || !caseRow) return null;
    return box(caseRow, '管理者だけに表示。削除しても30日以内なら設定から戻せます', {
      trash: id => CasesApi.trashCase(id),
      done: name => {
        if (typeof setCaseListFlash === 'function') setCaseListFlash('「' + name + '」を削除しました。設定 → 削除した案件 から' + KEEP_DAYS + '日以内なら戻せます');
        openCases(); // 一覧へ（openCases が URL の #case/… を消す。hashchange で2回開いて案内が消えないよう hash は直接変えない）
      }
    });
  }
  // ── 現場用のツールページの一番下（Task 42: 自分が登録した案件だけ。DB は rpc field_trash_case が現場用の登録かも確かめる） ──
  function fieldSection(caseRow) {
    if (!caseRow || !ctx || !ctx.user || caseRow.created_by !== ctx.user.id) return null;
    return box(caseRow, '自分が登録した案件だけ削除できます。削除しても30日以内なら管理者が戻せます', {
      trash: id => CasesApi.fieldTrashCase(id),
      done: name => {
        if (typeof fieldSetFlash === 'function') fieldSetFlash('「' + name + '」を削除しました。30日以内なら管理者が戻せます');
        if (typeof fieldRowsInvalidate === 'function') fieldRowsInvalidate();
        location.hash = '#f';
      }
    });
  }
  function box(caseRow, note, o) {
    const el = mk('div', 'trash-box');
    el.id = 'case-trash';
    const b = dBtn('この案件を削除', 'linkbtn danger trash-open', () => openSheet(caseRow, o));
    b.id = 'case-trash-btn';
    el.append(b, mk('span', 'trash-note', note));
    return el;
  }

  // 本人の今のパスワードか（Supabase に本人のメールでログインし直して確かめる。パスワードは保存・記録しない）
  //   → true / false（違う）。通信の失敗などは例外
  async function passwordOk(pw) {
    const { error } = await sb.auth.signInWithPassword({ email: ctx.user.email, password: pw });
    if (!error) return true;
    if (error.status === 400 || error.code === 'invalid_credentials') return false;
    throw error;
  }

  // 2段階（Task 42）: ①「本当に削除しますか？」→「削除に進む」 ② パスワード →「削除する」（赤）。
  //   o: { trash(id): 削除する, done(name): 削除の後 }
  function openSheet(c, o) {
    const prev = document.getElementById('trash-sheet');
    if (prev) prev.remove();
    const name = str(c.name);
    const bg = mk('div', 'modal-bg ph-sheet-bg trash-sheet-bg');
    bg.id = 'trash-sheet';
    const dlg = mk('div', 'modal ph-sheet trash-sheet');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'trash-sheet-title');
    const hd = mk('div', 'modal-hd');
    const h = mk('h3', null, 'この案件を削除');
    h.id = 'trash-sheet-title';
    const x = mk('button', 'modal-x', '×');
    x.type = 'button';
    x.id = 'trash-sheet-x';
    x.setAttribute('aria-label', '閉じる');
    hd.append(h, x);

    const lead = mk('p', 'trash-lead');
    lead.append(mk('b', null, '「' + name + '」'), document.createTextNode(' を本当に削除しますか？'));
    const back = mk('p', 'trash-back', '管理者なら' + KEEP_DAYS + '日は戻せます（設定 → 削除した案件）。');
    const err = mk('div', 'err');
    err.id = 'trash-err';
    err.setAttribute('role', 'alert');

    // ① 確認
    const act1 = mk('div', 'modal-act');
    act1.id = 'trash-step1';
    const cancel1 = dBtn('キャンセル', 'btn ghost', () => close());
    cancel1.id = 'trash-cancel';
    const next = dBtn('削除に進む', 'btn', () => step2());
    next.id = 'trash-next';
    act1.append(cancel1, next);

    // ② パスワード
    const step = mk('div', 'trash-step2');
    step.id = 'trash-step2';
    step.hidden = true;
    const ff = mk('div', 'ff');
    const lab = mk('label', null, '確認のため、ログインのパスワードを入れてください');
    lab.htmlFor = 'trash-pw';
    const pw = document.createElement('input');
    pw.type = 'password';
    pw.id = 'trash-pw';
    pw.autocomplete = 'current-password';
    ff.append(lab, pw);
    const act2 = mk('div', 'modal-act');
    const cancel2 = dBtn('キャンセル', 'btn ghost', () => close());
    cancel2.id = 'trash-cancel2';
    const go = dBtn('削除する', 'btn danger-fill', b => withBusy(b, async () => {
      err.textContent = '';
      const v = pw.value;
      pw.value = ''; // 使ったらすぐ消す（画面にも残さない）
      if (!v) { err.textContent = 'パスワードを入れてください'; pw.focus(); return; }
      cancel2.disabled = true; x.disabled = true;
      const fail = t => { err.textContent = t; cancel2.disabled = false; x.disabled = false; pw.focus(); };
      let ok;
      try { ok = await passwordOk(v); }
      catch (e) { return fail('パスワードを確かめられませんでした: ' + errText(e)); }
      if (!ok) return fail('パスワードが違います');
      try { await o.trash(c.id); }
      catch (e) { return fail('削除できませんでした: ' + errText(e)); }
      close();
      o.done(name);
    }));
    go.id = 'trash-go';
    pw.addEventListener('keydown', e => { if (e.key === 'Enter' && !go.disabled) { e.preventDefault(); go.click(); } });
    act2.append(cancel2, go);
    step.append(ff, act2);

    function step2() {
      act1.remove();
      step.hidden = false;
      pw.focus();
    }

    dlg.append(hd, lead, back, act1, step, err);
    bg.appendChild(dlg);
    // 外側のクリック・Esc では閉じない（入力のあるシート）。画面を移ったら閉じる
    document.body.appendChild(bg);
    document.body.classList.add('rm-open');
    const onHash = () => close();
    window.addEventListener('hashchange', onHash);
    function close() {
      pw.value = '';
      bg.remove();
      document.body.classList.remove('rm-open');
      window.removeEventListener('hashchange', onHash);
    }
    x.addEventListener('click', () => close());
    cancel1.focus();
    return bg;
  }

  // ── 設定の「削除した案件」 ───────────────────────────────────────────
  let seq = 0;
  async function renderCard() {
    const card = $('card-trash');
    if (!card) return;
    card.hidden = !isOwner();
    if (!isOwner()) return;
    const list = $('trash-list');
    const my = ++seq;
    setMsg('trash-msg', '');
    list.replaceChildren(mk('div', 'trash-empty', '読み込み中…'));
    let rows;
    try { rows = await CasesApi.listTrashed(); }
    catch (e) {
      if (my !== seq) return;
      list.replaceChildren();
      setMsg('trash-msg', '削除した案件を読み込めませんでした: ' + errText(e));
      return;
    }
    if (my !== seq) return;
    if (!rows.length) { list.replaceChildren(mk('div', 'trash-empty', '削除した案件はありません')); return; }
    list.replaceChildren(...rows.map(r => trashRow(r)));
  }
  const daysLeft = iso => {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return null;
    return Math.ceil((t + KEEP_DAYS * 86400e3 - Date.now()) / 86400e3);
  };
  function trashRow(r) {
    const el = mk('div', 'trash-row');
    el.dataset.id = r.id;
    const main = mk('div', 'trash-main');
    main.appendChild(mk('b', 'trash-name', r.name));
    const left = daysLeft(r.deleted_at);
    main.appendChild(mk('span', 'trash-when', PhaseLogic.fmtMD(r.deleted_at) + ' 削除' +
      (left == null ? '' : left > 0 ? '・あと' + left + '日で自動削除の対象' : '・30日を過ぎました（後日の自動削除の対象）')));
    el.appendChild(main);
    const ops = mk('div', 'trash-ops');
    const msg = mk('div', 'err trash-row-err');
    msg.setAttribute('role', 'alert');
    const restore = dBtn('元に戻す', 'btn sm ghost inline trash-restore', () => {
      if (el.querySelector('.trash-confirm')) return;
      const cf = mk('div', 'trash-confirm');
      cf.appendChild(mk('span', null, '「' + r.name + '」を元に戻しますか？（案件一覧に戻ります）'));
      const no = dBtn('やめる', 'btn sm ghost inline', () => { cf.remove(); restore.disabled = false; });
      const yes = dBtn('戻す', 'btn sm inline trash-yes', b => withBusy(b, async () => {
        msg.textContent = '';
        no.disabled = true;
        try { await CasesApi.restoreCase(r.id); }
        catch (e) { msg.textContent = '元に戻せませんでした: ' + errText(e); no.disabled = false; return; }
        await renderCard();
        setMsg('trash-msg', '「' + r.name + '」を元に戻しました（案件一覧に出ます）', true);
      }));
      cf.append(no, yes);
      el.insertBefore(cf, msg);
      restore.disabled = true;
      no.focus();
    });
    ops.appendChild(restore);
    el.appendChild(ops);
    el.appendChild(msg);
    return el;
  }

  return { section, fieldSection, openSheet, renderCard };
})();
window.CaseTrash = CaseTrash;
