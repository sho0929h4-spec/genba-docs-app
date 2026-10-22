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
let caseListFlash = '';       // 次に一覧を開いたとき1回だけ出す案内（案件を削除した後。js/case-trash.js）
function setCaseListFlash(text) { caseListFlash = text || ''; }

// チップ。🔴 自分の番 / 🟡 相手待ち / 💴 入金待ち は対応フェーズの段階から（CaseLogic → PhaseLogic.caseFlags）
const CHIP_LABELS = {
  open: '進行中',
  mine_turn: '自分の番',
  waiting: '相手待ち',
  mine: '自分の担当',
  requests: '未対応の依頼あり',
  unpaid: '入金待ち',
  done: '完了'
};
// チップの説明（Task 23 用語表: 自分の番＝自分が担当の自社の番）。選んだチップの説明を一覧の上に出す（title にも入れる）
const CHIP_HINTS = {
  mine_turn: '自分の番 = 自分が担当（案件の担当者か作業担当者）の案件で、こちらがやること（自社の番）があるもの',
  waiting: '相手待ち = 依頼元の返事や、URLを渡した担当者の入力を待っているもの'
};
const NEXT_MAX = 2; // カードの「次:」は最大2行（🔴 を先）

// 担当者の選択肢の後ろに付ける電話番号（Task 32。memberships.phone。無ければ ''）
function memberTel(m) { return m && m.phone ? '　電話 ' + m.phone : ''; }

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
  setMsg('case-list-msg', caseListFlash, !!caseListFlash);
  caseListFlash = '';
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
  // Task 29: 報告書の期限超過を管理者に知らせる（アプリを開いたとき・1回だけ＝DB が判定）。作ったら数を読み直す
  if (!errMsg && typeof overdueSync === 'function') {
    try {
      if (await overdueSync(rows)) {
        const again = (await CasesApi.listSummaries()) || [];
        if (seq !== caseListSeq) return;
        rows = again;
        caseRows = rows;
        renderCaseList();
      }
    } catch (e) { console.warn('報告書の期限超過の確認に失敗', e); }
    if (seq !== caseListSeq) return;
  }
  // 時刻を過ぎたリマインドの下書きを作り、「✉️ 送るメールが n件あります」を出す（js/outbox-ui.js）
  if (!errMsg && typeof refreshStaffBanner === 'function') refreshStaffBanner(rows, () => seq === caseListSeq && $('screen-cases').classList.contains('active')); // 🔔 確認してください（Task 6b）
  if (!errMsg && typeof refreshMessagesBanner === 'function') refreshMessagesBanner(rows, () => seq === caseListSeq && $('screen-cases').classList.contains('active')); // 📨 現場からの連絡（Task 23）
  if (!errMsg && typeof refreshOutboxBanner === 'function') refreshOutboxBanner(rows, () => seq === caseListSeq && $('screen-cases').classList.contains('active'));
}

function renderCaseList() {
  const me = ctx.user.id;
  const now = new Date();
  const counts = CaseLogic.countByFilter(caseRows, me, now);
  document.querySelectorAll('#case-chips .chip').forEach(chip => {
    const k = chip.dataset.filter;
    chip.textContent = CHIP_LABELS[k] + ' ' + (counts[k] || 0);
    chip.classList.toggle('on', k === caseFilter);
    if (CHIP_HINTS[k]) chip.title = CHIP_HINTS[k];
  });
  const hint = $('case-chip-hint');
  if (hint) { hint.textContent = CHIP_HINTS[caseFilter] || ''; hint.hidden = !CHIP_HINTS[caseFilter]; }

  const rows = CaseLogic.filterCases(caseRows, caseFilter, $('case-search').value, me, now);
  const list = $('case-list');
  list.replaceChildren(...rows.map(r => caseRowEl(r, now)));
  $('case-loading').hidden = !caseLoading;
  $('case-empty').hidden = caseLoading || caseLoadFailed || rows.length > 0;
  // 「✅ やること n件」（自分の分。押すと #tasks。js/tasks.js）
  const tb = $('case-tasks');
  if (tb && typeof tasksBannerCount === 'function') {
    const n = caseLoading || caseLoadFailed ? 0 : tasksBannerCount(caseRows);
    tb.replaceChildren(Icon.prepend(mk('span', null, 'やること ' + n + '件'), 'tasks'), mk('span', 'rep-sub', '自分の分を見る →'));
    tb.hidden = n === 0;
  }
}

function caseRowEl(r, now) {
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
  meta.appendChild(Icon.prepend(mk('span', null, r.assignee_name || '担当者未設定'), 'user', 14));
  meta.appendChild(mk('span', 'st ' + (r.status === 'done' ? 'done' : 'open'), r.status === 'done' ? '完了' : '進行中'));
  el.appendChild(meta);

  // 次: 各フェーズの今の段階（PhaseLogic.caseNext）。完了した案件は入金待ちだけ
  const all = PhaseLogic.caseNext(r.phases, now || new Date(), { me: ctx && ctx.user ? ctx.user.id : null }); // Task 25: 見ている人で段階が変わる
  const next = r.status === 'done' ? all.filter(x => x.key === 'payment') : all;
  const kindCount = {};
  (r.phases || []).forEach(p => { kindCount[p.kind] = (kindCount[p.kind] || 0) + 1; });
  next.slice(0, NEXT_MAX).forEach(x => el.appendChild(nextLineEl(r, x, kindCount)));
  if (next.length > NEXT_MAX) el.appendChild(mk('div', 'nx-more', 'ほか ' + (next.length - NEXT_MAX) + '件'));

  const badges = mk('div', 'badges');
  if (r.open_requests > 0) badges.appendChild(mk('span', 'bdg alert', '未対応の依頼 ' + r.open_requests));
  badges.appendChild(Icon.prepend(mk('span', 'bdg', (r.timeline_count || 0) + '件'), 'chat', 12));
  el.appendChild(badges);

  return el;
}

// 「[調査] 次: ● 10/20 9:00 調査に行く」（● は自社の番＝赤・相手待ち＝琥珀の小さな丸）。同じ種類が複数あれば何回目、作業担当者が案件の担当者と違えば名前を添える
function nextLineEl(r, x, kindCount) {
  const nx = mk('div', 'nx-line' + (x.late ? ' late' : ''));
  nx.dataset.phase = x.phaseId || '';
  nx.dataset.ball = x.ball;
  const k = PhaseLogic.KINDS.find(z => z.key === x.kind);
  nx.appendChild(mk('span', 'ph-kind k-' + x.kind, (k ? k.short : '') + (kindCount[x.kind] > 1 ? ' ' + x.seq + '回目' : '')));
  const nt = mk('span', 'nx-text', '次: ');
  nt.append(Icon.dot(x.ball, x.ball === 'them' ? '相手待ち' : '自社の番'), PhaseLogic.nextText(x));
  nx.appendChild(nt);
  if (x.ball === 'us' && x.workerId && x.workerId !== r.assignee_id && x.workerName) {
    nx.appendChild(Icon.prepend(mk('span', 'who-pill', x.workerName), 'user', 12));
  }
  return nx;
}

// ---- モーダル ----
// 依頼元: 元請は元請マスタ（clients）から選ぶ（その場で「＋ 新しい元請」も追加できる）。物件オーナー・入居者は案件の列。
// 保存時に cases.client_id と、互換の client_name / client_email を選んだマスタの値で更新する
const CM_LEGACY = '__legacy__'; // 元請マスタに紐付いていない旧データ（client_name だけの案件）。選んだままなら元請は変えない
let caseModalClients = [];       // 元請マスタ（名前順）。読み込めなかったら []
let caseModalClientsOk = false;  // 元請マスタを読み込めたか
let caseModalClientTouched = false;
let caseModalNewBusy = false;    // 「追加して選ぶ」の保存中
const CM_PARTY = [
  ['owner_name', 'cm-owner-name'], ['owner_email', 'cm-owner-email'], ['owner_tel', 'cm-owner-tel'],
  ['resident_name', 'cm-res-name'], ['resident_email', 'cm-res-email'], ['resident_tel', 'cm-res-tel']
];
const CM_NEW_IDS = ['cm-nc-name', 'cm-nc-contact', 'cm-nc-email'];

// force=true は保存中でも閉じる（画面遷移時）
function closeCaseModal(force) {
  if (caseModalBusy && !force) return;
  caseModalSeq++;
  setCaseModalBusy(false); // 強制クローズ時、進行中の保存はもう何も触らない
  caseModalNewBusy = false;
  closeNewClient();
  $('case-modal').hidden = true;
  caseModalRow = null;
  caseModalOnSaved = null;
}

function setCaseModalBusy(busy) {
  caseModalBusy = busy;
  $('cm-cancel').disabled = busy;
  $('cm-close').disabled = busy;
}

// 元請の選択肢を作り直す。want = 選びたい値（'' / client_id / CM_LEGACY）
function fillClientOptions(want) {
  const sel = $('cm-client');
  const row = caseModalRow;
  sel.replaceChildren(new Option('未選択', ''));
  caseModalClients.forEach(k => sel.appendChild(new Option(k.name, k.id)));
  if (row && row.client_id && !caseModalClients.some(k => k.id === row.client_id)) {
    // 一覧に無い（読み込み失敗など）。今の元請を保持する選択肢を足す（選んだままなら元請は変えない）
    sel.appendChild(new Option((row.client_master_name || row.client_name || '元請') + '（現在の元請）', row.client_id));
  }
  if (row && !row.client_id && row.client_name) {
    sel.appendChild(new Option(row.client_name + '（元請マスタに未登録）', CM_LEGACY));
  }
  sel.value = want;
  if (sel.value !== want) sel.value = '';
  renderClientInfo();
}

function renderClientInfo() {
  const v = $('cm-client').value;
  const info = $('cm-client-info');
  const k = caseModalClients.find(x => x.id === v);
  if (k) {
    const sub = typeof clientSubText === 'function' ? clientSubText(k) : (k.email || '');
    const mode = ClientsApi.BILLING_LABEL[k.billing_mode === 'monthly' ? 'monthly' : 'single'];
    info.textContent = (sub ? sub + ' ・ ' : '') + '請求: ' + mode + (k.email ? '' : ' ・ メール未登録');
  } else if (v === CM_LEGACY) {
    info.textContent = '元請マスタに未登録の元請です（このままでも保存できます）。「＋ 新しい元請」で登録すると、請求のしかたも使えます';
  } else {
    info.textContent = '';
  }
}

function openNewClient() {
  if (caseModalBusy || caseModalNewBusy || !caseModalClientsOk) return;
  const box = $('cm-client-new');
  setMsg('cm-nc-msg', '');
  if (box.hidden && CM_NEW_IDS.every(id => !$(id).value)) {
    // 旧データ（マスタ未登録）を選んでいるなら、その名前とメールを下書きに入れる
    const row = caseModalRow;
    if ($('cm-client').value === CM_LEGACY && row) {
      $('cm-nc-name').value = row.client_name || '';
      $('cm-nc-email').value = row.client_email || '';
    }
  }
  box.hidden = false;
  $('cm-client-add').disabled = true;
  $('cm-nc-name').focus();
}

function closeNewClient() {
  $('cm-client-new').hidden = true;
  CM_NEW_IDS.forEach(id => { $(id).value = ''; });
  $('cm-nc-mode').value = 'single';
  setMsg('cm-nc-msg', '');
  $('cm-client-add').disabled = !caseModalClientsOk;
  $('cm-nc-save').disabled = false;
  $('cm-nc-cancel').disabled = false;
}

// 「追加して選ぶ」: 元請マスタに登録して、この案件の元請に選ぶ（ほかの入力はそのまま）
async function saveNewClient() {
  setMsg('cm-nc-msg', '');
  if (caseModalNewBusy || caseModalBusy) return;
  const r = ClientsApi.clean({
    name: $('cm-nc-name').value, contact_name: $('cm-nc-contact').value,
    email: $('cm-nc-email').value, billing_mode: $('cm-nc-mode').value
  });
  if (r.error) { setMsg('cm-nc-msg', r.error); return; }
  const same = caseModalClients.find(k => ClientsApi.sameName(k.name, r.fields.name));
  if (same) {
    caseModalClientTouched = true;
    closeNewClient();
    fillClientOptions(same.id);
    setMsg('cm-msg', '同じ名前の元請「' + same.name + '」が元請マスタにあったので、それを選びました', true);
    return;
  }
  const seq = caseModalSeq;
  caseModalNewBusy = true;
  $('cm-nc-save').disabled = true;
  $('cm-nc-cancel').disabled = true;
  $('cm-save').disabled = true;
  let made = null, errMsg = '';
  try { made = await ClientsApi.create(r.fields); }
  catch (e) { errMsg = '元請を追加できませんでした: ' + (e && e.message ? e.message : e); }
  if (seq !== caseModalSeq) return; // 閉じられた/開き直された（登録自体は済んでいる場合がある）
  caseModalNewBusy = false;
  $('cm-save').disabled = false;
  $('cm-nc-save').disabled = false;
  $('cm-nc-cancel').disabled = false;
  if (errMsg) { setMsg('cm-nc-msg', errMsg); return; }
  caseModalClients = caseModalClients.concat([made]).sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja'));
  caseModalClientTouched = true;
  closeNewClient();
  fillClientOptions(made.id);
  setMsg('cm-msg', '元請「' + made.name + '」を元請マスタに追加して選びました', true);
}

// opts.focus === 'parties' … 案件詳細の「依頼元を編集」から開いたとき（依頼元の欄へ移る）
async function openCaseModal(row, onSaved, opts) {
  const seq = ++caseModalSeq;
  caseModalRow = row || null;
  caseModalOnSaved = onSaved || null;
  setCaseModalBusy(false);
  caseModalAssigneeTouched = false;
  caseModalClientTouched = false;
  caseModalNewBusy = false;
  caseModalClients = [];
  caseModalClientsOk = false;
  setMsg('cm-msg', '');
  $('cm-title').textContent = row ? '案件を編集' : '新規案件';
  $('cm-save').textContent = row ? '保存する' : '作成する';
  $('cm-name').value = row ? row.name || '' : '';
  $('cm-due').value = row ? row.due_date || '' : '';
  $('cm-address').value = row ? row.address || '' : '';
  $('cm-room').value = row ? row.room || '' : '';
  CM_PARTY.forEach(([col, id]) => { $(id).value = row ? row[col] || '' : ''; });
  closeNewClient();
  const wantClient = row ? (row.client_id || (row.client_name ? CM_LEGACY : '')) : '';
  fillClientOptions(wantClient);
  $('cm-client-add').disabled = true; // 元請マスタが揃うまで追加させない（同じ名前の確認ができないため）

  const sel = $('cm-assignee');
  const want = row ? row.assignee_id || '' : ctx.user.id;
  sel.replaceChildren(new Option('未設定', ''));
  sel.value = '';
  $('cm-save').disabled = true; // 担当者・元請の一覧が揃うまで保存させない（担当や元請が黙って消えるのを防ぐ）
  $('case-modal').hidden = false;
  if (opts && opts.focus === 'parties') {
    $('cm-client').focus();
    $('cm-parties').scrollIntoView({ block: 'start' });
  } else {
    $('cm-name').focus();
  }
  const [mr, cr] = await Promise.allSettled([CasesApi.listMembers(), ClientsApi.list()]);
  if (seq !== caseModalSeq) return; // 閉じられた/開き直された
  const errs = [];
  const members = mr.status === 'fulfilled' ? mr.value : null;
  if (mr.status !== 'fulfilled') errs.push('担当者一覧の読み込みに失敗しました: ' + (mr.reason && mr.reason.message ? mr.reason.message : mr.reason));
  if (cr.status === 'fulfilled') {
    caseModalClients = cr.value || [];
    caseModalClientsOk = true;
  } else {
    errs.push('元請マスタの読み込みに失敗しました（元請は今のまま保存されます）: ' + (cr.reason && cr.reason.message ? cr.reason.message : cr.reason));
  }
  const selfLabel = (ctx.membership && ctx.membership.display_name ? ctx.membership.display_name : '自分') + '（自分）';
  (members || []).forEach(m => {
    const label = (m.display_name || '(名前なし)') + (m.user_id === ctx.user.id ? '（自分）' : '') + memberTel(m);
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
  fillClientOptions(caseModalClientTouched ? $('cm-client').value : wantClient);
  $('cm-client-add').disabled = !caseModalClientsOk || !$('cm-client-new').hidden;
  if (errs.length) setMsg('cm-msg', errs.join(' / '));
  $('cm-save').disabled = false;
}

// 元請の選択 → 保存する列。undefined = 元請の列は送らない（今のまま）
function clientFieldsOf(value) {
  const row = caseModalRow;
  if (value === '') return { client_id: null, client_name: null, client_email: null };
  const k = caseModalClients.find(x => x.id === value);
  if (k) return { client_id: k.id, client_name: k.name, client_email: k.email || null };
  if (value === CM_LEGACY) return undefined;
  if (row && value === row.client_id) return undefined; // マスタを読めなかった（今の元請のまま）
  return undefined;
}

async function saveCaseModal() {
  setMsg('cm-msg', '');
  if (caseModalBusy || caseModalNewBusy) return;
  const name = $('cm-name').value.trim();
  if (!name) { setMsg('cm-msg', '物件名・現場名を入力してください'); return; }
  if (!$('cm-client-new').hidden) {
    if (CM_NEW_IDS.every(id => !$(id).value.trim())) closeNewClient();
    else {
      setMsg('cm-msg', '新しい元請の入力中です。「追加して選ぶ」か「やめる」を押してから保存してください');
      return;
    }
  }
  const party = {};
  for (const [col, id] of CM_PARTY) party[col] = $(id).value.trim() || null;
  const badEmail = [['owner_email', '物件オーナー'], ['resident_email', '入居者']].find(([col]) =>
    party[col] && !ClientsApi.validEmail(party[col]));
  if (badEmail) {
    setMsg('cm-msg', badEmail[1] + 'のメールアドレスの形式が正しくありません');
    $(CM_PARTY.find(x => x[0] === badEmail[0])[1]).focus();
    return;
  }
  const fields = {
    name,
    due_date: $('cm-due').value || null,
    assignee_id: $('cm-assignee').value || null,
    address: $('cm-address').value.trim() || null,
    room: $('cm-room').value.trim() || null, // 号室（migration 025）
    ...party,
    ...(clientFieldsOf($('cm-client').value) || {})
  };
  const row = caseModalRow;
  const cb = caseModalOnSaved;
  const seq = caseModalSeq;
  const idleLabel = row ? '保存する' : '作成する';
  setCaseModalBusy(true);
  $('cm-save').disabled = true;
  $('cm-client-add').disabled = true;
  $('cm-save').textContent = '保存中…';
  let created = null;
  let errMsg = '';
  try {
    if (row) await CasesApi.updateCase(row.id, fields, row);
    else created = await CasesApi.createCase(fields);
  } catch (e) {
    errMsg = '保存できませんでした: ' + (e && e.message ? e.message : e);
  }
  // 強制クローズ（画面遷移）や別モーダルの表示で世代が変わっていたら、UIにも画面遷移にも一切触れない。
  // 保存自体は成功している場合があり、一覧は次回表示で反映される
  if (seq !== caseModalSeq) return;
  setCaseModalBusy(false);
  $('cm-save').disabled = false;
  $('cm-client-add').disabled = !caseModalClientsOk;
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
  $('cm-client').addEventListener('change', () => { caseModalClientTouched = true; setMsg('cm-msg', ''); renderClientInfo(); });
  $('cm-client-add').addEventListener('click', openNewClient);
  $('cm-nc-cancel').addEventListener('click', closeNewClient);
  $('cm-nc-save').addEventListener('click', saveNewClient);
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
