// js/talk-logic.js — LINE 風の案件ごとのメッセージ（Task 46）の純粋関数（ブラウザ: window.TalkLogic / node: module.exports）
// トーク = 1つの案件（case_id 空 = 「全体」）。中身は既存のデータから作る（DB は migration 065 で見える範囲・元請から・既読の印だけ足した）:
//   msg  … staff_messages の手動の連絡（現場からの連絡・管理者の返事・日報・日報への返事・差し戻し・元請から）。吹き出し
//   card … 作業担当者が提出した報告書（submitted_at）・見積書（issued_at）。押すと開く
//   log  … 中央の小さな灰色の行「10/25 501号室 調査実施」。フェーズの記録（case_summaries.phases）・自動の連絡（催促・遅れ・期限超過・再編集・
//          案件登録・タスクの削除）・タイムラインの自動記録の一部（工事掲示・連絡メール・案件の完了）から
// 並び: 時刻の古い順（同じ時刻はカード → ログの順）。未読 = 自分以外の吹き出し・カードで、最後に読んだ時刻（talk_reads）より新しいもの。
//   印が無いトークは、自分あての未読の連絡（read_at が空。PhaseLogic.messageForMe）だけを数える
(function (root) {
  const inNode = typeof module !== 'undefined' && module.exports;
  const PL = () => (inNode ? require('./phase-logic.js') : root.PhaseLogic);
  const str = v => String(v == null ? '' : v).trim();
  const listOf = v => (Array.isArray(v) ? v.filter(Boolean) : []);
  const ms = v => { const d = PL().toDate(v); return d ? d.getTime() : null; };
  const ALL = 'all'; // 「全体」のトークの key

  // 対応の呼び名（ログ用）: 調査の2回目からは「再調査」、工事は「原因元工事」（2回目から「原因元工事 2回目」）、その他は名前（点検）
  function kindName(p, seq) {
    if (!p) return '';
    if (p.kind === 'survey') return seq > 1 ? '再調査' : '調査';
    const name = PL().workName(p.kind, p);
    return seq > 1 ? `${name} ${seq}回目` : name;
  }
  const RANK = { card: 0, log: 1, msg: 2 };
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
    const log = (at, what) => { if (ms(at) != null && what) out.push({ kind: 'log', at, text: [PL().fmtMD(at), room, what].filter(Boolean).join(' ') }); };
    // フェーズの記録
    for (const { p, seq } of seqd) {
      const k = kindName(p, seq);
      const reports = listOf(p.reports);
      const ests = listOf(p.estimates);
      if (p.schedule_set_at && p.scheduled_at) log(p.schedule_set_at, `${k}日程決定（${PL().fmtMDHM(p.scheduled_at)}）`);
      if (p.done_at) log(p.done_at, k + (p.kind === 'survey' ? '実施' : '完了'));
      for (const r of reports) {
        if (r.submitted_at) {
          out.push({ kind: 'card', doc: 'report', id: r.id, at: r.submitted_at, text: `${k}報告書`, from: r.submitted_by || null,
            fromName: r.submitted_by ? nameOf(r.submitted_by) : '担当者URL', mine: !!me && r.submitted_by === me, phaseId: p.id });
          log(r.submitted_at, `${k}報告書受領`);
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
        if (e.sent_at) log(e.sent_at, `${k}見積書発注待ち`);
        if (e.accepted_at) {
          log(e.accepted_at, `${k}発注済み`);
          if (p.kind !== 'survey' && !p.scheduled_at && !p.done_at) log(new Date(ms(e.accepted_at) + 1).toISOString(), `${k}日程調整中`);
        }
      }
      if (p.billed_at) log(p.billed_at, `${k}請求済み`);
      if (p.paid_at) log(p.paid_at, `${k}入金済み`);
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
      x.unread = x.kind !== 'log' && !x.mine && x.from !== me && (read != null ? ms(x.at) > read
        : x.kind === 'msg' && PL().messageForMe(x.msg, me, !!o.isOwner));
    });
    return out.sort((a, b) => ms(a.at) - ms(b.at) || RANK[a.kind] - RANK[b.kind]);
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
    const allList = items({ caseRow: null, messages: msgs.filter(m => !m.case_id), me, isOwner: o.isOwner, readAt: readOf(ALL), names: o.names });
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

  const api = { ALL, kindName, timelineLine, bubbleText, subjectOf, items, withDays, lastLine, threads, unreadTotal, recipient };
  if (inNode) module.exports = api;
  else root.TalkLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
