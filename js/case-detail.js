// js/case-detail.js — 案件詳細画面（ヘッダ・住所と地図・依頼元・対応フェーズ・書類）
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）
// mk() は case-list.js、withBusy / setMsg / showScreen / $ は app.js のものを使う
//
// グローバル（timeline.js が使う）:
//   currentCase   … case_summaries の1行（表示中の案件。読み込み前/失敗時は null）
//   caseMembers   … [{user_id, display_name}]（投稿者名の解決用）
// timeline.js 側が定義すれば呼ばれるフック:
//   renderTimeline(rootEl)  … 詳細の初回描画時に1回
//   refreshTimeline()       … フェーズの操作・状態変更などで自動記録が増えた後
// phase-ui.js 側が定義すれば呼ばれるフック:
//   renderPhases(rootEl)    … 詳細の初回描画時に1回（「対応フェーズ」欄。依頼元の下）
let currentCase = null;
let caseMembers = [];

let caseDetailId = null;   // 表示中（または読み込み中）の案件ID
let caseGen = 0;           // 案件を開くたびに増やす。古い応答/操作結果を捨てる
const casePartSeq = { head: 0 }; // 部分更新ごとの番号

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

// 自動記録(system)が増える操作の後に呼ぶ。timeline.js が refreshTimeline を定義していれば再読み込みさせる
// 「↩ 1つ前に戻す」（js/case-undo.js）も、直近の編集を読み直す
function notifyTimeline() {
  try { if (typeof refreshTimeline === 'function') refreshTimeline(); }
  catch (e) { console.warn('タイムラインの更新に失敗', e); }
  try { if (typeof CaseUndo !== 'undefined') CaseUndo.refresh(); }
  catch (e) { console.warn('「1つ前に戻す」の更新に失敗', e); }
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
  renderDetailMessage('読み込み中…', false);

  let results;
  try {
    results = await Promise.all([
      CasesApi.getSummary(id),
      CasesApi.listMembers()
    ]);
  } catch (e) {
    if (gen !== caseGen) return;
    renderDetailMessage('案件の読み込みに失敗しました: ' + errText(e), true, id);
    return;
  }
  if (gen !== caseGen) return; // より新しい読み込みが始まっている
  const [row, members] = results;
  if (!row) {
    renderDetailMessage('案件が見つかりません', false);
    return;
  }
  currentCase = row;
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
    data = await CasesApi.getSummary(id);
    if (!data) throw new Error('案件が見つかりません');
  } catch (e) {
    return gen === caseGen && seq === casePartSeq[part] ? errText(e) : '';
  }
  if (gen !== caseGen || seq !== casePartSeq[part]) return '';
  currentCase = data; renderHead(); renderParties();
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

  // 依頼元（元請／物件オーナー／入居者）。編集は案件のポップアップ
  const parties = mk('div', 'taio');
  parties.id = 'case-parties';

  // 対応フェーズ（調査・原因元工事・復旧工事のカード。js/phase-ui.js）
  let phases = null;
  if (typeof renderPhases === 'function') {
    phases = mk('div', 'taio ph-box');
    phases.id = 'case-phases';
  }

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
      // 「今回は送らない」にした日程連絡・リマインドは除く
      try { ds = (await ReportsApi.listDrafts(cid)).filter(d => d.status === 'draft' && !d.skipped_at); } catch (e) { /* ⑤へ */ }
      if (caseDetailId !== cid) return; // 取得中に別の画面へ移った
      b.disabled = false;
      if (!ds || ds.length === 0) { toReports(); return; }
      if (ds.length === 1) { openMailDraft(ds[0].id); return; }
      const isNote = d => d.purpose === 'schedule' || d.purpose === 'reminder' || d.purpose === 'survey_result';
      if (!ds.some(d => d.estimate_id || isNote(d))) { toReports(); return; }
      mailList.replaceChildren(mk('b', null, '✉ 送信待ちの下書き ' + ds.length + '件'));
      ds.forEach(d => {
        const line = mk('div', 'rep-draft-line');
        const ph = (currentCase.phases || []).find(p => p.id === d.phase_id) || null;
        const kind = isNote(d) && typeof PhaseLogic !== 'undefined' ? PhaseLogic.mailLabel(d, ph) : d.estimate_id ? '見積書' : '報告書';
        line.appendChild(mk('span', 'rep-sub', kind + '・' + (d.subject || '（件名なし）')));
        line.appendChild(dBtn('下書きを確認する', 'btn sm inline', () => openMailDraft(d.id)));
        mailList.appendChild(line);
      });
      mailList.hidden = false;
    });
    mailBanner.id = 'case-mail-banner';
    const cnt = mk('span', null, '✉ 送信待ちの下書き ' + pendingMails + '件');
    cnt.id = 'case-mail-count';
    mailBanner.append(cnt, mk('span', 'rep-sub', 'メールを確認して送る →'));
  }

    // 書類のボタンと「送信待ちの下書き」は1行に（PC。スマホは折り返す）
  const toolsRow = mk('div', 'case-tools-row');
  toolsRow.append(...[tools, mailBanner].filter(Boolean));
  // 一番下に小さく「この案件を削除」（管理者だけ。js/case-trash.js）
  const trash = typeof CaseTrash !== 'undefined' ? CaseTrash.section(currentCase) : null;
  root.replaceChildren(...[detailBackBtn(), headBox, parties, phases, toolsRow, toolsNote, mailList, tl, trash].filter(Boolean));

  renderHead();
  renderParties();
  if (phases) {
    try { renderPhases(phases); }
    catch (e) { console.warn('対応フェーズ欄の表示に失敗', e); phases.replaceChildren(mk('div', 'err', '対応フェーズ欄を表示できませんでした: ' + errText(e))); }
  }
  if (typeof renderTimeline === 'function') renderTimeline(tl);
}

// 「送信待ちの下書き n件」を実際の下書きに合わせる（case_summaries.drafts_to_send は「今回は送らない」も数えるため）。
// 対応フェーズ欄の読み込み（js/phase-ui.js）が、この案件の mail_drafts を渡して呼ぶ
function syncCaseMailBanner(caseId, drafts) {
  const b = $('case-mail-banner');
  if (!b || caseDetailId !== caseId) return;
  const n = (drafts || []).filter(d => d.status === 'draft' && !d.skipped_at).length;
  const c = $('case-mail-count');
  if (c) c.textContent = '✉ 送信待ちの下書き ' + n + '件';
  b.hidden = n === 0;
  if (n === 0 && $('case-mail-list')) $('case-mail-list').hidden = true;
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
  card.appendChild(meta); // 元請・連絡先は下の「依頼元」欄（renderParties）

  const act = mk('div', 'head-act');
  act.appendChild(dBtn('編集', 'linkbtn', () => {
    openCaseModal(currentCase, async () => {
      const m = await refreshPart('head');
      notifyTimeline(); // 依頼元を変えたときの自動記録を出す
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

  // 今の状態 1行（🔴 自社の番 n件・🟡 相手待ち n件・次: …）。中身は対応フェーズの読み込み後に js/phase-ui.js（phSyncNow）が入れる。
  // ヘッダを描き直しても同じ要素を使う（中身を失わない）
  let nowLine = $('case-now');
  if (!nowLine) {
    nowLine = mk('div', 'case-now');
    nowLine.id = 'case-now';
    nowLine.hidden = true;
    nowLine.setAttribute('role', 'status');
  }
  // 「今の状態」の行の右に「↩ 1つ前に戻す」（js/case-undo.js）。確かめる欄はその下
  const nowRow = mk('div', 'case-now-row');
  nowRow.appendChild(nowLine);
  let undoPanel = null;
  if (typeof CaseUndo !== 'undefined') {
    const u = CaseUndo.mount();
    nowRow.appendChild(u.btn);
    undoPanel = u.panel;
  }
  card.appendChild(nowRow);
  if (undoPanel) card.appendChild(undoPanel);

  const err = mk('div', 'err'); err.id = 'case-head-err';
  card.appendChild(err);
  $('case-head-box').replaceChildren(card);
}

// ---- 依頼元 ----
// 元請は元請マスタ（担当者名・メール・電話は case_summaries の client_contact / client_master_email / client_tel。migration 022）、
// 物件オーナー・入居者は案件の列
function partyContact(email, tel) {
  const sub = mk('div', 'pty-sub');
  if (email) {
    const a = mk('a', 'pty-mail', '✉ ' + email);
    a.href = 'mailto:' + email;
    sub.appendChild(a);
  }
  if (tel) {
    const a = mk('a', 'pty-tel', '☎ ' + tel);
    a.href = 'tel:' + String(tel).replace(/[^0-9+]/g, '');
    sub.appendChild(a);
  }
  if (!email && !tel) sub.appendChild(mk('span', 'pty-none', 'メール・電話 未登録'));
  return sub;
}

function partyRow(key, label, value) {
  const r = mk('div', 'pty-row');
  r.dataset.party = key;
  r.appendChild(mk('div', 'pty-k', label));
  r.appendChild(value);
  return r;
}

function renderParties() {
  const box = $('case-parties');
  if (!box || !currentCase) return;
  const c = currentCase;
  const head = mk('div', 'taio-head');
  head.style.marginBottom = '0';
  head.appendChild(mk('b', null, '依頼元'));
  // 関係する部屋（加害部屋・被害部屋。migration 030 / Task 12。js/case-rooms.js）の保存・削除の後
  const roomsChanged = async () => {
    const m = await refreshPart('head');
    notifyTimeline(); // 部屋の追加・変更・削除の自動記録を出す
    if (m) setMsg('case-head-err', '保存しましたが、最新の表示に更新できませんでした: ' + m);
  };
  const headActs = mk('span', 'pty-head-acts');
  if (typeof CaseRooms !== 'undefined') headActs.appendChild(CaseRooms.addButton(c, roomsChanged));
  head.appendChild(headActs);
  headActs.appendChild(dBtn('依頼元を編集', 'linkbtn', () => {
    openCaseModal(currentCase, async () => {
      const m = await refreshPart('head');
      notifyTimeline(); // 依頼元を変えたときの自動記録を出す
      if (m) setMsg('case-head-err', '保存しましたが、最新の表示に更新できませんでした: ' + m);
    }, { focus: 'parties' });
  }));

  // 元請
  const gc = mk('div', 'pty-v');
  const master = !!c.client_id && !!c.client_master_name;
  const gcName = c.client_master_name || c.client_name;
  if (gcName) {
    const line = mk('div');
    line.appendChild(mk('b', null, gcName + (master && c.client_contact ? ' ' + c.client_contact + '様' : '')));
    if (c.client_id && c.client_billing_mode) {
      const m = c.client_billing_mode === 'monthly' ? 'monthly' : 'single';
      line.appendChild(mk('span', 'pty-tag ' + m, ClientsApi.BILLING_LABEL[m]));
    }
    if (!c.client_id) line.appendChild(mk('span', 'pty-tag', '元請マスタに未登録'));
    gc.appendChild(line);
    gc.appendChild(partyContact(master ? (c.client_master_email || c.client_email) : c.client_email, master ? c.client_tel : null));
  } else {
    gc.appendChild(mk('span', 'pty-none', '未選択（「依頼元を編集」から元請マスタで選ぶ）'));
  }

  const person = (nm, email, tel) => {
    const v = mk('div', 'pty-v');
    if (!nm && !email && !tel) { v.appendChild(mk('span', 'pty-none', '未登録')); return v; }
    v.appendChild(mk('b', null, nm ? nm + '様' : '（お名前未登録）'));
    v.appendChild(partyContact(email, tel));
    return v;
  };
  // 号室（migration 025）: 依頼元の上。連絡メールの件名・宛名・場所に入る
  const roomV = mk('div', 'pty-v');
  const roomText = typeof PhaseLogic !== 'undefined' ? PhaseLogic.roomLabel(c.room) : String(c.room || '').trim();
  roomV.appendChild(roomText ? mk('b', null, roomText) : mk('span', 'pty-none', '未登録（「依頼元を編集」から入れられます）'));
  // 依頼元の部屋は「この案件の部屋（被害部屋）」という扱い（Task 12。加害部屋などは下の「関係する部屋」）
  if (roomText) roomV.appendChild(mk('span', 'rm-own-note', ' この案件の部屋（被害部屋）'));
  const roomRow = partyRow('room', '号室', roomV);
  roomRow.id = 'case-room';
  roomRow.classList.add('pty-room');
  // 関係する部屋の一覧（部屋が無ければ出さない）
  let rooms = null;
  if (typeof CaseRooms !== 'undefined') {
    try { rooms = CaseRooms.section(c, roomsChanged); } catch (e) { console.warn('関係する部屋の表示に失敗', e); }
  }
  box.replaceChildren(...[roomRow, head,
    partyRow('client', '元請', gc),
    partyRow('owner', '物件オーナー', person(c.owner_name, c.owner_email, c.owner_tel)),
    partyRow('resident', '入居者', person(c.resident_name, c.resident_email, c.resident_tel)), rooms].filter(Boolean));
}
