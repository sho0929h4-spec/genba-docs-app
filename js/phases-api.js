// js/phases-api.js — 対応フェーズ（case_phases）と日程連絡メールの下書きのDBアクセス（Supabase呼び出しはここに集約）
// 段階・文面・日本時間の計算は js/phase-logic.js（PhaseLogic）。
// 列は migration 020 の列 grant と同じ（kind・case_id は作成時だけ。schedule_set_at は 022 のトリガーが入れるので送らない）
const PhasesApi = (() => {
  const PL = () => window.PhaseLogic;
  const must = ({ data, error }) => { if (error) throw error; return data; };
  const UPDATE_COLS = ['scheduled_at', 'scheduled_end', 'done_at', 'bill_to_type', 'bill_to_name', 'billing_mode',
    'billing_month', 'billed_at', 'paid_at', 'amount_override', 'note', 'result', 'payment_due', 'plan', // result: 調査結果（023）・payment_due: 入金期限（024）・plan: 現場担当への指示（025・028 で用途変更）
    'worker_id', 'notified_at', 'ack_at']; // 026: 作業担当者・知らせた・確認した（時刻と「誰が」は DB のトリガーが入れ直す）
  const pick = (obj, cols) => {
    const out = {};
    for (const k of cols) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    return out;
  };
  const now = () => new Date().toISOString();
  const chunks = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };

  async function logSystem(caseId, body) {
    try {
      const text = typeof body === 'function' ? body() : body;
      must(await sb.from('timeline_entries').insert({ case_id: caseId, type: 'system', body: text }));
    } catch (e) { console.warn('自動記録に失敗', e); }
  }
  const me = () => (ctx && ctx.membership ? { display_name: ctx.membership.display_name || '' } : null);
  // 自動で作るリマインド（お客様向け・担当者向け）の署名「担当 ○○」: 開いた人ではなく案件の担当者（assignee）。
  //   無ければフェーズの作業担当者、それも無ければ開いた人。members（memberships の行）があれば名前はそこから引く
  function autoSigner(caseRow, phase, members) {
    const c = caseRow || {};
    const p = phase || {};
    const nameOf = id => { const m = id && (members || []).find(x => x.user_id === id); return m ? String(m.display_name || '').trim() : ''; };
    const name = nameOf(c.assignee_id) || String(c.assignee_name || '').trim()
      || nameOf(p.worker_id) || String(p.worker_name || '').trim();
    return name ? { display_name: name } : me();
  }
  // 宛先の既定（関係者のうちメールがある人）→ { recipients, to }。extraKeys: 足す関係する部屋（リマインド = 日程連絡で選んだ部屋。Task 12）
  function defaultTo(caseRow, purpose, extraKeys) {
    const keys = PL().defaultRecipients(caseRow, purpose, extraKeys);
    const cs = PL().contacts(caseRow);
    const to = keys.map(k => (cs.find(x => x.key === k) || {}).email).filter(Boolean);
    return { recipients: keys, to: Array.from(new Set(to)).join(', ') };
  }

  // 担当者の名前・メール（memberships。026）を caseRow に足す（宛名「鈴木さん」・宛先用）
  function withWorker(caseRow, workerId, members) {
    const w = (members || []).find(m => m.user_id === workerId) || null;
    return Object.assign({}, caseRow || {}, { worker_name: w ? w.display_name || '' : '', worker_email: w ? w.email || '' : '' });
  }
  // カードへのリンク（担当者向けのメールに入れる）
  const linkOf = (caseId, phaseId) => PL().phaseLink(location.origin + location.pathname, caseId, phaseId);

  const api = {
    withWorker,
    // 社内メンバー（担当者の候補・メール）
    async members() {
      return must(await sb.from('memberships').select('user_id, display_name, email').order('display_name')) || [];
    },
    async list(caseId) {
      return must(await sb.from('case_phases').select('*').eq('case_id', caseId).order('created_at').order('id'));
    },
    // 請求のしかたは元請マスタから写す（請求先は元請が既定。月ごとの元請なら monthly）
    async create(caseId, kind, caseRow) {
      if (!PL().KIND_KEYS.includes(kind)) throw new Error('フェーズの種類が正しくありません');
      const monthly = !!(caseRow && caseRow.client_id && caseRow.client_billing_mode === 'monthly');
      const row = must(await sb.from('case_phases')
        .insert({ case_id: caseId, kind, billing_mode: monthly ? 'monthly' : 'single' }).select().single());
      await logSystem(caseId, () => `${PL().kindLabel(kind)}を追加した`);
      return row;
    },
    async update(id, fields) {
      const patch = pick(fields, UPDATE_COLS);
      if (Object.keys(patch).length === 0) throw new Error('保存する項目がありません');
      const rows = must(await sb.from('case_phases').update(patch).eq('id', id).select());
      if (!rows || rows.length === 0) throw new Error('フェーズが見つかりません（削除された可能性があります）');
      return rows[0];
    },
    // 中身（見積書・報告書・工事掲示・送ったメール）があると DB が拒否する（未送信の下書きは一緒に消える）
    async remove(phase, title) {
      const rows = must(await sb.from('case_phases').delete().eq('id', phase.id).select('id'));
      if (!rows || rows.length === 0) throw new Error('削除できませんでした');
      await logSystem(phase.case_id, `${title}を削除した`);
    },
    // Task 16: setDone（調査済みにする・完了にする・取り消す）は無くした。done_at は報告書の提出で DB が入れる（migration 034）
    // 調査日時・工事日を保存し、日程連絡の下書きを作る/更新する。日時を消したら未送信の下書きは消す。
    // 日時が変わった・消えたときの未送信のリマインドは消す（作り直しはアプリを開いたとき。js/phase-logic.js dueReminders）
    //   drafts: この案件の mail_drafts（ReportsApi.listDrafts）。戻り値 { phase, draft }（draft は未送信の日程連絡 or null）
    async saveSchedule(phase, startIso, endIso, caseRow, drafts, title) {
      const before = phase.scheduled_at || null;
      const row = await api.update(phase.id, { scheduled_at: startIso || null, scheduled_end: startIso ? (endIso || null) : null });
      let draft = null;
      try {
        draft = await api.syncScheduleDrafts(before, row, caseRow, drafts);
      } catch (e) {
        const err = new Error('日時は保存しましたが、連絡メールの下書きを作れませんでした: ' + (e && e.message ? e.message : e));
        err.phase = row;
        throw err;
      } finally {
        const after = row.scheduled_at || null;
        const what = phase.kind === 'survey' ? '調査日時' : '工事日';
        const t = v => (v ? Date.parse(v) : null);
        if (t(before) !== t(after)) {
          await logSystem(phase.case_id, () => after
            ? `${title}の${what}を ${PL().fmtMDHM(after)} に${before ? '変えた' : '決めた'}`
            : `${title}の${what}を未定に戻した`);
        }
      }
      return { phase: row, draft };
    },
    // 日時を保存した後（saveSchedule）・日時の変更を「1つ前に戻す」で戻した後（Task 13）の連絡メールの下書き:
    //   日時があれば未送信の日程連絡を作る/更新する、消えていれば未送信の日程連絡を消す。日時が変わっていれば未送信のリマインドを消す
    //   （作り直しはアプリを開いたとき＝ syncReminders）。before: 変える前の scheduled_at、row: 今のフェーズの行 → 未送信の日程連絡 or null
    async syncScheduleDrafts(before, row, caseRow, drafts) {
      const phase = row;
      const mine = (drafts || []).filter(d => d.phase_id === phase.id && d.status === 'draft');
      let draft = null;
      {
        const sched = mine.filter(d => d.purpose === 'schedule')
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        if (!row.scheduled_at) {
          for (const d of sched) must(await sb.from('mail_drafts').delete().eq('id', d.id).eq('status', 'draft'));
        } else {
          const mail = keys => PL().scheduleMail({ phase: row, caseRow, org: ctx.org, me: me(), recipients: keys });
          if (sched.length) {
            const d = sched[0];
            // 宛名は下書きの送る相手（recipients）から。宛先も送る相手も空なら既定の相手を入れる（メールの無い相手だけを選んだ下書きは変えない）
            let keys = Array.isArray(d.recipients) ? d.recipients : [];
            const patch = { skipped_at: null };
            if (!String(d.to_email || '').trim() && !keys.length) {
              const t = defaultTo(caseRow, 'schedule');
              patch.to_email = t.to || null;
              patch.recipients = t.recipients;
              keys = t.recipients;
            }
            const m = mail(keys);
            patch.subject = m.subject;
            patch.body = m.body;
            const rows = must(await sb.from('mail_drafts').update(patch).eq('id', d.id).eq('status', 'draft').select());
            draft = rows && rows[0] ? rows[0] : null;
          }
          if (!draft) {
            const t = defaultTo(caseRow, 'schedule');
            const m = mail(t.recipients);
            draft = must(await sb.from('mail_drafts').insert({
              case_id: phase.case_id, phase_id: phase.id, purpose: 'schedule',
              to_email: t.to || null, recipients: t.recipients, subject: m.subject, body: m.body
            }).select().single());
          }
        }
        // 日時を変えた（同じ日の時刻だけでも）・消したら、このフェーズの未送信のリマインドは全部消す（本文の日時が古いため）。
        // 作り直しは次に案件一覧・案件を開いたとき（syncReminders）。変えていなくても完了・日付違いの古いものは消す
        const reminders = mine.filter(d => d.purpose === 'reminder');
        const moved = Date.parse(before || '') !== Date.parse(row.scheduled_at || '') && (before || row.scheduled_at);
        const stale = moved ? reminders : PL().staleReminders([row], reminders);
        for (const d of stale) must(await sb.from('mail_drafts').delete().eq('id', d.id).eq('status', 'draft'));
      }
      return draft;
    },

    // 調査結果（case_phases.result。023）を保存し、「調査結果のご報告」（purpose survey_result）の下書きを作る/更新する。
    //   未送信の下書きがあれば件名・本文を更新して「今回は送らない」を外す（宛先も送る相手も空なら既定を入れる）。無ければ、何か入っているときだけ作る。
    //   最初の保存（保存前の result が {}）のときだけタイムラインに「…の調査結果を記録した」。以後の変更は記録しない
    //   result: PhaseLogic.normalizeResult の形。戻り値 { phase, draft, first }（draft は未送信の下書き or null）
    async saveResult(phase, result, caseRow, title) {
      const r = PL().normalizeResult(result);
      const first = !phase.result || typeof phase.result !== 'object' || Object.keys(phase.result).length === 0;
      const row = await api.update(phase.id, { result: r });
      let draft = null;
      try {
        const open = must(await sb.from('mail_drafts').select('*').eq('phase_id', phase.id).eq('purpose', 'survey_result')
          .eq('status', 'draft').order('created_at', { ascending: false }));
        const mail = keys => PL().surveyResultMail({ phase: row, caseRow, org: ctx.org, me: me(), recipients: keys });
        if (open && open.length) {
          const d = open[0];
          let keys = Array.isArray(d.recipients) ? d.recipients : [];
          const patch = { skipped_at: null };
          if (!String(d.to_email || '').trim() && !keys.length) {
            const t = defaultTo(caseRow, 'survey_result');
            patch.to_email = t.to || null;
            patch.recipients = t.recipients;
            keys = t.recipients;
          }
          const m = mail(keys);
          patch.subject = m.subject;
          patch.body = m.body;
          const rows = must(await sb.from('mail_drafts').update(patch).eq('id', d.id).eq('status', 'draft').select());
          draft = rows && rows[0] ? rows[0] : null;
        }
        if (!draft && PL().hasResult(r)) {
          const t = defaultTo(caseRow, 'survey_result');
          const m = mail(t.recipients);
          draft = must(await sb.from('mail_drafts').insert({
            case_id: phase.case_id, phase_id: phase.id, purpose: 'survey_result',
            to_email: t.to || null, recipients: t.recipients, subject: m.subject, body: m.body
          }).select().single());
        }
      } catch (e) {
        const err = new Error('調査結果は保存しましたが、「調査結果のご報告」の下書きを作れませんでした: ' + (e && e.message ? e.message : e));
        err.phase = row;
        throw err;
      } finally {
        if (first) await logSystem(phase.case_id, `${title}の調査結果を記録した`);
      }
      return { phase: row, draft, first };
    },

    // 現場担当への指示（case_phases.plan。028。Task 9）を保存し、未送信の担当者へのメール（staff_notice: 確認依頼・前日のお知らせ）の
    // 指示の段落（■ 怪しい箇所 ■ 優先して調べる ■ 指示 ■ 当日の注意）だけ差し替える（本文の手直しは残す。置き場所が分からない本文は作り直す）。
    // お客様向けのメール（日程連絡・リマインド・調査結果のご報告）には入れないので触らない。
    //   members: 社内メンバー（作り直すときの宛名・署名）。戻り値 { phase, drafts }（drafts は書き換えた mail_drafts の行）
    async saveBrief(phase, brief, caseRow, members) {
      const v = PL().normalizeBrief(brief);
      const row = await api.update(phase.id, { plan: v });
      const changed = [];
      try {
        const open = must(await sb.from('mail_drafts').select('*').eq('phase_id', phase.id).eq('status', 'draft')
          .eq('purpose', 'staff_notice')) || [];
        const lines = PL().briefLines(v);
        for (const d of open) {
          let body = PL().setBriefSection(d.body, lines);
          if (body == null) {
            const cr = withWorker(caseRow, row.worker_id, members);
            const args = { phase: row, caseRow: cr, org: ctx.org, me: d.remind_slot ? autoSigner(caseRow, row, members) : me(), link: linkOf(row.case_id, row.id) };
            body = (d.remind_slot ? PL().staffReminderMail(args) : PL().staffNoticeMail(args)).body;
          }
          if (body === d.body) continue;
          const rows = must(await sb.from('mail_drafts').update({ body }).eq('id', d.id).eq('status', 'draft').select());
          if (rows && rows[0]) changed.push(rows[0]);
        }
      } catch (e) {
        const err = new Error('指示は保存しましたが、担当者へのメールの下書きを直せませんでした: ' + (e && e.message ? e.message : e));
        err.phase = row;
        throw err;
      }
      return { phase: row, drafts: changed };
    },

    /* ===== 作業担当者への確認依頼（対応フェーズ Task 6b） ===== */
    // 担当者を変える（知らせた・確認したは DB が消す）。未送信の確認依頼・前日のお知らせの下書きは消す（新しい担当者で作り直す）
    async setWorker(phase, workerId, title, members) {
      const row = await api.update(phase.id, { worker_id: workerId || null });
      try {
        must(await sb.from('mail_drafts').delete().eq('phase_id', phase.id).eq('purpose', 'staff_notice').eq('status', 'draft'));
      } catch (e) { console.warn('担当者への下書きを消せませんでした', e); }
      const w = (members || []).find(m => m.user_id === row.worker_id);
      await logSystem(phase.case_id, `${title}の作業担当者を${w ? ` ${w.display_name || '（名前なし）'} に` : 'なしに'}した`);
      return row;
    },
    // 担当者に知らせる（もう一度知らせると確認済みは消える）。担当者への確認依頼（purpose staff_notice）の下書きを作る/更新する
    //   → { phase, draft }
    async notifyWorker(phase, caseRow, title, members) {
      const row = await api.update(phase.id, { notified_at: now() });
      const cr = withWorker(caseRow, row.worker_id, members);
      let draft = null;
      try {
        const m = PL().staffNoticeMail({ phase: row, caseRow: cr, org: ctx.org, me: me(), link: linkOf(row.case_id, row.id) });
        const patch = { to_email: cr.worker_email || null, recipients: ['worker'], subject: m.subject, body: m.body, skipped_at: null };
        const open = must(await sb.from('mail_drafts').select('*').eq('phase_id', row.id).eq('purpose', 'staff_notice')
          .eq('status', 'draft').is('remind_slot', null).order('created_at', { ascending: false })) || [];
        if (open.length) {
          const rows = must(await sb.from('mail_drafts').update(patch).eq('id', open[0].id).eq('status', 'draft').select());
          draft = rows && rows[0] ? rows[0] : null;
        }
        if (!draft) {
          draft = must(await sb.from('mail_drafts').insert(Object.assign({ case_id: row.case_id, phase_id: row.id, purpose: 'staff_notice', worker_id: row.worker_id }, patch))
            .select().single());
        }
      } catch (e) {
        await logSystem(phase.case_id, `${title}の確認を${cr.worker_name ? ` ${cr.worker_name}さん` : '担当者'}に依頼した`);
        const err = new Error('担当者に知らせましたが、メールの下書きを作れませんでした: ' + (e && e.message ? e.message : e));
        err.phase = row;
        throw err;
      }
      await logSystem(phase.case_id, `${title}の確認を${cr.worker_name ? ` ${cr.worker_name}さん` : '担当者'}に依頼した`);
      return { phase: row, draft };
    },
    // 担当者本人が「確認した」（DB が本人以外・知らせる前を拒否する）
    async ack(phase, title) {
      const row = await api.update(phase.id, { ack_at: now() });
      const who = ctx && ctx.membership ? ctx.membership.display_name || '担当者' : '担当者';
      await logSystem(phase.case_id, `${who}が${title}を確認した`);
      return row;
    },

    /* ===== 請求（対応フェーズ Task 7） ===== */
    // items: [{ phase, caseRow, title, amount?, note? }]（phase は case_phases の行か case_summaries.phases の要素）。
    // 「請求した」（on=true: 未請求のものだけ billed_at = 今）／取り消し（on=false: 入金確認していないものだけ billed_at = null）。
    // DB の条件で絞るので、別の人が先に記録したものは触らない。変わった行ごとにその案件のタイムラインへ記録
    //   → 変わった case_phases の行の配列
    //   due: 入金期限 'YYYY-MM-DD'（on のとき。null 可）。取り消しでは入金期限も消す（024 の check: 期限は請求済みだけ）
    async setBilled(items, on, due) {
      const list = (items || []).filter(x => x && x.phase && x.phase.id);
      if (!list.length) return [];
      if (on && due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('入金期限の日付が正しくありません');
      const ids = list.map(x => x.phase.id);
      let q = sb.from('case_phases').update(on ? { billed_at: now(), payment_due: due || null } : { billed_at: null, payment_due: null }).in('id', ids);
      q = on ? q.is('billed_at', null) : q.is('paid_at', null);
      const rows = must(await q.select()) || [];
      for (const r of rows) {
        const it = list.find(x => x.phase.id === r.id);
        const parts = [];
        if (it.billTo) parts.push(it.billTo);
        parts.push(it.amount != null ? PL().yen(it.amount) : '金額未定');
        if (it.note) parts.push(it.note);
        if (on && due) parts.push('入金期限 ' + PL().fmtYmdMD(due));
        await logSystem(r.case_id, on ? `${it.title}を請求した（${parts.join('・')}）` : `${it.title}の請求を取り消した`);
      }
      return rows;
    },
    // 「入金確認」（on=true: 請求済みで未入金のものだけ paid_at = 今）／取り消し（on=false）
    async setPaid(items, on) {
      const list = (items || []).filter(x => x && x.phase && x.phase.id && (!on || x.phase.billed_at));
      if (!list.length) return [];
      const ids = list.map(x => x.phase.id);
      const q = sb.from('case_phases').update({ paid_at: on ? now() : null }).in('id', ids);
      const rows = must(await (on ? q.is('paid_at', null) : q).select()) || [];
      for (const r of rows) {
        const it = list.find(x => x.phase.id === r.id);
        await logSystem(r.case_id, on
          ? `${it.title}の入金を確認した（${it.amount != null ? PL().yen(it.amount) : '金額未定'}）`
          : `${it.title}の入金確認を取り消した`);
      }
      return rows;
    },
    // 請求先・請求のしかた・請求月を変える。next = { bill_to_type, bill_to_name, billing_mode, billing_month }
    //   請求先が元請以外なら単発（DB の check と同じ）。請求月は月ごとのときだけ（'YYYY-MM-01' か null = 完了月）
    //   タイムラインに 変更日・前の請求先（請求のしかたが変わったときはそれも）を記録
    async changeBillTo(phase, next, caseRow, title) {
      const type = next.bill_to_type;
      if (!PL().BILL_TO[type]) throw new Error('請求先を選んでください');
      const name = type === 'other' ? String(next.bill_to_name || '').trim() : null;
      if (type === 'other' && !name) throw new Error('「その他」の請求先の名前を入れてください');
      if (name && name.length > 100) throw new Error('請求先の名前は100文字までです');
      const mode = type === 'client' && next.billing_mode === 'monthly' ? 'monthly' : 'single';
      const month = mode === 'monthly' && next.billing_month ? String(next.billing_month).slice(0, 7) + '-01' : null;
      const patch = { bill_to_type: type, bill_to_name: name, billing_mode: mode, billing_month: month };
      const row = await api.update(phase.id, patch);
      const label = p => PL().billToLabel(p, caseRow);
      const modeText = p => (p.billing_mode === 'monthly'
        ? '月ごと' + (p.billing_month ? '（' + PL().ymLabel(p.billing_month) + '分）' : '（完了月）') : '単発');
      const before = { bill_to_type: phase.bill_to_type || 'client', bill_to_name: phase.bill_to_name || null,
        billing_mode: phase.billing_mode || 'single', billing_month: phase.billing_month || null };
      const today = PL().fmtMD(new Date());
      const whoChanged = label(before) !== label(row) || before.bill_to_type !== row.bill_to_type;
      const modeChanged = modeText(before) !== modeText(row);
      if (whoChanged) {
        await logSystem(phase.case_id || row.case_id, `${title}の請求先を ${label(row)} に変えた（${today} 変更・前の請求先: ${label(before)}` +
          (modeChanged ? `・請求のしかた: ${modeText(before)} → ${modeText(row)}` : '') + '）');
      } else if (modeChanged) {
        await logSystem(phase.case_id || row.case_id, `${title}の請求のしかたを ${modeText(row)} に変えた（${today} 変更・前: ${modeText(before)}）`);
      }
      return row;
    },
    // 入金期限を変える（請求済みのときだけ。'YYYY-MM-DD' か null）
    async setPaymentDue(phase, ymd, title) {
      if (ymd && !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error('入金期限の日付が正しくありません');
      const row = await api.update(phase.id, { payment_due: ymd || null });
      await logSystem(phase.case_id || row.case_id, ymd ? `${title}の入金期限を ${PL().fmtYmdMD(ymd)} にした` : `${title}の入金期限を消した`);
      return row;
    },
    // 月ごとの請求月（'YYYY-MM' / null = 完了月）
    async setBillingMonth(phase, ym) {
      return api.update(phase.id, { billing_month: ym ? String(ym).slice(0, 7) + '-01' : null });
    },
    // 請求額の手入力（amount_override。null で見積の金額に戻す）
    async setAmount(phase, amount, title) {
      const row = await api.update(phase.id, { amount_override: amount == null ? null : amount });
      await logSystem(phase.case_id || row.case_id, amount == null
        ? `${title}の請求額を見積の金額に戻した`
        : `${title}の請求額を ${PL().yen(amount)} に直した`);
      return row;
    },

    /* ===== リマインド・送るメール（対応フェーズ Task 6） ===== */
    // 送るメールの一覧・リマインドの作成に使う下書き: 未送信の全部 ＋ 指定フェーズのリマインド（送信済み・送らないも。二重作成の判定用）
    async listMailForOutbox(phaseIds) {
      const [open, rem] = await Promise.all([
        sb.from('mail_drafts').select('*').eq('status', 'draft').order('created_at'),
        phaseIds && phaseIds.length
          ? Promise.all(chunks(phaseIds, 80).map(ids => sb.from('mail_drafts').select('*').in('purpose', ['reminder', 'staff_notice']).in('phase_id', ids)))
          : Promise.resolve([])
      ]);
      const byId = new Map();
      for (const d of must(open) || []) byId.set(d.id, d);
      for (const r of rem) for (const d of must(r) || []) byId.set(d.id, d);
      return [...byId.values()];
    },
    // 時刻を過ぎていて未作成のリマインドを作る（サーバーの定期実行は使わない。案件一覧・案件を開いたときに呼ぶ）。
    //   entries: [{ caseRow, phases }]（phases は case_summaries.phases か case_phases の行）。drafts: そのフェーズの mail_drafts
    //   先に古い未送信のリマインド（日付が変わった・完了・予定の時刻を過ぎた）を消す。
    //   二重作成は DB の unique (phase_id, purpose, remind_slot, remind_for, worker_id) で防ぐ（別のタブ・別の人が同時に作っても1件。unique 違反は無視）
    //   → { created: [行], removed: n, errors: [文] }
    async syncReminders(entries, drafts, now) {
      const at = now || new Date();
      const out = { created: [], removed: 0, errors: [] };
      const phases = [];
      const caseOf = new Map();
      for (const e of entries || []) for (const p of (e.phases || [])) { phases.push(p); caseOf.set(p.id, e.caseRow); }
      const known = new Set(phases.map(p => p.id));
      // 担当者向けの前日のお知らせ（staff_notice ＋ remind_slot。026）も同じく古いものを消す
      let list = (drafts || []).filter(d => (d.purpose === 'reminder' || (d.purpose === 'staff_notice' && d.remind_slot)) && known.has(d.phase_id));
      for (const d of PL().staleReminders(phases, list, at)) {
        try {
          must(await sb.from('mail_drafts').delete().eq('id', d.id).eq('status', 'draft'));
          out.removed++;
          list = list.filter(x => x.id !== d.id);
        } catch (e) { out.errors.push('古いリマインドを消せませんでした: ' + (e && e.message ? e.message : e)); }
      }
      const due = PL().dueReminders(phases, list.concat((drafts || []).filter(d => d.purpose === 'schedule')), at);
      // 担当者向けの前日のお知らせ（宛先は担当者のメール。メールが無くても作る: アプリ内の 🔔 と文面コピーで伝える）
      const staffDue = PL().dueStaffReminders(phases, list.concat((drafts || []).filter(d => d.purpose === 'schedule')), at);
      // 署名（案件の担当者の名前）と担当者のメールを引くため、作るものがあるときだけ社内メンバーを読む
      let members = [];
      if (due.length || staffDue.length) {
        try { members = await api.members(); } catch (e) { out.errors.push('担当者を読み込めませんでした: ' + (e && e.message ? e.message : e)); }
      }
      for (const r of due) {
        const p = phases.find(x => x.id === r.phase_id);
        const caseRow = caseOf.get(r.phase_id) || {};
        // 日程連絡で関係する部屋の居住者を選んでいたら、リマインドにも入れる（今もある部屋でメールがあるものだけ）
        const sched = (drafts || []).filter(d => d.phase_id === r.phase_id && d.purpose === 'schedule')
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
        const t = defaultTo(caseRow, 'reminder', sched ? sched.recipients : null);
        const m = PL().reminderMail({ phase: p, caseRow, org: ctx.org, me: autoSigner(caseRow, p, members), slot: r.slot, recipients: t.recipients });
        const { data, error } = await sb.from('mail_drafts').insert({
          case_id: caseRow.id || p.case_id, phase_id: r.phase_id, purpose: 'reminder', remind_slot: r.slot, remind_for: r.remind_for,
          to_email: t.to || null, recipients: t.recipients, subject: m.subject, body: m.body
        }).select().single();
        if (error) {
          if (error.code === '23505') continue; // 別のタブ・別の人が先に作った
          out.errors.push('リマインドの下書きを作れませんでした: ' + error.message);
          continue;
        }
        out.created.push(data);
      }
      if (staffDue.length) {
        for (const r of staffDue) {
          const p = phases.find(x => x.id === r.phase_id);
          const caseRow = withWorker(caseOf.get(r.phase_id) || {}, p.worker_id, members);
          const caseId = caseRow.id || p.case_id;
          const m = PL().staffReminderMail({ phase: p, caseRow, org: ctx.org, me: autoSigner(caseRow, p, members), link: linkOf(caseId, p.id) });
          const { data, error } = await sb.from('mail_drafts').insert({
            case_id: caseId, phase_id: r.phase_id, purpose: 'staff_notice', remind_slot: 'd1', remind_for: r.remind_for,
            worker_id: p.worker_id, // DB のトリガー（027）がフェーズの今の担当者で入れ直す。unique は担当者ごと
            to_email: caseRow.worker_email || null, recipients: ['worker'], subject: m.subject, body: m.body
          }).select().single();
          if (error) {
            if (error.code === '23505') continue;
            out.errors.push('担当者への前日のお知らせを作れませんでした: ' + error.message);
            continue;
          }
          out.created.push(data);
        }
      }
      return out;
    },
    // 「今回は送らない」（日程連絡・リマインドだけ）／元に戻す
    async skipMail(draft, skip) {
      if (!PL().canSkip(draft)) throw new Error('このメールは「今回は送らない」にできません');
      const rows = must(await sb.from('mail_drafts').update({ skipped_at: skip === false ? null : now() })
        .eq('id', draft.id).eq('status', 'draft').select());
      if (!rows || rows.length === 0) throw new Error('送信済みか、削除されたメールです');
      return rows[0];
    }
  };
  return api;
})();
