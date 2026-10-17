// js/portals-api.js — お客様ページURL（case_portals）とお客様へのお知らせのDBアクセス（Supabase呼び出しはここに集約）
// DB: migration 018 / 019。
//   case_portals の insert は列単位の権限（case_id, audience, label, token）。org_id・created_by は既定値で入るので送らない。
//   update できるのは label と revoked_at だけ。取り消し（revoked_at）は一度入れたら戻せない（トリガーで例外）。
//   token は平文で保存（「URLをコピー」で何度も送り直すため。協力業者URLのハッシュ保存とは意図的に違う）
// お客様へのお知らせ = timeline_entries の type 'customer'。audiences（gc/pm/owner/resident を1つ以上）・文字のみ
const PortalsApi = (() => {
  const L = () => window.PortalLogic;
  const must = ({ data, error }) => { if (error) throw error; return data; };
  const now = () => new Date().toISOString();
  const COLS = 'id, case_id, audience, label, token, created_by, created_at, revoked_at, last_opened_at';

  // 32バイト乱数 → base64url（パディングなし・43文字）。協力業者URL（reports-api の newToken）と同じ作り方
  function newToken() {
    const c = window.crypto;
    if (!c || typeof c.getRandomValues !== 'function') throw new Error('この端末では乱数を作れません');
    const b = c.getRandomValues(new Uint8Array(32));
    let s = '';
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function cleanLabel(label) {
    const m = L().labelError(label);
    if (m) throw new Error(m);
    return String(label).trim();
  }

  return {
    // 案件のURL（取り消し済みも含む・新しい順）
    async list(caseId) {
      return must(await sb.from('case_portals').select(COLS).eq('case_id', caseId).order('created_at', { ascending: false }));
    },
    async issue(caseId, audience, label) {
      if (!L().isAudience(audience)) throw new Error('相手の種類を選んでください');
      const row = { case_id: caseId, audience, label: cleanLabel(label), token: newToken() };
      return must(await sb.from('case_portals').insert(row).select(COLS).single());
    },
    // 有効なものだけ取り消す。二度押し・別の画面で取り消し済みなら 0行 → 日本語で知らせる（DBの例外文言は出さない）
    async revoke(id) {
      const rows = must(await sb.from('case_portals').update({ revoked_at: now() })
        .eq('id', id).is('revoked_at', null).select('id'));
      if (!rows || rows.length === 0) throw new Error('取り消せませんでした（すでに取り消されている可能性があります）');
    },
    async rename(id, label) {
      const rows = must(await sb.from('case_portals').update({ label: cleanLabel(label) }).eq('id', id).select(COLS));
      if (!rows || rows.length === 0) throw new Error('宛名を変更できませんでした');
      return rows[0];
    },
    // 今のページ（index.html）と同じ階層の p.html#token
    urlOf(row) {
      return L().portalUrl(location.origin + location.pathname, row.token);
    },

    // お客様へのお知らせ（文字のみ）
    async addUpdate(caseId, body, audiences) {
      const text = String(body == null ? '' : body).trim();
      if (!text) throw new Error('お知らせの内容を入力してください');
      const keys = L().AUDIENCE_KEYS.filter(k => (audiences || []).includes(k));
      const m = L().audiencesError(keys);
      if (m) throw new Error(m);
      return must(await sb.from('timeline_entries')
        .insert({ case_id: caseId, type: 'customer', body: text, audiences: keys }).select().single());
    }
  };
})();
