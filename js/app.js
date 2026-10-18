// js/app.js
let ctx = null;
let recoveryMode = location.hash.includes('type=recovery');

function $(id) { return document.getElementById(id); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + id));
  window.scrollTo(0, 0);
}

function inviteTokenFromHash() {
  const m = location.hash.match(/invite=([a-f0-9]+)/);
  return m ? m[1] : null;
}

function clearInviteHash() {
  if (inviteTokenFromHash()) history.replaceState(null, '', location.pathname + location.search);
}

function resetSignupMode() {
  $('signup-company-row').style.display = '';
  $('signup-company').required = true;
  $('signup-invite-token').value = '';
  $('signup-lead').textContent = '会社を登録して使い始めます（この会社が課金・データ隔離の単位になります）';
}

function setMsg(id, text, ok) {
  const el = $(id);
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
}

function prepareSignupForInvite(token) {
  $('signup-company-row').style.display = 'none';
  $('signup-company').required = false;
  $('signup-invite-token').value = token;
  $('signup-lead').textContent = '招待を受けたスタッフの登録';
}

// ---- 描画（Task 7/8 が拡張・置換する） ----
function renderHeaders() {
  const orgName = ctx && ctx.org ? ctx.org.name : '';
  const userName = ctx && ctx.membership ? ctx.membership.display_name : '';
  document.querySelectorAll('.js-org-name').forEach(e => { e.textContent = orgName; });
  document.querySelectorAll('.js-user-name').forEach(e => { e.textContent = userName; });
}
async function renderSettings() {
  renderHeaders();
  if (!ctx) return;
  const o = ctx.org;
  const isOwner = ctx.membership.role === 'owner';
  $('set-name').value = o.name || '';
  $('set-address').value = o.address || '';
  $('set-tel').value = o.tel || '';
  $('set-email').value = o.email || '';
  $('set-reg').value = o.registration_number || '';
  $('set-save').disabled = !isOwner;
  $('set-logo-btn').disabled = !isOwner;
  $('invite-btn').disabled = !isOwner;
  $('invite-email').disabled = !isOwner;
  $('card-staff').hidden = !isOwner;
  ['set-name', 'set-address', 'set-tel', 'set-email', 'set-reg'].forEach(id => { $(id).readOnly = !isOwner; });
  const img = $('set-logo-img');
  if (o.logo_path) {
    try {
      img.src = await AppStorage.getUrl(o.logo_path);
      img.hidden = false;
      $('set-logo-ph').hidden = true;
    } catch (e) {
      img.hidden = true;
      $('set-logo-ph').hidden = false;
      setMsg('set-msg', 'ロゴの読み込みに失敗しました: ' + e.message);
    }
  } else {
    img.hidden = true;
    $('set-logo-ph').hidden = false;
  }
}

let setMsgTimer = null;
function flashOk(id, text) {
  setMsg(id, text, true);
  clearTimeout(setMsgTimer);
  setMsgTimer = setTimeout(() => setMsg(id, ''), 2000);
}

// インボイス登録番号: 全角→半角・小文字t→T・空白/ハイフン除去。空は null（DB: '^T[0-9]{13}$' か null）
function normRegNo(v) {
  const t = String(v || '').replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\-－ー‐−]/g, '').replace(/^t/, 'T');
  return t || null;
}

async function saveSettings() {
  const fields = {
    name: $('set-name').value.trim(),
    address: $('set-address').value.trim(),
    tel: $('set-tel').value.trim(),
    email: $('set-email').value.trim() || null,
    registration_number: normRegNo($('set-reg').value)
  };
  if (!fields.name) throw new Error('会社名を入力してください');
  if (fields.registration_number && !/^T[0-9]{13}$/.test(fields.registration_number)) {
    throw new Error('登録番号（インボイス）は「T」と13桁の数字で入力してください（例: T1234567890123）');
  }
  if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) throw new Error('メールアドレスの形式が正しくありません');
  const { error } = await sb.from('orgs').update(fields).eq('id', ctx.org.id);
  if (error) throw error;
  Object.assign(ctx.org, fields);
  $('set-reg').value = fields.registration_number || ''; // 正規化後（半角 T+13桁）の値に表示を更新
  renderHeaders();
}

const LOGO_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

async function uploadLogo(file) {
  const ext = LOGO_EXT[file.type];
  if (!ext) throw new Error('PNG/JPG/WebP画像のみアップロードできます');
  if (file.size > 2 * 1024 * 1024) throw new Error('ロゴは2MB以内にしてください');
  const oldPath = ctx.org.logo_path || null;
  const oldSize = oldPath ? await AppStorage.sizeOf(oldPath) : 0; // アップ前に取得
  const delta = file.size - oldSize;
  if (delta > 0) {
    const q = await checkQuota(delta);
    if (!q.ok) throw new Error(q.reason);
  }
  const path = `${ctx.org.id}/settings/logo/logo.${ext}`;
  await AppStorage.upload(path, file, { contentType: file.type });
  const { error } = await sb.from('orgs').update({ logo_path: path }).eq('id', ctx.org.id);
  if (error) throw error;
  if (oldPath && oldPath !== path) {
    try { await AppStorage.remove(oldPath); }
    catch (e) { console.warn('旧ロゴの削除に失敗', e); }
  }
  if (delta !== 0) await addUsage(delta);
  ctx.org.logo_path = path;
  await renderSettings();
}

async function createInvite(email) {
  const token = CryptoUtil.uuid().replaceAll('-', '');
  const expires = new Date(Date.now() + 7 * 86400e3).toISOString();
  const { error } = await sb.from('invites').insert({
    org_id: ctx.org.id, email, token, expires_at: expires
  });
  if (error) throw error;
  return `${location.origin}${location.pathname}#signup?invite=${token}`;
}

function resetInviteResult() {
  $('invite-result').hidden = true;
  $('invite-link').value = '';
  setMsg('invite-msg', '');
}

async function onInviteClick() {
  setMsg('invite-msg', '');
  $('invite-result').hidden = true;
  if (!ctx || ctx.membership.role !== 'owner') { setMsg('invite-msg', '招待できるのはオーナーのみです'); return; }
  const email = $('invite-email').value.trim();
  if (!email || !$('invite-email').checkValidity()) { setMsg('invite-msg', '有効なメールアドレスを入力してください'); return; }
  try {
    const url = await createInvite(email);
    $('invite-link').value = url;
    const subject = encodeURIComponent('現場ドキュメントへの招待');
    const body = encodeURIComponent('現場ドキュメントに招待されました。以下のリンクから登録してください。\n' + url);
    $('invite-mailto').href = `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${body}`;
    $('invite-result').hidden = false;
    flashOk('invite-msg', 'リンクを発行しました');
  } catch (e) {
    setMsg('invite-msg', '招待リンクを発行できませんでした: ' + (e && e.message ? e.message : e));
  }
}

async function onInviteCopy() {
  const input = $('invite-link');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch (e) {
    input.select();
    document.execCommand && document.execCommand('copy');
  }
  flashOk('invite-msg', 'コピーしました');
}

function openSettings() {
  resetInviteResult();
  typeof renderSettings === 'function' && renderSettings();
  showScreen('settings');
  if (typeof openClientsCard === 'function') openClientsCard(); // 元請マスタ（js/clients-ui.js。社内の誰でも編集できる）
}

const UUID_RE = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const CASE_HASH_RE = new RegExp('^#case/' + UUID_RE + '$', 'i');
const CASE_REPORTS_HASH_RE = new RegExp('^#case/' + UUID_RE + '/reports$', 'i');
const CASE_SHARE_HASH_RE = new RegExp('^#case/' + UUID_RE + '/share$', 'i');
const REPORT_HASH_RE = new RegExp('^#report/' + UUID_RE + '$', 'i');
const MAIL_HASH_RE = new RegExp('^#mail/' + UUID_RE + '$', 'i');
const CASE_NOTICES_HASH_RE = new RegExp('^#case/' + UUID_RE + '/notices$', 'i');
const REPORT_PDF_HASH_RE = new RegExp('^#report/' + UUID_RE + '/pdf$', 'i');
function routeFromHash() {
  const h = location.hash;
  let m;
  if ((m = h.match(CASE_HASH_RE))) openCase(m[1]);
  else if ((m = h.match(CASE_REPORTS_HASH_RE))) openReports(m[1]);      // ⑤ 案件内の報告書一覧（js/report-ui.js）
  else if ((m = h.match(CASE_SHARE_HASH_RE)) && typeof openShareScreen === 'function') openShareScreen(m[1]); // ⑦ 協力業者URLの発行
  else if ((m = h.match(MAIL_HASH_RE)) && typeof openMailDraft === 'function') openMailDraft(m[1]); // ⑨ 送付メールの下書き（js/mail-ui.js）
  else if ((m = h.match(CASE_NOTICES_HASH_RE)) && typeof openNotices === 'function') openNotices(m[1].toLowerCase()); // ⑪ 案件内の工事掲示一覧（js/notice-ui.js）
  else if ((m = h.match(NOTICE_HASH_RE)) && typeof openNotice === 'function') openNotice(m[1].toLowerCase());       // ⑫ 工事掲示の作成・編集（js/notice-edit.js。NOTICE_HASH_RE もそこで定義）
  else if ((m = h.match(ESTIMATES_HASH_RE)) && typeof openEstimates === 'function') openEstimates(m[1].toLowerCase());     // ⑬ 案件内の見積書一覧（js/estimate-ui.js。*_HASH_RE もそこで定義）
  else if ((m = h.match(ESTIMATE_PDF_HASH_RE)) && typeof openEstimatePdf === 'function') openEstimatePdf(m[1].toLowerCase()); // ⑮ 見積書のPDFプレビュー
  else if ((m = h.match(ESTIMATE_DIFF_HASH_RE)) && typeof openEstimateDiff === 'function') openEstimateDiff(m[1].toLowerCase()); // ⑯ 見積書の版の差分
  else if ((m = h.match(ESTIMATE_HASH_RE)) && typeof openEstimate === 'function') openEstimate(m[1].toLowerCase());          // ⑭ 見積書の作成・編集
  else if ((m = h.match(REPORT_PDF_HASH_RE))) openReportPdf(m[1]);      // ⑩ PDFプレビュー
  else if ((m = h.match(REPORT_HASH_RE))) openReport(m[1]);             // ⑥ 報告書の入力
  else if (h === '#team') openTeam();
  else if (h === '#outbox' && typeof openOutbox === 'function') openOutbox(); // 送るメール（js/outbox-ui.js）
  else if (h === '#billing' && typeof openBilling === 'function') openBilling(); // 請求の一覧（js/billing-ui.js）
  else openCases();
}

async function boot() {
  ctx = await getMyContext();
  if (recoveryMode) { showScreen('newpw'); return; }
  if (ctx) { clearInviteHash(); routeFromHash(); return; }
  const token = inviteTokenFromHash();
  if (token) { prepareSignupForInvite(token); showScreen('signup'); return; }
  showScreen('login');
}

// パスワード再設定メールのリンクで戻ってきた場合
sb.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') { recoveryMode = true; showScreen('newpw'); }
});

// ---- フォーム ----
async function withBusy(btn, fn) {
  btn.disabled = true;
  try { await fn(); } finally { btn.disabled = false; }
}

function bindForms() {
  $('login-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    setMsg('login-err', '');
    await withBusy($('login-btn'), async () => {
      try {
        await signIn($('login-email').value.trim(), $('login-pw').value);
        await boot();
      } catch (e) { setMsg('login-err', e.message); }
    });
  });

  $('signup-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    setMsg('signup-err', '');
    await withBusy($('signup-btn'), async () => {
      try {
        const email = $('signup-email').value.trim();
        const pw = $('signup-pw').value;
        const name = $('signup-name').value.trim();
        const token = $('signup-invite-token').value;
        let data;
        if (token) data = await signUpInvited(email, pw, name, token);
        else data = await signUpOwner(email, pw, $('signup-company').value.trim(), name);
        if (data && data.session) {
          if (token) location.hash = '';
          await boot();
        } else {
          setMsg('signup-err', '確認メールを送りました。メール内のリンクを開いてからログインしてください。', true);
        }
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        setMsg('signup-err', msg.includes('Database error')
          ? '登録できませんでした（招待リンクが無効/期限切れの可能性）'
          : msg);
      }
    });
  });

  $('reset-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    setMsg('reset-msg', '');
    await withBusy($('reset-btn'), async () => {
      try {
        await resetPassword($('reset-email').value.trim());
        setMsg('reset-msg', '再設定用のメールを送りました。メールをご確認ください。', true);
      } catch (e) { setMsg('reset-msg', e.message); }
    });
  });

  $('newpw-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    setMsg('newpw-msg', '');
    await withBusy($('newpw-btn'), async () => {
      try {
        const pw = $('newpw-pw').value;
        if (pw.length < 8) throw new Error('パスワードは8文字以上にしてください');
        if (pw !== $('newpw-pw2').value) throw new Error('確認用パスワードが一致しません');
        const { error } = await sb.auth.updateUser({ password: pw });
        if (error) throw error;
        setMsg('newpw-msg', '変更しました', true);
        recoveryMode = false;
        history.replaceState(null, '', location.pathname + location.search);
        await boot();
      } catch (e) { setMsg('newpw-msg', e.message); }
    });
  });

  $('go-signup').addEventListener('click', ev => {
    ev.preventDefault();
    if (!inviteTokenFromHash()) resetSignupMode();
    showScreen('signup');
  });
  $('go-reset').addEventListener('click', ev => { ev.preventDefault(); showScreen('reset'); });
  document.querySelectorAll('.go-login').forEach(a =>
    a.addEventListener('click', ev => { ev.preventDefault(); clearInviteHash(); resetSignupMode(); showScreen('login'); }));
  document.querySelectorAll('.js-logout').forEach(b => b.addEventListener('click', signOutUser));
  document.querySelectorAll('.js-open-settings').forEach(b => b.addEventListener('click', openSettings));
  $('settings-back').addEventListener('click', openCases);
  bindCaseList();
  bindTeam();
  if (typeof bindOutbox === 'function') bindOutbox();
  if (typeof bindBilling === 'function') bindBilling();
  if (typeof bindClients === 'function') bindClients();

  $('set-save').addEventListener('click', () => withBusy($('set-save'), async () => {
    setMsg('set-msg', '');
    try { await saveSettings(); flashOk('set-msg', '保存しました'); }
    catch (e) { setMsg('set-msg', e.message); }
  }));
  $('invite-btn').addEventListener('click', () => withBusy($('invite-btn'), onInviteClick));
  $('invite-copy').addEventListener('click', onInviteCopy);
  $('set-logo-btn').addEventListener('click', () => $('set-logo-file').click());
  $('set-logo-file').addEventListener('change', async ev => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    setMsg('set-msg', '');
    await withBusy($('set-logo-btn'), async () => {
      try { await uploadLogo(file); flashOk('set-msg', 'ロゴを保存しました'); }
      catch (e) { setMsg('set-msg', e.message); }
    });
  });
}

window.addEventListener('hashchange', () => {
  if (!ctx || recoveryMode) return;
  closeCaseModal(true);
  routeFromHash();
});
document.addEventListener('DOMContentLoaded', () => { bindForms(); boot(); });
