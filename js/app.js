// js/app.js
let ctx = null;
let recoveryMode = location.hash.includes('type=recovery');
// メールのリンクが期限切れ・使用済みのとき、Supabase は #error=…&error_code=otp_expired を付けて戻す（Task 41）
let authLinkErr = /[#&]error(_code)?=/.test(location.hash);
const fromResetLink = /[?&]reset=1(&|$)/.test(location.search); // auth.js resetPassword の戻り先

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
  $('set-margin').value = o.default_margin_pct != null ? String(Number(o.default_margin_pct)) : ''; // 利益率の既定値（migration 036・Task 19）
  $('set-save').disabled = !isOwner;
  $('set-logo-btn').disabled = !isOwner;
  $('invite-btn').disabled = !isOwner;
  $('invite-email').disabled = !isOwner;
  $('card-staff').hidden = !isOwner;
  $('card-gcal').hidden = !isOwner; // Task 55: 作業担当者の Google カレンダー
  if (isOwner && typeof CalFeed !== 'undefined') CalFeed.renderMembers($('gcal-list'));
  ['set-name', 'set-address', 'set-tel', 'set-email', 'set-reg', 'set-margin'].forEach(id => { $(id).readOnly = !isOwner; });
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
  // 利益率の既定値（%）: 全角も読む。空は null（= 0%）
  const mt = String($('set-margin').value || '').replace(/[０-９．]/g, c => (c === '．' ? '.' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0))).replace(/[%％\s]/g, '');
  fields.default_margin_pct = mt === '' ? null : EstimateLogic.normMargin(mt);
  if (mt !== '' && fields.default_margin_pct === null) throw new Error('利益率の既定値は0〜999の数字で入力してください（例: 20）');
  const { error } = await sb.from('orgs').update(fields).eq('id', ctx.org.id);
  if (error) throw error;
  Object.assign(ctx.org, fields);
  $('set-reg').value = fields.registration_number || ''; // 正規化後（半角 T+13桁）の値に表示を更新
  $('set-margin').value = fields.default_margin_pct != null ? String(fields.default_margin_pct) : '';
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
  // 現場用の画面（Task 18）では ⚙️ は現場用の設定へ
  if (typeof fieldHidesAdmin === 'function' && fieldHidesAdmin()) { location.hash = '#f/settings'; return; }
  resetInviteResult();
  typeof renderSettings === 'function' && renderSettings();
  showScreen('settings');
  if (typeof openClientsCard === 'function') openClientsCard(); // 元請マスタ（js/clients-ui.js。社内の誰でも編集できる）
  if (typeof CaseTrash !== 'undefined') CaseTrash.renderCard(); // 削除した案件（管理者だけ。js/case-trash.js）
  // 画面: 現場用／管理画面（管理者だけ。js/field-ui.js）
  const old = $('card-view');
  if (old) old.remove();
  if (ctx && ctx.membership.role === 'owner' && typeof fieldViewCard === 'function') {
    $('card-company').before(fieldViewCard('card-view'));
  }
}

const UUID_RE = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const CASE_HASH_RE = new RegExp('^#case/' + UUID_RE + '$', 'i');
const CASE_REPORTS_HASH_RE = new RegExp('^#case/' + UUID_RE + '/reports$', 'i');
const CASE_SHARE_HASH_RE = new RegExp('^#case/' + UUID_RE + '/share$', 'i');
const REPORT_HASH_RE = new RegExp('^#report/' + UUID_RE + '$', 'i');
const MAIL_HASH_RE = new RegExp('^#mail/' + UUID_RE + '$', 'i');
const CASE_NOTICES_HASH_RE = new RegExp('^#case/' + UUID_RE + '/notices$', 'i');
const REPORT_PDF_HASH_RE = new RegExp('^#report/' + UUID_RE + '/pdf$', 'i');
const CASE_PHASE_HASH_RE = new RegExp('^#case/' + UUID_RE + '/phase/' + UUID_RE + '$', 'i');
function routeFromHash() {
  // 現場用の画面（#f…）と役割による入口（スタッフは現場用だけ。js/field-ui.js。Task 18）。true ならそこで開いた
  if (typeof fieldRoute === 'function' && fieldRoute()) return;
  const h = location.hash; // fieldRoute が書き換えることがあるので後で読む
  let m;
  if ((m = h.match(CASE_HASH_RE))) openCase(m[1]);
  else if ((m = h.match(CASE_PHASE_HASH_RE)) && typeof openCasePhase === 'function') openCasePhase(m[1], m[2]); // フェーズ詳細ページ（案件ページの「詳しく見る」・担当者への確認依頼のリンク。js/phase-detail.js）
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
  else if (h === '#calendar' && typeof openCalendar === 'function') openCalendar(); // カレンダー（js/calendar-ui.js。Task 38）
  else if (h === '#tasks' && typeof openTasks === 'function') openTasks(); // やること（js/tasks.js。Task 17）
  else if (h === '#outbox' && typeof openOutbox === 'function') openOutbox(); // 送るメール（js/outbox-ui.js）
  else if ((m = h.match(SM_HASH_RE)) && typeof openMessages === 'function') openMessages(m[1] || null); // 📨 現場からの連絡（js/staff-messages.js。Task 23）
  else if ((m = h.match(TALK_HASH_RE)) && typeof openTalkScreen === 'function') openTalkScreen(m[1] || null); // メッセージ（LINE 風のトーク。js/talk-ui.js。Task 46）
  else if (h === '#billing' && typeof openBilling === 'function') openBilling(); // 請求の一覧（js/billing-ui.js）
  else if (h === '#inbox-staff' && typeof openStaffInbox === 'function') openStaffInbox(); // 担当者の「確認してください」（js/staff-inbox.js）
  else openCases();
}

// ---- 画面に戻ったときに読み直す（Task 23 I7） ----
// タブが表に戻った（visibilitychange）・ウィンドウに戻った（focus）ときに、表示中の画面のデータを読み直す。
// 30秒以内の連続は1回。入力中（入力欄にフォーカス）・シートを開いているときは読み直さない（入力を失わないため）
const APP_RETURN_GAP = 30000;
let appReturnAt = 0;
let appAwayAt = 0; // 画面を離れた（タブが裏・ウィンドウから離れた）時刻。離れていないのに来た focus は無視する
function onAppAway() { appAwayAt = Date.now(); }
function onAppReturn() {
  if (document.visibilityState === 'hidden') { onAppAway(); return; }
  if (!ctx || !appAwayAt) return;
  appAwayAt = 0;
  const now = Date.now();
  if (now - appReturnAt < APP_RETURN_GAP) return;
  const ae = document.activeElement;
  if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
  if (document.querySelector('.modal-bg:not([hidden])')) return;
  appReturnAt = now;
  refreshActiveScreen();
}
function refreshActiveScreen() {
  const on = id => { const el = document.getElementById('screen-' + id); return !!el && el.classList.contains('active'); };
  try {
    if (on('case') && typeof caseDetailId !== 'undefined' && caseDetailId) {
      // 案件ページ: 見出し（今の状態・連絡の数）と対応フェーズの表・ツールの件数（同じ読み込み結果から数える）
      refreshPart('head').then(() => { if (typeof ph !== 'undefined' && ph && !ph.phaseId && typeof phLoad === 'function') phLoad(); });
    } else if (on('phase') && typeof ph !== 'undefined' && ph && typeof phLoad === 'function') {
      phLoad();
    } else if (on('field') && typeof fd !== 'undefined' && fd) {
      if (typeof fieldRowsInvalidate === 'function') fieldRowsInvalidate();
      if (fd.view === 'cases') fdLoadCases(fd.seq);
      else if (fd.view === 'case') fdLoadCase(fd.seq);
      else if (fd.view === 'tasks' && typeof si !== 'undefined' && si) siLoad(si.seq);
      else if (fd.view === 'daily' && !(fd.daily && fd.daily.busy)) fdLoadDaily(fd.seq); // Task 29（入力中の一言は残す）
      else if (fd.view === 'contact' && typeof sm !== 'undefined' && sm) smLoad(sm.seq);
      else if (fd.view === 'msg' && typeof talk !== 'undefined' && talk && !talk.busy) talkLoad(talk); // Task 46（入力中の文は残す）
    } else if (on('inbox-staff') && typeof si !== 'undefined' && si) {
      siLoad(si.seq);
    } else if (on('tasks') && typeof tk !== 'undefined' && tk) {
      tkLoad(tk.seq);
    } else if (on('messages') && typeof sm !== 'undefined' && sm) {
      smLoad(sm.seq);
    } else if (on('talk') && typeof talk !== 'undefined' && talk && !talk.busy) {
      talkLoad(talk);
    }
  } catch (e) { console.warn('画面の読み直しに失敗', e); }
}
document.addEventListener('visibilitychange', onAppReturn);
window.addEventListener('blur', onAppAway);
window.addEventListener('focus', onAppReturn);

async function boot() {
  ctx = await getMyContext();
  if (recoveryMode) { showScreen('newpw'); return; }
  if (authLinkErr) {
    authLinkErr = false;
    history.replaceState(null, '', location.pathname);
    if (!ctx) {
      if (fromResetLink) showReset('再設定のリンクの期限が切れているか、もう使われています。もう一度、再設定のメールを送ってください');
      else { showScreen('login'); setMsg('login-err', 'メールのリンクの期限が切れているか、もう使われています'); }
      return;
    }
  }
  if (ctx) {
    clearInviteHash(); routeFromHash();
    // Task 55: 開いたときに自分の Google カレンダーのファイルを作り直す（ほかの人の操作・報告書の提出で変わった分。使い始めていなければ何もしない）
    if (typeof CalFeed !== 'undefined') CalFeed.touch([ctx.user.id]);
    return;
  }
  const token = inviteTokenFromHash();
  if (token) { prepareSignupForInvite(token); showScreen('signup'); return; }
  showScreen('login');
}

// パスワード再設定メールのリンクで戻ってきた場合
sb.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') { recoveryMode = true; showScreen('newpw'); }
});

// ---- パスワードの再設定（Task 41） ----
// 登録の有無で文言を変えない（登録されているかを漏らさない）
const RESET_SENT = '登録されていれば、再設定のメールを送りました。届かないときは迷惑メールも確認してください';
const RESET_WAIT_SEC = 60; // 連打防止。Supabase も同じ人へは60秒に1通
const RESET_BTN = '再設定のメールを送る';
let resetTimer = null;
function showReset(msg) {
  recoveryMode = false;
  showScreen('reset');
  setMsg('reset-msg', msg || '');
}
function resetCooldown() {
  const btn = $('reset-btn');
  const until = Date.now() + RESET_WAIT_SEC * 1000;
  clearInterval(resetTimer);
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) { clearInterval(resetTimer); resetTimer = null; btn.disabled = false; btn.textContent = RESET_BTN; return; }
    btn.disabled = true;
    btn.textContent = `もう一度送れるまで ${left} 秒`;
  };
  tick();
  resetTimer = setInterval(tick, 1000);
}
async function onResetSubmit(ev) {
  ev.preventDefault();
  const btn = $('reset-btn');
  if (btn.disabled) return;
  const email = $('reset-email').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setMsg('reset-msg', 'メールアドレスを正しく入れてください'); return; }
  setMsg('reset-msg', '');
  btn.disabled = true;
  try {
    await resetPassword(email);
  } catch (e) {
    // 送りすぎ（429）は登録されている人にだけ起きるので、送れたときと同じ文言にする
    const tooMany = e && (e.status === 429 || /rate limit|security purposes/i.test(e.message || ''));
    if (!tooMany) { setMsg('reset-msg', '送れませんでした。通信を確かめて、もう一度お試しください'); btn.disabled = false; return; }
  }
  setMsg('reset-msg', RESET_SENT, true);
  resetCooldown();
}
async function onNewPwSubmit(ev) {
  ev.preventDefault();
  const pw = $('newpw-pw').value;
  if (pw.length < 8) { setMsg('newpw-msg', 'パスワードは8文字以上にしてください'); return; }
  if (pw !== $('newpw-pw2').value) { setMsg('newpw-msg', '2つのパスワードが同じではありません。もう一度入れてください'); return; }
  setMsg('newpw-msg', '');
  await withBusy($('newpw-btn'), async () => {
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) {
      const m = error.message || '';
      if (error.code === 'same_password' || /different from the old/i.test(m)) setMsg('newpw-msg', '今と同じパスワードです。別のパスワードにしてください');
      else if (error.code === 'weak_password' || /weak|at least/i.test(m)) setMsg('newpw-msg', 'このパスワードは使えません。もっと長く、推測されにくいものにしてください');
      else if (error.status === 401 || error.status === 403 || /session|expired|jwt/i.test(m)) showReset('再設定のリンクの期限が切れました。もう一度、再設定のメールを送ってください');
      else setMsg('newpw-msg', '変更できませんでした。通信を確かめて、もう一度お試しください');
      return;
    }
    $('newpw-pw').value = '';
    $('newpw-pw2').value = '';
    recoveryMode = false;
    history.replaceState(null, '', location.pathname); // #access_token… と ?reset=1 を消す
    await boot();
  });
}

// ---- フォーム ----
// 画面内の確認（confirm() の代わり。Task 23 M6）。host の中（先頭か末尾）に「文・やめる・okLabel」の欄を出し、押した方で true / false を返す。
//   同じ host に出ている前の確認は「やめる」扱いで閉じる。opts: { okLabel, cancelLabel, danger, prepend, id }
function askInline(host, text, opts) {
  const o = opts || {};
  return new Promise(resolve => {
    if (!host) { resolve(false); return; }
    const prev = host.querySelector(':scope > .inline-ask');
    if (prev && prev._resolve) prev._resolve(false);
    if (prev) prev.remove();
    const box = document.createElement('div');
    box.className = 'inline-ask';
    if (o.id) box.id = o.id;
    box.setAttribute('role', 'alertdialog');
    const t = document.createElement('div');
    t.className = 'inline-ask-t';
    t.textContent = text;
    const acts = document.createElement('div');
    acts.className = 'inline-ask-acts';
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn sm ghost inline inline-ask-no';
    no.textContent = o.cancelLabel || 'やめる';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn sm inline inline-ask-ok' + (o.danger ? ' red' : '');
    ok.textContent = o.okLabel || 'OK';
    const done = v => { box._resolve = null; box.remove(); resolve(v); };
    box._resolve = v => { box._resolve = null; resolve(v); };
    no.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    acts.append(no, ok);
    box.append(t, acts);
    if (o.prepend) host.insertBefore(box, host.firstChild); else host.appendChild(box);
    ok.focus({ preventScroll: true });
    if (box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
  });
}

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

  $('reset-form').addEventListener('submit', onResetSubmit);
  $('newpw-form').addEventListener('submit', onNewPwSubmit);

  $('go-signup').addEventListener('click', ev => {
    ev.preventDefault();
    if (!inviteTokenFromHash()) resetSignupMode();
    showScreen('signup');
  });
  $('go-reset').addEventListener('click', ev => {
    ev.preventDefault();
    if (!$('reset-email').value) $('reset-email').value = $('login-email').value.trim();
    showScreen('reset');
  });
  document.querySelectorAll('.go-login').forEach(a =>
    a.addEventListener('click', ev => { ev.preventDefault(); clearInviteHash(); resetSignupMode(); showScreen('login'); }));
  document.querySelectorAll('.js-logout').forEach(b => b.addEventListener('click', signOutUser));
  document.querySelectorAll('.js-open-settings').forEach(b => b.addEventListener('click', openSettings));
  $('settings-back').addEventListener('click', openCases);
  bindCaseList();
  bindTeam();
  if (typeof bindTasks === 'function') bindTasks();
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
