// js/estimate-presets-api.js — 見積の「よく使う明細」（定型）の DB アクセス（migration 029 estimate_presets）
// DB の決まり: insert / update できる列は kind / label / line / sort だけ（org_id・created_by は DB の既定値）。
//   RLS は会社一致。line は {description, detail?, quantity, unit, amount, unitPrice?, postTax?:false}（029 の check）
// 送る前に EstimateLogic.validatePreset で DB と同じ判定をする（平易な文言で止める）。
// 依存: sb, window.EstimateLogic
const EstimatePresetsApi = (() => {
  const EL = () => window.EstimateLogic;
  const must = ({ data, error }) => { if (error) throw error; return data; };
  const COLS = ['kind', 'label', 'line', 'sort'];      // 列 grant と同じ allowlist
  const LINE_KEYS = ['description', 'detail', 'quantity', 'unit', 'amount', 'unitPrice', 'postTax'];
  const pick = (o, keys) => { const r = {}; keys.forEach(k => { if (o && o[k] !== undefined) r[k] = o[k]; }); return r; };
  function clean(p) {
    const row = pick(p, COLS);
    if (row.label != null) row.label = String(row.label).trim();
    if (row.line) {
      row.line = pick(row.line, LINE_KEYS);
      row.line.postTax = false;
      if (row.line.detail != null && !String(row.line.detail).trim()) delete row.line.detail;
    }
    return row;
  }
  function check(row) {
    const v = EL().validatePreset(row);
    if (!v.ok) throw new Error(v.errors.join('・'));
  }

  return {
    async list() {
      return must(await sb.from('estimate_presets').select('id, kind, label, line, sort, created_at, updated_at')
        .order('kind').order('sort').order('created_at')) || [];
    },
    // 見積のフェーズの種類（estimates.phase_id → case_phases.kind）。フェーズ無し・見つからなければ null
    async phaseKind(phaseId) {
      if (!phaseId) return null;
      const r = must(await sb.from('case_phases').select('id, kind').eq('id', phaseId).maybeSingle());
      return (r && r.kind) || null;
    },
    async create(p) {
      const row = clean(p);
      if (row.sort == null) row.sort = 0;
      check(row);
      return must(await sb.from('estimate_presets').insert(row).select('id, kind, label, line, sort, created_at, updated_at').single());
    },
    // patch は kind / label / line / sort の一部。全体（cur と合わせた形）で判定してから送る
    async update(cur, patch) {
      const row = clean(patch);
      check(Object.assign(clean(cur), row));
      const rows = must(await sb.from('estimate_presets').update(row).eq('id', cur.id).select('id, kind, label, line, sort, created_at, updated_at'));
      if (!rows || !rows.length) throw new Error('この明細は見つかりません（ほかの人が消した可能性があります）');
      return rows[0];
    },
    // 並び替え: [{ id, sort }] を順に保存（EstimateLogic.movePreset の結果）
    async setSorts(changes) {
      for (const c of changes || []) {
        must(await sb.from('estimate_presets').update({ sort: c.sort }).eq('id', c.id).select('id'));
      }
    },
    async remove(id) {
      must(await sb.from('estimate_presets').delete().eq('id', id).select('id'));
    }
  };
})();
