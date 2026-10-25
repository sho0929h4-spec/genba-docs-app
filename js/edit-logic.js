// js/edit-logic.js — 「↩ 1つ前に戻す」の文言と対象の選び方（純粋関数。対応フェーズ Task 13 / migration 031）
// case_edits の行（table_name, row_id, before, after, changed_cols, edited_by, edited_at, undone_at）を
// 「10/19 13:05 田中: 調査 1回目の日時 10/20 9:00 → 10/21 10:00」の形にする。時刻は日本時間（PhaseLogic）。
// 戻せる対象は 案件の項目（cases）・対応フェーズ（case_phases）・関係する部屋（case_rooms）だけ。
// 対象外: 書類（報告書・見積書・工事掲示）の本文、タイムラインの投稿、元請マスタの変更、フェーズ・部屋の追加と削除
(function (root) {
  const PL = () => (typeof module !== 'undefined' && module.exports ? require('./phase-logic.js') : root.PhaseLogic);
  const str = v => (v == null ? '' : String(v).trim());
  const listOf = v => (Array.isArray(v) ? v.filter(Boolean) : []);

  const NOT_COVERED = ['書類（報告書・見積書・工事掲示）の中身', 'タイムラインの投稿', '元請マスタの変更', 'フェーズや部屋の追加・削除'];

  // 列の名前（画面の言葉）。phase の日時は種類で「日時」（調査）／「工事日」（工事）
  const CASE_COLS = {
    name: '物件名', address: '住所', client_id: '元請', client_name: '元請', client_email: '元請のメール',
    assignee_id: '担当者', due_date: '期日', status: '状態', room: '号室',
    owner_name: '物件オーナーの名前', owner_email: '物件オーナーのメール', owner_tel: '物件オーナーの電話',
    resident_name: '入居者の名前', resident_email: '入居者のメール', resident_tel: '入居者の電話'
  };
  const PHASE_COLS = {
    scheduled_at: '日時', scheduled_end: '終わりの時刻', done_at: '現地確認済み', bill_to_type: '請求先', bill_to_name: '請求先の名前',
    billing_mode: '請求のしかた', billing_month: '請求月', billed_at: '請求', paid_at: '入金', amount_override: '請求額',
    note: 'メモ', result: '現地確認結果', payment_due: '入金期限', plan: '作業担当者への指示', worker_id: '作業担当者'
  };
  const ROOM_COLS = { role: '役割', room: '号室', resident_name: '居住者名', email: 'メール', tel: '電話', note: 'メモ', sort: '並び' };
  // 1つの変更として見せる列の組（元請は client_id で代表。client_name / client_email は一緒に戻る）
  const HIDDEN_WITH = { client_name: 'client_id', client_email: 'client_id' };

  function colLabel(table, col, kind) {
    if (table === 'case_phases') {
      if (col === 'scheduled_at') return kind === 'survey' ? '日時' : '工事日';
      if (col === 'done_at') return kind === 'survey' ? '現地確認済み' : '完了';
      if (col === 'label') return kind === 'other' ? '名前' : '表題'; // Task 64
      return PHASE_COLS[col] || col;
    }
    if (table === 'case_rooms') return ROOM_COLS[col] || col;
    return CASE_COLS[col] || col;
  }

  const short = (s, n) => { const a = Array.from(str(s)); return a.length > n ? a.slice(0, n).join('') + '…' : a.join(''); };

  // 値 → 表示。m: { members, edit }
  function valText(table, col, v, side, edit, members) {
    const P = PL();
    const nameOf = id => { const m = listOf(members).find(x => x.user_id === id); return m ? (str(m.display_name) || '(名前なし)') : '不明'; };
    const none = '（なし）';
    if (col === 'client_id') {
      const nm = str(((side === 'before' ? edit.before : edit.after) || {}).client_name);
      return v == null ? '未選択' : (nm || '（元請）');
    }
    if (v == null || v === '') {
      if (col === 'scheduled_at' || col === 'due_date') return '未定';
      if (col === 'done_at' || col === 'billed_at' || col === 'paid_at') return 'まだ';
      if (col === 'assignee_id' || col === 'worker_id') return '未設定';
      if (col === 'amount_override') return '見積の金額';
      return none;
    }
    switch (col) {
      case 'scheduled_at': case 'scheduled_end': return P.fmtMDHM(v);
      case 'done_at': case 'billed_at': case 'paid_at': return P.fmtMD(v);
      case 'due_date': case 'payment_due': return P.fmtYmdMD(String(v).slice(0, 10));
      case 'billing_month': return P.ymLabel(String(v).slice(0, 10));
      case 'status': return v === 'done' ? '完了' : '進行中';
      case 'assignee_id': case 'worker_id': return nameOf(v);
      case 'amount_override': return P.yen(v);
      case 'bill_to_type': return P.BILL_TO[v] || String(v);
      case 'billing_mode': return v === 'monthly' ? '月ごと' : '単発';
      case 'role': return table === 'case_rooms' ? P.roomRoleLabel(v) : String(v);
      case 'result': case 'plan': return '（内容）';
      default: return '「' + short(typeof v === 'object' ? JSON.stringify(v) : v, 20) + '」';
    }
  }

  // 何の変更か（「調査 1回目の」「加害部屋 402 の」「」）
  function targetOf(edit, opts) {
    const o = opts || {};
    if (edit.table_name === 'case_phases') {
      const p = listOf(o.phases).find(x => x.id === edit.row_id);
      return { found: !!p, kind: p ? p.kind : null, prefix: p ? PL().phaseTitle(p) + 'の' : '（削除したフェーズ）の' };
    }
    if (edit.table_name === 'case_rooms') {
      const r = listOf(o.rooms).find(x => x.id === edit.row_id);
      return { found: !!r, kind: null, prefix: '関係する部屋 ' + (r ? PL().roomTitle(r) : '（削除した部屋）') + ' の' };
    }
    return { found: true, kind: null, prefix: '' };
  }

  // → { items: [{ col, label, from, to }], target, text（本文）, line（日時・人つき）, rowExists }
  function describe(edit, opts) {
    const e = edit || {};
    const o = opts || {};
    const t = targetOf(e, o);
    const cols = listOf(e.changed_cols).filter(c => !(HIDDEN_WITH[c] && listOf(e.changed_cols).includes(HIDDEN_WITH[c])));
    const items = cols.map(c => ({
      col: c, label: colLabel(e.table_name, c, t.kind),
      from: valText(e.table_name, c, (e.before || {})[c], 'before', e, o.members),
      to: valText(e.table_name, c, (e.after || {})[c], 'after', e, o.members)
    }));
    const one = it => (it.from === '（内容）' && it.to === '（内容）') ? it.label + 'を変更' : `${it.label} ${it.from} → ${it.to}`;
    let body = items.slice(0, 2).map(one).join('・');
    if (items.length > 2) body += ` ほか${items.length - 2}項目`;
    const text = t.prefix + body;
    const m = listOf(o.members).find(x => x.user_id === e.edited_by);
    const who = m ? str(m.display_name) || '(名前なし)' : (e.edited_by ? '不明' : '');
    const when = e.edited_at ? PL().fmtMDHM(e.edited_at) : '';
    return { items, target: t.prefix, text, line: `${when} ${who}: ${text}`.trim(), rowExists: t.found };
  }

  // 戻せる直近の編集（未取消・行がまだある）。edits は新しい順でなくてもよい
  function latestUndoable(edits, opts) {
    const sorted = listOf(edits).filter(e => !e.undone_at)
      .sort((a, b) => String(b.edited_at).localeCompare(String(a.edited_at)) || String(b.id).localeCompare(String(a.id)));
    return sorted.find(e => targetOf(e, opts).found) || null;
  }

  // 日時（予定）を戻したか（連絡メールの下書き・リマインドを作り直す）
  const touchesSchedule = edit => !!edit && edit.table_name === 'case_phases'
    && listOf(edit.changed_cols).some(c => c === 'scheduled_at' || c === 'scheduled_end');

  // undo_case_edit の結果（{ok:false, reason}）→ 画面の文
  const REASON = {
    conflict: 'その後に別の変更があるため戻せません',
    undone: 'この変更はもう取り消してあります',
    gone: '変更したものが削除されているため戻せません',
    deleted: '削除した案件は戻せません',
    invalid: '前の値が今は使えないため戻せません（元請や担当者が削除された など）'
  };
  const reasonText = r => REASON[r] || '戻せませんでした';

  const api = { NOT_COVERED, colLabel, describe, latestUndoable, touchesSchedule, reasonText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EditLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
