// js/field-ui.js — 現場担当アプリ（スマホ専用の現場用画面。対応フェーズ Task 18。画面案 docs/mocks/mock-field.html）
// ルート: #f（自分の案件一覧）／#f/case/{id}（ツールページ）／#f/inbox（🔔 確認してください）／#f/contact（管理者に連絡。Task 23）／#f/settings（設定）。
// 下のタブバー 案件／確認／管理者に連絡／設定（safe-area）。現場用では送付・連絡メールの下書きは出さない（Task 23 C2。#f/outbox は #f/contact へ）
// 入口（fieldRoute: app.js の routeFromHash の最初に呼ぶ）:
//   スタッフ（memberships.role = 'member'）は現場用の画面だけ。管理画面のルートを開いても現場用に戻す
//     （#case/{id}…（フェーズ詳細・協力業者URLを含む）→ #f/case/{id}、#inbox-staff → #f/inbox、#outbox・#messages → #f/contact、それ以外 → #f）。
//   管理者（owner）は管理画面が既定。設定の「画面: 現場用／管理画面」で切替（この端末の localStorage に人ごとに記憶）。
//     現場用にしている管理者は、空のルートで #f が開く（管理画面のリンクを開いたときはそのまま管理画面）。
//     管理画面にしている管理者が #f… を開いたら管理画面へ（#f/case/{id} → #case/{id}）。
//   報告書・見積書・工事掲示・送付メールの画面（共通）は現場用からも開ける。そのとき body に fd-mode を付け、
//     ヘッダーの 💴（請求）を隠し、⚙️ は現場用の設定へ、戻るは「‹ ツール」（#f/case/{id}）にする（fieldBack）。
// 案件一覧は自分の担当だけ（案件の担当者か、フェーズの作業担当者。「全部」は出さない＝Ruling）。並びは PhaseLogic.fieldCases。
// ツールページ: 住所（Googleマップ）・入居者の電話・対応の切替チップ（今日の予定の対応が初期選択。無ければ最新）・
//   「📝 現場への指示（○○さんから）」と「確認した」（既存の ack。担当者本人・知らせてもらった後だけ）・
//   3つの大きなツールボタン（①報告書 ②見積書 ③工事掲示。状態は PhaseLogic.fieldTools）。押すと phase_id 付きで作る／開く。
// DB の変更は無い（スタッフも API では会社の全案件を読める。画面で絞るだけ）
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。alert/confirm は使わない
// mk() は case-list.js、dBtn / errText は case-detail.js、openStaffInbox は staff-inbox.js、openFieldContact / smOpenSheet は staff-messages.js、
// $ / showScreen / renderHeaders / withBusy は app.js

const FD_UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const FD_CASE_RE = new RegExp('^#f/case/' + FD_UUID + '$', 'i');
const FD_TABS = [
  { view: 'cases', hash: '#f', icon: '📋', label: '案件' },
  { view: 'inbox', hash: '#f/inbox', icon: '🔔', label: '確認' },
  { view: 'contact', hash: '#f/contact', icon: '✉️', label: '管理者に連絡' },
  { view: 'settings', hash: '#f/settings', icon: '⚙️', label: '設定' }
];
// 現場用からも開く共通の画面（報告書・見積書・工事掲示・送付メール）
const FD_SHARED_RES = [
  new RegExp('^#report/' + FD_UUID + '(/pdf)?$', 'i'),
  new RegExp('^#case/' + FD_UUID + '/(reports|estimates|notices)$', 'i'),
  new RegExp('^#estimate/' + FD_UUID + '(/pdf|/diff)?$', 'i'),
  new RegExp('^#notice/' + FD_UUID + '$', 'i'),
  new RegExp('^#mail/' + FD_UUID + '$', 'i')
];

let fd = null;          // { seq, view, caseId, rows, loading, err, data, busy, msg }
let fdSeq = 0;
const fdSel = new Map(); // 案件ごとに選んだ対応（この画面を開いている間だけ覚える。ツールから戻ったとき同じ対応を選ぶ）

/* ---------- 案件の集計の使い回し（Task 23 I13） ---------- */
// 現場用のタブ（案件・確認・管理者に連絡）を切り替えるたびに case_summaries を全部読み直さない（60秒は使い回す）。
// 書類の画面（報告書・見積書・工事掲示・メール）を開いたとき・操作したとき・画面に戻ったときは捨てて読み直す
const FD_ROWS_TTL = 60000;
let fdRowsCache = null; // { at, promise }
function fieldRows(force) {
  const now = Date.now();
  if (!force && fdRowsCache && now - fdRowsCache.at < FD_ROWS_TTL) return fdRowsCache.promise;
  const promise = CasesApi.listSummaries().then(r => r || []);
  fdRowsCache = { at: now, promise };
  promise.catch(() => { if (fdRowsCache && fdRowsCache.promise === promise) fdRowsCache = null; });
  return promise;
}
function fieldRowsInvalidate() { fdRowsCache = null; }

/* ---------- 画面の切替（現場用／管理画面） ---------- */
const fdMe = () => (ctx && ctx.user ? ctx.user.id : null);
const fdIsOwner = () => !!(ctx && ctx.membership && ctx.membership.role === 'owner');
const fdPrefKey = () => 'genba-docs.view.' + (fdMe() || '');
function fieldViewPref() {
  try { return localStorage.getItem(fdPrefKey()) || ''; } catch (e) { return ''; }
}
function setFieldViewPref(v) {
  try { localStorage.setItem(fdPrefKey(), v); } catch (e) { /* 使えない端末では記憶しない（この画面の間だけ） */ }
  fdPrefMem = v;
}
let fdPrefMem = '';
// 現場用の画面で使うか（スタッフは常に。管理者は設定で現場用を選んだとき）
function isFieldMode() {
  if (!ctx || !ctx.membership) return false;
  if (!fdIsOwner()) return true;
  return (fieldViewPref() || fdPrefMem) === 'field';
}
// 現場用から開いた共通の画面の「‹ ツール」（現場用でなければ null）
function fieldBack(caseId) {
  if (!caseId || !document.body.classList.contains('fd-mode')) return null;
  return { label: '‹ ツール', hash: '#f/case/' + String(caseId).toLowerCase() };
}
// 管理者向けの操作（送付・承諾・請求・削除）を出すか。現場用で開いているときは出さない
function fieldHidesAdmin() {
  return document.body.classList.contains('fd-mode');
}

function fdSetMode(on) { document.body.classList.toggle('fd-mode', !!on); }
function fdReplace(hash) {
  history.replaceState(null, '', location.pathname + location.search + (hash && hash !== '#' ? hash : ''));
}
function fdMatch(h) {
  if (h === '#f' || h === '#f/') return { view: 'cases' };
  if (h === '#f/inbox') return { view: 'inbox' };
  if (h === '#f/contact' || h === '#f/outbox') return { view: 'contact' }; // Task 23: 送るメール → 管理者に連絡
  if (h === '#f/settings') return { view: 'settings' };
  const m = h.match(FD_CASE_RE);
  if (m) return { view: 'case', caseId: m[1].toLowerCase() };
  return null;
}
// 管理画面のルート → 現場用のルート
function fdRedirectOf(h) {
  const m = h.match(new RegExp('^#case/' + FD_UUID + '(?:/phase/' + FD_UUID + ')?', 'i'));
  if (m) {
    if (m[2]) fdSel.set(m[1].toLowerCase(), m[2].toLowerCase()); // フェーズ詳細のリンク → その対応を選んで開く
    return '#f/case/' + m[1].toLowerCase();
  }
  if (h === '#inbox-staff') return '#f/inbox';
  if (h === '#outbox' || /^#messages/.test(h)) return '#f/contact';
  return '#f';
}

// app.js の routeFromHash の最初に呼ぶ。true = ここで画面を開いた（以降のルートは見ない）
function fieldRoute() {
  const h = location.hash;
  const fm = fdMatch(h);
  if (!isFieldMode()) {
    fdSetMode(false);
    if (fm) fdReplace(fm.view === 'case' ? '#case/' + fm.caseId : ''); // 管理画面にしている管理者 → 管理画面
    return false;
  }
  if (fm) { fdSetMode(true); openField(fm); return true; }
  if (FD_SHARED_RES.some(re => re.test(h))) { fieldRowsInvalidate(); fdSetMode(true); return false; } // 共通の画面（現場用の見た目で開く。書類を変えるので集計は読み直す）
  if (fdIsOwner() && h && h !== '#' && h !== '#login') { fdSetMode(false); return false; } // 管理者は管理画面のリンクをそのまま開ける
  const to = fdRedirectOf(h);
  fdReplace(to);
  fdSetMode(true);
  openField(fdMatch(to));
  return true;
}

/* ---------- 画面の枠（上のバー・下のタブバー） ---------- */
function openField(fm) {
  renderHeaders();
  showScreen('field');
  const seq = ++fdSeq;
  fd = { seq, view: fm.view, caseId: fm.caseId || null, rows: [], loading: true, err: '', data: null, busy: '', msg: '', toolErr: '' };
  fdTabs();
  const host = $('field-root');
  host.replaceChildren();
  document.title = '現場ドキュメント';
  if (fm.view === 'cases') { fdBar('現場ドキュメント'); fdRenderCases(); return fdLoadCases(seq); }
  if (fm.view === 'case') { fdBar('案件', '‹ 案件', '#f'); fdRenderCase(); return fdLoadCase(seq); }
  if (fm.view === 'inbox') {
    fdBar('確認してください');
    return openStaffInbox({ field: true, root: host });
  }
  if (fm.view === 'contact') {
    if (location.hash === '#f/outbox') fdReplace('#f/contact');
    fdBar('管理者に連絡');
    return openFieldContact(host);
  }
  fdBar('設定');
  fdRenderSettings();
}
const fdAlive = s => fd === s && $('screen-field').classList.contains('active');

function fdBar(title, backLabel, backHash) {
  const back = $('fd-back');
  back.hidden = !backLabel;
  back.textContent = backLabel || '';
  back.onclick = backHash ? () => { location.hash = backHash; } : null;
  $('fd-title').textContent = title;
}
function fdTabs() {
  const nav = $('fd-tabs');
  const active = fd && fd.view === 'case' ? 'cases' : fd && fd.view;
  nav.replaceChildren(...FD_TABS.map(t => {
    const b = dBtn('', 'fd-tab' + (t.view === active ? ' on' : ''), () => {
      // 今のタブをもう一度押したら読み直す（集計の使い回しを捨てる）
      if (location.hash === t.hash) { fieldRowsInvalidate(); openField(fdMatch(t.hash)); } else location.hash = t.hash;
    });
    b.dataset.tab = t.view;
    if (t.view === active) b.setAttribute('aria-current', 'page');
    b.appendChild(mk('b', 'fd-tab-ic', t.icon));
    b.appendChild(mk('span', null, t.label));
    return b;
  }));
}

/* ---------- #f 自分の案件一覧 ---------- */
async function fdLoadCases(seq) {
  let rows = [], err = '', msgs = [];
  try {
    rows = await fieldRows();
    // 管理者からの返事（未読）がある案件があれば読む（🔔 の件数に入れる。Task 23）
    if (rows.some(r => Number(r.staff_unread) > 0)) msgs = (await StaffMessagesApi.list({ toUser: fdMe(), unread: true })) || [];
  } catch (e) { err = '案件を読み込めませんでした: ' + errText(e); }
  if (!fd || fd.seq !== seq) return;
  Object.assign(fd, { rows, msgs, loading: false, err });
  fdRenderCases();
  // 時刻を過ぎたリマインド（お客様向け・担当者向けの前日のお知らせ）の下書きを作る（管理画面の案件一覧と同じ。サーバーの定期実行は使わない）
  if (!err && typeof outboxSync === 'function') {
    // 自分の担当の案件の分だけ（Task 23 I13。現場用ではメールの一覧は出さない）
    try { await outboxSync(rows.filter(r => PhaseLogic.fieldMine(r, fdMe()))); } catch (e) { console.warn('リマインドの確認に失敗', e); }
  }
}

function fdRenderCases() {
  const s = fd;
  const host = $('field-root');
  const nodes = [];
  if (s.loading) nodes.push(mk('div', 'empty', '読み込み中…'));
  else if (s.err) {
    nodes.push(mk('div', 'err', s.err));
    nodes.push(dBtn('再読み込み', 'btn sm ghost inline', () => openField({ view: 'cases' })));
  } else {
    const now = new Date();
    const n = PhaseLogic.staffInbox(s.rows, fdMe(), now, { messages: s.msgs }).length;
    if (n) {
      const b = dBtn('', 'fd-bell', () => { location.hash = '#f/inbox'; });
      b.id = 'fd-bell';
      b.appendChild(mk('b', null, '🔔 確認してください ' + n + '件'));
      b.appendChild(mk('span', 'fd-tiny', '見る ›'));
      nodes.push(b);
    }
    const list = PhaseLogic.fieldCases(s.rows, fdMe(), now);
    const h = mk('div', 'fd-h', '自分の担当 ' + list.length + '件');
    h.id = 'fd-count';
    nodes.push(h);
    if (!list.length) {
      const e = mk('div', 'empty', '担当の案件はありません');
      e.id = 'fd-empty';
      nodes.push(e);
    }
    const wrap = mk('div', 'fd-list');
    wrap.id = 'fd-list';
    list.forEach(it => wrap.appendChild(fdCaseCard(it)));
    nodes.push(wrap);
  }
  host.replaceChildren(...nodes);
}

function fdKindBadge(kind) {
  return mk('span', 'ph-kind k-' + kind, PhaseLogic.kindLabel(kind));
}
function fdBallClass(st) { return st && st.ball === 'us' ? ' us' : st && st.ball === 'them' ? ' them' : ''; }

function fdCaseCard(it) {
  const c = it.caseRow;
  const card = mk('div', 'fd-card' + (it.today ? ' today' : ''));
  card.dataset.caseId = c.id;
  const main = dBtn('', 'fd-card-main', () => { location.hash = '#f/case/' + c.id; });
  const top = mk('div', 'fd-row');
  if (it.phase) top.appendChild(fdKindBadge(it.phase.kind));
  top.appendChild(mk('b', 'fd-when', it.when));
  top.appendChild(mk('span', 'fd-sp'));
  if (it.stageText) top.appendChild(mk('span', 'fd-stage' + fdBallClass(it.stage), it.stageText));
  main.appendChild(top);
  main.appendChild(mk('span', 'fd-place', PhaseLogic.placeName(c) || '（物件名なし）'));
  if (c.address) main.appendChild(mk('span', 'fd-tiny fd-addr', '📍 ' + c.address));
  card.appendChild(main);
  const tel = fdTelLink(c);
  if (tel) card.appendChild(tel);
  return card;
}
// 入居者の電話（tel:）。電話番号が無ければ名前だけ、どちらも無ければ null
function fdTelLink(c) {
  const name = String(c.resident_name || '').trim();
  const tel = String(c.resident_tel || '').trim();
  if (!tel) return name ? mk('span', 'fd-tiny fd-res', '入居者 ' + name + '様') : null;
  const a = mk('a', 'fd-tel', '☎ 入居者' + (name ? ' ' + name + '様' : '') + ' ' + tel);
  a.href = 'tel:' + tel.replace(/[^0-9+]/g, '');
  return a;
}

/* ---------- #f/case/{id} ツールページ ---------- */
async function fdLoadCase(seq) {
  const s = fd;
  let res, err = '';
  try {
    res = await Promise.all([
      CasesApi.getSummary(s.caseId),
      ReportsApi.listByCase(s.caseId),
      EstimatesApi.listByCase(s.caseId),
      NoticesApi.listByCase(s.caseId)
    ]);
  } catch (e) { err = '案件を読み込めませんでした: ' + errText(e); }
  if (!fd || fd.seq !== seq) return;
  s.loading = false;
  s.err = err;
  if (!err && res[1] && res[1].length) {
    // 担当者URLが使えるか（調査報告待ち。Task 23 I6。案件ページの phLoad と同じ形）
    try {
      const shares = (await ReportsApi.listSharesByReports(res[1].map(r => r.id))) || [];
      res[1].forEach(r => {
        const act = shares.find(sh => sh.report_id === r.id && ReportsApi.shareActive(sh));
        r.share_active = !!act;
        r.share_name = act ? act.vendor_name || '' : '';
      });
    } catch (e) { console.warn('担当者URLの読み込みに失敗', e); }
    if (!fd || fd.seq !== seq) return;
  }
  if (!err) {
    if (!res[0]) s.err = '案件が見つかりません';
    else s.data = { caseRow: res[0], reports: res[1] || [], estimates: (res[2] || []).flatMap(x => x.versions || []), notices: res[3] || [] };
  }
  fdRenderCase();
}

function fdSelected(s) {
  const c = s.data.caseRow;
  const phases = Array.isArray(c.phases) ? c.phases : [];
  const want = fdSel.get(c.id);
  return phases.find(p => p.id === want) || PhaseLogic.fieldDefaultPhase(phases, new Date());
}

function fdRenderCase() {
  const s = fd;
  const host = $('field-root');
  if (s.loading) { host.replaceChildren(mk('div', 'empty', '読み込み中…')); return; }
  if (s.err) {
    host.replaceChildren(mk('div', 'err', s.err), dBtn('再読み込み', 'btn sm ghost inline', () => openField({ view: 'case', caseId: s.caseId })));
    return;
  }
  const c = s.data.caseRow;
  const place = PhaseLogic.placeName(c) || '（物件名なし）';
  fdBar(place, '‹ 案件', '#f');
  document.title = place + ' - 現場ドキュメント';
  const nodes = [];
  // 住所（Googleマップ）・入居者の電話
  const info = mk('div', 'fd-info');
  if (c.address) {
    const a = mk('a', 'fd-map', '📍 ' + c.address + '（Googleマップ）');
    a.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(c.address);
    a.target = '_blank';
    a.rel = 'noopener';
    info.appendChild(a);
  }
  const tel = fdTelLink(c);
  if (tel) info.appendChild(tel);
  if (info.childNodes.length) nodes.push(info);

  const phases = Array.isArray(c.phases) ? c.phases : [];
  if (!phases.length) {
    const e = mk('div', 'empty', 'この案件にはまだ対応（調査・工事）がありません。管理者に登録してもらってください');
    e.id = 'fd-no-phase';
    nodes.push(e);
    host.replaceChildren(...nodes);
    return;
  }
  const sel = fdSelected(s);
  // 対応の切替チップ
  const chips = mk('div', 'fd-chips');
  chips.id = 'fd-phase-chips';
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'どの対応の分か');
  PhaseLogic.fieldPhaseChips(phases, new Date()).forEach(ch => {
    const on = ch.id === sel.id;
    const b = dBtn(ch.text, 'fd-chip' + (on ? ' on' : ''), () => {
      fdSel.set(c.id, ch.id);
      s.toolErr = '';
      s.msg = '';
      fdRenderCase();
    });
    b.dataset.phaseId = ch.id;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    chips.appendChild(b);
  });
  nodes.push(chips);
  const st = PhaseLogic.stage(sel, null, new Date());
  const stText = PhaseLogic.fieldStageLabel(st) || (st.label ? '✓ ' + st.label : '');
  if (stText) {
    const sl = mk('div', 'fd-stage-line' + fdBallClass(st), '今: ' + stText);
    sl.id = 'fd-stage-line';
    nodes.push(sl);
  }
  const brief = fdBriefCard(s, c, sel);
  if (brief) nodes.push(brief);
  const msg = mk('div', 'ob-msg', s.msg || '');
  msg.id = 'fd-msg';
  msg.setAttribute('role', 'status');
  nodes.push(msg);
  // 3つのツール
  const docs = {
    reports: s.data.reports.filter(r => r.phase_id === sel.id),
    estimates: s.data.estimates.filter(e => e.phase_id === sel.id),
    notices: s.data.notices.filter(n => n.phase_id === sel.id)
  };
  const t = PhaseLogic.fieldTools(docs);
  const tools = mk('div', 'fd-tools');
  tools.id = 'fd-tools';
  tools.appendChild(fdToolBtn(s, 'report', '📋', '① 報告書', t.report, () => fdOpenReport(s, c, sel, t.report)));
  tools.appendChild(fdToolBtn(s, 'estimate', '🧾', '② 見積書', t.estimate, () => fdOpenEstimate(s, c, sel, phases, t.estimate)));
  tools.appendChild(fdToolBtn(s, 'notice', '📢', '③ 工事掲示', t.notice, () => fdOpenNotice(s, c, sel, phases, t.notice)));
  nodes.push(tools);
  const err = mk('div', 'err', s.toolErr || '');
  err.id = 'fd-tool-err';
  nodes.push(err);
  // 管理者に連絡（Task 23。この案件・対応を選んだ状態でシートを開く）
  const ct = dBtn('📨 管理者に連絡', 'btn ghost fd-contact', () => smOpenSheet({ rows: [c], caseId: c.id, phaseId: sel.id,
    onSent: () => { if (fdAlive(s)) { s.msg = '管理者に連絡しました（「✉️ 管理者に連絡」のタブで返事を見られます）'; fdRenderCase(); } } }));
  ct.id = 'fd-contact';
  ct.disabled = !!s.busy;
  nodes.push(ct);
  nodes.push(mk('div', 'fd-note', 'ツールの中身は管理画面の報告書・見積書・工事掲示と同じです。保存すると管理者の案件ページにそのまま反映されます。'));
  host.replaceChildren(...nodes);
}

// 「📝 現場への指示（○○さんから）」。指示が無く、知らせてもらってもいなければ出さない
function fdBriefCard(s, c, p) {
  const lines = PhaseLogic.briefLines(p.plan);
  const notified = !!p.notified_at;
  if (!lines.length && !notified) return null;
  const card = mk('div', 'fd-brief');
  card.id = 'fd-brief';
  const from = String(p.notified_by_name || c.assignee_name || '').trim();
  card.appendChild(mk('b', null, '📝 現場への指示' + (from ? '（' + from + 'さんから）' : '')));
  const b = PhaseLogic.normalizeBrief(p.plan);
  const label = (list, keys) => keys.map(k => (list.find(x => x.key === k) || {}).label).filter(Boolean).join('・');
  const head = [];
  if (b.suspects.length) head.push('怪しい箇所: ' + label(PhaseLogic.BRIEF_SUSPECTS, b.suspects));
  if (b.priority.length) head.push('優先: ' + label(PhaseLogic.BRIEF_PRIORITY, b.priority));
  if (head.length) card.appendChild(mk('div', 'fd-brief-head', head.join(' ／ ')));
  if (b.note.trim()) card.appendChild(mk('div', 'fd-brief-text', b.note.trim()));
  if (b.visitNote.trim()) card.appendChild(mk('div', 'fd-brief-text', '当日の注意: ' + b.visitNote.trim()));
  if (!lines.length) card.appendChild(mk('div', 'fd-tiny', '指示の記載はありません'));
  const row = mk('div', 'fd-row');
  if (p.ack_at) {
    const tag = mk('span', 'fd-ack-tag', '✓ 確認済み ' + PhaseLogic.fmtMDHM(p.ack_at) + (p.ack_by_name ? '（' + p.ack_by_name + '）' : ''));
    tag.id = 'fd-ack-tag';
    row.appendChild(tag);
  } else if (notified && p.worker_id && p.worker_id === fdMe()) {
    const ack = dBtn('確認した', 'btn sm ghost inline fd-ack', btn => fdAck(s, c, p, btn));
    ack.id = 'fd-ack';
    ack.disabled = !!s.busy;
    row.appendChild(ack);
  }
  if (row.childNodes.length) card.appendChild(row);
  return card;
}

async function fdAck(s, c, p, btn) {
  if (s.busy) return;
  s.busy = 'ack';
  s.msg = '';
  btn.disabled = true;
  const title = PhaseLogic.fieldPhaseChips(c.phases, new Date()).find(x => x.id === p.id).title;
  let err = '';
  try { await PhasesApi.ack(Object.assign({ case_id: c.id }, p), title); }
  catch (e) { err = '「確認した」にできませんでした: ' + errText(e); }
  s.busy = '';
  if (!fdAlive(s)) return;
  if (err) { s.toolErr = err; fdRenderCase(); return; }
  s.msg = title + 'を「確認した」にしました';
  fieldRowsInvalidate();
  await fdReloadCase(s);
}
async function fdReloadCase(s) {
  try {
    const row = await CasesApi.getSummary(s.caseId);
    if (fdAlive(s) && row) s.data.caseRow = row;
  } catch (e) { if (fdAlive(s)) s.toolErr = '最新の表示に更新できませんでした: ' + errText(e); }
  if (fdAlive(s)) fdRenderCase();
}

function fdToolBtn(s, key, icon, title, state, onClick) {
  const b = dBtn('', 'fd-tool', () => fdRunTool(s, key, onClick));
  b.dataset.tool = key;
  b.dataset.state = state.state;
  b.disabled = !!s.busy;
  b.appendChild(mk('span', 'fd-tool-ic', icon));
  const txt = mk('span', 'fd-tool-t');
  txt.appendChild(mk('b', null, title));
  txt.appendChild(mk('span', 'fd-tool-st', s.busy === key ? '開いています…' : state.text));
  b.appendChild(txt);
  b.appendChild(mk('span', 'fd-tool-go', '›'));
  return b;
}

async function fdRunTool(s, key, fn) {
  if (s.busy) return;
  s.busy = key;
  s.toolErr = '';
  s.msg = '';
  fdRenderCase();
  let err = '';
  try { await fn(); }
  catch (e) { err = ({ report: '報告書', estimate: '見積書', notice: '工事掲示' }[key]) + 'を開けませんでした: ' + errText(e); }
  if (fd !== s) return;
  s.busy = '';
  if (err) s.toolErr = err;
  if (fdAlive(s)) fdRenderCase();
}

const fdTitleOf = (c, p) => PhaseLogic.fieldPhaseChips(c.phases, new Date()).find(x => x.id === p.id).title;

async function fdOpenReport(s, c, p, state) {
  fdSel.set(c.id, p.id);
  if (state.open) { location.hash = '#report/' + state.open.id; return; }
  // Task 23 I4: 作業担当者の初期値 = このフェーズの作業担当者（無ければ自分）
  const row = await ReportsApi.create(c.id, PhaseLogic.reportFields(p, c, { meId: fdMe(), title: fdTitleOf(c, p) }));
  if (fdAlive(s)) location.hash = '#report/' + row.id;
}

async function fdOpenEstimate(s, c, p, phases, state) {
  fdSel.set(c.id, p.id);
  if (state.open) { location.hash = '#estimate/' + state.open.id; return; }
  const opts = { phase_id: p.id, phaseTitle: fdTitleOf(c, p) };
  // 工事の見積は、この案件の調査結果の注意事項を備考の初期値に（フェーズ詳細ページ・やることと同じ）
  if (p.kind !== 'survey') {
    const r = PhaseLogic.latestSurveyResult(phases);
    if (r) opts.noteExtra = PhaseLogic.estimateNoteExtra(r);
  }
  const row = await EstimatesApi.create(c.id, c, opts);
  if (fdAlive(s)) location.hash = '#estimate/' + row.id;
}

async function fdOpenNotice(s, c, p, phases, state) {
  fdSel.set(c.id, p.id);
  if (state.open) { location.hash = '#notice/' + state.open.id; return; }
  if (state.count > 1) { location.hash = '#case/' + c.id + '/notices'; return; }
  // 工事日・調査結果の注意事項を初期値に（フェーズ詳細ページの「📢 工事掲示を作る」と同じ）
  const data = {};
  if (p.scheduled_at) { // phYmd / phHm は phase-ui.js（日本時間の YYYY-MM-DD / HH:MM）
    data.workDate = phYmd(p.scheduled_at);
    data.timeStart = phHm(p.scheduled_at);
    if (p.scheduled_end) {
      if (phYmd(p.scheduled_end) !== data.workDate) data.workDateEnd = phYmd(p.scheduled_end);
      data.timeEnd = phHm(p.scheduled_end);
    }
  }
  if (c.room) data.roomNo = String(c.room);
  const r = PhaseLogic.latestSurveyResult(phases);
  if (r) Object.assign(data, PhaseLogic.noticeInit(r));
  const row = await NoticesApi.create(c.id, c, { phase_id: p.id, phaseTitle: fdTitleOf(c, p), data });
  if (fdAlive(s)) location.hash = '#notice/' + row.id;
}

/* ---------- #f/settings ---------- */
function fdRenderSettings() {
  const host = $('field-root');
  const nodes = [];
  const me = mk('div', 'fd-card fd-set');
  me.id = 'fd-set-me';
  me.appendChild(mk('b', 'fd-place', ((ctx.membership && ctx.membership.display_name) || '(名前なし)') + '（' + (fdIsOwner() ? '管理者' : 'スタッフ') + '）'));
  me.appendChild(mk('span', 'fd-tiny', (ctx.org && ctx.org.name) || ''));
  nodes.push(me);
  if (fdIsOwner()) nodes.push(fieldViewCard('fd-set-view'));
  // ホーム画面に追加の手順
  const add = mk('div', 'fd-card fd-set');
  add.id = 'fd-set-home';
  add.appendChild(mk('b', null, 'ホーム画面に追加'));
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  if (standalone) add.appendChild(mk('span', 'fd-tiny', 'ホーム画面のアイコンから開いています。'));
  add.appendChild(mk('span', 'fd-tiny', 'ほかのアプリと同じように、ホーム画面のアイコンから開けるようになります（全画面で開き、アドレスバーは出ません）。'));
  const steps = (title, list) => {
    const box = mk('div', 'fd-steps');
    box.appendChild(mk('b', null, title));
    const ol = mk('ol');
    list.forEach(t => ol.appendChild(mk('li', null, t)));
    box.appendChild(ol);
    return box;
  };
  add.appendChild(steps('iPhone（Safari）', ['このページを Safari で開く', '下の共有ボタン（四角から上向きの矢印）を押す', '「ホーム画面に追加」を押す', '右上の「追加」を押す']));
  add.appendChild(steps('Android（Chrome）', ['このページを Chrome で開く', '右上の「︙」（メニュー）を押す', '「ホーム画面に追加」（または「アプリをインストール」）を押す', '「追加」を押す']));
  nodes.push(add);
  const out = dBtn('ログアウト', 'btn ghost fd-logout', () => signOutUser());
  out.id = 'fd-logout';
  nodes.push(out);
  host.replaceChildren(...nodes);
}

// 「画面: 現場用／管理画面」（管理者だけ。現場用の設定と管理画面の設定の両方に出す）
function fieldViewCard(id) {
  const card = mk('div', id === 'fd-set-view' ? 'fd-card fd-set' : 'card');
  card.id = id;
  const field = isFieldMode();
  const row = mk('div', 'fd-row');
  row.appendChild(mk('b', id === 'fd-set-view' ? null : 'card-ttl', '画面'));
  row.appendChild(mk('span', 'fd-sp'));
  const chip = (label, v, on) => {
    const b = dBtn(label, 'fd-chip' + (on ? ' on' : ''), () => {
      if (on) return;
      setFieldViewPref(v);
      const to = v === 'field' ? '#f' : '';
      if (location.hash === to || (!to && (!location.hash || location.hash === '#'))) routeFromHash();
      else location.hash = to; // → hashchange → routeFromHash（fieldRoute が画面を決める）
    });
    b.dataset.view = v;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    return b;
  };
  row.appendChild(chip('現場用', 'field', field));
  row.appendChild(chip('管理画面', 'admin', !field));
  card.appendChild(row);
  card.appendChild(mk('span', 'fd-tiny', '管理者は管理画面が最初に開きます。現場用にすると、この端末では現場用の画面が最初に開きます（スタッフは現場用だけです）'));
  return card;
}
