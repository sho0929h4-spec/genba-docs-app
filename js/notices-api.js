// js/notices-api.js — 工事掲示のDBアクセス（Supabase 呼び出しはここに集約）
// 依存: NoticeLogic（js/notice-logic.js）、グローバル sb / ctx（js/supabase.js / js/app.js）
// notices の列権限（migration 013）: room, work_name, work_date, work_date_end, work_date_tbd, data だけ更新できる。
// 一覧用の列（room / work_name / work_date / work_date_end / work_date_tbd）は data から必ず同期する（唯一の源は data）。
const NoticesApi = (() => {
  const NL = () => window.NoticeLogic;
  const must = ({ data, error }) => { if (error) throw error; return data; };

  // 更新してよい列（DB の列 grant と同じ）。org_id / case_id / created_by などは画面から変えられない
  const NOTICE_COLS = ['room', 'work_name', 'work_date', 'work_date_end', 'work_date_tbd', 'data'];
  const pick = (obj, cols) => {
    const out = {};
    for (const k of cols) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    return out;
  };
  const clone = v => JSON.parse(JSON.stringify(v));

  // 'YYYY-MM-DD' の実在する日付だけ通す。それ以外は null（DB の date 型を壊さない）
  function dateOrNull(v) {
    const s = String(v || '').trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    const t = new Date(Date.UTC(y, mo - 1, d));
    return y >= 1 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? s : null;
  }
  const textOrNull = v => { const s = String(v == null ? '' : v).trim(); return s ? s : null; };

  // data から一覧用の列を作る
  function listCols(data) {
    const d = data || {};
    return {
      room: textOrNull(d.roomNo),
      work_name: textOrNull(d.workName),
      work_date: dateOrNull(d.workDate),
      work_date_end: dateOrNull(d.workDateEnd),
      work_date_tbd: !!d.workDateTbd
    };
  }
  // 保存する行（data ＋ 一覧用の列）を allowlist 越しに作る
  const patchOf = data => pick({ ...listCols(data), data }, NOTICE_COLS);

  // 会社マスタ（ctx.org）のスナップショット。後で会社情報を変えても過去の掲示は変わらない
  function contactSnapshot() {
    const o = (typeof ctx !== 'undefined' && ctx && ctx.org) || {};
    return { company: o.name || '', address: o.address || '', tel: o.tel || '' };
  }

  const api = {
    // 工事日の新しい順（未定・空が先頭。旧ツールと同じ）、同じ日は作成の新しい順
    async listByCase(caseId) {
      return must(await sb.from('notices').select('*').eq('case_id', caseId)
        .order('work_date', { ascending: false, nullsFirst: true })
        .order('created_at', { ascending: false }));
    },
    async get(id) {
      return must(await sb.from('notices').select('*').eq('id', id).maybeSingle());
    },
    // 新規作成。物件名は案件名、連絡先は会社マスタのスナップショット
    async create(caseId, caseRow) {
      const data = NL().emptyData(caseRow);
      data.contact = contactSnapshot();
      const row = { case_id: caseId, ...patchOf(data) };
      return must(await sb.from('notices').insert(row).select().single());
    },
    // data と一覧用の列を一緒に保存する。0行なら失敗（削除済み・権限なし）
    async save(id, data) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('保存する内容がありません');
      const rows = must(await sb.from('notices').update(patchOf(data)).eq('id', id).select());
      if (!rows || rows.length === 0) throw new Error('保存できませんでした（掲示が削除された可能性があります）');
      return rows[0];
    },
    async remove(id) {
      const rows = must(await sb.from('notices').delete().eq('id', id).select('id'));
      if (!rows || rows.length === 0) throw new Error('削除できませんでした');
    },
    // 複製 = 号室を空にした新規 insert（連絡先のスナップショットも引き継ぐ）。別の号室用に使う
    async duplicate(notice) {
      const data = clone(notice.data || {});
      data.roomNo = '';
      const row = { case_id: notice.case_id, ...patchOf(data) };
      return must(await sb.from('notices').insert(row).select().single());
    },
    // 連絡先を会社マスタの最新で上書きして保存する。更新後の行を返す
    async refreshContact(id, data) {
      const next = { ...clone(data || {}), contact: contactSnapshot() };
      return api.save(id, next);
    }
  };
  return api;
})();
window.NoticesApi = NoticesApi;
