// js/work-log.js — Task 77: 日報に自動で入れる作業の記録（work_logs・migration 091）（window.WorkLog）
// 現地の着・出: ツールページの「現場に着いた」「現場を出た」→ kind 'site' の行（行く回ごと。押し直し = 時刻を今に直す）
// Task 81: 報告書・見積書を書いていた時間（kind 'report' / 'estimate'）は数えない（ユーザー決定。表と migration 091 はそのまま）
(function (root) {
  const me = () => (typeof ctx !== 'undefined' && ctx && ctx.user ? ctx.user.id : null);
  const today = () => PhaseLogic.jstYmd(new Date());
  const must = ({ data, error }) => { if (error) throw error; return data; };
  // 自分のその日の記録（日報・ツールページ）
  async function listMine(ymd) {
    return must(await sb.from('work_logs').select('*').eq('user_id', me()).eq('ymd', ymd || today()).order('created_at')) || [];
  }
  // 現場に着いた（新しい回）
  async function arrive(caseId, phaseId) {
    return must(await sb.from('work_logs').insert({ ymd: today(), kind: 'site', case_id: caseId, phase_id: phaseId, arrived_at: new Date().toISOString() }).select('*'));
  }
  // 着いた・出た の時刻を今に（押し直し・出た）
  async function stamp(id, col) {
    const rows = must(await sb.from('work_logs').update({ [col]: new Date().toISOString() }).eq('id', id).select('id'));
    if (!rows || !rows.length) throw new Error('記録を直せませんでした');
  }
  root.WorkLog = { listMine, arrive, stamp };
})(typeof window !== 'undefined' ? window : globalThis);
