// js/auth.js
async function signUpOwner(email, password, companyName, displayName) {
  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { data: { company_name: companyName, display_name: displayName } }
  });
  if (error) throw error;
  return data;
}

async function signUpInvited(email, password, displayName, inviteToken) {
  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { data: { display_name: displayName, invite_token: inviteToken } }
  });
  if (error) throw error;
  return data;
}

async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

// 共用端末に、署名URL・メール本文・報告書の入力が残らないように、端末に退避したデータを消す
function clearLocalDrafts() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    keys.filter(k => k && /^(mail-wait-|mail-draft-|report-draft-)/.test(k)).forEach(k => localStorage.removeItem(k));
  } catch (e) { /* localStorage が使えない環境では何もしない */ }
}

async function signOutUser() {
  try { await sb.auth.signOut(); }
  finally { clearLocalDrafts(); }
  location.hash = '#login';
  location.reload();
}

// 再設定メールのリンクの戻り先。?reset=1 で「再設定のリンクから来た」と分かる（#reset はメールのリンクが付ける #access_token… とぶつかるので使わない）
async function resetPassword(email) {
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: location.origin + location.pathname + '?reset=1'
  });
  if (error) throw error;
}

async function getMyContext() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data: m, error } = await sb.from('memberships')
    .select('user_id, org_id, display_name, role, phone, orgs(*)')
    .eq('user_id', user.id).single();
  if (error) return null;
  return { user, membership: m, org: m.orgs };
}
