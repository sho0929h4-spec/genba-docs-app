// js/phase-logic.js — 対応フェーズ（調査・原因元工事・復旧工事）の純粋関数（ブラウザ: window.PhaseLogic / node: module.exports）
// 社内画面のフェーズカード・案件一覧の「次:」・連絡メール／リマインド・請求の一覧で使う。
// 時刻はすべて日本時間（UTC+9 固定。日本に夏時間は無い）で判定・表示する。実行環境のタイムゾーンには依存しない
// （getHours 等のローカル関数は使わず、+9時間ずらした値を getUTC* で読む）。
// フェーズの形は case_summaries.phases（migration 021）の要素:
//   { id, kind, seq, scheduled_at, scheduled_end, done_at, bill_to_type, bill_to_name, billing_mode, billing_month,
//     billed_at, paid_at, amount_override, estimate_due（037。見積書提案期日 YYYY-MM-DD）, estimates: [...], reports: [...] }
//   estimates の要素 { id, series_id, version, status, total, accepted, sent_at, accepted_at, sent_version, sent_total }
//   reports の要素   { id, work_type, status, sent, sent_at, submitted_at, submitted_via, share_active }
//     （034: share_active = 協力業者URLが使える＝作業員が入力中。035: submitted_via = member（社内）/ share（協力業者URL））
// 見積・報告書は estimates / reports 表の行そのもの（全版）を渡してもよい（superseded を除いて同じ判定になる）。
(function (root) {
  const KINDS = [
    { key: 'survey', label: '調査', short: '調査', color: 'blue' },
    { key: 'cause', label: '原因元工事', short: '原因元', color: 'orange' },
    { key: 'repair', label: '復旧工事', short: '復旧', color: 'green' }
  ];
  const KIND_KEYS = KINDS.map(k => k.key);
  const kindOf = key => KINDS.find(k => k.key === key) || null;
  const kindLabel = key => (kindOf(key) || {}).label || '';
  const isWork = key => key === 'cause' || key === 'repair';

  // 段階の並び（カードのステップ表示用）。stage().key はこのどれか
  const STEPS = {
    // Task 16: 「調査済みにする」は無い。報告書の流れ（URLを渡す→作業員が提出／自社で書く→提出）で進む
    survey: [
      { key: 'schedule', label: '調査日を決める' },
      { key: 'visit', label: '調査に行く' },
      { key: 'waiting', label: '調査報告待ち' },
      { key: 'write', label: '報告書を書く' },
      { key: 'check', label: '報告書を確認する' },
      { key: 'report', label: '報告書を送る' },
      { key: 'approval', label: '見積の承諾待ち' },
      { key: 'done', label: '完了' }
    ],
    // 工事は 7 つの段階（2026-10-20 ユーザー指示。手で段階を変えるボタンは無く、画面の操作から自動で決まる）
    work: [
      { key: 'estimate', label: '見積書作成必要' },
      { key: 'issued', label: '見積書提出済み' },
      { key: 'approval', label: '発注待ち' },
      { key: 'schedule', label: '受注後日程調整必要' },
      { key: 'work', label: '工事待ち' },
      { key: 'report', label: '完了報告必要' },
      { key: 'bill', label: '請求する' },
      { key: 'payment', label: '入金待ち' },
      { key: 'done', label: '済' }
    ]
  };
  const steps = kind => (kind === 'survey' ? STEPS.survey : isWork(kind) ? STEPS.work : []);

  const MARK = { us: '🔴', them: '🟡' };
  const SLOTS = [
    { slot: 'd3', days: 3, label: '3日前' },
    { slot: 'd1', days: 1, label: '前日' }
  ];
  const REMIND_HOUR = 18; // 日本時間 18:00
  const RECIPIENTS = [
    { key: 'client', label: '元請' },
    { key: 'owner', label: '物件オーナー' },
    { key: 'resident', label: '入居者' },
    { key: 'worker', label: '担当者' } // 作業担当者（社内。担当者への確認依頼・担当者向けの前日リマインドだけ。Task 6b）
  ];
  const BILL_TO = { client: '元請', owner: '物件オーナー', resident: '入居者', other: 'その他' };
  // 関係する部屋（case_rooms.role。migration 030 / Task 12）。依頼元の部屋（cases.room）は「この案件の部屋（被害部屋）」
  const ROOM_ROLES = [
    { key: 'cause', label: '加害部屋' },
    { key: 'damage', label: '被害部屋' },
    { key: 'other', label: 'その他' }
  ];
  const ROOM_PREFIX = 'room:'; // 送る相手（mail_drafts.recipients）の関係する部屋の居住者 = 'room:{case_rooms.id}'

  /* ---------- 日本時間 ---------- */
  const JST_MS = 9 * 3600 * 1000;
  const WEEK = '日月火水木金土';
  const pad = n => String(n).padStart(2, '0');
  const str = v => String(v == null ? '' : v).trim();

  // Date / ISO文字列 / ミリ秒 → Date（無効・空は null）
  function toDate(v) {
    if (v == null || v === '') return null;
    const d = v instanceof Date ? new Date(v.getTime()) : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const ms = v => { const d = toDate(v); return d ? d.getTime() : null; };
  // 日本時間の年月日・時分・曜日
  function jst(v) {
    const t = ms(v);
    if (t == null) return null;
    const d = new Date(t + JST_MS);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
      h: d.getUTCHours(), min: d.getUTCMinutes(), w: WEEK[d.getUTCDay()] };
  }
  // 日本時間の日 'YYYY-MM-DD'
  function jstYmd(v) {
    const p = jst(v);
    return p ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : '';
  }
  // 日本時間の月 'YYYY-MM'
  function jstYm(v) { return jstYmd(v).slice(0, 7); }
  // 日本時間の y/m/d h:min の瞬間（Date）。d が範囲外でも繰り上がる（Date.UTC と同じ）
  function jstAt(y, m, d, h, min) { return new Date(Date.UTC(y, m - 1, d, (h || 0) - 9, min || 0)); }

  const fmtMD = v => { const p = jst(v); return p ? `${p.m}/${p.d}` : ''; };                           // 10/20
  const fmtHM = p => `${p.h}:${pad(p.min)}`;                                                           // 9:00
  const fmtMDHM = v => { const p = jst(v); return p ? `${p.m}/${p.d} ${fmtHM(p)}` : ''; };              // 10/20 9:00
  const fmtMDWHM = v => { const p = jst(v); return p ? `${p.m}/${p.d}（${p.w}）${fmtHM(p)}` : ''; };      // 10/17（土）18:00
  const fmtLongDate = p => `${p.y}年${p.m}月${p.d}日（${p.w}）`;
  // 日付だけの値（date 列 'YYYY-MM-DD'）→ 12/7。タイムゾーンで日がずれないよう文字列のまま読む
  const fmtYmdMD = v => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? `${Number(m[2])}/${Number(m[3])}` : ''; };
  // 2026年10月20日（火） 9:00〜 ／ 〜17:00（同じ日）／ 〜10月22日（木） 17:00（別の日）
  function fmtRange(start, end) {
    const s = jst(start);
    if (!s) return '未定';
    let out = `${fmtLongDate(s)} ${fmtHM(s)}〜`;
    const e = jst(end);
    if (e && ms(end) > ms(start)) {
      if (e.y === s.y && e.m === s.m && e.d === s.d) out += fmtHM(e);
      else out += `${e.y === s.y ? '' : e.y + '年'}${e.m}月${e.d}日（${e.w}） ${fmtHM(e)}`;
    }
    return out;
  }

  /* ---------- 表示名 ---------- */
  // 「調査 1回目」。sameKindIndex 省略時は phase.seq（case_summaries の何回目）
  function phaseTitle(phase, sameKindIndex) {
    const label = kindLabel(phase && phase.kind);
    const n = Number(sameKindIndex != null ? sameKindIndex : phase && phase.seq);
    return Number.isInteger(n) && n > 0 ? `${label} ${n}回目` : label;
  }

  /* ---------- 書類の判定 ---------- */
  const listOf = v => (Array.isArray(v) ? v.filter(Boolean) : []);
  const liveEstimates = list => listOf(list).filter(e => e.status !== 'superseded');
  const isAccepted = e => e.status === 'accepted' || e.accepted === true;
  const isReportSent = r => r.status === 'sent' || r.sent === true;
  function docsOf(phase, docs) {
    const d = docs || {};
    return {
      estimates: listOf(d.estimates != null ? d.estimates : phase && phase.estimates),
      reports: listOf(d.reports != null ? d.reports : phase && phase.reports)
    };
  }
  // 報告書の進み具合（一番進んでいるもの）→ { state: 'sent'|'confirmed'|'submitted'|'waiting'|'draft'|null, report, date }
  //   waiting = 下書きで協力業者URLが使える（作業員が入力中）。date は提出日（submitted / confirmed）。
  //   submitted は 作業員がURLから提出したもの（確認が要る）だけ。社内で書いて提出したものは confirmed と同じ扱い（そのまま送れる）
  const REPORT_RANK = { draft: 1, waiting: 2, submitted: 3, confirmed: 4, sent: 5 };
  function reportState(reports) {
    let best = { state: null, report: null, date: null };
    for (const r of listOf(reports)) {
      const st = isReportSent(r) ? 'sent' : r.status === 'confirmed' ? 'confirmed'
        : r.status === 'submitted' ? (r.submitted_via === 'share' ? 'submitted' : 'confirmed')
        : r.share_active ? 'waiting' : 'draft';
      if (!best.state || REPORT_RANK[st] > REPORT_RANK[best.state]) best = { state: st, report: r, date: r.submitted_at || null };
    }
    return best;
  }
  // 工事の「完了報告必要」の括弧の補足（報告書の状態）
  const WORK_REPORT_NOTE = { draft: '（報告書 下書き）', waiting: '（作業員の入力待ち）', submitted: '（報告書 提出済み・確認する）', confirmed: '（報告書 送付する）' };
  // 送付済みで承諾されていない見積（最新の版が sent）。日付は一番新しい送付日
  function pendingApproval(estimates) {
    const pend = liveEstimates(estimates).filter(e => e.status === 'sent');
    if (!pend.length) return null;
    const last = pend.map(e => ms(e.sent_at)).filter(t => t != null).sort((a, b) => b - a)[0];
    return { date: last != null ? new Date(last).toISOString() : null };
  }

  /* ---------- 段階 ---------- */
  function mkStage(key, label, ball, date, extra) {
    return Object.assign({ key, label, ball, date: date || null }, extra || {});
  }
  // 予定の日（日本時間）が今日より前か
  const isLate = (at, now) => !!at && jstYmd(at) < jstYmd(now);

  // 入金待ち（入金期限があれば「入金待ち（期限 12/7）」。期限を過ぎたら late）
  function paymentStage(p, nowAt) {
    const due = p.payment_due ? String(p.payment_due).slice(0, 10) : '';
    return mkStage('payment', due ? `入金待ち（期限 ${fmtYmdMD(due)}）` : '入金待ち', 'them', p.billed_at,
      { late: !!due && due < jstYmd(nowAt), due: due || null });
  }

  // フェーズの今の段階 → { key, label, ball: 'us'|'them'|null, date, late? }
  //   調査（Task 16）: 報告書の状態を先に見る。送付前は
  //     確認済み（🔴 報告書を送る）＞ 提出済み（🔴 報告書を確認する）＞ URL発行済み・未提出（🟡 調査報告待ち）＞ 下書き（🔴 報告書を書く）＞
  //     報告書なし: 調査済み（旧データ。🔴 報告書を送る）／日時未定（🔴 調査日を決める）／日時決定（🔴 M/D H:MM 調査に行く）
  //     送付後 → 見積が送付済みで未承諾（🟡 見積の承諾待ち）→ 入金待ち → 完了
  //   工事（2026-10-20 の7段階）: 1 見積書作成必要 🔴 → 2 見積書提出済み（送付する）🔴 → 3 発注待ち 🟡 → 4 受注後日程調整必要 🔴 →
  //     5 工事待ち（M/D）🟡 → 6 完了報告必要 🔴（工事日を過ぎた or done_at。報告書の状態を括弧で補足）→ 7 請求する 🔴 → 入金待ち 🟡 → 済
  //   工事は 入金・請求・報告書の送付・完了 の記録を先に見る（記録があれば前の段は済んだものとする。旧 対応履歴から移したフェーズは見積が無いため）
  function stage(phase, docs, now) {
    const p = phase || {};
    const { estimates, reports } = docsOf(p, docs);
    const nowAt = toDate(now) || new Date();
    const rs = reportState(reports);
    const reportSent = rs.state === 'sent';
    if (p.kind === 'survey') {
      if (!reportSent) {
        if (rs.state === 'confirmed') return mkStage('report', '報告書を送る', 'us', p.done_at || rs.date);
        if (rs.state === 'submitted') return mkStage('check', '報告書を確認する', 'us', rs.date || p.done_at);
        if (rs.state === 'waiting') return mkStage('waiting', '調査報告待ち', 'them', null);
        if (rs.state === 'draft') return mkStage('write', '報告書を書く', 'us', null);
        if (p.done_at) return mkStage('report', '報告書を送る', 'us', p.done_at);
        if (!p.scheduled_at) return mkStage('schedule', '調査日を決める', 'us', null);
        return mkStage('visit', `${fmtMDHM(p.scheduled_at)} 調査に行く`, 'us', p.scheduled_at,
          { late: isLate(p.scheduled_at, nowAt) });
      }
      const pend = pendingApproval(estimates);
      if (pend) return mkStage('approval', '見積の承諾待ち', 'them', pend.date);
      // 調査費用を請求して入金待ち（精算の段。Task 7）
      if (p.billed_at && !p.paid_at) return paymentStage(p, nowAt);
      return mkStage('done', '完了', null, p.done_at);
    }
    if (isWork(p.kind)) {
      if (p.paid_at) return mkStage('done', '済', null, p.paid_at);
      if (p.billed_at) return paymentStage(p, nowAt);
      if (reportSent) return mkStage('bill', '請求する', 'us', p.done_at || rs.report.sent_at);
      const workReport = () => mkStage('report', '完了報告必要' + (WORK_REPORT_NOTE[rs.state] || ''), 'us', p.done_at || p.scheduled_at,
        { report: rs.state });
      if (p.done_at) return workReport();
      if (!liveEstimates(estimates).some(isAccepted)) {
        const pend = pendingApproval(estimates);
        if (pend) return mkStage('approval', '発注待ち', 'them', pend.date);
        // Task 20: 調査報告の「次の対応方針 = 原因元工事」で見積書提案期日（estimate_due）が入る → 「（期日 M/D）」・過ぎたら late
        const due = p.estimate_due ? String(p.estimate_due).slice(0, 10) : '';
        const dueExtra = due ? { due, late: due < jstYmd(nowAt) } : {};
        if (liveEstimates(estimates).some(e => e.status === 'issued')) {
          return mkStage('issued', due ? `見積書提出済み（送付する・期日 ${fmtYmdMD(due)}）` : '見積書提出済み（送付する）', 'us', due || null, dueExtra);
        }
        return mkStage('estimate', due ? `見積書作成必要（期日 ${fmtYmdMD(due)}）` : '見積書作成必要', 'us', due || null, dueExtra);
      }
      if (!p.scheduled_at) return mkStage('schedule', '受注後日程調整必要', 'us', null);
      // 工事日（終わりの日があればその日）の当日までは 工事待ち、過ぎたら 完了報告必要
      if (isLate(p.scheduled_end && ms(p.scheduled_end) > ms(p.scheduled_at) ? p.scheduled_end : p.scheduled_at, nowAt)) return workReport();
      return mkStage('work', `工事待ち（${fmtMD(p.scheduled_at)}）`, 'them', p.scheduled_at);
    }
    return mkStage('unknown', '', null, null);
  }

  // 案件一覧の「次:」の行。🔴（自社）を先、🟡（相手）を後。同じ色はフェーズの並び順。済んだフェーズは出さない
  //   → [{ phaseId, kind, title, key, label, ball, mark, date, late }]
  function caseNext(phases, now) {
    const list = listOf(phases);
    const count = {};
    const rows = list.map((p, i) => {
      count[p.kind] = (count[p.kind] || 0) + 1;
      const st = stage(p, null, now);
      return { i, row: { phaseId: p.id || null, kind: p.kind, title: phaseTitle(p, p.seq != null ? p.seq : count[p.kind]),
        seq: p.seq != null ? p.seq : count[p.kind],
        key: st.key, label: st.label, ball: st.ball, mark: MARK[st.ball] || '', date: st.date, late: !!st.late,
        workerId: p.worker_id || null, workerName: str(p.worker_name) || null } };
    }).filter(x => x.row.ball);
    const rank = b => (b === 'us' ? 0 : 1);
    rows.sort((a, b) => rank(a.row.ball) - rank(b.row.ball) || a.i - b.i);
    return rows.map(x => x.row);
  }

  // 「次:」の1行の文（caseNext の行）→ '10/20 9:00 調査に行く' / '見積の承諾待ち（10/16 送付）' / '請求する（完了 10/14）'
  function nextText(row) {
    if (!row) return '';
    if (row.key === 'approval' && row.date) return `${row.label}（${fmtMD(row.date)} 送付）`;
    if (row.key === 'check' && row.date) return `${row.label}（提出 ${fmtMD(row.date)}）`;
    if (row.key === 'report' && row.kind !== 'survey') return row.label; // 工事の「完了報告必要」は括弧の補足だけ
    if ((row.key === 'report' || row.key === 'bill') && row.date) {
      return `${row.label}（${row.kind === 'survey' ? '調査' : '完了'} ${fmtMD(row.date)}）`;
    }
    return row.label;
  }

  // 案件一覧のチップ用（caseRow = case_summaries の行）
  //   next: caseNext の行。us / them: 🔴 / 🟡 の段階があるか
  //   mineTurn: 自分が担当する 🔴 の段階がある（その段階のフェーズの作業担当者が自分、または案件の担当者が自分）
  //   mine: 案件の担当者か、どれかのフェーズの作業担当者が自分
  //   unpaid: 請求済み・未入金のフェーズの数
  function caseFlags(caseRow, meId, now) {
    const c = caseRow || {};
    const next = caseNext(c.phases, now);
    const phases = listOf(c.phases);
    const meCase = !!meId && c.assignee_id === meId;
    return {
      next,
      us: next.some(r => r.ball === 'us'),
      them: next.some(r => r.ball === 'them'),
      mineTurn: !!meId && next.some(r => r.ball === 'us' && (meCase || r.workerId === meId)),
      mine: meCase || (!!meId && phases.some(p => p.worker_id === meId)),
      unpaid: phases.filter(p => p.billed_at && !p.paid_at).length
    };
  }

  // チーム状況: 進行中の案件の 🔴 の段階を担当者（フェーズの作業担当者。無ければ案件の担当）ごとに数える。🟡 は相手待ちとして別に一覧
  //   → { summary: { us, them, late, unassigned }, byMember: [{ user_id, name, items, late }], unassigned: [item], waiting: [item] }
  //   item = caseNext の行 + { caseId, caseName, who, whoName, text }。並びは 予定・期限を過ぎたもの → 日付の早い順 → 案件名
  function teamStages(caseRows, members, now) {
    const nameOf = new Map(listOf(members).map(m => [m.user_id, str(m.display_name) || '(名前なし)']));
    const us = [], them = [];
    for (const c of listOf(caseRows)) {
      if (c.status !== 'open') continue;
      for (const r of caseNext(c.phases, now)) {
        const who = r.workerId || c.assignee_id || null;
        const whoName = !who ? '' : nameOf.get(who)
          || (who === r.workerId ? r.workerName : str(c.assignee_name)) || '不明';
        const it = Object.assign({}, r, { caseId: c.id, caseName: str(c.name), who, whoName, text: nextText(r) });
        (r.ball === 'us' ? us : them).push(it);
      }
    }
    const t = x => (x.date ? ms(x.date) : Infinity);
    const sort = list => list.sort((a, b) => (b.late ? 1 : 0) - (a.late ? 1 : 0) || t(a) - t(b)
      || (a.caseName < b.caseName ? -1 : a.caseName > b.caseName ? 1 : 0));
    sort(us); sort(them);
    const mine = new Map();
    us.filter(x => x.who).forEach(x => { if (!mine.has(x.who)) mine.set(x.who, []); mine.get(x.who).push(x); });
    const order = listOf(members).map(m => m.user_id).filter(id => mine.has(id));
    mine.forEach((_, id) => { if (!order.includes(id)) order.push(id); }); // 退会済み等はメンバー順の後ろ
    const byMember = order.map(id => {
      const items = mine.get(id);
      return { user_id: id, name: items[0].whoName, items, late: items.filter(x => x.late).length };
    });
    const unassigned = us.filter(x => !x.who);
    return {
      summary: { us: us.length, them: them.length, late: us.concat(them).filter(x => x.late).length, unassigned: unassigned.length },
      byMember, unassigned, waiting: them
    };
  }

  /* ---------- やること（#tasks。Task 17） ---------- */
  // 🔴（自社）の段階の種類 → グループ。action は行の右のボタン（画面 js/tasks.js が決める操作の種類）
  const TASK_GROUPS = [
    { key: 'estimate', label: '見積書作成必要', action: 'make_estimate' },
    { key: 'send_estimate', label: '見積書を送付', action: 'send_estimate' },
    { key: 'schedule', label: '日程調整必要', action: 'schedule' },
    { key: 'visit', label: '調査に行く', action: null },
    { key: 'write', label: '報告書を書く', action: 'open_report' },
    { key: 'check', label: '報告書を確認する', action: 'open_report' },
    { key: 'send_report', label: '報告書を送る', action: 'send_report' },
    { key: 'work_report', label: '完了報告必要', action: 'work_report' },
    { key: 'bill', label: '請求する', action: 'bill' },
    { key: 'other', label: 'その他', action: null }
  ];
  const TASK_OF = {
    survey: { schedule: 'schedule', visit: 'visit', write: 'write', check: 'check', report: 'send_report' },
    work: { estimate: 'estimate', issued: 'send_estimate', schedule: 'schedule', report: 'work_report', bill: 'bill' }
  };
  function taskGroupOf(kind, key) {
    const m = kind === 'survey' ? TASK_OF.survey : isWork(kind) ? TASK_OF.work : {};
    return m[key] || 'other';
  }
  // 送付する見積（提出済み・未送付の最新）
  function issuedEstimate(estimates) {
    const list = liveEstimates(estimates).filter(e => e.status === 'issued');
    list.sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0) || String(b.id).localeCompare(String(a.id)));
    return list[0] || null;
  }
  // 全案件（進行中・削除されていないもの）の 🔴 の段階を種類ごとにまとめる
  //   opts: { mine: true（既定。me があるとき）= 自分が案件の担当者か、そのフェーズの作業担当者の分だけ, members: [{user_id, display_name}] }
  //   → { groups: [{ key, label, action, items }]（件数のあるものだけ・TASK_GROUPS の順）, total, counts: { all, mine } }
  //   item = { group, action, caseId, caseName, room, phaseId, kind, title, key, label, text, date, late, who, whoName, mine,
  //            reportId, reportStatus, reportState, estimateId, phase, caseRow }
  //   並び（グループの中）: 期限・予定を過ぎたもの → 日付の近い順 → 日付なし（同じなら案件名・フェーズ名）
  function taskGroups(caseRows, me, now, opts) {
    const o = opts || {};
    const mineOnly = o.mine !== undefined ? !!o.mine : !!me;
    const nameOf = new Map(listOf(o.members).map(m => [m.user_id, str(m.display_name) || '(名前なし)']));
    const all = [];
    for (const c of listOf(caseRows)) {
      if (c.status !== 'open' || c.deleted_at) continue;
      const count = {};
      for (const p of listOf(c.phases)) {
        count[p.kind] = (count[p.kind] || 0) + 1;
        const st = stage(p, null, now);
        if (st.ball !== 'us') continue;
        const group = taskGroupOf(p.kind, st.key);
        const def = TASK_GROUPS.find(g => g.key === group);
        const seq = p.seq != null ? p.seq : count[p.kind];
        const workerId = p.worker_id || null;
        const who = workerId || c.assignee_id || null;
        const whoName = !who ? '' : nameOf.get(who) || (who === workerId ? str(p.worker_name) : str(c.assignee_name)) || '不明';
        const rs = reportState(p.reports);
        const est = group === 'send_estimate' ? issuedEstimate(p.estimates) : null;
        const row = { phaseId: p.id || null, kind: p.kind, title: phaseTitle(p, seq), seq, key: st.key, label: st.label, ball: st.ball, date: st.date };
        all.push({
          group, action: def.action, caseId: c.id || null, caseName: str(c.name), room: str(c.room),
          phaseId: p.id || null, kind: p.kind, title: row.title, key: st.key, label: st.label, text: nextText(row),
          date: st.date || null, late: !!st.late, due: st.due || null, who, whoName,
          mine: !!me && (c.assignee_id === me || workerId === me),
          reportId: rs.report ? rs.report.id || null : null, reportStatus: rs.report ? rs.report.status || null : null, reportState: rs.state,
          estimateId: est ? est.id || null : null,
          phase: p, caseRow: c
        });
      }
    }
    const t = x => (x.date ? ms(x.date) : null);
    const cmp = (a, b) => {
      if (a.late !== b.late) return a.late ? -1 : 1;
      const ta = t(a), tb = t(b);
      if (ta != null && tb != null && ta !== tb) return ta - tb;
      if ((ta == null) !== (tb == null)) return ta == null ? 1 : -1;
      return (a.caseName < b.caseName ? -1 : a.caseName > b.caseName ? 1 : 0) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
    };
    const shown = mineOnly ? all.filter(x => x.mine) : all;
    const groups = TASK_GROUPS.map(g => ({ key: g.key, label: g.label, action: g.action, items: shown.filter(x => x.group === g.key).sort(cmp) }))
      .filter(g => g.items.length > 0);
    return { groups, total: shown.length, counts: { all: all.length, mine: all.filter(x => x.mine).length } };
  }

  /* ---------- リマインド ---------- */
  // 予定（scheduledAt）の3日前・前日の 18:00（日本時間）。createdAt（予定を入れた時刻）で既に過ぎている枠は除く
  //   → [{ slot: 'd3'|'d1', label, at: ISO, remind_for: 'YYYY-MM-DD'（予定の日・日本時間） }]
  function reminderSlots(scheduledAt, createdAt) {
    const s = jst(scheduledAt);
    if (!s) return [];
    const from = ms(createdAt);
    const remindFor = jstYmd(scheduledAt);
    return SLOTS.map(x => ({ slot: x.slot, label: x.label,
      at: jstAt(s.y, s.m, s.d - x.days, REMIND_HOUR, 0).toISOString(), remind_for: remindFor }))
      .filter(x => from == null || ms(x.at) > from);
  }

  const isReminderOf = (d, phaseId) => d && d.purpose === 'reminder' && d.phase_id === phaseId;
  // 予定を入れた時刻。phase.schedule_set_at があればそれ。無ければ そのフェーズの日程連絡（purpose schedule）の
  // 一番新しい下書きの時刻（未送信は updated_at = 日時を変えて本文を更新した時、送信済み・送らないは created_at）。
  // それも無ければ phase.updated_at → created_at、どれも無ければ null（枠を除かない）
  function scheduleSetAt(phase, drafts) {
    if (phase.schedule_set_at) return phase.schedule_set_at;
    const own = listOf(drafts).filter(d => d.purpose === 'schedule' && d.phase_id === phase.id)
      .sort((a, b) => (ms(b.created_at) || 0) - (ms(a.created_at) || 0));
    if (own.length) {
      const d = own[0];
      return d.status === 'draft' && !d.skipped_at ? (d.updated_at || d.created_at) : d.created_at;
    }
    return phase.updated_at || phase.created_at || null;
  }

  // 今作るリマインド（アプリを開いた時に呼ぶ）→ [{ phase_id, kind, slot, label, at, remind_for }]
  //   対象: 日時が入っていて未完了・予定の時刻より前。時刻（18:00）を過ぎていて、同じ (phase_id, slot, remind_for) の
  //   下書きが無い（送信済み・送らないも含めて1回だけ）。前日の枠も過ぎていたら 3日前 は作らない（前日だけ）
  function dueReminders(phases, existingDrafts, now) {
    const nowMs = ms(now) != null ? ms(now) : Date.now();
    const drafts = listOf(existingDrafts);
    const out = [];
    for (const p of listOf(phases)) {
      if (!p.id || !p.scheduled_at || p.done_at || !KIND_KEYS.includes(p.kind)) continue;
      if (nowMs >= ms(p.scheduled_at)) continue;
      let due = reminderSlots(p.scheduled_at, scheduleSetAt(p, drafts)).filter(s => ms(s.at) <= nowMs);
      if (due.some(s => s.slot === 'd1')) due = due.filter(s => s.slot === 'd1');
      for (const s of due) {
        const exists = drafts.some(d => isReminderOf(d, p.id) && d.remind_slot === s.slot && d.remind_for === s.remind_for);
        if (!exists) out.push({ phase_id: p.id, kind: p.kind, slot: s.slot, label: s.label, at: s.at, remind_for: s.remind_for });
      }
    }
    return out;
  }

  // 消して作り直す未送信のリマインド（日時が変わった・日時を消した・完了した・フェーズが無い）→ mail_drafts の行
  //   担当者向けの前日のお知らせ（staff_notice ＋ remind_slot）も含める
  //   now を渡すと、予定の時刻を過ぎた未送信のリマインドも含める（予定が終わった後のお知らせは送らない）
  function staleReminders(phases, drafts, now) {
    const byId = new Map(listOf(phases).map(p => [p.id, p]));
    const nowMs = ms(now);
    return listOf(drafts).filter(d => {
      const staff = d.purpose === 'staff_notice' && !!d.remind_slot; // 担当者向けの前日のお知らせ（Task 6b）も同じ規則。担当者がいなくなっても消す
      if ((d.purpose !== 'reminder' && !staff) || d.status !== 'draft') return false;
      const p = byId.get(d.phase_id);
      // 担当者向けは、担当者がいなくなった・別の人に変わった（027 の worker_id）ときも消す
      if (!p || !p.scheduled_at || p.done_at || (staff && (!p.worker_id || (d.worker_id && d.worker_id !== p.worker_id)))) return true;
      if (nowMs != null && nowMs >= ms(p.scheduled_at)) return true;
      return d.remind_for !== jstYmd(p.scheduled_at);
    });
  }

  // カードに出すリマインドの状態 → { none, slots: [{ slot, label, at, state, draft }] }
  //   state: 'planned'（時刻前）| 'due'（時刻を過ぎた・まだ作られていない＝次に一覧を開いたとき作る）|
  //          'draft'（下書きあり）| 'sent'（送信済み）| 'skipped'（今回は送らない）
  //   予定を入れた時点で過ぎていた枠・前日の枠も過ぎて作らない 3日前 は出さない。
  //   予定の時刻を過ぎた・完了したフェーズは、作ったもの（送信済み・送らない）だけ出す
  function reminderState(phase, drafts, now) {
    const p = phase || {};
    const nowMs = ms(now) != null ? ms(now) : Date.now();
    if (!p.scheduled_at) return { none: true, slots: [] };
    const remindFor = jstYmd(p.scheduled_at);
    const own = listOf(drafts).filter(d => isReminderOf(d, p.id) && d.remind_for === remindFor)
      .sort((a, b) => (ms(b.created_at) || 0) - (ms(a.created_at) || 0));
    const planned = reminderSlots(p.scheduled_at, scheduleSetAt(p, drafts));
    const open = !p.done_at && nowMs < ms(p.scheduled_at);
    const d1Passed = planned.some(s => s.slot === 'd1' && ms(s.at) <= nowMs);
    const slots = [];
    for (const x of SLOTS) {
      const d = own.find(m => m.remind_slot === x.slot) || null;
      const plan = planned.find(s => s.slot === x.slot);
      const [yy, mm, dd] = remindFor.split('-').map(Number);
      const at = plan ? plan.at : jstAt(yy, mm, dd - x.days, REMIND_HOUR, 0).toISOString();
      let state;
      if (d) state = d.status === 'sent' ? 'sent' : d.skipped_at ? 'skipped' : 'draft';
      else if (!open || !plan) continue;
      else if (ms(plan.at) > nowMs) state = 'planned';
      else if (x.slot === 'd3' && d1Passed) continue;
      else state = 'due';
      slots.push({ slot: x.slot, label: x.label, at, state, draft: d });
    }
    return { none: slots.length === 0, slots };
  }

  /* ---------- 送るメール（#outbox） ---------- */
  // メールの種類の表示名（「調査日のご連絡」「工事日のお知らせ（前日・原因元工事）」「報告書の送付」等）
  function mailLabel(draft, phase) {
    const d = draft || {};
    const k = phase && phase.kind;
    if (d.purpose === 'schedule' || d.purpose === 'reminder') {
      const head = k === 'survey' ? '調査日' : isWork(k) ? '工事日' : '日程';
      if (d.purpose === 'schedule') return `${head}のご連絡${isWork(k) ? `（${kindLabel(k)}）` : ''}`;
      const sl = (SLOTS.find(x => x.slot === d.remind_slot) || {}).label;
      const tail = [sl, isWork(k) ? kindLabel(k) : ''].filter(Boolean).join('・');
      return `${head}のお知らせ${tail ? `（${tail}）` : ''}`;
    }
    if (d.purpose === 'survey_result') return '調査結果のご報告';
    if (d.purpose === 'staff_notice') return d.remind_slot ? '担当者への前日のお知らせ' : '担当者への確認依頼';
    if (d.purpose === 'estimate' || d.estimate_id) return '見積書の送付';
    return '報告書の送付';
  }
  // 宛先の種類（recipients）→ 「元請・入居者・加害部屋 402」（元請・物件オーナー・入居者・関係する部屋の順）。
  //   関係する部屋は caseRow（case_summaries の行。rooms）があれば「加害部屋 402」、無い・消された部屋は「関係する部屋」（1回）
  function recipientsLabel(keys, caseRow) {
    const set = new Set(listOf(keys));
    const out = RECIPIENTS.filter(r => r.key !== 'worker' && set.has(r.key)).map(r => r.label);
    const rs = roomsOf(caseRow);
    let unknown = false;
    listOf(keys).filter(isRoomKey).forEach(k => {
      const r = rs.find(x => roomKey(x.id) === k);
      if (r) { const t = roomTitle(r); if (!out.includes(t)) out.push(t); } else unknown = true;
    });
    if (unknown) out.push('関係する部屋');
    if (set.has('worker')) out.push('担当者');
    return out.join('・');
  }
  // 「今回は送らない」にできるのは日程連絡・リマインド・調査結果のご報告だけ（書類の送付はできない）
  const canSkip = d => !!d && (d.purpose === 'schedule' || d.purpose === 'reminder' || d.purpose === 'survey_result' || d.purpose === 'staff_notice');
  // 未送信（送らないを除く）の下書きを案件ごとにまとめる。caseRows は case_summaries の行（phases 付き）
  //   → [{ caseRow, items: [{ draft, phase, label, title, canSkip }] }]（下書きの作成順。案件は一番古い下書きの順）
  function groupOutbox(caseRows, drafts) {
    const cases = new Map(listOf(caseRows).map(c => [c.id, c]));
    const groups = new Map();
    const sorted = listOf(drafts).slice().sort((a, b) => (ms(a.created_at) || 0) - (ms(b.created_at) || 0));
    for (const d of sorted) {
      if (d.status !== 'draft' || d.skipped_at) continue;
      const c = cases.get(d.case_id);
      if (!c) continue;
      const p = listOf(c.phases).find(x => x.id === d.phase_id) || null;
      if (!groups.has(c.id)) groups.set(c.id, { caseRow: c, items: [] });
      groups.get(c.id).items.push({ draft: d, phase: p, label: mailLabel(d, p), title: p ? phaseTitle(p) : '', canSkip: canSkip(d), caseRow: c });
    }
    return [...groups.values()];
  }

  /* ---------- 関係する部屋（Task 12） ---------- */
  const roomKey = id => ROOM_PREFIX + id;
  const isRoomKey = k => typeof k === 'string' && k.startsWith(ROOM_PREFIX) && k.length > ROOM_PREFIX.length;
  const roomRoleLabel = role => (ROOM_ROLES.find(x => x.key === role) || ROOM_ROLES[2]).label;
  // case_summaries.rooms（並びは DB の sort → 作成順のまま）。id と号室のあるものだけ
  const roomsOf = caseRow => listOf(caseRow && caseRow.rooms).filter(r => r && r.id && str(r.room));
  // 「加害部屋 402」（号室は入力のまま）
  const roomTitle = r => [roomRoleLabel(r && r.role), str(r && r.room)].filter(Boolean).join(' ');
  // 送る相手のキーの並び（保存する recipients の順）: 元請・物件オーナー・入居者・関係する部屋（並び順）・担当者
  const recipientOrder = caseRow => ['client', 'owner', 'resident'].concat(roomsOf(caseRow).map(r => roomKey(r.id)), ['worker']);
  // 工事掲示の号室の初期値の候補（Task 12）: この案件の部屋（cases.room）→ 関係する部屋。同じ号室は1回
  //   → [{ value: '402', label: '加害部屋 402', key: 'case' | 'room:{id}' }]
  function roomChoices(caseRow) {
    const c = caseRow || {};
    const out = [];
    if (str(c.room)) out.push({ value: str(c.room), label: 'この案件の部屋（被害部屋） ' + str(c.room), key: 'case' });
    roomsOf(c).forEach(r => {
      if (out.some(x => x.value === str(r.room))) return;
      out.push({ value: str(r.room), label: roomTitle(r), key: roomKey(r.id) });
    });
    return out;
  }

  /* ---------- 関係者・宛先 ---------- */
  const clientName = c => str(c && (c.client_master_name || c.client_name));
  // 案件の関係者 → [{ key, label, name, email, tel }]（元請・物件オーナー・入居者・関係する部屋の居住者の順。名前もメールも無い人も含む）
  //   関係する部屋の居住者（Task 12）: key 'room:{id}'・label「加害部屋 402」・room: 部屋の行
  function contacts(caseRow) {
    const c = caseRow || {};
    return [
      { key: 'client', label: '元請', name: clientName(c), email: str(c.client_email), tel: str(c.client_tel) },
      { key: 'owner', label: '物件オーナー', name: str(c.owner_name), email: str(c.owner_email), tel: str(c.owner_tel) },
      { key: 'resident', label: '入居者', name: str(c.resident_name), email: str(c.resident_email), tel: str(c.resident_tel) }
    ].concat(roomsOf(c).map(r => ({ key: roomKey(r.id), label: roomTitle(r), name: str(r.resident_name),
      email: str(r.email), tel: str(r.tel), room: r })))
      .concat(str(c.worker_name) || str(c.worker_email)
      ? [{ key: 'worker', label: '担当者', name: str(c.worker_name), email: str(c.worker_email), tel: '' }] : []);
  }
  // 送る相手の一覧での表示「加害部屋 402 山本様」（関係する部屋）／「入居者 佐藤」（依頼元。今までどおり）
  function contactTitle(c) {
    if (!c) return '';
    if (c.room) return c.name ? `${c.label} ${withSama(c.name)}` : c.label;
    return c.label + (c.name ? ' ' + c.name : '');
  }
  // 宛先の既定（mail_drafts.recipients の値）。メールがある人だけ
  //   schedule・survey_result: 元請・物件オーナー・入居者 ／ reminder: 入居者・物件オーナー ／ それ以外（報告書・見積）: 元請
  //   関係する部屋の居住者は既定では選ばない（その場で選ぶ）。extraKeys（例: リマインドに日程連絡で選んだ部屋）を渡すと、
  //   今もある部屋でメールがあるものだけ後ろに足す
  function defaultRecipients(caseRow, purpose, extraKeys) {
    // staff_notice（担当者への確認依頼・前日のお知らせ）は担当者だけ（メールが無くても選ぶ: アプリ内の通知と文面コピーで伝える）
    if (purpose === 'staff_notice') return contacts(caseRow).some(x => x.key === 'worker') ? ['worker'] : [];
    const order = purpose === 'schedule' || purpose === 'survey_result' ? ['client', 'owner', 'resident']
      : purpose === 'reminder' ? ['resident', 'owner'] : ['client'];
    const has = new Set(contacts(caseRow).filter(x => x.email).map(x => x.key));
    const extra = new Set(listOf(extraKeys).filter(isRoomKey));
    return order.filter(k => has.has(k)).concat(recipientOrder(caseRow).filter(k => extra.has(k) && has.has(k)));
  }

  /* ---------- 連絡メール（Task 6c: 宛名・書き出し・内容詳細・署名の形をそろえる） ---------- */
  // 本文の形（調査・工事・リマインド・調査結果のご報告・担当者向けで共通）:
  //   {宛名: 送る相手ごとに1行}            ← 送る相手が無ければこの段落ごと無い
  //   （空行）
  //   お世話になっております。
  //   {会社名}でございます。               ← 会社名が無ければ省く
  //   {本文}
  //   （空行）
  //   何卒よろしくお願いいたします。
  //   （空行）
  //   {署名: 会社名　担当 名前 / TEL / メール。無い行は省く}
  // 「いつもお世話になっております」「ご都合の悪い点…」は使わない
  const GREETING = 'お世話になっております。';
  const CLOSING = '何卒よろしくお願いいたします。';
  const withSama = n => (/(様|御中|さん)$/.test(n) ? n : n + '様');
  // 号室の表示: 数字・英字で終わるなら「号室」を足す（302 → 302号室、A-1 → A-1号室）。それ以外（302号室・A棟 など）はそのまま
  function roomLabel(room) {
    const r = str(room);
    if (!r) return '';
    return /[0-9０-９A-Za-zＡ-Ｚａ-ｚ]$/.test(r) ? r + '号室' : r;
  }
  // 物件名＋号室（「グランメゾン世田谷 302号室」）。物件名に号室が含まれていてもそのまま足す
  const placeName = (c, sep) => [str(c && c.name), roomLabel(c && c.room)].filter(Boolean).join(sep || ' ');
  function placeLines(c) {
    const lines = [`場所: ${placeName(c, '　')}`];
    if (str(c.address)) lines.push(`住所: ${str(c.address)}`);
    return lines;
  }
  function signature(org, me) {
    const o = org || {};
    const name = str(o.name);
    const person = str(me && (me.display_name || me.name));
    const lines = [];
    if (name || person) lines.push([name, person ? `担当 ${person}` : ''].filter(Boolean).join('　'));
    if (str(o.tel)) lines.push(`TEL: ${str(o.tel)}`);
    if (str(o.email)) lines.push(`メール: ${str(o.email)}`);
    return lines;
  }
  function subjectOf(head, kind, caseRow) {
    const name = placeName(caseRow || {});
    return `【${head}】${name}${isWork(kind) ? `（${kindLabel(kind)}）` : ''}`;
  }
  // 宛名の1行。元請 =「{会社名} {担当者名}様」（担当者名が無ければ「{会社名} 御中」）／
  // 物件オーナー・入居者 =「{物件名} {号室} {名前}様」（名前が無ければ「物件オーナー様」「入居者様」）／
  // 作業担当者（worker。Task 6b）=「{名前}さん」（caseRow.worker_name）
  function addresseeLine(caseRow, key) {
    const c = caseRow || {};
    if (key === 'client') {
      const n = clientName(c);
      const p = str(c.client_contact);
      if (n) return p ? `${n} ${withSama(p)}` : `${n} 御中`;
      return p ? withSama(p) : 'ご担当者様';
    }
    if (key === 'owner' || key === 'resident') {
      const n = str(key === 'owner' ? c.owner_name : c.resident_name);
      if (!n) return key === 'owner' ? '物件オーナー様' : '入居者様';
      return [placeName(c), withSama(n)].filter(Boolean).join(' ');
    }
    if (key === 'worker') {
      const n = str(c.worker_name);
      return n ? (/(さん|様)$/.test(n) ? n : n + 'さん') : '担当者さん';
    }
    // 関係する部屋の居住者（Task 12）=「{物件名} {その部屋の号室} {名前}様」（名前が無ければ「… 入居者様」）。消された部屋は ''
    if (isRoomKey(key)) {
      const r = roomsOf(c).find(x => roomKey(x.id) === key);
      if (!r) return '';
      const place = placeName({ name: c.name, room: r.room });
      return [place, str(r.resident_name) ? withSama(str(r.resident_name)) : '入居者様'].filter(Boolean).join(' ');
    }
    return '';
  }
  // 宛名の並び: 担当者・元請・物件オーナー・入居者・関係する部屋（並び順）
  const addresseeOrder = caseRow => ['worker', 'client', 'owner', 'resident'].concat(roomsOf(caseRow).map(r => roomKey(r.id)));
  // 送る相手（mail_drafts.recipients）→ 宛名の行の配列（元請・物件オーナー・入居者・関係する部屋の順。同じ行は1回）
  function addresseeLines(caseRow, keys) {
    const set = new Set(listOf(keys));
    const out = [];
    addresseeOrder(caseRow).filter(k => set.has(k)).forEach(k => { const l = addresseeLine(caseRow, k); if (l && !out.includes(l)) out.push(l); });
    return out;
  }
  // 本文の宛名の行だけを差し替える（送る相手のチェックを変えたとき・1人分の文面をコピーするとき）。
  //   「お世話になっております。」より前を宛名とみなして入れ替える（本文の手直しは残る）。
  //   書き出しが消されているときは、前の宛名（prevLines）が先頭にそのまま残っていればそこだけ差し替え、無ければ本文を変えない
  function setAddressee(body, lines, prevLines) {
    const src = String(body == null ? '' : body);
    const all = src.split('\n');
    const block = listOf(lines).length ? listOf(lines).concat(['']) : [];
    const g = all.indexOf(GREETING);
    if (g >= 0) return block.concat(all.slice(g)).join('\n');
    const prev = listOf(prevLines);
    if (prev.length && prev.every((l, k) => all[k] === l)) {
      let j = prev.length;
      if (all[j] === '') j++;
      return block.concat(all.slice(j)).join('\n');
    }
    return src;
  }
  function wrapMail(caseRow, recipients, org, me, bodyLines) {
    const lines = [];
    const ad = addresseeLines(caseRow, recipients);
    if (ad.length) lines.push(...ad, '');
    lines.push(GREETING);
    if (str(org && org.name)) lines.push(`${str(org.name)}でございます。`);
    lines.push(...bodyLines, '', CLOSING);
    const sig = signature(org, me);
    if (sig.length) lines.push('', ...sig);
    return lines.join('\n');
  }
  const kindFrom = (kind, phase) => (KIND_KEYS.includes(kind) ? kind : phase && phase.kind);
  const rcptOf = (recipients, caseRow, purpose) => (Array.isArray(recipients) ? recipients : defaultRecipients(caseRow, purpose));

  /* ---- 現場担当への指示（case_phases.plan。migration 028。Task 9） ---- */
  // 社内だけで使う（担当者への確認依頼・前日のお知らせの本文、🔔 の一覧、フェーズ詳細ページ）。お客様向けのメールには一切出さない
  const BRIEF_SUSPECTS = [
    { key: 'bath', label: '浴室' }, { key: 'ceiling', label: '天井' }, { key: 'wall', label: '壁' }, { key: 'floor', label: '床' },
    { key: 'kitchen', label: 'キッチン' }, { key: 'washroom', label: '洗面' }, { key: 'toilet', label: 'トイレ' },
    { key: 'washer', label: '洗濯機' }, { key: 'water_heater', label: '給湯器' }, { key: 'pipe', label: '給排水管' },
    { key: 'balcony', label: 'バルコニー' }, { key: 'common', label: '共用部' }, { key: 'other', label: 'その他' }
  ];
  const BRIEF_PRIORITY = [
    { key: 'upstairs', label: '上階の水回り' }, { key: 'own_room', label: '当該室の水回り' }, { key: 'underfloor', label: '床下・隠蔽部' },
    { key: 'exterior', label: '外壁・サッシ' }, { key: 'common_pipe', label: '共用配管' }, { key: 'other', label: 'その他' }
  ];
  const BRIEF_HEADS = ['■ 怪しい箇所', '■ 優先して調べる', '■ 指示', '■ 当日の注意'];
  const txt = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
  // DB の値 → 画面の形（足りないキーは空・知らない値は落とす・並びはボタンの順）。文字列は入力中の値のまま
  function normalizeBrief(raw) {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const pickList = (v, list) => { const set = new Set(Array.isArray(v) ? v : []); return list.map(x => x.key).filter(k => set.has(k)); };
    return { suspects: pickList(r.suspects, BRIEF_SUSPECTS), priority: pickList(r.priority, BRIEF_PRIORITY),
      note: txt(r.note), visitNote: txt(r.visitNote) };
  }
  const labelsOf = (list, keys) => keys.map(k => (list.find(x => x.key === k) || {}).label).filter(Boolean);
  // 文章の欄 → 行（前後の空白と空行を除く。メールの段落の区切りと混ざらないように）
  const textLines = v => txt(v).split('\n').map(l => l.trim()).filter(Boolean);
  // 担当者へのメールの指示の段落（■ 怪しい箇所 ■ 優先して調べる ■ 指示 ■ 当日の注意。空の項目は出さない）→ 行の配列（全部空なら []）
  function briefLines(raw) {
    const b = normalizeBrief(raw);
    const blocks = [];
    const sus = labelsOf(BRIEF_SUSPECTS, b.suspects);
    if (sus.length) blocks.push([BRIEF_HEADS[0], sus.join('・')]);
    const pri = labelsOf(BRIEF_PRIORITY, b.priority);
    if (pri.length) blocks.push([BRIEF_HEADS[1], pri.join('・')]);
    if (textLines(b.note).length) blocks.push([BRIEF_HEADS[2], ...textLines(b.note)]);
    if (textLines(b.visitNote).length) blocks.push([BRIEF_HEADS[3], ...textLines(b.visitNote)]);
    return blocks.reduce((out, x, i) => out.concat(i ? [''] : [], x), []);
  }
  const hasBrief = raw => briefLines(raw).length > 0;
  // 1行の要約（🔔 の一覧・作業担当者の段）→ '怪しい: 浴室・天井 ／ 優先: 上階の水回り ／ 指示: 上階 402 の… ／ 当日: 鍵は管理人室'。空なら ''
  function briefSummary(raw, max) {
    const b = normalizeBrief(raw);
    const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
    const parts = [];
    const sus = labelsOf(BRIEF_SUSPECTS, b.suspects);
    if (sus.length) parts.push('怪しい: ' + sus.join('・'));
    const pri = labelsOf(BRIEF_PRIORITY, b.priority);
    if (pri.length) parts.push('優先: ' + pri.join('・'));
    const note = textLines(b.note).join(' ');
    if (note) parts.push('指示: ' + cut(note, 30));
    const visit = textLines(b.visitNote).join(' ');
    if (visit) parts.push('当日: ' + cut(visit, 20));
    return cut(parts.join(' ／ '), max || 120);
  }
  // 担当者へのメールの本文の指示の段落だけを差し替える（指示を変えたとき。本文の手直しは残る）。
  //   段落が無ければ「内容を確認したら…」「詳しくは…」の行（STAFF_TAILS）の前に入れる。置き場所が分からなければ null（呼ぶ側で作り直す）
  function setBriefSection(body, lines) {
    const src = String(body == null ? '' : body);
    const all = src.split('\n');
    const brief = Array.isArray(lines) ? lines.map(String) : []; // 項目の間の空行を残す（listOf は空文字を落とす）
    const isHead = l => BRIEF_HEADS.includes(l);
    const h = all.findIndex(isHead);
    if (h >= 0) {
      let e = h;
      for (;;) { // 見出し＋空行までを1つの項目として、続く限り読む
        e++;
        while (e < all.length && all[e] !== '') e++;
        if (e + 1 < all.length && all[e] === '' && isHead(all[e + 1])) { e++; continue; }
        break;
      }
      if (brief.length) return all.slice(0, h).concat(brief, all.slice(e)).join('\n');
      const s0 = h > 0 && all[h - 1] === '' ? h - 1 : h;
      return all.slice(0, s0).concat(all.slice(e)).join('\n');
    }
    if (!brief.length) return src;
    const t = all.findIndex(l => STAFF_TAILS.includes(l));
    if (t < 0) return null;
    const before = all.slice(0, t);
    while (before.length && before[before.length - 1] === '') before.pop();
    return before.concat([''], brief, [''], all.slice(t)).join('\n');
  }

  function scheduleBody(k, phase, caseRow, org, me, recipients, leadLine) {
    const p = phase || {};
    const lines = [leadLine, ''];
    lines.push(`${k === 'survey' ? '調査日時' : '工事日時'}: ${fmtRange(p.scheduled_at, p.scheduled_end)}`);
    lines.push(...placeLines(caseRow || {}));
    return wrapMail(caseRow, recipients, org, me, lines);
  }
  // 入居者あての定型文（js/mail-templates.js）。kind に定型文が無ければ null
  const MT = () => (inNode ? require('./mail-templates.js') : root.MailTemplates);
  function residentTemplate(k) { const m = MT(); return m ? m.residentSchedule(k) : null; }
  // 日程連絡の本文の形: 'resident'（送る相手に入居者扱いの人 = この案件の入居者か関係する部屋の居住者が含まれ、
  //   定型文がある種類 = 今は調査だけ）／'short'（今の短い形）
  const hasResident = recipients => listOf(recipients).some(k => k === 'resident' || isRoomKey(k));
  function scheduleForm(kind, recipients) {
    return hasResident(recipients) && residentTemplate(kind) ? 'resident' : 'short';
  }
  // 名乗りの行: 「{会社名}の{担当者名}と申します。」（片方だけなら「{会社名}でございます。」「{担当者名}と申します。」）
  function introLine(org, me) {
    const o = str(org && org.name);
    const n = str(me && (me.display_name || me.name));
    if (o && n) return `${o}の${n}と申します。`;
    if (o) return `${o}でございます。`;
    return n ? `${n}と申します。` : '';
  }
  function residentBody(k, phase, caseRow, org, me, recipients) {
    const p = phase || {};
    const lines = [];
    const ad = addresseeLines(caseRow, recipients);
    if (ad.length) lines.push(...ad, '');
    lines.push(...MT().fill(residentTemplate(k), { 名乗り: introLine(org, me), 日時: fmtRange(p.scheduled_at, p.scheduled_end) }));
    const sig = signature(org, me);
    if (sig.length) lines.push('', ...sig);
    return lines.join('\n');
  }

  // 調査日・工事日の連絡（purpose schedule）→ { subject, body }。recipients（送る相手のキー）を省くと既定（defaultRecipients）
  //   送る相手に入居者が含まれる調査は入居者あての定型文（Task 9。js/mail-templates.js）。それ以外（元請・物件オーナーだけ・工事）は短い形
  function scheduleMail({ kind, phase, caseRow, org, me, recipients } = {}) {
    const k = kindFrom(kind, phase);
    const survey = k === 'survey';
    const rc = rcptOf(recipients, caseRow, 'schedule');
    return {
      subject: subjectOf(survey ? '調査日のご連絡' : '工事日のご連絡', k, caseRow),
      body: scheduleForm(k, rc) === 'resident' ? residentBody(k, phase, caseRow, org, me, rc)
        : scheduleBody(k, phase, caseRow, org, me, rc, survey ? '下記の日程で調査に伺います。' : `下記の日程で${kindLabel(k)}を行います。`)
    };
  }
  // リマインド（purpose reminder。slot 'd3'|'d1'）→ { subject, body }
  function reminderMail({ kind, phase, caseRow, org, me, slot, recipients } = {}) {
    const k = kindFrom(kind, phase);
    const survey = k === 'survey';
    const sl = (SLOTS.find(x => x.slot === slot) || SLOTS[0]).label;
    const what = survey ? '調査' : kindLabel(k);
    return {
      subject: subjectOf(`${survey ? '調査日' : '工事日'}のお知らせ（${sl}）`, k, caseRow),
      body: scheduleBody(k, phase, caseRow, org, me, rcptOf(recipients, caseRow, 'reminder'),
        `${what}の日が近づいてまいりましたので、改めてご案内いたします。`)
    };
  }

  /* ---------- 調査結果と注意事項（Task 5b。case_phases.result） ---------- */
  // 文言の元は工事掲示（NoticeLogic.WORK_TYPES）と見積（EstimateLogic.NOTE_FIRST）。phase-logic.js の方が先に読み込まれるので、
  // 使うときに取りに行く（node は require）
  const inNode = typeof module !== 'undefined' && module.exports && typeof require === 'function';
  const NL = () => (inNode ? require('./notice-logic.js') : root.NoticeLogic);
  const EL = () => (inNode ? require('./estimate-logic.js') : root.EstimateLogic);
  const MOVE_ITEMS_TEXT = '作業範囲の荷物の移動をお願いいたします。';
  const EXTRA_CAUTIONS = [
    { key: 'power_water', label: '電気・水道の提供をお願い' },
    { key: 'move_items', label: '荷物の移動をお願い' }
  ];
  // 注意事項のボタンの並び: 工事掲示の工事内容（その他を除く）→ 電気・水道 → 荷物 → その他（自由記入）。label は WORK_TYPES のまま
  function cautionChoices() {
    const wt = NL().WORK_TYPES;
    const pick = w => ({ key: w.key, label: w.label, extra: w.extra ? Object.assign({}, w.extra) : null });
    return wt.filter(w => w.key !== 'other').map(pick).concat(EXTRA_CAUTIONS.map(x => Object.assign({ extra: null }, x)),
      wt.filter(w => w.key === 'other').map(pick));
  }
  const cautionKeys = () => cautionChoices().map(c => c.key);
  const text = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
  // DB の値 → 画面の形（足りないキーは空。知らない注意事項は落とす。並びはボタンの順）。文字列は前後の空白も残す（入力中の値）
  function normalizeResult(raw) {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const set = new Set(Array.isArray(r.cautions) ? r.cautions : []);
    return {
      cause: text(r.cause), why: text(r.why), scope: text(r.scope),
      cautions: cautionKeys().filter(k => set.has(k)),
      cautionOther: text(r.cautionOther), drainRooms: text(r.drainRooms)
    };
  }
  // 何か入っているか（3つの文章のどれか・注意事項のどれか）
  function hasResult(raw) {
    const r = normalizeResult(raw);
    return !!(str(r.cause) || str(r.why) || str(r.scope) || r.cautions.length);
  }
  // 選んだ注意事項 → 文の配列。工事掲示の文（騒音+振動は「騒音・振動」の1文、その他は句点を足す: NoticeLogic.bodySentences）、
  // 電気・水道は見積の NOTE_FIRST、荷物は「作業範囲の荷物の移動をお願いいたします。」。同じ文は1回。その他は最後
  function cautionSentences(raw) {
    const r = normalizeResult(raw);
    const on = new Set(r.cautions);
    const workTypes = {};
    NL().WORK_TYPES.forEach(w => { workTypes[w.key] = on.has(w.key) && w.key !== 'other'; });
    const out = NL().bodySentences({ workTypes });
    if (on.has('power_water')) out.push(EL().NOTE_FIRST);
    if (on.has('move_items')) out.push(MOVE_ITEMS_TEXT);
    if (on.has('other')) out.push(...NL().bodySentences({ workTypes: { other: true }, otherWorkText: r.cautionOther }));
    return out.filter((t, i) => t && out.indexOf(t) === i);
  }
  // 調査結果のご報告（purpose survey_result）→ { subject, body }。空の欄の見出しは出さない。宛名・書き出し・署名は日程連絡と同じ形
  function surveyResultMail({ phase, caseRow, org, me, recipients } = {}) {
    const p = phase || {};
    const r = normalizeResult(p.result);
    const lines = [];
    const day = jst(p.done_at || p.scheduled_at);
    lines.push(day ? `${day.m}月${day.d}日に実施した調査の結果をご報告いたします。` : '調査の結果をご報告いたします。');
    const section = (head, body) => { if (str(body)) lines.push('', `■ ${head}`, str(body)); };
    section('原因', r.cause);
    section('経緯', r.why);
    section('復旧工事の範囲', r.scope);
    const sentences = cautionSentences(r);
    if (sentences.length) {
      lines.push('', '■ 工事の際のお願い・ご注意');
      const drainText = (NL().WORK_TYPES.find(w => w.key === 'drain') || {}).text;
      const rooms = r.cautions.includes('drain') ? NL().normalizeRooms(r.drainRooms) : '';
      sentences.forEach(t => {
        lines.push('・' + t);
        if (rooms && t === drainText) lines.push(`　（排水制限のかかる号室: ${rooms}）`);
      });
    }
    lines.push('', 'お見積書は別途お送りいたします。');
    return { subject: subjectOf('調査結果のご報告', 'survey', caseRow),
      body: wrapMail(caseRow, rcptOf(recipients, caseRow, 'survey_result'), org, me, lines) };
  }
  /* ---- 作業担当者への確認依頼（Task 6b） ---- */
  // カードへのリンク（base: アプリの URL。# 以降は付け直す）。opts.field: 担当者がスタッフ → 現場用のツールページ #f/case/{id}（Task 18）
  function phaseLink(base, caseId, phaseId, opts) {
    const b = String(base || '').split('#')[0];
    return opts && opts.field ? `${b}#f/case/${caseId}` : `${b}#case/${caseId}/phase/${phaseId}`;
  }
  const whatOf = k => (k === 'survey' ? '調査' : kindLabel(k));
  // 担当者へのメールの結びの前の行（指示の段落はこの前に入る: setBriefSection）
  const STAFF_TAILS = ['内容を確認したら、下のリンクから開いて「確認した」を押してください。', '詳しくは下のリンクから確認してください。'];
  // 担当者へのメール（社内）の本文。現場担当への指示（Task 9）があれば ■ 怪しい箇所 ■ 優先して調べる ■ 指示 ■ 当日の注意 の段落
  function staffBody(k, p, caseRow, org, me, link, lead, tail) {
    const lines = [lead, ''];
    lines.push(`${k === 'survey' ? '調査日時' : '工事日時'}: ${fmtRange(p.scheduled_at, p.scheduled_end)}`);
    lines.push(...placeLines(caseRow || {}));
    const brief = briefLines(p.plan);
    if (brief.length) lines.push('', ...brief);
    lines.push('', tail);
    if (str(link)) lines.push(str(link));
    return wrapMail(caseRow, ['worker'], org, me, lines);
  }
  // 担当者への確認依頼（purpose staff_notice）→ { subject, body }。caseRow.worker_name が宛名（「鈴木さん」）
  //   件名「【確認してください】10/20 9:00 調査 グランメゾン世田谷 302号室」（日時未定なら日時を省く）
  function staffNoticeMail({ phase, caseRow, org, me, link } = {}) {
    const p = phase || {};
    const k = p.kind;
    const when = p.scheduled_at ? fmtMDHM(p.scheduled_at) : '';
    const place = placeName(caseRow || {});
    const lead = `${p.scheduled_at ? fmtMDWHM(p.scheduled_at) + '〜 ' : ''}${place} の${whatOf(k)}をお願いします。`;
    return {
      subject: `【確認してください】${[when, whatOf(k), place].filter(Boolean).join(' ')}`,
      body: staffBody(k, p, caseRow, org, me, link, lead, STAFF_TAILS[0])
    };
  }
  // 担当者向けの前日のお知らせ（purpose staff_notice ＋ remind_slot d1）→ { subject, body }
  function staffReminderMail({ phase, caseRow, org, me, link } = {}) {
    const p = phase || {};
    const k = p.kind;
    const place = placeName(caseRow || {});
    return {
      subject: `【明日の予定】${[fmtMDHM(p.scheduled_at), whatOf(k), place].filter(Boolean).join(' ')}`,
      body: staffBody(k, p, caseRow, org, me, link, `明日 ${fmtMDWHM(p.scheduled_at)}〜 ${place} の${whatOf(k)}です。`, STAFF_TAILS[1])
    };
  }
  // 担当者向けの前日のお知らせを今作るか（アプリを開いたときに呼ぶ）→ [{ phase_id, slot: 'd1', remind_for }]
  //   入居者向けの前日リマインドと同じ時刻（前日 18:00）・同じ条件（予定を入れた時点で過ぎていれば作らない・予定の時刻を過ぎたら作らない）。
  //   担当者が決まっているフェーズだけ。同じ (phase_id, d1, remind_for, 担当者) の staff_notice が既にあれば作らない
  //   （担当者を変えたら新しい担当者向けを作る。DB の unique も worker_id 込み: migration 027。worker_id の無い古い行は同じ担当者とみなす）
  function dueStaffReminders(phases, existingDrafts, now) {
    const nowMs = ms(now) != null ? ms(now) : Date.now();
    const drafts = listOf(existingDrafts);
    const out = [];
    for (const p of listOf(phases)) {
      if (!p.id || !p.worker_id || !p.scheduled_at || p.done_at || !KIND_KEYS.includes(p.kind)) continue;
      if (nowMs >= ms(p.scheduled_at)) continue;
      const d1 = reminderSlots(p.scheduled_at, scheduleSetAt(p, drafts)).find(x => x.slot === 'd1');
      if (!d1 || ms(d1.at) > nowMs) continue;
      const exists = drafts.some(d => d.purpose === 'staff_notice' && d.phase_id === p.id && d.remind_slot === 'd1' && d.remind_for === d1.remind_for
        && (!d.worker_id || d.worker_id === p.worker_id));
      if (!exists) out.push({ phase_id: p.id, kind: p.kind, slot: 'd1', label: d1.label, at: d1.at, remind_for: d1.remind_for });
    }
    return out;
  }
  // 担当者の状態（カードの表示）→ { key: 'none'|'unset'|'notified'|'ack', label }
  function workerState(phase) {
    const p = phase || {};
    if (!p.worker_id) return { key: 'unset', label: '担当者が決まっていません' };
    if (p.ack_at) return { key: 'ack', label: `確認済み ${fmtMDHM(p.ack_at)}${str(p.ack_by_name) ? `（${str(p.ack_by_name)}）` : ''}` };
    if (p.notified_at) return { key: 'notified', label: `知らせた ${fmtMDHM(p.notified_at)}` };
    return { key: 'none', label: '未通知' };
  }
  // 担当者の「🔔 確認してください」の一覧。caseRows は case_summaries の行（phases 付き）、meId は自分の user_id
  //   notice: 自分が担当者で、知らせてもらって未確認（調査済み・完了は除く）
  //   tomorrow: 自分が担当者で、明日（日本時間）の予定（未確認の notice があればそちらに含める: tomorrow: true）
  //   → [{ type, caseRow, phase, title, label, from, fromAt, tomorrow, brief }]（notice を先、各々予定の早い順。brief は現場担当への指示の要約・無ければ ''）
  function staffInbox(caseRows, meId, now) {
    const nowMs = ms(now) != null ? ms(now) : Date.now();
    const tomorrow = jstYmd(nowMs + 86400000);
    const out = [];
    for (const c of listOf(caseRows)) {
      const count = {};
      for (const p of listOf(c.phases)) {
        count[p.kind] = (count[p.kind] || 0) + 1;
        if (!meId || p.worker_id !== meId || p.done_at) continue;
        const isTomorrow = !!p.scheduled_at && jstYmd(p.scheduled_at) === tomorrow;
        const notice = !!p.notified_at && !p.ack_at;
        if (!notice && !isTomorrow) continue;
        const what = whatOf(p.kind);
        const when = p.scheduled_at ? `${fmtMDWHM(p.scheduled_at)}〜` : '日時未定';
        const label = isTomorrow ? `明日 ${when} ${what}です` : `${when} ${p.kind === 'survey' ? '調査に行ってください' : what + 'をお願いします'}`;
        out.push({ type: notice ? 'notice' : 'tomorrow', caseRow: c, phase: p, title: phaseTitle(p, p.seq != null ? p.seq : count[p.kind]),
          label, from: str(p.notified_by_name), fromAt: p.notified_at || null, tomorrow: isTomorrow, brief: briefSummary(p.plan) });
      }
    }
    const t = x => (x.phase.scheduled_at ? ms(x.phase.scheduled_at) : Infinity);
    return out.sort((a, b) => (a.type === b.type ? 0 : a.type === 'notice' ? -1 : 1) || t(a) - t(b));
  }

  // 工事カードで使う調査結果: この案件の調査のうち、何か入っている一番新しい（並びの最後の）もの。無ければ null
  function latestSurveyResult(phases) {
    const list = listOf(phases).filter(p => p.kind === 'survey' && hasResult(p.result));
    return list.length ? normalizeResult(list[list.length - 1].result) : null;
  }
  // 報告書（調査区分）の初期値: 原因 f2 ／ 原因と判断した理由 reason ／ 次の対応方針 f4
  function reportInit(raw) {
    const r = normalizeResult(raw);
    return { f2: str(r.cause), reason: str(r.why), f4: str(r.scope) };
  }
  // 見積書の備考の初期値（data.notes.extra）。NOTE_FIRST は備考の1行目に必ず入るので除く（重複は1回）
  function estimateNoteExtra(raw) {
    return cautionSentences(raw).filter(t => t !== EL().NOTE_FIRST).join('\n');
  }
  // 工事掲示の工事内容チェックの初期値 → { workTypes, drainRooms, otherWorkText }（WORK_TYPES の7種だけ）
  function noticeInit(raw) {
    const r = normalizeResult(raw);
    const workTypes = {};
    NL().WORK_TYPES.forEach(w => { workTypes[w.key] = r.cautions.includes(w.key); });
    return { workTypes, drainRooms: workTypes.drain ? str(r.drainRooms) : '', otherWorkText: workTypes.other ? str(r.cautionOther) : '' };
  }

  /* ---------- 書類の共有記録 ---------- */
  // 見積・報告書の「下書き → 共有 → 承諾（見積）／確認（報告書）」
  //   mails（mail_drafts の行・任意）から送付日と宛先の種類を補う。報告書の「確認」は doc.viewed_at
  //   （お客様ページで開いた日など、呼ぶ側が入れる）があれば済
  //   → { type: 'estimate'|'report', steps: [{ key, label, done, date }], current, sentTo: ['client',...] }
  function docTrack(doc, mails) {
    const d = doc || {};
    const isEst = d.series_id != null || d.version != null || d.total != null || d.accepted_at !== undefined;
    const sentMails = listOf(mails).filter(m => m.status === 'sent' &&
      (isEst ? m.estimate_id === d.id : m.report_id === d.id));
    const mailSentAt = sentMails.map(m => ms(m.sent_at)).filter(t => t != null).sort((a, b) => a - b)[0];
    const sentAt = d.sent_at || (mailSentAt != null ? new Date(mailSentAt).toISOString() : null);
    const sentTo = RECIPIENTS.map(r => r.key).filter(k => sentMails.some(m => listOf(m.recipients).includes(k)));
    const shared = isEst ? (!!sentAt || d.status === 'sent' || isAccepted(d)) : (!!sentAt || isReportSent(d));
    const steps = [{ key: 'draft', label: '下書き', done: true, date: d.created_at || null },
      { key: 'shared', label: '共有', done: shared, date: shared ? sentAt : null }];
    if (isEst) steps.push({ key: 'accepted', label: '承諾', done: isAccepted(d), date: d.accepted_at || null });
    else steps.push({ key: 'confirmed', label: '確認', done: !!d.viewed_at, date: d.viewed_at || null });
    const current = steps.filter(s => s.done).pop().key;
    return { type: isEst ? 'estimate' : 'report', steps, current, sentTo };
  }

  /* ---------- 請求 ---------- */
  // 見積を系列ごとにまとめる → [{ accepted: total|null, sent: {version,total}|null }]
  function seriesOf(estimates) {
    const groups = new Map();
    for (const e of listOf(estimates)) {
      const key = e.series_id || e.id;
      if (!groups.has(key)) groups.set(key, { accepted: null, sent: null });
      const g = groups.get(key);
      const pick = (version, total) => {
        if (total == null) return;
        const v = Number(version) || 0;
        if (!g.sent || v > g.sent.version) g.sent = { version: v, total: Number(total) };
      };
      if (isAccepted(e) && e.status !== 'superseded' && e.total != null) g.accepted = Number(e.total);
      if (e.sent_total != null) pick(e.sent_version, e.sent_total);
      if (e.sent_at && e.total != null) pick(e.version, e.total);
    }
    return [...groups.values()];
  }
  // 請求額の根拠 'override'（手入力）| 'accepted'（承諾された見積の合計）| 'sent'（承諾が無いとき系列ごとの最新の送付済み版の合計）| null
  function billingBasis(phase, estimates) {
    const p = phase || {};
    if (p.amount_override != null && p.amount_override !== '') return 'override';
    const s = seriesOf(estimates != null ? estimates : p.estimates);
    if (s.some(g => g.accepted != null)) return 'accepted';
    if (s.some(g => g.sent)) return 'sent';
    return null;
  }
  // 請求額（円・整数）。無ければ null
  function billingAmount(phase, estimates) {
    const p = phase || {};
    const basis = billingBasis(p, estimates);
    if (basis === 'override') return Number(p.amount_override);
    const s = seriesOf(estimates != null ? estimates : p.estimates);
    if (basis === 'accepted') return s.reduce((a, g) => a + (g.accepted || 0), 0);
    if (basis === 'sent') return s.reduce((a, g) => a + (g.sent ? g.sent.total : 0), 0);
    return null;
  }

  // 請求先の表示（「元請 ○○管理」「物件オーナー 山田様」「入居者 佐藤様」「その他の名前」）
  function billToLabel(phase, caseRow) {
    const t = (phase && phase.bill_to_type) || 'client';
    const c = caseRow || {};
    if (t === 'other') return str(phase.bill_to_name) || BILL_TO.other;
    if (t === 'client') { const n = clientName(c); return n ? `元請 ${n}` : '元請'; }
    const n = str(t === 'owner' ? c.owner_name : c.resident_name);
    return n ? `${BILL_TO[t]} ${withSama(n)}` : (BILL_TO[t] || '');
  }

  const billStatus = p => (p.paid_at ? 'paid' : p.billed_at ? 'billed' : 'unbilled');
  const BILL_STATUS_LABEL = { unbilled: '未請求', billed: '入金待ち', paid: '入金済み' };
  const BILLING_MODE_LABEL = { single: '単発（案件ごと）', monthly: '月ごと（まとめて）' };

  // 金額の表示 ¥116,800（null・数でないものは ''）
  function yen(n) {
    if (n == null || n === '' || !Number.isFinite(Number(n))) return '';
    const v = Math.round(Number(n));
    return (v < 0 ? '-' : '') + '¥' + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  // 金額の入力（全角数字・¥・円・カンマ・空白を許す）→ { ok, value }。空は { ok: true, value: null }
  function parseYen(s) {
    const t = String(s == null ? '' : s)
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[¥￥円,，、\s]/g, '');
    if (t === '') return { ok: true, value: null };
    if (!/^\d{1,13}$/.test(t)) return { ok: false, value: null };
    const v = Number(t);
    return v <= 1000000000000 ? { ok: true, value: v } : { ok: false, value: null };
  }
  // 'YYYY-MM' / 'YYYY-MM-DD' → '2026年11月'
  function ymLabel(ym) {
    const m = /^(\d{4})-(\d{2})/.exec(String(ym || ''));
    return m ? `${m[1]}年${Number(m[2])}月` : '';
  }
  // 'YYYY-MM' に n か月足す
  function addMonth(ym, n) {
    const m = /^(\d{4})-(\d{2})/.exec(String(ym || ''));
    if (!m) return '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1 + (n || 0), 1));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  }
  // 請求の一覧に出る月（'YYYY-MM'）: 月ごとは billing_month（未設定なら完了月）、単発は完了月。未完了で未設定は ''
  function billingMonthOf(phase) {
    const p = phase || {};
    if (p.billing_mode === 'monthly' && p.billing_month) return String(p.billing_month).slice(0, 7);
    return p.done_at ? jstYm(p.done_at) : '';
  }
  // 入金期限の初期値（'YYYY-MM-DD'。日本時間）: 月ごとは請求月（無ければ完了月 → 請求日の月）の翌月末、単発は請求日の30日後
  function paymentDueDefault(phase, billedAt) {
    const p = phase || {};
    const at = toDate(billedAt) || new Date();
    if (p.billing_mode === 'monthly') {
      const ym = billingMonthOf(p) || jstYm(at);
      const [y, m] = ym.split('-').map(Number);
      const last = new Date(Date.UTC(y, m + 1, 0)); // 翌月の末日
      return `${last.getUTCFullYear()}-${pad(last.getUTCMonth() + 1)}-${pad(last.getUTCDate())}`;
    }
    return jstYmd(at.getTime() + 30 * 86400000);
  }
  // 入金期限を過ぎて未入金か（期限の日の翌日から。日本時間）
  function isOverdue(phase, now) {
    const p = phase || {};
    if (!p.billed_at || p.paid_at || !p.payment_due) return false;
    return String(p.payment_due).slice(0, 10) < jstYmd(toDate(now) || new Date());
  }
  // 精算（請求）の段を出すか: 工事も調査も常に出す（2026-10-18 追加指示。調査は見積が無くても手入力の金額で請求できる）。
  //   請求の一覧（groupBilling）に調査が出るのは、請求額があるか請求・入金の記録があるときだけ
  function showsBilling(phase) {
    const p = phase || {};
    return KIND_KEYS.includes(p.kind);
  }
  function groupStatus(items) {
    if (items.some(x => x.status === 'unbilled')) return 'unbilled';
    if (items.some(x => x.status === 'billed')) return 'billed';
    return 'paid';
  }
  // 入力を { phase, caseRow } の並びにする。case_summaries の行（phases を持つ）・{ phase, caseRow }・caseRow 付きのフェーズ のどれでも可
  function flatten(rows) {
    const out = [];
    for (const r of listOf(rows)) {
      if (Array.isArray(r.phases)) for (const p of r.phases) out.push({ phase: p, caseRow: r });
      else if (r.phase) out.push({ phase: r.phase, caseRow: r.caseRow || r.case || {} });
      else out.push({ phase: r, caseRow: r.caseRow || r.case || {} });
    }
    return out;
  }
  // 請求の一覧（month = 'YYYY-MM' か 'YYYY-MM-01'）
  //   monthly: 月ごとの元請への請求で billing_month がその月（未設定なら完了月）→ 元請ごとにまとめる
  //   single:  単発で 完了（done_at）が日本時間でその月
  //   調査は請求額（見積・手入力）があるものだけ（調査費用の請求）。工事は金額が無くても出す（amount: null）
  //   → { month, monthly: [{ clientId, clientName, items, total, unknown, status, statusLabel }], single: [item], total }
  //     item = { phase, caseRow, caseName, kind, title, billTo, amount, status, statusLabel, doneAt, paymentDue, overdue }
  //   now（省略時は今）は入金期限超過（overdue）の判定に使う
  function groupBilling(rows, month, now) {
    const ym = String(month || '').slice(0, 7);
    const monthly = new Map();
    const single = [];
    for (const { phase: p, caseRow: c } of flatten(rows)) {
      if (!p || !KIND_KEYS.includes(p.kind)) continue;
      const amount = billingAmount(p);
      if (p.kind === 'survey' && amount == null && !p.billed_at && !p.paid_at) continue; // 調査は請求額があるか、請求の記録があるものだけ
      const isMonthly = p.billing_mode === 'monthly';
      const inMonth = isMonthly
        ? (p.billing_month ? String(p.billing_month).slice(0, 7) === ym : !!p.done_at && jstYm(p.done_at) === ym)
        : !!p.done_at && jstYm(p.done_at) === ym;
      if (!inMonth) continue;
      const status = billStatus(p);
      const item = { phase: p, caseRow: c, caseName: str(c.name), kind: p.kind, title: phaseTitle(p),
        billTo: billToLabel(p, c), amount, status, statusLabel: BILL_STATUS_LABEL[status], doneAt: p.done_at || null,
        paymentDue: p.payment_due ? String(p.payment_due).slice(0, 10) : null, overdue: isOverdue(p, now) };
      if (isMonthly) {
        const key = c.client_id || 'name:' + clientName(c);
        if (!monthly.has(key)) monthly.set(key, { clientId: c.client_id || null, clientName: clientName(c), items: [] });
        monthly.get(key).items.push(item);
      } else single.push(item);
    }
    const byDone = (a, b) => (ms(a.doneAt) || Infinity) - (ms(b.doneAt) || Infinity) || a.caseName.localeCompare(b.caseName);
    const groups = [...monthly.values()].map(g => {
      g.items.sort(byDone);
      const status = groupStatus(g.items);
      return Object.assign(g, {
        total: g.items.reduce((a, x) => a + (x.amount || 0), 0),
        unknown: g.items.filter(x => x.amount == null).length,
        status, statusLabel: BILL_STATUS_LABEL[status]
      });
    }).sort((a, b) => (a.clientName < b.clientName ? -1 : a.clientName > b.clientName ? 1 : 0));
    single.sort(byDone);
    const total = groups.reduce((a, g) => a + g.total, 0) + single.reduce((a, x) => a + (x.amount || 0), 0);
    return { month: ym, monthly: groups, single, total };
  }

  /* ---------- 案件ページのフェーズの行（Task 9 は フェーズ名・日時・対応状況 だけ表示。Task 10 の表の列のデータもここで作る） ---------- */
  // phase: case_phases の行（か case_summaries.phases の要素）、seq: 同じ種類の何回目、
  // docs: { estimates（全版可）, reports, mails（このフェーズの mail_drafts） }（省略時は phase.estimates / phase.reports）、now
  //   → { id, kind, title, when, stage, short, report, estimate, bill, payment, worker, brief }
  //     when: { at, end, text: '10/20 9:00' | '未定' } / stage: stage() の値 / short: 表のセル向けの短い段階 '🔴 調査に行く' '🟡 承諾待ち 2日' '✓ 完了'
  //     report: { state: 'none'|'draft'|'waiting'|'submitted'|'confirmed'|'shared'|'viewed', text, date } / estimate: { state: 'none'|'draft'|'sent'|'accepted', text, version, amount }
  //     bill: { state: 'unbilled'|'billed'|'paid', text } / payment: { state: 'none'|'due'|'overdue'|'paid', text } / worker: workerState() / brief: 指示があるか
  function phaseRow(phase, seq, docs, now) {
    const p = phase || {};
    const nowAt = toDate(now) || new Date();
    const d = docs || {};
    const estimates = listOf(d.estimates != null ? d.estimates : p.estimates);
    const reports = listOf(d.reports != null ? d.reports : p.reports);
    const mails = listOf(d.mails);
    const st = stage(p, { estimates, reports }, nowAt);
    const days = st.date ? Math.max(0, Math.round((ms(jstYmd(nowAt)) - ms(jstYmd(st.date))) / 86400000)) : 0;
    const shortLabel = st.key === 'visit' ? '調査に行く' : st.key === 'issued' ? '見積書提出済み' :
      st.key === 'report' && isWork(p.kind) ? '完了報告必要' :
      st.key === 'approval' ? `${isWork(p.kind) ? '発注待ち' : '承諾待ち'}${st.date && days ? ` ${days}日` : ''}` : st.label;
    const short = st.ball ? `${MARK[st.ball]} ${shortLabel}` : `✓ ${st.label}`;
    // 報告書: 一番進んでいるもの（共有・確認 > 確認済み > 提出済み > 作業員が入力中 > 下書き）
    const rank = { draft: 0, waiting: 1, submitted: 2, confirmed: 3, shared: 4, viewed: 5 };
    let report = { state: 'none', text: '未作成', date: null };
    for (const r of reports) {
      const t = docTrack(r, mails);
      const shared = t.steps.find(x => x.key === 'shared');
      const seen = t.steps.find(x => x.key === 'confirmed');
      const s = seen && seen.done ? 'viewed' : shared && shared.done ? 'shared' : r.status === 'confirmed' ? 'confirmed' : r.status === 'submitted' ? 'submitted'
        : r.share_active ? 'waiting' : 'draft';
      const date = s === 'viewed' ? seen.date : s === 'shared' ? shared.date : null;
      if (report.state === 'none' || rank[s] > rank[report.state]) {
        report = { state: s, date, text: s === 'viewed' ? `確認 ${fmtMD(date)}` : s === 'shared' ? `共有${date ? ' ' + fmtMD(date) : ''}`
          : s === 'confirmed' ? '確認済み' : s === 'submitted' ? '提出済み' : s === 'waiting' ? '作業員が入力中' : '下書き' };
      }
    }
    // 見積: 最新の版（承諾があればそれ）
    const live = liveEstimates(estimates);
    const acc = live.filter(isAccepted).sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0))[0];
    const last = acc || live.slice().sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0)
      || String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
    let estimate = { state: 'none', text: '未作成', version: null, amount: null };
    if (last) {
      const v = Number(last.version) || 1;
      const amount = last.total != null ? Number(last.total) : null;
      if (acc) estimate = { state: 'accepted', text: `v${v} 承諾`, version: v, amount };
      else if (last.status === 'sent') estimate = { state: 'sent', text: `v${v} 送付${last.sent_at ? ' ' + fmtMD(last.sent_at) : ''}`, version: v, amount };
      else estimate = { state: 'draft', text: `v${v} 下書き`, version: v, amount };
    }
    const bs = billStatus(p);
    const bill = { state: bs, text: bs === 'unbilled' ? '未' : `請求 ${fmtMD(p.billed_at)}` };
    const due = p.payment_due ? String(p.payment_due).slice(0, 10) : '';
    const payment = p.paid_at ? { state: 'paid', text: `入金 ${fmtMD(p.paid_at)}` }
      : p.billed_at && due ? { state: isOverdue(p, nowAt) ? 'overdue' : 'due', text: `期限 ${fmtYmdMD(due)}` }
        : { state: 'none', text: '—' };
    return { id: p.id || null, kind: p.kind, title: phaseTitle(p, seq),
      when: { at: p.scheduled_at || null, end: p.scheduled_end || null, text: p.scheduled_at ? fmtMDHM(p.scheduled_at) : '未定' },
      stage: st, short, report, estimate, bill, payment, worker: workerState(p), brief: hasBrief(p.plan) };
  }

  // 案件ページの表の「確認」の列（作業担当者の確認状態）。members = [{ user_id, display_name }]（確認した人の名前に使う）
  //   → { key: 'unset'|'none'|'notified'|'ack', text: '担当未定' / '未通知' / '知らせた 10/17' / '✓ 鈴木 10/18', short: スマホのチップ用（日付なし） }
  function workerCell(phase, members) {
    const p = phase || {};
    if (!p.worker_id) return { key: 'unset', text: '担当未定', short: '担当未定' };
    if (p.ack_at) {
      const m = listOf(members).find(x => x && x.user_id === (p.ack_by || p.worker_id));
      const who = str(m && m.display_name) || str(p.ack_by_name);
      return { key: 'ack', text: `✓ ${who ? who + ' ' : '確認 '}${fmtMD(p.ack_at)}`, short: `✓ ${who || '確認済み'}` };
    }
    if (p.notified_at) return { key: 'notified', text: `知らせた ${fmtMD(p.notified_at)}`, short: '知らせた' };
    return { key: 'none', text: '未通知', short: '未通知' };
  }

  // 案件ページの上部の「今の状態」1行。phases はこの案件のフェーズ（各 estimates / reports 付き。stage と同じ）
  //   → { us, them, next: caseNext の先頭（無ければ null）, text: '🔴 自社の番 2件 ・ 🟡 相手待ち 1件 ・ 次: 10/20 9:00 調査に行く' }
  function caseNow(phases, now) {
    const rows = caseNext(phases, now);
    const us = rows.filter(r => r.ball === 'us').length;
    const them = rows.filter(r => r.ball === 'them').length;
    const next = rows[0] || null;
    const list = listOf(phases);
    const tail = next ? `次: ${next.kind === 'survey' ? '' : next.title + ' '}${nextText(next)}`
      : list.length ? '次: なし（すべて済み）' : '次: 対応フェーズを追加してください';
    return { us, them, next, text: `${MARK.us} 自社の番 ${us}件 ・ ${MARK.them} 相手待ち ${them}件 ・ ${tail}` };
  }

  // 作業員に報告書のURLを渡すときの文面（「送る文面をコピー」。LINE 等に貼る）
  //   { phase, caseRow, org, url } → '○○設備です。△△マンション 101号室の調査の報告書の入力をお願いします。…\nURL'
  function shareRequestText({ phase, caseRow, org, url }) {
    const p = phase || {}, c = caseRow || {};
    const place = placeName(c);
    const lines = [`${str(org && org.name) ? str(org.name) + 'です。' : ''}${place ? place + 'の' : ''}${kindLabel(p.kind) || '作業'}の報告書の入力をお願いします。`];
    if (p.scheduled_at) lines.push(`${p.kind === 'survey' ? '調査日時' : '工事日'}: ${fmtRange(p.scheduled_at, p.scheduled_end)}`);
    lines.push('下のURLを開くと、ログインなしで報告書の入力・写真の追加・提出ができます（提出するとURLは使えなくなります）。');
    lines.push(String(url || ''));
    return lines.join('\n');
  }

  /* ---------- 現場担当アプリ（Task 18。#f） ---------- */
  // 自分の担当の案件か（案件の担当者か、どれかのフェーズの作業担当者）
  function fieldMine(caseRow, meId) {
    const c = caseRow || {};
    return !!meId && (c.assignee_id === meId || listOf(c.phases).some(p => p.worker_id === meId));
  }
  const isToday = (at, nowAt) => !!at && jstYmd(at) === jstYmd(nowAt);
  // 予定の日時の短い表示: '今日 9:00' / '明日 9:00' / '11/5（水）9:00' / '日時未定'
  function fieldWhen(at, now) {
    const nowAt = toDate(now) || new Date();
    const p = jst(at);
    if (!p) return '日時未定';
    if (isToday(at, nowAt)) return `今日 ${fmtHM(p)}`;
    if (jstYmd(at) === jstYmd(ms(nowAt) + 86400000)) return `明日 ${fmtHM(p)}`;
    return fmtMDWHM(at);
  }
  // 同じ種類の何回目を付けたフェーズの一覧（case_summaries の seq が無ければ並び順で数える）
  function withSeq(phases) {
    const count = {};
    return listOf(phases).map(p => { count[p.kind] = (count[p.kind] || 0) + 1; return { p, seq: p.seq != null ? p.seq : count[p.kind] }; });
  }
  // ツールページで最初に選ぶ対応: 今日の予定がある対応（早い順の先頭）。無ければ最新（並びの最後）。無ければ null
  function fieldDefaultPhase(phases, now) {
    const nowAt = toDate(now) || new Date();
    const list = listOf(phases);
    const today = list.filter(p => isToday(p.scheduled_at, nowAt)).sort((a, b) => ms(a.scheduled_at) - ms(b.scheduled_at));
    return today[0] || list[list.length - 1] || null;
  }
  // 案件一覧のカードに出す対応: 今日の予定 → 未完了で今日より後の予定（早い順）→ 未完了の最新 → 最新
  function fieldFocus(phases, now) {
    const nowAt = toDate(now) || new Date();
    const list = listOf(phases);
    const byAt = (a, b) => ms(a.scheduled_at) - ms(b.scheduled_at);
    const today = list.filter(p => isToday(p.scheduled_at, nowAt)).sort(byAt);
    if (today.length) return today[0];
    const open = list.filter(p => !p.done_at);
    const ahead = open.filter(p => p.scheduled_at && jstYmd(p.scheduled_at) > jstYmd(nowAt)).sort(byAt);
    return ahead[0] || open[open.length - 1] || list[list.length - 1] || null;
  }
  // 段階の短い文（カード・チップ向け。日付は別に出すので外す）
  function fieldStageLabel(st) {
    if (!st || !st.ball) return '';
    const label = st.key === 'visit' ? '調査に行く' : st.key === 'work' ? '工事待ち' : st.key === 'issued' ? '見積書提出済み' : st.label;
    return `${MARK[st.ball]} ${label}`;
  }
  // 現場用の「自分の案件一覧」: 進行中で自分の担当の案件だけ（全部の切替は無い＝Ruling）。
  //   → [{ caseRow, phase（カードの対応・無ければ null）, title, when, stage, stageText, today, at }]
  //   並び: 今日の予定（時刻の早い順）→ 日付のあるもの（今に近い順）→ 日付なし（物件名順）
  function fieldCases(caseRows, meId, now) {
    const nowAt = toDate(now) || new Date();
    const out = [];
    for (const c of listOf(caseRows)) {
      if (c.status && c.status !== 'open') continue;
      if (c.deleted_at) continue;
      if (!fieldMine(c, meId)) continue;
      const seqd = withSeq(c.phases);
      const p = fieldFocus(c.phases, nowAt);
      const seq = p ? (seqd.find(x => x.p === p) || {}).seq : null;
      const st = p ? stage(p, null, nowAt) : null;
      out.push({ caseRow: c, phase: p, title: p ? phaseTitle(p, seq) : '', at: p && p.scheduled_at ? p.scheduled_at : null,
        when: p ? fieldWhen(p.scheduled_at, nowAt) : '対応なし', stage: st, stageText: fieldStageLabel(st),
        today: !!p && isToday(p.scheduled_at, nowAt) });
    }
    const group = x => (x.today ? 0 : x.at ? 1 : 2);
    const dist = x => Math.abs(ms(x.at) - ms(nowAt));
    return out.sort((a, b) => group(a) - group(b)
      || (group(a) === 0 ? ms(a.at) - ms(b.at) : group(a) === 1 ? dist(a) - dist(b) : 0)
      || str(a.caseRow.name).localeCompare(str(b.caseRow.name), 'ja'));
  }
  // ツールページの対応の切替チップ → [{ id, phase, title, text: '調査 1回目 ・ 今日 9:00' | '原因元工事 1回目' }]
  function fieldPhaseChips(phases, now) {
    const nowAt = toDate(now) || new Date();
    return withSeq(phases).map(({ p, seq }) => {
      const title = phaseTitle(p, seq);
      return { id: p.id, phase: p, title, text: p.scheduled_at ? `${title} ・ ${fieldWhen(p.scheduled_at, nowAt)}` : title };
    });
  }
  // 3つのツールボタンの今の状態（選んだ対応の書類）。reports / estimates（全版）/ notices は表の行
  //   → { report: { state, text, open }, estimate: {…}, notice: {…} }
  //     state: 'none'（まだありません）/ 'draft'（下書きあり）/ 'done'（提出済み）/ 'many'（n件。工事掲示だけ）
  //     open: 開く書類（報告書・見積書は最新、工事掲示は1件のときだけ）。none なら null
  function fieldTools(docs) {
    const d = docs || {};
    const byCreated = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''));
    const reports = listOf(d.reports).slice().sort(byCreated);
    const r = reports[reports.length - 1] || null;
    const more = (n, t) => (n > 1 ? `${t}（全${n}件）` : t);
    let report = { state: 'none', text: 'まだありません ・ 新しく作る', open: null, count: 0 };
    if (r) {
      const photos = listOf(r.photos).length;
      report = r.status === 'draft'
        ? { state: 'draft', text: more(reports.length, `下書きあり（写真 ${photos}枚）`) + ' ・ 続きを書く', open: r, count: reports.length }
        : { state: 'done', text: more(reports.length, '提出済み') + ' ・ 開く', open: r, count: reports.length };
    }
    // 見積: 系列ごとの最新の版。一番新しい系列の最新版を開く
    const live = liveEstimates(d.estimates);
    const latestOf = new Map();
    for (const e of live) {
      const cur = latestOf.get(e.series_id);
      if (!cur || (Number(e.version) || 0) > (Number(cur.version) || 0)) latestOf.set(e.series_id, e);
    }
    const series = Array.from(latestOf.values()).sort(byCreated);
    const e = series[series.length - 1] || null;
    let estimate = { state: 'none', text: 'まだありません ・ 新しく作る', open: null, count: 0 };
    if (e) {
      estimate = e.status === 'draft'
        ? { state: 'draft', text: more(series.length, '下書きあり') + ' ・ 続きを書く', open: e, count: series.length }
        : { state: 'done', text: more(series.length, '提出済み') + ' ・ 開く', open: e, count: series.length };
    }
    const notices = listOf(d.notices).slice().sort(byCreated);
    const notice = !notices.length ? { state: 'none', text: 'まだありません ・ 新しく作る', open: null, count: 0 }
      : notices.length === 1 ? { state: 'many', text: '1件 ・ 開く／複製して別の号室', open: notices[0], count: 1 }
        : { state: 'many', text: `${notices.length}件 ・ 一覧を開く`, open: null, count: notices.length };
    return { report, estimate, notice };
  }

  const api = { KINDS, KIND_KEYS, STEPS, MARK, SLOTS, RECIPIENTS, BILL_TO, kindLabel, steps,
    ROOM_ROLES, roomKey, isRoomKey, roomRoleLabel, roomsOf, roomTitle, recipientOrder, roomChoices, contactTitle, hasResident,
    toDate, jstYmd, jstYm, jstAt, fmtMD, fmtMDHM, fmtMDWHM, fmtRange,
    phaseTitle, stage, reportState, shareRequestText, caseNext, nextText, caseFlags, teamStages, TASK_GROUPS, taskGroupOf, taskGroups, reminderSlots, scheduleSetAt, dueReminders, staleReminders, reminderState,
    mailLabel, recipientsLabel, canSkip, groupOutbox, contacts, defaultRecipients, scheduleMail, reminderMail, docTrack,
    GREETING, CLOSING, roomLabel, placeName, addresseeLine, addresseeLines, setAddressee,
    BRIEF_SUSPECTS, BRIEF_PRIORITY, BRIEF_HEADS, normalizeBrief, briefLines, hasBrief, briefSummary, setBriefSection, STAFF_TAILS,
    scheduleForm, introLine, phaseRow, workerCell, caseNow,
    phaseLink, staffNoticeMail, staffReminderMail, dueStaffReminders, workerState, staffInbox,
    MOVE_ITEMS_TEXT, cautionChoices, normalizeResult, hasResult, cautionSentences, surveyResultMail, latestSurveyResult,
    reportInit, estimateNoteExtra, noticeInit,
    billingBasis, billingAmount, billToLabel, groupBilling,
    BILL_STATUS_LABEL, BILLING_MODE_LABEL, billStatus, yen, parseYen, ymLabel, addMonth, billingMonthOf, showsBilling,
    paymentDueDefault, isOverdue, fmtYmdMD,
    fieldMine, fieldWhen, fieldDefaultPhase, fieldFocus, fieldStageLabel, fieldCases, fieldPhaseChips, fieldTools };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PhaseLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
