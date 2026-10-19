// js/case-rooms-api.js — 関係する部屋（case_rooms。migration 030 / 対応フェーズ Task 12）の DB アクセスと入力チェック
// 依頼元の部屋（cases.room / resident_*）とは別の部屋（上階の加害部屋など）を案件に登録する。
// DB の決まり: insert できる列は case_id / role / room / resident_name / email / tel / note / sort、
//   update できる列は role / room / resident_name / email / tel / note / sort（org_id・created_by は DB の既定値）。
//   RLS は会社一致。delete 可。追加・変更・削除はタイムラインに記録する（失敗しても操作は成功扱い）
// 依存: sb, ClientsApi.validEmail, PhaseLogic（役割の名前）
const CaseRoomsApi = (() => {
  const must = ({ data, error }) => { if (error) throw error; return data; };
  const INSERT_COLS = ['case_id', 'role', 'room', 'resident_name', 'email', 'tel', 'note', 'sort'];
  const UPDATE_COLS = ['role', 'room', 'resident_name', 'email', 'tel', 'note', 'sort'];
  const ROLES = ['cause', 'damage', 'other'];
  // DB の check と同じ上限（文字数）
  const MAX = { room: 40, resident_name: 100, email: 254, tel: 40, note: 500 };
  const SEL = 'id, case_id, role, room, resident_name, email, tel, note, sort, created_at, updated_at';
  const pick = (obj, cols) => {
    const out = {};
    for (const k of cols) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    return out;
  };
  const len = s => Array.from(String(s || '')).length;
  const norm = s => String(s == null ? '' : s).trim();
  const orNull = s => (norm(s) ? norm(s) : null);
  const title = r => (window.PhaseLogic ? PhaseLogic.roomTitle(r) : norm(r && r.room));

  // 画面の入力 → 保存する値。{ fields } か { error }（平易な文言）
  function clean(f) {
    const x = f || {};
    const fields = {
      role: ROLES.includes(x.role) ? x.role : 'cause',
      room: norm(x.room),
      resident_name: orNull(x.resident_name),
      email: orNull(x.email),
      tel: orNull(x.tel),
      note: orNull(x.note)
    };
    if (!fields.room) return { error: '号室を入れてください' };
    if (len(fields.room) > MAX.room) return { error: '号室は' + MAX.room + '文字までです' };
    if (fields.resident_name && len(fields.resident_name) > MAX.resident_name) return { error: '居住者名は' + MAX.resident_name + '文字までです' };
    if (fields.email && (len(fields.email) > MAX.email || !ClientsApi.validEmail(fields.email))) return { error: 'メールアドレスの形式が正しくありません' };
    if (fields.tel && len(fields.tel) > MAX.tel) return { error: '電話は' + MAX.tel + '文字までです' };
    if (fields.note && len(fields.note) > MAX.note) return { error: 'メモは' + MAX.note + '文字までです' };
    return { fields };
  }
  async function logSystem(caseId, body) {
    try { must(await sb.from('timeline_entries').insert({ case_id: caseId, type: 'system', body })); }
    catch (e) { console.warn('自動記録に失敗', e); }
  }

  return {
    MAX, ROLES, clean,
    async list(caseId) {
      return must(await sb.from('case_rooms').select(SEL).eq('case_id', caseId).order('sort').order('created_at').order('id')) || [];
    },
    // 追加（並びは今ある部屋の後ろ）
    async create(caseId, input, existing) {
      const c = clean(input);
      if (c.error) throw new Error(c.error);
      const sort = Math.min(1000000, (existing || []).reduce((m, r) => Math.max(m, Number(r.sort) || 0), -1) + 1);
      const row = pick({ case_id: caseId, ...c.fields, sort }, INSERT_COLS);
      const made = must(await sb.from('case_rooms').insert(row).select(SEL).single());
      await logSystem(caseId, `関係する部屋を追加した（${title(made)}）`);
      return made;
    },
    async update(cur, input) {
      const c = clean(input);
      if (c.error) throw new Error(c.error);
      const rows = must(await sb.from('case_rooms').update(pick(c.fields, UPDATE_COLS)).eq('id', cur.id).select(SEL));
      if (!rows || !rows.length) throw new Error('この部屋は見つかりません（ほかの人が消した可能性があります）');
      await logSystem(rows[0].case_id, `関係する部屋を変更した（${title(rows[0])}）`);
      return rows[0];
    },
    // cur: 部屋の行（case_summaries.rooms の要素は case_id を持たないので caseId を別に渡す）
    async remove(cur, caseId) {
      const rows = must(await sb.from('case_rooms').delete().eq('id', cur.id).select('id, case_id'));
      if (!rows || !rows.length) throw new Error('この部屋は見つかりません（ほかの人が消した可能性があります）');
      await logSystem(caseId || cur.case_id || rows[0].case_id, `関係する部屋を削除した（${title(cur)}）`);
    }
  };
})();
window.CaseRoomsApi = CaseRoomsApi;
