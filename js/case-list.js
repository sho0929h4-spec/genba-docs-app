// js/case-list.js — 案件一覧画面と新規/編集モーダル
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）
let caseRows = [];
let caseFilter = 'open';
let caseModalRow = null;      // null=新規 / 行=編集
let caseModalOnSaved = null;  // 編集保存後の再描画コールバック
let caseModalBusy = false;    // 保存中（閉じ操作を無効化）
let caseModalAssigneeTouched = false; // 読み込み中にユーザーが担当者を選んだか
let caseModalSeq = 0;         // モーダルを開くたびに増やす。古い担当者一覧の応答を捨てる
let caseListSeq = 0;          // 一覧取得のリクエスト番号。古い応答を捨てる
let caseLoading = false;
let caseLoadFailed = false;

const CHIP_LABELS = {
  open: '進行中',
  mine_turn: '🔴 自分の番',
  mine: '自分の担当',
  requests: '⚠️ 未対応の依頼',
  unsettled: '💰 精算未確認',
  done: '完了'
};

function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

async function openCases() {
  renderHeaders();
  showScreen('cases');
  history.replaceState(null, '', location.pathname + location.search);
  setMsg('case-list-msg', '');
  const seq = ++caseListSeq;
  caseLoading = true;
  caseLoadFailed = false;
  renderCaseList();
  let rows = [];
  let errMsg = '';
  try {
    rows = (await CasesApi.listSummaries()) || [];
  } catch (e) {
    errMsg = '案件の読み込みに失敗しました: ' + (e && e.message ? e.message : e);
  }
  if (seq !== caseListSeq) return; // より新しい読み込みが始まっている
  caseLoading = false;
  if (errMsg) {
    caseRows = [];
    caseLoadFailed = true;
    setMsg('case-list-msg', errMsg);
  } else {
    caseRows = rows;
  }
  renderCaseList();
}

function renderCaseList() {
  const me = ctx.user.id;
  const counts = CaseLogic.countByFilter(caseRows, me);
  document.querySelectorAll('#case-chips .chip').forEach(chip => {
    const k = chip.dataset.filter;
    chip.textContent = CHIP_LABELS[k] + ' ' + (counts[k] || 0);
    chip.classList.toggle('on', k === caseFilter);
  });

  const rows = CaseLogic.filterCases(caseRows, caseFilter, $('case-search').value, me);
  const list = $('case-list');
  list.replaceChildren(...rows.map(caseRowEl));
  $('case-loading').hidden = !caseLoading;
  $('case-empty').hidden = caseLoading || caseLoadFailed || rows.length > 0;
}

function caseRowEl(r) {
  const today = CaseLogic.todayStr();
  const el = mk('div', 'case');
  el.dataset.id = r.id;

  const t = mk('div', 't');
  t.appendChild(mk('h3', null, r.name));
  const ds = CaseLogic.dueState(r.due_date, today);
  const due = mk('span', 'due' + ((ds === 'overdue' || ds === 'near') && r.status !== 'done' ? ' near' : ''),
    r.due_date ? '期日 ' + CaseLogic.formatMD(r.due_date) : '期日未設定');
  t.appendChild(due);
  el.appendChild(t);

  const meta = mk('div', 'meta');
  meta.appendChild(mk('span', null, '👤 ' + (r.assignee_name || '担当者未設定')));
  meta.appendChild(mk('span', 'st ' + (r.status === 'done' ? 'done' : 'open'), r.status === 'done' ? '完了' : '進行中'));
  el.appendChild(meta);

  if (r.next_title) {
    const us = r.next_ball === 'us';
    const nx = mk('div', 'nx-line');
    nx.appendChild(mk('span', 'ball' + (us ? ' me' : ''), us ? '🔴 社内対応' : '🟡 相手待ち'));
    if (r.next_assignee_name) nx.appendChild(mk('span', 'who-pill', '👤 ' + r.next_assignee_name));
    let text = '次: ' + r.next_title;
    if (r.next_due) text += (us ? '（期限 ' : '（次回確認 ') + CaseLogic.formatMD(r.next_due) + '）';
    nx.appendChild(mk('span', null, text));
    el.appendChild(nx);
  }

  const badges = mk('div', 'badges');
  if (r.open_requests > 0) badges.appendChild(mk('span', 'bdg alert', '⚠️ 未対応の依頼 ' + r.open_requests));
  if (r.unsettled_works > 0) badges.appendChild(mk('span', 'bdg alert', '💰 精算未確認 ' + r.unsettled_works));
  badges.appendChild(mk('span', 'bdg', '💬 ' + (r.timeline_count || 0) + '件'));
  el.appendChild(badges);

  return el;
}

// ---- モーダル ----
// force=true は保存中でも閉じる（画面遷移時）
function closeCaseModal(force) {
  if (caseModalBusy && !force) return;
  caseModalSeq++;
  setCaseModalBusy(false); // 強制クローズ時、進行中の保存はもう何も触らない
  $('case-modal').hidden = true;
  caseModalRow = null;
  caseModalOnSaved = null;
}

function setCaseModalBusy(busy) {
  caseModalBusy = busy;
  $('cm-cancel').disabled = busy;
  $('cm-close').disabled = busy;
}

async function openCaseModal(row, onSaved) {
  const seq = ++caseModalSeq;
  caseModalRow = row || null;
  caseModalOnSaved = onSaved || null;
  setCaseModalBusy(false);
  caseModalAssigneeTouched = false;
  setMsg('cm-msg', '');
  $('cm-title').textContent = row ? '案件を編集' : '新規案件';
  $('cm-save').textContent = row ? '保存する' : '作成する';
  $('cm-name').value = row ? row.name || '' : '';
  $('cm-due').value = row ? row.due_date || '' : '';
  $('cm-address').value = row ? row.address || '' : '';
  $('cm-client').value = row ? row.client_name || '' : '';
  $('cm-client-email').value = row ? row.client_email || '' : '';

  const sel = $('cm-assignee');
  const want = row ? row.assignee_id || '' : ctx.user.id;
  sel.replaceChildren(new Option('未設定', ''));
  sel.value = '';
  $('cm-save').disabled = true; // 担当者一覧が揃うまで保存させない（担当が黙って消えるのを防ぐ）
  $('case-modal').hidden = false;
  $('cm-name').focus();
  let members = null;
  let errMsg = '';
  try {
    members = await CasesApi.listMembers();
  } catch (e) {
    errMsg = '担当者一覧の読み込みに失敗しました: ' + (e && e.message ? e.message : e);
  }
  if (seq !== caseModalSeq) return; // 閉じられた/開き直された
  const selfLabel = (ctx.membership && ctx.membership.display_name ? ctx.membership.display_name : '自分') + '（自分）';
  (members || []).forEach(m => {
    const label = (m.display_name || '(名前なし)') + (m.user_id === ctx.user.id ? '（自分）' : '');
    sel.appendChild(new Option(label, m.user_id));
  });
  if (!caseModalAssigneeTouched) sel.value = want;
  if (!caseModalAssigneeTouched && want && sel.value !== want) {
    // 一覧に無い（取得失敗/退会済み等）。元の値を保持する選択肢を足す
    const label = want === ctx.user.id ? selfLabel
      : (row && row.assignee_name ? row.assignee_name : '') + '（現在の担当）';
    sel.appendChild(new Option(label, want));
    sel.value = want;
  }
  if (errMsg) setMsg('cm-msg', errMsg);
  $('cm-save').disabled = false;
}

async function saveCaseModal() {
  setMsg('cm-msg', '');
  if (caseModalBusy) return;
  const name = $('cm-name').value.trim();
  if (!name) { setMsg('cm-msg', '物件名・現場名を入力してください'); return; }
  const email = $('cm-client-email').value.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setMsg('cm-msg', 'メールアドレスの形式が正しくありません');
    return;
  }
  const fields = {
    name,
    due_date: $('cm-due').value || null,
    assignee_id: $('cm-assignee').value || null,
    address: $('cm-address').value.trim() || null,
    client_name: $('cm-client').value.trim() || null,
    client_email: email || null
  };
  const row = caseModalRow;
  const cb = caseModalOnSaved;
  const seq = caseModalSeq;
  const idleLabel = row ? '保存する' : '作成する';
  setCaseModalBusy(true);
  $('cm-save').disabled = true;
  $('cm-save').textContent = '保存中…';
  let created = null;
  let errMsg = '';
  try {
    if (row) await CasesApi.updateCase(row.id, fields);
    else created = await CasesApi.createCase(fields);
  } catch (e) {
    errMsg = '保存できませんでした: ' + (e && e.message ? e.message : e);
  }
  // 強制クローズ（画面遷移）や別モーダルの表示で世代が変わっていたら、UIにも画面遷移にも一切触れない。
  // 保存自体は成功している場合があり、一覧は次回表示で反映される
  if (seq !== caseModalSeq) return;
  setCaseModalBusy(false);
  $('cm-save').disabled = false;
  $('cm-save').textContent = idleLabel;
  if (errMsg) { setMsg('cm-msg', errMsg); return; }
  // ここから先は保存成功。後続処理の失敗は保存失敗として扱わない
  closeCaseModal();
  try {
    if (row) { if (cb) await cb(); }
    else openCase(created.id);
  } catch (e) { console.warn('保存後の処理に失敗', e); }
}

function bindCaseList() {
  $('case-search').addEventListener('input', renderCaseList);
  $('cm-assignee').addEventListener('change', () => { caseModalAssigneeTouched = true; });
  $('case-chips').addEventListener('click', ev => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    caseFilter = chip.dataset.filter;
    renderCaseList();
  });
  $('case-list').addEventListener('click', ev => {
    const el = ev.target.closest('.case');
    if (el) openCase(el.dataset.id);
  });
  $('case-new-btn').addEventListener('click', () => openCaseModal(null));
  $('cm-cancel').addEventListener('click', () => closeCaseModal());
  $('cm-save').addEventListener('click', saveCaseModal);
  // 外側のクリックや Esc では閉じない（入力中のデータが消えるため）。閉じるのは × とキャンセルだけ
  $('cm-close').addEventListener('click', () => closeCaseModal());
}
