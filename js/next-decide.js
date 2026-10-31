// js/next-decide.js — Task 75: 調査の報告書を提出したあとの「次の対応を決める」画面（画面全体）
// 閉じるボタン・戻るボタンは出さない（ユーザー決定: 選ぶまで閉じない）。決めずにアプリを閉じた・読み込み直したときは、
//   その報告書を開いたとき（report-edit.js）・その案件を開いたとき（checkCase。管理画面・現場用）にまた出す。タスクの一覧にも出る（PhaseLogic）
// 方針の欄は報告書の入力画面にあった部品（js/report-form.js の edNextPicker）をそのまま使う。入力チェックは ReportLogic.validateNext
// 決める: rpc report_decide_next（DB が権限・状態・中身を確かめ、原因元工事・再調査のフェーズと期日・タイムライン・管理者への連絡を作る）
// 決めた後: 原因元工事・再調査 →「このまま見積書を作る」（その対応の見積書の編集へ）／「タスクに入れて後で作る」（タスクの一覧へ）。その他 → 案件へ
// ユーザー入力は createElement + textContent（innerHTML は使わない）。mk / dBtn / errText は case-list.js・case-detail.js
const NextDecide = (() => {
  let cur = null; // 表示中（または開いている途中）なら { id }
  const me = () => (typeof ctx !== 'undefined' && ctx && ctx.user ? ctx.user.id : null);
  const isOwner = () => !!(typeof ctx !== 'undefined' && ctx && ctx.membership && ctx.membership.role === 'owner');
  // DB の report_decide_next と同じ人（管理者・提出した人・報告書の作業者・その対応の作業担当者）
  const canDecide = (r, phase) => { const u = me(); return !!u && (isOwner() || u === r.submitted_by || u === r.worker_id || (!!phase && u === phase.worker_id)); };
  const phaseOf = (caseRow, id) => ((caseRow && caseRow.phases) || []).find(p => p.id === id) || null;
  const inField = () => typeof fieldHidesAdmin === 'function' && fieldHidesAdmin();
  const caseHash = id => { const fb = typeof fieldBack === 'function' ? fieldBack(id) : null; return fb ? fb.hash : '#case/' + id; };

  // 案件を開いたとき: まだ決めていない調査の報告書（自分が決められるもの）があれば出す
  function checkCase(caseRow) {
    if (cur || !caseRow) return;
    for (const p of caseRow.phases || []) {
      const r = (p.reports || []).find(x => ReportLogic.nextPending(x) && canDecide(x, p));
      if (r) { open({ reportId: r.id, caseRow }); return; }
    }
  }

  // o: { report（data つきの行）| reportId, caseRow, before（現場用: 提出の前のタスクの印。fieldTaskKeys） }
  async function open(o) {
    if (cur) return;
    cur = { id: (o.report && o.report.id) || o.reportId };
    let r = o.report && o.report.data ? o.report : null, caseRow = o.caseRow || null;
    try {
      if (!r) r = await ReportsApi.get(cur.id);
      if (r && (!caseRow || caseRow.id !== r.case_id)) caseRow = await CasesApi.getSummary(r.case_id);
    } catch (e) { console.warn('次の対応を決める画面を開けませんでした', e); r = null; }
    if (!r || !ReportLogic.nextPending(r) || !canDecide(r, phaseOf(caseRow, r.phase_id))) { cur = null; return; }
    build(r, caseRow, o.before || null);
  }

  function build(r, caseRow, before) {
    const phase = phaseOf(caseRow, r.phase_id);
    const title = phase ? PhaseLogic.phaseTitle(phase, phase.seq) : '調査';
    const bg = mk('div', 'nd-bg');
    bg.id = 'nd-screen';
    const box = mk('div', 'nd-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'nd-h');
    const h = mk('h2', 'nd-h', '次の対応を決める');
    h.id = 'nd-h';
    const place = mk('div', 'nd-place', [caseRow ? PhaseLogic.placeName(caseRow) : '', title].filter(Boolean).join(' ・ '));
    // Task 81: 自分が提出していない報告書（協力業者の URL・ほかの人）は「提出された」。中身は下の要約で読める
    const lead = mk('p', 'nd-lead', (r.submitted_by && r.submitted_by === me() ? '調査の報告書を提出しました。' : '提出された調査の報告書の次の対応を決めます。')
      + '報告書の中身を読んで、次の対応を1つ選んで「決める」を押してください（決めるまでこの画面は閉じません）。');
    const sum = summary(r);
    const s = { f: { data: ReportLogic.normalizeData(r.data) }, els: {}, ro: false, onDirty: () => { err.replaceChildren(); } };
    const body = mk('div', 'rep-card nd-body');
    const err = mk('div', 'err nd-err');
    err.id = 'nd-err';
    err.setAttribute('role', 'alert');
    edNextPicker(s, body);
    const acts = mk('div', 'nd-acts');
    const ok = dBtn('決める', 'btn nd-ok', () => decide());
    ok.id = 'nd-ok';
    acts.appendChild(ok);
    box.append(h, place, lead, sum, body, err, acts);
    bg.appendChild(box);
    document.body.appendChild(bg);
    document.body.classList.add('nd-open');
    cur.bg = bg;
    h.tabIndex = -1;
    h.focus();

    const showErr = list => err.replaceChildren(...list.map(t => mk('div', null, t)));
    const close = () => { bg.remove(); document.body.classList.remove('nd-open'); cur = null; };

    async function decide() {
      const n = s.f.data.nextAction;
      const errs = ReportLogic.validateNext(s.f.data);
      if (errs.length) { showErr(errs); return; }
      ok.disabled = true;
      ok.textContent = '保存しています…';
      let res;
      try { res = await ReportsApi.decideNext(r.id, n); }
      catch (e) {
        // ほかの人が先に決めた・再編集で下書きに戻ったなど、もう決められないときは閉じて案件へ（閉じるボタンが無いので閉じ込めない）
        if (/もう決まっています|まだ提出されていません|見つかりません/.test(errText(e))) { close(); location.hash = caseHash(r.case_id); return; }
        ok.disabled = false;
        ok.textContent = '決める';
        showErr(['保存できませんでした: ' + errText(e)]);
        return;
      }
      // 調査結果・「調査結果のご報告」の下書きを作り直す（提出のときと同じ。失敗しても止めない）
      const data = Object.assign({}, r.data, { nextAction: n });
      delete data.nextPending;
      await ReportsApi.syncSurveyResult(Object.assign({}, r, { data }));
      if (typeof fieldRowsInvalidate === 'function') fieldRowsInvalidate();
      if (n.type === 'other') { await leave(caseHash(r.case_id)); return; }
      after(n, res && res.phase_id);
    }

    // 決めた後（原因元工事・再調査）: 見積書を今作るか、タスクに入れて後で作るか
    function after(n, phaseId) {
      h.textContent = '見積書をどうしますか';
      sum.remove();
      lead.textContent = '決めました: ' + ReportLogic.nextActionText({ nextAction: n });
      body.replaceChildren(mk('div', 'nd-q', '見積書を今作るか、タスクに入れて後で作るかを選んでください。'));
      err.replaceChildren();
      const est = dBtn('このまま見積書を作る', 'btn nd-ok', () => makeEstimate(est, later, phaseId));
      est.id = 'nd-estimate';
      const later = dBtn('タスクに入れて後で作る', 'btn ghost nd-later', () => toTasks());
      later.id = 'nd-later';
      acts.replaceChildren(est, later);
      h.focus();
    }

    async function makeEstimate(est, later, phaseId) {
      est.disabled = later.disabled = true;
      try {
        const c = await CasesApi.getSummary(r.case_id);
        const p = phaseOf(c, phaseId);
        if (!c || !p) throw new Error('対応が見つかりません');
        const drafts = (p.estimates || []).filter(e => e.status === 'draft' && e.id);
        const row = drafts.length ? drafts[drafts.length - 1] : await makePhaseEstimate(c, p, PhaseLogic.phaseTitle(p, p.seq));
        if (inField() && typeof fdSel !== 'undefined') fdSel.set(c.id, p.id);
        close();
        location.hash = '#estimate/' + row.id;
      } catch (e) {
        est.disabled = later.disabled = false;
        showErr(['見積書を作れませんでした: ' + errText(e)]);
      }
    }

    const toTasks = () => leave(inField() ? '#f/tasks' : '#tasks');
    // 現場用で提出の直後なら、増えたタスク（調査の見積書作成など）を移る前に知らせる（Task 48 と同じ全画面のポップアップ）
    async function leave(to) {
      const added = before && typeof fieldNoteAddedTasks === 'function' ? await fieldNoteAddedTasks(r.case_id, before) : [];
      close();
      if (added.length) await fieldAddedPopup(added);
      location.hash = to;
    }
  }

  // Task 81: 報告書の要約（読むだけ。ReportLogic.decideSummary）。長い文は先頭だけ出して「もっと見る」で全部
  const SUM_MAX = 80;
  function summary(r) {
    const card = mk('div', 'rep-card nd-sum');
    card.id = 'nd-sum';
    card.appendChild(mk('h3', 'nd-sum-h', '報告書の中身'));
    const dl = mk('dl', 'nd-sum-dl');
    ReportLogic.decideSummary(r).forEach(x => {
      const dd = mk('dd', 'nd-sum-v');
      const full = String(x.value);
      if (Array.from(full).length <= SUM_MAX) dd.textContent = full;
      else {
        const t = mk('span', null, Array.from(full).slice(0, SUM_MAX).join('') + '…');
        const more = dBtn('もっと見る', 'linkbtn nd-more', () => { t.textContent = full; more.remove(); });
        dd.append(t, more);
      }
      dl.append(mk('dt', 'nd-sum-k', x.label), dd);
    });
    card.appendChild(dl);
    return card;
  }

  return { open, checkCase, canDecide, isOpen: () => !!cur };
})();
