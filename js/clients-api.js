// js/clients-api.js — 元請マスタ（clients。migration 020）のDBアクセスと入力チェック
// 管理会社＝元請。元請ごとに請求のしかた（単発／月ごと）を持つ。案件は cases.client_id で参照する。
// 社内の誰でも（オーナーでもスタッフでも）一覧・追加・編集できる。削除は無い（DB にも権限が無い）
const ClientsApi = (() => {
  const must = ({ data, error }) => { if (error) throw error; return data; };

  // DBの列権限（migration 020）: insert も update も列単位でこの6列だけ。
  // 許可外の列（created_by など）が1つでも入ると要求全体が拒否されるため入口で絞る
  const INSERT_COLS = ['name', 'contact_name', 'email', 'tel', 'billing_mode', 'memo'];
  const UPDATE_COLS = ['name', 'contact_name', 'email', 'tel', 'billing_mode', 'memo'];
  const pick = (obj, cols) => {
    const out = {};
    for (const k of cols) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    return out;
  };

  const BILLING_MODES = ['single', 'monthly'];
  const BILLING_LABEL = { single: '単発', monthly: '月ごと' };
  const BILLING_HINT = { single: '単発（案件ごとに請求）', monthly: '月ごと（1か月分をまとめて請求）' };
  // DB の check と同じ上限（文字数）
  const MAX = { name: 100, contact_name: 100, email: 254, tel: 40, memo: 2000 };

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const validEmail = s => EMAIL_RE.test(String(s || ''));
  const len = s => Array.from(String(s || '')).length;
  const norm = s => String(s == null ? '' : s).trim();
  // 同じ名前かどうか（前後の空白と全角/半角の空白の違いは無視）
  const sameName = (a, b) => norm(a).replace(/\s+/g, ' ') === norm(b).replace(/\s+/g, ' ');

  // 画面の入力 → 保存する値。{ fields } か { error }（平易な文言）を返す
  function clean(input) {
    const f = {
      name: norm(input.name),
      contact_name: norm(input.contact_name) || null,
      email: norm(input.email) || null,
      tel: norm(input.tel) || null,
      billing_mode: BILLING_MODES.includes(input.billing_mode) ? input.billing_mode : 'single',
      memo: norm(input.memo) || null
    };
    if (!f.name) return { error: '元請の名前を入力してください' };
    if (len(f.name) > MAX.name) return { error: `元請の名前は${MAX.name}文字以内にしてください` };
    if (f.contact_name && len(f.contact_name) > MAX.contact_name) return { error: `担当者名は${MAX.contact_name}文字以内にしてください` };
    if (f.email && (len(f.email) > MAX.email || !validEmail(f.email))) return { error: '元請のメールアドレスの形式が正しくありません' };
    if (f.tel && len(f.tel) > MAX.tel) return { error: `電話番号は${MAX.tel}文字以内にしてください` };
    if (f.memo && len(f.memo) > MAX.memo) return { error: `メモは${MAX.memo}文字以内にしてください` };
    return { fields: f };
  }

  return {
    INSERT_COLS, UPDATE_COLS, BILLING_MODES, BILLING_LABEL, BILLING_HINT, MAX,
    validEmail, sameName, clean,
    async list() { return must(await sb.from('clients').select('*').order('name')); },
    async get(id) { return must(await sb.from('clients').select('*').eq('id', id).maybeSingle()); },
    async create(fields) {
      return must(await sb.from('clients').insert(pick(fields, INSERT_COLS)).select().single());
    },
    async update(id, fields) {
      return must(await sb.from('clients').update(pick(fields, UPDATE_COLS)).eq('id', id).select().single());
    }
  };
})();
