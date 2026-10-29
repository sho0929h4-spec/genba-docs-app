// js/share-logic.js — 報告書・見積書の「共有」（Task 68・Task 72）の文面・ファイル名の組み立て（ブラウザ: window.ShareLogic / node: module.exports）
// 件名（Task 72）: 「物件名 号室 作業内容＋書類名」=「サンプルハイツ 302号室 再調査報告書」／「サンプルハイツ 302号室 原因元工事 御見積書」（【】は付けない）
//   作業内容 = 現地確認／調査／原因元工事／復旧工事／その他の名前。再調査で作った調査（source_phase_id あり）は「再調査」
// 本文（メール）: 宛名 → 「いつもお世話になっております。○○の○○です。」→「表題の件につきまして、再調査報告書（御見積書）を共有いたします。」→ 結び → 署名。
//   LINE 用（short）は宛名と署名を省き、表題が無いので用件は「サンプルハイツ 302号室 再調査報告書を共有いたします。」。PDF のリンクは送るときに withLink で用件の行の下に入れる
// 書類の名前（docLabel）は DB の _t68_doc_label（migration 085。タイムラインの「…を共有した（LINE）」）と同じ
(function (root) {
  const inNode = typeof module !== 'undefined' && module.exports;
  const PL = () => (inNode ? require('./phase-logic.js') : root.PhaseLogic);
  const str = v => String(v == null ? '' : v).trim();
  // 対応の種類 → 名前（現地確認／調査／原因元工事／復旧工事／その他）。フェーズの無い古い報告書は work_type から
  const WT_KIND = { investigate: 'survey', repair: 'cause', restore: 'repair' };
  const VIA = { share: 'スマホの共有', mail: 'メール', line: 'LINE' };

  // doc: 'report' | 'estimate'。row: 報告書・見積書の行。caseRow.phases（case_summaries）から作業内容を引く（件名・ファイル名に使う）
  function kindName(doc, row, caseRow) {
    const r = row || {};
    const ph = (Array.isArray(caseRow && caseRow.phases) ? caseRow.phases : []).find(p => p && p.id === r.phase_id);
    if (ph && ph.kind === 'survey' && ph.source_phase_id) return '再調査';
    if (ph) return PL().workName(ph.kind, ph);
    const key = doc === 'report' ? WT_KIND[r.work_type] : '';
    return key ? PL().kindLabel(key) : '';
  }
  // 「調査報告書」／「原因元工事の見積書」（種類が無ければ「報告書」「見積書」）
  function docLabel(doc, kind) {
    const k = str(kind);
    return doc === 'estimate' ? (k ? k + 'の見積書' : '見積書') : k + '報告書';
  }
  // 宛名: 「大京管理 山田様」／「大京管理 ご担当者様」／「ご担当者様」（元請マスタの会社名・担当者名。無ければ案件の依頼元の名前）
  function addressee(caseRow) {
    const c = caseRow || {};
    const company = str(c.client_master_name) || str(c.client_name);
    const contact = str(c.client_master_name) ? str(c.client_contact) : '';
    const sama = contact ? (/(様|御中|さん)$/.test(contact) ? contact : contact + '様') : 'ご担当者様';
    return [company, sama].filter(Boolean).join(' ');
  }
  // o: { doc, kind, caseRow, org: { name, tel }, me: { name, tel }, short }
  //   → { subject, body }
  function message(o) {
    const c = o.caseRow || {};
    const place = PL().placeName(c);
    const kind = str(o.kind);
    const orgName = str(o.org && o.org.name);
    const myName = str(o.me && o.me.name);
    const tel = str(o.me && o.me.tel) || str(o.org && o.org.tel);
    const est = o.doc === 'estimate';
    const doc = est ? '御見積書' : kind + '報告書';
    const subject = [place, est ? kind : '', doc].filter(Boolean).join(' ');
    const who = orgName && myName ? `${orgName}の${myName}です。` : orgName || myName ? `${orgName || myName}です。` : '';
    const what = o.short ? `${subject}を共有いたします。` : `表題の件につきまして、${doc}を共有いたします。`;
    const main = ['いつもお世話になっております。' + who, '', what, 'ご確認のほど、よろしくお願いいたします。'];
    if (o.short) return { subject, body: main.join('\n') };
    const sign = [orgName, myName, tel ? 'TEL ' + tel : ''].filter(Boolean);
    const lines = [addressee(c), '', ...main];
    if (sign.length) lines.push('', '――――――――――', ...sign);
    return { subject, body: lines.join('\n') };
  }
  // 受け取った人の保存名: 「サンプルハイツ302号室_調査報告書.pdf」／「サンプルハイツ302号室_原因元工事_御見積書.pdf」
  function fileName(doc, kind, caseRow) {
    const place = PL().placeName(caseRow || {}, '');
    const k = str(kind);
    const parts = [place, ...(doc === 'estimate' ? [k, '御見積書'] : [docLabel('report', k)])].filter(Boolean);
    return parts.join('_').replace(/[\\/:*?"<>|\s]+/g, '') + '.pdf';
  }
  // 本文に PDF のリンクの行を入れる: 「…共有いたします。」の行のすぐ下（その行が消されていれば最後）
  function withLink(body, link) {
    const l = str(link);
    const b = String(body == null ? '' : body);
    if (!l) return b;
    const ls = b.split(/\r?\n/);
    const i = ls.findIndex(x => x.includes('共有いたします'));
    if (i < 0) return b.replace(/\s+$/, '') + '\n\n' + l;
    ls.splice(i + 1, 0, l);
    return ls.join('\n');
  }
  // LINE の共有 URL（ユーザーが「LINEで開く」を押したときだけ使う）
  const lineUrl = text => 'https://line.me/R/msg/text/?' + encodeURIComponent(String(text == null ? '' : text));
  const viaLabel = via => VIA[via] || '';

  const api = { VIA, kindName, docLabel, addressee, message, fileName, withLink, lineUrl, viaLabel };
  if (inNode) module.exports = api;
  else root.ShareLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
