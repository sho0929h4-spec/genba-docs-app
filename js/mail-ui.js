// js/mail-ui.js — ⑨ 依頼者へ送る報告書・見積書メールの下書き確認・送信（#mail/{id}）… openMailDraft(id)  （Task 7 / Phase 4 Task 5）
// 見積の下書き（draft.estimate_id）は文言（見積書PDF 等）・戻り先（見積書一覧）を出し分け、送信済みにした後 EstimatesApi.onMailSent を呼ぶ
// ユーザー入力は createElement + textContent / value で描画する（innerHTML は使わない）
// mk() は case-list.js、dBtn / errText は case-detail.js、edField / edInput / edTextarea / edHm は report-form.js、
// rpdfLoadOpts は report-ui.js、showScreen / renderHeaders / setMsg / $ は app.js のものを使う
//
// 送信は「リンク方式」: 送信時に報告書PDFを作って公開バケット public-pdfs に置き、期限のない公開URLを本文に入れた mailto: を開く（推測できない乱数フォルダ）。
//   実際の送信はユーザーのメールアプリが行う。メールアプリで送れたら「送信済みにする」→ markSent（案件のタイムラインに記録）。
//   送付済みの画面の「PDFリンクを無効にする」で公開バケットのファイルを消せば、そのリンクは開けなくなる。
// openMailDraft が定義されていると、⑤（js/report-ui.js）の「送信待ちの下書き」・案件詳細のバナー・確認後の遷移が有効になる。
//
// 画面遷移は location.hash の変更だけ（hashchange → routeFromHash → openMailDraft）。
// 世代番号 mlSeq: 古い読み込み応答や、画面を離れた後の送信処理の結果は捨てる。保存は直列（s.chain）。

const ML_DELAY = 1000;                       // 入力から保存までの待ち（ミリ秒）
// 見積の下書き（draft.estimate_id）と報告書の下書き（draft.report_id）で文言・戻り先を出し分ける
const mlIsEst = s => !!(s && s.draft && s.draft.estimate_id);
// 調査日・工事日の連絡／リマインド／調査結果のご報告（purpose schedule / reminder / survey_result。対応フェーズ）:
// 書類なし・PDFなし・送る相手は依頼元から選ぶ・戻り先は案件
const ML_NOTE_TITLE = { schedule: '日程の連絡メール', reminder: 'リマインドのメール', survey_result: '調査結果のご報告メール',
  staff_notice: '担当者へのメール' }; // staff_notice: 担当者への確認依頼・前日のお知らせ（Task 6b。送る相手は作業担当者だけ）
const mlIsStaff = s => !!(s && s.draft && s.draft.purpose === 'staff_notice');
const mlIsNote = s => !!(s && s.draft && !s.draft.estimate_id && !s.draft.report_id && !!ML_NOTE_TITLE[s.draft.purpose]);
const mlDoc = s => (mlIsEst(s) ? '見積書' : '報告書');
const mlLinkLabel = s => mlDoc(s) + 'PDF: ';
// s.returnTo: 「送るメール」（#outbox）・「やること」（#tasks）から開いたときはそこへ戻る（openMailDraftFrom）
// 日程連絡・リマインド・調査結果・担当者へのメール（フェーズのメール）は、そのフェーズの詳細ページ（Task 9）へ戻る
const mlPhaseHash = s => (mlIsNote(s) && s.draft.phase_id ? '#case/' + s.draft.case_id + '/phase/' + s.draft.phase_id : null);
const mlListHash = s => s.returnTo || mlPhaseHash(s) || ('#case/' + s.draft.case_id + (mlIsNote(s) ? '' : mlIsEst(s) ? '/estimates' : '/reports'));
const mlBackLabel = s => (s.returnTo === '#outbox' || s.returnTo === '#f/outbox' ? '← 送るメール' : s.returnTo === '#tasks' ? '← やること'
  : mlPhaseHash(s) ? '← ' + (mlPhase(s) ? PhaseLogic.phaseTitle(mlPhase(s)) : 'フェーズ') + 'に戻る'
    : mlIsNote(s) ? '← 案件' : '← ' + mlDoc(s) + '一覧');
const ML_EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
let ml = null;      // 表示中の画面の状態
let mlSeq = 0;      // openMailDraft のたびに増やす
let mlReturn = null; // { id, hash }: 次に開く下書きの戻り先（openMailDraftFrom）

/* ---------- 小さな部品 ---------- */
const mlStamp = iso => {
  const d = new Date(iso);
  if (!iso || isNaN(d.getTime())) return '';
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + edHm(d);
};
// カンマ区切りのアドレス一覧が全部正しい形式か（空は true）
const mlEmailsOk = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean).every(a => ML_EMAIL_RE.test(a));

/* ---------- localStorage（使えない環境でも画面は動かす） ---------- */
const mlWaitKey = id => 'mail-wait-' + id;     // 「送信済みにする」待ちの状態（PDFリンク・mailto・時刻）
const mlDraftKey = id => 'mail-draft-' + id;   // 保存できていない入力の退避
const ML_WAIT_MAX = 14 * 86400000;             // 「送信済みにする」待ちの端末内の保持期間（14日）。PDFリンク自体に期限はない。過ぎた待ち状態は破棄
function mlLsDel(key) { try { localStorage.removeItem(key); } catch (e) { /* 何もしない */ } }
function mlWaitSet(s) {
  try { localStorage.setItem(mlWaitKey(s.id), JSON.stringify(Object.assign({ t: Date.now() }, s.mail))); } catch (e) { /* 容量不足など */ }
}
function mlWaitGet(id) {
  try {
    const o = JSON.parse(localStorage.getItem(mlWaitKey(id)));
    const ok = o && typeof o === 'object' && typeof o.mailto === 'string' && o.mailto.startsWith('mailto:') &&
      typeof o.subject === 'string' && typeof o.fullBody === 'string' && (o.url == null || typeof o.url === 'string') && Number.isFinite(o.t);
    if (!ok || Date.now() - o.t > ML_WAIT_MAX || o.t > Date.now() + 60000) { mlLsDel(mlWaitKey(id)); return null; }
    return { mailto: o.mailto, url: o.url || '', subject: o.subject, fullBody: o.fullBody, shortened: o.shortened === true, noMail: o.noMail === true }; // url が空 = リンクなしで送った。noMail = メールが無い相手だけ（文面コピー）
  } catch (e) { return null; }
}
function mlDraftSet(s) {
  try { localStorage.setItem(mlDraftKey(s.id), JSON.stringify({ base: s.draft.updated_at || null, f: s.f })); } catch (e) { /* 容量不足など。サーバ保存が本線 */ }
}
function mlDraftGet(id) {
  try {
    const o = JSON.parse(localStorage.getItem(mlDraftKey(id)));
    const f = o && o.f;
    return f && ['to', 'cc', 'subject', 'body'].every(k => typeof f[k] === 'string') ? o : null;
  } catch (e) { return null; }
}
const mlSameStamp = (a, b) => !!a && !!b && (a === b || (Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b)));
const mlIsHash = (id, h) => String(h).toLowerCase() === '#mail/' + String(id).toLowerCase();

// メールアプリを開く。画面を離れる操作なので1か所に集める（E2E はここを差し替えて mailto を横取りする）
function mlOpenMailto(url) { location.href = url; }

// backDraft: 戻り先の下書き（{ case_id, estimate_id }）。見積の下書きなら見積書一覧、それ以外は報告書一覧へ戻る
function mlMessage(text, isErr, backDraft) {
  $('mail-bar').hidden = true;
  const nodes = [];
  if (backDraft && backDraft.case_id) {
    const b = { draft: backDraft };
    nodes.push(dBtn(mlBackLabel(b), 'back', () => { location.hash = mlListHash(b); }));
  }
  nodes.push(mk('div', isErr ? 'err' : 'empty', text));
  $('mail-root').replaceChildren(...nodes);
}

/* ---------- 保存（入力から1秒） ---------- */
function mlSetSave(s, state) {
  s.saveState = state;
  const el = s.els.save;
  if (!el) return;
  el.className = 'rep-save' + (state === 'saved' ? '' : state === 'error' ? ' err' : ' busy');
  if (state === 'pending') el.textContent = '保存待ち…';
  else if (state === 'saving') el.textContent = '保存中…';
  else if (state === 'saved') el.textContent = '保存済み ' + edHm(s.lastSaved || new Date());
  else if (state === 'error') el.textContent = '保存できませんでした: ' + (s.saveErr || '');
  else if (state === 'restored') { el.className = 'rep-save busy'; el.textContent = '前回の未保存の入力を復元しました'; }
  else el.textContent = '';
  if (s.els.retry) s.els.retry.hidden = state !== 'error';
}

function mlCollect(s) {
  const f = s.f;
  const out = {
    to_email: String(f.to || '').trim() || null,
    cc: String(f.cc || '').trim() || null,
    subject: String(f.subject || ''),
    body: String(f.body || '')
  };
  if (mlIsNote(s)) out.recipients = mlRcptKeys(s); // 日程連絡・リマインドは宛先の種類も保存する
  return out;
}

/* ---------- 宛先の種類（日程連絡・リマインド: 元請・物件オーナー・入居者から選ぶ） ---------- */
const mlSplit = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
// 送る相手のキー（今ある相手だけ。関係する部屋 room:{id} は消された部屋を外す。Task 12）
const mlRcptKeys = s => { const ok = PhaseLogic.recipientOrder(s.caseRow); return (Array.isArray(s.f.recipients) ? s.f.recipients : []).filter(k => ok.includes(k)); };
// 送る相手の並び（元請・物件オーナー・入居者・関係する部屋・担当者）
const mlOrder = (s, set) => PhaseLogic.recipientOrder(s.caseRow).filter(k => set.has(k));
// 送る相手の候補: 担当者へのメールは作業担当者だけ、それ以外は依頼元（元請・物件オーナー・入居者）と関係する部屋の居住者
const mlContacts = s => PhaseLogic.contacts(s.caseRow || {}).filter(c => (c.key === 'worker') === mlIsStaff(s));
// 宛先欄のうち依頼元のメールではないもの（手で足した宛先）
function mlManualTo(s) {
  const known = new Set(mlContacts(s).map(c => c.email.toLowerCase()).filter(Boolean));
  return mlSplit(s.f.to).filter(a => !known.has(a.toLowerCase()));
}
// 日程連絡（調査）の本文の形（Task 9）: 送る相手に入居者が含まれると入居者あての定型文（js/mail-templates.js）、それ以外は短い形
const mlFormOf = (s, keys) => {
  const p = s.draft && s.draft.purpose === 'schedule' ? mlPhase(s) : null;
  return p ? PhaseLogic.scheduleForm(p.kind, keys) : null;
};
const mlMe = () => (ctx && ctx.membership ? { display_name: ctx.membership.display_name || '' } : null);
// 送る相手を prevKeys → keys にしたときの本文。形が変わる（入居者を足した・外した）なら本文を作り直す（定型文と短い形は中身が違うため。
// 手直しは消える）。同じ形なら宛名の行だけ差し替える（Task 6c。手直しは残る）。prevLines: 前の宛名の行（省略時は prevKeys から）
function mlBodyFor(s, body, prevKeys, keys, prevLines) {
  const f0 = mlFormOf(s, prevKeys);
  const f1 = mlFormOf(s, keys);
  if (f0 && f1 && f0 !== f1) {
    return PhaseLogic.scheduleMail({ phase: mlPhase(s), caseRow: s.caseRow, org: ctx && ctx.org, me: mlMe(), recipients: keys }).body;
  }
  return PhaseLogic.setAddressee(body, PhaseLogic.addresseeLines(s.caseRow, keys), prevLines || PhaseLogic.addresseeLines(s.caseRow, prevKeys));
}
function mlToggleRcpt(s, key, on) {
  if (s.ro || s.phase !== 'edit' || s.busy) return;
  const cur = new Set(mlRcptKeys(s));
  if (on) cur.add(key); else cur.delete(key);
  const keys = mlOrder(s, cur);
  const emails = mlContacts(s).filter(c => keys.includes(c.key) && c.email).map(c => c.email);
  const to = Array.from(new Set(emails.concat(mlManualTo(s)))).join(', ');
  const body = mlBodyFor(s, s.f.body, mlRcptKeys(s), keys);
  s.f.recipients = keys;
  s.f.to = to;
  s.f.body = body;
  if (s.els.to) s.els.to.value = to;
  if (s.els.body && s.els.body.value !== body) s.els.body.value = body;
  mlMarkDirty(s);
  mlFillRcptNote(s);
  mlFillCopy(s);
}
// 選んだ人のうちメールが無い人 → 「文面をコピー」の案内
function mlFillRcptNote(s) {
  const el = s.els.rcptNote;
  if (!el) return;
  const keys = mlRcptKeys(s);
  const noMail = mlContacts(s).filter(c => keys.includes(c.key) && !c.email);
  const lines = [];
  if (noMail.length) lines.push('メールが無い人（' + noMail.map(c => PhaseLogic.contactTitle(c)).join('・') + '）には、下の「文面をコピー」で LINE などに貼り付けて送ってください');
  if (mlFormOf(s, keys) === 'resident') lines.push('入居者様（関係する部屋の居住者を含む）が含まれるので、本文は入居者様あての定型文です（入居者様を外すと短い文面に戻ります）');
  el.textContent = lines.join('\n');
  el.hidden = !lines.length;
}
function mlRcptBox(s) {
  const disabled = s.ro || s.phase !== 'edit';
  const box = mk('div', 'ml-rcpt');
  box.id = 'ml-rcpt';
  const head = mk('div', 'ml-rcpt-h');
  head.appendChild(mk('div', 'ml-rcpt-t', mlIsStaff(s) ? '送る相手（作業担当者）' : '送る相手（依頼元から選ぶ）'));
  // ＋ 依頼元を追加（Task 6b）: 案件の依頼元の編集をこの場で開く。保存すると一覧を読み直し、増えた相手を選ぶ（入力中の件名・本文はそのまま）
  if (!mlIsStaff(s) && !disabled && typeof openCaseModal === 'function') {
    const add = dBtn('＋ 依頼元を追加', 'btn sm ghost inline ml-rcpt-add', () => mlAddParty(s));
    add.id = 'ml-rcpt-add';
    head.appendChild(add);
  }
  box.appendChild(head);
  const cs = mlContacts(s).filter(c => c.name || c.email || c.room); // 関係する部屋は名前・メールが無くても出す（文面をコピーで送れる）
  if (!cs.length) {
    box.appendChild(mk('div', 'rep-sub', mlIsStaff(s)
      ? '作業担当者が決まっていません。フェーズ詳細ページの「作業担当者」で選んでください（下の宛先に直接入れても送れます）'
      : '依頼元が登録されていません。「＋ 依頼元を追加」から元請・物件オーナー・入居者を登録できます（下の宛先に直接入れても送れます）'));
    return box;
  }
  const keys = mlRcptKeys(s);
  cs.forEach(c => {
    const row = mk('label', 'ml-rc');
    row.dataset.key = c.key;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = c.key;
    cb.checked = keys.includes(c.key);
    cb.disabled = disabled;
    cb.addEventListener('change', () => mlToggleRcpt(s, c.key, cb.checked));
    const txt = mk('span', 'ml-rc-x');
    txt.appendChild(mk('b', null, PhaseLogic.contactTitle(c)));
    txt.appendChild(mk('span', 'rep-sub' + (c.email ? '' : ' ml-rc-nomail'), c.email || 'メール未登録（文面をコピーして送る）'));
    row.append(cb, txt);
    box.appendChild(row);
  });
  const note = mk('div', 'ml-rcpt-note');
  note.id = 'ml-rcpt-note';
  s.els.rcptNote = note;
  box.appendChild(note);
  mlFillRcptNote(s);
  return box;
}
// ＋ 依頼元を追加: 依頼元の編集ポップアップ（js/case-list.js openCaseModal。外側クリック・Esc では閉じない）を開き、
// 保存したら案件を読み直して送る相手の欄だけ作り直す。新しく増えた相手（名前かメールが入った）は選んだ状態にして、宛先・宛名にも入れる
function mlAddParty(s) {
  if (s.ro || s.phase !== 'edit' || s.busy) return;
  const before = new Set(mlContacts(s).filter(c => c.name || c.email || c.room).map(c => c.key));
  const beforeManual = mlManualTo(s);
  const beforeKeys = mlRcptKeys(s);
  const prevLines = PhaseLogic.addresseeLines(s.caseRow, beforeKeys);
  openCaseModal(s.caseRow, async () => {
    let row = null;
    try { row = await CasesApi.getSummary(s.draft.case_id); } catch (e) { console.warn('依頼元を読み直せませんでした', e); }
    if (ml !== s || !row) return;
    s.caseRow = Object.assign({}, row, { worker_name: s.caseRow.worker_name || '', worker_email: s.caseRow.worker_email || '' });
    const now = mlContacts(s).filter(c => c.name || c.email || c.room);
    const added = now.filter(c => !before.has(c.key) && !c.room).map(c => c.key); // 関係する部屋は自動では選ばない
    const cur = new Set(mlRcptKeys(s).concat(added));
    const keys = mlOrder(s, cur).filter(k => now.some(c => c.key === k));
    const emails = now.filter(c => keys.includes(c.key) && c.email).map(c => c.email);
    const known = new Set(now.map(c => c.email.toLowerCase()).filter(Boolean));
    s.f.recipients = keys;
    s.f.to = Array.from(new Set(emails.concat(beforeManual.filter(a => !known.has(a.toLowerCase()))))).join(', ');
    s.f.body = mlBodyFor(s, s.f.body, beforeKeys, keys, prevLines);
    if (s.els.to) s.els.to.value = s.f.to;
    if (s.els.body) s.els.body.value = s.f.body;
    const old = document.getElementById('ml-rcpt');
    if (old) old.replaceWith(mlRcptBox(s));
    mlFillCopy(s);
    mlMarkDirty(s);
  }, { focus: 'parties' });
}
const mlNoteText = (s, body) => String(s.f.subject || '') + '\n\n' + String(body == null ? s.f.body || '' : body);
// 1人分の宛名にした文面（LINE などで1人ずつ送るため。Task 6c）
//   日程連絡（調査）は相手の形で: 入居者様あては定型文、元請・物件オーナーあては短い形（今の本文と形が違えば作り直した文面）
function mlOneText(s, key) {
  return mlNoteText(s, mlBodyFor(s, s.f.body, mlRcptKeys(s), [key]));
}
// 「文面をコピー」: 選んだ相手のうちメールが無い人ごとに、その人の宛名だけの文面。いなければ今の本文そのまま
function mlCopyTextBtn(s) {
  const wrap = mk('div', 'ml-copy');
  wrap.id = 'ml-copy';
  s.els.copy = wrap;
  mlFillCopy(s);
  return wrap;
}
function mlFillCopy(s) {
  const wrap = s.els.copy;
  if (!wrap) return;
  const msg = mk('span', 'rep-sub');
  msg.id = 'ml-copy-msg';
  msg.setAttribute('role', 'status');
  const keys = mlRcptKeys(s);
  const noMail = mlContacts(s).filter(c => keys.includes(c.key) && !c.email);
  const btn = (who, text, key) => {
    const b = dBtn(who ? '文面をコピー（' + who + 'あて）' : '文面をコピー', 'btn sm ghost inline ml-copy-btn', async () => {
      const ok = await mlCopy(text());
      msg.textContent = ok ? (who ? who + 'あての' : '') + '件名と本文をコピーしました。LINE などに貼り付けてください'
        : 'コピーできませんでした。本文の欄を長押しして選択してください';
    });
    if (key) b.dataset.key = key;
    return b;
  };
  const btns = noMail.length
    ? noMail.map(c => btn(PhaseLogic.addresseeLine(s.caseRow, c.key), () => mlOneText(s, c.key), c.key))
    : [btn('', () => mlNoteText(s))];
  btns[0].id = 'ml-copy-text';
  btns.forEach(b => { b.disabled = !!s.busy; });
  wrap.replaceChildren(...btns, msg);
}

// 入力値の反映。値が変わっていなければ何もしない（type=email は blur 時の change でも呼ばれるため、無駄な保存を避ける）
function mlSet(s, key, v) {
  if (s.f[key] === v) return;
  s.f[key] = v;
  mlMarkDirty(s);
}

function mlMarkDirty(s) {
  if (s.ro || s.phase !== 'edit') return;
  s.dirty = true;
  mlDraftSet(s);
  mlSetSave(s, 'pending');
  mlClearVal(s);
  clearTimeout(s.timer);
  s.timer = setTimeout(() => mlFlush(s), ML_DELAY);
}

// 保留中の保存を今すぐ実行して、終わるまで待つ（直列。失敗しても throw しない: s.dirty が残る）
function mlFlush(s) {
  clearTimeout(s.timer);
  s.timer = null;
  s.chain = s.chain.then(() => mlDoSave(s)).catch(e => {
    s.dirty = true;
    s.saveErr = errText(e);
    mlSetSave(s, 'error');
  });
  return s.chain;
}

async function mlDoSave(s) {
  if (s.ro || !s.dirty) return;
  const fields = mlCollect(s);
  s.dirty = false;
  mlSetSave(s, 'saving');
  try {
    const row = await ReportsApi.saveDraft(s.id, fields);
    if (row && row.updated_at) s.draft.updated_at = row.updated_at;
    s.lastSaved = new Date();
    if (s.dirty) { mlDraftSet(s); mlSetSave(s, 'pending'); } // 保存中にさらに入力があった（次のタイマーで保存）。退避の base を新しいサーバー値に合わせる
    else { mlLsDel(mlDraftKey(s.id)); mlSetSave(s, 'saved'); }
  } catch (e) {
    s.dirty = true;
    s.saveErr = errText(e);
    mlSetSave(s, 'error');
  }
}
const mlPending = s => !!s && s.dirty;
// この画面をまだ開いているか（送信準備中に別の画面へ移ったら、メールアプリを開いたりしない）
const mlAlive = s => ml === s && mlIsHash(s.id, location.hash);

window.addEventListener('hashchange', () => { if (ml && mlPending(ml) && !mlIsHash(ml.id, location.hash)) mlFlush(ml); });
window.addEventListener('beforeunload', () => { if (ml && mlPending(ml)) mlFlush(ml); });
document.addEventListener('visibilitychange', () => { if (document.hidden && ml && mlPending(ml)) mlFlush(ml); });

/* ---------- エラー表示 ---------- */
function mlClearVal(s) { if (s.els.val && s.els.val.firstChild) s.els.val.replaceChildren(); }
function mlShowVal(s, text) {
  const box = s.els.val;
  if (!box) return;
  if (!text) { box.replaceChildren(); return; }
  box.replaceChildren(mk('div', 'rep-val-e', text));
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ---------- 描画 ---------- */
function mlBackBtn(s) {
  const b = dBtn(mlBackLabel(s), 'back', () => mlLeave(s, mlListHash(s)));
  s.els.back = b;
  return b;
}

function mlSenderNote() {
  const email = ctx && ctx.org ? String(ctx.org.email || '').trim() : '';
  const name = ctx && ctx.org ? String(ctx.org.name || '').trim() : '';
  const t = email
    ? '送信はあなたのメールアプリから行います（返信先: ' + email + '）'
    : '送信はあなたのメールアプリから行います。会社マスタでメールアドレスを設定すると署名に入ります';
  const box = mk('div', 'ml-from', (name ? name + ' ・ ' : '') + t);
  box.id = 'ml-from';
  return box;
}

// 受け取った人が保存するPDFの名前（添付の表示と公開URLの ?download= で同じ名前）
function mlPdfName(s) {
  return mlIsEst(s)
    ? (s.estimate && typeof EstimateLogic !== 'undefined' ? EstimateLogic.fileName(s.estimate) : '見積書.pdf')
    : ReportLogic.fileName(s.caseRow && s.caseRow.name, s.report ? s.report.room : '');
}

function mlAttachment(s) {
  const est = mlIsEst(s);
  const src = est ? s.estimate : s.report;
  const name = mlPdfName(s);
  const box = mk('div', 'ml-att');
  box.id = 'ml-att';
  const info = mk('div');
  info.appendChild(mk('b', null, name));
  info.appendChild(mk('div', 'rep-sub', s.ro
    ? '送付時に作成した' + mlDoc(s) + 'PDF（ダウンロードリンク・期限なしとして本文に入れました）'
    : (src ? '送信時にPDFを作成し、ダウンロードリンク（期限なし）を本文に入れます'
      : '元の' + mlDoc(s) + 'が見つからないため、PDFのリンクは入れられません')));
  if (est && s.estimate && !s.ro && s.estimate.status === 'superseded') {
    const w = mk('div', 'err', 'この見積書は旧版です（新しい版があります）。送っても状態や依頼の反映は変わりません');
    w.id = 'ml-att-old';
    info.appendChild(w);
  }
  box.append(mk('span', 'ic', 'PDF'), info);
  return box;
}

function mlHeadRow(s) {
  const row = mk('div', 'rep-between rep-ed-top');
  row.appendChild(mlBackBtn(s));
  CaseBand.attach(row, s.els.back, s.caseRow).id = 'ml-place'; // Task 30: 物件名と号室の帯
  const box = mk('div', 'rep-acts');
  const save = mk('span', 'rep-save');
  save.id = 'ml-save';
  save.setAttribute('role', 'status');
  const retry = dBtn('再試行', 'btn sm ghost inline', () => mlFlush(s));
  retry.id = 'ml-retry';
  retry.hidden = true;
  s.els.save = save;
  s.els.retry = retry;
  if (!s.ro && s.phase === 'edit') box.append(save, retry);
  row.appendChild(box);
  return row;
}

function mlComposeCard(s) {
  const f = s.f;
  const disabled = s.ro || s.phase !== 'edit';
  const card = mk('div', 'rep-card');
  const head = mk('div', 'rep-between');
  head.style.marginBottom = '10px';
  head.appendChild(mk('b', null, (mlIsNote(s) ? ML_NOTE_TITLE[s.draft.purpose] : '依頼元へ送るメール') + (s.ro ? '' : '（下書き）')));
  head.appendChild(mk('span', 'rep-pill ' + (s.ro ? 'p-ok' : 'p-sent'), s.ro ? '送付済み' : '自動作成'));
  card.appendChild(head);
  if (mlIsNote(s)) {
    const phase = mlPhase(s);
    const dated = s.draft.purpose !== 'survey_result' && phase && phase.scheduled_at; // 調査結果のご報告は日時を出さない
    const kind = mk('div', 'rep-sub ml-kind', (phase ? PhaseLogic.phaseTitle(phase) + ' ・ ' : '') + PhaseLogic.mailLabel(s.draft, phase) +
      (dated ? ' ・ ' + PhaseLogic.fmtRange(phase.scheduled_at, phase.scheduled_end) : ''));
    kind.id = 'ml-kind';
    card.appendChild(kind);
    card.appendChild(mlRcptBox(s));
  }

  const to = edInput('ml-to', 'email', f.to, v => mlSet(s, 'to', v), { placeholder: '例: tanto@example.co.jp', autocomplete: 'off' });
  to.multiple = true; // 複数宛先はカンマ区切り
  const cc = edInput('ml-cc', 'text', f.cc, v => mlSet(s, 'cc', v), { placeholder: '任意（複数はカンマ区切り）', autocomplete: 'off' });
  cc.inputMode = 'email';
  const subject = edInput('ml-subject', 'text', f.subject, v => mlSet(s, 'subject', v), { autocomplete: 'off' });
  const body = edTextarea('ml-body', f.body, false, '', v => mlSet(s, 'body', v));
  Object.assign(s.els, { to, cc, subject, body });

  card.appendChild(edField(mlIsNote(s) ? '宛先（メールアドレス。上で選ぶと入ります・手で足せます）' : '宛先', to));
  card.appendChild(edField('CC', cc));
  card.appendChild(mlSenderNote());
  card.appendChild(edField('件名', subject));
  card.appendChild(edField('本文', body, s.ro || mlIsNote(s) ? '' : '「{{PDF_LINK}}」の行には、送信時に' + mlDoc(s) + 'PDFのリンクが入ります', 'ml-body-ff'));
  if (!mlIsNote(s)) card.appendChild(mlAttachment(s));
  else if (!s.ro) card.appendChild(mlCopyTextBtn(s));
  if (!mlIsEst(s) && !mlIsNote(s)) {
    const quote = mk('div', 'ml-att ml-att-off', '＋ 見積書を添付（見積書機能の追加後に使えます）');
    quote.style.marginTop = '8px';
    card.appendChild(quote);
  }
  card.appendChild(mk('div', 'rep-note', mlIsNote(s)
    ? '「送信済みにする」と、案件のタイムラインに「' + PhaseLogic.mailLabel(s.draft, mlPhase(s)) + 'を送った（送った相手）」と残ります'
    : '送ったメールは案件のタイムラインに「送付した（宛先・件名・添付）」として残ります'));
  if (disabled) card.querySelectorAll('input,textarea').forEach(e => { e.disabled = true; });
  return card;
}

// 送信済み: 読み取り専用（送付日時・宛先）
function mlBuildSent(s) {
  const d = s.draft;
  const info = mk('div', 'rep-card');
  const rows = [
    ['送付日時', mlStamp(d.sent_at) || '（不明）'],
    ['宛先', d.to_email || '（未入力）']
  ];
  if (mlIsNote(s) && PhaseLogic.recipientsLabel(d.recipients, s.caseRow)) rows.push(['送った相手', PhaseLogic.recipientsLabel(d.recipients, s.caseRow)]);
  if (d.cc) rows.push(['CC', d.cc]);
  const dl = mk('dl', 'rep-auto');
  rows.forEach(([k, v]) => { dl.append(mk('dt', null, k), mk('dd', null, v)); });
  dl.id = 'ml-sent-info';
  info.append(mk('div', 'ml-sent-row', 'このメールは送付済みです。内容は変更できません（読み取り専用）'), dl);
  const nodes = [mlHeadRow(s), info];
  const pl = mlPdfLinkCard(s);
  if (pl) nodes.push(pl);
  nodes.push(mlComposeCard(s));
  return nodes;
}

/* ---------- 送付済みPDFリンクの管理 ---------- */
// s.pdf = { kind: 'checking' | 'alive' | 'gone' | 'none', url, busy, err }。kind が none のメール（PDFなし・以前の期限つき方式）はカードを出さない
function mlPdfLinkCard(s) {
  if (!s.pdf || s.pdf.kind === 'none') return null;
  const card = mk('div', 'rep-card');
  card.id = 'ml-pdflink';
  mlFillPdfLink(s, card);
  return card;
}

function mlFillPdfLink(s, card) {
  const p = s.pdf;
  const nodes = [mk('b', null, mlDoc(s) + 'PDFのリンク')];
  if (p.kind === 'checking') {
    nodes.push(mk('div', 'rep-sub', '確認中…'));
  } else if (p.kind === 'gone') {
    const g = mk('div', 'rep-sub', '無効化済み（このリンクからはPDFを開けません）' +
      (s.phase === 'waiting' ? '。メールを送り直すときは「内容を直す（編集に戻る）」から送信し直してください（新しいリンクが作られます）' : ''));
    g.id = 'ml-pdflink-gone';
    nodes.push(g);
  } else {
    nodes.push(mk('div', 'rep-sub', '期限はありません。メールを受け取った人が開けます。止めたいときは無効にしてください'));
    if (s.phase !== 'waiting') { // 待ち状態の画面には、リンクのコピー欄が別にある
      const url = document.createElement('input');
      url.type = 'text';
      url.id = 'ml-pdflink-url';
      url.className = 'ml-url';
      url.readOnly = true;
      url.value = p.url;
      url.setAttribute('aria-label', mlDoc(s) + 'PDFの公開リンク');
      url.addEventListener('focus', () => url.select());
      nodes.push(url);
    }
    const off = dBtn('PDFリンクを無効にする', 'btn sm ghost inline danger', () => mlRevokePdf(s));
    off.id = 'ml-pdflink-off';
    off.disabled = !!p.busy || !!s.busy;
    nodes.push(off);
  }
  if (p.err) { const e = mk('div', 'err', p.err); e.id = 'ml-pdflink-err'; nodes.push(e); }
  card.replaceChildren(...nodes);
}

async function mlLoadPdfLink(s) {
  try { s.pdf = Object.assign({ busy: false, err: '' }, await ReportsApi.pdfLinkState(s.draft, mlPdfName(s))); }
  catch (e) { s.pdf = { kind: 'none', busy: false, err: '' }; return; } // 確認できなければ何も出さない
  if (ml !== s) return;
  mlRender(s);
}

async function mlRevokePdf(s) {
  if (!s.pdf || s.pdf.busy || s.pdf.kind !== 'alive' || !mlAlive(s)) return;
  // 画面内の確認（confirm() は使わない。Task 23 M6）
  const ok = await askInline($('ml-pdflink'), 'このメールのPDFリンクを無効にしますか？\n無効にすると、メールを受け取った人はPDFを開けなくなります（元に戻せません。' + mlDoc(s) + 'そのものは消えません）。\n反映まで数分〜1時間ほどかかる場合があります。',
    { okLabel: '無効にする', danger: true, id: 'ml-ask' });
  if (!ok || !s.pdf || s.pdf.busy || s.pdf.kind !== 'alive' || !mlAlive(s)) return;
  s.pdf.busy = true; s.pdf.err = '';
  mlFillPdfLink(s, $('ml-pdflink'));
  try {
    await ReportsApi.revokePdfLink(s.draft);
    s.pdf = { kind: 'gone', url: '', busy: false, err: '' };
  } catch (e) {
    s.pdf.busy = false;
    s.pdf.err = '無効にできませんでした: ' + errText(e);
  }
  if (ml === s && $('ml-pdflink')) mlFillPdfLink(s, $('ml-pdflink'));
}

// メールアプリを開いた後: 「送信済みにする」を待つ状態 + 開かない環境向けのコピー用
function mlBuildWaiting(s) {
  const m = s.mail;
  const card = mk('div', 'rep-card ml-wait');
  card.id = 'ml-wait';
  card.appendChild(mk('h3', null, m.noMail ? '文面をコピーして送ってください' : 'メールアプリを開きました'));
  card.appendChild(mk('div', null, m.noMail
    ? '選んだ相手にメールアドレスがありません。『本文をコピー』で LINE などに貼り付けて送り、送れたら『送信済みにする』を押してください'
    : 'メールアプリで送信できたら『送信済みにする』を押してください'));
  if (m.shortened) { // 本文が長く、mailto には全文を入れられなかった
    const warn = mk('div', 'ml-short-warn', '本文が長いため短縮してメールアプリを開きました。『本文をコピー』で全文を貼り付けてください');
    warn.id = 'ml-short-warn';
    warn.setAttribute('role', 'alert');
    card.appendChild(warn);
  }
  if (!m.noMail) card.appendChild(mk('div', 'rep-sub', '宛先: ' + (s.f.to || '') + (s.f.cc ? ' ／ CC: ' + s.f.cc : '')));
  if (mlIsNote(s) && PhaseLogic.recipientsLabel(mlRcptKeys(s), s.caseRow)) card.appendChild(mk('div', 'rep-sub', '送る相手: ' + PhaseLogic.recipientsLabel(mlRcptKeys(s), s.caseRow)));

  card.appendChild(mk('div', 'rep-group-ttl', m.noMail ? 'コピーする' : 'メールアプリが開かないとき'));
  const copied = mk('div', 'rep-sub');
  copied.id = 'ml-copied';
  copied.setAttribute('role', 'status');
  const copy = (label, text, cls) => dBtn(label, cls || 'btn sm ghost inline', async () => {
    const ok = await mlCopy(text);
    copied.textContent = ok ? label.replace('をコピー', '') + 'をコピーしました' : 'コピーできませんでした。下の欄を長押しして選択してください';
  });
  const acts = mk('div', 'ml-copy');
  acts.append(
    copy('件名をコピー', m.subject),
    copy('本文をコピー', m.fullBody, m.shortened ? 'btn sm inline ml-copy-emph' : null),
    ...(m.url ? [copy('PDFリンクをコピー', m.url)] : []), // 本文のリンク行を消して送ったときは PDF を作っていない
    ...(m.noMail ? [] : [dBtn('メールアプリを開き直す', 'btn sm ghost inline', () => mlOpenMailto(m.mailto))])
  );
  card.append(acts, copied);

  if (m.url) {
    const url = document.createElement('input');
    url.type = 'text';
    url.id = 'ml-link-url';
    url.className = 'ml-url';
    url.readOnly = true;
    url.value = m.url;
    url.setAttribute('aria-label', mlDoc(s) + 'PDFのダウンロードリンク（期限なし）');
    url.addEventListener('focus', () => url.select());
    card.appendChild(url);
  }
  const back = dBtn('内容を直す（編集に戻る）', 'btn sm ghost inline', () => mlBackToEdit(s));
  back.id = 'ml-back-edit';
  back.style.marginTop = '10px';
  card.appendChild(back);
  const nodes = [mlHeadRow(s), card];
  const pl = mlPdfLinkCard(s);
  if (pl) nodes.push(pl);
  nodes.push(mlComposeCard(s));
  return nodes;
}

function mlRender(s) {
  const err = mk('div', 'rep-val');
  err.id = 'ml-val';
  err.setAttribute('role', 'alert');
  s.els.val = err;
  const nodes = s.ro ? mlBuildSent(s) : s.phase === 'waiting' ? mlBuildWaiting(s) : [mlHeadRow(s), mlComposeCard(s)];
  nodes.splice(1, 0, err);
  $('mail-root').replaceChildren(...nodes);
  if (!s.ro && s.phase === 'edit') mlSetSave(s, s.lastSaved ? 'saved' : s.restored ? 'restored' : '');

  const bar = $('mail-bar');
  bar.hidden = false;
  const later = $('mail-later'), send = $('mail-send'), done = $('mail-done');
  later.textContent = s.ro ? '閉じる' : 'あとで';
  later.onclick = () => mlLeave(s, s.ro ? '#case/' + s.draft.case_id : mlListHash(s));
  send.hidden = s.ro || s.phase !== 'edit';
  send.textContent = '送信する';
  send.onclick = () => mlSend(s);
  done.hidden = s.ro || s.phase !== 'waiting';
  done.onclick = () => mlMarkSent(s);
  mlSyncBusy(s);
}

// 通信中は入力と操作ボタンを止める（二度押し・打鍵の取りこぼし防止）
function mlSyncBusy(s) {
  const busy = s.busy;
  ['mail-later', 'mail-send', 'mail-done'].forEach(id => { $(id).disabled = busy; });
  if (s.els.back) s.els.back.disabled = busy;
  if (s.phase === 'edit' && !s.ro) {
    ['to', 'cc', 'subject', 'body'].forEach(k => { if (s.els[k]) s.els[k].disabled = busy; });
  }
  document.querySelectorAll('#ml-wait button').forEach(b => { b.disabled = busy; });
  if (s.phase === 'edit' && !s.ro) document.querySelectorAll('#ml-rcpt input, #ml-copy button').forEach(b => { b.disabled = busy; });
}

async function mlCopy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const t = document.createElement('textarea');
      t.value = text;
      t.style.position = 'fixed';
      t.style.opacity = '0';
      document.body.appendChild(t);
      t.select();
      const ok = document.execCommand && document.execCommand('copy');
      t.remove();
      return !!ok;
    } catch (e2) { return false; }
  }
}

/* ---------- 戻る・離れる ---------- */
async function mlLeave(s, hash) {
  if (s.busy) return;
  if (!s.ro && s.phase === 'edit') {
    s.busy = true;
    mlSyncBusy(s);
    await mlFlush(s);
    s.busy = false;
    if (ml !== s) return;
    mlSyncBusy(s);
    if (mlPending(s) && !(await askInline($('mail-bar'), '保存できていない入力があります。このまま戻りますか？', { okLabel: 'このまま戻る', prepend: true, id: 'ml-ask' }))) return;
  }
  location.hash = hash;
}

function mlBackToEdit(s) {
  if (s.busy || s.ro) return;
  s.phase = 'edit';
  s.mail = null;
  s.pdf = null;
  mlLsDel(mlWaitKey(s.id));
  mlRender(s);
}

/* ---------- 送る ---------- */
// 送付PDFの差し替え口: 見積の下書きなら EstimatePdf、報告書なら ReportPdf
async function mlMakePdf(s) {
  if (s.draft.estimate_id) {
    if (!s.estimate || typeof EstimatePdf === 'undefined') throw new Error('元の見積書が見つかりません');
    const org = ctx.org || {};
    const logo = org.logo_path ? await AppStorage.getUrl(org.logo_path).catch(() => '') : '';
    return EstimatePdf.toBlob(s.estimate, s.caseRow, org, logo || '');
  }
  if (!s.report) throw new Error('元の報告書が見つかりません');
  const opts = await rpdfLoadOpts(s.report);
  if (!mlAlive(s)) throw new Error('画面が切り替わりました');
  return ReportPdf.toBlob(opts); // 写真は 4枚/ページ・全体表示（固定。Task 26）
}
async function mlSend(s) {
  if (s.busy || s.ro || s.phase !== 'edit' || !mlAlive(s)) return;
  mlClearVal(s);
  const f = s.f;
  const to = String(f.to || '').trim();
  // 日程連絡・リマインドで、選んだ相手が全員メール無し → メールアプリは開かず、文面をコピーして送る
  const noMail = !to && mlIsNote(s) && mlRcptKeys(s).length > 0;
  if (!to && !noMail) {
    mlShowVal(s, mlIsNote(s) ? '送る相手を選ぶか、宛先のメールアドレスを入力してください（メールが無い人には「文面をコピー」で送れます）' : '宛先を入力してください');
    s.els.to.focus();
    return;
  }
  if (!mlEmailsOk(to)) { mlShowVal(s, '宛先のメールアドレスの形式が正しくありません'); s.els.to.focus(); return; }
  if (!mlEmailsOk(f.cc)) { mlShowVal(s, 'CCのメールアドレスの形式が正しくありません'); s.els.cc.focus(); return; }
  if (!String(f.subject || '').trim()) { mlShowVal(s, '件名を入力してください'); s.els.subject.focus(); return; }

  s.busy = true;
  mlSyncBusy(s);
  const send = $('mail-send');
  try {
    await mlFlush(s);
    if (!mlAlive(s)) return;
    if (mlPending(s)) { mlShowVal(s, '入力を保存できていません。通信を確認して、上の「再試行」を押してください'); return; }

    const PDF_LINK = ReportLogic.PDF_LINK;
    let url = '';
    if (mlIsNote(s)) {
      // 日程の連絡・リマインドは書類が無いので PDF のリンクは作らない
    } else if (!String(f.body || '').includes(PDF_LINK)) {
      // 本文からリンクの行が消されている → PDFを作らず、リンクなしで開くかどうか確認
      // 画面内の確認（confirm() は使わない。Task 23 M6）
      const ok = await askInline($('mail-bar'), '本文に「' + PDF_LINK + '」の行がないため、' + mlDoc(s) + 'PDFのリンクはメールに入りません。このまま進みますか？',
        { okLabel: 'リンクなしで進む', prepend: true, id: 'ml-ask' });
      if (!ok || !mlAlive(s)) return;
    } else {
      send.textContent = 'PDFを作成中…';
      try {
        const blob = await mlMakePdf(s);
        if (!mlAlive(s)) return;
        url = await ReportsApi.preparePdfLink(s.draft, blob, mlPdfName(s));
      } catch (e) {
        if (ml === s) mlShowVal(s, '送信の準備に失敗しました（PDFの作成・保存）: ' + errText(e));
        return;
      }
      if (!mlAlive(s)) return;
    }

    const link = url ? mlLinkLabel(s) + url : null;
    const built = ReportLogic.buildMailto({ to, cc: f.cc, subject: f.subject, body: f.body, link });
    const mailto = built.url;
    s.mail = {
      mailto, url, subject: f.subject, shortened: built.shortened, noMail,
      fullBody: link ? String(f.body).split(PDF_LINK).join(link) : String(f.body)
    };
    s.phase = 'waiting';
    s.pdf = url ? { kind: 'alive', url, busy: false, err: '' } : null; // 待ち状態でもPDFリンクを無効にできる
    mlWaitSet(s); // タブが再読込されても「送信済みにする」待ちから再開できるように
    s.busy = false;
    mlRender(s);
    if (!noMail) mlOpenMailto(mailto);
  } finally {
    s.busy = false;
    if (ml === s) {
      send.textContent = '送信する';
      mlSyncBusy(s);
    }
  }
}

// メールアプリで送れたあと: 送信済みにして案件へ
async function mlMarkSent(s) {
  if (s.busy || s.ro || s.phase !== 'waiting' || !mlAlive(s)) return;
  s.busy = true;
  mlSyncBusy(s);
  mlClearVal(s);
  // 見積書の送付はタイムラインに「見積書（…）を送付した（宛先…／件名…）」の1件だけ（onMailSent が記録する）
  const estSend = !!(s.estimate && typeof EstimatesApi !== 'undefined');
  let sentRow = null;
  try {
    try {
      sentRow = await ReportsApi.markSent(s.draft, { skipLog: estSend, logText: mlIsNote(s) ? mlSentText(s) : null });
    } catch (e) {
      if (ml === s) mlShowVal(s, '送信済みにできませんでした: ' + errText(e));
      return;
    }
    // 見積書の送付: 見積を送付済みに・紐付けた依頼を対応済みに（失敗しても送信済みは取り消さない）
    if (estSend) {
      try { await EstimatesApi.onMailSent(s.estimate, sentRow); } catch (e) { console.warn('見積書の送付済み更新に失敗', e); }
    }
    // 送信済みになったので端末の退避は先に消す（別の画面へ移っていても残さない）
    mlLsDel(mlWaitKey(s.id));
    mlLsDel(mlDraftKey(s.id));
    if (ml !== s) return;
    s.ro = true; // 以降の保存・送信は受け付けない
    // 送るメール（#outbox）から開いたときはそこへ。見積は見積書一覧へ（版の状態が見える）。日程の連絡などフェーズのメールはフェーズ詳細ページへ、報告書は案件へ
    location.hash = s.returnTo || (mlIsEst(s) ? mlListHash(s) : mlPhaseHash(s) || '#case/' + s.draft.case_id);
  } finally {
    s.busy = false;
    if (ml === s) mlSyncBusy(s);
  }
}

// 日程連絡・リマインドのフェーズ（case_summaries.phases の要素。何回目 seq 付き）
const mlPhase = s => ((s.caseRow && s.caseRow.phases) || []).find(p => p.id === s.draft.phase_id) || null;
// 送信済みの記録: 「調査 1回目: 調査日のご連絡を送った（元請・入居者）」。手で足した宛先はアドレスで
function mlSentText(s) {
  const phase = mlPhase(s);
  const who = [PhaseLogic.recipientsLabel(mlRcptKeys(s), s.caseRow), mlManualTo(s).join(', ')].filter(Boolean).join('、');
  return (phase ? PhaseLogic.phaseTitle(phase) + ': ' : '') + PhaseLogic.mailLabel(s.draft, phase) + 'を送った（' + (who || '宛先なし') + '）';
}

/* ---------- 入口 ---------- */
// 戻り先つきで開く（送るメールの一覧から）。戻り先はこの下書きを開いたときだけ使う
function openMailDraftFrom(id, hash) {
  mlReturn = { id: String(id).toLowerCase(), hash };
  openMailDraft(id);
}
// 一覧のカード等 → location.hash 変更 → hashchange → routeFromHash → ここ。hash がまだ違うときは hash を変えるだけ
function openMailDraft(id) {
  if (!id) return;
  id = String(id).toLowerCase(); // UUID は大文字でも開く（DB・内部の比較は小文字）
  if (!mlIsHash(id, location.hash)) { location.hash = '#mail/' + id; return; }
  return mlOpen(id);
}

async function mlOpen(id) {
  const seq = ++mlSeq;
  const returnTo = mlReturn && mlReturn.id === id ? mlReturn.hash : null; // 1回だけ使う（カードから開き直したときは案件へ戻る）
  mlReturn = null;
  const prev = ml;
  showScreen('mail');
  renderHeaders();
  mlMessage('読み込み中…', false);
  // 直前に開いていた下書きの保留中の保存を終わらせてから読み込む（同じ下書きに戻ったとき古い内容を読まないため）
  if (prev) { clearTimeout(prev.timer); await mlFlush(prev); }
  if (seq !== mlSeq) return;
  ml = null;

  let draft, caseRow, report = null, estimate = null;
  try {
    draft = await ReportsApi.getDraft(id);
    if (draft) {
      [caseRow, report] = await Promise.all([
        CasesApi.getSummary(draft.case_id),
        draft.report_id ? ReportsApi.get(draft.report_id) : Promise.resolve(null)
      ]);
      if (draft.estimate_id && typeof EstimatesApi !== 'undefined') estimate = await EstimatesApi.get(draft.estimate_id);
    }
  } catch (e) {
    if (seq !== mlSeq) return;
    mlMessage('メールの下書きを読み込めませんでした: ' + errText(e), true);
    return;
  }
  if (seq !== mlSeq) return;
  if (!draft) { mlMessage('メールの下書きが見つかりません', false); return; }
  // Task 23 C2: 現場用の画面からは送らない（送付・連絡メールは管理者の操作）。送信ボタンを出さず、戻るだけ
  if (typeof fieldHidesAdmin === 'function' && fieldHidesAdmin()) {
    $('mail-bar').hidden = true;
    const back = dBtn('‹ 戻る', 'back', () => { if (history.length > 1) history.back(); else location.hash = '#f/case/' + draft.case_id; });
    $('mail-root').replaceChildren(back, mk('div', 'empty ml-field-note', 'メールは管理者が送ります。現場用の画面からは送れません。伝えたいことは「管理者に連絡」から送ってください'));
    return;
  }

  // 担当者へのメール: 宛名・宛先の作業担当者（フェーズの担当者・社内メンバーのメール）を caseRow に足す
  if (draft.purpose === 'staff_notice' && caseRow) {
    const phase = (caseRow.phases || []).find(p => p.id === draft.phase_id) || {};
    let members = [];
    try { members = (await CasesApi.listMembers()) || []; } catch (e) { console.warn('担当者を読み込めませんでした', e); }
    if (seq !== mlSeq) return;
    caseRow = PhasesApi.withWorker(caseRow, phase.worker_id, members);
  }
  const s = {
    id: draft.id, gen: seq, draft, caseRow: caseRow || { name: '' }, report, estimate, returnTo,
    ro: draft.status !== 'draft', phase: 'edit', mail: null,
    f: { to: draft.to_email || '', cc: draft.cc || '', subject: draft.subject || '', body: draft.body || '',
      recipients: Array.isArray(draft.recipients) ? draft.recipients.slice() : [] },
    dirty: false, timer: null, chain: Promise.resolve(), saveState: '', saveErr: '', lastSaved: null, busy: false, restored: false, els: {}
  };
  if (s.ro) {
    mlLsDel(mlWaitKey(id));
    mlLsDel(mlDraftKey(id));
  } else {
    const w = mlWaitGet(id);
    if (w) { // メールアプリから戻ってタブが読み込み直された → 「送信済みにする」待ちから再開
      s.phase = 'waiting';
      s.mail = w;
      if (!w.url) { // リンクなしで送った場合は、保存済みの下書きの内容からリンクなしの mailto を作り直す
        w.subject = s.f.subject;
        w.fullBody = s.f.body;
        const b2 = ReportLogic.buildMailto({ to: s.f.to, cc: s.f.cc, subject: s.f.subject, body: s.f.body, link: null });
        w.mailto = b2.url;
        w.shortened = b2.shortened;
      }
    } else {
      // 保存できないまま離れた入力が端末に残っていて、その後サーバー側が変わっていなければ戻して保存し直す
      const b = mlDraftGet(id);
      if (b) {
        if (mlSameStamp(b.base, draft.updated_at)) { Object.assign(s.f, b.f); s.dirty = true; s.restored = true; }
        else mlLsDel(mlDraftKey(id));
      }
    }
  }
  ml = s;
  // 送付済み、または送信待ち（リンクつき）の再開: PDFリンクの状態を確認して「無効にする」を出す
  if ((s.ro || (s.phase === 'waiting' && s.mail && s.mail.url)) && ReportsApi.isPublicPdfPath(draft.pdf_path)) {
    s.pdf = { kind: 'checking', url: '', busy: false, err: '' };
  } else if (s.phase === 'waiting' && s.mail && s.mail.url && draft.pdf_path == null) {
    s.pdf = { kind: 'gone', url: '', busy: false, err: '' }; // 送信待ちで無効にした後（pdf_path は空になる）
  }
  mlRender(s);
  // 確認が要るのは checking のときだけ。gone（送信待ちで無効化済み・pdf_path が空）で確認すると none が返って「無効化済み」が消える
  if (s.pdf && s.pdf.kind === 'checking') mlLoadPdfLink(s);
  if (s.dirty) mlFlush(s);
}
