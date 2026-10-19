// js/case-trash.js — 案件の削除（ゴミ箱）。対応フェーズ Task 13 / migration 031
//   - 案件ページの一番下に小さく「この案件を削除」（管理者＝オーナーだけに出す。スタッフには出さない。DB でも管理者だけ）
//   - 押すと確認シート: いっしょに見えなくなるもの（フェーズ・書類・メール下書き・タイムラインの件数）を出し、
//     物件名をそのまま入力しないと「削除する」が押せない。入力があるので外側クリック・Esc では閉じない（× とキャンセルだけ）
//   - 削除後は案件一覧に戻り「削除しました。設定 → 削除した案件 から30日以内なら戻せます」
//   - 設定の「削除した案件」（管理者だけ）: 一覧と「元に戻す」（画面内で確かめる）。30日を過ぎた分の自動削除は後日（docs/phase0-deferred.md）
//   ユーザー入力は createElement + textContent で描く（innerHTML は使わない）。alert / confirm は使わない。
// DB は CasesApi（trashCase / restoreCase / listTrashed）。mk は case-list.js、dBtn / errText は case-detail.js、withBusy / setMsg / $ は app.js
const CaseTrash = (() => {
  const str = v => (v == null ? '' : String(v).trim());
  const isOwner = () => !!(ctx && ctx.membership && ctx.membership.role === 'owner');
  const KEEP_DAYS = 30;

  // 削除するといっしょに見えなくなるもの（case_summaries の件数から）
  function counts(c) {
    const n = v => Number(v) || 0;
    const reports = n(c.report_count), estimates = n(c.estimate_count), notices = n(c.notice_count);
    return [
      { key: 'phases', label: '対応フェーズ', n: Array.isArray(c.phases) ? c.phases.length : 0 },
      { key: 'docs', label: '書類', n: reports + estimates + notices, sub: `報告書 ${reports}・見積書 ${estimates}・工事掲示 ${notices}` },
      { key: 'drafts', label: '送っていないメールの下書き', n: n(c.drafts_to_send) },
      { key: 'timeline', label: 'タイムライン', n: n(c.timeline_count) }
    ];
  }

  // ── 案件ページの一番下 ─────────────────────────────────────────────
  function section(caseRow) {
    if (!isOwner() || !caseRow) return null;
    const box = mk('div', 'trash-box');
    box.id = 'case-trash';
    const b = dBtn('この案件を削除', 'linkbtn danger trash-open', () => openSheet(caseRow));
    b.id = 'case-trash-btn';
    box.append(b, mk('span', 'trash-note', '管理者だけに表示。削除しても30日以内なら設定から戻せます'));
    return box;
  }

  function openSheet(c) {
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
    lead.append(mk('b', null, '「' + name + '」'), document.createTextNode(' を削除すると、案件一覧・チーム状況・請求の一覧・送るメールから消えます。いっしょに見えなくなるもの:'));
    const ul = mk('ul', 'trash-list');
    ul.id = 'trash-counts';
    counts(c).forEach(it => {
      const li = mk('li', null);
      li.dataset.key = it.key;
      li.append(mk('span', null, it.label), mk('b', null, ' ' + it.n + '件'));
      if (it.sub && it.n) li.appendChild(mk('span', 'trash-sub', '（' + it.sub + '）'));
      ul.appendChild(li);
    });
    const back = mk('p', 'trash-back', '間違えたときは「設定 → 削除した案件」から' + KEEP_DAYS + '日以内なら元に戻せます。');

    const inp = document.createElement('input');
    inp.type = 'text';
    inp.id = 'trash-name';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.placeholder = name;
    const ff = mk('div', 'ff');
    const lb = mk('label', null, '確認のため、物件名をそのまま入力してください');
    lb.htmlFor = inp.id;
    ff.append(lb, mk('div', 'trash-want', name), inp);

    const err = mk('div', 'err');
    err.id = 'trash-err';
    err.setAttribute('role', 'alert');
    const act = mk('div', 'modal-act');
    const cancel = dBtn('キャンセル', 'btn ghost', () => close());
    cancel.id = 'trash-cancel';
    const go = dBtn('削除する', 'btn danger-fill', b => withBusy(b, async () => {
      if (str(inp.value) !== name) { err.textContent = '物件名が一致しません'; inp.focus(); return; }
      err.textContent = '';
      cancel.disabled = true; x.disabled = true; inp.disabled = true;
      try { await CasesApi.trashCase(c.id); }
      catch (e) {
        err.textContent = '削除できませんでした: ' + errText(e);
        cancel.disabled = false; x.disabled = false; inp.disabled = false;
        return;
      }
      close();
      if (typeof setCaseListFlash === 'function') setCaseListFlash('「' + name + '」を削除しました。設定 → 削除した案件 から' + KEEP_DAYS + '日以内なら戻せます');
      openCases(); // 一覧へ（openCases が URL の #case/… を消す。hashchange で2回開いて案内が消えないよう hash は直接変えない）
    }));
    go.id = 'trash-go';
    // withBusy が終わると disabled を外すので、一致していないときは押せない状態に戻す
    const sync = () => { go.disabled = str(inp.value) !== name || inp.disabled; };
    go.addEventListener('click', () => setTimeout(sync, 0));
    inp.addEventListener('input', sync);
    sync();
    act.append(cancel, go);
    dlg.append(hd, lead, ul, back, ff, act, err);
    bg.appendChild(dlg);
    // 外側のクリック・Esc では閉じない（入力のあるシート）。画面を移ったら閉じる
    document.body.appendChild(bg);
    document.body.classList.add('rm-open');
    const onHash = () => close();
    window.addEventListener('hashchange', onHash);
    function close() {
      bg.remove();
      document.body.classList.remove('rm-open');
      window.removeEventListener('hashchange', onHash);
    }
    x.addEventListener('click', () => close());
    inp.focus();
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

  return { section, openSheet, renderCard, counts };
})();
window.CaseTrash = CaseTrash;
