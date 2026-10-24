// js/tasks.js — やること（#tasks。対応フェーズ Task 17）… openTasks() / tasksBannerCount(rows)
// 全案件（進行中・削除されていないもの）の 🔴（自社）の段階を種類ごとにまとめる（PhaseLogic.taskGroups）:
//   見積書作成必要／見積書を送付／日程調整必要／調査に行く／報告書を書く／報告書を確認する／報告書を送る／完了報告必要／請求する／その他。
// 上の「自分の分だけ」（既定オン: 自分が案件の担当者か、そのフェーズの作業担当者）。各行に「開く」（フェーズ詳細ページ）と、その場で進めるボタンを1つ:
//   見積書作成必要 → 見積を作る（phase_id 付きで作って編集画面へ）／見積書を送付 → 送るメールへ（送付メールの下書き。戻り先はこの画面）／
//   日程調整必要 → 工事日（調査日）を決める（詳細ページの日時の入力を開く）／調査に行く → ボタンなし（開くだけ）／
//   報告書を書く・確認する → 報告書を開く／報告書を送る → 送るメールへ（未送信の下書き。無ければ確認して作る）／
//   完了報告必要 → 報告書を作る（自社で作って編集画面へ）／報告書を開く／請求する → 請求した（入金期限を入れて画面内で確かめてから記録）
// Task 43: 一番上に「差し戻し」（作業担当者が差し戻したタスク。PhaseLogic.taskSendbacks。「自分の分だけ」に関係なく出す）。
//   各行に「済みにする」（rpc task_flag_close。連絡に返事をしても済みになる）と「開く」
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。alert/confirm は使わない
// mk() は case-list.js、dBtn / errText は case-detail.js、openMailDraftFrom は mail-ui.js、pdOpenWhen は phase-detail.js、
// $ / setMsg / showScreen / renderHeaders / withBusy は app.js

let tk = null;              // { seq, rows, members, loading, failed, busy: Set(phaseId), bill: phaseId|null, rowErr: Map, notice }
let tkSeq = 0;
let tkMineOnly = true;      // 「自分の分だけ」（既定オン。この端末の表示中だけ覚える）

const tkMe = () => (ctx && ctx.user ? ctx.user.id : null);
const tkPhaseHash = it => '#case/' + it.caseId + '/phase/' + it.phaseId;

// 案件一覧の上の「✅ やること n件」（自分の分）
function tasksBannerCount(rows) {
  return PhaseLogic.taskGroups(rows, tkMe(), new Date()).counts.mine;
}

async function openTasks() {
  renderHeaders();
  showScreen('tasks');
  if (location.hash !== '#tasks') history.replaceState(null, '', location.pathname + location.search + '#tasks');
  const seq = ++tkSeq;
  const keep = tk && tk.notice ? tk.notice : '';
  tk = { seq, rows: [], members: [], loading: true, failed: false, busy: new Set(), bill: null, rowErr: new Map(), notice: keep };
  setMsg('tasks-msg', '');
  tkRender();
  await tkLoad(seq);
}

async function tkLoad(seq) {
  let res = null, errMsg = '';
  try { res = await Promise.all([CasesApi.listSummaries(), CasesApi.listMembers()]); }
  catch (e) { errMsg = 'やることの読み込みに失敗しました: ' + errText(e); }
  if (!tk || tk.seq !== seq) return; // 別の画面に移った / より新しい読み込み
  tk.loading = false;
  tk.failed = !!errMsg;
  tk.rows = errMsg ? [] : (res[0] || []);
  tk.members = errMsg ? [] : (res[1] || []);
  setMsg('tasks-msg', errMsg);
  tkRender();
}
const tkAlive = s => tk === s && $('screen-tasks').classList.contains('active');

/* ---------- 描画 ---------- */
function tkRender() {
  const s = tk;
  if (!s) return;
  const g = PhaseLogic.taskGroups(s.rows, tkMe(), new Date(), { mine: tkMineOnly, members: s.members });
  const shown = !s.loading && !s.failed;

  const mine = $('tasks-mine');
  mine.setAttribute('aria-pressed', tkMineOnly ? 'true' : 'false');
  mine.classList.toggle('on', tkMineOnly);
  mine.textContent = (tkMineOnly ? '✓ ' : '') + '自分の分だけ';
  $('tasks-count').textContent = shown ? (tkMineOnly ? '自分の分 ' + g.counts.mine + '件（全員 ' + g.counts.all + '件）' : '全員の分 ' + g.counts.all + '件') : '';
  const note = $('tasks-notice');
  note.textContent = s.notice || '';
  note.hidden = !s.notice;

  const cards = shown ? g.groups.map(gr => tkGroupEl(gr)) : [];
  const sbs = shown ? PhaseLogic.taskSendbacks(s.rows) : [];
  if (sbs.length) cards.unshift(tkSendbackGroupEl(sbs));
  $('tasks-body').replaceChildren(...cards);
  $('tasks-loading').hidden = !s.loading;
  $('tasks-empty').hidden = !shown || cards.length > 0;
  $('tasks-retry').hidden = !s.failed;
}

function tkGroupEl(gr) {
  const card = mk('div', 'member tk-group');
  card.dataset.group = gr.key;
  const h = mk('div', 'member-h');
  h.appendChild(mk('b', null, gr.label));
  const sub = mk('span', 'mh-sub tk-n', gr.items.length + '件');
  const late = gr.items.filter(x => x.late).length;
  if (late) {
    sub.appendChild(document.createTextNode('・'));
    // 見積書提案期日だけが過ぎているグループは「期日を過ぎた」（Task 20）
    const word = gr.items.some(x => x.late && !x.due) ? '予定を過ぎた ' : '期日を過ぎた ';
    sub.appendChild(mk('span', 'hot', word + late));
  }
  h.appendChild(sub);
  card.appendChild(h);
  gr.items.forEach(it => card.appendChild(tkRowEl(it)));
  return card;
}

// Task 43: 差し戻し（作業担当者が理由を書いて戻したタスク）
function tkSendbackGroupEl(list) {
  const s = tk;
  const card = mk('div', 'member tk-group tk-sendback');
  card.dataset.group = 'sendback';
  const h = mk('div', 'member-h');
  h.append(mk('b', null, '差し戻し'), mk('span', 'mh-sub tk-n', list.length + '件'));
  card.appendChild(h);
  list.forEach(x => {
    const it = { group: 'sendback', phaseId: x.flag.id }; // tkKey 用（記録ごと）
    const m = s.members.find(y => y.user_id === x.flag.created_by);
    const place = [x.caseRow.name || '(案件名なし)', PhaseLogic.roomLabel(x.caseRow.room)].filter(Boolean).join(' ');
    const row = mk('div', 'mt-row tk-row');
    row.dataset.phase = x.phase.id;
    row.dataset.group = 'sendback';
    row.dataset.flagId = x.flag.id;
    const l = mk('div', 'mt-l');
    l.appendChild(mk('b', null, '差し戻し: ' + x.todo));
    l.appendChild(mk('span', 'mt-case', place + ' ・ ' + x.title + ' ・ ' + ((m && m.display_name) || '作業担当者') + '「' + x.flag.body + '」'));
    row.appendChild(l);
    const r = mk('div', 'mt-r');
    const done = dBtn('済みにする', 'btn sm inline tk-act tk-sendback-done', b => tkRun(it, b, '済みにできませんでした', async () => {
      await PhasesApi.closeTaskFlag(x.flag.id);
      s.notice = place + ' ・ ' + x.title + 'の差し戻し（' + x.todo + '）を済みにしました';
      if (tkAlive(s)) await tkLoad(s.seq);
    }));
    done.disabled = s.busy.has(tkKey(it));
    const open = mk('button', 'poke tk-open', '開く');
    open.type = 'button';
    open.setAttribute('aria-label', '開く: ' + place + ' ' + x.title);
    open.addEventListener('click', () => { location.hash = '#case/' + x.caseRow.id + '/phase/' + x.phase.id; });
    r.append(done, open);
    row.appendChild(r);
    const err = mk('div', 'err tk-err', s.rowErr.get(tkKey(it)) || '');
    if (!err.textContent) err.hidden = true;
    row.appendChild(err);
    card.appendChild(row);
  });
  return card;
}

// 行ごとの処理中・エラーの鍵（同じフェーズの2行＝日程調整と見積書作成が処理中を分け合わない。Task 23 M3）
const tkKey = it => (it.group || '') + ':' + (it.phaseId || '');

function tkRowEl(it) {
  const s = tk;
  const row = mk('div', 'mt-row tk-row');
  row.dataset.phase = it.phaseId || '';
  row.dataset.group = it.group;
  const l = mk('div', 'mt-l');
  l.appendChild(mk('b', it.late ? 'hot' : null)).append(Icon.dot('us'), it.text);
  const place = [it.caseName || '(案件名なし)', PhaseLogic.roomLabel(it.room)].filter(Boolean).join(' ');
  l.appendChild(mk('span', 'mt-case', place + ' ・ ' + it.title + ' ・ 担当 ' + (it.whoName || 'なし')));
  row.appendChild(l);

  const r = mk('div', 'mt-r');
  // 見積書提案期日（Task 20）・入金期限は「期日を過ぎています」、予定日は「予定を過ぎています」
  if (it.late) r.appendChild(mk('span', 'nx-due near', it.due ? '期日を過ぎています' : '予定を過ぎています'));
  const act = tkActionBtn(it);
  if (act) r.appendChild(act);
  const open = mk('button', 'poke tk-open', '開く');
  open.type = 'button';
  open.setAttribute('aria-label', '開く: ' + place + ' ' + it.title);
  open.addEventListener('click', () => { location.hash = tkPhaseHash(it); });
  r.appendChild(open);
  row.appendChild(r);

  if (s && s.bill === it.phaseId) row.appendChild(tkBillForm(it));
  const err = mk('div', 'err tk-err', (s && s.rowErr.get(tkKey(it))) || '');
  if (!err.textContent) err.hidden = true;
  row.appendChild(err);
  return row;
}

// 行の右のボタン（その場で進める操作。1つだけ）
function tkActionBtn(it) {
  const s = tk;
  const busy = s.busy.has(tkKey(it));
  const btn = (label, fn) => {
    const b = dBtn(label, 'btn sm inline tk-act', () => fn(b));
    b.dataset.action = it.action || '';
    b.disabled = busy || (s.bill != null && s.bill !== it.phaseId && it.action === 'bill');
    return b;
  };
  switch (it.action) {
    case 'make_estimate':
      // 下書きがあれば続きを開く（Task 23: 提出するまで行が残る）
      return it.estimateId ? btn('見積の続きを書く', () => { location.hash = '#estimate/' + it.estimateId; })
        : btn('見積を作る', b => tkRun(it, b, '見積書を作れませんでした', () => tkMakeEstimate(it)));
    case 'send_estimate': return it.estimateId ? btn('送るメールへ', b => tkRun(it, b, '送付メールの下書きを作れませんでした', () => tkSendEstimate(it))) : null;
    case 'schedule': return btn(it.phase && it.phase.schedule && PhaseLogic.schedOpen(it.phase) && it.phase.schedule.state === 'wish' ? '日程を確定する' // Task 50
      : it.kind === 'survey' ? '調査日を決める' : '工事日を決める', () => tkOpenWhen(it));
    case 'open_report':
      // Task 23: 調査日時を過ぎて報告書がまだ無い（報告書を書く・期限あり）→ その場で作る
      return it.reportId ? btn('報告書を開く', () => { location.hash = '#report/' + it.reportId; })
        : it.group === 'write' ? btn('報告書を作る', b => tkRun(it, b, '報告書を作れませんでした', () => tkMakeReport(it))) : null;
    case 'send_report': return it.reportId ? btn('送るメールへ', b => tkRun(it, b, '送付メールの下書きを作れませんでした', () => tkSendReport(it))) : null;
    case 'work_report':
      // 報告書が提出済み・確認済み（送付する）なら調査の「報告書を送る」と同じく「送るメールへ」（Task 23 M4）
      if (it.reportId && (it.reportState === 'confirmed' || (it.reportStatus === 'submitted' && it.reportState !== 'submitted'))) {
        return btn('送るメールへ', b => tkRun(it, b, '送付メールの下書きを作れませんでした', () => tkSendReport(it)));
      }
      return it.reportId ? btn('報告書を開く', () => { location.hash = '#report/' + it.reportId; })
        : btn('報告書を作る', b => tkRun(it, b, '報告書を作れませんでした', () => tkMakeReport(it)));
    case 'bill': {
      if (s.bill === it.phaseId) return null; // 下の入力欄の「請求した（記録する）」で記録する
      return btn('請求した', () => tkOpenBill(it));
    }
    default: return null;
  }
}

/* ---------- 操作 ---------- */
// 共通: 二度押しを防ぎ、失敗はその行に出す。fn が true を返したら（画面を移った）何もしない
async function tkRun(it, btn, failLabel, fn) {
  const s = tk;
  if (!s || s.busy.has(tkKey(it))) return;
  s.busy.add(tkKey(it));
  s.rowErr.delete(tkKey(it));
  s.notice = '';
  tkRender();
  let err = '';
  try { await fn(); }
  catch (e) { err = failLabel + ': ' + errText(e); }
  if (tk !== s) return;
  s.busy.delete(tkKey(it));
  if (err) {
    s.rowErr.set(tkKey(it), err);
    if (tkAlive(s)) tkRender();
  }
}

async function tkMakeEstimate(it) {
  const s = tk;
  const opts = { phase_id: it.phaseId, phaseTitle: it.title };
  // 工事の見積は、この案件の調査結果の注意事項を備考の初期値に（フェーズ詳細ページの「＋ 見積書を作る」と同じ）
  if (it.kind !== 'survey') {
    const r = PhaseLogic.latestSurveyResult(it.caseRow.phases);
    if (r) opts.noteExtra = PhaseLogic.estimateNoteExtra(r);
  }
  const row = await EstimatesApi.create(it.caseId, it.caseRow, opts);
  if (tkAlive(s)) location.hash = '#estimate/' + row.id;
}

async function tkSendEstimate(it) {
  const s = tk;
  let d = await EstimatesApi.findMailDraft(it.estimateId);
  if (!d) {
    const est = await EstimatesApi.get(it.estimateId);
    if (!est) throw new Error('見積書が見つかりません');
    d = await EstimatesApi.createMailDraft(est);
  }
  if (tkAlive(s) && d && d.id) openMailDraftFrom(d.id, '#tasks');
}

async function tkSendReport(it) {
  const s = tk;
  const drafts = await ReportsApi.listDrafts(it.caseId);
  let d = (drafts || []).filter(m => m.report_id === it.reportId && m.status === 'draft')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
  if (!d) {
    const r = await ReportsApi.get(it.reportId);
    if (!r) throw new Error('報告書が見つかりません');
    // 自社で書いて提出したもの（submitted）は確認済みにして下書きを作る。確認済みなら下書きだけ作る
    d = r.status === 'submitted' ? await ReportsApi.confirm(r) : await ReportsApi.createDraft(r);
  }
  if (tkAlive(s) && d && d.id) openMailDraftFrom(d.id, '#tasks');
}

async function tkMakeReport(it) {
  const s = tk;
  // Task 26: 作業担当者の初期値 = このフェーズの作業担当者（未設定なら空欄。編集画面で選べる）
  const row = await ReportsApi.create(it.caseId, PhaseLogic.reportFields(it.phase, it.caseRow, { title: it.title }));
  if (tkAlive(s)) location.hash = '#report/' + row.id;
}

// 日程調整必要: フェーズ詳細ページを開いて日時の入力欄を開く（js/phase-detail.js の pdOpenWhen）
function tkOpenWhen(it) {
  if (typeof pdOpenWhen === 'function') pdOpenWhen(it.caseId, it.phaseId);
  else location.hash = tkPhaseHash(it);
}

// 請求した: 行の下に入金期限の欄（初期値: 月ごと=請求月の翌月末・単発=請求日の30日後）。「やめる」でだけ閉じる
function tkOpenBill(it) {
  const s = tk;
  if (!s) return;
  if (s.bill && s.bill !== it.phaseId) return;
  s.bill = it.phaseId;
  s.rowErr.delete(tkKey(it));
  s.notice = '';
  tkRender();
  const i = document.querySelector('#tasks-body .tk-due-input');
  if (i) { i.scrollIntoView({ block: 'nearest' }); i.focus({ preventScroll: true }); }
}

function tkBillForm(it) {
  const s = tk;
  const p = it.phase;
  const amount = PhaseLogic.billingAmount(p, p.estimates);
  const billTo = PhaseLogic.billToLabel(p, it.caseRow);
  const box = mk('div', 'ph-form tk-bill');
  box.appendChild(mk('div', 'ph-sub tk-bill-what', '金額: ' + (amount == null ? '未定（フェーズの詳細ページの請求の段で直せます）' : PhaseLogic.yen(amount)) + ' ・ 請求先: ' + billTo));
  const input = document.createElement('input');
  input.type = 'date';
  input.className = 'tk-due-input';
  input.value = PhaseLogic.paymentDueDefault(p, new Date());
  const l = mk('label', null, '入金期限');
  l.appendChild(input);
  box.appendChild(l);
  box.appendChild(mk('div', 'ph-sub', '初期値: ' + (p.billing_mode === 'monthly' ? '請求月の翌月末' : '請求日の30日後') + '（変えられます）。請求書を出したら記録してください'));
  const acts = mk('div', 'ph-acts');
  const cancel = dBtn('やめる', 'btn sm ghost inline tk-bill-cancel', () => {
    if (s.busy.has(tkKey(it))) return;
    s.bill = null; s.rowErr.delete(tkKey(it)); tkRender();
  });
  const ok = dBtn('請求した（記録する）', 'btn sm inline tk-bill-ok', b => {
    const v = input.value;
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { s.rowErr.set(tkKey(it), '入金期限の日付を正しく入れてください'); tkRender(); return; }
    return tkBill(it, b, v || null, amount, billTo);
  });
  const busy = s.busy.has(tkKey(it));
  cancel.disabled = busy; ok.disabled = busy; input.disabled = busy;
  acts.appendChild(cancel);
  acts.appendChild(ok);
  box.appendChild(acts);
  return box;
}

async function tkBill(it, btn, due, amount, billTo) {
  const s = tk;
  if (!s || s.busy.has(tkKey(it))) return;
  s.busy.add(tkKey(it));
  s.rowErr.delete(tkKey(it));
  tkRender();
  let err = '';
  try {
    const rows = await PhasesApi.setBilled([{ phase: it.phase, title: it.title, amount, billTo }], true, due);
    if (!rows.length) err = '記録できませんでした（ほかの人が先に記録した可能性があります。表示を更新しました）';
  } catch (e) { err = '請求の記録に失敗しました: ' + errText(e); }
  if (tk !== s) return;
  s.busy.delete(tkKey(it));
  s.bill = null;
  const place = [it.caseName, PhaseLogic.roomLabel(it.room)].filter(Boolean).join(' ');
  s.notice = err ? '' : place + ' ・ ' + it.title + 'を請求済みにしました（入金期限 ' + (due ? PhaseLogic.fmtYmdMD(due) : 'なし') + '。取り消しはフェーズの詳細ページの請求の段から）';
  if (err) s.rowErr.set(tkKey(it), err);
  if (!tkAlive(s)) return;
  s.loading = false;
  await tkLoad(s.seq);
  if (err && tk === s) { s.rowErr.set(tkKey(it), err); tkRender(); }
}

function bindTasks() {
  $('tasks-retry').addEventListener('click', () => openTasks());
  $('tasks-mine').addEventListener('click', () => {
    tkMineOnly = !tkMineOnly;
    if (tk) { tk.notice = ''; if (!tk.busy.size) tk.bill = null; }
    tkRender();
  });
  const b = $('case-tasks');
  if (b) b.addEventListener('click', () => { location.hash = '#tasks'; });
}
