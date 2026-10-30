// js/estimate-templates-api.js — 見積書のテンプレート（行のまとまり）の DB アクセス（Task 78 / migration 092 estimate_templates）
// DB の決まり: insert できる列は owner_user_id / name / lines / sort、update は name / sort だけ（中身の行は登録後に変えない）。
//   RLS は会社一致＋ owner_user_id: null = 会社共通（全員が読む・管理者だけが書く）、自分の id = 自分専用（本人だけ）＝ 068 と同じ
// 送る前に EstimateLogic.validateTemplate で DB と同じ判定をする（平易な文言で止める）。
// 依存: sb, window.EstimateLogic
const EstimateTemplatesApi = (() => {
  const must = ({ data, error }) => { if (error) throw error; return data; };
  const SEL = 'id, name, lines, sort, owner_user_id, created_at, updated_at';
  return {
    async list() {
      return must(await sb.from('estimate_templates').select(SEL).order('sort').order('created_at')) || [];
    },
    // t: { name, lines, sort, owner_user_id? }（自分専用なら自分の id、会社共通なら無し）
    async create(t) {
      const row = { name: String(t.name == null ? '' : t.name).trim(), lines: t.lines, sort: t.sort || 0 };
      if (t.owner_user_id) row.owner_user_id = t.owner_user_id;
      const v = window.EstimateLogic.validateTemplate(row);
      if (!v.ok) throw new Error(v.errors.join('・'));
      return must(await sb.from('estimate_templates').insert(row).select(SEL).single());
    },
    async rename(cur, name) {
      const n = String(name == null ? '' : name).trim();
      const v = window.EstimateLogic.validateTemplate({ name: n, lines: cur.lines });
      if (!v.ok) throw new Error(v.errors.join('・'));
      const rows = must(await sb.from('estimate_templates').update({ name: n }).eq('id', cur.id).select(SEL));
      if (!rows || !rows.length) throw new Error('このテンプレートは見つかりません（ほかの人が消した可能性があります）');
      return rows[0];
    },
    // 並び替え: [{ id, sort }]（EstimateLogic.movePreset の結果）
    async setSorts(changes) {
      for (const c of changes || []) must(await sb.from('estimate_templates').update({ sort: c.sort }).eq('id', c.id).select('id'));
    },
    async remove(id) {
      must(await sb.from('estimate_templates').delete().eq('id', id).select('id'));
    }
  };
})();
