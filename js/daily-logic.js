// js/daily-logic.js — 現場用の「日報作成」（Task 32）の純粋関数（ブラウザ: window.DailyLogic / node: module.exports）
// 日報は4区画。すべて既存のデータから自動で転記し、各行は押して ☑／☐（含める・外す）だけ:
//   1. {M/D（曜）}に行った現場と対応報告: その日の自分の対応（物件名 号室・対応・時刻・今回行く部屋）ごとに
//      報告書の状態（提出済み M/D（曜）H:MM／下書き／未作成）と必要な対応（PhaseLogic の段階）
//   2. {M/D（曜）}に処理したタスク: その日に済ませたもの（報告書の提出・見積の提出・確認した・工事掲示の作成・
//      管理者への連絡/返事・遅れ報告）。時刻つき
//   3. {翌日 M/D（曜）}に対応するタスク: 翌日の予定（日時のある対応）＋ 期限が翌日までのタスク（報告書・見積）
//   4. かかった時間: 1. の現場ごとに、報告書の作業開始〜終了時間があればその時間（自動）。無ければ時間のチップを押して選ぶ。
//      移動時間は任意のチップ。合計は自動
// 日付はすべて具体の日付（「本日」「明日」の言葉は使わない＝Task 31 の決まり。見出しも「10/21（水）に…」）。
// 時刻は日本時間（PhaseLogic と同じく実行環境のタイムゾーンに依存しない）。
// 選んだ状態 sel = { off: { [行のkey]: true }（外した行）, chip: { [時間のkey]: 分 | 'other' }, other: { [時間のkey]: '2.5'（時間） },
//   travel: 分 | null（移動時間。null = 選んでいない） }
(function (root) {
  const inNode = typeof module !== 'undefined' && module.exports;
  const PL = () => (inNode ? require('./phase-logic.js') : root.PhaseLogic);
  const str = v => String(v == null ? '' : v).trim();
  const listOf = v => (Array.isArray(v) ? v.filter(Boolean) : []);
  const ms = v => { const d = PL().toDate(v); return d ? d.getTime() : null; };
  const WEEK = '日月火水木金土';

  // 'YYYY-MM-DD' → { y, m, d, w }（日付だけで計算）
  function ymdParts(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return { y: +m[1], m: +m[2], d: +m[3], w: WEEK[d.getUTCDay()] };
  }
  const ymdMDW = ymd => { const p = ymdParts(ymd); return p ? `${p.m}/${p.d}（${p.w}）` : ''; };          // 10/21（水）
  const ymdLong = ymd => { const p = ymdParts(ymd); return p ? `${p.y}年${p.m}月${p.d}日（${p.w}）` : ''; }; // 2026年10月21日（水）
  const hm = v => { const s = PL().fmtMDHM(v); return s ? s.split(' ')[1] : ''; };                        // 9:00
  const isDay = (v, ymd) => !!v && PL().jstYmd(v) === ymd;

  // 時間のチップ（分）。'other' はその他（時間を数字で入れる）
  const TIME_CHIPS = [
    { v: 30, label: '30分' }, { v: 60, label: '1時間' }, { v: 90, label: '1.5時間' }, { v: 120, label: '2時間' },
    { v: 180, label: '3時間' }, { v: 240, label: '半日' }, { v: 480, label: '1日' }, { v: 'other', label: 'その他' }
  ];
  const TRAVEL_CHIPS = [{ v: 0, label: 'なし' }, { v: 30, label: '30分' }, { v: 60, label: '1時間' }, { v: 90, label: '1.5時間' }, { v: 120, label: '2時間' }];
  const OTHER_MAX_MIN = 24 * 60;
  const PHOTOS_MAX = 3;
  const NOTE_HEAD = '■ 一言';

  // 分 → '2時間30分' / '30分' / '1時間' / '0分'
  function fmtDuration(min) {
    const n = Math.max(0, Math.round(Number(min) || 0));
    const h = Math.floor(n / 60), m = n % 60;
    if (!h) return `${m}分`;
    return m ? `${h}時間${m}分` : `${h}時間`;
  }
  // 'HH:MM' → 分（不正は null）
  function hmMin(s) {
    const m = /^(\d{1,2}):(\d{2})/.exec(str(s));
    if (!m || +m[1] > 23 || +m[2] > 59) return null;
    return +m[1] * 60 + +m[2];
  }
  // その他の入力（時間・小数可）→ 分（0 < 分 ≤ 24時間。不正は null）
  function otherMinutes(v) {
    const t = str(v).replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/時間$/, '');
    if (!/^\d+(\.\d+)?$/.test(t)) return null;
    const n = Math.round(Number(t) * 60);
    return n > 0 && n <= OTHER_MAX_MIN ? n : null;
  }

  // 報告書の状態の文: 提出済み 10/21（水）11:30／下書き／未作成
  function reportStateText(reports) {
    const list = listOf(reports);
    const done = list.filter(r => r.status && r.status !== 'draft').sort((a, b) => (ms(b.submitted_at) || 0) - (ms(a.submitted_at) || 0))[0];
    if (done) return done.submitted_at ? `提出済み ${PL().fmtMDWHM(done.submitted_at)}` : '提出済み';
    return list.length ? '下書き' : '未作成';
  }
  // 自分の対応か（作業担当者が自分。作業担当者が空なら案件の担当者が自分）
  const mine = (c, p, me) => !!me && (p.worker_id === me || (!p.worker_id && !p.open_call_at && c.assignee_id === me)); // Task 51: 募集中は案件の担当者の日報に入れない
  // 報告書の作業開始〜終了（times = [{ phase_id, time_start, time_end }]。両方ある最後のもの）→ { minutes, text } | null
  function autoTime(times, phaseId) {
    const list = listOf(times).filter(t => t.phase_id === phaseId && hmMin(t.time_start) != null && hmMin(t.time_end) != null);
    const t = list[list.length - 1];
    if (!t) return null;
    let n = hmMin(t.time_end) - hmMin(t.time_start);
    if (n <= 0) n += 24 * 60; // 日をまたいだ作業
    const fmt = s => { const v = hmMin(s); return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`; };
    return { minutes: n, text: `${fmt(t.time_start)}〜${fmt(t.time_end)}` };
  }

  // 日報の中身を組み立てる
  //   o: { rows: case_summaries の行, me, now, times: 報告書の作業時間, notices: 自分が作った工事掲示（{ id, case_id, phase_id, created_at }）,
  //        messages: 自分が送った連絡（staff_messages の行） }
  //   → { ymd, nextYmd, dayLabel, nextLabel, sections: [{ key, title, items: [{ key, text, sub: [文], at }] }], times: [{ key, label, auto }] }
  function build(o) {
    const opt = o || {};
    const L = PL();
    const nowAt = L.toDate(opt.now) || new Date();
    const ymd = L.jstYmd(nowAt);
    const nextYmd = L.ymdAdd(ymd, 1);
    const me = opt.me || null;
    const res = { ymd, nextYmd, dayLabel: ymdMDW(ymd), nextLabel: ymdMDW(nextYmd), sections: [], times: [] };
    const sites = [], done = [], next = [];
    const caseById = new Map();
    const phaseInfo = new Map(); // phaseId → { c, p, title }
    for (const c of listOf(opt.rows)) {
      if (c.deleted_at) continue;
      caseById.set(c.id, c);
      const count = {};
      for (const p of listOf(c.phases)) {
        count[p.kind] = (count[p.kind] || 0) + 1;
        phaseInfo.set(p.id, { c, p, title: L.phaseTitle(p, p.seq != null ? p.seq : count[p.kind]) });
      }
    }
    const placeOf = c => L.placeName(c) || '（物件名なし）';
    for (const { c, p, title } of phaseInfo.values()) {
      const place = placeOf(c);
      const base = { caseId: c.id, phaseId: p.id || null };
      // 1. その日行った現場（自分の対応で、予定がその日）
      if (mine(c, p, me) && isDay(p.scheduled_at, ymd)) {
        const st = L.stage(p, null, nowAt, { me });
        const need = L.fieldStageLabel(st) || (st.label ? `なし（✓ ${st.label}）` : 'なし');
        sites.push(Object.assign({ key: 'site:' + p.id, at: ms(p.scheduled_at), text: `${hm(p.scheduled_at)} ${place} ${title}`,
          sub: [`行く部屋: ${L.visitText(p.plan, c)}`, `報告書: ${reportStateText(p.reports)}`, `必要な対応: ${need}`] }, base));
        res.times.push({ key: 'time:' + p.id, phaseId: p.id, label: `${place} ${title}`, auto: autoTime(opt.times, p.id), at: ms(p.scheduled_at) });
      }
      // 2. 処理したタスク
      listOf(p.reports).forEach(r => {
        if (me && r.submitted_by === me && r.status !== 'draft' && isDay(r.submitted_at, ymd)) {
          done.push(Object.assign({ key: 'done:report:' + r.id, at: ms(r.submitted_at), text: `${hm(r.submitted_at)} 報告書を提出 ${place} ${title}`, sub: [] }, base));
        }
      });
      listOf(p.estimates).forEach(e => {
        if (me && e.created_by === me && e.status && e.status !== 'draft' && isDay(e.issued_at, ymd)) {
          const amt = e.total != null ? ' ' + L.yen(e.total) : '';
          done.push(Object.assign({ key: 'done:estimate:' + e.id, at: ms(e.issued_at),
            text: `${hm(e.issued_at)} 見積書を提出 ${place} ${title}（v${Number(e.version) || 1}${amt}）`, sub: [] }, base));
        }
      });
      if (me && p.worker_id === me && isDay(p.ack_at, ymd)) {
        done.push(Object.assign({ key: 'done:ack:' + p.id, at: ms(p.ack_at), text: `${hm(p.ack_at)} 現場への指示を確認した ${place} ${title}`, sub: [] }, base));
      }
      if (me && p.late_by === me && isDay(p.late_at, ymd)) {
        done.push(Object.assign({ key: 'done:late:' + p.id, at: ms(p.late_at), text: `${hm(p.late_at)} 到着が遅れそうと報告 ${place} ${title}`, sub: [] }, base));
      }
      // 3. 翌日に対応するタスク（自分の対応だけ・進行中の案件だけ）
      if (!mine(c, p, me) || (c.status && c.status !== 'open')) continue;
      if (!p.done_at && isDay(p.scheduled_at, nextYmd)) {
        next.push(Object.assign({ key: 'next:visit:' + p.id, at: ms(p.scheduled_at), text: `${L.fmtMDWHM(p.scheduled_at)}〜 ${place} ${title}`,
          sub: [`行く部屋: ${L.visitText(p.plan, c)}`] }, base));
      }
      const st = L.stage(p, null, nowAt, { me });
      if (st.due && ((p.kind === 'survey' && st.key === 'write') || (p.kind !== 'survey' && st.key === 'report') || st.key === 'record') && st.due <= nextYmd) {
        const dueText = p.kind === 'survey' && st.dueAt ? L.fmtMDWHM(st.dueAt) : ymdMDW(st.due);
        const what = st.key === 'record' ? '現地確認の記録を送信' : '報告書を書いて提出'; // Task 65
        next.push(Object.assign({ key: 'next:report:' + p.id, at: st.dueAt ? ms(st.dueAt) : ms(L.jstAt(+st.due.slice(0, 4), +st.due.slice(5, 7), +st.due.slice(8, 10), 23, 59)),
          text: `${what}（期限 ${dueText}${st.late ? '・期限超過' : ''}） ${place} ${title}`, sub: [] }, base));
      }
      const et = L.estimateTodo(p, nowAt);
      if (et && et.due <= nextYmd) {
        next.push(Object.assign({ key: 'next:estimate:' + p.id, at: ms(L.jstAt(+et.due.slice(0, 4), +et.due.slice(5, 7), +et.due.slice(8, 10), 23, 59)),
          text: `見積書を提出（期限 ${ymdMDW(et.due)}${et.late ? '・期限超過' : ''}） ${place} ${title}`, sub: [] }, base));
      }
    }
    // 2. 工事掲示の作成（自分が作ったもの）・管理者への連絡（自分が送ったもの）
    listOf(opt.notices).forEach(n => {
      if (!isDay(n.created_at, ymd) || (me && n.created_by && n.created_by !== me)) return;
      const info = phaseInfo.get(n.phase_id);
      const c = info ? info.c : caseById.get(n.case_id);
      if (!c) return;
      done.push({ key: 'done:notice:' + n.id, caseId: c.id, phaseId: n.phase_id || null, at: ms(n.created_at),
        text: `${hm(n.created_at)} 工事掲示を作成 ${placeOf(c)}${info ? ' ' + info.title : ''}`, sub: [] });
    });
    listOf(opt.messages).forEach(m => {
      if (!me || m.from_user !== me || !m.case_id || (m.source && m.source !== 'staff') || !isDay(m.created_at, ymd)) return;
      const c = caseById.get(m.case_id);
      done.push({ key: 'done:msg:' + m.id, caseId: m.case_id, phaseId: m.phase_id || null, at: ms(m.created_at),
        text: `${hm(m.created_at)} 管理者に${m.reply_to ? '返事' : '連絡'}「${str(m.subject)}」${c ? ' ' + placeOf(c) : ''}`, sub: [] });
    });
    const byAt = (a, b) => (a.at || 0) - (b.at || 0) || String(a.text || a.label).localeCompare(String(b.text || b.label), 'ja');
    [sites, done, next, res.times].forEach(x => x.sort(byAt));
    res.sections = [
      { key: 'sites', title: `${res.dayLabel}に行った現場と対応報告`, items: sites },
      { key: 'done', title: `${res.dayLabel}に処理したタスク`, items: done },
      { key: 'next', title: `${res.nextLabel}に対応するタスク`, items: next }
    ];
    return res;
  }

  /* ---------- 選んだ状態 ---------- */
  const isOff = (sel, key) => !!(sel && sel.off && sel.off[key]);
  // 時間の行の分（含めない・選んでいない・その他が不正なら null）
  function timeMinutes(t, sel) {
    if (!t || isOff(sel, t.key)) return null;
    if (t.auto) return t.auto.minutes;
    const v = sel && sel.chip ? sel.chip[t.key] : undefined;
    if (v === 'other') return otherMinutes(sel.other && sel.other[t.key]);
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  // 合計 → { work（現場の合計）, travel（移動。選んでいなければ 0）, total, missing（含める行で時間が未選択の数）, text }
  function totals(model, sel) {
    let work = 0, missing = 0;
    listOf(model && model.times).forEach(t => {
      if (isOff(sel, t.key)) return;
      const n = timeMinutes(t, sel);
      if (n == null) missing += 1; else work += n;
    });
    const travel = sel && Number.isFinite(sel.travel) && sel.travel > 0 ? sel.travel : 0;
    const total = work + travel;
    return { work, travel, total, missing, text: `合計 ${fmtDuration(total)}${travel ? `（移動 ${fmtDuration(travel)}を含む）` : ''}` };
  }
  // 時間の行の右に出す文: 自動 '2時間30分（9:00〜11:30・報告書の作業時間）'／選んだ '1時間'／未選択 '未選択'
  function timeText(t, sel) {
    if (t.auto) return `${fmtDuration(t.auto.minutes)}（${t.auto.text}・報告書の作業時間）`;
    const n = timeMinutes(t, sel);
    return n == null ? '未選択' : fmtDuration(n);
  }

  /* ---------- 文と PDF の中身 ---------- */
  const heading = (ymd, name) => `日報 ${ymdLong(ymd)} ${str(name) || '名前なし'}`;
  // 画面・本文・PDF で同じ中身（含める行だけ）→ { title, org, sections: [{ title, rows: [{ text, sub }] }], time: { rows: [{ label, value }], total, travel }, note }
  function view(model, sel, o) {
    const opt = o || {};
    const m = model || { sections: [], times: [] };
    const sections = listOf(m.sections).map(s => ({ key: s.key, title: s.title,
      rows: listOf(s.items).filter(x => !isOff(sel, x.key)).map(x => ({ text: x.text, sub: listOf(x.sub) })) }));
    const tt = totals(m, sel);
    const rows = listOf(m.times).filter(t => !isOff(sel, t.key)).map(t => ({ label: t.label, value: timeText(t, sel) }));
    if (sel && Number.isFinite(sel.travel)) rows.push({ label: '移動時間', value: sel.travel > 0 ? fmtDuration(sel.travel) : 'なし' });
    return { title: heading(m.ymd, opt.name), org: str(opt.org), sections, time: { rows, total: tt.text, missing: tt.missing }, note: str(opt.note) };
  }
  // 日報の本文（staff_messages.body。テキスト版）。区画が空なら「・なし」。一言は最後（「■ 一言」の後ろ＝送り直すときに取り出せる）
  function text(model, sel, o) {
    const v = view(model, sel, o);
    const lines = [];
    v.sections.forEach(s => {
      lines.push(`■ ${s.title}`);
      if (!s.rows.length) lines.push('・なし');
      s.rows.forEach(r => { lines.push(`・${r.text}`); r.sub.forEach(x => lines.push(`　${x}`)); });
    });
    lines.push(`■ かかった時間（${v.time.total}）`);
    if (!v.time.rows.length) lines.push('・なし');
    v.time.rows.forEach(r => lines.push(`・${r.label} ${r.value}`));
    if (v.note) lines.push('', NOTE_HEAD, v.note);
    return lines.join('\n');
  }
  // 送った日報の本文から一言を取り出す（送り直すときの初期値）
  function noteOf(body) {
    const b = String(body || '');
    const i = b.indexOf('\n' + NOTE_HEAD + '\n');
    return i >= 0 ? b.slice(i + NOTE_HEAD.length + 2) : '';
  }

  const api = { TIME_CHIPS, TRAVEL_CHIPS, PHOTOS_MAX, NOTE_HEAD, ymdMDW, ymdLong, fmtDuration, otherMinutes, reportStateText, autoTime,
    build, timeMinutes, totals, timeText, heading, view, text, noteOf };
  if (inNode) module.exports = api;
  else root.DailyLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
