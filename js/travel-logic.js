// js/travel-logic.js — Task 70 の判定と文（純粋関数だけ。ブラウザ: window.TravelLogic / node: module.exports）
//   B. 調査の終了予定の既定（開始＋N分。N は1人ずつの設定 memberships.survey_end_mins）。自動で入れた値だけ開始に追従し、手で直した値は触らない
//   C. 原因元工事・復旧工事の日程: 最新の見積書の備考の「工事時間」（EstimateLogic.timeRange）を、時刻の欄が空のときだけ入れる
//   D. 引き受け・指名のときの「間に合うか」: その担当者の同じ日（日本時間）の直前・直後の予定を選び、移動の目安（Google Routes API の秒数）で判定して文にする
//   fetch は js/travel-api.js、画面（確認のシート・設定のカード）は js/travel-ui.js
(function (root) {
  const inNode = typeof module !== 'undefined' && module.exports;
  const PL = () => (inNode ? require('./phase-logic.js') : root.PhaseLogic);
  const EL = () => (inNode ? require('./estimate-logic.js') : root.EstimateLogic);
  const MIN = 60000;
  const GUESS_MINS = 60; // 終了予定が無い予定は開始＋60分を終わりとみなす（PhaseLogic.slotEndMs と同じ）
  const ms = v => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
  const iso = t => new Date(t).toISOString();
  const str = v => String(v == null ? '' : v).trim();
  const hm = v => PL().fmtMDHM(v).split(' ')[1] || ''; // '13:00' / '9:30'（日本時間）

  /* ---------- B. 調査の終了予定（開始から N 分） ---------- */
  const SURVEY_END_DEFAULT = 120;
  const SURVEY_END_CHOICES = Array.from({ length: 12 }, (_, i) => (i + 1) * 30); // 30分〜6時間・30分きざみ（DB の check と同じ）
  const surveyMins = v => (SURVEY_END_CHOICES.includes(Number(v)) ? Number(v) : SURVEY_END_DEFAULT);
  const minsText = m => (m < 60 ? m + '分' : m % 60 ? Math.floor(m / 60) + '時間' + (m % 60) + '分' : m / 60 + '時間');
  // 開始・種類が変わったときに呼ぶ。s: { kind, start, end（今の終了予定 ISO か null）, auto（前に自動で入れた値か null）, mins }
  //   → { end, auto }。調査で開始があり、終了予定が空か自動で入れた値のまま → 開始＋N分。手で入れた・直した値はそのまま（auto は null に）。
  //   調査でなくなった・開始を消した → 自動で入れた値だけ消す
  function autoEnd(s) {
    const x = s || {};
    const mine = !!x.auto && x.end === x.auto;
    if (x.end && !mine) return { end: x.end, auto: null };
    if (x.kind !== 'survey' || ms(x.start) == null) return { end: null, auto: null };
    const e = iso(ms(x.start) + surveyMins(x.mins) * MIN);
    return { end: e, auto: e };
  }

  // 前に保存した終了予定がちょうど 開始＋N分 なら自動で入れた値とみなす（日時を直す欄を開いたとき。開始を動かすと一緒に動く）→ その値か null
  function initialAuto(kind, start, end, mins) {
    const s = ms(start), e = ms(end);
    return kind === 'survey' && s != null && e != null && e - s === surveyMins(mins) * MIN ? iso(e) : null;
  }

  /* ---------- C. 見積書の工事時間 → 時刻 ---------- */
  // kind: 対応の種類。cond: PhaseLogic.workConditions(phase)（{ time: '9:00〜17:00' } か null）。cur: { start, end } = 今の時刻の欄（'HH:MM' か ''）
  //   → { start: '09:00', end: '17:00', note: '見積書の工事時間（9:00〜17:00）から入れました' } か null（原因元工事・復旧工事で、時刻の欄が両方空のときだけ）
  function workTimes(kind, cond, cur) {
    if (kind !== 'cause' && kind !== 'repair') return null;
    if (cur && (cur.start || cur.end)) return null;
    const r = cond && cond.time ? EL().timeRange(cond.time) : null;
    if (!r) return null;
    const short = t => String(+t.slice(0, 2)) + t.slice(2);
    return { start: r.start, end: r.end, note: '見積書の工事時間（' + short(r.start) + '〜' + short(r.end) + '）から入れました' };
  }

  /* ---------- D. 直前・直後の予定 ---------- */
  // rows: case_summaries の行（phases 付き）。o: { workerId, phaseId（この対応。外す）, start, end（空なら＋60分）, caseRow（この現場。rows に無いとき） }
  //   その担当者の同じ日（日本時間）の担当の予定（失注・完了・済みは外す = PhaseLogic.busyOf と同じ）のうち
  //   prev = この開始より前に始まる一番近いもの、next = この終了予定以降に始まる一番近いもの
  //   → { here: { address, place }, start, end, endGuessed, prev, next }（prev / next = { start, end, endGuessed, address, place, phaseId } か null）
  function neighbors(rows, o) {
    const x = o || {};
    const list = Array.isArray(rows) ? rows : [];
    const s = ms(x.start);
    if (s == null || !x.workerId) return { here: null, start: x.start || null, end: null, endGuessed: false, prev: null, next: null };
    const endOf = (start, end) => (ms(end) != null && ms(end) > ms(start) ? { end: iso(ms(end)), endGuessed: false } : { end: iso(ms(start) + GUESS_MINS * MIN), endGuessed: true });
    const mine = endOf(x.start, x.end);
    const day = PL().jstYmd(x.start);
    const own = list.find(c => (Array.isArray(c && c.phases) ? c.phases : []).some(p => p && p.id === x.phaseId)) || x.caseRow || {};
    const here = { address: str(own.address), place: PL().placeName(own) || '（物件名なし）' };
    const items = [];
    for (const c of list) {
      if (!c || c.deleted_at) continue;
      for (const p of Array.isArray(c.phases) ? c.phases : []) {
        if (!p || p.worker_id !== x.workerId || p.id === x.phaseId || ms(p.scheduled_at) == null || p.lost_at || p.done_at || p.completed_at) continue;
        if (PL().jstYmd(p.scheduled_at) !== day) continue;
        items.push(Object.assign({ start: p.scheduled_at, address: str(c.address), place: PL().placeName(c) || '別の案件', phaseId: p.id }, endOf(p.scheduled_at, p.scheduled_end)));
      }
    }
    const before = items.filter(i => ms(i.start) < s).sort((a, b) => ms(b.start) - ms(a.start));
    const after = items.filter(i => ms(i.start) >= ms(mine.end)).sort((a, b) => ms(a.start) - ms(b.start));
    return { here, start: x.start, end: mine.end, endGuessed: mine.endGuessed, prev: before[0] || null, next: after[0] || null };
  }
  // 移動の区間（前の現場 → ここ・ここ → 次の現場）。from / to = { address, place }、depart = 出る時刻、arriveBy = 着いていたい時刻
  function legs(n) {
    const x = n || {};
    const out = [];
    if (x.prev) out.push({ side: 'prev', from: x.prev, to: x.here, depart: x.prev.end, departGuessed: x.prev.endGuessed, arriveBy: x.start });
    if (x.next) out.push({ side: 'next', from: x.here, to: x.next, depart: x.end, departGuessed: x.endGuessed, arriveBy: x.next.start });
    return out;
  }
  const hasAddr = leg => !!(leg && leg.from && leg.to && str(leg.from.address) && str(leg.to.address));
  // 車の秒数 → 着く時刻・遅れるか
  function judge(leg, seconds) {
    const sec = typeof seconds === 'number' ? seconds : NaN;
    if (!leg || !Number.isFinite(sec) || sec < 0) return null;
    const arrive = ms(leg.depart) + Math.round(sec / 60) * MIN;
    return { arrive: iso(arrive), late: arrive > ms(leg.arriveBy), mins: Math.round(sec / 60) };
  }
  const durText = m => (m < 60 ? m + '分' : Math.floor(m / 60) + '時間' + (m % 60 ? (m % 60) + '分' : ''));
  // 区間の文。r: judge の結果（null = 計算しなかった）、state: 'ok' | 'loading' | 'failed'（目安を出せなかった）
  //   → { text, note（赤い字。間に合わない可能性があるときだけ）, late }
  function legText(leg, r, state) {
    const guess = leg.departGuessed ? '（終了予定が無いので開始＋60分とみなします）' : '';
    const at = hm(leg.depart) + guess;
    const head = leg.side === 'prev' ? '前の現場（' + leg.from.place + '）の終了予定 ' + at : 'この終了予定 ' + at;
    const nextName = leg.side === 'next' ? '次の現場（' + leg.to.place + '・' + hm(leg.to.start) + ' 開始）' : '';
    if (!hasAddr(leg)) return { text: head + (nextName ? ' の後に' + nextName : '') + '。住所が無いので計算できません', note: '', late: false };
    if (r) {
      const tail = ' ごろ着（車で約' + durText(r.mins) + '・Googleの目安）';
      return { text: head + ' に出ると ' + (nextName ? nextName + 'に ' : '') + hm(r.arrive) + tail, note: r.late ? '間に合わない可能性があります' : '', late: r.late };
    }
    const why = state === 'loading' ? '車の時間を調べています…' : '目安を出せませんでした';
    return { text: head + (nextName ? ' の後に' + nextName : '') + '。' + why, note: '', late: false };
  }
  // 「Googleマップで経路を見る」（キー不要）
  const mapUrl = (origin, dest) => 'https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent(str(origin)) + '&destination=' + encodeURIComponent(str(dest)) + '&travelmode=driving';
  // Routes API（computeRoutes）の本文。出発時刻が今より前なら departureTime を付けない（＝今。過去の時刻は API が断るため）
  function routeBody(origin, dest, depart, now) {
    const body = { origin: { address: str(origin) }, destination: { address: str(dest) }, travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE' };
    const t = ms(depart), n = ms(now) != null ? ms(now) : Date.now();
    if (t != null && t > n) body.departureTime = iso(t);
    return body;
  }
  // Routes API の答え → 秒数（'2700s'）か null
  function routeSeconds(res) {
    const r = res && Array.isArray(res.routes) ? res.routes[0] : null;
    const m = r && /^(\d+(?:\.\d+)?)s$/.exec(String(r.duration || ''));
    return m ? Math.round(Number(m[1])) : null;
  }
  // 伏せ字（末尾4文字だけ）
  const maskKey = k => (str(k) ? '••••' + str(k).slice(-4) : '');
  // ブラウザ用の API キーの形（DB の check と同じ: 英数字と - _ だけ・20〜100字）
  const keyOk = k => /^[A-Za-z0-9_-]{20,100}$/.test(str(k));

  const api = { SURVEY_END_DEFAULT, SURVEY_END_CHOICES, surveyMins, minsText, autoEnd, initialAuto, workTimes, neighbors, legs, hasAddr, judge, legText, mapUrl, routeBody, routeSeconds, maskKey, keyOk };
  if (inNode) module.exports = api;
  else root.TravelLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
