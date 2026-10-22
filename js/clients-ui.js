// js/clients-ui.js — 設定画面の「元請マスタ」（一覧・追加・編集。単発／月ごと）
// 社内の誰でも（オーナーでもスタッフでも）操作できる（ユーザー決定）。削除は無い。
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。alert / confirm は使わない
// mk() は case-list.js、$ / setMsg / flashOk / withBusy は app.js のものを使う
//
// app.js の openSettings から呼ばれる: openClientsCard()
let clRows = [];          // 元請マスタの行（名前順）
let clSeq = 0;            // 一覧の読み込み番号。古い応答を捨てる
let clEditId = undefined; // フォーム: undefined=閉 / null=追加 / id=その行の編集
let clLoadFailed = false;

const clErr = e => (e && e.message ? e.message : String(e));

// 「担当 田中様 ・ mail ・ tel」の1行（空なら ''）
function clientSubText(k) {
  const parts = [];
  if (k.contact_name) parts.push('担当 ' + k.contact_name + '様');
  if (k.email) parts.push(k.email);
  if (k.tel) parts.push(k.tel);
  return parts.join(' ・ ');
}

function clientModeTag(mode) {
  const m = mode === 'monthly' ? 'monthly' : 'single';
  return mk('span', 'pty-tag ' + m, ClientsApi.BILLING_LABEL[m]);
}

async function openClientsCard() {
  closeClientForm();
  setMsg('cl-msg', '');
  await loadClients();
}

async function loadClients() {
  const seq = ++clSeq;
  clLoadFailed = false;
  $('cl-list').replaceChildren(mk('div', 'cl-empty', '読み込み中…'));
  let rows = null, errMsg = '';
  try { rows = (await ClientsApi.list()) || []; }
  catch (e) { errMsg = '元請マスタの読み込みに失敗しました: ' + clErr(e); }
  if (seq !== clSeq) return;
  if (errMsg) {
    clRows = [];
    clLoadFailed = true;
    const b = mk('button', 'btn sm ghost inline', '再読み込み');
    b.type = 'button';
    b.addEventListener('click', loadClients);
    $('cl-list').replaceChildren(mk('div', 'err', errMsg), b);
    return;
  }
  clRows = rows;
  renderClients();
}

function renderClients() {
  const box = $('cl-list');
  if (clRows.length === 0) {
    box.replaceChildren(mk('div', 'cl-empty', 'まだ元請がありません。「＋ 元請を追加」から登録してください'));
    return;
  }
  box.replaceChildren(...clRows.map(k => {
    const row = mk('div', 'cl-row');
    row.dataset.id = k.id;
    const l = mk('div');
    const h = mk('div');
    h.appendChild(mk('b', null, k.name));
    h.appendChild(clientModeTag(k.billing_mode));
    l.appendChild(h);
    // 担当・メールは1行、電話はタップで発信できるリンク（36px 以上）
    const sub = clientSubText(Object.assign({}, k, { tel: null }));
    if (sub) l.appendChild(mk('div', 'cl-sub', sub));
    if (k.tel) {
      const a = Icon.prepend(mk('a', 'cl-tel', k.tel), 'phone', 14);
      a.href = 'tel:' + String(k.tel).replace(/[^0-9+]/g, '');
      l.appendChild(a);
    }
    if (k.memo) l.appendChild(mk('div', 'cl-memo', k.memo));
    const b = mk('button', 'linkbtn cl-edit', '編集');
    b.type = 'button';
    b.setAttribute('aria-label', k.name + ' を編集');
    b.addEventListener('click', () => openClientForm(k));
    row.append(l, b);
    return row;
  }));
}

function openClientForm(k) {
  clEditId = k ? k.id : null;
  setMsg('cl-msg', '');
  $('cl-form-ttl').textContent = k ? '元請を編集' : '元請を追加';
  $('cl-save').textContent = k ? '保存する' : '追加する';
  $('cl-name').value = k ? k.name || '' : '';
  $('cl-contact').value = k ? k.contact_name || '' : '';
  $('cl-email').value = k ? k.email || '' : '';
  $('cl-tel').value = k ? k.tel || '' : '';
  $('cl-memo').value = k ? k.memo || '' : '';
  const mode = k && k.billing_mode === 'monthly' ? 'monthly' : 'single';
  $('cl-mode-' + mode).checked = true;
  $('cl-form').hidden = false;
  $('cl-add-btn').hidden = true;
  $('cl-name').focus();
  $('cl-form').scrollIntoView({ block: 'nearest' });
}

function closeClientForm() {
  clEditId = undefined;
  $('cl-form').hidden = true;
  $('cl-add-btn').hidden = false;
}

async function saveClientForm() {
  setMsg('cl-msg', '');
  if (clEditId === undefined) return;
  const mode = $('cl-mode-monthly').checked ? 'monthly' : 'single';
  const r = ClientsApi.clean({
    name: $('cl-name').value, contact_name: $('cl-contact').value, email: $('cl-email').value,
    tel: $('cl-tel').value, billing_mode: mode, memo: $('cl-memo').value
  });
  if (r.error) { setMsg('cl-msg', r.error); return; }
  const editId = clEditId;
  if (clLoadFailed) { setMsg('cl-msg', '元請マスタを読み込めていません。再読み込みしてから保存してください'); return; }
  const dup = clRows.find(x => x.id !== editId && ClientsApi.sameName(x.name, r.fields.name));
  if (dup) { setMsg('cl-msg', '同じ名前の元請「' + dup.name + '」がすでにあります'); return; }
  const btns = [$('cl-save'), $('cl-cancel')];
  btns.forEach(b => { b.disabled = true; });
  try {
    if (editId) await ClientsApi.update(editId, r.fields);
    else await ClientsApi.create(r.fields);
  } catch (e) {
    btns.forEach(b => { b.disabled = false; });
    setMsg('cl-msg', '保存できませんでした: ' + clErr(e));
    return;
  }
  btns.forEach(b => { b.disabled = false; });
  closeClientForm();
  await loadClients();
  flashOk('cl-msg', editId ? '保存しました' : '追加しました');
}

function bindClients() {
  $('cl-add-btn').addEventListener('click', () => openClientForm(null));
  $('cl-cancel').addEventListener('click', () => { setMsg('cl-msg', ''); closeClientForm(); });
  $('cl-save').addEventListener('click', saveClientForm);
}
