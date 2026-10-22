// js/phase-logic.js — 対応フェーズ（調査・原因元工事・復旧工事）の純粋関数（ブラウザ: window.PhaseLogic / node: module.exports）
// 社内画面のフェーズカード・案件一覧の「次:」・連絡メール／リマインド・請求の一覧で使う。
// 時刻はすべて日本時間（UTC+9 固定。日本に夏時間は無い）で判定・表示する。実行環境のタイムゾーンには依存しない
// （getHours 等のローカル関数は使わず、+9時間ずらした値を getUTC* で読む）。
// フェーズの形は case_summaries.phases（migration 021）の要素:
//   { id, kind, seq, scheduled_at, scheduled_end, done_at, bill_to_type, bill_to_name, billing_mode, billing_month,
//     billed_at, paid_at, amount_override, estimate_due（037。見積書提案期日 YYYY-MM-DD）, estimates: [...], reports: [...] }
//   estimates の要素 { id, series_id, version, status, total, accepted, sent_at, accepted_at, sent_version, sent_total }
//   reports の要素   { id, work_type, status, sent, sent_at, submitted_at, submitted_via, submitted_by, share_active }
//     （034: share_active = 担当者URLが使える。035: submitted_via = member（社内）/ share（担当者URL）。045: submitted_by = 提出した人）
// 段階は見ている人（opts.me = user_id）で変わる（Task 25）: 作業担当者が自分以外 → 🟡 報告待ち、別の人が提出 → 🔴 報告書を確認する
// 見積・報告書は estimates / reports 表の行そのもの（全版）を渡してもよい（superseded を除いて同じ判定になる）。
(function (root) {
  const KINDS = [
    { key: 'survey', label: '調査', short: '調査', color: 'blue' },
    { key: 'cause', label: '原因元工事', short: '原因元', color: 'orange' },
    { key: 'repair', label: '復旧工事', short: '復旧', color: 'green' },
    // Task 37 / migration 058: その他（名前は自由。case_phases.label・40字まで）。段階・報告書・見積書・工事掲示・請求は工事と同じ流れ
    { key: 'other', label: 'その他', short: 'その他', color: 'gray' }
  ];
  const KIND_KEYS = KINDS.map(k => k.key);
  const kindOf = key => KINDS.find(k => k.key === key) || null;
  const kindLabel = key => (kindOf(key) || {}).label || '';
  const isWork = key => key === 'cause' || key === 'repair' || key === 'other';
  const LABEL_MAX = 40; // その他の名前（DB の case_phases_label_check と同じ）
  // 作業の名前: その他はフェーズの名前（点検）、ほかは種類の名前（原因元工事）。名前の無いその他は「その他」
  const workName = (kind, phase) => (kind === 'other' ? str(phase && phase.label) || kindLabel('other') : kindLabel(kind));

  // 段階の並び（カードのステップ表示用）。stage().key はこのどれか
  const STEPS = {
    // Task 16: 「調査済みにする」は無い。報告書の流れで進む
    // Task 25: 報告書と担当者URLはフェーズを作ったときに自動でできる。調査日時を過ぎたら、作業担当者が自分以外なら 🟡 報告待ち（名前）、
    //   自分か未設定なら 🔴 報告書を書いて提出（期限 翌日）
    survey: [
      { key: 'schedule', label: '調査日を決める' },
      { key: 'visit', label: '調査に行く' },
      { key: 'waiting', label: '報告待ち' },
      { key: 'write', label: '報告書を書いて提出' },
      { key: 'check', label: '報告書を確認する' },
      { key: 'report', label: '報告書を送る' },
      { key: 'approval', label: '発注待ち' },
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
  const fmtMDW = v => { const p = jst(v); return p ? `${p.m}/${p.d}（${p.w}）` : ''; };                   // 10/17（土）
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
  //   Task 37: その他は「その他（点検）」（何回目は付けない。名前が無ければ「その他」）
  function phaseTitle(phase, sameKindIndex) {
    if (phase && phase.kind === 'other') return str(phase.label) ? `その他（${str(phase.label)}）` : kindLabel('other');
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
  //   waiting = 下書きで担当者URLが使える（Task 25 からはフェーズの報告書はいつも URL 付き。段階の判定では draft と同じ扱い）。
  //   date は提出日（submitted / confirmed）。
  //   submitted は 確認が要る提出: 担当者URLから提出したもの、または別の人（me 以外）が社内で提出したもの（Task 25）。
  //   自分（me）が提出したもの・me が分からないときの社内の提出は confirmed と同じ扱い（そのまま送れる）
  const REPORT_RANK = { draft: 1, waiting: 2, submitted: 3, confirmed: 4, sent: 5 };
  const byOther = (r, me) => !!me && !!r.submitted_by && r.submitted_by !== me;
  const needsCheck = (r, me) => !!r && (r.submitted_via === 'share' || byOther(r, me));
  function reportState(reports, me) {
    let best = { state: null, report: null, date: null };
    for (const r of listOf(reports)) {
      const st = isReportSent(r) ? 'sent' : r.status === 'confirmed' ? 'confirmed'
        : r.status === 'submitted' ? (needsCheck(r, me) ? 'submitted' : 'confirmed')
        : r.share_active ? 'waiting' : 'draft';
      if (!best.state || REPORT_RANK[st] > REPORT_RANK[best.state]) best = { state: st, report: r, date: r.submitted_at || null };
    }
    return best;
  }
  // フェーズを消すときに一緒に消してよい報告書（自動で作った下書きのまま＝写真なし。Task 25）
  const isBlankReport = r => !!r && r.status === 'draft' && !listOf(r.photos).length;
  // 工事の「完了報告必要」の括弧の補足（報告書の状態）
  const WORK_REPORT_NOTE = { draft: '（報告書 下書き）', waiting: '（報告書 下書き）', submitted: '（報告書 提出済み・確認する）', confirmed: '（報告書 送付する）' };
  // 送付済みで承諾されていない見積（最新の版が sent）。日付は一番新しい送付日
  function pendingApproval(estimates) {
    const pend = liveEstimates(estimates).filter(e => e.status === 'sent');
    if (!pend.length) return null;
    const last = pend.map(e => ms(e.sent_at)).filter(t => t != null).sort((a, b) => b - a)[0];
    return { date: last != null ? new Date(last).toISOString() : null };
  }

  // 見積書の期限（Task 21・Task 23）: 調査報告の「次の対応方針」（原因元工事・再調査）で estimate_due が入り、
  //   そのフェーズの見積がまだ提出されていない（下書きだけ・無い）・請求も入金もまだ → { due: 'YYYY-MM-DD', late }。それ以外は null
  //   Task 23 I1: 下書きでは消さない（提出 issued・送付・承諾で消える。管理者側の「見積書作成必要」と同じ）
  function estimateTodo(phase, now) {
    const p = phase || {};
    const due = p.estimate_due ? String(p.estimate_due).slice(0, 10) : '';
    if (!due || p.billed_at || p.paid_at) return null;
    if (isWork(p.kind) && p.done_at) return null;
    if (liveEstimates(p.estimates).some(e => e.status && e.status !== 'draft')) return null;
    const nowAt = toDate(now) || new Date();
    return { due, late: due < jstYmd(nowAt) };
  }
  // 'YYYY-MM-DD' の n 日後（日付だけで計算。タイムゾーンに依存しない）
  function ymdAdd(ymd, n) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    if (!m) return '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  // 報告書の期限（Task 23 Ruling → Task 29 で調査を変更）
  //   調査（Task 29 Ruling）: 作業完了の1時間後。作業完了 = このフェーズの報告書の作業終了時間（作業日 + time_end。作業日が無ければ調査日）、
  //     無ければ調査日時の3時間後（日本時間）。過ぎたら late（「期限超過」）
  //   工事: 工事日（終わりの日があればその日）の翌日（日本時間）。翌日が終わったら late
  //   予定の時刻を過ぎて、報告書が未提出（無い・下書き。担当者URL付きの下書きも）・調査済み／完了の記録も無い・請求も入金もまだ →
  //   { due: 'YYYY-MM-DD'（期限の日）, dueAt: 期限の瞬間（ISO）, late }。それ以外は null（Task 25: 誰が書くかは stage が作業担当者で決める）
  const SURVEY_WORK_HOURS = 3;
  const REPORT_GRACE_HOURS = 1;
  // 作業完了の瞬間（Date）。reports はこのフェーズの報告書（作業終了時間があるもののうち一番新しいもの）
  function workEndAt(phase, reports) {
    const p = phase || {};
    const withEnd = listOf(reports).filter(r => /^\d{1,2}:\d{2}/.test(str(r.time_end)));
    const r = withEnd[withEnd.length - 1];
    if (r) {
      const wd = str(r.work_date).slice(0, 10);
      const ymd = /^\d{4}-\d{2}-\d{2}$/.test(wd) ? wd : jstYmd(p.scheduled_at);
      if (ymd) {
        const [h, mi] = str(r.time_end).split(':').map(Number);
        return jstAt(+ymd.slice(0, 4), +ymd.slice(5, 7), +ymd.slice(8, 10), h, mi);
      }
    }
    const t = ms(p.scheduled_at);
    return t == null ? null : new Date(t + SURVEY_WORK_HOURS * 3600000);
  }
  // 報告書の期限の瞬間（Date）。調査 = 作業完了 + 1時間、工事 = 工事日の翌日の終わり（翌々日 0:00）
  function reportDueAt(phase, reports) {
    const p = phase || {};
    if (!p.scheduled_at) return null;
    if (p.kind === 'survey') {
      const end = workEndAt(p, reports);
      return end ? new Date(end.getTime() + REPORT_GRACE_HOURS * 3600000) : null;
    }
    const end = p.scheduled_end && ms(p.scheduled_end) > ms(p.scheduled_at) ? p.scheduled_end : p.scheduled_at;
    const d = ymdAdd(jstYmd(end), 2);
    return jstAt(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10), 0, 0);
  }
  function reportTodo(phase, now, docs) {
    const p = phase || {};
    if (!p.scheduled_at || p.done_at || p.billed_at || p.paid_at) return null;
    const reports = docsOf(p, docs).reports;
    const rs = reportState(reports);
    if (rs.state && rs.state !== 'draft' && rs.state !== 'waiting') return null;
    const nowAt = toDate(now) || new Date();
    if (ms(p.scheduled_at) > ms(nowAt)) return null;
    const dueAt = reportDueAt(p, reports);
    if (p.kind === 'survey') {
      return { due: jstYmd(dueAt), dueAt: dueAt.toISOString(), late: ms(nowAt) > dueAt.getTime() };
    }
    const end = p.scheduled_end && ms(p.scheduled_end) > ms(p.scheduled_at) ? p.scheduled_end : p.scheduled_at;
    const due = ymdAdd(jstYmd(end), 1);
    return { due, dueAt: dueAt.toISOString(), late: due < jstYmd(nowAt) };
  }
  // 期限の短い文: 調査 '10/21 13:00'（時刻まで）／工事 '10/22'
  const reportDueText = (kind, rt) => (rt ? (kind === 'survey' && rt.dueAt ? fmtMDHM(rt.dueAt) : fmtYmdMD(rt.due)) : '');

  // Task 29: 見積書提案期日は通常2日以内（今日＋2日まで）。それより先なら「理由」と「いつまでに提出できるか」が必須
  const ESTIMATE_DUE_DAYS = 2;
  // today: 'YYYY-MM-DD'（日本時間の今日）か Date。due が今日＋2日より先なら true
  function estimateDueNeedsReason(due, today) {
    const d = str(due).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    const t = typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : jstYmd(toDate(today) || new Date());
    return d > ymdAdd(t, ESTIMATE_DUE_DAYS);
  }
  // 案件ページ・連絡に出す「（理由: …・提出 10/27 まで）」（理由が無ければ ''）
  function estimateDueReasonText(phaseOrNext) {
    const x = phaseOrNext || {};
    const reason = str(x.estimate_due_reason != null ? x.estimate_due_reason : x.estimateDueReason);
    if (!reason) return '';
    const by = str(x.estimate_due_by != null ? x.estimate_due_by : x.estimateDueBy).slice(0, 10);
    return `（理由: ${reason}${/^\d{4}-\d{2}-\d{2}$/.test(by) ? `・提出 ${fmtYmdMD(by)} まで` : ''}）`;
  }

  /* ---------- 段階 ---------- */
  // 作業担当者の名前（case_summaries の worker_name → members から）
  function workerNameOf(p, members) {
    const n = str(p && p.worker_name);
    if (n) return n;
    const m = listOf(members).find(x => x.user_id === (p && p.worker_id));
    return m ? str(m.display_name) : '';
  }
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
  //   調査（Task 16・25）: 報告書の状態を先に見る。送付前は
  //     確認済み（🔴 報告書を送る）＞ 提出済み（担当者URL・別の人: 🔴 報告書を確認する／自分: 🔴 報告書を送る）＞
  //     未提出（下書き・担当者URL付き・無い）: 調査済み（旧データ。🔴 報告書を送る）／日時未定（🔴 調査日を決める）／
  //     日時の前（🔴 M/D H:MM 調査に行く）／日時を過ぎた（作業担当者が自分以外 🟡 報告待ち（名前）・自分か未設定 🔴 報告書を書いて提出（期限 翌日））
  //     送付後 → 見積が送付済みで未承諾（🟡 見積の承諾待ち）→ 入金待ち → 完了
  //   工事（2026-10-20 の7段階）: 1 見積書作成必要 🔴 → 2 見積書提出済み（送付する）🔴 → 3 発注待ち 🟡 → 4 受注後日程調整必要 🔴 →
  //     5 工事待ち（M/D）🟡 → 6 完了報告必要 🔴（工事日を過ぎた or done_at。報告書の状態を括弧で補足）→ 7 請求する 🔴 → 入金待ち 🟡 → 済
  //   工事は 入金・請求・報告書の送付・完了 の記録を先に見る（記録があれば前の段は済んだものとする。旧 対応履歴から移したフェーズは見積が無いため）
  //   opts（Task 25）: { me: 見ている人の user_id, members: [{ user_id, display_name }]（報告待ちの名前） }
  function stage(phase, docs, now, opts) {
    const p = phase || {};
    const o = opts || {};
    const { estimates, reports } = docsOf(p, docs);
    const nowAt = toDate(now) || new Date();
    const rs = reportState(reports, o.me);
    const reportSent = rs.state === 'sent';
    if (p.kind === 'survey') {
      if (!reportSent) {
        if (rs.state === 'confirmed') return mkStage('report', '報告書を送る', 'us', p.done_at || rs.date);
        if (rs.state === 'submitted') return mkStage('check', '報告書を確認する', 'us', rs.date || p.done_at);
        if (p.done_at) return mkStage('report', '報告書を送る', 'us', p.done_at); // 旧データ（報告書なしで調査済み）
        if (!p.scheduled_at) return mkStage('schedule', '調査日を決める', 'us', null);
        // Task 23・25: 調査日時を過ぎて報告書が未提出（下書き・担当者URL付きも）→ 作業担当者が自分以外なら 🟡 報告待ち（名前）、
        //   自分か未設定なら 🔴 報告書を書いて提出（期限 翌日。🔔 と同じ期限）
        const rt = reportTodo(p, nowAt, { reports });
        if (rt) {
          if (p.worker_id && p.worker_id !== o.me) {
            const who = workerNameOf(p, o.members);
            return mkStage('waiting', `報告待ち（${who || '担当者'}）`, 'them', rt.due, { due: rt.due, dueAt: rt.dueAt, late: rt.late, worker: who || '' });
          }
          return mkStage('write', `報告書を書いて提出（期限 ${reportDueText('survey', rt)}）`, 'us', rt.due, { due: rt.due, dueAt: rt.dueAt, late: rt.late });
        }
        return mkStage('visit', `${fmtMDHM(p.scheduled_at)} 調査に行く`, 'us', p.scheduled_at,
          { late: isLate(p.scheduled_at, nowAt) });
      }
      const pend = pendingApproval(estimates);
      if (pend) return mkStage('approval', '発注待ち', 'them', pend.date); // Task 23: 承諾待ち → 発注待ち（見積の送付後）
      // 調査費用を請求して入金待ち（精算の段。Task 7）
      if (p.billed_at && !p.paid_at) return paymentStage(p, nowAt);
      return mkStage('done', '完了', null, p.done_at);
    }
    if (isWork(p.kind)) {
      if (p.paid_at) return mkStage('done', '済', null, p.paid_at);
      if (p.billed_at) return paymentStage(p, nowAt);
      if (reportSent) return mkStage('bill', '請求する', 'us', p.done_at || rs.report.sent_at);
      // Task 23: 報告書が未提出（無い・下書き・担当者URL付きの下書き）なら期限（工事日の翌日）を括弧に足す。過ぎたら late
      const workReport = () => {
        const rt = reportTodo(p, nowAt, { reports, estimates });
        const note = (WORK_REPORT_NOTE[rs.state] || '').replace(/）$/, rt ? `・期限 ${fmtYmdMD(rt.due)}）` : '）');
        return mkStage('report', '完了報告必要' + (note || (rt ? `（期限 ${fmtYmdMD(rt.due)}）` : '')), 'us', rt ? rt.due : p.done_at || p.scheduled_at,
          rt ? { report: rs.state, due: rt.due, dueAt: rt.dueAt, late: rt.late } : { report: rs.state });
      };
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

  // 見ている人の段階。🟡 報告待ち（作業担当者が別の人）なら、作業担当者から見た段階（🔴 報告書を書いて提出）に読み替える
  //   （チーム状況・やることの「全員」で、だれの番かを作業担当者に付けるため。Task 25）
  function workerStage(p, now, o) {
    const st = stage(p, null, now, o);
    return st.key === 'waiting' && p && p.worker_id ? stage(p, null, now, Object.assign({}, o, { me: p.worker_id })) : st;
  }

  // 案件一覧の「次:」の行。🔴（自社）を先、🟡（相手）を後。同じ色はフェーズの並び順。済んだフェーズは出さない
  //   → [{ phaseId, kind, title, key, label, ball, mark, date, late }]
  //   opts（Task 25）: { me, members, byWorker }。byWorker: 🟡 報告待ちのフェーズは作業担当者から見た段階（🔴 報告書を書いて提出）にする（チーム状況）
  function caseNext(phases, now, opts) {
    const o = opts || {};
    const list = listOf(phases);
    const count = {};
    const rows = [];
    list.forEach((p, i) => {
      count[p.kind] = (count[p.kind] || 0) + 1;
      const st = o.byWorker ? workerStage(p, now, o) : stage(p, null, now, o);
      const base = { phaseId: p.id || null, kind: p.kind, title: phaseTitle(p, p.seq != null ? p.seq : count[p.kind]),
        seq: p.seq != null ? p.seq : count[p.kind], workerId: p.worker_id || null, workerName: str(p.worker_name) || null };
      rows.push({ i, row: Object.assign({}, base, { key: st.key, label: st.label, ball: st.ball, mark: MARK[st.ball] || '', date: st.date,
        late: !!st.late, due: st.due || null, dueAt: st.dueAt || null }) });
      // Task 23: 再調査の調査の見積書の期限も1行（やること・🔔 と同じ件数にする）
      const todo = p.kind === 'survey' ? estimateTodo(p, now) : null;
      if (todo) {
        rows.push({ i, row: Object.assign({}, base, { key: 'estimate', label: `見積書作成必要（期日 ${fmtYmdMD(todo.due)}）`, ball: 'us', mark: MARK.us,
          date: todo.due, late: todo.late, due: todo.due }) });
      }
    });
    const shown = rows.filter(x => x.row.ball);
    const rank = b => (b === 'us' ? 0 : 1);
    shown.sort((a, b) => rank(a.row.ball) - rank(b.row.ball) || a.i - b.i);
    return shown.map(x => x.row);
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
    const next = caseNext(c.phases, now, { me: meId });
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
      for (const r of caseNext(c.phases, now, { byWorker: true, members })) {
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
    { key: 'write', label: '報告書を書いて提出', action: 'open_report' },
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
  // 作りかけの見積（下書きの最新）。「見積書作成必要」の行のボタンで続きを開く（Task 23: 下書きでは行が消えない）
  function draftEstimate(estimates) {
    const list = liveEstimates(estimates).filter(e => e.status === 'draft' && e.id);
    list.sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return list[0] || null;
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
        // Task 25: 作業担当者が別の人の「報告書を書いて提出」はその人の分（自分の分には入れない。全員の分には出す）
        const own = stage(p, null, now, { me, members: o.members });
        const st = own.key === 'waiting' ? workerStage(p, now, { me, members: o.members }) : own;
        const othersWrite = own.key === 'waiting' && st.key === 'write';
        const todo = p.kind === 'survey' ? estimateTodo(p, now) : null;
        if (todo) {
          const seq0 = p.seq != null ? p.seq : count[p.kind];
          const w0 = p.worker_id || null, who0 = w0 || c.assignee_id || null;
          const label0 = `見積書作成必要（期日 ${fmtYmdMD(todo.due)}）`;
          all.push({
            group: 'estimate', action: 'make_estimate', caseId: c.id || null, caseName: str(c.name), room: str(c.room),
            phaseId: p.id || null, kind: p.kind, title: phaseTitle(p, seq0), key: 'estimate', label: label0, text: label0,
            date: todo.due, late: todo.late, due: todo.due, who: who0,
            whoName: !who0 ? '' : nameOf.get(who0) || (who0 === w0 ? str(p.worker_name) : str(c.assignee_name)) || '不明',
            mine: !!me && (c.assignee_id === me || w0 === me),
            reportId: null, reportStatus: null, reportState: null, estimateId: (draftEstimate(p.estimates) || {}).id || null, phase: p, caseRow: c
          });
        }
        if (st.ball !== 'us') continue;
        const group = taskGroupOf(p.kind, st.key);
        const def = TASK_GROUPS.find(g => g.key === group);
        const seq = p.seq != null ? p.seq : count[p.kind];
        const workerId = p.worker_id || null;
        const who = workerId || c.assignee_id || null;
        const whoName = !who ? '' : nameOf.get(who) || (who === workerId ? str(p.worker_name) : str(c.assignee_name)) || '不明';
        const rs = reportState(p.reports, me);
        const est = group === 'send_estimate' ? issuedEstimate(p.estimates) : group === 'estimate' ? draftEstimate(p.estimates) : null;
        const row = { phaseId: p.id || null, kind: p.kind, title: phaseTitle(p, seq), seq, key: st.key, label: st.label, ball: st.ball, date: st.date };
        all.push({
          group, action: def.action, caseId: c.id || null, caseName: str(c.name), room: str(c.room),
          phaseId: p.id || null, kind: p.kind, title: row.title, key: st.key, label: st.label, text: nextText(row),
          date: st.date || null, late: !!st.late, due: st.due || null, dueAt: st.dueAt || null, who, whoName,
          mine: !!me && (workerId === me || (c.assignee_id === me && !othersWrite)),
          reportId: rs.report ? rs.report.id || null : null, reportStatus: rs.report ? rs.report.status || null : null, reportState: rs.state,
          estimateId: est ? est.id || null : null,
          phase: p, caseRow: c
        });
      }
    }
    const t = x => (x.dueAt ? ms(x.dueAt) : x.date ? ms(x.date) : null); // Task 29: 調査の報告書は期限の時刻まで比べる
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
      if (d.purpose === 'schedule') return `${head}のご連絡${isWork(k) ? `（${workName(k, phase)}）` : ''}`;
      const sl = (SLOTS.find(x => x.slot === d.remind_slot) || {}).label;
      const tail = [sl, isWork(k) ? workName(k, phase) : ''].filter(Boolean).join('・');
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
  function subjectOf(head, kind, caseRow, phase) {
    const name = placeName(caseRow || {});
    return `【${head}】${name}${isWork(kind) ? `（${workName(kind, phase)}）` : ''}`;
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

  /* ---- 作業担当者への指示（case_phases.plan。migration 028 → Task 25 / migration 045 で号室ごと） ---- */
  // 社内だけで使う（担当者への確認依頼・前日のお知らせの本文、🔔 の一覧、フェーズ詳細ページ、現場用のツールページ）。お客様向けのメールには一切出さない
  // 形（Task 25）: { rooms: [{ room, role, suspects[], suspectOther, tasks[], taskOther, note }], visitNote }
  //   room: 号室（この案件の部屋か関係する部屋）、role: 加害部屋 cause／被害部屋 damage／その他 other（選んだときの役割。表示用）
  const BRIEF_SUSPECTS = [
    { key: 'supply', label: '給湯給水系統' }, { key: 'drain', label: '排水系統' }, { key: 'rain', label: '雨漏り可能性あり' }, { key: 'other', label: 'その他' }
  ];
  const BRIEF_TASKS = [
    { key: 'cause', label: '原因調査' }, { key: 'pressure', label: '耐圧テスト' }, { key: 'drain_test', label: '排水テスト' },
    { key: 'photo', label: '被害箇所の写真撮影' }, { key: 'estimate', label: '被害箇所の復旧見積もりと採寸' }, { key: 'open', label: '開口調査' },
    { key: 'other', label: 'その他' }
  ];
  // 028 の形（旧 plan: suspects / priority / note / visitNote）の項目。読み替えて表示するときだけ使う
  const OLD_SUSPECTS = [
    { key: 'bath', label: '浴室' }, { key: 'ceiling', label: '天井' }, { key: 'wall', label: '壁' }, { key: 'floor', label: '床' },
    { key: 'kitchen', label: 'キッチン' }, { key: 'washroom', label: '洗面' }, { key: 'toilet', label: 'トイレ' },
    { key: 'washer', label: '洗濯機' }, { key: 'water_heater', label: '給湯器' }, { key: 'pipe', label: '給排水管' },
    { key: 'balcony', label: 'バルコニー' }, { key: 'common', label: '共用部' }, { key: 'other', label: 'その他' }
  ];
  const BRIEF_PRIORITY = [
    { key: 'upstairs', label: '上階の水回り' }, { key: 'own_room', label: '当該室の水回り' }, { key: 'underfloor', label: '床下・隠蔽部' },
    { key: 'exterior', label: '外壁・サッシ' }, { key: 'common_pipe', label: '共用配管' }, { key: 'other', label: 'その他' }
  ];
  const VISIT_HEAD = '■ 当日の注意';
  const BRIEF_MAX_ROOMS = 20;
  const VISIT_MAX = 20; // 今回行く部屋（Task 31。DB の _phase_visit_ok と同じ）
  const VISIT_ROOMS_HEAD = '■ 今回行く部屋';
  const txt = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const pickList = (v, list) => { const set = new Set(Array.isArray(v) ? v : []); return list.map(x => x.key).filter(k => set.has(k)); };
  const labelsOf = (list, keys) => keys.map(k => (list.find(x => x.key === k) || {}).label).filter(Boolean);
  // 文章の欄 → 行（前後の空白と空行を除く。メールの段落の区切りと混ざらないように）
  const textLines = v => txt(v).split('\n').map(l => l.trim()).filter(Boolean);
  const roleKey = v => (ROOM_ROLES.some(x => x.key === v) ? v : '');
  // 号室の区画1つ（足りないキーは空・知らない値は落とす・並びはボタンの順）
  function briefRoom(x) {
    const r = x && typeof x === 'object' && !Array.isArray(x) ? x : {};
    return { room: str(r.room).slice(0, 40), role: roleKey(r.role), suspects: pickList(r.suspects, BRIEF_SUSPECTS), suspectOther: txt(r.suspectOther),
      tasks: pickList(r.tasks, BRIEF_TASKS), taskOther: txt(r.taskOther), note: txt(r.note) };
  }
  // DB の値 → 画面の形 { rooms, visitNote }。同じ号室の区画は最初の1つだけ。
  //   旧 plan（028: suspects / priority / note）は「号室未設定」の区画1つに読み替える（怪しい箇所 → その他の自由記載、優先・指示 → 補足）
  function normalizeBrief(raw) {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    let rooms = [];
    if (Array.isArray(r.rooms)) {
      const seen = new Set();
      r.rooms.map(briefRoom).forEach(b => {
        if (seen.has(b.room)) return;
        seen.add(b.room);
        rooms.push(b);
      });
      rooms = rooms.slice(0, BRIEF_MAX_ROOMS);
    } else {
      const sus = labelsOf(OLD_SUSPECTS, pickList(r.suspects, OLD_SUSPECTS));
      const pri = labelsOf(BRIEF_PRIORITY, pickList(r.priority, BRIEF_PRIORITY));
      const note = [pri.length ? '優先して調べる: ' + pri.join('・') : ''].concat(textLines(r.note)).filter(Boolean).join('\n');
      if (sus.length || note) {
        rooms = [{ room: '', role: '', suspects: sus.length ? ['other'] : [], suspectOther: sus.join('・'), tasks: [], taskOther: '', note }];
      }
    }
    const out = { rooms, visitNote: txt(r.visitNote) };
    // Task 31: 今回行く部屋（キーが無い＝まだ選んでいない。[] ＝選んだが全部外した。どちらも「未設定」の扱いは visitRooms() で）
    if (Array.isArray(r.visitRooms)) out.visitRooms = visitList(r.visitRooms);
    return out;
  }
  // 今回行く部屋の配列 → [{ room, role }]（号室が空・同じ号室は落とす・20まで）
  function visitList(v) {
    const out = [];
    (Array.isArray(v) ? v : []).forEach(x => {
      const o = x && typeof x === 'object' && !Array.isArray(x) ? x : {};
      const room = str(o.room).slice(0, 40);
      if (!room || out.some(y => y.room === room)) return;
      out.push({ room, role: roleKey(o.role) });
    });
    return out.slice(0, VISIT_MAX);
  }
  // 区画の見出し「402号室（加害部屋）」（号室が無ければ「号室未設定」）
  const briefRoomHead = b => (roomLabel(b && b.room) || '号室未設定') + (b && b.role ? `（${roomRoleLabel(b.role)}）` : '');
  // 選んだ項目の文（その他は自由記載を括弧で）
  const choiceText = (list, keys, other) => labelsOf(list, keys.filter(k => k !== 'other'))
    .concat(keys.includes('other') ? [str(other) ? `その他（${str(other)}）` : 'その他'] : []).join('・');
  const roomHasBrief = b => !!(b.suspects.length || b.tasks.length || textLines(b.note).length);
  /* ---- 案件の依頼内容（cases.request。Task 28 / migration 052） ---- */
  // 依頼元から聞いた内容: { text, symptoms[], symptomOther, damage, suspect, photos: [{ path, name, size, type, caption }] }
  // 社内の画面（案件ページの「依頼内容」）・担当者への確認依頼メールと 🔔・現場用のツールページ・担当者URLのページで使う
  const REQUEST_SYMPTOMS = [
    { key: 'ceiling', label: '天井からの水漏れ' }, { key: 'wall', label: '壁のシミ' }, { key: 'floor', label: '床の濡れ' },
    { key: 'downstairs', label: '階下からの申告' }, { key: 'smell', label: '異臭・カビ' }, { key: 'water_bill', label: '水道料金の増加' },
    { key: 'other', label: 'その他' }
  ];
  const REQUEST_TEXT_MAX = 2000;
  const REQUEST_FIELD_MAX = 1000;
  const REQUEST_PHOTOS_MAX = 30;
  const REQUEST_HEAD = '■ 依頼内容';
  // DB の値 → 画面の形（足りないキーは空・知らない症状は落とす・並びはボタンの順・写真は path のあるものだけ・同じ写真は1回）
  function normalizeRequest(raw) {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const seen = new Set();
    const photos = (Array.isArray(r.photos) ? r.photos : []).filter(x => x && typeof x === 'object' && typeof x.path === 'string' && x.path
      && !seen.has(x.path) && seen.add(x.path)).slice(0, REQUEST_PHOTOS_MAX).map(x => {
      const o = { path: x.path, caption: txt(x.caption).slice(0, 200) };
      if (typeof x.name === 'string') o.name = x.name;
      if (typeof x.size === 'number') o.size = x.size;
      if (typeof x.type === 'string') o.type = x.type;
      return o;
    });
    return { text: txt(r.text), symptoms: pickList(r.symptoms, REQUEST_SYMPTOMS), symptomOther: txt(r.symptomOther),
      damage: txt(r.damage), suspect: txt(r.suspect), photos };
  }
  const symptomText = r => choiceText(REQUEST_SYMPTOMS, r.symptoms, r.symptomOther);
  // 文章の項目 → [{ key, label, text }]（空の項目は出さない）。依頼内容は見出しなしで先頭に
  function requestItems(raw) {
    const r = normalizeRequest(raw);
    const out = [];
    if (str(r.text)) out.push({ key: 'text', label: '依頼内容', text: textLines(r.text).join('\n') });
    if (r.symptoms.length) out.push({ key: 'symptoms', label: '症状', text: symptomText(r) });
    if (str(r.damage)) out.push({ key: 'damage', label: '被害箇所', text: textLines(r.damage).join('\n') });
    if (str(r.suspect)) out.push({ key: 'suspect', label: '怪しい箇所', text: textLines(r.suspect).join('\n') });
    return out;
  }
  const hasRequest = raw => requestItems(raw).length > 0 || normalizeRequest(raw).photos.length > 0;
  // 担当者へのメールの「■ 依頼内容」の段落 → 行の配列（文章が全部空なら []。写真は枚数だけ）
  //   ■ 依頼内容
  //   依頼内容: 402号室の浴室下から…（2行目以降はそのまま）
  //   症状: 天井からの水漏れ・その他（夜だけ）
  //   被害箇所: … / 怪しい箇所: … / 写真: 3枚（アプリで見られます）
  function requestLines(raw) {
    const items = requestItems(raw);
    const n = normalizeRequest(raw).photos.length;
    if (!items.length && !n) return [];
    const lines = [REQUEST_HEAD];
    items.forEach(it => it.text.split('\n').forEach((l, i) => lines.push(i ? l : it.label + ': ' + l)));
    if (n) lines.push(`写真: ${n}枚（アプリで見られます）`);
    return lines;
  }
  // 1行の要約（🔔 の一覧）。空なら ''
  function requestSummary(raw, max) {
    const items = requestItems(raw);
    const n = normalizeRequest(raw).photos.length;
    const parts = items.map(it => (it.key === 'text' ? '' : it.label + ': ') + it.text.replace(/\n/g, ' '));
    if (n) parts.push(`写真 ${n}枚`);
    const s = parts.join(' ／ ');
    const m = max || 120;
    return s.length > m ? s.slice(0, m) + '…' : s;
  }
  // 担当者へのメールの指示の段落（■ 依頼内容 → ■ 号室ごとの指示 → ■ 当日の注意）。setBriefSection に渡す行
  //   Task 31: 先頭に ■ 今回行く部屋
  function staffSectionLines(caseRow, plan) {
    return [visitLines(plan, caseRow), requestLines(caseRow && caseRow.request), briefLines(plan)]
      .filter(x => x.length).reduce((out, x, i) => out.concat(i ? [''] : [], x), []);
  }

  /* ---- 到着が遅れそう（Task 28 追加指示 / migration 052） ---- */
  // 作業担当者の画面（現場用・担当者URL）では入居者の電話を既定で出さない。そのフェーズで「到着が遅れそう」を報告したら（late_at）出す
  const LATE_CHOICES = [{ minutes: 15, label: '15分' }, { minutes: 30, label: '30分' }, { minutes: 60, label: '1時間' }];
  const LATE_MAX = 600;
  // 見込み（分）→ 約30分／約1時間／約1時間30分（DB の _late_label と同じ）
  function lateLabel(minutes) {
    const m = Math.round(Number(minutes));
    if (!Number.isFinite(m) || m < 1) return '';
    return '約' + (m < 60 ? m + '分' : m % 60 === 0 ? m / 60 + '時間' : Math.floor(m / 60) + '時間' + (m % 60) + '分');
  }
  // 入力 → 分（1〜600 の整数でなければ null）。その他の欄は「45」「1時間」「1時間半」「90分」を受け付ける
  function parseLateMinutes(v) {
    if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= LATE_MAX ? v : null;
    const t = str(v).replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)).replace(/\s/g, '');
    let m = null;
    let x;
    if ((x = t.match(/^(\d+)(?:分)?$/))) m = +x[1];
    else if ((x = t.match(/^(\d+)時間(半|(\d+)分?)?$/))) m = +x[1] * 60 + (x[2] === '半' ? 30 : x[3] ? +x[3] : 0);
    return m != null && Number.isInteger(m) && m >= 1 && m <= LATE_MAX ? m : null;
  }
  // 入居者（この案件の部屋 → 関係する部屋）→ [{ room, role, own, name, tel, label }]。名前も電話も無い部屋は出さない（DB の _case_residents と同じ）
  function caseResidents(caseRow) {
    const c = caseRow || {};
    const out = [];
    const push = (room, role, own, name, tel) => {
      if (!str(name) && !str(tel)) return;
      out.push({ room: str(room), role, own, name: str(name), tel: str(tel), label: briefRoomHead({ room: str(room), role }) });
    };
    push(c.room, 'damage', true, c.resident_name, c.resident_tel);
    listOf(c.rooms).forEach(r => push(r.room, roleKey(r.role) || 'other', false, r.resident_name, r.tel));
    return out;
  }
  // 作業担当者の画面で入居者の電話を出してよいか（そのフェーズで到着の遅れを報告した後）
  //   Task 37: 見ている人（me）が自分で登録した案件（cases.created_by）なら最初から出す（自分で入れた連絡先のため）
  const residentTelOpen = (phase, caseRow, me) => !!(phase && phase.late_at) || !!(me && caseRow && caseRow.created_by === me);

  // 担当者へのメールの指示の段落 → 行の配列（全部空なら []）。号室ごとに
  //   ■ 402号室（加害部屋）
  //   怪しい箇所: 給湯給水系統・その他（天井裏）
  //   指示: 原因調査・耐圧テスト
  //   補足: …
  // の区画（中身の無い区画は出さない）、最後に ■ 当日の注意
  function briefLines(raw) {
    const b = normalizeBrief(raw);
    const blocks = [];
    b.rooms.filter(roomHasBrief).forEach(r => {
      const lines = ['■ ' + briefRoomHead(r)];
      if (r.suspects.length) lines.push('怪しい箇所: ' + choiceText(BRIEF_SUSPECTS, r.suspects, r.suspectOther));
      if (r.tasks.length) lines.push('指示: ' + choiceText(BRIEF_TASKS, r.tasks, r.taskOther));
      textLines(r.note).forEach((l, i) => lines.push(i ? l : '補足: ' + l));
      blocks.push(lines);
    });
    if (textLines(b.visitNote).length) blocks.push([VISIT_HEAD, ...textLines(b.visitNote)]);
    return blocks.reduce((out, x, i) => out.concat(i ? [''] : [], x), []);
  }
  const hasBrief = raw => briefLines(raw).length > 0;
  // 1行の要約（🔔 の一覧・作業担当者の段）→ '402号室（加害部屋） 怪しい: 給湯給水系統 指示: 原因調査 ／ 当日: 鍵は管理人室'。空なら ''
  function briefSummary(raw, max) {
    const b = normalizeBrief(raw);
    const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
    const parts = [];
    b.rooms.filter(roomHasBrief).forEach(r => {
      const p = [briefRoomHead(r)];
      if (r.suspects.length) p.push('怪しい: ' + choiceText(BRIEF_SUSPECTS, r.suspects, r.suspectOther));
      if (r.tasks.length) p.push('指示: ' + choiceText(BRIEF_TASKS, r.tasks, r.taskOther));
      const note = textLines(r.note).join(' ');
      if (note) p.push('補足: ' + cut(note, 30));
      parts.push(p.join(' '));
    });
    const visit = textLines(b.visitNote).join(' ');
    if (visit) parts.push('当日: ' + cut(visit, 20));
    return cut(parts.join(' ／ '), max || 120);
  }
  // 「被害箇所の写真撮影」を選んだ号室 → [{ room, role }]（報告書の写真の欄の注意書き。ReportLogic.photoNote）
  function photoRooms(raw) {
    return normalizeBrief(raw).rooms.filter(r => r.tasks.includes('photo')).map(r => ({ room: r.room, role: r.role }));
  }
  // 指示・調査結果の号室の候補: この案件の部屋（cases.room。役割は被害部屋）→ 関係する部屋（並び順）。同じ号室は1回
  //   → [{ room: '402', role: 'cause', label: '402号室（加害部屋）' }]
  function planRoomChoices(caseRow) {
    const c = caseRow || {};
    const out = [];
    if (str(c.room)) out.push({ room: str(c.room).slice(0, 40), role: 'damage', label: briefRoomHead({ room: str(c.room), role: 'damage' }), own: true });
    roomsOf(c).forEach(r => {
      const room = str(r.room).slice(0, 40);
      if (out.some(x => x.room === room)) return;
      out.push({ room, role: roleKey(r.role) || 'other', label: briefRoomHead({ room, role: roleKey(r.role) || 'other' }) });
    });
    return out;
  }
  /* ---- 今回行く部屋（Task 31。case_phases.plan.visitRooms = [{ room, role }]） ---- */
  // 被害部屋だけ／加害部屋だけ／両方 を作業担当者がすぐ分かるように、フェーズごとに行く部屋を持つ。
  // 初期値（まだ選んでいない）: 指示（plan.rooms）に号室がある部屋 → 無ければこの案件の部屋（cases.room）
  function visitDefault(plan, caseRow) {
    const c = caseRow || {};
    const rooms = visitList(normalizeBrief(plan).rooms.map(r => ({ room: r.room, role: r.role })));
    if (rooms.length) return { rooms, source: 'brief' };
    if (str(c.room)) return { rooms: [{ room: str(c.room).slice(0, 40), role: 'damage' }], source: 'case' };
    return { rooms: [], source: 'none' };
  }
  // 管理者のチップで ☑ にする部屋（選んだもの。まだ選んでいなければ初期値）
  function visitSelected(plan, caseRow) {
    const b = normalizeBrief(plan);
    return Array.isArray(b.visitRooms) ? b.visitRooms : visitDefault(plan, caseRow).rooms;
  }
  // 今の行く部屋 → { rooms: [{ room, role }], source: 'set'（選んだ）| 'brief'（指示の号室）| 'case'（未設定 → この案件の部屋）| 'none' }
  //   役割は今の部屋の役割（関係する部屋の役割を変えたら表示も変わる）。全部外したとき（[]）は未設定と同じ
  function visitRooms(plan, caseRow) {
    const b = normalizeBrief(plan);
    const c = caseRow || {};
    let v;
    if (Array.isArray(b.visitRooms) && b.visitRooms.length) v = { rooms: b.visitRooms, source: 'set' };
    else if (Array.isArray(b.visitRooms)) v = str(c.room) ? { rooms: [{ room: str(c.room).slice(0, 40), role: 'damage' }], source: 'case' } : { rooms: [], source: 'none' };
    else v = visitDefault(plan, c);
    const choices = planRoomChoices(c);
    return { rooms: v.rooms.map(r => ({ room: r.room, role: (choices.find(x => x.room === r.room) || {}).role || r.role })), source: v.source };
  }
  // 「101号室（被害部屋）・201号室（加害部屋）」／未設定「この案件の部屋（101号室）」
  function visitText(plan, caseRow) {
    const v = visitRooms(plan, caseRow);
    if (v.source === 'none') return 'この案件の部屋';
    if (v.source === 'case') return `この案件の部屋（${roomLabel(v.rooms[0].room)}）`;
    return v.rooms.map(briefRoomHead).join('・');
  }
  const visitLine = (plan, caseRow) => '今回行く部屋: ' + visitText(plan, caseRow);
  // 一覧の行の短い表示「101・201号室」（号室が数字・英字で終わらないものが混ざれば「101号室・A棟」）。部屋が無ければ ''
  function visitShort(plan, caseRow) {
    const rooms = visitRooms(plan, caseRow).rooms.map(r => r.room);
    if (!rooms.length) return '';
    return rooms.every(r => roomLabel(r) === r + '号室') ? rooms.join('・') + '号室' : rooms.map(roomLabel).join('・');
  }
  // 担当者へのメールの段落（■ 今回行く部屋）。部屋が1つも分からなければ []
  function visitLines(plan, caseRow) {
    return visitRooms(plan, caseRow).source === 'none' ? [] : [VISIT_ROOMS_HEAD, visitText(plan, caseRow)];
  }
  // Task 33: ツールページ・担当者URLのページの「📋 依頼内容」の一番上の、訪問する号室ごとの1行
  //   訪問する号室 = visitRooms（plan.visitRooms → 指示のある号室 → この案件の部屋）。部屋が1つも分からなければ「この案件の部屋」の1行
  //   → { rows: [{ room, role, head:'402号室（加害部屋）', name:'402号室', roleText:'加害部屋', must:'原因調査・耐圧テスト', mustFrom:'brief'|'kind', sub:'怪しい箇所: …／補足: …',
  //                line:'402号室（加害部屋）→ 原因調査・耐圧テスト', extra }], note:'当日の注意（行は改行区切り）' }
  //   必要な対応 = その号室の指示（tasks・その他）。無ければフェーズ名（調査・原因元工事・復旧工事）。
  //   行く部屋に入っていない号室でも中身のある指示があれば、後ろに extra: true で出す（指示を見落とさないように。号室未設定の旧 plan も）
  function visitTaskRows(plan, caseRow, kind) {
    const b = normalizeBrief(plan);
    const v = visitRooms(plan, caseRow);
    const kindText = kindLabel(kind) || '対応';
    const mkRow = (room, role, br, extra) => {
      const head = room ? briefRoomHead({ room, role }) : br ? briefRoomHead(br) : 'この案件の部屋';
      const name = room ? roomLabel(room) : br ? '号室未設定' : 'この案件の部屋'; // 画面では号室＋役割のタグ（roleText）
      const tasks = br && br.tasks.length ? choiceText(BRIEF_TASKS, br.tasks, br.taskOther) : '';
      const sub = [];
      if (br && br.suspects.length) sub.push('怪しい箇所: ' + choiceText(BRIEF_SUSPECTS, br.suspects, br.suspectOther));
      if (br && textLines(br.note).length) sub.push('補足: ' + textLines(br.note).join(' '));
      const must = tasks || kindText;
      const rl = room ? role : br ? br.role : '';
      return { room, role, head, name, roleText: rl ? roomRoleLabel(rl) : '', must, mustFrom: tasks ? 'brief' : 'kind', sub: sub.join('／'), line: `${head}→ ${must}`, extra: !!extra };
    };
    const rows = v.rooms.map(r => {
      const br = b.rooms.find(x => x.room === r.room);
      return mkRow(r.room, r.role || (br && br.role) || '', br, false);
    });
    if (!rows.length) rows.push(mkRow('', '', null, false));
    b.rooms.filter(roomHasBrief).forEach(br => {
      if (br.room && v.rooms.some(r => r.room === br.room)) return;
      rows.push(mkRow(br.room, br.role, br, true));
    });
    return { rows, note: textLines(b.visitNote).join('\n') };
  }
  // チップを押した → 新しい visitRooms（並びは号室の候補の順 → 候補に無いもの）
  function visitToggle(plan, caseRow, choice, on) {
    const cur = visitSelected(plan, caseRow).filter(r => r.room !== str(choice && choice.room));
    if (on && str(choice && choice.room)) cur.push({ room: str(choice.room).slice(0, 40), role: roleKey(choice.role) });
    const order = planRoomChoices(caseRow).map(x => x.room);
    const idx = r => { const i = order.indexOf(r.room); return i < 0 ? order.length : i; };
    return visitList(cur.map((r, i) => ({ r, i })).sort((a, b) => idx(a.r) - idx(b.r) || a.i - b.i).map(x => x.r));
  }

  // 担当者へのメールの本文の指示の段落だけを差し替える（指示を変えたとき。本文の手直しは残る）。
  //   段落が無ければ「内容を確認したら…」「詳しくは…」の行（STAFF_TAILS）の前に入れる。置き場所が分からなければ null（呼ぶ側で作り直す）
  function setBriefSection(body, lines) {
    const src = String(body == null ? '' : body);
    const all = src.split('\n');
    const brief = Array.isArray(lines) ? lines.map(String) : []; // 項目の間の空行を残す（listOf は空文字を落とす）
    const isHead = l => /^■ /.test(l); // 号室ごとの見出し（Task 25）・当日の注意・旧い見出し（028）
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
      subject: subjectOf(survey ? '調査日のご連絡' : '工事日のご連絡', k, caseRow, phase),
      body: scheduleForm(k, rc) === 'resident' ? residentBody(k, phase, caseRow, org, me, rc)
        : scheduleBody(k, phase, caseRow, org, me, rc, survey ? '下記の日程で調査に伺います。' : `下記の日程で${workName(k, phase)}を行います。`)
    };
  }
  // リマインド（purpose reminder。slot 'd3'|'d1'）→ { subject, body }
  function reminderMail({ kind, phase, caseRow, org, me, slot, recipients } = {}) {
    const k = kindFrom(kind, phase);
    const survey = k === 'survey';
    const sl = (SLOTS.find(x => x.slot === slot) || SLOTS[0]).label;
    const what = survey ? '調査' : workName(k, phase);
    return {
      subject: subjectOf(`${survey ? '調査日' : '工事日'}のお知らせ（${sl}）`, k, caseRow, phase),
      body: scheduleBody(k, phase, caseRow, org, me, rcptOf(recipients, caseRow, 'reminder'),
        `${what}の日が近づいてまいりましたので、改めてご案内いたします。`)
    };
  }

  // Task 33 追加: 現場用の「タスク」タブの1行（4項目だけ）。staffInbox の1件 → { place, kind, kindText, todo, due, late }
  //   place: 物件名 号室（日報への返事は「📝 日報」）／kind: フェーズの種類（無ければ ''）／todo: やること（短い言葉）／
  //   due: 報告書・見積書は「10/22（木）まで」（調査の報告書は時刻つき「10/21（水）15:00まで」）・超過は「…まで・超過」（late）、
  //        確認依頼・翌日の予定は「10/22（木）13:00〜」（日時未定）、管理者からの連絡は届いた時刻「10/21（水）14:05」
  const TASK_TODO = { report: '報告書作成', estimate: '見積書作成', notice: '確認依頼', tomorrow: '翌日の予定' };
  function fieldTaskRow(it) {
    const x = it || {};
    const p = x.phase || null;
    const place = x.caseRow ? placeName(x.caseRow) || '（物件名なし）' : '📝 日報';
    const kind = p && KIND_KEYS.includes(p.kind) ? p.kind : '';
    const todo = x.type === 'message' ? (x.nudge ? '催促' : '管理者からの返事') : TASK_TODO[x.type] || str(x.label);
    let due = '';
    if (x.type === 'report' || x.type === 'estimate') {
      const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(x.due));
      const at = x.type === 'report' && kind === 'survey' && x.dueAt ? fmtMDWHM(x.dueAt) : ymd ? fmtMDW(jstAt(+ymd[1], +ymd[2], +ymd[3], 12, 0)) : '';
      if (at) due = at + 'まで' + (x.late ? '・超過' : '');
    } else if (x.type === 'message') due = fmtMDWHM(x.fromAt);
    else if (p) due = p.scheduled_at ? fmtMDWHM(p.scheduled_at) + '〜' : '日時未定';
    return { place, kind, kindText: kindLabel(kind), todo, due, late: !!x.late && (x.type === 'report' || x.type === 'estimate'), sendback: !!x.sendback };
  }
  // Task 43: フェーズの有効なタスクの記録（phase.task_flags = phase_task_flags の行。PhasesApi.attachTaskFlags が付ける）。
  //   task: report / estimate / notice / tomorrow、action: dismiss（削除）/ sendback（差し戻し）→ 1件 or null（closed_at があるものは済み）
  function taskFlag(phase, task, action) {
    return listOf(phase && phase.task_flags).find(f => f.task === task && f.action === action && !f.closed_at) || null;
  }
  // 管理者の「やること」の差し戻し（進行中の案件・有効なもの・古い順）→ [{ caseRow, phase, title, flag, todo }]
  function taskSendbacks(caseRows) {
    const out = [];
    for (const c of listOf(caseRows)) {
      if ((c.status && c.status !== 'open') || c.deleted_at) continue;
      withSeq(c.phases).forEach(({ p, seq }) => listOf(p.task_flags).filter(f => f.action === 'sendback' && !f.closed_at)
        .forEach(f => out.push({ caseRow: c, phase: p, title: phaseTitle(p, seq), flag: f, todo: TASK_TODO[f.task] || '' })));
    }
    return out.sort((a, b) => ms(a.flag.created_at) - ms(b.flag.created_at));
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
  //   Task 25: 原因・被害箇所は号室ごと rooms: [{ room, role, cause, damage }]。なぜそうなったか・復旧工事の範囲・注意事項は案件全体で1つ。
  //   旧い形（023: cause が1つ）は「号室未設定」の区画1つに読み替える
  function resultRoom(x) {
    const r = x && typeof x === 'object' && !Array.isArray(x) ? x : {};
    return { room: str(r.room).slice(0, 40), role: roleKey(r.role), cause: text(r.cause), damage: text(r.damage) };
  }
  function normalizeResult(raw) {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const set = new Set(Array.isArray(r.cautions) ? r.cautions : []);
    let rooms = [];
    if (Array.isArray(r.rooms)) {
      const seen = new Set();
      r.rooms.map(resultRoom).forEach(b => { if (!seen.has(b.room)) { seen.add(b.room); rooms.push(b); } });
      rooms = rooms.slice(0, BRIEF_MAX_ROOMS);
    } else if (str(r.cause)) {
      rooms = [{ room: '', role: '', cause: text(r.cause), damage: '' }];
    }
    return {
      rooms, why: text(r.why), scope: text(r.scope),
      cautions: cautionKeys().filter(k => set.has(k)),
      cautionOther: text(r.cautionOther), drainRooms: text(r.drainRooms)
    };
  }
  const resultRoomHas = b => !!(str(b.cause) || str(b.damage));
  // 何か入っているか（号室の原因・被害箇所・2つの文章のどれか・注意事項のどれか）
  function hasResult(raw) {
    const r = normalizeResult(raw);
    return !!(r.rooms.some(resultRoomHas) || str(r.why) || str(r.scope) || r.cautions.length);
  }
  // 号室の比べ方（前後の空白・「号室」・全角数字の違いは同じとみなす）
  const roomNorm = v => str(v).replace(/[０-９Ａ-Ｚａ-ｚ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/号室$/, '').trim().toLowerCase();
  // 号室に合う区画（無ければ号室未設定の区画、それも無ければ null）
  function resultRoomFor(raw, room) {
    const r = normalizeResult(raw);
    const want = roomNorm(room);
    return (want && r.rooms.find(b => roomNorm(b.room) === want)) || r.rooms.find(b => !b.room) || null;
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
  // Task 27: ご報告メールの末尾の文。next = 提出された調査の報告書の「次の対応方針」（data.nextAction: { type, estimateDue }）。
  //   原因元工事 → 「お見積書は {期日の翌日} までにお送りいたします。」、再調査 → 「再調査のうえ、お見積書は … までにお送りいたします。」、
  //   それ以外・期日なし → 「お見積書は別途お送りいたします。」（今までの文）。翌日は日付だけで計算（estimate_due は日本時間の日付）
  const ESTIMATE_LATER = 'お見積書は別途お送りいたします。';
  // 'YYYY-MM-DD' → 10月26日（月）（日付だけで読む。タイムゾーンに依存しない）
  function fmtYmdLong(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) return '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${WEEK[d.getUTCDay()]}）`;
  }
  // → { type, due（担当者の期日）, sendBy（お客様に送る日 = 翌日）} or null
  function estimatePromise(next) {
    const n = next && typeof next === 'object' ? next : {};
    const due = str(n.estimateDue);
    if ((n.type !== 'cause' && n.type !== 'resurvey') || !/^\d{4}-\d{2}-\d{2}$/.test(due) || !fmtYmdLong(due)) return null;
    return { type: n.type, due, sendBy: ymdAdd(due, 1) };
  }
  function estimatePromiseText(next) {
    const p = estimatePromise(next);
    if (!p) return ESTIMATE_LATER;
    const t = `お見積書は${fmtYmdLong(p.sendBy)}までにお送りいたします。`;
    return p.type === 'resurvey' ? '再調査のうえ、' + t : t;
  }
  // 調査結果のご報告（purpose survey_result）→ { subject, body }。空の欄の見出しは出さない。宛名・書き出し・署名は日程連絡と同じ形
  //   Task 27: next（提出された調査の報告書の次の対応方針）で末尾の文が変わる（estimatePromiseText）
  function surveyResultMail({ phase, caseRow, org, me, recipients, next } = {}) {
    const p = phase || {};
    const r = normalizeResult(p.result);
    const lines = [];
    const day = jst(p.done_at || p.scheduled_at);
    lines.push(day ? `${day.m}月${day.d}日に実施した調査の結果をご報告いたします。` : '調査の結果をご報告いたします。');
    const section = (head, body) => { if (str(body)) lines.push('', `■ ${head}`, str(body)); };
    // Task 25: 号室ごとに ■ 402号室（加害部屋） 原因: … 被害箇所: …（号室未設定の区画 = 旧い形は ■ 原因）
    r.rooms.filter(resultRoomHas).forEach(b => {
      if (!b.room) {
        section('原因', b.cause);
        if (str(b.damage)) lines.push(`被害箇所: ${str(b.damage)}`);
        return;
      }
      lines.push('', '■ ' + briefRoomHead(b));
      if (str(b.cause)) lines.push(`原因: ${str(b.cause)}`);
      if (str(b.damage)) lines.push(`被害箇所: ${str(b.damage)}`);
    });
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
    lines.push('', estimatePromiseText(next));
    return { subject: subjectOf('調査結果のご報告', 'survey', caseRow),
      body: wrapMail(caseRow, rcptOf(recipients, caseRow, 'survey_result'), org, me, lines) };
  }
  /* ---- 作業担当者への確認依頼（Task 6b） ---- */
  // カードへのリンク（base: アプリの URL。# 以降は付け直す）。opts.field: 担当者がスタッフ → 現場用のツールページ #f/case/{id}（Task 18）
  function phaseLink(base, caseId, phaseId, opts) {
    const b = String(base || '').split('#')[0];
    // Task 31: 現場用はそのフェーズのツールページ #f/case/{id}/phase/{phaseId}
    return opts && opts.field ? `${b}#f/case/${caseId}/phase/${phaseId}` : `${b}#case/${caseId}/phase/${phaseId}`;
  }
  const whatOf = (k, p) => (k === 'survey' ? '調査' : workName(k, p));
  // 担当者へのメールの結びの前の行（指示の段落はこの前に入る: setBriefSection）
  const STAFF_TAILS = ['内容を確認したら、下のリンクから開いて「確認した」を押してください。', '詳しくは下のリンクから確認してください。'];
  // 担当者へのメール（社内）の本文。現場担当への指示（Task 9）があれば ■ 怪しい箇所 ■ 優先して調べる ■ 指示 ■ 当日の注意 の段落
  function staffBody(k, p, caseRow, org, me, link, lead, tail, shareUrl) {
    const lines = [lead, ''];
    lines.push(`${k === 'survey' ? '調査日時' : '工事日時'}: ${fmtRange(p.scheduled_at, p.scheduled_end)}`);
    lines.push(...placeLines(caseRow || {}));
    // Task 28: ■ 依頼内容（案件の依頼内容）→ ■ 号室ごとの指示 → ■ 当日の注意
    const brief = staffSectionLines(caseRow, p.plan);
    if (brief.length) lines.push('', ...brief);
    lines.push('', tail);
    if (str(link)) lines.push(str(link));
    // Task 26: 担当者URL（自動発行）はここ（と ⑦）だけに出す
    if (str(shareUrl)) lines.push('', STAFF_SHARE_LINE, str(shareUrl));
    return wrapMail(caseRow, ['worker'], org, me, lines);
  }
  // 担当者への確認依頼（purpose staff_notice）→ { subject, body }。caseRow.worker_name が宛名（「鈴木さん」）
  //   件名「【確認してください】10/20 9:00 調査 グランメゾン世田谷 302号室」（日時未定なら日時を省く）
  //   Task 26: shareUrl（このフェーズの担当者URL）があれば最後に「報告書の入力・提出（ログインなしで開けます）:」と URL
  const STAFF_SHARE_LINE = '報告書の入力・提出（ログインなしで開けます）:';
  function staffNoticeMail({ phase, caseRow, org, me, link, shareUrl } = {}) {
    const p = phase || {};
    const k = p.kind;
    const when = p.scheduled_at ? fmtMDHM(p.scheduled_at) : '';
    const place = placeName(caseRow || {});
    const lead = `${p.scheduled_at ? fmtMDWHM(p.scheduled_at) + '〜 ' : ''}${place} の${whatOf(k, p)}をお願いします。`;
    return {
      subject: `【確認してください】${[when, whatOf(k, p), place].filter(Boolean).join(' ')}`,
      body: staffBody(k, p, caseRow, org, me, link, lead, STAFF_TAILS[0], shareUrl)
    };
  }
  // 担当者向けの前日のお知らせ（purpose staff_notice ＋ remind_slot d1）→ { subject, body }
  function staffReminderMail({ phase, caseRow, org, me, link } = {}) {
    const p = phase || {};
    const k = p.kind;
    const place = placeName(caseRow || {});
    return {
      // Task 31: 「明日」は使わず具体の日付
      subject: `【前日のお知らせ】${[fmtMDHM(p.scheduled_at), whatOf(k, p), place].filter(Boolean).join(' ')}`,
      body: staffBody(k, p, caseRow, org, me, link, `${fmtMDWHM(p.scheduled_at)}〜 ${place} の${whatOf(k, p)}です（前日のお知らせ）。`, STAFF_TAILS[1])
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
  // 作業担当者のタスク（現場用の「タスク」タブ・管理画面の #inbox-staff。Task 29 で並びを変更）。caseRows は case_summaries の行（phases 付き）、meId は自分の user_id
  //   message: 自分あての未読の連絡（管理者からの質問・返事・催促。opts.messages = staff_messages）。案件の無い連絡（日報への返事）も出す
  //   report: 調査日時・工事日を過ぎて報告書が未提出（期限 = reportTodo。過ぎたら late「期限超過」）
  //   estimate: 見積書の期限あり・まだ提出していない（estimateTodo。下書きでは消えない）
  //   notice: 自分が担当者で、知らせてもらって未確認（調査済み・完了は除く）
  //   tomorrow: 自分が担当者で、明日（日本時間）の予定（未確認の notice があればそちらに含める: tomorrow: true）
  //   → [{ type, caseRow, phase, title, label, due, dueAt, late, from, fromAt, tomorrow, brief, request, visit（Task 31: 今回行く部屋の1行。対応の無い連絡は ''） }]
  //   並び（Task 29）: ① 連絡（催促 → 新しい順）→ ② 報告書（期限超過が先 → 期限の早い順）→ ③ 見積書（期限の早い順）→ ④ 確認依頼 → ⑤ 明日の予定
  function staffInbox(caseRows, meId, now, opts) {
    const nowMs = ms(now) != null ? ms(now) : Date.now();
    const tomorrow = jstYmd(nowMs + 86400000);
    const out = [];
    const caseById = new Map(listOf(caseRows).filter(c => (!c.status || c.status === 'open') && !c.deleted_at).map(c => [c.id, c]));
    listOf(opts && opts.messages).filter(m => messageForMe(m, meId, false) && (!m.case_id || caseById.has(m.case_id))).forEach(m => {
      const c = m.case_id ? caseById.get(m.case_id) : null;
      const ws = c ? withSeq(c.phases) : [];
      const hit = ws.find(x => x.p.id === m.phase_id);
      out.push({ type: 'message', caseRow: c, phase: hit ? hit.p : null, title: hit ? phaseTitle(hit.p, hit.seq) : c ? '案件全体' : '日報',
        // Task 28: 催促（source = nudge）は件名そのまま（⚠️ 催促: …）
        label: m.source === 'nudge' ? str(m.subject) : `📨 管理者から: ${str(m.subject)}`, nudge: m.source === 'nudge',
        message: m, due: null, dueAt: null, late: false, from: '', fromAt: m.created_at, tomorrow: false, brief: '' });
    });
    for (const c of listOf(caseRows)) {
      // Task 23 M2: 進行中の案件だけ（現場用の一覧の件数と合わせる）
      if ((c.status && c.status !== 'open') || c.deleted_at) continue;
      const count = {};
      for (const p of listOf(c.phases)) {
        count[p.kind] = (count[p.kind] || 0) + 1;
        if (!meId || p.worker_id !== meId) continue;
        const title = phaseTitle(p, p.seq != null ? p.seq : count[p.kind]);
        // Task 21・23: 作業担当者が自分・見積書の期限あり・まだ提出していない → 「見積書を仕上げて提出（期限 M/D）」（下書きでは消えない）
        const todo = estimateTodo(p, now);
        if (todo) {
          out.push({ type: 'estimate', caseRow: c, phase: p, title,
            label: `見積書を仕上げて提出（期限 ${fmtYmdMD(todo.due)}）`, due: todo.due, dueAt: null, late: todo.late, from: '', fromAt: null, tomorrow: false, brief: '' });
        }
        // Task 23・29: 調査日・工事日を過ぎて報告書が未提出 → 「報告書を書いて提出（期限 …）」（stage の期限と同じ）
        const st = stage(p, null, now, { me: meId });
        if (st.due && ((p.kind === 'survey' && st.key === 'write') || (isWork(p.kind) && st.key === 'report'))) {
          const rt = { due: st.due, dueAt: st.dueAt };
          out.push({ type: 'report', caseRow: c, phase: p, title,
            label: `報告書を書いて提出（期限 ${reportDueText(p.kind, rt)}）`, due: st.due, dueAt: st.dueAt || null, late: !!st.late, from: '', fromAt: null, tomorrow: false, brief: '' });
        }
        if (p.done_at) continue;
        const isTomorrow = !!p.scheduled_at && jstYmd(p.scheduled_at) === tomorrow;
        const notice = !!p.notified_at && !p.ack_at;
        if (!notice && !isTomorrow) continue;
        const what = whatOf(p.kind, p);
        const when = p.scheduled_at ? `${fmtMDWHM(p.scheduled_at)}〜` : '日時未定';
        // Task 31: 「明日」は使わず具体の日付（翌日の予定は「10/22（水）10:00〜 調査です」）
        const label = isTomorrow ? `${when} ${what}です` : `${when} ${p.kind === 'survey' ? '調査に行ってください' : what + 'をお願いします'}`;
        out.push({ type: notice ? 'notice' : 'tomorrow', caseRow: c, phase: p, title: phaseTitle(p, p.seq != null ? p.seq : count[p.kind]),
          label, due: null, dueAt: null, late: false, from: str(p.notified_by_name), fromAt: p.notified_at || null, tomorrow: isTomorrow, brief: briefSummary(p.plan),
          request: requestSummary(c.request) }); // Task 28: 案件の依頼内容の要約（指示の前に出す）
      }
    }
    // Task 31: 対応のある行には「今回行く部屋: …」。Task 43: 削除したタスクは出さない・差し戻し中の印
    const list = out.filter(x => x.type === 'message' || !taskFlag(x.phase, x.type, 'dismiss'));
    list.forEach(x => {
      x.visit = x.phase ? visitLine(x.phase.plan, x.caseRow) : '';
      x.sendback = x.type === 'message' ? null : taskFlag(x.phase, x.type, 'sendback');
    });
    const rank = { nudge: 0, message: 1, report: 2, estimate: 3, notice: 4, tomorrow: 5 };
    const dueMs = x => (x.dueAt ? ms(x.dueAt) : ms(jstAt(+x.due.slice(0, 4), +x.due.slice(5, 7), +x.due.slice(8, 10), 0, 0)));
    const t = x => (x.type === 'message' ? -ms(x.fromAt) : x.due ? dueMs(x) : x.phase.scheduled_at ? ms(x.phase.scheduled_at) : Infinity);
    const rk = x => (x.nudge ? rank.nudge : rank[x.type]);
    return list.sort((a, b) => rk(a) - rk(b) || (b.late ? 1 : 0) - (a.late ? 1 : 0) || t(a) - t(b));
  }

  /* ---------- 現場からの連絡（staff_messages。Task 23） ---------- */
  // 件名の候補（現場用の「＋ 連絡する」）
  const MESSAGE_SUBJECTS = ['調査が終わりました', '見積を提出しました', '質問があります', '日程を変えたい'];
  // 自分あての未読か（宛先が自分。宛先が空 = 管理者全員あてなので管理者なら自分あて。自分が送ったものは除く）
  function messageForMe(m, meId, isOwner) {
    if (!m || m.read_at || !meId || m.from_user === meId) return false;
    return m.to_user ? m.to_user === meId : !!isOwner;
  }
  // 連絡をやり取りごとにまとめる → [{ root, replies: [古い順], last: 最後のやり取りの時刻, unread: 自分あての未読の数 }]（新しいやり取りが先）
  //   返事の返事も最初の連絡（root）にまとめる。もとの連絡が見えない返事はそれ自体を root にする
  function messageThreads(messages, meId, isOwner) {
    const list = listOf(messages);
    const byId = new Map(list.map(m => [m.id, m]));
    const rootOf = m => { let r = m, n = 0; while (r.reply_to && byId.has(r.reply_to) && n++ < 50) r = byId.get(r.reply_to); return r; };
    const groups = new Map();
    list.forEach(m => {
      const r = rootOf(m);
      if (!groups.has(r.id)) groups.set(r.id, { root: r, replies: [], last: r.created_at, unread: 0 });
      const g = groups.get(r.id);
      if (m !== r) g.replies.push(m);
      if (ms(m.created_at) > ms(g.last)) g.last = m.created_at;
      if (messageForMe(m, meId, isOwner)) g.unread += 1;
    });
    const out = [...groups.values()];
    out.forEach(g => g.replies.sort((a, b) => ms(a.created_at) - ms(b.created_at)));
    return out.sort((a, b) => (b.unread ? 1 : 0) - (a.unread ? 1 : 0) || ms(b.last) - ms(a.last));
  }

  // 工事カードで使う調査結果: この案件の調査のうち、何か入っている一番新しい（並びの最後の）もの。無ければ null
  function latestSurveyResult(phases) {
    const list = listOf(phases).filter(p => p.kind === 'survey' && hasResult(p.result));
    return list.length ? normalizeResult(list[list.length - 1].result) : null;
  }
  // 報告書（調査区分）の初期値: 原因 f2 ／ 原因と判断した理由 reason ／ 次の対応方針 f4
  //   Task 25: 原因はその報告書の号室に合う区画から（無ければ号室未設定の区画。どちらも無ければ空）
  function reportInit(raw, room) {
    const r = normalizeResult(raw);
    const b = resultRoomFor(r, room);
    return { f2: str(b && b.cause), reason: str(r.why), f4: str(r.scope) };
  }
  // 報告書をこのフェーズで作るときの項目（ReportsApi.create に渡す。Task 23）
  //   作業担当者の初期値 = そのフェーズの作業担当者（無ければ開いた人 o.meId）。作業区分はフェーズの種類で決まる
  //   Task 23 I11・I12: 号室 = 案件の号室（cases.room）、作業日 = フェーズの日時（日本時間の日。無ければ今日）、
  //   調査の報告書は調査結果を 原因／原因と判断した理由／次の対応方針 の初期値に（reportInit。管理画面・現場用とも）
  //   o: { meId, title, now, workerName（協力業者URLのとき。worker_id は入れない） }
  function reportFields(phase, caseRow, o) {
    const p = phase || {}, c = caseRow || {}, opt = o || {};
    const WT = { survey: 'investigate', cause: 'repair', repair: 'restore', other: 'repair' }; // Task 37: その他は設備修繕の書式
    const f = { work_type: WT[p.kind] || 'repair', phase_id: p.id || null };
    if (str(opt.workerName)) f.worker_name = str(opt.workerName);
    else f.worker_id = p.worker_id || opt.meId || null;
    if (opt.title) f.phaseTitle = opt.title;
    if (str(c.room)) f.room = str(c.room).slice(0, 40);
    f.work_date = p.scheduled_at ? jstYmd(p.scheduled_at) : jstYmd(toDate(opt.now) || new Date());
    if (p.kind === 'survey' && hasResult(p.result)) f.init = reportInit(p.result, f.room);
    return f;
  }
  // 提出された調査の報告書（選択式の原因・理由・次の対応方針）→ 調査結果（case_phases.result）の空の項目だけ埋めたもの（Task 23 I10）。
  //   変わらなければ null。texts: { cause, reason, next }（ReportLogic.causeText / data.reason / ReportLogic.nextActionText）
  //   Task 25: 原因は報告書の号室（o.room）の区画へ（区画が無ければ足す。役割は o.caseRow の部屋から）。号室が無ければ号室未設定の区画
  function resultFromReport(currentResult, texts, o) {
    const cur = normalizeResult(currentResult);
    const t = texts || {};
    const opt = o || {};
    const next = Object.assign({}, cur, { rooms: cur.rooms.map(b => Object.assign({}, b)) });
    let changed = false;
    [['why', t.reason], ['scope', t.next]].forEach(([k, v]) => {
      if (!str(cur[k]) && str(v)) { next[k] = str(v); changed = true; }
    });
    if (str(t.cause)) {
      const room = str(opt.room).slice(0, 40);
      const want = roomNorm(room);
      let b = want ? next.rooms.find(x => roomNorm(x.room) === want) : next.rooms.find(x => !x.room);
      if (!b && want && next.rooms.length === 1 && !next.rooms[0].room) b = next.rooms[0]; // 旧い形の区画だけなら、そこに入れる
      if (!b) {
        const ch = planRoomChoices(opt.caseRow).find(x => roomNorm(x.room) === want);
        b = { room, role: ch ? ch.role : '', cause: '', damage: '' };
        next.rooms.push(b);
      }
      if (!str(b.cause)) { b.cause = str(t.cause); changed = true; }
    }
    return changed ? next : null;
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
  // 見積・報告書の「下書き → 提出済み → 共有 → 承諾（見積）／確認（報告書）」
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
    // 提出済み（Task 23 C1）: 見積は issued 以降、報告書は submitted 以降（社内・協力業者とも）
    const submitted = shared || (isEst ? (d.status === 'issued' || !!d.issued_at)
      : (d.status === 'submitted' || d.status === 'confirmed' || !!d.submitted_at));
    const subAt = isEst ? d.issued_at || null : d.submitted_at || null;
    const steps = [{ key: 'draft', label: '下書き', done: true, date: d.created_at || null },
      { key: 'submitted', label: '提出済み', done: submitted, date: submitted ? subAt : null },
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

  /* ---------- 提出後の再編集（Task 35） ---------- */
  // 報告書・見積書の行（reports / estimates 表の行か case_summaries の要素）→ 再編集の印
  //   { key: 'editing'（再編集中＝まだ再提出していない）| 'edited'（再編集あり＝再提出済み・管理者の確認／送付の前）| 'history'（印は消えた・回数だけ）,
  //     short: '再編集中' | '再編集あり' | '', text: '再編集中（10/22 14:05 鈴木）' | '再編集あり（…）' | '再編集 1回', at, by, count } か null
  function reeditMark(doc) {
    const d = doc || {};
    const count = Math.max(0, Number(d.reedit_count) || 0);
    if (!count && !d.reedit_mark) return null;
    const at = d.reedit_at || null, by = str(d.reedit_by_name);
    const when = [at ? fmtMDHM(at) : '', by].filter(Boolean).join(' ');
    if (d.reedit_mark) {
      const key = d.status === 'draft' ? 'editing' : 'edited';
      const short = key === 'editing' ? '再編集中' : '再編集あり';
      return { key, short, text: short + (when ? `（${when}）` : ''), at, by, count };
    }
    return { key: 'history', short: '', text: `再編集 ${count}回`, at, by, count };
  }
  // 再編集に戻せるか（画面のボタン。権限は DB の関数が見る）。kind: 'report' | 'estimate'。
  //   報告書: 提出済み・確認済み（依頼元へ送付の前）／見積書: 提出済み（issued）の最新の版（送付の前）
  //   → { ok, reason: ok でないときの文（送付済みは「管理者に連絡」を案内）}
  function canReedit(kind, doc, opts) {
    const d = doc || {}, o = opts || {};
    if (kind === 'report') {
      if (d.status === 'submitted' || d.status === 'confirmed') return { ok: true, reason: '' };
      if (d.status === 'sent') return { ok: false, reason: '依頼元へ送付済みのため再編集できません。直したいときは「管理者に連絡」から知らせてください' };
      return { ok: false, reason: '' };
    }
    if (d.status === 'issued' && o.latest !== false) return { ok: true, reason: '' };
    if (d.status === 'sent' || d.status === 'accepted') return { ok: false, reason: '依頼元へ送付済みのため再編集できません。直したいときは「管理者に連絡」から知らせてください' };
    return { ok: false, reason: '' };
  }

  /* ---------- 案件ページのフェーズの行（Task 9 は フェーズ名・日時・対応状況 だけ表示。Task 10 の表の列のデータもここで作る） ---------- */
  // phase: case_phases の行（か case_summaries.phases の要素）、seq: 同じ種類の何回目、
  // docs: { estimates（全版可）, reports, mails（このフェーズの mail_drafts） }（省略時は phase.estimates / phase.reports）、now
  //   → { id, kind, title, when, stage, short, report, estimate, bill, payment, worker, brief }
  //     when: { at, end, text: '10/20 9:00' | '未定' } / stage: stage() の値 / short: 表のセル向けの短い段階 '🔴 調査に行く' '🟡 承諾待ち 2日' '✓ 完了'
  //     report: { state: 'none'|'draft'|'waiting'|'submitted'|'confirmed'|'shared'|'viewed', text, date } / estimate: { state: 'none'|'draft'|'sent'|'accepted', text, version, amount }
  //     bill: { state: 'unbilled'|'billed'|'paid', text } / payment: { state: 'none'|'due'|'overdue'|'paid', text } / worker: workerState() / brief: 指示があるか
  //   opts（Task 25）: { me, members }（stage と同じ）
  function phaseRow(phase, seq, docs, now, opts) {
    const p = phase || {};
    const o = opts || {};
    const nowAt = toDate(now) || new Date();
    const d = docs || {};
    const estimates = listOf(d.estimates != null ? d.estimates : p.estimates);
    const reports = listOf(d.reports != null ? d.reports : p.reports);
    const mails = listOf(d.mails);
    const st = stage(p, { estimates, reports }, nowAt, o);
    const days = st.date ? Math.max(0, Math.round((ms(jstYmd(nowAt)) - ms(jstYmd(st.date))) / 86400000)) : 0;
    const shortLabel = st.key === 'visit' ? '調査に行く' : st.key === 'issued' ? '見積書提出済み' :
      st.key === 'report' && isWork(p.kind) ? '完了報告必要' :
      st.key === 'approval' ? `発注待ち${st.date && days ? ` ${days}日` : ''}` : st.label;
    const short = st.ball ? `${MARK[st.ball]} ${shortLabel}` : `✓ ${st.label}`;
    // 報告書: 一番進んでいるもの（共有・確認 > 確認済み > 提出済み > 下書き）
    const rank = { draft: 0, waiting: 1, submitted: 2, ready: 3, confirmed: 3, shared: 4, viewed: 5 };
    let report = { state: 'none', text: '未作成', date: null };
    for (const r of reports) {
      const t = docTrack(r, mails);
      const shared = t.steps.find(x => x.key === 'shared');
      const seen = t.steps.find(x => x.key === 'confirmed');
      // 社内（管理者・スタッフ）が提出したものは確認の段を飛ばす＝「提出済み（未送付）」（Task 23。stage の「報告書を送る」と同じ）
      const s = seen && seen.done ? 'viewed' : shared && shared.done ? 'shared' : r.status === 'confirmed' ? 'confirmed'
        : r.status === 'submitted' ? (needsCheck(r, o.me) ? 'submitted' : 'ready')
        : 'draft'; // Task 25: 担当者URLはいつもあるので、下書きは「下書き」（報告待ちは対応状況の欄に出る）
      const date = s === 'viewed' ? seen.date : s === 'shared' ? shared.date : null;
      if (report.state === 'none' || rank[s] > rank[report.state]) {
        report = { state: s, date, text: s === 'viewed' ? `確認 ${fmtMD(date)}` : s === 'shared' ? `共有${date ? ' ' + fmtMD(date) : ''}`
          : s === 'confirmed' ? '確認済み（未送付）' : s === 'ready' ? '提出済み（未送付）' : s === 'submitted' ? '提出済み・確認待ち'
            : '下書き' }; // Task 28 確認: 「協力業者が入力中」等の古い文言は無い（担当者URLはいつもあるので「下書き」）
      }
    }
    // Task 35: 再編集の印（再編集中を先に。表のセルの小さな札）
    const rmarks = reports.map(reeditMark).filter(m => m && m.key !== 'history');
    report.reedit = rmarks.find(m => m.key === 'editing') || rmarks[0] || null;
    // 見積: 最新の版（承諾があればそれ）
    const live = liveEstimates(estimates);
    const acc = live.filter(isAccepted).sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0))[0];
    const last = acc || live.slice().sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0)
      || String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
    let estimate = { state: 'none', text: '未作成', version: null, amount: null, cost: null, reedit: null };
    if (last) {
      const v = Number(last.version) || 1;
      const amount = last.total != null ? Number(last.total) : null;
      // Task 35: 原価の税込合計（明細の原価から。明細が無い要素・原価の無い見積は null＝「原価 —」）
      const ct = Array.isArray(last.lines) ? EL().costTotals(last.lines) : null;
      const cost = ct ? ct.total : null;
      const rm = reeditMark(last);
      const reedit = rm && rm.key !== 'history' ? rm : null;
      if (acc) estimate = { state: 'accepted', text: `v${v} 承諾`, version: v, amount, cost, reedit };
      else if (last.status === 'sent') estimate = { state: 'sent', text: `v${v} 送付${last.sent_at ? ' ' + fmtMD(last.sent_at) : ''}`, version: v, amount, cost, reedit };
      // 提出済み（issued）は下書きと分ける（Task 23 C1。対応状況の「見積書提出済み（送付する）」と同じ）
      else if (last.status === 'issued') estimate = { state: 'issued', text: `v${v} 提出済み（未送付）`, version: v, amount, cost, reedit };
      else estimate = { state: 'draft', text: `v${v} 下書き`, version: v, amount, cost, reedit };
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
  // Task 28: 作業担当者への催促の記録（表の確認セル）→ '催促 10/25（2回）'（無ければ ''）
  const nudgeText = phase => (phase && phase.nudged_at ? `催促 ${fmtMD(phase.nudged_at)}（${Math.max(1, Number(phase.nudge_count) || 1)}回）` : '');
  // Task 28: 表の「担当者」の列（作業担当者の名前・未設定）
  function workerCol(phase, members) {
    const p = phase || {};
    if (!p.worker_id) return { set: false, text: '未設定' };
    return { set: true, text: workerNameOf(p, members) || '（退会したメンバー）' };
  }
  // Task 28: 催促の文（作業担当者から見た今の段階）→ { text: '報告書を書いて提出（期限 10/26）', due, late（期限を過ぎて未提出）} か null（作業担当者なし）
  //   見積書の期限（estimate_due）があれば「見積書を仕上げて提出（期限 M/D）」（🔔 と同じ）。それ以外は stage を作業担当者として見た文
  function nudgeInfo(phase, docs, now) {
    const p = phase || {};
    if (!p.worker_id) return null;
    const d = docsOf(p, docs);
    const todo = estimateTodo(Object.assign({}, p, { estimates: d.estimates }), now);
    if (todo) return { text: `見積書を仕上げて提出（期限 ${fmtYmdMD(todo.due)}）`, due: todo.due, late: todo.late };
    const st = stage(p, d, now, { me: p.worker_id });
    if (!st.label) return null;
    const hasDue = /期限|期日/.test(st.label);
    return { text: st.label + (st.due && !hasDue ? `（期限 ${fmtYmdMD(st.due)}）` : ''), due: st.due || null, late: !!(st.due && st.late) };
  }

  // 案件ページの上部の「今の状態」1行。phases はこの案件のフェーズ（各 estimates / reports 付き。stage と同じ）
  //   → { us, them, next: caseNext の先頭（無ければ null）, text: '🔴 自社の番 2件 ・ 🟡 相手待ち 1件 ・ 次: 10/20 9:00 調査に行く' }
  function caseNow(phases, now, opts) {
    const rows = caseNext(phases, now, opts);
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
    const lines = [`${str(org && org.name) ? str(org.name) + 'です。' : ''}${place ? place + 'の' : ''}${workName(p.kind, p) || '作業'}の報告書の入力をお願いします。`];
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
  // 予定の日時の短い表示: '11/5（水）9:00' / '日時未定'（Task 31: 「今日」「明日」は案件タブの見出しだけ。ほかは具体の日付）
  function fieldWhen(at, now) { // eslint-disable-line no-unused-vars
    return jst(at) ? fmtMDWHM(at) : '日時未定';
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
      const st = p ? stage(p, null, nowAt, { me: meId }) : null;
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
  // Task 27: 現場用トップ（#f）の一番上の「🧾 見積書を提出（期限 M/D）」カード。🔔 の「見積書を仕上げて提出」と同じ判定
  //   （進行中の案件・そのフェーズの作業担当者が自分・estimate_due あり・見積が未提出（下書きだけ・無い）・請求も入金もまだ。estimateTodo）
  //   → [{ caseRow, phase, title, due, late, label, draft（続きを開く見積の下書き or null）}]。並び: 期限を過ぎたもの → 期限の早い順 → 物件名
  function fieldEstimateCards(caseRows, meId, now) {
    const nowAt = toDate(now) || new Date();
    const out = [];
    if (!meId) return out;
    for (const c of listOf(caseRows)) {
      if ((c.status && c.status !== 'open') || c.deleted_at) continue;
      for (const { p, seq } of withSeq(c.phases)) {
        if (p.worker_id !== meId) continue;
        const todo = estimateTodo(p, nowAt);
        if (!todo) continue;
        const drafts = listOf(p.estimates).filter(e => e && e.status === 'draft' && e.id);
        out.push({ caseRow: c, phase: p, title: phaseTitle(p, seq), due: todo.due, late: todo.late,
          label: `見積書を提出（期限 ${fmtYmdMD(todo.due)}）`, draft: drafts[drafts.length - 1] || null });
      }
    }
    return out.sort((a, b) => (b.late ? 1 : 0) - (a.late ? 1 : 0) || a.due.localeCompare(b.due)
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
      // Task 25: 報告書はいつも担当者URL付き（「調査報告待ち」の表示はやめた）。下書きは「続きを書く」
      report = r.status === 'draft'
        ? { state: 'draft', text: more(reports.length, r.reedit_mark ? `再編集中（写真 ${photos}枚）` : `下書きあり（写真 ${photos}枚）`) + (r.reedit_mark ? ' ・ 直して再提出' : ' ・ 続きを書く'), open: r, count: reports.length }
        // Task 40: 提出後も中身を見る・直す（直すのは依頼元へ送付の前だけ。Task 35 の再編集）
        : { state: 'done', open: r, count: reports.length,
          text: more(reports.length, r.status === 'sent' ? '依頼元へ送付済み' : r.status === 'confirmed' ? '確認済み' : ('提出済み ' + fmtMD(r.submitted_at)).trim())
            + (r.status === 'sent' ? ' ・ 中身を見る' : ' ・ 中身を見る・直す') };
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
        ? { state: 'draft', text: more(series.length, e.reedit_mark ? '再編集中' : '下書きあり') + (e.reedit_mark ? ' ・ 直して再提出' : ' ・ 続きを書く'), open: e, count: series.length }
        : { state: 'done', text: more(series.length, '提出済み') + ' ・ 開く', open: e, count: series.length };
    }
    const notices = listOf(d.notices).slice().sort(byCreated);
    const notice = !notices.length ? { state: 'none', text: 'まだありません ・ 新しく作る', open: null, count: 0 }
      : notices.length === 1 ? { state: 'many', text: '1件 ・ 開く／複製して別の号室', open: notices[0], count: 1 }
        : { state: 'many', text: `${notices.length}件 ・ 一覧を開く`, open: null, count: notices.length };
    return { report, estimate, notice };
  }

  /* ---------- 現場用アプリのタブ（Task 29） ---------- */
  // 「案件」タブ: 本日行く現場・対応の一覧。自分が作業担当者（または案件の担当者）のフェーズを 日付 → 時刻 の順に。
  //   group: today（今日・時刻順）→ later（明日以降・日付順）→ tbd（日時未定・済んでいないもの）→ past（日時を過ぎて自分の番が残っているもの）→
  //   none（自分が担当の案件で対応がまだ無い）。済んだフェーズ（今日のもの以外）は出さない。進行中の案件だけ
  //   → [{ caseRow, phase, title, group, at, when, time, date（'10/22（水）'）, visit（Task 31: 今回行く部屋「101・201号室」）, stage, stageText, today }]
  // Task 31: today（本日）→ tomorrow（明日）→ later（明日以降）→ past → none → tbd（日時未定は最後）
  // Task 40: submitted（自分が作業担当者で報告書を提出済み〜依頼元へ送る前・再編集中）は日時未定の上
  const SCHEDULE_GROUPS = ['today', 'tomorrow', 'later', 'past', 'none', 'submitted', 'tbd'];
  // Task 40: 対応の最新の報告書が 提出済み・確認済み（依頼元へ送る前）か再編集中なら案件タブの印 → { key, text, at } か null
  function fieldSubmitted(phase) {
    const reports = listOf(phase && phase.reports).slice().sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    const r = reports[reports.length - 1];
    if (!r) return null;
    if (r.status === 'draft' && r.reedit_mark) return { key: 'editing', text: '報告書 再編集中', at: r.reedit_at || r.submitted_at || null };
    if (r.status !== 'submitted' && r.status !== 'confirmed') return null;
    return { key: r.status, text: ('報告書 提出済み ' + fmtMD(r.submitted_at)).trim() + (r.status === 'confirmed' ? ' ・ 確認済み' : ''), at: r.submitted_at || null };
  }
  function fieldSchedule(caseRows, meId, now) {
    const nowAt = toDate(now) || new Date();
    const today = jstYmd(nowAt);
    const tomorrow = jstYmd(ms(nowAt) + 86400000);
    const out = [];
    if (!meId) return out;
    for (const c of listOf(caseRows)) {
      if ((c.status && c.status !== 'open') || c.deleted_at) continue;
      const mineCase = c.assignee_id === meId;
      const list = withSeq(c.phases).filter(({ p }) => mineCase || p.worker_id === meId);
      if (!list.length) {
        if (mineCase && !listOf(c.phases).length) {
          out.push({ caseRow: c, phase: null, title: '', group: 'none', at: null, when: '対応なし', time: '', visit: '', stage: null, stageText: '', today: false });
        }
        continue;
      }
      for (const { p, seq } of list) {
        const st = stage(p, null, nowAt, { me: meId });
        const at = p.scheduled_at || null;
        const sub = p.worker_id === meId ? fieldSubmitted(p) : null;
        let group;
        if (sub) group = 'submitted';
        else if (at && jstYmd(at) === today) group = 'today';
        else if (at && jstYmd(at) === tomorrow) group = 'tomorrow';
        else if (at && jstYmd(at) > today) group = 'later';
        else if (!at) group = st.ball ? 'tbd' : '';
        else group = st.ball === 'us' ? 'past' : '';
        if (!group) continue;
        const pj = jst(at);
        out.push({ caseRow: c, phase: p, title: phaseTitle(p, seq), group, at, when: fieldWhen(at, nowAt), time: pj ? fmtHM(pj) : '', date: fmtMDW(at),
          visit: visitShort(p.plan, c), stage: st, stageText: fieldStageLabel(st) || (st.label ? '✓ ' + st.label : ''), today: group === 'today', sub });
      }
    }
    const gi = x => SCHEDULE_GROUPS.indexOf(x.group);
    return out.sort((a, b) => gi(a) - gi(b)
      || (a.group === 'today' || a.group === 'tomorrow' || a.group === 'later' ? ms(a.at) - ms(b.at) : a.group === 'past' ? ms(b.at) - ms(a.at)
        : a.group === 'submitted' ? (ms(b.sub.at) || 0) - (ms(a.sub.at) || 0) : 0)
      || str(a.caseRow.name).localeCompare(str(b.caseRow.name), 'ja') || str(a.title).localeCompare(str(b.title), 'ja'));
  }

  // 案件タブの見出し（Task 31）: 本日（10/21（火））／明日（10/22（水））／明日以降／…／日時未定
  function scheduleGroupLabel(group, now) {
    const nowAt = toDate(now) || new Date();
    if (group === 'today') return `本日（${fmtMDW(nowAt)}）`;
    if (group === 'tomorrow') return `明日（${fmtMDW(ms(nowAt) + 86400000)}）`;
    return { later: '明日以降', past: '日時を過ぎた対応（まだ自分の番）', none: '対応がまだ無い案件', submitted: '提出済み（管理者の確認待ち）', tbd: '日時未定' }[group] || '';
  }
  // 古いリンク #f/case/{id} の行き先（Task 31）: 自分が担当（作業担当者。案件の担当者なら全部）で未完了のフェーズのうち、今に一番近い予定のもの
  //   （日時未定は後ろ・その中では新しいもの）。無ければ null（履歴ページへ）
  function fieldRedirectPhase(caseRow, meId, now) {
    const c = caseRow || {};
    const nowMs = ms(now) != null ? ms(now) : Date.now();
    const mine = withSeq(c.phases).filter(({ p }) => !p.done_at && meId && (p.worker_id === meId || c.assignee_id === meId));
    if (!mine.length) return null;
    const dated = mine.filter(x => x.p.scheduled_at).sort((a, b) => Math.abs(ms(a.p.scheduled_at) - nowMs) - Math.abs(ms(b.p.scheduled_at) - nowMs));
    return dated.length ? dated[0].p : mine[mine.length - 1].p;
  }
  // 「過去の対応履歴」（#f/case/{id}/history。Task 31）: この案件の全フェーズを日付順（日時未定は最後・作成順）
  //   docs = { reports, estimates（全版）, notices }（表の行）→ [{ phase, title, when, stage, stageText, tools: fieldTools の値 }]
  function fieldHistory(caseRow, docs, now, meId) {
    const d = docs || {};
    const nowAt = toDate(now) || new Date();
    const list = withSeq(caseRow && caseRow.phases).map((x, i) => Object.assign({ i }, x));
    list.sort((a, b) => (a.p.scheduled_at ? 0 : 1) - (b.p.scheduled_at ? 0 : 1)
      || (a.p.scheduled_at && b.p.scheduled_at ? ms(a.p.scheduled_at) - ms(b.p.scheduled_at) : 0) || a.i - b.i);
    return list.map(({ p, seq }) => {
      const st = stage(p, null, nowAt, { me: meId });
      const own = k => listOf(d[k]).filter(x => x.phase_id === p.id);
      return { phase: p, title: phaseTitle(p, seq), when: fieldWhen(p.scheduled_at, nowAt), stage: st,
        stageText: fieldStageLabel(st) || (st.label ? '✓ ' + st.label : ''),
        tools: fieldTools({ reports: own('reports'), estimates: own('estimates'), notices: own('notices') }) };
    });
  }

  // 報告書の期限超過で管理者に自動の連絡を入れる対象（Task 29。アプリを開いたときに判定。1回だけ = report_overdue_at が空のもの）
  //   進行中の案件のフェーズで、報告書が未提出のまま期限（reportTodo）を過ぎたもの → [{ caseRow, phase }]
  function overdueReports(caseRows, now) {
    const out = [];
    for (const c of listOf(caseRows)) {
      if ((c.status && c.status !== 'open') || c.deleted_at) continue;
      for (const p of listOf(c.phases)) {
        if (!p.id || p.report_overdue_at || taskFlag(p, 'report', 'dismiss')) continue; // Task 43: 報告書作成を削除している間は知らせない
        const rt = reportTodo(p, now);
        if (rt && rt.late) out.push({ caseRow: c, phase: p });
      }
    }
    return out;
  }

  // 日報（Task 32）は js/daily-logic.js（DailyLogic）

  // 見積の提出で作る工事掲示の初期値（Task 29）。原因元工事・復旧工事のフェーズだけ（調査は null）
  //   号室 = 案件の部屋、工事名称 = 「原因元工事」「復旧工事」＋ 見積の件名、工事日 = フェーズの工事日（未定なら「工事日は未定」）、
  //   工事内容のチェック = 調査結果の注意事項 ＋ 見積の備考の文（騒音／振動／断水／排水制限／通行制限／臭気）、排水制限の号室 = 調査結果の号室
  //   → NoticesApi.create の opts.data（workTypes / drainRooms / otherWorkText / roomNo / workName / workDate… / workDateTbd / autoFrom）
  function autoNoticeData({ phase, caseRow, phases, estimate } = {}) {
    const p = phase || {}, c = caseRow || {};
    if (!isWork(p.kind)) return null;
    const ed = (estimate && estimate.data) || {};
    const subject = str(ed.subject);
    const data = { roomNo: str(c.room).slice(0, 80), workName: (workName(p.kind, p) + (subject ? ' ' + subject : '')).slice(0, 80), autoFrom: 'estimate' };
    if (p.scheduled_at) {
      data.workDate = jstYmd(p.scheduled_at);
      data.timeStart = fmtHM(jst(p.scheduled_at)).padStart(5, '0');
      if (p.scheduled_end && ms(p.scheduled_end) > ms(p.scheduled_at)) {
        if (jstYmd(p.scheduled_end) !== data.workDate) data.workDateEnd = jstYmd(p.scheduled_end);
        data.timeEnd = fmtHM(jst(p.scheduled_end)).padStart(5, '0');
      }
    } else data.workDateTbd = true;
    const r = latestSurveyResult(phases);
    const init = r ? noticeInit(r) : { workTypes: {}, drainRooms: '', otherWorkText: '' };
    const wt = {};
    NL().WORK_TYPES.forEach(w => { wt[w.key] = !!init.workTypes[w.key]; });
    const notes = [str(ed.notes && ed.notes.extra), str(ed.notes && typeof ed.notes === 'string' ? ed.notes : '')].join('\n');
    NL().WORK_TYPES.forEach(w => { if (w.key !== 'other' && w.text && notes.includes(w.text)) wt[w.key] = true; });
    if (notes.includes(NL().NOISE_VIBRATION_TEXT)) { wt.noise = true; wt.vibration = true; }
    data.workTypes = wt;
    data.drainRooms = wt.drain ? init.drainRooms : '';
    data.otherWorkText = wt.other ? init.otherWorkText : '';
    return data;
  }

  // 案件ページの表の「工事掲示」の列（Task 29）。notices = このフェーズの工事掲示（notices 表の行）
  //   → { state: 'na'（調査）|'none'|'auto'（見積の提出で自動で作った下書き・まだ手で直していない）|'made'|'many', text, open（1件のときの掲示） }
  function noticeCell(phase, notices) {
    const p = phase || {};
    if (!isWork(p.kind)) return { state: 'na', text: '—', open: null };
    const list = listOf(notices);
    if (!list.length) return { state: 'none', text: '未作成', open: null };
    if (list.length > 1) return { state: 'many', text: `${list.length}件`, open: null };
    const auto = !!(list[0].data && list[0].data.autoFrom);
    return { state: auto ? 'auto' : 'made', text: auto ? '下書き（自動）' : '作成済み', open: list[0] };
  }


  /* ---------- Task 36: 作業担当者の見積書入力で見る「調査の内容」 ---------- */
  const RL = () => (inNode ? require('./report-logic.js') : root.ReportLogic);
  // 提出済みの報告書（提出済み・確認済み・依頼元へ送付済み。下書き＝再編集中は入れない）
  const SURVEY_REPORT_DONE = ['submitted', 'confirmed', 'sent'];
  const reportDoneAt = r => ms(r.submitted_at) || ms(r.updated_at) || ms(r.created_at) || 0;
  // その調査の提出済みの報告書のうち一番新しいもの（無ければ null）
  function surveyReportOf(reports, phaseId) {
    const list = listOf(reports).filter(r => r.phase_id === phaseId && SURVEY_REPORT_DONE.includes(r.status));
    return list.sort((a, b) => reportDoneAt(b) - reportDoneAt(a))[0] || null;
  }
  // 見積書（estPhaseId のフェーズ）と一緒に見る調査 → { phase, title, report }。
  //   調査の見積 → その調査。工事の見積 → 作られた元の調査（source_phase_id。058 より前の行・手で足したフェーズは空）→ 同じ案件の、提出済みの報告書がある一番新しい調査。
  //   report が null = まだ調査の報告書がない（phase も null = 調査が無い）
  function estimateSurvey(caseRow, reports, estPhaseId) {
    const all = withSeq(caseRow && caseRow.phases);
    const surveys = all.filter(x => x.p.kind === 'survey');
    const pack = x => (x ? { phase: x.p, title: phaseTitle(x.p, x.seq), report: surveyReportOf(reports, x.p.id) } : { phase: null, title: '', report: null });
    const own = all.find(x => x.p.id === estPhaseId);
    if (own && own.p.kind === 'survey') return pack(own);
    // Task 37 / migration 058: 作った元の調査の記録（source_phase_id）があればその調査（報告書が再編集中なら「まだ…ありません」）
    const src = own && own.p.source_phase_id ? surveys.find(x => x.p.id === own.p.source_phase_id) : null;
    if (src) return pack(src);
    const done = surveys.filter(x => surveyReportOf(reports, x.p.id));
    if (done.length) return pack(done[done.length - 1]);
    return pack(surveys[surveys.length - 1] || null);
  }
  // 'YYYY-MM-DD' → '11/2（月）'（日付だけで読む）
  function fmtYmdMDW(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    if (!m) return '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return `${+m[2]}/${+m[3]}（${WEEK[d.getUTCDay()]}）`;
  }
  // 調査の内容の要約（見積書の入力画面の折りたたみ欄・調査の内容ページで共通）。src = estimateSurvey の戻り値（report があるとき）
  //   estPhase: 見積のフェーズ（見積書の期限と理由を出す。任意）
  //   → { title, date: '調査日 11/2（月）', rooms: [{ name, role, roleText, cause, damage }], reason, workItems: [], workText,
  //       next, due: '見積書の期限 11/4（水）（理由: …）', extras: [{ label, value }]（漏水の状況・漏水時の対応・お部屋の状況）,
  //       photos: [{ path, caption, marks }] }
  function surveySummary(src, estPhase) {
    const s = src || {}, p = s.phase || {}, r = s.report || {};
    const R = RL();
    const d = R.normalizeData(r.data);
    const res = normalizeResult(p.result);
    const day = fmtYmdMDW(r.work_date) || (p.scheduled_at ? fmtMDW(p.scheduled_at) : '');
    let rooms = res.rooms.filter(resultRoomHas).map(b => ({
      name: b.room ? roomLabel(b.room) : '号室未設定', role: b.role, roleText: b.role ? roomRoleLabel(b.role) : '',
      cause: str(b.cause), damage: str(b.damage)
    }));
    const cause = R.causeText(d);
    if (!rooms.length && cause) rooms = [{ name: roomLabel(r.room) || 'この案件の部屋', role: '', roleText: '', cause, damage: '' }];
    const rows = R.resultRows({ work_type: r.work_type || 'investigate', data: r.data });
    const val = label => (rows.find(x => x.label === label) || {}).value || '';
    const ep = estPhase || {};
    const due = /^\d{4}-\d{2}-\d{2}/.test(str(ep.estimate_due)) ? `見積書の期限 ${fmtYmdMDW(ep.estimate_due)}${estimateDueReasonText(ep)}` : '';
    return {
      title: s.title || phaseTitle(p), date: day ? `調査日 ${day}` : '',
      rooms,
      reason: str(d.reason) || str(res.why),
      workItems: R.chipsForPdf({ work_type: r.work_type || 'investigate', data: r.data }),
      workText: str(d.f1),
      next: R.nextActionText(d) || str(res.scope),
      due,
      extras: ['漏水の状況', '漏水時の対応', 'お部屋の状況'].map(label => ({ label, value: val(label) })).filter(x => x.value),
      photos: listOf(r.photos).filter(x => x && x.path).map(x => ({ path: String(x.path), caption: str(x.caption), marks: x.marks }))
    };
  }

  /* ---------- Task 37: 作業担当者の案件登録（現場用 #f/new。DB は rpc field_create_case / migration 058） ---------- */
  const NEW_CASE_MAX = { name: 100, room: 40, address: 200, resident: 100, contact: 254, tel: 40, request: 2000 };
  // 'YYYY-MM-DDTHH:MM'（日時の入力欄）を日本時間として読む → Date（読めなければ null）
  function jstInput(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(str(v));
    if (!m) return null;
    const d = jstAt(+m[1], +m[2], +m[3], +m[4], +m[5]);
    return jstYmd(d) === `${m[1]}-${m[2]}-${m[3]}` ? d : null;
  }
  // 入力 → { ok, errors: { 欄: 文 }, args（rpc の引数） }。DB の確かめと同じ（前後の空白は除く・連絡先は「@」があればメール）
  function newCaseCheck(v) {
    const x = v || {};
    const errors = {};
    const f = { name: str(x.name), room: str(x.room), address: str(x.address), resident: str(x.resident), contact: str(x.contact),
      kind: str(x.kind), label: str(x.label), request: str(x.request) };
    const need = (k, label) => { if (!f[k]) errors[k] = label + 'を入れてください'; else if (Array.from(f[k]).length > NEW_CASE_MAX[k]) errors[k] = `${label}は${NEW_CASE_MAX[k]}文字までです`; };
    need('name', '物件名'); need('room', '号室'); need('address', '住所'); need('resident', '入居者の名前');
    if (f.contact.includes('@')) {
      if (f.contact.length > NEW_CASE_MAX.contact || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.contact)) errors.contact = '連絡先のメールアドレスの形が正しくありません';
    } else if (Array.from(f.contact).length > NEW_CASE_MAX.tel) errors.contact = '連絡先（電話番号）は40文字までです';
    const at = jstInput(x.at);
    if (!at) errors.at = '訪問日時を入れてください';
    if (!KIND_KEYS.includes(f.kind)) errors.kind = 'フェーズを選んでください';
    if (f.kind === 'other') {
      if (!f.label) errors.label = '「その他」の名前を入れてください（例: 点検・清掃）';
      else if (Array.from(f.label).length > LABEL_MAX) errors.label = `「その他」の名前は${LABEL_MAX}文字までです`;
    }
    if (Array.from(f.request).length > NEW_CASE_MAX.request) errors.request = '依頼内容詳細は2000文字までです';
    const ok = Object.keys(errors).length === 0;
    return { ok, errors, args: ok ? { p_name: f.name, p_room: f.room, p_address: f.address, p_resident_name: f.resident, p_contact: f.contact,
      p_scheduled_at: at.toISOString(), p_kind: f.kind, p_label: f.kind === 'other' ? f.label : null, p_request: f.request } : null };
  }

  const api = { KINDS, KIND_KEYS, STEPS, LABEL_MAX, isWork, workName, NEW_CASE_MAX, jstInput, newCaseCheck, MARK, SLOTS, RECIPIENTS, BILL_TO, kindLabel, steps,
    ROOM_ROLES, roomKey, isRoomKey, roomRoleLabel, roomsOf, roomTitle, recipientOrder, roomChoices, contactTitle, hasResident,
    toDate, jstYmd, jstYm, jstAt, fmtMD, fmtMDHM, fmtMDWHM, fmtRange,
    phaseTitle, stage, workerStage, isBlankReport, estimateTodo, reportTodo, ymdAdd, reportState, shareRequestText, caseNext, nextText, caseFlags, teamStages, TASK_GROUPS, taskGroupOf, taskGroups, reminderSlots, scheduleSetAt, dueReminders, staleReminders, reminderState,
    mailLabel, recipientsLabel, canSkip, groupOutbox, contacts, defaultRecipients, scheduleMail, reminderMail, docTrack,
    GREETING, CLOSING, roomLabel, placeName, addresseeLine, addresseeLines, setAddressee,
    REQUEST_SYMPTOMS, REQUEST_TEXT_MAX, REQUEST_FIELD_MAX, REQUEST_PHOTOS_MAX, REQUEST_HEAD, normalizeRequest, requestItems, hasRequest, requestLines, requestSummary, staffSectionLines,
    LATE_CHOICES, LATE_MAX, lateLabel, parseLateMinutes, caseResidents, residentTelOpen,
    BRIEF_SUSPECTS, BRIEF_TASKS, BRIEF_PRIORITY, VISIT_HEAD, VISIT_MAX, VISIT_ROOMS_HEAD, visitDefault, visitSelected, visitRooms, visitText, visitLine, visitShort, visitLines, visitToggle, visitTaskRows, fieldTaskRow, TASK_TODO, taskFlag, taskSendbacks, normalizeBrief, briefLines, hasBrief, briefSummary, briefRoomHead, photoRooms, planRoomChoices, setBriefSection, STAFF_TAILS,
    scheduleForm, introLine, reeditMark, canReedit, phaseRow, workerCell, nudgeText, workerCol, nudgeInfo, caseNow,
    phaseLink, staffNoticeMail, staffReminderMail, dueStaffReminders, workerState, staffInbox,
    MOVE_ITEMS_TEXT, cautionChoices, normalizeResult, hasResult, resultRoomFor, cautionSentences, surveyResultMail, ESTIMATE_LATER, fmtYmdLong, estimatePromise, estimatePromiseText, latestSurveyResult,
    reportInit, reportFields, resultFromReport, estimateNoteExtra, noticeInit, MESSAGE_SUBJECTS, messageForMe, messageThreads,
    billingBasis, billingAmount, billToLabel, groupBilling,
    BILL_STATUS_LABEL, BILLING_MODE_LABEL, billStatus, yen, parseYen, ymLabel, addMonth, billingMonthOf, showsBilling,
    paymentDueDefault, isOverdue, fmtYmdMD,
    fieldMine, fieldWhen, fieldDefaultPhase, fieldFocus, fieldStageLabel, fieldCases, fieldEstimateCards, fieldPhaseChips, fieldTools,
    SURVEY_WORK_HOURS, REPORT_GRACE_HOURS, workEndAt, reportDueAt, reportDueText, ESTIMATE_DUE_DAYS, estimateDueNeedsReason, estimateDueReasonText,
    SCHEDULE_GROUPS, fieldSchedule, fieldSubmitted, scheduleGroupLabel, fieldRedirectPhase, fieldHistory, fmtMDW, overdueReports, autoNoticeData, noticeCell,
    SURVEY_REPORT_DONE, surveyReportOf, estimateSurvey, fmtYmdMDW, surveySummary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PhaseLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
