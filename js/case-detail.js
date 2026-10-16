// js/case-detail.js — 案件詳細画面（ヘッダ・住所と地図・次やること・書類・対応履歴と精算）
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）
// mk() は case-list.js、withBusy / setMsg / showScreen / $ は app.js のものを使う
//
// グローバル（timeline.js が使う）:
//   currentCase   … case_summaries の1行（表示中の案件。読み込み前/失敗時は null）
//   caseMembers   … [{user_id, display_name}]（投稿者名の解決用）
// timeline.js 側が定義すれば呼ばれるフック:
//   renderTimeline(rootEl)  … 詳細の初回描画時に1回
//   refreshTimeline()       … 次やること済/対応履歴追加/精算確認/状態変更で自動記録が増えた後
let currentCase = null;
let caseMembers = [];
let caseActions = [];
let caseWorks = [];

let caseDetailId = null;   // 表示中（または読み込み中）の案件ID
let caseGen = 0;           // 案件を開くたびに増やす。古い応答/操作結果を捨てる
const casePartSeq = { head: 0, actions: 0, works: 0 }; // 部分更新ごとの番号
let nextFormKind = null;   // 次やること追加フォームの種類（null=閉）
let workFormKind = null;   // 対応履歴追加フォームの種類（null=閉）
const editingSettle = new Set(); // 精算予定日を編集中の work.id

const errText = e => (e && e.message ? e.message : String(e));

function memberName(id) {
  if (!id) return '';
  const m = caseMembers.find(x => x.user_id === id);
  return m ? (m.display_name || '(名前なし)') : '不明';
}

function dBtn(text, cls, onClick) {
  const b = mk('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', () => onClick(b));
  return b;
}

function dField(labelText, control) {
  const l = mk('label', null, labelText);
  l.appendChild(control);
  return l;
}

function dSelect(options, value) {
  const s = document.createElement('select');
  options.forEach(o => s.appendChild(new Option(o[1], o[0])));
  s.value = value;
  if (s.value !== value) s.value = options.length ? options[0][0] : '';
  return s;
}

function dDate(value) {
  const i = document.createElement('input');
  i.type = 'date';
  i.value = value || '';
  return i;
}

function localDateTimeValue(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function memberOptions(noneLabel) {
  const opts = [['', noneLabel]];
  caseMembers.forEach(m => {
    opts.push([m.user_id, (m.display_name || '(名前なし)') + (m.user_id === ctx.user.id ? '（自分）' : '')]);
  });
  return opts;
}

// 自動記録(system)が増える操作の後に呼ぶ。timeline.js が refreshTimeline を定義していれば再読み込みさせる
function notifyTimeline() {
  try { if (typeof refreshTimeline === 'function') refreshTimeline(); }
  catch (e) { console.warn('タイムラインの更新に失敗', e); }
}

// ---- 開く / 読み込み ----
// 一覧の行クリック → location.hash 変更 → hashchange → routeFromHash → openCase が2回走るので、
// 同じ案件を表示中/読み込み中なら何もしない。再読み込みは loadCase を直接呼ぶ
function openCase(id) {
  if (!id) return;
  if (caseDetailId === id && $('screen-case').classList.contains('active')) return;
  showScreen('case');
  renderHeaders();
  const h = '#case/' + id;
  if (location.hash !== h) location.hash = h;
  return loadCase(id);
}

function detailBackBtn() {
  return dBtn('← 案件一覧', 'back', () => openCases());
}

function renderDetailMessage(text, isErr, retryId) {
  const root = $('case-detail-root');
  const nodes = [detailBackBtn()];
  if (isErr) nodes.push(mk('div', 'err', text));
  else nodes.push(mk('div', 'empty', text));
  if (retryId) nodes.push(dBtn('再読み込み', 'btn sm ghost inline', () => loadCase(retryId)));
  root.replaceChildren(...nodes);
}

async function loadCase(id) {
  const gen = ++caseGen;
  caseDetailId = id;
  currentCase = null;
  caseMembers = [];
  caseActions = [];
  caseWorks = [];
  nextFormKind = null;
  workFormKind = null;
  editingSettle.clear();
  renderDetailMessage('読み込み中…', false);

  let results;
  try {
    results = await Promise.all([
      CasesApi.getSummary(id),
      CasesApi.listActions(id),
      CasesApi.listWorks(id),
      CasesApi.listMembers()
    ]);
  } catch (e) {
    if (gen !== caseGen) return;
    renderDetailMessage('案件の読み込みに失敗しました: ' + errText(e), true, id);
    return;
  }
  if (gen !== caseGen) return; // より新しい読み込みが始まっている
  const [row, actions, works, members] = results;
  if (!row) {
    renderDetailMessage('案件が見つかりません', false);
    return;
  }
  currentCase = row;
  caseActions = actions || [];
  caseWorks = works || [];
  caseMembers = members || [];
  buildDetail();
}

// 部分更新。'' = 成功 or 古い応答として破棄 / 文字列 = 失敗メッセージ
async function refreshPart(part) {
  const gen = caseGen;
  const id = caseDetailId;
  const seq = ++casePartSeq[part];
  let data;
  try {
    if (part === 'head') {
      data = await CasesApi.getSummary(id);
      if (!data) throw new Error('案件が見つかりません');
    } else if (part === 'actions') {
      data = await CasesApi.listActions(id);
    } else {
      data = await CasesApi.listWorks(id);
    }
  } catch (e) {
    return gen === caseGen && seq === casePartSeq[part] ? errText(e) : '';
  }
  if (gen !== caseGen || seq !== casePartSeq[part]) return '';
  if (part === 'head') { currentCase = data; renderHead(); }
  else if (part === 'actions') { caseActions = data || []; renderNextRows(); }
  else { caseWorks = data || []; renderWorksSum(); renderWorksRows(); }
  return '';
}

// 操作の共通ラッパー。fn が throw したら errId に表示。成功したら part を再取得して描画
async function runOp(b, errId, part, label, fn) {
  const gen = caseGen;
  setMsg(errId, '');
  await withBusy(b, async () => {
    try {
      await fn();
    } catch (e) {
      if (gen === caseGen) setMsg(errId, label + 'に失敗しました: ' + errText(e));
      return;
    }
    if (gen !== caseGen) return;
    const m = await refreshPart(part);
    if (m && gen === caseGen) setMsg(errId, label + 'は完了しましたが、最新の表示に更新できませんでした: ' + m);
  });
}

// ---- 全体の骨組み ----
function buildDetail() {
  const root = $('case-detail-root');

  const headBox = mk('div');
  headBox.id = 'case-head-box';

  const next = mk('div', 'next');
  const nextHead = mk('div', 'taio-head');
  nextHead.appendChild(mk('b', null, '次やること'));
  const nextRows = mk('div'); nextRows.id = 'case-next-rows';
  const nextForm = mk('div'); nextForm.id = 'case-next-form';
  const nextChips = mk('div', 'taio-add'); nextChips.id = 'case-next-chips';
  nextChips.style.marginTop = '10px';
  nextChips.style.marginBottom = '0';
  const nextErr = mk('div', 'err'); nextErr.id = 'case-next-err';
  next.append(nextHead, nextRows, nextForm, nextChips, nextErr);

  const tools = mk('div', 'tools');
  [['📋', '報告書'], ['🧾', '見積書'], ['📢', '工事掲示']].forEach(([ic, nm]) => {
    const b = mk('button', 'toolbtn');
    b.type = 'button';
    const ct = mk('div', 'ct', '準備中');
    if (nm === '報告書') {
      // 件数は case_summaries の report_count / reports_to_confirm。確認待ちがあれば強調
      const total = Number(currentCase.report_count) || 0;
      const wait = Number(currentCase.reports_to_confirm) || 0;
      ct.textContent = wait > 0 ? '確認待ち ' + wait : total + '件';
      if (wait > 0) ct.classList.add('hot');
      b.id = 'case-tool-reports';
      b.addEventListener('click', () => { location.hash = '#case/' + currentCase.id + '/reports'; });
    } else if (nm === '見積書') {
      // 件数は case_summaries の estimate_count（系列の数）、金額は latest_estimate_total（migration 014/015）
      const n = Number(currentCase.estimate_count) || 0;
      const lt = currentCase.latest_estimate_total;
      ct.textContent = n + '件';
      b.id = 'case-tool-estimates';
      b.addEventListener('click', () => { location.hash = '#case/' + currentCase.id + '/estimates'; });
      if (n > 0 && lt != null && typeof EstimateLogic !== 'undefined') {
        const yen = mk('div', 'ct ct-yen', EstimateLogic.yen(lt));
        yen.id = 'case-tool-estimates-total';
        b.append(mk('div', 'ic', ic), mk('div', 'nm', nm), ct, yen);
        tools.appendChild(b);
        return;
      }
    } else if (nm === '工事掲示') {
      // 件数は case_summaries の notice_count（migration 013）
      ct.textContent = (Number(currentCase.notice_count) || 0) + '件';
      b.id = 'case-tool-notices';
      b.addEventListener('click', () => { location.hash = '#case/' + currentCase.id + '/notices'; });
    } else {
      b.addEventListener('click', () => { $('case-tools-note').hidden = false; });
    }
    b.append(mk('div', 'ic', ic), mk('div', 'nm', nm), ct);
    tools.appendChild(b);
  });
  const toolsNote = mk('div', 'tools-note', 'Phase 2以降で使えるようになります');
  toolsNote.id = 'case-tools-note';
  toolsNote.hidden = true;

  const works = mk('div', 'taio');
  const worksHead = mk('div', 'taio-head');
  worksHead.appendChild(mk('b', null, '対応履歴と精算'));
  const worksSum = mk('span', 'taio-sum'); worksSum.id = 'case-works-sum';
  worksHead.appendChild(worksSum);
  const worksChips = mk('div', 'taio-add'); worksChips.id = 'case-works-chips';
  const worksForm = mk('div'); worksForm.id = 'case-works-form';
  const worksRows = mk('div'); worksRows.id = 'case-works-rows';
  const worksErr = mk('div', 'err'); worksErr.id = 'case-works-err';
  works.append(worksHead, worksChips, worksForm, worksRows, worksErr);

  const tl = mk('div'); tl.id = 'case-timeline';

  // 依頼者へ送るメール（報告書・見積書）の下書きが残っているとき（⑨ のある版だけ）。行き先:
  //   1件 → その⑨ / 報告書の下書きだけ → ⑤の「送信待ちの下書き」 /
  //   見積書の下書きを含む（見積書一覧には送信待ちの表示がない）→ 案件詳細の中に下書きの一覧を出す / 取得できない → ⑤
  const pendingMails = Number(currentCase.drafts_to_send) || 0;
  let mailBanner = null, mailList = null;
  if (pendingMails > 0 && typeof openMailDraft === 'function') {
    mailList = mk('div', 'rep-card rep-drafts');
    mailList.id = 'case-mail-list';
    mailList.hidden = true;
    mailBanner = dBtn('', 'rep-banner', async b => {
      const cid = currentCase.id;
      const toReports = () => { location.hash = '#case/' + cid + '/reports'; };
      b.disabled = true;
      let ds = null;
      try { ds = (await ReportsApi.listDrafts(cid)).filter(d => d.status === 'draft'); } catch (e) { /* ⑤へ */ }
      if (caseDetailId !== cid) return; // 取得中に別の画面へ移った
      b.disabled = false;
      if (!ds || ds.length === 0) { toReports(); return; }
      if (ds.length === 1) { openMailDraft(ds[0].id); return; }
      if (!ds.some(d => d.estimate_id)) { toReports(); return; }
      mailList.replaceChildren(mk('b', null, '✉ 送信待ちの下書き ' + ds.length + '件'));
      ds.forEach(d => {
        const line = mk('div', 'rep-draft-line');
        line.appendChild(mk('span', 'rep-sub', (d.estimate_id ? '見積書' : '報告書') + '・' + (d.subject || '（件名なし）')));
        line.appendChild(dBtn('下書きを確認する', 'btn sm inline', () => openMailDraft(d.id)));
        mailList.appendChild(line);
      });
      mailList.hidden = false;
    });
    mailBanner.id = 'case-mail-banner';
    mailBanner.append(mk('span', null, '✉ 送信待ちの下書き ' + pendingMails + '件'), mk('span', 'rep-sub', 'メールを確認して送る →'));
  }

  root.replaceChildren(...[detailBackBtn(), headBox, next, tools, toolsNote, mailBanner, mailList, works, tl].filter(Boolean));

  renderHead();
  renderNextRows();
  renderNextChips();
  renderNextForm();
  renderWorksSum();
  renderWorksChips();
  renderWorksForm();
  renderWorksRows();
  if (typeof renderTimeline === 'function') renderTimeline(tl);
}

// ---- ヘッダ ----
function renderHead() {
  const c = currentCase;
  const done = c.status === 'done';
  const card = mk('div', 'case-head');

  const t = mk('div', 't');
  t.appendChild(mk('h2', null, c.name));
  t.appendChild(mk('span', 'st ' + (done ? 'done' : 'open'), done ? '完了' : '進行中'));
  card.appendChild(t);

  const meta = mk('div', 'meta');
  meta.appendChild(mk('span', null, '👤 ' + (c.assignee_name || '担当者未設定')));
  const ds = CaseLogic.dueState(c.due_date, CaseLogic.todayStr());
  const hot = !done && (ds === 'overdue' || ds === 'near');
  const due = mk('span', hot ? 'hot' : null, c.due_date ? '📅 期日 ' + CaseLogic.formatMD(c.due_date) : '📅 期日未設定');
  meta.appendChild(due);
  if (c.client_name) meta.appendChild(mk('span', null, '🏢 元請: ' + c.client_name));
  if (c.client_email) meta.appendChild(mk('span', null, '✉ ' + c.client_email));
  card.appendChild(meta);

  const act = mk('div', 'head-act');
  act.appendChild(dBtn('編集', 'linkbtn', () => {
    openCaseModal(currentCase, async () => {
      const m = await refreshPart('head');
      if (m) setMsg('case-head-err', '保存しましたが、最新の表示に更新できませんでした: ' + m);
    });
  }));
  act.appendChild(dBtn(done ? '再開する' : '完了にする', 'btn sm ghost inline', b => {
    const gen = caseGen;
    const id = c.id;
    const next = done ? 'open' : 'done';
    runOp(b, 'case-head-err', 'head', '状態の変更', async () => {
      await CasesApi.setStatus(id, next);
      if (gen === caseGen) notifyTimeline();
    });
  }));
  card.appendChild(act);

  const urls = CaseLogic.mapUrls(c.address);
  const addr = mk('div', 'addr');
  if (urls) {
    addr.appendChild(mk('span', null, '📍 ' + c.address));
    const links = mk('span', 'maplinks');
    const a1 = mk('a', null, 'Googleマップ');
    a1.href = urls.google; a1.target = '_blank'; a1.rel = 'noopener';
    const a2 = mk('a', null, '標準マップ');
    a2.href = urls.apple; a2.target = '_blank'; a2.rel = 'noopener';
    links.append(a1, document.createTextNode('｜'), a2);
    addr.appendChild(links);
  } else {
    addr.appendChild(mk('span', 'muted', '📍 住所未設定（編集から追加）'));
  }
  card.appendChild(addr);

  const err = mk('div', 'err'); err.id = 'case-head-err';
  card.appendChild(err);
  $('case-head-box').replaceChildren(card);
}

// ---- 次やること ----
function renderNextRows() {
  const box = $('case-next-rows');
  if (caseActions.length === 0) {
    box.replaceChildren(mk('div', 'nx-empty', '次やることはありません'));
    return;
  }
  box.replaceChildren(...caseActions.map(actionRowEl));
}

function actionRowEl(a) {
  const today = CaseLogic.todayStr();
  const us = a.ball === 'us';
  const row = mk('div', 'nx-row');

  const l = mk('div', 'nx-l');
  l.appendChild(mk('span', 'ball' + (us ? ' me' : ''), us ? '🔴 自分の番' : '🟡 相手待ち'));
  l.appendChild(mk('b', null, a.title));
  if (a.started_on) {
    const days = CaseLogic.daysBetween(a.started_on, today);
    l.appendChild(mk('span', 'nx-sub',
      CaseLogic.formatMD(a.started_on) + '開始' + (days >= 0 ? '・' + days + '日経過' : '')));
  }
  const who = memberName(a.assignee_id);
  l.appendChild(a.assignee_id
    ? mk('span', 'who-pill', '👤 ' + who)
    : mk('span', 'who-pill none', '担当なし'));
  row.appendChild(l);

  const r = mk('div', 'nx-r');
  if (a.due_date) {
    const ds = CaseLogic.dueState(a.due_date, today);
    const hot = ds === 'overdue' || ds === 'near';
    r.appendChild(mk('span', 'nx-due' + (hot ? ' near' : ''),
      (us ? '期限 ' : '次回確認 ') + CaseLogic.formatMD(a.due_date)));
  }
  r.appendChild(dBtn('済にする ✓', 'linkbtn', b => {
    const gen = caseGen;
    runOp(b, 'case-next-err', 'actions', '完了処理', async () => {
      await CasesApi.completeAction(a);
      if (gen === caseGen) notifyTimeline();
    });
  }));
  r.appendChild(dBtn('削除', 'linkbtn danger', b => {
    if (!confirm('削除しますか？')) return;
    runOp(b, 'case-next-err', 'actions', '削除', () => CasesApi.deleteAction(a.id));
  }));
  row.appendChild(r);
  return row;
}

function renderNextChips() {
  const box = $('case-next-chips');
  box.replaceChildren(...CaseLogic.ACTION_KINDS.map(k => {
    const c = dBtn('＋ ' + k.label, 'chip' + (nextFormKind === k.key ? ' on' : ''), () => {
      nextFormKind = nextFormKind === k.key ? null : k.key;
      setMsg('case-next-err', '');
      renderNextChips();
      renderNextForm();
    });
    return c;
  }));
}

function renderNextForm() {
  const box = $('case-next-form');
  if (!nextFormKind) { box.replaceChildren(); return; }
  const k = CaseLogic.actionKind(nextFormKind);
  const id = currentCase.id;
  const today = CaseLogic.todayStr();

  const form = mk('div', 'addform');
  form.appendChild(mk('div', 'af-ttl', '＋ ' + k.label + ' を追加'));
  const grid = mk('div', 'af-grid');

  const title = document.createElement('input');
  title.type = 'text';
  title.value = k.title;
  title.autocomplete = 'off';
  title.maxLength = 200;
  const titleLabel = dField('内容', title);
  titleLabel.className = 'span-all';

  const defAssignee = currentCase.assignee_id && caseMembers.some(m => m.user_id === currentCase.assignee_id)
    ? currentCase.assignee_id : ctx.user.id;
  const asg = dSelect(memberOptions('担当なし'), defAssignee);

  const ball = dSelect([['us', '🔴 自分の番'], ['them', '🟡 相手待ち']], k.ball);
  const due = dDate('');
  const dueText = document.createTextNode(k.ball === 'us' ? '期限' : '次回確認日');
  const dueLabel = mk('label');
  dueLabel.append(dueText, due);
  ball.addEventListener('change', () => { dueText.textContent = ball.value === 'us' ? '期限' : '次回確認日'; });

  grid.append(titleLabel, dField('担当', asg), dField('ボール', ball), dueLabel);

  let started = null;
  if (k.key === 'insurance') {
    started = dDate(today);
    grid.appendChild(dField('申請日', started));
  }
  form.appendChild(grid);

  const acts = mk('div', 'af-act');
  acts.appendChild(dBtn('キャンセル', 'btn sm ghost inline', () => {
    nextFormKind = null;
    setMsg('case-next-err', '');
    renderNextChips();
    renderNextForm();
  }));
  acts.appendChild(dBtn('追加', 'btn sm inline', b => {
    const t = title.value.trim();
    if (!t) { setMsg('case-next-err', '内容を入力してください'); title.focus(); return; }
    const gen = caseGen;
    const fields = {
      kind: k.key,
      ball: ball.value,
      title: t,
      assignee_id: asg.value || null,
      due_date: due.value || null,
      started_on: started ? started.value || null : null
    };
    runOp(b, 'case-next-err', 'actions', '追加', async () => {
      await CasesApi.addAction(id, fields);
      if (gen !== caseGen) return;
      nextFormKind = null;
      renderNextChips();
      renderNextForm();
    });
  }));
  form.appendChild(acts);
  box.replaceChildren(form);
  if (!title.value) title.focus();
}

// ---- 対応履歴と精算 ----
function renderWorksSum() {
  const n = caseWorks.filter(w => !w.settled_at).length;
  const sum = $('case-works-sum');
  sum.replaceChildren(document.createTextNode('精算未確認 '));
  const b = mk('b', n > 0 ? 'hot' : null, n + '件');
  sum.appendChild(b);
}

function renderWorksChips() {
  const box = $('case-works-chips');
  box.replaceChildren(...CaseLogic.WORK_KINDS.map(k =>
    dBtn('＋ ' + k.label, 'chip' + (workFormKind === k.key ? ' on' : ''), () => {
      workFormKind = workFormKind === k.key ? null : k.key;
      setMsg('case-works-err', '');
      renderWorksChips();
      renderWorksForm();
    })));
}

function renderWorksForm() {
  const box = $('case-works-form');
  if (!workFormKind) { box.replaceChildren(); return; }
  const kind = workFormKind;
  const id = currentCase.id;
  const isOther = kind === 'other';

  const form = mk('div', 'addform');
  form.style.marginTop = '0';
  form.style.marginBottom = '10px';
  form.appendChild(mk('div', 'af-ttl', '＋ ' + CaseLogic.workLabel(kind) + ' を記録'));
  const grid = mk('div', 'af-grid');

  const at = document.createElement('input');
  at.type = 'datetime-local';
  at.value = localDateTimeValue(new Date());
  const worker = dSelect(memberOptions('未設定'), ctx.user.id);
  const settle = dDate('');
  const label = document.createElement('input');
  label.type = 'text';
  label.autocomplete = 'off';
  label.maxLength = 200;
  label.placeholder = isOther ? '内容（必須）' : '補足（任意）';
  const labelField = dField(isOther ? '内容（必須）' : '補足（任意）', label);
  labelField.className = 'span-all';

  grid.append(dField('対応日時', at), dField('対応者', worker), dField('精算予定日（任意）', settle), labelField);
  form.appendChild(grid);

  const acts = mk('div', 'af-act');
  acts.appendChild(dBtn('キャンセル', 'btn sm ghost inline', () => {
    workFormKind = null;
    setMsg('case-works-err', '');
    renderWorksChips();
    renderWorksForm();
  }));
  acts.appendChild(dBtn('追加', 'btn sm inline', b => {
    const text = label.value.trim();
    if (isOther && !text) { setMsg('case-works-err', '内容を入力してください'); label.focus(); return; }
    const when = new Date(at.value);
    if (!at.value || isNaN(when.getTime())) { setMsg('case-works-err', '対応日時を入力してください'); return; }
    const gen = caseGen;
    const fields = {
      kind,
      label: text || null,
      worked_at: when.toISOString(),
      worker_id: worker.value || null,
      settle_due: settle.value || null
    };
    runOp(b, 'case-works-err', 'works', '追加', async () => {
      await CasesApi.addWork(id, fields);
      if (gen !== caseGen) return;
      workFormKind = null;
      renderWorksChips();
      renderWorksForm();
      notifyTimeline();
    });
  }));
  form.appendChild(acts);
  box.replaceChildren(form);
}

function renderWorksRows() {
  const box = $('case-works-rows');
  if (caseWorks.length === 0) {
    box.replaceChildren(mk('div', 'nx-empty', '対応履歴はまだありません'));
    return;
  }
  box.replaceChildren(...caseWorks.map(workRowEl));
}

function workRowEl(w) {
  const row = mk('div', 'to-row');
  const l = mk('div', 'to-l');
  l.appendChild(mk('span', 'wk-tag', CaseLogic.workLabel(w.kind)));
  l.appendChild(mk('b', null, CaseLogic.formatDateTime(w.worked_at)));
  if (w.worker_id) l.appendChild(mk('span', 'to-who', memberName(w.worker_id)));
  if (w.label) l.appendChild(mk('span', 'to-label', w.label));
  row.appendChild(l);

  const r = mk('div', 'to-r');
  if (editingSettle.has(w.id)) {
    const d = dDate(w.settle_due);
    r.appendChild(mk('span', 'to-pay', '精算:'));
    r.appendChild(d);
    r.appendChild(dBtn('保存', 'btn sm inline', b => {
      const v = d.value || null;
      runOp(b, 'case-works-err', 'works', '精算予定日の変更', async () => {
        await CasesApi.updateWork(w.id, { settle_due: v });
        editingSettle.delete(w.id);
      });
    }));
    r.appendChild(dBtn('キャンセル', 'linkbtn', () => {
      editingSettle.delete(w.id);
      renderWorksRows();
    }));
  } else {
    r.appendChild(mk('span', 'to-pay', '精算: ' + (w.settle_due ? CaseLogic.formatMD(w.settle_due) : '未定')));
    r.appendChild(dBtn(w.settle_due ? '変更' : '設定', 'linkbtn', () => {
      editingSettle.add(w.id);
      renderWorksRows();
    }));
  }

  const settled = !!w.settled_at;
  r.appendChild(dBtn(settled ? '精算確認済み ✓' : '精算未確認 → タップで✓', 'settle-btn' + (settled ? ' ok' : ''), b => {
    const gen = caseGen;
    runOp(b, 'case-works-err', 'works', '精算状態の変更', async () => {
      await CasesApi.setSettled(w, !settled);
      if (gen === caseGen && !settled) notifyTimeline();
    });
  }));
  r.appendChild(dBtn('削除', 'linkbtn danger', b => {
    if (!confirm('削除しますか？')) return;
    runOp(b, 'case-works-err', 'works', '削除', async () => {
      await CasesApi.deleteWork(w.id);
      editingSettle.delete(w.id);
    });
  }));
  row.appendChild(r);
  return row;
}
