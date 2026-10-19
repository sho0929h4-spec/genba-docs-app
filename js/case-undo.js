// js/case-undo.js — 案件ページ上部の「↩ 1つ前に戻す」（対応フェーズ Task 13 / migration 031）
//   - 「今の状態」の行の右にボタン。直近のまだ取り消していない編集（case_edits）があるときだけ出す
//   - 押すと画面内で確かめる: 「10/19 13:05 田中: 調査 1回目の日時 10/20 9:00 → 10/21 10:00」→「戻す」
//   - 戻すのは DB の undo_case_edit（今の値がその編集の後の値と同じときだけ戻す。違えば「その後に別の変更があるため戻せません」）
//   - 戻した後は案件を読み直す。日時を戻したときは連絡メールの下書きを今の日時で作り直し（PhasesApi.syncScheduleDrafts）、
//     リマインドは読み直しの中で今の仕組み（PhasesApi.syncReminders）が作り直す
//   - 続けて押せば、さらに1つ前に戻る
//   - 対象外（EditLogic.NOT_COVERED）: 書類の中身・タイムラインの投稿・元請マスタの変更・フェーズや部屋の追加と削除
//   ユーザー入力は createElement + textContent で描く（innerHTML は使わない）。alert / confirm は使わない。
// 文言は js/edit-logic.js（EditLogic）。DB は CasesApi.listEdits / undoEdit。
// mk は case-list.js、dBtn / errText / currentCase / caseMembers / caseDetailId / loadCase は case-detail.js、withBusy / $ は app.js
const CaseUndo = (() => {
  let st = { caseId: null, edits: [], loaded: false, open: false, busy: false, msg: '', flash: '', seq: 0 };

  const opts = () => ({ phases: (currentCase && currentCase.phases) || [], rooms: (currentCase && currentCase.rooms) || [], members: caseMembers || [] });
  const latest = () => (st.caseId && currentCase && st.caseId === currentCase.id ? EditLogic.latestUndoable(st.edits, opts()) : null);

  // 案件ページの見出しに置く（ヘッダを描き直しても同じ要素を使う）→ { btn: ボタンの入れ物, panel: 確かめる欄 }
  function mount() {
    let btn = $('case-undo');
    let panel = $('case-undo-panel');
    const fresh = !btn || !panel;
    if (!btn) { btn = mk('span', 'case-undo'); btn.id = 'case-undo'; }
    if (!panel) { panel = mk('div', 'undo-panel'); panel.id = 'case-undo-panel'; panel.hidden = true; }
    if (!currentCase) return { btn, panel };
    if (st.caseId !== currentCase.id) st = { caseId: currentCase.id, edits: [], loaded: false, open: false, busy: false, msg: '', flash: '', seq: st.seq };
    if (fresh) { st.open = false; st.msg = ''; st.flash = ''; setTimeout(() => load(), 0); } // 案件ページを開き直した: 描き終わってから読む
    else setTimeout(() => draw(), 0);
    return { btn, panel };
  }

  async function load() {
    if (!currentCase) return;
    const caseId = currentCase.id;
    const my = ++st.seq;
    let rows;
    try { rows = await CasesApi.listEdits(caseId); }
    catch (e) { console.warn('編集の記録を読めませんでした', e); rows = null; }
    if (my !== st.seq || !currentCase || currentCase.id !== caseId || st.caseId !== caseId) return;
    if (rows) { st.edits = rows; st.loaded = true; }
    draw();
  }
  function refresh() {
    if (!$('case-undo') || !currentCase) return;
    st.msg = '';
    return load();
  }

  function draw() {
    const btnBox = $('case-undo');
    const panel = $('case-undo-panel');
    if (!btnBox || !panel) return;
    const e = latest();
    btnBox.replaceChildren();
    if (e) {
      const b = dBtn('↩ 1つ前に戻す', 'linkbtn undo-btn', () => { st.open = !st.open; st.msg = ''; st.flash = ''; draw(); });
      b.id = 'case-undo-btn';
      b.setAttribute('aria-expanded', st.open ? 'true' : 'false');
      b.setAttribute('aria-controls', 'case-undo-panel');
      b.disabled = st.busy;
      btnBox.appendChild(b);
    }
    const nodes = [];
    if (st.open && e) {
      const d = EditLogic.describe(e, opts());
      nodes.push(mk('b', 'undo-q', '↩ この変更を取り消して、1つ前に戻しますか？'));
      const line = mk('div', 'undo-line', d.line);
      line.id = 'case-undo-line';
      nodes.push(line);
      if (EditLogic.touchesSchedule(e)) nodes.push(mk('div', 'undo-sub', '日時を戻すと、連絡メールの下書きとリマインドも戻した日時で作り直します（送るのは今までどおり「確認して送る」から）'));
      const act = mk('div', 'undo-act');
      const no = dBtn('やめる', 'btn sm ghost inline', () => { st.open = false; st.msg = ''; draw(); });
      no.id = 'case-undo-no';
      const yes = dBtn('戻す', 'btn sm inline undo-yes', b => run(b, e, d));
      yes.id = 'case-undo-yes';
      no.disabled = yes.disabled = st.busy;
      act.append(no, yes);
      nodes.push(act);
      if (st.msg) { const m = mk('div', 'err undo-err', st.msg); m.id = 'case-undo-msg'; m.setAttribute('role', 'alert'); nodes.push(m); }
      nodes.push(mk('div', 'undo-help', '戻せるのは、案件の項目（物件名・依頼元・担当者・期日など）・対応フェーズ（日時・調査済み/完了・請求など）・関係する部屋 の変更です。'
        + '戻せないもの: ' + EditLogic.NOT_COVERED.join('・') + '。'));
    } else if (st.msg || st.flash) {
      const m = mk('div', st.msg ? 'err undo-err' : 'undo-ok', st.msg || st.flash);
      m.id = 'case-undo-msg';
      m.setAttribute('role', st.msg ? 'alert' : 'status');
      nodes.push(m);
    }
    panel.replaceChildren(...nodes);
    panel.hidden = nodes.length === 0;
  }

  async function run(btn, e, d) {
    if (st.busy || !currentCase) return;
    const caseId = currentCase.id;
    st.busy = true; st.msg = '';
    draw();
    let res = null;
    try { res = await CasesApi.undoEdit(e.id, d.text); }
    catch (err) { st.msg = '戻せませんでした: ' + errText(err); }
    st.busy = false;
    if (caseDetailId !== caseId) return;
    if (!res || !res.ok) {
      if (res) st.msg = EditLogic.reasonText(res.reason);
      await load(); // ほかの人の変更・取り消しを読み直す（表示は残す）
      return;
    }
    let warn = '';
    if (EditLogic.touchesSchedule(e)) {
      // 日程連絡の下書きを戻した日時で作り直す（リマインドは読み直しの syncReminders が作り直す）
      try {
        const [rows, drafts] = await Promise.all([PhasesApi.list(caseId), ReportsApi.listDrafts(caseId)]);
        const row = (rows || []).find(p => p.id === e.row_id);
        const prev = Object.prototype.hasOwnProperty.call(e.after || {}, 'scheduled_at') ? e.after.scheduled_at : (row ? row.scheduled_at : null);
        if (row) await PhasesApi.syncScheduleDrafts(prev, row, currentCase, drafts || []);
      } catch (err) { warn = '（連絡メールの下書きを作り直せませんでした: ' + errText(err) + '）'; }
    }
    if (caseDetailId !== caseId) return;
    st.open = false;
    const flash = '戻しました: ' + d.text + warn;
    await loadCase(caseId); // 案件ページを読み直す（対応フェーズ・タイムライン・リマインドも）
    if (st.caseId === caseId) {
      if (warn) st.msg = flash; else st.flash = flash;
      draw();
    }
  }

  return { mount, refresh, load };
})();
window.CaseUndo = CaseUndo;
