// js/field-ui.js — 現場担当アプリ（スマホ専用の現場用画面。対応フェーズ Task 18。画面案 docs/mocks/mock-field.html）
// ルート（Task 29）: #f（案件 = 本日行く現場・対応の一覧）／#f/case/{id}（ツールページ）／#f/tasks（タスク = 優先順の一覧。旧 🔔）／
//   #f/daily（日報作成）／#f/settings（設定）／#f/contact（管理者とのやり取り。タブには出さない＝タスクとツールページのボタンから）。
// 下のタブバー 案件／タスク／日報作成／設定（safe-area）。旧ルート #f/inbox は #f/tasks、#f/outbox は #f/contact へ。
// 現場用では送付・連絡メールの下書きは出さない（Task 23 C2）
// 入口（fieldRoute: app.js の routeFromHash の最初に呼ぶ）:
//   スタッフ（memberships.role = 'member'）は現場用の画面だけ。管理画面のルートを開いても現場用に戻す
//     （#case/{id}…（フェーズ詳細・協力業者URLを含む）→ #f/case/{id}、#inbox-staff → #f/tasks、#outbox・#messages → #f/contact、それ以外 → #f）。
//   管理者（owner）は管理画面が既定。設定の「画面: 現場用／管理画面」で切替（この端末の localStorage に人ごとに記憶）。
//     現場用にしている管理者は、空のルートで #f が開く（管理画面のリンクを開いたときはそのまま管理画面）。
//     管理画面にしている管理者が #f… を開いたら管理画面へ（#f/case/{id} → #case/{id}）。
//   報告書・見積書・工事掲示・送付メールの画面（共通）は現場用からも開ける。そのとき body に fd-mode を付け、
//     ヘッダーの 💴（請求）を隠し、⚙️ は現場用の設定へ、戻るは「‹ ツール」（#f/case/{id}）にする（fieldBack）。
// 「案件」タブ（Task 29）: 自分が作業担当者（または案件の担当者）のフェーズを 今日（時刻順）→ 明日以降（日付順）→ 日時未定 →
//   日時を過ぎて自分の番が残っているもの → 対応なし（PhaseLogic.fieldSchedule）。各行: 時刻・物件名 号室・フェーズ・対応状況・住所（地図）・
//   入居者の電話（Task 28 の遅れ報告の決まり）。押すとその対応を選んだツールページ。上に「✅ タスク n件」（期限超過があれば赤）
//   （Task 27 の「🧾 見積書を提出」のカードはタスクの ③ に移した）
// 「タスク」タブ: js/staff-inbox.js の openStaffInbox({ field: true })。「日報作成」タブ: この下の fdRenderDaily
// アプリを開いたとき（案件・タスク・日報の読み込み）に、報告書の期限超過を管理者に知らせる（overdueSync。js/staff-messages.js）
// ツールページ: 住所（Googleマップ）・入居者の電話・対応の切替チップ（今日の予定の対応が初期選択。無ければ最新）・
//   「📝 現場への指示（○○さんから）」と「確認した」（既存の ack。担当者本人・知らせてもらった後だけ）・
//   3つの大きなツールボタン（①報告書 ②見積書 ③工事掲示。状態は PhaseLogic.fieldTools）。押すと phase_id 付きで作る／開く。
// Task 28: ツールページに「依頼内容」（文章・症状・被害箇所・怪しい箇所・写真のサムネイル → 拡大）と「関係する部屋」（号室・役割・居住者）を指示の上に。
//   入居者の電話は既定で出さない。「🕒 到着が遅れそう」（一覧のカード・ツールページ）でシート → 報告（PhasesApi.reportLate = rpc phase_report_late）
//   すると、そのフェーズでは入居者の電話（tel:）が出る（case_summaries.phases[].late_at）。管理者の画面では今までどおり常に出す
// DB は migration 052・053（スタッフも API では会社の全案件を読める。画面で絞るだけ）
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。alert/confirm は使わない
// mk() は case-list.js、dBtn / errText は case-detail.js、openStaffInbox / makePhaseEstimate は staff-inbox.js、openFieldContact / smOpenSheet は staff-messages.js、
// $ / showScreen / renderHeaders / withBusy は app.js

const FD_UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const FD_CASE_RE = new RegExp('^#f/case/' + FD_UUID + '$', 'i');
const FD_TABS = [
  { view: 'cases', hash: '#f', icon: '📋', label: '案件' },
  { view: 'tasks', hash: '#f/tasks', icon: '✅', label: 'タスク' },
  { view: 'daily', hash: '#f/daily', icon: '📝', label: '日報作成' },
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
  if (h === '#f/tasks' || h === '#f/inbox') return { view: 'tasks' }; // Task 29: 確認（🔔）→ タスク
  if (h === '#f/daily') return { view: 'daily' };
  if (h === '#f/contact' || h === '#f/outbox') return { view: 'contact' }; // Task 23: 送るメール → 管理者に連絡（Task 29: タブには出さない）
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
  if (h === '#inbox-staff') return '#f/tasks';
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
  if (fm.view === 'tasks') {
    if (location.hash === '#f/inbox') fdReplace('#f/tasks');
    fdBar('タスク');
    return openStaffInbox({ field: true, root: host });
  }
  if (fm.view === 'daily') { fdBar('日報作成'); fdRenderDaily(); return fdLoadDaily(seq); }
  if (fm.view === 'contact') {
    if (location.hash === '#f/outbox') fdReplace('#f/contact');
    fdBar('管理者とのやり取り', '‹ タスク', '#f/tasks');
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
  const active = fd && fd.view === 'case' ? 'cases' : fd && fd.view === 'contact' ? 'tasks' : fd && fd.view;
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

/* ---------- #f 案件（本日行く現場・対応の一覧。Task 29） ---------- */
async function fdLoadCases(seq) {
  let rows = [], err = '', msgs = [];
  try {
    rows = await fieldRows();
    msgs = await fdUnreadMessages(); // 管理者からの未読の連絡（タスクの件数に入れる）
  } catch (e) { err = '案件を読み込めませんでした: ' + errText(e); }
  if (!fd || fd.seq !== seq) return;
  Object.assign(fd, { rows, msgs, loading: false, err });
  fdRenderCases();
  if (err) return;
  // 報告書の期限超過を管理者に知らせる（自分の担当の案件の分。1回だけ＝DB が判定。Task 29）
  try { if (await overdueSync(rows.filter(r => PhaseLogic.fieldMine(r, fdMe())))) fieldRowsInvalidate(); } catch (e) { console.warn('期限超過の確認に失敗', e); }
  // 時刻を過ぎたリマインド（お客様向け・担当者向けの前日のお知らせ）の下書きを作る（管理画面の案件一覧と同じ。サーバーの定期実行は使わない）
  if (typeof outboxSync === 'function') {
    // 自分の担当の案件の分だけ（Task 23 I13。現場用ではメールの一覧は出さない）
    try { await outboxSync(rows.filter(r => PhaseLogic.fieldMine(r, fdMe()))); } catch (e) { console.warn('リマインドの確認に失敗', e); }
  }
}
// 自分あての未読の連絡（管理者からの返事・催促・日報への返事）
async function fdUnreadMessages() {
  return (await StaffMessagesApi.list({ toUser: fdMe(), unread: true })) || [];
}

const FD_GROUP_LABEL = { today: '今日', later: '明日以降', tbd: '日時未定', past: '日時を過ぎた対応（まだ自分の番）', none: '対応がまだ無い案件' };
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
    // タスクの件数（期限超過があれば赤）→ タスクのタブへ
    const tasks = PhaseLogic.staffInbox(s.rows, fdMe(), now, { messages: s.msgs });
    if (tasks.length) {
      const late = tasks.filter(x => x.late).length;
      const b = dBtn('', 'fd-bell' + (late ? ' late' : ''), () => { location.hash = '#f/tasks'; });
      b.id = 'fd-bell';
      b.appendChild(mk('b', null, '✅ タスク ' + tasks.length + '件' + (late ? '（期限超過 ' + late + '件）' : '')));
      b.appendChild(mk('span', 'fd-tiny', '見る ›'));
      nodes.push(b);
    }
    const list = PhaseLogic.fieldSchedule(s.rows, fdMe(), now);
    const todayN = list.filter(x => x.group === 'today').length;
    const h = mk('div', 'fd-h', '本日行く現場・対応 ' + todayN + '件');
    h.id = 'fd-count';
    nodes.push(h);
    if (!list.length) {
      const e = mk('div', 'empty', '担当の案件はありません');
      e.id = 'fd-empty';
      nodes.push(e);
    }
    const wrap = mk('div', 'fd-list');
    wrap.id = 'fd-list';
    if (list.length && !todayN) {
      const e = mk('div', 'fd-tiny fd-no-today', '今日の予定はありません');
      e.id = 'fd-no-today';
      wrap.appendChild(e);
    }
    let group = '';
    list.forEach(it => {
      if (it.group !== group) {
        group = it.group;
        const gh = mk('div', 'fd-gh' + (group === 'today' ? ' today' : ''), FD_GROUP_LABEL[group]);
        gh.dataset.group = group;
        wrap.appendChild(gh);
      }
      wrap.appendChild(fdCaseCard(it));
    });
    nodes.push(wrap);
  }
  host.replaceChildren(...nodes);
}

function fdKindBadge(kind) {
  return mk('span', 'ph-kind k-' + kind, PhaseLogic.kindLabel(kind));
}
function fdBallClass(st) { return st && st.ball === 'us' ? ' us' : st && st.ball === 'them' ? ' them' : ''; }

// 1行（1つの対応）: 時刻・物件名 号室・フェーズ・対応状況 → 押すとその対応を選んだツールページ。住所（地図）と入居者の電話は下に
function fdCaseCard(it) {
  const c = it.caseRow;
  const p = it.phase;
  const late = !!(it.stage && it.stage.late);
  const card = mk('div', 'fd-card' + (it.today ? ' today' : '') + (late ? ' late' : ''));
  card.dataset.caseId = c.id;
  if (p) card.dataset.phaseId = p.id;
  card.dataset.group = it.group;
  const main = dBtn('', 'fd-card-main', () => { if (p) fdSel.set(c.id, p.id); location.hash = '#f/case/' + c.id; });
  const top = mk('div', 'fd-row');
  top.appendChild(mk('b', 'fd-when', it.group === 'today' ? it.time : it.group === 'none' ? '対応なし' : it.when));
  if (p) top.appendChild(fdKindBadge(p.kind));
  if (p) top.appendChild(mk('span', 'fd-tiny fd-ph-title', it.title.replace(PhaseLogic.kindLabel(p.kind), '').trim()));
  main.appendChild(top);
  main.appendChild(mk('span', 'fd-place', PhaseLogic.placeName(c) || '（物件名なし）'));
  if (it.stageText) main.appendChild(mk('span', 'fd-stage' + fdBallClass(it.stage) + (late ? ' late' : ''), it.stageText));
  card.appendChild(main);
  if (c.address) {
    const a = mk('a', 'fd-tiny fd-addr fd-map', '📍 ' + c.address + '（地図）');
    a.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(c.address);
    a.target = '_blank';
    a.rel = 'noopener';
    card.appendChild(a);
  }
  // 入居者の電話（到着が遅れその報告の後だけ）は今日の対応だけに出す（ほかの日はツールページで）
  if (p && it.group === 'today') card.appendChild(fdLateBox(c, p, () => { fieldRowsInvalidate(); if (fd && fd.view === 'cases') openField({ view: 'cases' }); }));
  return card;
}
// 入居者の電話（Task 28）: そのフェーズで「到着が遅れそう」を報告していれば tel: の一覧、まだなら「🕒 到着が遅れそう」のボタン
function fdLateBox(c, p, onDone) {
  const late = PhaseLogic.residentTelOpen(p);
  const box = RequestView.residentsBox({
    residents: PhaseLogic.caseResidents(c), late,
    lateText: late ? PhaseLogic.fmtMDHM(p.late_at) : '',
    disabled: !!(fd && fd.busy),
    onLate: () => RequestView.openLateSheet({
      title: (PhaseLogic.placeName(c) || '（物件名なし）') + ' ・ ' + fdTitleOf(c, p),
      onSubmit: (minutes, note) => PhasesApi.reportLate(p.id, minutes, note),
      onDone
    })
  });
  box.dataset.phaseId = p.id;
  box.classList.add('fd-late');
  return box;
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
  let shares = [];
  if (!err && res[1] && res[1].length) {
    // 担当者URL（使えるか = share_active。Task 26: ツールページには URL の欄を出さない。遅延作成の判定に使う）
    try {
      shares = (await ReportsApi.listSharesByReports(res[1].map(r => r.id))) || [];
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
    else s.data = { caseRow: res[0], reports: res[1] || [], estimates: (res[2] || []).flatMap(x => x.versions || []), notices: res[3] || [], shares };
  }
  // Task 25: 選んだ対応に報告書・担当者URLが無ければ作る（既存のフェーズの遅延作成。1回だけ）
  if (!s.ensured) s.ensured = new Set();
  const sel = !s.err && s.data ? fdSelected(s) : null;
  if (sel && !s.ensured.has(sel.id)) {
    s.ensured.add(sel.id);
    try {
      const own = s.data.reports.filter(r => r.phase_id === sel.id);
      const r = await ReportsApi.ensurePhaseReport(Object.assign({ case_id: s.caseId }, sel), s.data.caseRow,
        { reports: own, shares: shares.filter(sh => own.some(x => x.id === sh.report_id)), title: fdTitleOf(s.data.caseRow, sel) });
      if (r && r.made && fd && fd.seq === seq) return fdLoadCase(seq);
    } catch (e) { console.warn('報告書と担当者URLを用意できませんでした', e); }
    if (!fd || fd.seq !== seq) return;
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
  const phases = Array.isArray(c.phases) ? c.phases : [];
  const sel0 = phases.length ? fdSelected(s) : null;
  if (sel0) {
    const lb = fdLateBox(c, sel0, () => { fieldRowsInvalidate(); if (fdAlive(s)) { s.msg = '到着の遅れを管理者に報告しました'; fdReloadCase(s); } });
    lb.id = 'fd-late';
    info.appendChild(lb);
  }
  if (info.childNodes.length) nodes.push(info);
  // Task 30: ① 住所・入居者 → ② 依頼内容 → ③ 関係する部屋 → ④ 現場への指示 → ⑤ 対応の切替・今の段階 → ⑥ ツール
  const req = RequestView.build(c.request, { photoUrl: p => CasesApi.requestPhotoUrl(p), title: '📋 依頼内容', id: 'fd-request', cls: 'fd-req' });
  if (req) nodes.push(req);
  else {
    const e = mk('div', 'fd-req-empty', '📋 依頼内容はまだ登録されていません');
    e.id = 'fd-request-empty';
    nodes.push(e);
  }
  const rooms = fdRoomsCard(c);
  if (rooms) nodes.push(rooms);
  if (!phases.length) {
    const e = mk('div', 'empty', 'この案件にはまだ対応（調査・工事）がありません。管理者に登録してもらってください');
    e.id = 'fd-no-phase';
    nodes.push(e);
    host.replaceChildren(...nodes);
    return;
  }
  const sel = fdSelected(s);
  const brief = fdBriefCard(s, c, sel);
  if (brief) nodes.push(brief);
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
      // Task 25: まだ用意していない対応なら、報告書・担当者URLを確かめてから描く
      fdRenderCase();
      if (!s.ensured || !s.ensured.has(ch.id)) fdLoadCase(s.seq); // 読み直して描き直す（その間も今の画面のまま）
    });
    b.dataset.phaseId = ch.id;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    chips.appendChild(b);
  });
  nodes.push(chips);
  const st = PhaseLogic.stage(sel, null, new Date(), { me: fdMe() });
  const stText = PhaseLogic.fieldStageLabel(st) || (st.label ? '✓ ' + st.label : '');
  if (stText) {
    const sl = mk('div', 'fd-stage-line' + fdBallClass(st), '今: ' + stText);
    sl.id = 'fd-stage-line';
    nodes.push(sl);
  }
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
    onSent: () => { if (fdAlive(s)) { s.msg = '管理者に連絡しました（返事は「タスク」に出ます）'; fdRenderCase(); } } }));
  ct.id = 'fd-contact';
  ct.disabled = !!s.busy;
  nodes.push(ct);
  nodes.push(mk('div', 'fd-note', 'ツールの中身は管理画面の報告書・見積書・工事掲示と同じです。保存すると管理者の案件ページにそのまま反映されます。'));
  host.replaceChildren(...nodes);
}

// 「🏠 関係する部屋」（Task 28）: この案件の部屋＋関係する部屋の 号室・役割・居住者（電話は出さない＝到着が遅れそうの報告の後に上の欄で）
function fdRoomsCard(c) {
  const list = PhaseLogic.planRoomChoices(c);
  if (!list.length) return null;
  const card = mk('div', 'fd-rooms');
  card.id = 'fd-rooms';
  card.appendChild(mk('b', null, '🏠 関係する部屋'));
  const rs = Array.isArray(c.rooms) ? c.rooms : [];
  list.forEach(x => {
    const row = mk('div', 'fd-room');
    row.dataset.room = x.room;
    row.appendChild(mk('span', 'rm-tag ' + (x.role || 'other'), PhaseLogic.roomRoleLabel(x.role)));
    row.appendChild(mk('b', null, PhaseLogic.roomLabel(x.room) || x.room));
    if (x.own) row.appendChild(mk('span', 'fd-tiny', 'この案件の部屋'));
    const r = x.own ? null : rs.find(y => String(y.room || '').trim() === x.room);
    const name = String(x.own ? c.resident_name || '' : (r && r.resident_name) || '').trim();
    if (name) row.appendChild(mk('span', 'fd-tiny', '居住者 ' + name + '様'));
    card.appendChild(row);
  });
  return card;
}

// 「📝 現場への指示（○○さんから）」。指示が無く、知らせてもらってもいなければ出さない
//   Task 25: 号室ごとに ■ 402号室（加害部屋） 怪しい箇所: … 指示: … 補足: …（PhaseLogic.briefLines と同じ文）
function fdBriefCard(s, c, p) {
  const lines = PhaseLogic.briefLines(p.plan);
  const notified = !!p.notified_at;
  if (!lines.length && !notified) return null;
  const card = mk('div', 'fd-brief');
  card.id = 'fd-brief';
  const from = String(p.notified_by_name || c.assignee_name || '').trim();
  card.appendChild(mk('b', null, '📝 現場への指示' + (from ? '（' + from + 'さんから）' : '')));
  let block = null;
  lines.forEach(l => {
    if (!l) { block = null; return; }
    if (/^■ /.test(l)) {
      block = mk('div', 'fd-brief-room');
      block.appendChild(mk('div', 'fd-brief-head', l.slice(2)));
      card.appendChild(block);
      return;
    }
    (block || card).appendChild(mk('div', 'fd-brief-text', l));
  });
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

/* ---------- #f/daily 日報作成（Task 29） ---------- */
// その日の対応を管理者に送る。自動で埋まる: 今日行った現場・提出した報告書・提出した見積・遅れ報告（PhaseLogic.dailyReport）。
// 手で足す: 一言・写真（任意）。「送る」→ rpc staff_daily_send（件名「日報 M/D（名前）」・管理者の「📨 現場からの連絡」に出る）。
// 当日は直して「送り直す」（同じ1件を差し替えて管理者の未読に戻す）。送った日報と管理者からの返事は下に履歴として残る
const FD_DAILY_NOTE_HEAD = '\n■ 一言\n';
async function fdLoadDaily(seq) {
  let rows = [], list = [], err = '';
  try {
    [rows, list] = await Promise.all([fieldRows(), StaffMessagesApi.list({ noCase: true, limit: 300 })]);
  } catch (e) { err = '日報を読み込めませんでした: ' + errText(e); }
  if (!fd || fd.seq !== seq) return;
  const me = fdMe();
  const mine = (list || []).filter(m => m.source === 'daily' && m.from_user === me);
  const ids = new Set(mine.map(m => m.id));
  const replies = (list || []).filter(m => m.reply_to && ids.has(m.reply_to));
  const today = PhaseLogic.jstYmd(new Date());
  const d0 = mine.find(m => m.daily_date === today) || null;
  const prev = fd.daily || {};
  fd.daily = { rows: rows || [], mine, replies, today: d0, files: prev.files || [],
    keep: prev.keepTouched ? prev.keep : (d0 && Array.isArray(d0.attachments) ? d0.attachments.slice() : []), keepTouched: !!prev.keepTouched,
    note: prev.noteTouched ? prev.note : fdDailyNoteOf(d0), noteTouched: !!prev.noteTouched, busy: false, err: '', msg: prev.msg || '' };
  Object.assign(fd, { rows: rows || [], loading: false, err });
  fdRenderDaily();
  if (!err) {
    try { if (await overdueSync((rows || []).filter(r => PhaseLogic.fieldMine(r, me)))) fieldRowsInvalidate(); } catch (e) { console.warn('期限超過の確認に失敗', e); }
  }
}
// 送った日報の本文から「一言」を取り出す（送り直すときの初期値）
function fdDailyNoteOf(m) {
  const b = String((m && m.body) || '');
  const i = b.indexOf(FD_DAILY_NOTE_HEAD);
  return i >= 0 ? b.slice(i + FD_DAILY_NOTE_HEAD.length) : '';
}

function fdRenderDaily() {
  const s = fd;
  const host = $('field-root');
  if (s.loading) { host.replaceChildren(mk('div', 'empty', '読み込み中…')); return; }
  if (s.err) {
    host.replaceChildren(mk('div', 'err', s.err), dBtn('再読み込み', 'btn sm ghost inline', () => openField({ view: 'daily' })));
    return;
  }
  const d = s.daily;
  const nodes = [];
  const auto = PhaseLogic.dailyReport(d.rows, fdMe(), new Date());
  const name = (ctx.membership && ctx.membership.display_name) || '';
  const card = mk('div', 'fd-card fd-daily');
  card.id = 'fd-daily';
  const head = mk('div', 'fd-row');
  head.appendChild(mk('b', 'fd-place', PhaseLogic.dailySubject(auto.ymd, name)));
  card.appendChild(head);
  card.appendChild(mk('span', 'fd-tiny', '下の4つは自動で入ります。一言と写真を足して「送る」を押すと、管理者の「📨 現場からの連絡」に届きます'));
  PhaseLogic.DAILY_SECTIONS.forEach(([k, label]) => {
    const sec = mk('div', 'fd-daily-sec');
    sec.dataset.sec = k;
    sec.appendChild(mk('b', null, '■ ' + label));
    const items = auto[k];
    if (!items.length) sec.appendChild(mk('div', 'fd-tiny fd-daily-none', 'なし'));
    items.forEach(x => sec.appendChild(mk('div', 'fd-daily-item', '・' + x.text)));
    card.appendChild(sec);
  });
  // 一言
  const ta = document.createElement('textarea');
  ta.id = 'fd-daily-note';
  ta.rows = 4;
  ta.maxLength = 1000;
  ta.placeholder = '例: 明日は 10 時から A マンションの続きに行きます';
  ta.value = d.note || '';
  ta.disabled = d.busy;
  ta.addEventListener('input', () => { d.note = ta.value; d.noteTouched = true; });
  const lt = mk('label', 'sm-f fd-daily-f', '一言（任意）');
  lt.appendChild(ta);
  card.appendChild(lt);
  // 写真（任意）
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/*';
  file.multiple = true;
  file.id = 'fd-daily-file';
  file.className = 'sr-only';
  const pick = dBtn('📷 写真を添付', 'btn sm ghost inline fd-daily-pick', () => file.click());
  pick.disabled = d.busy;
  const count = d.keep.length + d.files.length;
  const picked = mk('span', 'rep-sub fd-daily-picked', count ? '写真 ' + count + '枚' + (d.keep.length ? '（送った写真 ' + d.keep.length + '枚を含む）' : '') : '写真なし');
  const clear = dBtn('写真を外す', 'linkbtn fd-daily-clear', () => { d.files = []; d.keep = []; d.keepTouched = true; fdRenderDaily(); });
  clear.hidden = !count;
  clear.disabled = d.busy;
  file.addEventListener('change', () => {
    d.files = d.files.concat(Array.from(file.files || [])).slice(0, Math.max(0, StaffMessagesApi.FILES_MAX - d.keep.length));
    file.value = '';
    fdRenderDaily();
  });
  const pr = mk('div', 'sm-filerow');
  pr.append(pick, picked, clear, file);
  card.appendChild(pr);
  if (d.today) {
    const st = mk('div', 'fd-daily-sent', '✓ 今日の日報は送りました（' + PhaseLogic.fmtMDHM(d.today.created_at) + '・' + (d.today.read_at ? '既読' : '未読') + '）。直して「送り直す」を押すと、管理者の画面で未読に戻ります');
    st.id = 'fd-daily-sent';
    card.appendChild(st);
  }
  const send = dBtn(d.busy ? '送っています…' : d.today ? '送り直す' : '送る', 'btn fd-daily-send', () => fdSendDaily(s, auto));
  send.id = 'fd-daily-send';
  send.disabled = d.busy;
  card.appendChild(send);
  const err = mk('div', 'err', d.err || '');
  err.id = 'fd-daily-err';
  err.setAttribute('role', 'alert');
  card.appendChild(err);
  const msg = mk('div', 'ob-msg', d.msg || '');
  msg.id = 'fd-daily-msg';
  msg.setAttribute('role', 'status');
  card.appendChild(msg);
  nodes.push(card);
  // 履歴（送った日報と管理者からの返事）
  nodes.push(mk('div', 'fd-h', '送った日報 ' + d.mine.length + '件'));
  const hist = mk('div', 'fd-list');
  hist.id = 'fd-daily-hist';
  if (!d.mine.length) hist.appendChild(mk('div', 'empty', 'まだ送った日報はありません'));
  d.mine.forEach(m => {
    const box = mk('div', 'fd-card fd-daily-h');
    box.dataset.msgId = m.id;
    const top = mk('div', 'fd-row');
    top.appendChild(mk('b', null, m.subject));
    top.appendChild(mk('span', 'fd-tiny', PhaseLogic.fmtMDHM(m.created_at) + ' ・ ' + (m.read_at ? '既読' : '未読')));
    box.appendChild(top);
    const body = mk('div', 'fd-daily-body', m.body);
    box.appendChild(body);
    const atts = Array.isArray(m.attachments) ? m.attachments : [];
    if (atts.length) box.appendChild(mk('span', 'fd-tiny', '写真 ' + atts.length + '枚'));
    d.replies.filter(r => r.reply_to === m.id).forEach(r => {
      const rp = mk('div', 'fd-daily-reply');
      rp.appendChild(mk('b', null, '管理者から（' + PhaseLogic.fmtMDHM(r.created_at) + '）'));
      rp.appendChild(mk('div', null, r.body));
      box.appendChild(rp);
    });
    hist.appendChild(box);
  });
  nodes.push(hist);
  host.replaceChildren(...nodes);
}

async function fdSendDaily(s, auto) {
  const d = s.daily;
  if (!d || d.busy) return;
  d.busy = true;
  d.err = '';
  d.msg = '';
  fdRenderDaily();
  let row = null, err = '';
  try {
    row = await StaffMessagesApi.sendDaily({ body: PhaseLogic.dailyBody(auto, d.note), keep: d.keep, files: d.files });
  } catch (e) { err = '日報を送れませんでした: ' + errText(e); }
  if (fd !== s || !s.daily) return;
  d.busy = false;
  if (err) { d.err = err; fdRenderDaily(); return; }
  Object.assign(d, { files: [], keepTouched: false, noteTouched: false,
    msg: (row && row.resent ? '日報を送り直しました' : '日報を送りました') + '（管理者の「📨 現場からの連絡」に出ます）' });
  await fdLoadDaily(s.seq);
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
