// js/phase-logic.js — 対応フェーズ（調査・原因元工事・復旧工事）の純粋関数（ブラウザ: window.PhaseLogic / node: module.exports）
// 社内画面のフェーズカード・案件一覧の「次:」・連絡メール／リマインド・請求の一覧で使う。
// 時刻はすべて日本時間（UTC+9 固定。日本に夏時間は無い）で判定・表示する。実行環境のタイムゾーンには依存しない
// （getHours 等のローカル関数は使わず、+9時間ずらした値を getUTC* で読む）。
// フェーズの形は case_summaries.phases（migration 021）の要素:
//   { id, kind, seq, scheduled_at, scheduled_end, done_at, bill_to_type, bill_to_name, billing_mode, billing_month,
//     billed_at, paid_at, amount_override, estimates: [...], reports: [...] }
//   estimates の要素 { id, series_id, version, status, total, accepted, sent_at, accepted_at, sent_version, sent_total }
//   reports の要素   { id, work_type, status, sent, sent_at }
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
    survey: [
      { key: 'schedule', label: '調査日を決める' },
      { key: 'visit', label: '調査に行く' },
      { key: 'report', label: '報告書を送る' },
      { key: 'approval', label: '見積の承諾待ち' },
      { key: 'done', label: '完了' }
    ],
    work: [
      { key: 'estimate', label: '見積を送る' },
      { key: 'approval', label: '見積の承諾待ち' },
      { key: 'schedule', label: '工事日を決める' },
      { key: 'work', label: '工事' },
      { key: 'report', label: '報告書を送る' },
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
    { key: 'resident', label: '入居者' }
  ];
  const BILL_TO = { client: '元請', owner: '物件オーナー', resident: '入居者', other: 'その他' };

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

  // フェーズの今の段階 → { key, label, ball: 'us'|'them'|null, date, late? }
  //   調査: 日時未定 → 日時決定・未実施 → 調査済み・報告書未送付 → 見積が送付済みで未承諾 → 完了
  //   工事: 見積未送付 → 承諾待ち → 工事日未定 → 未完了 → 報告書未送付 → 未請求 → 入金待ち → 済
  //   工事は 入金・請求・完了 の記録を先に見る（記録があれば前の段は済んだものとする。旧 対応履歴から移したフェーズは見積が無いため）
  function stage(phase, docs, now) {
    const p = phase || {};
    const { estimates, reports } = docsOf(p, docs);
    const nowAt = toDate(now) || new Date();
    const reportSent = reports.some(isReportSent);
    if (p.kind === 'survey') {
      if (!p.done_at) {
        if (!p.scheduled_at) return mkStage('schedule', '調査日を決める', 'us', null);
        return mkStage('visit', `${fmtMDHM(p.scheduled_at)} 調査に行く`, 'us', p.scheduled_at,
          { late: isLate(p.scheduled_at, nowAt) });
      }
      if (!reportSent) return mkStage('report', '報告書を送る', 'us', p.done_at);
      const pend = pendingApproval(estimates);
      if (pend) return mkStage('approval', '見積の承諾待ち', 'them', pend.date);
      return mkStage('done', '完了', null, p.done_at);
    }
    if (isWork(p.kind)) {
      if (p.paid_at) return mkStage('done', '済', null, p.paid_at);
      if (p.billed_at) return mkStage('payment', '入金待ち', 'them', p.billed_at);
      if (p.done_at) {
        if (!reportSent) return mkStage('report', '報告書を送る', 'us', p.done_at);
        return mkStage('bill', '請求する', 'us', p.done_at);
      }
      if (!liveEstimates(estimates).some(isAccepted)) {
        const pend = pendingApproval(estimates);
        if (pend) return mkStage('approval', '見積の承諾待ち', 'them', pend.date);
        return mkStage('estimate', '見積を送る', 'us', null);
      }
      if (!p.scheduled_at) return mkStage('schedule', '工事日を決める', 'us', null);
      return mkStage('work', `${fmtMD(p.scheduled_at)} 工事`, 'us', p.scheduled_at,
        { late: isLate(p.scheduled_at, nowAt) });
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
        key: st.key, label: st.label, ball: st.ball, mark: MARK[st.ball] || '', date: st.date, late: !!st.late } };
    }).filter(x => x.row.ball);
    const rank = b => (b === 'us' ? 0 : 1);
    rows.sort((a, b) => rank(a.row.ball) - rank(b.row.ball) || a.i - b.i);
    return rows.map(x => x.row);
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
  function staleReminders(phases, drafts) {
    const byId = new Map(listOf(phases).map(p => [p.id, p]));
    return listOf(drafts).filter(d => {
      if (d.purpose !== 'reminder' || d.status !== 'draft') return false;
      const p = byId.get(d.phase_id);
      if (!p || !p.scheduled_at || p.done_at) return true;
      return d.remind_for !== jstYmd(p.scheduled_at);
    });
  }

  /* ---------- 関係者・宛先 ---------- */
  const clientName = c => str(c && (c.client_master_name || c.client_name));
  // 案件の関係者 → [{ key, label, name, email, tel }]（元請・物件オーナー・入居者の順。名前もメールも無い人も含む）
  function contacts(caseRow) {
    const c = caseRow || {};
    return [
      { key: 'client', label: '元請', name: clientName(c), email: str(c.client_email), tel: str(c.client_tel) },
      { key: 'owner', label: '物件オーナー', name: str(c.owner_name), email: str(c.owner_email), tel: str(c.owner_tel) },
      { key: 'resident', label: '入居者', name: str(c.resident_name), email: str(c.resident_email), tel: str(c.resident_tel) }
    ];
  }
  // 宛先の既定（mail_drafts.recipients の値）。メールがある人だけ
  //   schedule: 元請・物件オーナー・入居者 ／ reminder: 入居者・物件オーナー ／ それ以外（報告書・見積）: 元請
  function defaultRecipients(caseRow, purpose) {
    const order = purpose === 'schedule' ? ['client', 'owner', 'resident']
      : purpose === 'reminder' ? ['resident', 'owner'] : ['client'];
    const has = new Set(contacts(caseRow).filter(x => x.email).map(x => x.key));
    return order.filter(k => has.has(k));
  }

  /* ---------- 連絡メール ---------- */
  const withSama = n => (/(様|御中)$/.test(n) ? n : n + '様');
  function placeLines(c) {
    const name = str(c.name);
    const room = str(c.room);
    const lines = [`場所: ${name}${room ? ` ${/号室$/.test(room) ? room : room + '号室'}` : ''}`];
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
    const name = str(caseRow && caseRow.name);
    return `【${head}】${name}${isWork(kind) ? `（${kindLabel(kind)}）` : ''}`;
  }
  function mailBody(kind, phase, caseRow, org, me, leadLine) {
    const c = caseRow || {};
    const p = phase || {};
    const survey = kind === 'survey';
    const orgName = str(org && org.name);
    const lines = ['いつもお世話になっております。'];
    if (orgName) lines.push(`${orgName}でございます。`);
    lines.push(leadLine, '');
    lines.push(`${survey ? '調査日時' : '工事日時'}: ${fmtRange(p.scheduled_at, p.scheduled_end)}`);
    lines.push(...placeLines(c));
    if (survey) lines.push('立ち会い: 入居者様のお立ち会いをお願いいたします');
    lines.push('');
    if (!survey) lines.push('工事中はご不便をおかけいたしますが、ご理解とご協力のほどお願い申し上げます。');
    lines.push('ご都合の悪い点などございましたら、お手数ですがご連絡くださいますようお願いいたします。');
    lines.push('どうぞよろしくお願いいたします。');
    const sig = signature(org, me);
    if (sig.length) lines.push('', ...sig);
    return lines.join('\n');
  }
  const kindFrom = (kind, phase) => (KIND_KEYS.includes(kind) ? kind : phase && phase.kind);

  // 調査日・工事日の連絡（purpose schedule）→ { subject, body }
  function scheduleMail({ kind, phase, caseRow, org, me } = {}) {
    const k = kindFrom(kind, phase);
    const survey = k === 'survey';
    return {
      subject: subjectOf(survey ? '調査日のご連絡' : '工事日のご連絡', k, caseRow),
      body: mailBody(k, phase, caseRow, org, me,
        survey ? '下記の日程で調査に伺います。' : `下記の日程で${kindLabel(k)}を行います。`)
    };
  }
  // リマインド（purpose reminder。slot 'd3'|'d1'）→ { subject, body }
  function reminderMail({ kind, phase, caseRow, org, me, slot } = {}) {
    const k = kindFrom(kind, phase);
    const survey = k === 'survey';
    const sl = (SLOTS.find(x => x.slot === slot) || SLOTS[0]).label;
    const what = survey ? '調査' : kindLabel(k);
    return {
      subject: subjectOf(`${survey ? '調査日' : '工事日'}のお知らせ（${sl}）`, k, caseRow),
      body: mailBody(k, phase, caseRow, org, me,
        `${what}の日が近づいてまいりましたので、改めてご案内いたします。`)
    };
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
  //     item = { phase, caseRow, caseName, kind, title, billTo, amount, status, statusLabel, doneAt }
  function groupBilling(rows, month) {
    const ym = String(month || '').slice(0, 7);
    const monthly = new Map();
    const single = [];
    for (const { phase: p, caseRow: c } of flatten(rows)) {
      if (!p || !KIND_KEYS.includes(p.kind)) continue;
      const amount = billingAmount(p);
      if (p.kind === 'survey' && amount == null) continue;
      const isMonthly = p.billing_mode === 'monthly';
      const inMonth = isMonthly
        ? (p.billing_month ? String(p.billing_month).slice(0, 7) === ym : !!p.done_at && jstYm(p.done_at) === ym)
        : !!p.done_at && jstYm(p.done_at) === ym;
      if (!inMonth) continue;
      const status = billStatus(p);
      const item = { phase: p, caseRow: c, caseName: str(c.name), kind: p.kind, title: phaseTitle(p),
        billTo: billToLabel(p, c), amount, status, statusLabel: BILL_STATUS_LABEL[status], doneAt: p.done_at || null };
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

  const api = { KINDS, KIND_KEYS, STEPS, MARK, SLOTS, RECIPIENTS, BILL_TO, kindLabel, steps,
    toDate, jstYmd, jstYm, jstAt, fmtMD, fmtMDHM, fmtMDWHM, fmtRange,
    phaseTitle, stage, caseNext, reminderSlots, scheduleSetAt, dueReminders, staleReminders,
    contacts, defaultRecipients, scheduleMail, reminderMail, docTrack,
    billingBasis, billingAmount, billToLabel, groupBilling };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PhaseLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
