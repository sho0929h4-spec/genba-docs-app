// js/field-ui.js — 現場担当アプリ（スマホ専用の現場用画面。対応フェーズ Task 18。画面案 docs/mocks/mock-field.html）
// ルート（Task 29）: #f（案件 = 本日行く現場・対応の一覧）／#f/case/{id}（ツールページ）／#f/tasks（タスク = 優先順の一覧。旧 🔔）／
//   #f/daily（日報作成）／#f/settings（設定）／#f/contact（管理者とのやり取り。タブには出さない＝タスクとツールページのボタンから）。
// Task 31: ツールページは管理者から依頼された対応1つだけ #f/case/{id}/phase/{phaseId}（対応の切替チップは無い）。一番下に
//   「過去の対応履歴を参照する ›」→ #f/case/{id}/history（全フェーズを日付順・押すとその対応のツールページ）。古いリンク #f/case/{id} は
//   自分が担当で未完了の直近の対応へ振り向ける（PhaseLogic.fieldRedirectPhase。無ければ履歴）。ツールページの1行目（帯の直下）に
//   「🚪 今回行く部屋: …」（plan.visitRooms）。「管理者に連絡」はタスクのタブだけ。「本日」「明日」は案件タブの見出しだけ（ほかは具体の日付）
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
// Task 31: ツールページは1つの対応（フェーズ）だけ #f/case/{id}/phase/{phaseId}。過去の対応履歴 #f/case/{id}/history
const FD_PHASE_RE = new RegExp('^#f/case/' + FD_UUID + '/phase/' + FD_UUID + '$', 'i');
const FD_HIST_RE = new RegExp('^#f/case/' + FD_UUID + '/history$', 'i');
const fdPhaseHash = (caseId, phaseId) => '#f/case/' + String(caseId).toLowerCase() + '/phase/' + String(phaseId).toLowerCase();
const fdHistHash = caseId => '#f/case/' + String(caseId).toLowerCase() + '/history';
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
const fdSel = new Map(); // 案件ごとに最後に開いた対応（この画面を開いている間だけ覚える。ツールから「‹ ツール」で同じ対応のページに戻る）

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
  const pid = fdSel.get(String(caseId).toLowerCase());
  return { label: '‹ ツール', hash: pid ? fdPhaseHash(caseId, pid) : '#f/case/' + String(caseId).toLowerCase() };
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
  if (m) return { view: 'case', caseId: m[1].toLowerCase(), phaseId: null }; // 古いリンク: 読み込んでから直近の対応へ振り向ける
  const mp = h.match(FD_PHASE_RE);
  if (mp) return { view: 'case', caseId: mp[1].toLowerCase(), phaseId: mp[2].toLowerCase() };
  const mh = h.match(FD_HIST_RE);
  if (mh) return { view: 'history', caseId: mh[1].toLowerCase() };
  return null;
}
// 管理画面のルート → 現場用のルート
function fdRedirectOf(h) {
  const m = h.match(new RegExp('^#case/' + FD_UUID + '(?:/phase/' + FD_UUID + ')?', 'i'));
  if (m) return m[2] ? fdPhaseHash(m[1], m[2]) : '#f/case/' + m[1].toLowerCase(); // フェーズ詳細のリンク → その対応のツールページ
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
    if (fm) fdReplace(fm.view === 'case' || fm.view === 'history' ? '#case/' + fm.caseId + (fm.phaseId ? '/phase/' + fm.phaseId : '') : ''); // 管理画面にしている管理者 → 管理画面
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
  fd = { seq, view: fm.view, caseId: fm.caseId || null, phaseId: fm.phaseId || null, rows: [], loading: true, err: '', data: null, busy: '', msg: '', toolErr: '' };
  fdTabs();
  const host = $('field-root');
  host.replaceChildren();
  document.title = '現場ドキュメント';
  if (fm.view === 'cases') { fdBar('現場ドキュメント'); fdRenderCases(); return fdLoadCases(seq); }
  if (fm.view === 'case') { fdBar('案件', '‹ 案件', '#f'); fdRenderCase(); return fdLoadCase(seq); }
  if (fm.view === 'history') { fdBar('過去の対応履歴', '‹ 案件', '#f'); fdRenderHistory(); return fdLoadCase(seq); }
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
  const active = fd && (fd.view === 'case' || fd.view === 'history') ? 'cases' : fd && fd.view === 'contact' ? 'tasks' : fd && fd.view;
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
      const e = mk('div', 'fd-tiny fd-no-today', '本日（' + PhaseLogic.fmtMDW(now) + '）の予定はありません');
      e.id = 'fd-no-today';
      wrap.appendChild(e);
    }
    let group = '';
    list.forEach(it => {
      if (it.group !== group) {
        group = it.group;
        // Task 31: 見出し「本日（10/21（水））」「明日（10/22（木））」「明日以降」…「日時未定」（「本日」「明日」はここだけ）
        const gh = mk('div', 'fd-gh' + (group === 'today' ? ' today' : ''), PhaseLogic.scheduleGroupLabel(group, now));
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
  // Task 31: 押すとその対応のツールページ（対応が無ければ過去の対応履歴）
  const main = dBtn('', 'fd-card-main', () => { if (p) fdSel.set(c.id, p.id); location.hash = p ? fdPhaseHash(c.id, p.id) : fdHistHash(c.id); });
  const top = mk('div', 'fd-row');
  // 本日・明日の見出しの中は時刻だけ。明日以降・過ぎた対応は日付つき（10/23（金）9:00）
  const when = it.group === 'today' || it.group === 'tomorrow' ? it.time : it.group === 'none' ? '対応なし' : it.when;
  top.appendChild(mk('b', 'fd-when', when));
  if (p) top.appendChild(fdKindBadge(p.kind));
  if (p) top.appendChild(mk('span', 'fd-tiny fd-ph-title', it.title.replace(PhaseLogic.kindLabel(p.kind), '').trim()));
  main.appendChild(top);
  main.appendChild(mk('span', 'fd-place', PhaseLogic.placeName(c) || '（物件名なし）'));
  if (it.visit) main.appendChild(mk('span', 'fd-visit-short', '🚪 ' + it.visit)); // Task 31: 今回行く部屋「101・201号室」
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
  // Task 31: 古いリンク #f/case/{id} → 自分が担当で未完了の直近の対応のページ（無ければ過去の対応履歴）
  if (!s.err && s.data && s.view === 'case' && !s.phaseId) {
    const to = PhaseLogic.fieldRedirectPhase(s.data.caseRow, fdMe(), new Date());
    if (to) { s.phaseId = to.id; fdReplace(fdPhaseHash(s.caseId, to.id)); }
    else { s.view = 'history'; fdReplace(fdHistHash(s.caseId)); fdTabs(); }
  }
  if (s.view === 'history') { fdRenderHistory(); return; }
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

// Task 31: ページの対応（#f/case/{id}/phase/{phaseId}）。この案件に無ければ null
function fdSelected(s) {
  const c = s.data.caseRow;
  const phases = Array.isArray(c.phases) ? c.phases : [];
  const p = phases.find(x => x.id === s.phaseId) || null;
  if (p) fdSel.set(c.id, p.id);
  return p;
}
// 「過去の対応履歴を参照する ›」
function fdHistLink(c) {
  const a = dBtn('過去の対応履歴を参照する ›', 'linkbtn fd-hist-link', () => { location.hash = fdHistHash(c.id); });
  a.id = 'fd-hist-link';
  return a;
}

function fdRenderCase() {
  const s = fd;
  const host = $('field-root');
  if (s.loading) { host.replaceChildren(mk('div', 'empty', '読み込み中…')); return; }
  if (s.err) {
    host.replaceChildren(mk('div', 'err', s.err), dBtn('再読み込み', 'btn sm ghost inline', () => openField({ view: 'case', caseId: s.caseId, phaseId: s.phaseId })));
    return;
  }
  const c = s.data.caseRow;
  const place = PhaseLogic.placeName(c) || '（物件名なし）';
  fdBar(place, '‹ 案件', '#f');
  document.title = place + ' - 現場ドキュメント';
  const sel = fdSelected(s);
  if (!sel) {
    const e = mk('div', 'empty', 'この対応は見つかりません（消された可能性があります）。管理者に確かめてください');
    e.id = 'fd-no-phase';
    host.replaceChildren(e, fdHistLink(c));
    return;
  }
  const nodes = [];
  // Task 31: ⓪ 今回行く部屋（帯の直下・1行目・大きく）→ ① 住所・入居者 → ② 依頼内容 → ③ 関係する部屋 → ④ 現場への指示 →
  //   ⑤ この対応（種類・日時・今の段階）→ ⑥ ツール → 過去の対応履歴へのリンク。対応の切替チップは出さない（このページは管理者から依頼された対応1つ）
  const visit = mk('div', 'fd-visit', '🚪 ' + PhaseLogic.visitLine(sel.plan, c));
  visit.id = 'fd-visit';
  nodes.push(visit);
  // 住所（Googleマップ）・入居者の電話
  const info = mk('div', 'fd-info');
  if (c.address) {
    const a = mk('a', 'fd-map', '📍 ' + c.address + '（Googleマップ）');
    a.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(c.address);
    a.target = '_blank';
    a.rel = 'noopener';
    info.appendChild(a);
  }
  const lb = fdLateBox(c, sel, () => { fieldRowsInvalidate(); if (fdAlive(s)) { s.msg = '到着の遅れを管理者に報告しました'; fdReloadCase(s); } });
  lb.id = 'fd-late';
  info.appendChild(lb);
  nodes.push(info);
  const req = RequestView.build(c.request, { photoUrl: p => CasesApi.requestPhotoUrl(p), title: '📋 依頼内容', id: 'fd-request', cls: 'fd-req' });
  if (req) nodes.push(req);
  else {
    const e = mk('div', 'fd-req-empty', '📋 依頼内容はまだ登録されていません');
    e.id = 'fd-request-empty';
    nodes.push(e);
  }
  const rooms = fdRoomsCard(c);
  if (rooms) nodes.push(rooms);
  const brief = fdBriefCard(s, c, sel);
  if (brief) nodes.push(brief);
  // この対応（種類・何回目・日時）と今の段階
  const ph = mk('div', 'fd-phase-line');
  ph.id = 'fd-phase-line';
  ph.dataset.phaseId = sel.id;
  ph.appendChild(fdKindBadge(sel.kind));
  ph.appendChild(mk('b', null, fdTitleOf(c, sel)));
  ph.appendChild(mk('span', 'fd-tiny', PhaseLogic.fieldWhen(sel.scheduled_at, new Date())));
  nodes.push(ph);
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
  const phases = Array.isArray(c.phases) ? c.phases : [];
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
  // Task 31: 「管理者に連絡」のボタンはここには出さない（タスクのタブにある）
  nodes.push(mk('div', 'fd-note', 'ツールの中身は管理画面の報告書・見積書・工事掲示と同じです。保存すると管理者の案件ページにそのまま反映されます。'));
  nodes.push(fdHistLink(c));
  host.replaceChildren(...nodes);
}

/* ---------- #f/case/{id}/history 過去の対応履歴（Task 31） ---------- */
// この案件の全フェーズを日付順に。各行: 種類・何回目・日時・段階・報告書／見積書／工事掲示の状態。押すとその対応のツールページ
function fdRenderHistory() {
  const s = fd;
  const host = $('field-root');
  if (s.loading) { host.replaceChildren(mk('div', 'empty', '読み込み中…')); return; }
  if (s.err) {
    host.replaceChildren(mk('div', 'err', s.err), dBtn('再読み込み', 'btn sm ghost inline', () => openField({ view: 'history', caseId: s.caseId })));
    return;
  }
  const c = s.data.caseRow;
  const place = PhaseLogic.placeName(c) || '（物件名なし）';
  fdBar(place, '‹ 案件', '#f');
  document.title = '過去の対応履歴 ' + place + ' - 現場ドキュメント';
  const nodes = [mk('div', 'fd-h', '過去の対応履歴')];
  const list = PhaseLogic.fieldHistory(c, s.data, new Date(), fdMe());
  const wrap = mk('div', 'fd-list');
  wrap.id = 'fd-history';
  if (!list.length) {
    const e = mk('div', 'empty', 'この案件にはまだ対応（調査・工事）がありません。管理者に登録してもらってください');
    e.id = 'fd-no-phase';
    wrap.appendChild(e);
  }
  const short = { report: '報告書', estimate: '見積書', notice: '工事掲示' };
  const stateText = x => ({ none: 'なし', draft: '下書き', done: '提出済み' }[x.state] || (x.count ? x.count + '件' : 'なし'));
  list.forEach(h => {
    const card = mk('div', 'fd-card fd-hist' + (h.phase.done_at ? ' done' : ''));
    card.dataset.phaseId = h.phase.id;
    const main = dBtn('', 'fd-card-main', () => { fdSel.set(c.id, h.phase.id); location.hash = fdPhaseHash(c.id, h.phase.id); });
    const top = mk('div', 'fd-row');
    top.appendChild(fdKindBadge(h.phase.kind));
    top.appendChild(mk('b', null, h.title));
    top.appendChild(mk('span', 'fd-tiny', h.when));
    main.appendChild(top);
    if (h.stageText) main.appendChild(mk('span', 'fd-stage' + fdBallClass(h.stage), h.stageText));
    const docs = mk('span', 'fd-tiny fd-hist-docs', ['report', 'estimate', 'notice'].map(k => short[k] + ' ' + stateText(h.tools[k])).join(' ・ '));
    main.appendChild(docs);
    card.appendChild(main);
    wrap.appendChild(card);
  });
  nodes.push(wrap);
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

/* ---------- #f/daily 日報作成（Task 29 → Task 32） ---------- */
// 1画面で上から4区画（DailyLogic.build。すべて既存のデータから自動で転記）: {M/D（曜）}に行った現場と対応報告／処理したタスク／
//   {翌日}に対応するタスク／かかった時間。各行は押して ☑／☐（含める・外す）だけ。時間は報告書の作業開始〜終了があれば自動、
//   無ければチップ（30分〜1日・その他）。移動時間は任意のチップ。合計は自動。文字入力は一言だけ。写真は3枚まで。
// 下に固定の「PDFを見る」（A4 縦1ページのプレビュー。DailyPdf）と「送る」（PDF を Storage に保存して staff_messages（source='daily'）に添付。
//   rpc staff_daily_send・件名「日報 M/D（名前）」・管理者の「📨 現場からの連絡」に出る）。当日は「送った（H:MM）」と出て、直して「送り直す」
//   （同じ1件を差し替えて管理者の未読に戻す。前の PDF と外した写真は消す）。☑ と時間の選択・一言はこの端末に当日分だけ覚える（localStorage）
// 送った日報と管理者からの返事は下に履歴として残る（PDF を開ける）
const fdDailyKey = ymd => 'genba-docs.daily.' + (fdMe() || '') + '.' + ymd;
function fdDailyDraftGet(ymd) {
  try { const v = JSON.parse(localStorage.getItem(fdDailyKey(ymd)) || 'null'); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
}
function fdDailyDraftSet(d) {
  try { localStorage.setItem(fdDailyKey(d.model.ymd), JSON.stringify({ sel: d.sel, note: d.noteTouched ? d.note : null })); } catch (e) { /* 覚えられない端末ではこの画面の間だけ */ }
}
async function fdLoadDaily(seq) {
  let rows = [], list = [], sent = [], times = [], notices = [], err = '';
  const me = fdMe();
  const now = new Date();
  const ymd = PhaseLogic.jstYmd(now);
  const dayStart = PhaseLogic.jstAt(+ymd.slice(0, 4), +ymd.slice(5, 7), +ymd.slice(8, 10), 0, 0).toISOString();
  try {
    [rows, list, sent, notices] = await Promise.all([fieldRows(), StaffMessagesApi.list({ noCase: true, limit: 300 }),
      StaffMessagesApi.list({ fromUser: me, limit: 200 }), NoticesApi.listMineSince(dayStart)]);
    const pre = DailyLogic.build({ rows, me, now });
    times = await ReportsApi.timesForPhases(pre.times.map(t => t.phaseId));
  } catch (e) { err = '日報を読み込めませんでした: ' + errText(e); }
  if (!fd || fd.seq !== seq) return;
  const mine = (list || []).filter(m => m.source === 'daily' && m.from_user === me);
  const ids = new Set(mine.map(m => m.id));
  const replies = (list || []).filter(m => m.reply_to && ids.has(m.reply_to));
  const model = DailyLogic.build({ rows: rows || [], me, now, times, notices, messages: sent });
  const d0 = mine.find(m => m.daily_date === model.ymd) || null;
  const prev = fd.daily && fd.daily.model && fd.daily.model.ymd === model.ymd ? fd.daily : null;
  const draft = fdDailyDraftGet(model.ymd) || {};
  const sel = prev ? prev.sel : Object.assign({ off: {}, chip: {}, other: {}, travel: null }, draft.sel || {});
  const keepOf = m => (m && Array.isArray(m.attachments) ? m.attachments.filter(a => !StaffMessagesApi.isPdf(a)) : []);
  const noteDraft = typeof draft.note === 'string' ? draft.note : null;
  fd.daily = { model, rows: rows || [], mine, replies, today: d0, sel,
    photos: prev ? prev.photos : [], keep: prev && prev.keepTouched ? prev.keep : keepOf(d0).slice(0, DailyLogic.PHOTOS_MAX), keepTouched: !!(prev && prev.keepTouched),
    note: prev && prev.noteTouched ? prev.note : noteDraft != null ? noteDraft : DailyLogic.noteOf(d0 && d0.body),
    noteTouched: !!(prev && prev.noteTouched) || noteDraft != null, busy: '', err: '', msg: prev ? prev.msg : '', pdf: null };
  Object.assign(fd, { rows: rows || [], loading: false, err });
  fdRenderDaily();
  if (!err) {
    try { if (await overdueSync((rows || []).filter(r => PhaseLogic.fieldMine(r, me)))) fieldRowsInvalidate(); } catch (e) { console.warn('期限超過の確認に失敗', e); }
  }
}

const fdDailyName = () => (ctx.membership && ctx.membership.display_name) || '';
const fdDailyView = d => DailyLogic.view(d.model, d.sel, { name: fdDailyName(), org: (ctx.org && ctx.org.name) || '', note: d.note });
// ☑／☐ の行（44px・押すだけ）
function fdDailyRow(d, item, extra) {
  const on = !(d.sel.off && d.sel.off[item.key]);
  const b = mk('button', 'dl-row' + (on ? ' on' : ''));
  b.type = 'button';
  b.dataset.key = item.key;
  b.setAttribute('role', 'checkbox');
  b.setAttribute('aria-checked', on ? 'true' : 'false');
  b.disabled = !!d.busy;
  b.appendChild(mk('span', 'dl-ck', on ? '☑' : '☐'));
  const txt = mk('span', 'dl-txt');
  txt.appendChild(mk('b', null, item.text || item.label));
  (item.sub || []).forEach(x => txt.appendChild(mk('span', 'dl-sub', x)));
  if (extra) txt.appendChild(mk('span', 'dl-val', extra));
  b.appendChild(txt);
  b.addEventListener('click', () => {
    d.sel.off = Object.assign({}, d.sel.off, { [item.key]: on });
    if (!on) delete d.sel.off[item.key];
    fdDailyChanged(d, item.key);
  });
  return b;
}
function fdDailyChanged(d, focusKey) {
  d.pdf = null;
  fdDailyDraftSet(d);
  fdRenderDaily();
  if (focusKey) {
    const t = Array.from(document.querySelectorAll('#fd-daily [data-key]')).find(x => x.dataset.key === focusKey && x.tagName === 'BUTTON');
    if (t) t.focus({ preventScroll: true });
  }
}
function fdDailyChip(d, label, on, onClick, attrs) {
  const b = dBtn(label, 'fd-chip dl-chip' + (on ? ' on' : ''), onClick);
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.disabled = !!d.busy;
  Object.entries(attrs || {}).forEach(([k, v]) => { b.dataset[k] = v; });
  return b;
}
function fdDailyTotals(d) {
  const t = DailyLogic.totals(d.model, d.sel);
  const tot = $('fd-daily-total');
  if (tot) tot.textContent = t.text;
  const miss = $('fd-daily-missing');
  if (miss) { miss.textContent = t.missing ? '時間を選んでいない現場が' + t.missing + '件あります（合計に入っていません）' : ''; miss.hidden = !t.missing; }
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
  const m = d.model;
  const nodes = [];
  const card = mk('div', 'fd-card fd-daily');
  card.id = 'fd-daily';
  const head = mk('div', 'dl-head');
  head.appendChild(mk('b', 'fd-place', DailyLogic.heading(m.ymd, fdDailyName())));
  head.appendChild(mk('span', 'fd-tiny', (ctx.org && ctx.org.name) || ''));
  card.appendChild(head);
  if (d.today) {
    const st = mk('div', 'fd-daily-sent', '✓ 送った（' + PhaseLogic.fmtMDHM(d.today.created_at).split(' ')[1] + '・' + (d.today.read_at ? '既読' : '未読') + '）　直して「送り直す」を押すと、管理者の画面で未読に戻ります');
    st.id = 'fd-daily-sent';
    card.appendChild(st);
  }
  card.appendChild(mk('span', 'fd-tiny', '自動で入りました。行を押すと ☑／☐ が切り替わります（☑ の行だけが日報に入ります）'));
  m.sections.forEach(sec => {
    const box = mk('div', 'dl-sec');
    box.dataset.sec = sec.key;
    box.appendChild(mk('div', 'dl-h', '■ ' + sec.title));
    if (!sec.items.length) box.appendChild(mk('div', 'dl-none', 'なし'));
    sec.items.forEach(x => box.appendChild(fdDailyRow(d, x)));
    card.appendChild(box);
  });
  // かかった時間
  const tb = mk('div', 'dl-sec');
  tb.dataset.sec = 'time';
  tb.appendChild(mk('div', 'dl-h', '■ かかった時間'));
  if (!m.times.length) tb.appendChild(mk('div', 'dl-none', 'なし（行った現場がありません）'));
  m.times.forEach(t => {
    const wrap = mk('div', 'dl-trow');
    wrap.dataset.tkey = t.key;
    const on = !(d.sel.off && d.sel.off[t.key]);
    wrap.appendChild(fdDailyRow(d, { key: t.key, text: t.label }, DailyLogic.timeText(t, d.sel)));
    if (on && !t.auto) {
      const chips = mk('div', 'fd-chips dl-chips');
      const cur = d.sel.chip && d.sel.chip[t.key];
      DailyLogic.TIME_CHIPS.forEach(c => chips.appendChild(fdDailyChip(d, c.label, cur === c.v, () => {
        d.sel.chip = Object.assign({}, d.sel.chip, { [t.key]: cur === c.v ? null : c.v });
        fdDailyChanged(d);
      }, { v: String(c.v) })));
      wrap.appendChild(chips);
      if (cur === 'other') {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.inputMode = 'decimal';
        inp.className = 'dl-other';
        inp.placeholder = '例: 2.5';
        inp.setAttribute('aria-label', t.label + ' のかかった時間（時間）');
        inp.maxLength = 5;
        inp.value = (d.sel.other && d.sel.other[t.key]) || '';
        inp.disabled = !!d.busy;
        inp.addEventListener('input', () => {
          d.sel.other = Object.assign({}, d.sel.other, { [t.key]: inp.value });
          d.pdf = null;
          fdDailyDraftSet(d);
          const val = wrap.querySelector('.dl-val');
          if (val) val.textContent = DailyLogic.timeText(t, d.sel);
          fdDailyTotals(d);
        });
        const lb = mk('label', 'dl-other-f', 'その他（時間）');
        lb.appendChild(inp);
        wrap.appendChild(lb);
      }
    }
    tb.appendChild(wrap);
  });
  const tr = mk('div', 'dl-trow travel');
  tr.appendChild(mk('div', 'dl-tl', '移動時間（任意）'));
  const tchips = mk('div', 'fd-chips dl-chips');
  DailyLogic.TRAVEL_CHIPS.forEach(c => tchips.appendChild(fdDailyChip(d, c.label, d.sel.travel === c.v, () => {
    d.sel.travel = d.sel.travel === c.v ? null : c.v;
    fdDailyChanged(d);
  }, { travel: String(c.v) })));
  tr.appendChild(tchips);
  tb.appendChild(tr);
  const tot = mk('div', 'dl-total');
  tot.id = 'fd-daily-total';
  tb.appendChild(tot);
  const miss = mk('div', 'dl-miss');
  miss.id = 'fd-daily-missing';
  tb.appendChild(miss);
  card.appendChild(tb);
  // 一言
  const ta = document.createElement('textarea');
  ta.id = 'fd-daily-note';
  ta.rows = 3;
  ta.maxLength = 1000;
  ta.placeholder = '例: 201号室の入居者さんは夕方なら在宅とのことです';
  ta.value = d.note || '';
  ta.disabled = !!d.busy;
  ta.addEventListener('input', () => { d.note = ta.value; d.noteTouched = true; d.pdf = null; fdDailyDraftSet(d); });
  const lt = mk('label', 'sm-f fd-daily-f', '一言（任意）');
  lt.appendChild(ta);
  card.appendChild(lt);
  // 写真（任意・3枚まで）
  const pb = mk('div', 'dl-photos');
  pb.id = 'fd-daily-photos';
  const count = d.keep.length + d.photos.length;
  pb.appendChild(mk('div', 'dl-tl', '写真（任意・' + DailyLogic.PHOTOS_MAX + '枚まで）' + (count ? ' ' + count + '枚' : '')));
  const thumbs = mk('div', 'dl-thumbs');
  const thumb = (src, label, onRemove) => {
    const t = mk('div', 'dl-thumb');
    const im = document.createElement('img');
    im.alt = label;
    if (typeof src === 'string') im.src = src; else src.then(u => { im.src = u; }, () => { im.alt = '写真を開けませんでした'; });
    t.appendChild(im);
    const x = dBtn('×', 'dl-thumb-x', onRemove);
    x.setAttribute('aria-label', '写真を外す');
    x.disabled = !!d.busy;
    t.appendChild(x);
    thumbs.appendChild(t);
  };
  d.keep.forEach(a => thumb(StaffMessagesApi.photoUrl(a.path), a.name || '送った写真', () => {
    d.keep = d.keep.filter(x => x !== a); d.keepTouched = true; d.pdf = null; fdRenderDaily();
  }));
  d.photos.forEach(p => thumb(p.url, p.name || '写真', () => {
    d.photos = d.photos.filter(x => x !== p); try { URL.revokeObjectURL(p.url); } catch (e) { /* 無視 */ } d.pdf = null; fdRenderDaily();
  }));
  pb.appendChild(thumbs);
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/*';
  file.multiple = true;
  file.id = 'fd-daily-file';
  file.className = 'sr-only';
  file.addEventListener('change', () => fdDailyAddPhotos(d, Array.from(file.files || [])));
  const pick = dBtn('📷 写真を追加', 'btn sm ghost inline fd-daily-pick', () => file.click());
  pick.id = 'fd-daily-pick';
  pick.disabled = !!d.busy || count >= DailyLogic.PHOTOS_MAX;
  pb.append(pick, file);
  card.appendChild(pb);
  const err = mk('div', 'err', d.err || '');
  err.id = 'fd-daily-err';
  err.setAttribute('role', 'alert');
  card.appendChild(err);
  const msg = mk('div', 'ob-msg', d.msg || '');
  msg.id = 'fd-daily-msg';
  msg.setAttribute('role', 'status');
  card.appendChild(msg);
  nodes.push(card);
  // 下に固定のボタン
  const bar = mk('div', 'dl-bar');
  bar.id = 'fd-daily-bar';
  const pv = dBtn(d.busy === 'pdf' ? 'PDFを作っています…' : '📄 PDFを見る', 'btn ghost dl-pdf', () => fdDailyPreview(s));
  pv.id = 'fd-daily-pdf';
  pv.disabled = !!d.busy;
  const send = dBtn(d.busy === 'send' ? '送っています…' : d.today ? '送り直す' : '送る', 'btn dl-send fd-daily-send', () => fdSendDaily(s));
  send.id = 'fd-daily-send';
  send.disabled = !!d.busy;
  bar.append(pv, send);
  nodes.push(bar);
  // 履歴（送った日報と管理者からの返事）
  nodes.push(mk('div', 'fd-h', '送った日報 ' + d.mine.length + '件'));
  const hist = mk('div', 'fd-list');
  hist.id = 'fd-daily-hist';
  if (!d.mine.length) hist.appendChild(mk('div', 'empty', 'まだ送った日報はありません'));
  d.mine.forEach(mm => {
    const box = mk('div', 'fd-card fd-daily-h');
    box.dataset.msgId = mm.id;
    const top = mk('div', 'fd-row');
    top.appendChild(mk('b', null, mm.subject));
    top.appendChild(mk('span', 'fd-tiny', PhaseLogic.fmtMDHM(mm.created_at) + ' ・ ' + (mm.read_at ? '既読' : '未読')));
    box.appendChild(top);
    const atts = Array.isArray(mm.attachments) ? mm.attachments : [];
    const pdf = atts.find(a => StaffMessagesApi.isPdf(a));
    if (pdf) box.appendChild(smPdfLinks(pdf));
    box.appendChild(mk('div', 'fd-daily-body', mm.body));
    const ph = atts.filter(a => !StaffMessagesApi.isPdf(a));
    if (ph.length) box.appendChild(mk('span', 'fd-tiny', '写真 ' + ph.length + '枚'));
    d.replies.filter(r => r.reply_to === mm.id).forEach(r => {
      const rp = mk('div', 'fd-daily-reply');
      rp.appendChild(mk('b', null, '管理者から（' + PhaseLogic.fmtMDHM(r.created_at) + '）'));
      rp.appendChild(mk('div', null, r.body));
      box.appendChild(rp);
    });
    hist.appendChild(box);
  });
  nodes.push(hist);
  nodes.push(mk('div', 'dl-spacer'));
  host.replaceChildren(...nodes);
  fdDailyTotals(d);
}

async function fdDailyAddPhotos(d, files) {
  const room = DailyLogic.PHOTOS_MAX - d.keep.length - d.photos.length;
  const list = files.slice(0, Math.max(0, room));
  d.err = files.length > list.length ? '写真は' + DailyLogic.PHOTOS_MAX + '枚までです' : '';
  for (const f of list) {
    try {
      const p = await ImageUtil.prepareFile(f);
      if (p.type !== 'image/jpeg') throw new Error('「' + f.name + '」は写真ではありません');
      d.photos.push(Object.assign({}, p, { url: URL.createObjectURL(p.blob) }));
    } catch (e) { d.err = errText(e); }
  }
  d.pdf = null;
  if (fd && fd.daily === d) fdRenderDaily();
}

// PDF を作る（中身が変わっていなければ前に作ったものを使う）
async function fdDailyMakePdf(d) {
  const v = fdDailyView(d);
  const sig = JSON.stringify(v) + '|' + d.keep.map(a => a.path).join(',') + '|' + d.photos.map(p => p.url).join(',');
  if (d.pdf && d.pdf.sig === sig) return d.pdf;
  const urls = [];
  for (const a of d.keep) { try { urls.push(await StaffMessagesApi.photoUrl(a.path)); } catch (e) { console.warn('写真のURLを作れませんでした', e); } }
  d.photos.forEach(p => urls.push(p.url));
  const r = await DailyPdf.toBlob(v, { photos: urls });
  window.__dailyPdfLast = { pages: r.pages, pt: r.pt, size: r.blob.size }; // 検証用（中身は出さない）
  d.pdf = Object.assign({ sig, view: v }, r);
  return d.pdf;
}

async function fdDailyPreview(s) {
  const d = s.daily;
  if (!d || d.busy) return;
  d.busy = 'pdf';
  d.err = '';
  fdRenderDaily();
  let r = null, err = '';
  try { r = await fdDailyMakePdf(d); } catch (e) { err = 'PDFを作れませんでした: ' + errText(e); }
  if (fd !== s || s.daily !== d) return;
  d.busy = '';
  if (err) { d.err = err; fdRenderDaily(); return; }
  fdRenderDaily();
  fdDailyPreviewSheet(r, d.model.ymd);
}

// PDF のプレビュー（PDF と同じ画像を出す）。入力が無いので × と Esc で閉じる（外側を押しても閉じない）
function fdDailyPreviewSheet(r, ymd) {
  const old = $('dl-pv-bg');
  if (old) old.remove();
  const bg = mk('div', 'dl-pv-bg');
  bg.id = 'dl-pv-bg';
  bg.setAttribute('role', 'dialog');
  bg.setAttribute('aria-modal', 'true');
  bg.setAttribute('aria-label', '日報のPDF');
  const top = mk('div', 'dl-pv-top');
  top.appendChild(mk('b', null, '日報のPDF（' + r.pages + 'ページ' + (r.pt < DailyPdf.FONT_STEPS[0] ? '・文字を小さくして収めました' : '') + '）'));
  const url = URL.createObjectURL(r.blob);
  const save = mk('a', 'btn sm ghost inline dl-pv-save', '保存');
  save.href = url;
  save.download = DailyPdf.fileName(ymd, fdDailyName());
  const close = () => { document.removeEventListener('keydown', onKey); bg.remove(); try { URL.revokeObjectURL(url); } catch (e) { /* 無視 */ } const b = $('fd-daily-pdf'); if (b) b.focus(); };
  const x = dBtn('× 閉じる', 'btn sm ghost inline dl-pv-close', close);
  x.id = 'dl-pv-close';
  top.append(save, x);
  bg.appendChild(top);
  const body = mk('div', 'dl-pv-body');
  r.images.forEach((src, i) => {
    const im = document.createElement('img');
    im.className = 'dl-pv-img';
    im.alt = '日報のPDF ' + (i + 1) + 'ページ目';
    im.src = src;
    body.appendChild(im);
  });
  bg.appendChild(body);
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  document.body.appendChild(bg);
  x.focus();
}

async function fdSendDaily(s) {
  const d = s.daily;
  if (!d || d.busy) return;
  d.busy = 'send';
  d.err = '';
  d.msg = '';
  fdRenderDaily();
  let row = null, err = '';
  try {
    const body = DailyLogic.text(d.model, d.sel, { name: fdDailyName(), org: (ctx.org && ctx.org.name) || '', note: d.note });
    if (body.length > StaffMessagesApi.BODY_MAX) throw new Error('日報が長すぎます（' + StaffMessagesApi.BODY_MAX + '文字まで）。☐ にする行を増やすか、一言を短くしてください');
    const pdf = await fdDailyMakePdf(d);
    const old = d.today && Array.isArray(d.today.attachments) ? d.today.attachments : [];
    const drop = old.filter(a => !d.keep.some(k => k.path === a.path));
    row = await StaffMessagesApi.sendDaily({ body, pdf: pdf.blob, pdfName: DailyPdf.fileName(d.model.ymd, fdDailyName()),
      keep: d.keep, photos: d.photos.map(p => ({ blob: p.blob, name: p.name, size: p.size, type: p.type })), drop });
  } catch (e) { err = '日報を送れませんでした: ' + errText(e); }
  if (fd !== s || s.daily !== d) return;
  d.busy = '';
  if (err) { d.err = err; fdRenderDaily(); return; }
  d.photos.forEach(p => { try { URL.revokeObjectURL(p.url); } catch (e) { /* 無視 */ } });
  Object.assign(d, { photos: [], keepTouched: false, noteTouched: false, pdf: null,
    msg: (row && row.resent ? '日報を送り直しました' : '日報を送りました') + '（管理者の「📨 現場からの連絡」で PDF を開けます）' });
  try { localStorage.setItem(fdDailyKey(d.model.ymd), JSON.stringify({ sel: d.sel, note: null })); } catch (e) { /* 無視 */ }
  await fdLoadDaily(s.seq);
}

/* ---------- #f/settings（Task 32: 担当者の情報／画面の切替（管理者のみ）／ログアウト） ---------- */
// 担当者の情報: 会社名（表示のみ）・担当者名（直せる）・メールアドレス（ログインに使うもの。表示のみ）・電話番号（直せる）。
// 直したらその場で自動保存（入力が止まって1秒・欄を離れたとき）。DB は migration 056（本人の行の display_name / phone だけ update できる）
const FD_SET_SAVE_MS = 1000;
let fdSetTimer = null;
// 電話番号の入力を半角に（全角の数字・ハイフン・括弧・空白）。形が違えば null
function fdPhoneNorm(v) {
  const t = String(v || '').replace(/[０-９（）＋]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[ー－‐−―]/g, '-').replace(/　/g, ' ').trim();
  if (!t) return '';
  return t.length <= 30 && /^[0-9+()\- ]+$/.test(t) ? t : null;
}
function fdRenderSettings() {
  const host = $('field-root');
  const nodes = [];
  const m = ctx.membership || {};
  const me = mk('div', 'fd-card fd-set');
  me.id = 'fd-set-me';
  me.appendChild(mk('b', null, '担当者の情報'));
  const ro = (label, value, id) => {
    const row = mk('div', 'fd-set-ro');
    row.appendChild(mk('span', 'fd-set-k', label));
    const v = mk('span', 'fd-set-v', value || '—');
    v.id = id;
    row.appendChild(v);
    return row;
  };
  me.appendChild(ro('会社名', (ctx.org && ctx.org.name) || '', 'fd-set-org'));
  const field = (label, id, type, value, ph) => {
    const lb = mk('label', 'fd-set-f', label);
    const inp = document.createElement('input');
    inp.id = id;
    inp.type = type;
    inp.value = value || '';
    inp.placeholder = ph;
    inp.maxLength = type === 'tel' ? 30 : 40;
    if (type === 'tel') { inp.inputMode = 'tel'; inp.autocomplete = 'tel'; } else inp.autocomplete = 'name';
    lb.appendChild(inp);
    return { lb, inp };
  };
  const nm = field('担当者名', 'fd-set-name', 'text', m.display_name, '例: 佐藤 太郎');
  me.appendChild(nm.lb);
  me.appendChild(ro('メールアドレス（ログインに使うもの）', (ctx.user && ctx.user.email) || '', 'fd-set-email'));
  const ph = field('電話番号', 'fd-set-phone', 'tel', m.phone, '例: 090-1234-5678');
  me.appendChild(ph.lb);
  const st = mk('div', 'fd-set-st', '直すと自動で保存します');
  st.id = 'fd-set-status';
  st.setAttribute('role', 'status');
  me.appendChild(st);
  const err = mk('div', 'err', '');
  err.id = 'fd-set-err';
  err.setAttribute('role', 'alert');
  me.appendChild(err);
  const save = async () => {
    clearTimeout(fdSetTimer);
    fdSetTimer = null;
    const name = nm.inp.value.trim();
    const phone = fdPhoneNorm(ph.inp.value);
    if (!name) { err.textContent = '担当者名を入れてください'; return; }
    if (phone === null) { err.textContent = '電話番号は数字と - ( ) + だけで入れてください（30文字まで）'; return; }
    const cur = ctx.membership || {};
    if (name === (cur.display_name || '') && (phone || null) === (cur.phone || null)) { err.textContent = ''; return; }
    err.textContent = '';
    st.textContent = '保存しています…';
    try {
      const row = await CasesApi.updateMe({ display_name: name, phone });
      Object.assign(ctx.membership, { display_name: row.display_name, phone: row.phone || null });
      document.querySelectorAll('.js-user-name').forEach(e => { e.textContent = row.display_name; });
      if (document.activeElement !== ph.inp && ph.inp.value !== (row.phone || '')) ph.inp.value = row.phone || '';
      fieldRowsInvalidate();
      st.textContent = '✓ 保存しました（' + PhaseLogic.fmtMDHM(new Date()).split(' ')[1] + '）';
    } catch (e) {
      st.textContent = '';
      err.textContent = '保存できませんでした: ' + errText(e);
    }
  };
  [nm.inp, ph.inp].forEach(inp => {
    inp.addEventListener('input', () => { clearTimeout(fdSetTimer); st.textContent = '入力中…'; fdSetTimer = setTimeout(save, FD_SET_SAVE_MS); });
    inp.addEventListener('blur', () => { if (fdSetTimer) save(); });
  });
  nodes.push(me);
  if (fdIsOwner()) nodes.push(fieldViewCard('fd-set-view'));
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
