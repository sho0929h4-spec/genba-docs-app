// js/work-log.js — Task 77: 日報に自動で入れる作業の記録（work_logs・migration 091）（ブラウザ: window.WorkLog / node: module.exports は純粋関数だけ）
// 1. 現地の着・出: ツールページの「現場に着いた」「現場を出た」→ kind 'site' の行（行く回ごと。押し直し = 時刻を今に直す）
// 2. 報告書・見積書を書いていた分: 現場用で #report/{id}・#estimate/{id} を開いている間を数える（fieldRoute から route(hash)）。
//    画面が見えている間だけ・何も触らない時間が5分を超えたらその間は数えない（放置は数えない）・1分未満は捨てる。
//    画面が裏に回ったとき・画面を離れたときに、たまった分（1分単位）を日ごと・書類ごとの行に足す（kind 'report' / 'estimate'）
(function (root) {
  const inNode = typeof module !== 'undefined' && module.exports;
  const IDLE_MS = 5 * 60 * 1000;
  const DAY_MAX = 24 * 60;

  // 書いていた時間の数え方。s = { last: 最後に触った時刻（ms）| null（止まっている）, acc: たまった ms }
  //   ev: 'start'（開いた・表に戻った）／'act'（触った）／'hide'（裏に回った）／'stop'（離れた）
  //   前に触ってからの間が5分以内なら足す。5分を超えた間は放置なので足さない
  function step(s, t, ev) {
    let acc = s && s.acc > 0 ? s.acc : 0;
    const last = s ? s.last : null;
    if (last != null && ev !== 'start' && t > last && t - last <= IDLE_MS) acc += t - last;
    return { last: ev === 'hide' || ev === 'stop' ? null : t, acc };
  }
  // たまった分を1分単位で取り出す。裏に回ったときは切り捨てて端数を残す。離れたとき（last = true）は四捨五入・合わせて1分未満は捨てる
  function take(s, last) {
    const acc = s.acc || 0;
    const minutes = last ? (acc < 60000 ? 0 : Math.round(acc / 60000)) : Math.floor(acc / 60000);
    return { minutes, s: { last: s.last, acc: last ? 0 : acc - minutes * 60000 } };
  }
  // 足した分（1日を超えない）
  const addUp = (old, n) => Math.min(DAY_MAX, (Number(old) || 0) + (Number(n) || 0));

  const api = { IDLE_MS, step, take, addUp };
  if (inNode) { module.exports = api; return; }

  /* ---------- ブラウザ: 表の読み書き ---------- */
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
  // 書いていた分を足す（その日・その書類の行が無ければ作る）
  async function addMinutes(kind, docId, n) {
    const col = kind === 'report' ? 'report_id' : 'estimate_id';
    const ymd = today();
    const rows = must(await sb.from('work_logs').select('id, minutes').eq('user_id', me()).eq('ymd', ymd).eq('kind', kind).eq(col, docId));
    if (rows && rows.length) {
      must(await sb.from('work_logs').update({ minutes: addUp(rows[0].minutes, n) }).eq('id', rows[0].id).select('id'));
      return;
    }
    const doc = must(await sb.from(kind === 'report' ? 'reports' : 'estimates').select('case_id, phase_id').eq('id', docId).maybeSingle());
    if (!doc) return;
    must(await sb.from('work_logs').insert({ ymd, kind, case_id: doc.case_id, phase_id: doc.phase_id || null, [col]: docId, minutes: addUp(0, n) }).select('id'));
  }

  /* ---------- ブラウザ: 書いていた時間を数える ---------- */
  const DOC_RE = /^#(report|estimate)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  let cur = null;                  // { key, kind, id, s }
  let pending = Promise.resolve(); // 保存の順番待ち（日報を開く前に待つ）
  const visible = () => document.visibilityState !== 'hidden';
  function save(c, last) {
    const r = take(c.s, last);
    c.s = r.s;
    if (r.minutes < 1) return;
    pending = pending.then(() => addMinutes(c.kind, c.id, r.minutes)).catch(e => console.warn('書いていた時間を記録できませんでした', e));
  }
  // 現場用のルートが変わるたびに呼ぶ（現場用でなければ空の hash）
  function route(hash) {
    const m = DOC_RE.exec(hash || '');
    const key = m ? m[1] + ':' + m[2].toLowerCase() : null;
    if (cur && cur.key === key) return;
    if (cur) { cur.s = step(cur.s, Date.now(), 'stop'); save(cur, true); cur = null; }
    if (m) cur = { key, kind: m[1], id: m[2].toLowerCase(), s: step(null, Date.now(), visible() ? 'start' : 'stop') };
  }
  const onAct = () => { if (cur && visible()) cur.s = step(cur.s, Date.now(), 'act'); };
  ['pointerdown', 'keydown', 'input', 'scroll', 'wheel'].forEach(t => document.addEventListener(t, onAct, { capture: true, passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (!cur) return;
    if (visible()) cur.s = step(cur.s, Date.now(), 'start');
    else { cur.s = step(cur.s, Date.now(), 'hide'); save(cur); }
  });

  root.WorkLog = Object.assign(api, { listMine, arrive, stamp, addMinutes, route, flushed: () => pending });
})(typeof window !== 'undefined' ? window : globalThis);
