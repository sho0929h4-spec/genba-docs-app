// js/talk-logic.js — LINE 風の案件ごとのメッセージ（Task 46）の純粋関数（ブラウザ: window.TalkLogic / node: module.exports）
// トーク = 1つの案件（case_id 空 = 「全体」）。中身は既存のデータから作る（DB は migration 065 で見える範囲・元請から・既読の印だけ足した）:
//   msg  … staff_messages の手動の連絡（現場からの連絡・管理者の返事・日報・日報への返事・差し戻し・元請から）。吹き出し
//   card … 作業担当者が提出した報告書（submitted_at）・見積書（issued_at）。押すと開く
//   log  … 中央の小さな灰色の行「10/25 14:32 501号室 調査実施」（Task 50: 月日と時刻）。フェーズの記録（case_summaries.phases）・自動の連絡（催促・遅れ・期限超過・再編集・
//          案件登録・タスクの削除）・タイムラインの自動記録の一部（工事掲示・連絡メール・案件の完了）から
// 並び: 時刻の古い順（同じ時刻はカード → ログの順）。未読 = 自分以外の吹き出し・カードで、最後に読んだ時刻（talk_reads）より新しいもの。
//   印が無いトークは、自分あての未読の連絡（read_at が空。PhaseLogic.messageForMe）だけを数える
(function (root) {
  const inNode = typeof module !== 'undefined' && module.exports;
  const PL = () => (inNode ? require('./phase-logic.js') : root.PhaseLogic);
  const EL = () => (inNode ? require('./estimate-logic.js') : root.EstimateLogic);
  const str = v => String(v == null ? '' : v).trim();
  const listOf = v => (Array.isArray(v) ? v.filter(Boolean) : []);
  const ms = v => { const d = PL().toDate(v); return d ? d.getTime() : null; };
  const ALL = 'all'; // 「全体」のトークの key

  // 対応の呼び名（ログ用）: 調査の2回目から・調査報告から作った調査（source_phase_id。Task 47）は「再調査」、工事は「原因元工事」（2回目から「原因元工事 2回目」）、その他は名前（点検）
  const kindName = (p, seq) => PL().flowName(p, seq); // Task 52: 矢羽の名前と同じ（PhaseLogic.flowName）
  const RANK = { card: 0, cond: 1, sched: 1, call: 1, log: 2, msg: 3 };
  // 自動の連絡のうち、ログの行にするもの（report_submit は報告書の受領の行と重なるので出さない）
  const LOG_SOURCES = ['nudge', 'late', 'overdue', 'reedit', 'case_create', 'task_delete'];
  // タイムラインの自動記録のうち、フェーズの記録に無いものだけを短くする（ほかは出さない。重ならないように）
  const TIMELINE_MAP = [
    [/^(.+?)の工事掲示を(?:自動で)?作った/, m => `${m[1]}の工事掲示作成`],
    [/^(.+?): (.+?)を送った（/, m => `${m[1]} ${m[2]}送付`],
    [/^案件を完了にした$/, () => '案件完了'],
    [/^案件を再開した$/, () => '案件再開']
  ];
  function timelineLine(body) {
    const b = str(body);
    for (const [re, f] of TIMELINE_MAP) { const m = re.exec(b); if (m) return f(m); }
    return '';
  }
  // 吹き出しの文: トークの書き込みは件名 = 本文の1行目なので本文だけ。古い連絡は件名と本文（返事「Re: …」は本文だけ）
  function bubbleText(m) {
    const subj = PL().plainSubject(m.subject);
    const body = String(m.body || '').trim();
    if (!body) return subj;
    if (/^Re:/.test(subj) || body.startsWith(subj)) return body;
    return subj + '\n' + body;
  }
  // 書き込みの件名（本文の1行目・40字まで。写真だけなら「写真」）
  function subjectOf(body, photoCount) {
    const first = String(body || '').split('\n').map(s => s.trim()).find(Boolean) || '';
    if (!first) return photoCount ? '写真' : '';
    const a = Array.from(first);
    return a.length > 40 ? a.slice(0, 39).join('') + '…' : first;
  }

  // 1つのトークの中身。o: { caseRow（case_summaries の行。全体は null）, messages（このトークの staff_messages）, timeline（このトークの timeline_entries）,
  //   me, isOwner, readAt（talk_reads の時刻。無ければ null）, names: { user_id: 表示名 } }
  //   → [{ kind: 'msg'|'card'|'log', at, text, mine, from（user_id）, fromName, asClient, msg, doc, id, unread }]
  function items(o) {
    const c = o.caseRow || null;
    const me = o.me || null;
    const names = o.names || {};
    const nameOf = id => (id && names[id]) || '';
    const room = c ? PL().roomLabel(c.room) : '';
    const out = [];
    const seqd = c ? withSeq(c.phases) : [];
    const phaseOf = id => seqd.find(x => x.p.id === id) || null;
    const log = (at, what) => { if (ms(at) != null && what) out.push({ kind: 'log', at, text: [PL().fmtMDHM(at), room, what].filter(Boolean).join(' ') }); }; // Task 50: 「10/25 14:32 501号室 調査実施」
    // Task 47: 段階を手で直したときは、そのログ（staff_messages source stage）を出して、同じ時刻の完了・請求・入金の自動のログは出さない（重なるので）
    const manual = new Set(listOf(o.messages).filter(m => m.source === 'stage' && m.phase_id).map(m => m.phase_id + '|' + ms(m.created_at)));
    const auto = (p, at, what) => { if (!manual.has(p.id + '|' + ms(at))) log(at, what); };
    // Task 50: 日程調整のカード（staff_messages source schedule）。同じ時刻の「日程決定」は確定のカードと重なるので出さない。
    //   日程調整のある対応の「日程調整中」は、候補／条件を出した時点に出す（発注の時刻には出さない）
    const schedMsgs = listOf(o.messages).filter(m => m.source === 'schedule' && m.phase_id && m.meta && m.meta.action !== 'blocked'); // Task 53: 埋まった知らせはログだけ（カードの順番に入れない）
    const schedConfirm = new Set(schedMsgs.filter(m => m.meta.action === 'confirm').map(m => m.phase_id + '|' + ms(m.created_at)));
    const schedPhases = new Set(schedMsgs.map(m => m.phase_id));
    // フェーズの記録
    for (const { p, seq } of seqd) {
      const k = kindName(p, seq);
      const reports = listOf(p.reports);
      const ests = listOf(p.estimates);
      if (p.schedule_set_at && p.scheduled_at && !schedConfirm.has(p.id + '|' + ms(p.schedule_set_at))) log(p.schedule_set_at, `${k}日程決定（${PL().fmtMDHM(p.scheduled_at)}）`);
      const rec = p.kind === 'site_check'; // Task 65: 現地確認は記録（送信で done_at。カードとログは記録の送信から）
      if (p.done_at && !rec) auto(p, p.done_at, k + (p.kind === 'survey' ? '実施' : '完了'));
      for (const r of reports) {
        if (r.submitted_at) {
          out.push({ kind: 'card', doc: 'report', id: r.id, at: r.submitted_at, text: rec ? `${k}の記録` : `${k}報告書`, from: r.submitted_by || null,
            fromName: r.submitted_by ? nameOf(r.submitted_by) : '担当者URL', mine: !!me && r.submitted_by === me, phaseId: p.id });
          log(r.submitted_at, rec ? `${k}の記録を${r.reedit_count ? '再' : ''}送信` : `${k}報告書受領`);
        }
        if (r.sent_at) log(r.sent_at, `${k}報告書送付`);
      }
      // 見積書依頼: 調査報告から作られた対応（source_phase_id）で見積の期日があるもの。時刻はその調査の報告書の提出
      if (p.estimate_due && p.source_phase_id) {
        const src = phaseOf(p.source_phase_id);
        const at = src && listOf(src.p.reports).map(r => r.submitted_at).filter(Boolean).sort((a, b) => ms(b) - ms(a))[0];
        if (at) log(new Date(ms(at) + 1).toISOString(), `${k}見積書依頼`);
      }
      for (const e of ests) {
        if (e.issued_at) {
          out.push({ kind: 'card', doc: 'estimate', id: e.id, at: e.issued_at, text: `${k}見積書`,
            sub: [e.version > 1 ? `第${e.version}版` : '', e.total != null ? PL().yen(e.total) : ''].filter(Boolean).join(' '),
            from: e.created_by || null, fromName: nameOf(e.created_by), mine: !!me && e.created_by === me, phaseId: p.id });
          log(e.issued_at, `${k}見積書受領`);
        }
        // Task 47: 工事の見積書の提出 → 工事の日程の条件（備考と明細から）のカードとログ。備考に無い項目は「未記入」
        if (e.issued_at && PL().isWork(p.kind) && e.status !== 'draft') {
          const cond = EL().conditions(e);
          out.push({ kind: 'cond', id: 'cond-' + e.id, at: e.issued_at, text: `${k}の工事の条件`, cond, phaseId: p.id, from: e.created_by || null, mine: true });
          log(e.issued_at, `${k} 工事の条件を記録` + (cond.missing.length ? `（${cond.missing.join('・')}は未記入）` : ''));
        }
        if (e.sent_at) log(e.sent_at, `${k}見積書発注待ち`);
        if (e.accepted_at) {
          log(e.accepted_at, `${k}発注済み`);
          if (p.kind !== 'survey' && !p.scheduled_at && !p.done_at && !schedPhases.has(p.id)) log(new Date(ms(e.accepted_at) + 1).toISOString(), `${k}日程調整中`);
        }
      }
      if (p.billed_at) auto(p, p.billed_at, `${k}請求済み`);
      if (p.paid_at) auto(p, p.paid_at, `${k}入金済み`);
    }
    const push = (m, text, after) => out.push({ kind: 'msg', at: after ? new Date(ms(m.created_at) + 1).toISOString() : m.created_at, msg: m, id: m.id,
      from: m.from_user || null, asClient: !!m.as_client, mine: !!me && m.from_user === me && !m.as_client,
      fromName: m.as_client ? '元請から' : nameOf(m.from_user) || (m.from_user ? '不明' : '自動のお知らせ'), text, daily: m.source === 'daily' });
    // 連絡
    for (const m of listOf(o.messages)) {
      const hit = m.phase_id ? phaseOf(m.phase_id) : null;
      const k = hit ? kindName(hit.p, hit.seq) : '';
      const subj = PL().plainSubject(m.subject);
      if (m.source === 'report_submit' || m.source === 'case_delete') continue;
      if (m.source === 'schedule') { // Task 50: 候補・条件・希望・確定のカード（ボタンは今の日程調整のカードだけ押せる）とログ
        if (!hit || !m.meta) continue;
        const meta = m.meta;
        if (meta.action === 'blocked') { log(m.created_at, PL().schedLogText(meta, k)); continue; } // Task 53: 「… 候補が埋まりました（出し直してください）」
        if (meta.reset) log(m.created_at, `${k} 日程を変える`); // カードより前（同じ時刻は入れた順）
        out.push({ kind: 'sched', id: m.id, at: m.created_at, msg: m, meta, phaseId: hit.p.id, phase: hit.p, text: `${k}の${PL().SCHED_CARD_TITLE[meta.action] || '日程'}`,
          from: m.from_user || null, fromName: nameOf(m.from_user) || '不明', mine: !!me && m.from_user === me,
          active: schedActive(m, hit.p, schedMsgs), latest: schedLatest(m, schedMsgs) });
        log(m.created_at, PL().schedLogText(meta, k));
        if (meta.action === 'offer' || meta.action === 'conditions') log(new Date(ms(m.created_at) + 1).toISOString(), `${k}日程調整中`);
        continue;
      }
      if (m.source === 'open_call') { // Task 51: 全体のトークの募集のカード（meta に対応）・案件のトークの「○○が担当になりました」のログ
        const meta = m.meta || {};
        if (meta.action === 'taken') {
          if (m.to_user) continue; // Task 60: 募集した人あての同じ知らせ（ログは1行）
          const who = nameOf(m.from_user) || '不明';
          log(m.created_at, [k, meta.at ? `${who}が ${PL().fmtMDWHM(meta.at)} に行きます` : who + 'が担当になりました'].filter(Boolean).join(' ')); // Task 60: 到着の時刻
          continue;
        }
        if (meta.action === 'expired') { log(m.created_at, [k, '募集が期限切れになりました（誰も行けませんでした）'].filter(Boolean).join(' ')); continue; } // Task 60
        if (meta.action !== 'call') continue;
        const cs = callState(m, o.messages, o.caseRows);
        out.push(Object.assign({ kind: 'call', id: m.id, at: m.created_at, msg: m, from: m.from_user || null, fromName: nameOf(m.from_user) || '不明',
          mine: !!me && m.from_user === me, text: cs.phase ? PL().callText(cs.phase, cs.caseRow, cs.seq) : PL().plainSubject(m.subject) }, cs));
        continue;
      }
      if (m.source === 'stage') { // Task 47: 「10/27 9:00 501号室 原因元工事 失注」
        const lab = /「(.+?)」/.exec(subj);
        log(m.created_at, [k, lab ? lab[1] : subj].filter(Boolean).join(' '));
        continue;
      }
      if (LOG_SOURCES.includes(m.source)) {
        let what = subj;
        if (m.source === 'nudge') what = k + (/見積/.test(subj) ? '見積書催促' : /報告/.test(subj) ? '報告書催促' : '催促');
        else if (m.source === 'overdue') what = (k || '') + '報告書の期限超過';
        log(m.created_at, what);
        // 催促・遅れの報告に添えた一言（本文の「一言: …」の行）は吹き出しにする（ログの直後）
        const note = /^一言: (.+)$/m.exec(String(m.body || ''));
        if (note) push(m, note[1].trim(), true);
        continue;
      }
      push(m, m.source === 'daily' ? subj : bubbleText(m), false);
    }
    for (const t of listOf(o.timeline)) {
      if (t.type !== 'system') continue;
      log(t.created_at, timelineLine(t.body));
    }
    const read = ms(o.readAt);
    out.forEach(x => {
      x.unread = (x.kind === 'msg' || x.kind === 'card' || x.kind === 'sched' || x.kind === 'call') && !x.mine && x.from !== me && (read != null ? ms(x.at) > read
        : ((x.kind === 'msg' || x.kind === 'sched') && PL().messageForMe(x.msg, me, !!o.isOwner)) || (x.kind === 'call' && x.state === 'open')); // Task 51: 印が無くても募集中のカードは未読
    });
    return out.sort((a, b) => ms(a.at) - ms(b.at) || RANK[a.kind] - RANK[b.kind]);
  }
  // Task 51: 募集のカードの今: その対応の一番新しい募集のカードで、まだ募集中 → open、担当が決まった → taken（takerName）、
  //   Task 60: 期限切れ → expired、それ以外（取り消し・古い募集・案件が無い）→ closed
  //   caseRows = 会社の案件（case_summaries の行。全体のトークは案件が無いので全部から探す）
  function callState(m, messages, caseRows) {
    const meta = (m && m.meta) || {};
    const c = listOf(caseRows).find(x => x.id === meta.case_id && !x.deleted_at) || null;
    const hit = c ? withSeq(c.phases).find(x => x.p.id === meta.phase_id) : null;
    const base = { phase: hit ? hit.p : null, caseRow: c, seq: hit ? hit.seq : null, phaseId: meta.phase_id || null, state: 'closed', takerName: '' };
    if (!hit) return base;
    const latest = listOf(messages).filter(x => x.source === 'open_call' && x.meta && x.meta.action === 'call' && x.meta.phase_id === meta.phase_id)
      .sort((a, b) => ms(b.created_at) - ms(a.created_at) || String(b.id).localeCompare(String(a.id)))[0];
    if (!latest || latest.id !== m.id) return base;
    if (PL().isOpenCall(hit.p)) return Object.assign(base, { state: 'open' });
    if (hit.p.worker_id) return Object.assign(base, { state: 'taken', takerName: str(hit.p.worker_name) || '（退会したメンバー）', takerId: hit.p.worker_id });
    if (PL().callExpired(hit.p)) return Object.assign(base, { state: 'expired' }); // Task 60: 期限切れ（出し直せる）
    return base;
  }
  // Task 50: 日程調整のカードが今も押せるか = その対応の一番新しい日程調整のカードで、今の状態（phase.schedule.state）がそのカードの次の番
  //   （候補 → candidates・条件 → conditions・希望 → wish）。確定のカードはボタンなし（日程を変えるは別）
  const SCHED_STATE_OF = { offer: 'candidates', conditions: 'conditions', wish: 'wish', propose: 'wish' };
  function schedLatest(m, all) {
    const latest = listOf(all).filter(x => x.phase_id === m.phase_id).sort((a, b) => ms(b.created_at) - ms(a.created_at) || String(b.id).localeCompare(String(a.id)))[0];
    return !!latest && latest.id === m.id;
  }
  function schedActive(m, phase, all) {
    const s = phase && phase.schedule;
    if (!s || phase.scheduled_at || phase.lost_at || SCHED_STATE_OF[m.meta.action] !== s.state) return false;
    return schedLatest(m, all);
  }
  function withSeq(phases) {
    const count = {};
    return listOf(phases).map(p => { count[p.kind] = (count[p.kind] || 0) + 1; return { p, seq: p.seq != null ? p.seq : count[p.kind] }; });
  }

  // 日付の区切りをはさむ → [{ day: '10/25（土）' } | item]
  function withDays(list) {
    const out = [];
    let last = '';
    for (const x of listOf(list)) {
      const d = PL().jstYmd(x.at);
      if (d && d !== last) { out.push({ day: PL().fmtMDW(x.at), ymd: d }); last = d; }
      out.push(x);
    }
    return out;
  }

  // 一覧の1行の「最後の1行」
  function lastLine(x) {
    if (!x) return '';
    if (x.kind === 'card') return x.text + 'が届きました';
    if (x.kind === 'cond' || x.kind === 'sched' || x.kind === 'call') return x.text;
    if (x.kind === 'msg') return (x.asClient ? '元請から: ' : '') + String(x.text || '').split('\n')[0];
    return x.text;
  }

  // トークの一覧。o: { caseRows, messages（見えている全部）, reads（talk_reads の行）, me, isOwner, names }
  //   作業担当者は担当の案件（PhaseLogic.fieldMine）、管理者は全部の案件。どちらも「全体」を1行。削除した案件は出さない
  //   → [{ key, caseRow, title, initial, last: { at, text }, unread }]（新しい順。何も無いものは最後に物件名順）
  function threads(o) {
    const me = o.me || null;
    const readOf = key => { const r = listOf(o.reads).find(x => (x.case_id || ALL) === key); return r ? r.read_at : null; };
    const msgs = listOf(o.messages);
    const rows = listOf(o.caseRows).filter(c => !c.deleted_at && (o.isOwner || PL().fieldMine(c, me)));
    const out = rows.map(c => {
      const list = items({ caseRow: c, messages: msgs.filter(m => m.case_id === c.id), me, isOwner: o.isOwner, readAt: readOf(c.id), names: o.names });
      const last = list[list.length - 1] || null;
      const title = PL().placeName(c) || '（物件名なし）';
      return { key: c.id, caseRow: c, title, initial: Array.from(str(c.name) || '？')[0],
        last: last ? { at: last.at, text: lastLine(last) } : null, unread: list.filter(x => x.unread).length };
    });
    const allList = items({ caseRow: null, caseRows: o.caseRows, messages: msgs.filter(m => !m.case_id), me, isOwner: o.isOwner, readAt: readOf(ALL), names: o.names });
    const al = allList[allList.length - 1] || null;
    out.push({ key: ALL, caseRow: null, title: '全体', initial: '全', last: al ? { at: al.at, text: lastLine(al) } : null,
      unread: allList.filter(x => x.unread).length });
    return out.sort((a, b) => (b.last ? 1 : 0) - (a.last ? 1 : 0) || (ms(b.last && b.last.at) || 0) - (ms(a.last && a.last.at) || 0)
      || (a.key === ALL ? -1 : b.key === ALL ? 1 : a.title.localeCompare(b.title, 'ja')));
  }
  const unreadTotal = list => listOf(list).reduce((a, t) => a + (Number(t.unread) || 0), 0);

  // 管理者の書き込みの宛先: その案件の作業担当者（フェーズの作業担当者・案件の担当者のうち自分以外）が1人ならその人。
  //   いなければ・2人以上なら空（宛先なし。作業担当者にはトークの未読で届く）
  function recipient(caseRow, me) {
    const c = caseRow || {};
    const ids = new Set(listOf(c.phases).map(p => p.worker_id).concat(c.assignee_id).filter(id => id && id !== me));
    return ids.size === 1 ? [...ids][0] : null;
  }

  // Task 47: このトークでフェーズ管理を直せるか（DB の phase_set_stage と同じ）: 管理者、または現場用で自分が登録した案件
  //   （登録した本人で、その案件に案件登録の自動の連絡 source case_create がある）。messages = そのトークの連絡
  function canManage(caseRow, me, isOwner, messages) {
    const c = caseRow || {};
    if (!c.id) return false;
    if (isOwner) return true;
    return !!me && c.created_by === me && listOf(messages).some(m => m.case_id === c.id && m.source === 'case_create');
  }
  // 日程調整中のときの入力欄の例（具体の日付: 1週間後とその次の日）
  function scheduleHint(now) {
    const t = ms(now) != null ? ms(now) : Date.now();
    return `例: 日程候補日 ${PL().fmtMD(t + 7 * 86400000)}・${PL().fmtMD(t + 8 * 86400000)} の午前中希望`;
  }

  const api = { ALL, callState, kindName, canManage, scheduleHint, timelineLine, bubbleText, subjectOf, items, withDays, lastLine, threads, unreadTotal, recipient };
  if (inNode) module.exports = api;
  else root.TalkLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
