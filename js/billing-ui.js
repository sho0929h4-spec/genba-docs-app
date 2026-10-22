// js/billing-ui.js — 請求の一覧（#billing）… openBilling()
// 対応フェーズ Task 7。月を選ぶ（前月・今月・翌月）→ 月ごと（monthly）の元請ごとにその月のフェーズと合計、単発（single）は完了した月で一覧。
// 「まとめて請求した」（月ごとのグループ単位）・各行の「請求した」「入金確認」。直前の操作は「元に戻す」で取り消せる。請求書PDFは作らない。
// 集計は PhaseLogic.groupBilling（case_summaries の phases から）、記録は PhasesApi.setBilled / setPaid（タイムラインへ自動記録）。
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。alert/confirm は使わない
// mk() は case-list.js、dBtn / errText は case-detail.js、showScreen / renderHeaders / $ は app.js

let bl = null;          // { seq, ym, rows, loading, err, busy: Set, undo: { label, kind, items }|null, msg, form: { key, items, label, note }|null }
let blSeq = 0;
let blMonth = '';       // 最後に見た月（'YYYY-MM'。画面を開き直しても同じ月）


async function openBilling() {
  renderHeaders();
  showScreen('billing');
  if (!blMonth) blMonth = PhaseLogic.jstYm(new Date());
  const seq = ++blSeq;
  bl = { seq, ym: blMonth, rows: [], loading: true, err: '', busy: new Set(), undo: null, msg: '', form: null };
  blRender();
  await blLoad(seq);
}

async function blLoad(seq) {
  let rows = [], err = '';
  try { rows = (await CasesApi.listSummaries()) || []; }
  catch (e) { err = '請求の一覧を読み込めませんでした: ' + errText(e); }
  if (!bl || bl.seq !== seq || seq !== blSeq) return;
  Object.assign(bl, { rows, loading: false, err });
  blRender();
}

function blGo(delta) {
  if (!bl) return;
  blMonth = delta === 0 ? PhaseLogic.jstYm(new Date()) : PhaseLogic.addMonth(bl.ym, delta);
  bl.ym = blMonth;
  bl.undo = null;
  bl.msg = '';
  bl.form = null;
  blRender();
}

const blKey = it => it.phase.id;
function blInfo(it, note) {
  return { phase: it.phase, title: it.title, amount: it.amount, billTo: it.billTo, note }; // 記録はその案件のタイムラインなので物件名は付けない
}

// 記録の共通: items をまとめて on/off。成功したら読み込み直して「元に戻す」を出す
//   due: 「請求した」ときの入金期限（'YYYY-MM-DD'|null）
async function blAct(kind, items, on, label, note, due) {
  const s = bl;
  if (!s || !items.length || items.some(it => s.busy.has(blKey(it)))) return;
  items.forEach(it => s.busy.add(blKey(it)));
  s.msg = '';
  blRender();
  const fn = kind === 'paid' ? PhasesApi.setPaid : PhasesApi.setBilled;
  let rows = [], err = '';
  try { rows = await fn(items.map(it => blInfo(it, note)), on, due); }
  catch (e) { err = label + 'を記録できませんでした: ' + errText(e); }
  if (bl !== s) return;
  items.forEach(it => s.busy.delete(blKey(it)));
  if (!err && rows.length === 0) err = '記録できませんでした（ほかの人が先に記録した可能性があります。表示を更新しました）';
  const done = items.filter(it => rows.some(r => r.id === it.phase.id));
  s.undo = !err && on ? { label, kind, items: done } : null;
  s.msg = err || (on ? '' : label + 'を取り消しました');
  s.err = '';
  if (!err) s.form = null;
  await blLoad(s.seq);
}

// 直前の記録を取り消す（請求 → billed_at を戻す。入金確認済みは戻さない／入金確認 → paid_at を戻す）
function blUndo() {
  const s = bl;
  if (!s || !s.undo) return;
  return blAct(s.undo.kind, s.undo.items, false, s.undo.label);
}

// 「請求した」の前に入金期限を入れる欄（初期値: 月ごと=請求月の翌月末・単発=請求日の30日後。変えられる）
function blOpenForm(key, items, label, note) {
  if (!bl) return;
  bl.form = { key, items, label, note };
  bl.msg = '';
  blRender();
  const i = document.querySelector('#billing-root .bl-due-input');
  if (i) i.focus();
}
function blFormEl(f) {
  const box = mk('div', 'ph-form bl-form');
  const input = document.createElement('input');
  input.type = 'date';
  input.className = 'bl-due-input';
  input.value = PhaseLogic.paymentDueDefault(f.items[0].phase, new Date());
  const l = mk('label', null, '入金期限');
  l.appendChild(input);
  box.appendChild(l);
  box.appendChild(mk('div', 'ph-sub', '初期値: ' + (f.items[0].phase.billing_mode === 'monthly' ? '請求月の翌月末' : '請求日の30日後') + '（変えられます）'));
  const err = mk('div', 'err');
  const acts = mk('div', 'ph-acts');
  acts.appendChild(dBtn('やめる', 'btn sm ghost inline bl-form-cancel', () => { bl.form = null; blRender(); }));
  const ok = dBtn('請求した（記録する）', 'btn sm inline bl-form-ok', () => {
    const v = input.value;
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { err.textContent = '入金期限の日付を正しく入れてください'; input.focus(); return; }
    return blAct('billed', f.items, true, f.label, f.note, v || null);
  });
  ok.disabled = f.items.some(it => bl.busy.has(blKey(it)));
  acts.appendChild(ok);
  box.append(acts, err);
  return box;
}

// 1行（フェーズ）。showBill: 単発の行は「請求した」も出す（月ごとはまとめて）
function blItemEl(it, showBill) {
  const row = mk('div', 'bl-item');
  row.dataset.phaseId = it.phase.id;
  row.dataset.status = it.status;
  const left = mk('div', 'bl-l');
  const top = mk('div', 'bl-top');
  const name = dBtn(it.caseName || '（物件名なし）', 'linkbtn bl-case', () => { location.hash = '#case/' + it.caseRow.id; });
  top.appendChild(name);
  top.appendChild(phBillTag(it.phase));
  left.appendChild(top);
  const sub = [it.title];
  if (showBill) sub.push('請求先 ' + it.billTo);
  if (it.doneAt) sub.push('完了 ' + PhaseLogic.fmtMD(it.doneAt));
  if (it.phase.billed_at) sub.push('請求 ' + PhaseLogic.fmtMD(it.phase.billed_at));
  if (it.phase.paid_at) sub.push('入金 ' + PhaseLogic.fmtMD(it.phase.paid_at));
  left.appendChild(mk('div', 'rep-sub bl-sub', sub.join(' ・ ')));
  if (it.paymentDue && !it.phase.paid_at) {
    // 期限超過は行の印（入金期限超過）と赤い文字で示す
    left.appendChild(mk('div', 'bl-due' + (it.overdue ? ' over' : ''), '入金期限 ' + PhaseLogic.fmtYmdMD(it.paymentDue) + (it.overdue ? '（超過）' : '')));
  }
  row.appendChild(left);
  const right = mk('div', 'bl-r');
  right.appendChild(mk('b', 'bl-yen num' + (it.amount == null ? ' none' : ''), it.amount == null ? '金額未定' : PhaseLogic.yen(it.amount)));
  const busy = bl.busy.has(blKey(it));
  const formOpen = bl.form && bl.form.key === it.phase.id;
  if (it.status === 'unbilled' && showBill && !formOpen) {
    const b = dBtn('請求した', 'btn sm inline bl-bill', () => blOpenForm(it.phase.id, [it], '「' + it.caseName + ' ' + it.title + '」の請求'));
    b.disabled = busy;
    right.appendChild(b);
  } else if (it.status === 'billed') {
    const b = dBtn('入金確認', 'btn sm inline bl-paid', () => blAct('paid', [it], true, '「' + it.caseName + ' ' + it.title + '」の入金確認'));
    b.disabled = busy;
    right.appendChild(b);
  }
  row.appendChild(right);
  if (formOpen) {
    const f = blFormEl(bl.form);
    f.classList.add('bl-form-row');
    row.appendChild(f);
  }
  return row;
}

function blGroupEl(g, ym) {
  const card = mk('div', 'rep-card bl-group');
  card.dataset.clientId = g.clientId || '';
  card.dataset.status = g.status;
  const hd = mk('div', 'bl-gh');
  hd.appendChild(mk('b', 'bl-gname', (g.clientName || '（元請未設定）') + '（月ごと）'));
  const over = g.items.some(it => it.overdue);
  const tag = mk('span', 'bl-tag ' + (over ? 'over' : g.status), over ? '入金期限超過' : BL_STATUS_LABEL[g.status]);
  tag.dataset.status = over ? 'overdue' : g.status;
  hd.appendChild(tag);
  card.appendChild(hd);
  g.items.forEach(it => card.appendChild(blItemEl(it, false)));
  const tot = mk('div', 'bl-total');
  tot.appendChild(mk('span', null, PhaseLogic.ymLabel(ym) + '分 合計' + (g.unknown ? '（金額未定 ' + g.unknown + '件を除く）' : '')));
  tot.appendChild(mk('b', 'bl-yen num', PhaseLogic.yen(g.total)));
  card.appendChild(tot);
  const unbilled = g.items.filter(it => it.status === 'unbilled');
  const gkey = 'g:' + (g.clientId || g.clientName) + ':' + ym;
  if (unbilled.length && bl.form && bl.form.key === gkey) {
    card.appendChild(blFormEl(bl.form));
  } else if (unbilled.length) {
    const acts = mk('div', 'bl-acts');
    const label = '「' + (g.clientName || '元請') + ' ' + PhaseLogic.ymLabel(ym) + '分（' + unbilled.length + '件）」の請求';
    const b = dBtn('まとめて「請求した」（' + unbilled.length + '件）', 'btn sm inline bl-bill-all',
      () => blOpenForm(gkey, unbilled, label, Number(ym.slice(5, 7)) + '月分まとめて'));
    b.disabled = unbilled.some(it => bl.busy.has(blKey(it)));
    acts.appendChild(b);
    card.appendChild(acts);
  }
  return card;
}

function blRender() {
  const root = $('billing-root');
  if (!root || !bl) return;
  const nodes = [dBtn('← 案件一覧', 'back', () => openCases())];
  nodes.push(mk('h2', 'ob-h', '請求の一覧'));
  nodes.push(mk('div', 'rep-sub ob-lead', '月ごとの元請はその月の分をまとめて、単発は工事が完了した月に出ます。' +
    '請求書はここでは作りません。この一覧を見ながら請求書を作り、「請求した」「入金確認」を記録してください（各案件のタイムラインにも残ります）'));

  const nav = mk('div', 'bl-nav');
  nav.appendChild(dBtn('‹ 前月', 'btn sm ghost inline bl-prev', () => blGo(-1)));
  const cur = mk('b', 'bl-month', PhaseLogic.ymLabel(bl.ym));
  cur.id = 'billing-month';
  cur.setAttribute('aria-live', 'polite');
  nav.appendChild(cur);
  nav.appendChild(dBtn('翌月 ›', 'btn sm ghost inline bl-next', () => blGo(1)));
  const today = dBtn('今月', 'linkbtn bl-today', () => blGo(0));
  today.disabled = bl.ym === PhaseLogic.jstYm(new Date());
  nav.appendChild(today);
  nodes.push(nav);

  const msg = mk('div', 'ob-msg bl-msg');
  msg.id = 'billing-msg';
  msg.setAttribute('role', 'status');
  if (bl.undo) {
    msg.appendChild(mk('span', null, bl.undo.label + 'を記録しました'));
    const u = dBtn('元に戻す', 'linkbtn bl-undo', () => blUndo());
    u.disabled = bl.undo.items.some(it => bl.busy.has(blKey(it)));
    msg.appendChild(u);
  } else if (bl.msg) {
    msg.appendChild(mk('span', /できません/.test(bl.msg) ? 'bl-err' : null, bl.msg));
  }
  nodes.push(msg);

  if (bl.loading) nodes.push(mk('div', 'empty', '読み込み中…'));
  else if (bl.err) {
    nodes.push(mk('div', 'err', bl.err));
    nodes.push(dBtn('再読み込み', 'btn sm ghost inline', () => openBilling()));
  } else {
    const g = PhaseLogic.groupBilling(bl.rows, bl.ym, new Date());
    const all = g.monthly.flatMap(x => x.items).concat(g.single);
    const count = st => all.filter(it => it.status === st).length;
    const sum = mk('div', 'rep-card bl-sum');
    sum.id = 'billing-summary';
    const l1 = mk('div', 'bl-total');
    l1.appendChild(mk('span', null, PhaseLogic.ymLabel(bl.ym) + 'の請求 合計'));
    l1.appendChild(mk('b', 'bl-yen num', PhaseLogic.yen(g.total)));
    sum.appendChild(l1);
    const unknown = all.filter(it => it.amount == null).length;
    sum.appendChild(mk('div', 'rep-sub', `未請求 ${count('unbilled')}件 ・ 入金待ち ${count('billed')}件 ・ 入金済み ${count('paid')}件` +
      (unknown ? ` ・ 金額未定 ${unknown}件（合計に入っていません）` : '')));
    const over = all.filter(it => it.overdue).length;
    if (over) sum.appendChild(mk('div', 'bl-due over', '入金期限超過 ' + over + '件'));
    nodes.push(sum);

    nodes.push(mk('h3', 'bl-h', '月ごと（元請ごとにまとめて請求）'));
    if (!g.monthly.length) nodes.push(mk('div', 'bl-empty', 'この月の月ごとの請求はありません'));
    g.monthly.forEach(x => nodes.push(blGroupEl(x, bl.ym)));

    nodes.push(mk('h3', 'bl-h', '単発（案件ごと・完了した月）'));
    if (!g.single.length) nodes.push(mk('div', 'bl-empty', 'この月に完了した単発の請求はありません'));
    else {
      const card = mk('div', 'rep-card bl-single');
      g.single.forEach(it => card.appendChild(blItemEl(it, true)));
      nodes.push(card);
    }
  }
  root.replaceChildren(...nodes);
}

function bindBilling() {
  document.querySelectorAll('.js-open-billing').forEach(b => b.addEventListener('click', () => { location.hash = '#billing'; }));
}
