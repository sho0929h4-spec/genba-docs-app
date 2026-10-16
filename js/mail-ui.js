// js/mail-ui.js — ⑨ 依頼者へ送る報告メールの下書き確認・送信（#mail/{id}）… openMailDraft(id)  （Task 7）
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
const ML_LINK_LABEL = '報告書PDF: ';
const ML_EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
let ml = null;      // 表示中の画面の状態
let mlSeq = 0;      // openMailDraft のたびに増やす

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
    return { mailto: o.mailto, url: o.url || '', subject: o.subject, fullBody: o.fullBody, shortened: o.shortened === true }; // url が空 = リンクなしで送った
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

function mlMessage(text, isErr, backCaseId) {
  $('mail-bar').hidden = true;
  const nodes = [];
  if (backCaseId) nodes.push(dBtn('← 報告書一覧', 'back', () => { location.hash = '#case/' + backCaseId + '/reports'; }));
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
  return {
    to_email: String(f.to || '').trim() || null,
    cc: String(f.cc || '').trim() || null,
    subject: String(f.subject || ''),
    body: String(f.body || '')
  };
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
  box.replaceChildren(mk('div', 'rep-val-e', '⛔ ' + text));
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ---------- 描画 ---------- */
function mlBackBtn(s) {
  const b = dBtn('← 報告書一覧', 'back', () => mlLeave(s, '#case/' + s.draft.case_id + '/reports'));
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

function mlAttachment(s) {
  const L = ReportLogic;
  const room = s.report ? s.report.room : '';
  const name = L.fileName(s.caseRow && s.caseRow.name, room);
  const box = mk('div', 'ml-att');
  box.id = 'ml-att';
  const info = mk('div');
  info.appendChild(mk('b', null, name));
  info.appendChild(mk('div', 'rep-sub', s.ro
    ? '送付時に作成した報告書PDF（ダウンロードリンク・期限なしとして本文に入れました）'
    : (s.report ? '送信時にPDFを作成し、ダウンロードリンク（期限なし）を本文に入れます'
      : '元の報告書が見つからないため、PDFのリンクは入れられません')));
  box.append(mk('span', 'ic', 'PDF'), info);
  return box;
}

function mlHeadRow(s) {
  const row = mk('div', 'rep-between rep-ed-top');
  row.appendChild(mlBackBtn(s));
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
  head.appendChild(mk('b', null, '✉ 依頼者へ送るメール' + (s.ro ? '' : '（下書き）')));
  head.appendChild(mk('span', 'rep-pill ' + (s.ro ? 'p-ok' : 'p-sent'), s.ro ? '送付済み' : '自動作成'));
  card.appendChild(head);

  const to = edInput('ml-to', 'email', f.to, v => mlSet(s, 'to', v), { placeholder: '例: tanto@example.co.jp', autocomplete: 'off' });
  to.multiple = true; // 複数宛先はカンマ区切り
  const cc = edInput('ml-cc', 'text', f.cc, v => mlSet(s, 'cc', v), { placeholder: '任意（複数はカンマ区切り）', autocomplete: 'off' });
  cc.inputMode = 'email';
  const subject = edInput('ml-subject', 'text', f.subject, v => mlSet(s, 'subject', v), { autocomplete: 'off' });
  const body = edTextarea('ml-body', f.body, false, '', v => mlSet(s, 'body', v));
  Object.assign(s.els, { to, cc, subject, body });

  card.appendChild(edField('宛先', to));
  card.appendChild(edField('CC', cc));
  card.appendChild(mlSenderNote());
  card.appendChild(edField('件名', subject));
  card.appendChild(edField('本文', body, s.ro ? '' : '「{{PDF_LINK}}」の行には、送信時に報告書PDFのリンクが入ります', 'ml-body-ff'));
  card.appendChild(mlAttachment(s));
  const quote = mk('div', 'ml-att ml-att-off', '＋ 見積書を添付（見積書機能の追加後に使えます）');
  quote.style.marginTop = '8px';
  card.appendChild(quote);
  card.appendChild(mk('div', 'rep-note', '送ったメールは案件のタイムラインに「送付した（宛先・件名・添付）」として残ります'));
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
  const nodes = [mk('b', null, '報告書PDFのリンク')];
  if (p.kind === 'checking') {
    nodes.push(mk('div', 'rep-sub', '確認中…'));
  } else if (p.kind === 'gone') {
    const g = mk('div', 'rep-sub', '無効化済み（このリンクからはPDFを開けません）' +
      (s.phase === 'waiting' ? '。メールを送り直すときは「内容を直す（編集に戻る）」から送信し直してください' : ''));
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
      url.setAttribute('aria-label', '報告書PDFの公開リンク');
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
  try { s.pdf = Object.assign({ busy: false, err: '' }, await ReportsApi.pdfLinkState(s.draft)); }
  catch (e) { s.pdf = { kind: 'none', busy: false, err: '' }; return; } // 確認できなければ何も出さない
  if (ml !== s) return;
  mlRender(s);
}

async function mlRevokePdf(s) {
  if (!s.pdf || s.pdf.busy || s.pdf.kind !== 'alive' || !mlAlive(s)) return;
  if (!confirm('このメールのPDFリンクを無効にしますか？\n無効にすると、メールを受け取った人はPDFを開けなくなります（元に戻せません。報告書そのものは消えません）。\n反映まで数分〜1時間ほどかかる場合があります。')) return;
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
  card.appendChild(mk('h3', null, '✉ メールアプリを開きました'));
  card.appendChild(mk('div', null, 'メールアプリで送信できたら『送信済みにする』を押してください'));
  if (m.shortened) { // 本文が長く、mailto には全文を入れられなかった
    const warn = mk('div', 'ml-short-warn', '本文が長いため短縮してメールアプリを開きました。『本文をコピー』で全文を貼り付けてください');
    warn.id = 'ml-short-warn';
    warn.setAttribute('role', 'alert');
    card.appendChild(warn);
  }
  card.appendChild(mk('div', 'rep-sub', '宛先: ' + (s.f.to || '') + (s.f.cc ? ' ／ CC: ' + s.f.cc : '')));

  card.appendChild(mk('div', 'rep-group-ttl', 'メールアプリが開かないとき'));
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
    dBtn('メールアプリを開き直す', 'btn sm ghost inline', () => mlOpenMailto(m.mailto))
  );
  card.append(acts, copied);

  if (m.url) {
    const url = document.createElement('input');
    url.type = 'text';
    url.id = 'ml-link-url';
    url.className = 'ml-url';
    url.readOnly = true;
    url.value = m.url;
    url.setAttribute('aria-label', '報告書PDFのダウンロードリンク（期限なし）');
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
  later.onclick = () => mlLeave(s, s.ro ? '#case/' + s.draft.case_id : '#case/' + s.draft.case_id + '/reports');
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
    if (mlPending(s) && !confirm('保存できていない入力があります。このまま戻りますか？')) return;
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
async function mlSend(s) {
  if (s.busy || s.ro || s.phase !== 'edit' || !mlAlive(s)) return;
  mlClearVal(s);
  const f = s.f;
  const to = String(f.to || '').trim();
  if (!to) { mlShowVal(s, '宛先を入力してください'); s.els.to.focus(); return; }
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
    if (!String(f.body || '').includes(PDF_LINK)) {
      // 本文からリンクの行が消されている → PDFを作らず、リンクなしで開くかどうか確認
      if (!confirm('本文に「' + PDF_LINK + '」の行がないため、報告書PDFのリンクはメールに入りません。このまま進みますか？')) return;
    } else {
      send.textContent = 'PDFを作成中…';
      try {
        if (!s.report) throw new Error('元の報告書が見つかりません');
        const opts = await rpdfLoadOpts(s.report);
        if (!mlAlive(s)) return;
        const blob = await ReportPdf.toBlob(Object.assign({}, opts, { perPage: 4, fit: 'contain' }));
        if (!mlAlive(s)) return;
        url = await ReportsApi.preparePdfLink(s.draft, blob);
      } catch (e) {
        if (ml === s) mlShowVal(s, '送信の準備に失敗しました（PDFの作成・保存）: ' + errText(e));
        return;
      }
      if (!mlAlive(s)) return;
    }

    const link = url ? ML_LINK_LABEL + url : null;
    const built = ReportLogic.buildMailto({ to, cc: f.cc, subject: f.subject, body: f.body, link });
    const mailto = built.url;
    s.mail = {
      mailto, url, subject: f.subject, shortened: built.shortened,
      fullBody: link ? String(f.body).split(PDF_LINK).join(link) : String(f.body)
    };
    s.phase = 'waiting';
    s.pdf = url ? { kind: 'alive', url, busy: false, err: '' } : null; // 待ち状態でもPDFリンクを無効にできる
    mlWaitSet(s); // タブが再読込されても「送信済みにする」待ちから再開できるように
    s.busy = false;
    mlRender(s);
    mlOpenMailto(mailto);
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
  try {
    try {
      await ReportsApi.markSent(s.draft);
    } catch (e) {
      if (ml === s) mlShowVal(s, '送信済みにできませんでした: ' + errText(e));
      return;
    }
    // 送信済みになったので端末の退避は先に消す（別の画面へ移っていても残さない）
    mlLsDel(mlWaitKey(s.id));
    mlLsDel(mlDraftKey(s.id));
    if (ml !== s) return;
    s.ro = true; // 以降の保存・送信は受け付けない
    location.hash = '#case/' + s.draft.case_id;
  } finally {
    s.busy = false;
    if (ml === s) mlSyncBusy(s);
  }
}

/* ---------- 入口 ---------- */
// 一覧のカード等 → location.hash 変更 → hashchange → routeFromHash → ここ。hash がまだ違うときは hash を変えるだけ
function openMailDraft(id) {
  if (!id) return;
  id = String(id).toLowerCase(); // UUID は大文字でも開く（DB・内部の比較は小文字）
  if (!mlIsHash(id, location.hash)) { location.hash = '#mail/' + id; return; }
  return mlOpen(id);
}

async function mlOpen(id) {
  const seq = ++mlSeq;
  const prev = ml;
  showScreen('mail');
  renderHeaders();
  mlMessage('読み込み中…', false);
  // 直前に開いていた下書きの保留中の保存を終わらせてから読み込む（同じ下書きに戻ったとき古い内容を読まないため）
  if (prev) { clearTimeout(prev.timer); await mlFlush(prev); }
  if (seq !== mlSeq) return;
  ml = null;

  let draft, caseRow, report = null;
  try {
    draft = await ReportsApi.getDraft(id);
    if (draft) {
      [caseRow, report] = await Promise.all([
        CasesApi.getSummary(draft.case_id),
        draft.report_id ? ReportsApi.get(draft.report_id) : Promise.resolve(null)
      ]);
    }
  } catch (e) {
    if (seq !== mlSeq) return;
    mlMessage('メールの下書きを読み込めませんでした: ' + errText(e), true);
    return;
  }
  if (seq !== mlSeq) return;
  if (!draft) { mlMessage('メールの下書きが見つかりません', false); return; }

  const s = {
    id: draft.id, gen: seq, draft, caseRow: caseRow || { name: '' }, report,
    ro: draft.status !== 'draft', phase: 'edit', mail: null,
    f: { to: draft.to_email || '', cc: draft.cc || '', subject: draft.subject || '', body: draft.body || '' },
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
  }
  mlRender(s);
  if (s.pdf) mlLoadPdfLink(s);
  if (s.dirty) mlFlush(s);
}
