// js/estimate-ui.js — 見積書の画面
//   ⑬ 案件内の見積書一覧（#case/{id}/estimates） … openEstimates(caseId)
//   ⑭ 作成・編集（#estimate/{id}）               … openEstimate(id)
//   ⑮ PDFプレビュー（#estimate/{id}/pdf）         … openEstimatePdf(id)
//   ⑯ 版の差分（#estimate/{id}/diff）             … openEstimateDiff(id)（前の版と比べた追加・削除・金額変更と合計差）
// 提出済み以降の版には操作カード（依頼者へ送付・承諾された・減額対応で新しい版を作る・前の版との差分）を出す。
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。alert は使わない（画面内に出す）。
// mk() は case-list.js、dBtn / errText / currentCase は case-detail.js、showScreen / renderHeaders / setMsg / $ は app.js のものを使う
// 計算・文言は EstimateLogic、DB は EstimatesApi（版管理・送付・承諾は Task 5 でこの画面に足す）、紙面は EstimatePdf。
// 「よく使う明細」（定型・Task 11 / Task 22）は js/estimate-presets.js（明細の下のボタン列＝唯一の追加候補・行の「…」→ 登録・編集シート）。
//
// 編集は draft のみ。提出済み以降（issued/sent/accepted/superseded）は読み取り専用で表示する。
// 画面の並び（PC 1100px以上=上のバー＋左 入力／右 紙面、未満=1段＋紙面の折りたたみ）は js/estimate-layout.js（Task 15）。
// 明細はコンパクトな表（1つの DOM を CSS で切り替え: 640px以上=1行2段、未満=摘要・詳細の下に数量・単位・金額）。
// 並び替えは 1100px以上=⠿ のドラッグ（↑↓キーでも可）、未満=↑↓。金額が正、単価は表示だけ（EstimateLogic.unitPrice）。
// 諸経費の自動行・「税込合計を00に」の値引き行は EstimatesApi.normalizeLines で毎回取り直す（保存時と同じ計算）。
// 自動保存: 入力から1.5秒で EstimatesApi.save（data と lines。lines は正規化して合計と一緒に送られる）。
//   同時に localStorage `estimate-draft-{id}` へ退避（base = 読み込み時のサーバー updated_at）。
//   開いたとき base とサーバーの updated_at が同じ（または送信中だった中身 p がサーバーと同じ）なら復元して保存し直す。
//   Task 61: それ以外でサーバーと中身が違えば、どちらを使うか聞く（askLocalDraft。勝手に捨てない・勝手に上書きしない）。
//   hashchange / beforeunload / pagehide（iPhone は beforeunload が来ない）/ 非表示化 / PDFプレビュー / 提出の前に、保留中の保存を flush する。
// 世代番号: 一覧 eulSeq・編集 eueSeq・PDF eupSeq。古い応答は捨てる。保存は1見積につき直列（s.chain）。
// Task 36: 現場用（fieldHidesAdmin）で開いたときだけ、入力パネルの一番上に「調査の内容」の折りたたみ欄（js/survey-view.js）。
//   どの調査かは PhaseLogic.estimateSurvey（報告書は ReportsApi.listByCase）。ページへ移る前に flush。管理画面では読み込みもしない

const EU_UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
// app.js より先に読み込まれるので、ルーターが使う正規表現はここで定義する
const ESTIMATES_HASH_RE = new RegExp('^#case/' + EU_UUID + '/estimates$', 'i');
const ESTIMATE_HASH_RE = new RegExp('^#estimate/' + EU_UUID + '$', 'i');
const ESTIMATE_PDF_HASH_RE = new RegExp('^#estimate/' + EU_UUID + '/pdf$', 'i');
const ESTIMATE_DIFF_HASH_RE = new RegExp('^#estimate/' + EU_UUID + '/diff$', 'i');
const EU_DELAY = 1500;
const EU_STATUS = {
  draft: ['下書き', 'p-draft'], issued: ['提出済み', 'p-wait'], sent: ['送付済み', 'p-sent'],
  accepted: ['承諾', 'p-ok'], superseded: ['旧版', 'p-old']
};
const EU_UNITS = ['式', '日', '台', '㎡', 'm', '箇所', '枚', '本', '個', '人工', '回', 'セット'];
const euKey = id => 'estimate-draft-' + id;
const euClone = v => JSON.parse(JSON.stringify(v));
const euObj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const euStr = v => (v == null ? '' : String(v));
const euYen = n => EstimateLogic.yen(n);

function euPill(status) {
  const p = EU_STATUS[status] || [status || '', 'p-draft'];
  return mk('span', 'rep-pill ' + p[1], p[0]);
}
// seriesNumber: 未提出の v2 以降で、系列の番号（v1 の EST-…）を見せるため
function euNumberText(est, seriesNumber) {
  const n = EstimatesApi.displayNumber(est);
  if (n) return n;
  const v = Number(est && est.version) || 1;
  if (seriesNumber && v >= 2) return seriesNumber + '-v' + v + '（提出時に確定）';
  return '番号なし（提出すると付きます）';
}
// 数字の入力文字列を半角に（全角数字・全角小数点・全角マイナス・カンマ・円記号・空白）
function euNormNum(v) {
  return euStr(v).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[．。]/g, '.').replace(/[－−ー‐]/g, '-').replace(/[,，¥￥円\s]/g, '');
}
// ％の入力 → 0以上の数（正しくなければ NaN）
function euParsePct(v) {
  const t = euNormNum(v).replace(/[%％]/g, '');
  if (!/^\d*\.?\d*$/.test(t) || !/\d/.test(t)) return NaN;
  return Number(t);
}
// 安定した JSON（キー順をそろえる。jsonb はキー順を保たないため、退避と DB の内容を比べるときに使う）
// 見積の利益率の初期値: 保存済みの値 → 会社設定の既定値（orgs.default_margin_pct）→ 0
function euMarginOf(row) {
  const own = row && row.margin_pct != null ? EstimateLogic.normMargin(row.margin_pct) : null;
  if (own !== null) return own;
  const def = typeof ctx !== 'undefined' && ctx && ctx.org && ctx.org.default_margin_pct != null ? EstimateLogic.normMargin(ctx.org.default_margin_pct) : null;
  return def !== null ? def : 0;
}
function euStable(v) {
  if (Array.isArray(v)) return '[' + v.map(euStable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + euStable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

/* ======================= ⑬ 案件内の見積書一覧 ======================= */
let eulCaseId = null;
let eulSeq = 0;
let eulSummary = null;
let eulSeries = [];
let eulBusy = false;

function eulMessage(text, isErr, retryId) {
  const fb = (typeof fieldBack === 'function' ? fieldBack(eulCaseId) : null); // 現場用から開いたときは「‹ ツール」（js/field-ui.js。Task 18）
  const nodes = [dBtn(fb ? fb.label : '← 案件へ', 'back', () => { location.hash = fb ? fb.hash : '#case/' + eulCaseId; })];
  nodes.push(mk('div', isErr ? 'err' : 'empty', text));
  if (retryId) nodes.push(dBtn('再読み込み', 'btn sm ghost inline', () => eulLoad(retryId)));
  $('estimates-root').replaceChildren(...nodes);
}

// location.hash の変更 → hashchange → routeFromHash → openEstimates が2回走るので、同じ案件を表示中/読み込み中なら何もしない
function openEstimates(caseId) {
  if (!caseId) return;
  if (eulCaseId === caseId && $('screen-estimates').classList.contains('active')) return;
  showScreen('estimates');
  renderHeaders();
  const h = '#case/' + caseId + '/estimates';
  if (location.hash.toLowerCase() !== h) location.hash = h;
  return eulLoad(caseId);
}

async function eulLoad(caseId) {
  const seq = ++eulSeq;
  eulCaseId = caseId;
  eulSummary = null;
  eulSeries = [];
  eulBusy = false;
  eulMessage('読み込み中…', false);
  let res;
  try {
    res = await Promise.all([CasesApi.getSummary(caseId), EstimatesApi.listByCase(caseId)]);
  } catch (e) {
    if (seq !== eulSeq) return;
    eulMessage('見積書の読み込みに失敗しました: ' + errText(e), true, caseId);
    return;
  }
  if (seq !== eulSeq) return;
  if (!res[0]) { eulMessage('案件が見つかりません', false); return; }
  eulSummary = res[0];
  eulSeries = res[1] || [];
  eulBuild();
}

function eulBuild() {
  const head = mk('div', 'rep-between');
  head.appendChild(mk('h3', null, '見積書'));
  const cnt = mk('span', 'rep-sub', 'この案件の見積書 ' + eulSeries.length + '件');
  cnt.id = 'eul-count';
  head.appendChild(cnt);
  const acts = mk('div', 'rep-acts rep-top-acts');
  const create = dBtn('＋ 見積書を作成', 'btn inline', () => eulCreate());
  create.id = 'eul-create';
  acts.appendChild(create);
  const note = mk('div', 'rep-sub', '宛名は元請、件名は物件名が入った状態で作られます。提出すると見積番号が付きます');
  const err = mk('div', 'err');
  err.id = 'eul-err';
  const list = mk('div');
  list.id = 'eul-list';
  if (!eulSeries.length) list.appendChild(mk('div', 'empty', 'この案件の見積書はまだありません'));
  else eulSeries.forEach(s => list.appendChild(eulSeriesEl(s)));
  const card = mk('div', 'rep-card');
  card.append(head, acts, note, err, list);
  const fb = (typeof fieldBack === 'function' ? fieldBack(eulCaseId) : null);
  const back = dBtn(fb ? fb.label : '← ' + (eulSummary ? eulSummary.name : '案件へ'), 'back', () => { location.hash = fb ? fb.hash : '#case/' + eulCaseId; });
  $('estimates-root').replaceChildren(back, card);
}

// 系列カード: 番号・件名・最新版の状態と金額・版の履歴（古い版から。v2 以降は前版比）
function eulSeriesEl(s) {
  const L = s.latest;
  const box = mk('div', 'eu-series');
  box.dataset.series = s.series_id;
  const h = mk('div', 'eu-series-h');
  const left = mk('div');
  left.appendChild(mk('div', 'eu-series-no', EstimatesApi.displayNumber(L) || '未提出'));
  left.appendChild(mk('div', 'eu-series-ttl', euStr(L.data && L.data.subject) || '件名未入力'));
  const sub = mk('div', 'rep-sub', '宛名: ' + (euStr(L.data && L.data.client) || '未入力') + (L.data && L.data.issueDate ? ' ・ 見積日 ' + L.data.issueDate : ''));
  left.appendChild(sub);
  const right = mk('div');
  right.style.textAlign = 'right';
  right.appendChild(euPill(L.status));
  // Task 35: 再編集の印（一覧）
  const rm = PhaseLogic.reeditMark(L);
  if (rm && rm.short) { const t = mk('span', 'reedit-tag eu-reedit-tag', rm.short); t.title = rm.text; right.appendChild(t); }
  right.appendChild(mk('div', 'eu-series-amt eu-num', euYen(L.total)));
  h.append(left, right);
  box.appendChild(h);

  const vers = mk('div', 'eu-vers');
  const asc = s.versions.slice().sort((a, b) => (Number(a.version) || 0) - (Number(b.version) || 0));
  asc.forEach((v, i) => {
    const vr = mk('div', 'eu-ver-row');
    const b = mk('button', 'eu-ver');
    b.type = 'button';
    b.dataset.id = v.id;
    b.append(mk('span', null, 'v' + v.version), mk('b', null, euYen(v.total)));
    if (i > 0) {
      const d = (Number(v.total) || 0) - (Number(asc[i - 1].total) || 0);
      const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
      b.appendChild(mk('span', 'eu-diff' + (d < 0 ? ' down' : d > 0 ? ' up' : ''), '（前版比 ' + sign + '¥' + EstimateLogic.fmt(Math.abs(d)) + '）'));
    }
    b.appendChild(euPill(v.status));
    b.addEventListener('click', () => { location.hash = '#estimate/' + v.id; });
    vr.appendChild(b);
    if (i > 0) {
      const d = dBtn('差分', 'btn sm ghost inline eu-ver-diff', () => { location.hash = '#estimate/' + v.id + '/diff'; });
      d.setAttribute('aria-label', 'v' + asc[i - 1].version + ' と v' + v.version + ' の差分');
      d.dataset.id = v.id;
      vr.appendChild(d);
    }
    vers.appendChild(vr);
  });
  box.appendChild(vers);
  const acts = mk('div', 'rep-acts');
  acts.style.marginTop = '8px';
  acts.appendChild(dBtn(L.status === 'draft' ? '開いて編集' : '開く', 'btn sm inline', () => { location.hash = '#estimate/' + L.id; }));
  box.appendChild(acts);
  return box;
}

async function eulCreate() {
  if (eulBusy) return;
  const id = eulCaseId;
  eulBusy = true;
  const btn = $('eul-create');
  if (btn) btn.disabled = true;
  setMsg('eul-err', '');
  let made = null, msg = '';
  try { made = await EstimatesApi.create(id, eulSummary); }
  catch (e) { msg = '作成に失敗しました: ' + errText(e); }
  eulBusy = false;
  if (id !== eulCaseId) return;
  if (btn) btn.disabled = false;
  if (made && made.id) { location.hash = '#estimate/' + made.id; return; }
  setMsg('eul-err', msg);
}

/* ======================= ⑭ 作成・編集 ======================= */
let eue = null;     // 表示中の編集セッション
let eueFlash = null; // Task 35: 開き直した画面に出すお知らせ { id, text }（再編集・前の版に戻したあと）
let eueSeq = 0;
let eueUid = 0;

/* ---------- localStorage（使えない環境でも画面は動かす） ---------- */
function eueLsGet(id) {
  try {
    const o = JSON.parse(localStorage.getItem(euKey(id)));
    return o && typeof o === 'object' && o.d && typeof o.d === 'object' && Array.isArray(o.l) ? o : null;
  } catch (e) { return null; }
}
// p: 送信中の保存の中身。送信中に入力→タブを閉じると、サーバーの updated_at は base より進むが中身は p と同じ。
//    次に開いたとき、base が違っても DB の内容が p と同じなら「自分の保存が届いた後の入力」として復元する
function eueLsSet(s) {
  try { localStorage.setItem(euKey(s.id), JSON.stringify({ t: Date.now(), base: s.row.updated_at || null, d: s.data, l: s.lines, m: s.margin, pdf: s.sourcePdf || null, p: s.inflight || null })); }
  catch (e) { /* 容量不足など。サーバ保存が本線 */ }
}
function eueLsDel(id) { try { localStorage.removeItem(euKey(id)); } catch (e) { /* 何もしない */ } }
function eueSameStamp(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const x = Date.parse(a), y = Date.parse(b);
  return Number.isFinite(x) && x === y;
}

/* ---------- data / lines の正規化 ---------- */
function eueNormData(raw) {
  const d = Object.assign({}, euObj(raw));
  ['client', 'subject', 'manager', 'issueDate', 'validUntil'].forEach(k => { d[k] = euStr(d[k]); });
  d.honorific = d.honorific === '様' ? '様' : '御中';
  const base = EstimateLogic.defaultNotes();
  const n = euObj(d.notes);
  d.notes = {
    koki: Object.assign({}, base.koki, euObj(n.koki)),
    jikan: Object.assign({}, base.jikan, euObj(n.jikan)),
    // Task 48 E: ホテル移動・荷物の片付け（必要／不要）。前からある「荷物の移動依頼」のチェックは 片付け 必要（場所なし）に置き換える
    hotel: n.hotel === 'need' || n.hotel === 'none' ? n.hotel : '',
    katazuke: (k => ({ sel: k.sel === 'need' || k.sel === 'none' ? k.sel : euObj(n.nimotsu).on ? 'need' : '',
      places: (Array.isArray(k.places) ? k.places : []).filter(p => EstimateLogic.KATAZUKE_PLACES.includes(p)), free: euStr(k.free) }))(euObj(n.katazuke)),
    extra: euStr(n.extra)
  };
  ['koki', 'jikan'].forEach(k => { d.notes[k].on = !!d.notes[k].on; d.notes[k].val = euStr(d.notes[k].val); });
  return d;
}
function eueNormLines(raw) {
  const ls = (Array.isArray(raw) ? raw : []).map(l => Object.assign({}, euObj(l)));
  ls.forEach(l => { if (!l.id) l.id = EstimateLogic.newLine().id; });
  return EstimatesApi.normalizeLines(ls.length ? ls : [EstimateLogic.newLine()]);
}
const eueIsAdj = l => EstimateLogic.isAdjustLine(l); // 「税込合計を00に」の調整行（内部フラグ isAdjust）

// 退避した「送信中の保存」の中身が DB の内容と同じか（＝その保存は届いていて、その後の入力だけが端末に残っている）
function eueSameContent(p, row) {
  if (!p || typeof p !== 'object' || !p.d || !Array.isArray(p.l) || !row) return false;
  try {
    return euStable(eueNormData(p.d)) === euStable(eueNormData(row.data)) &&
      euStable(EstimatesApi.normalizeLines(p.l)) === euStable(EstimatesApi.normalizeLines(row.lines));
  } catch (e) { return false; }
}

/* ---------- 保存 ---------- */
function eueSetSave(s, state) {
  s.saveState = state;
  const el = s.els.save;
  if (!el) return;
  s.els.retry.hidden = state !== 'error';
  el.className = 'rep-save' + (state === 'saved' ? '' : state === 'error' || state === 'invalid' ? ' err' : ' busy');
  const p = n => String(n).padStart(2, '0');
  if (state === 'pending') el.textContent = '保存待ち…';
  else if (state === 'saving') el.textContent = '保存中…';
  else if (state === 'saved') { const d = s.lastSaved || new Date(); el.textContent = '保存しました ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  else if (state === 'error') el.textContent = '保存できませんでした: ' + (s.saveErr || '');
  else if (state === 'invalid') el.textContent = s.saveErr || '入力に誤りがあるため保存していません';
  else if (state === 'restored') el.textContent = '前回の未保存の入力を復元しました';
  else el.textContent = '';
}

// 保存できない入力（DB が拒否するもの）。問題が無ければ ''
function eueBlocker(s) {
  if (EstimateLogic.totals(s.lines).subtotal < 0) return '小計がマイナスのため保存していません（金額を見直してください）';
  return '';
}

function eueChanged(s) {
  s.rev++;
  s.dirty = true;
  eueDisarmIssue(s);
  eueLsSet(s);
  if (s.els.val && s.els.val.firstChild) s.els.val.replaceChildren();
  EstimateLayout.changed(s); // 紙面プレビューは 300ms 後に描き直す
  eueSetSave(s, 'pending');
  clearTimeout(s.timer);
  s.timer = setTimeout(() => eueFlush(s), EU_DELAY);
}

// 保留中の保存を今すぐ実行し、終わるまで待つ（保存は直列。失敗しても throw しない: s.dirty が残る）
function eueFlush(s) {
  clearTimeout(s.timer);
  s.timer = null;
  s.chain = s.chain.then(() => eueDoSave(s)).catch(e => {
    s.dirty = true;
    s.saveErr = errText(e);
    eueSetSave(s, 'error');
  });
  return s.chain;
}
async function eueDoSave(s) {
  if (!s.dirty || s.readOnly) return;
  const bad = eueBlocker(s);
  if (bad) { s.saveErr = bad; eueSetSave(s, 'invalid'); return; }
  const data = euClone(s.data);
  const lines = euClone(s.lines);
  s.dirty = false;
  s.inflight = { d: data, l: lines };
  eueLsSet(s); // Task 61: 送信中の中身も退避（届いた後にページが閉じても、開き直したとき「自分の保存」と分かる）
  eueSetSave(s, 'saving');
  try {
    // amount 整数・postTax boolean・cost 整数に正規化して合計と送る。利益率と業者PDFの保存先も一緒に（Task 19）
    const row = await EstimatesApi.save(s.id, { data, lines, margin_pct: s.margin, source_pdf_path: s.sourcePdf || null });
    s.inflight = null;
    s.row = Object.assign({}, s.row, row);
    s.lastSaved = new Date();
    // 保存中にさらに入力があった: 退避の base を保存後の updated_at に合わせる（古い base のままだと次回「他で更新」と判定され消える）
    if (s.dirty) { eueLsSet(s); eueSetSave(s, 'pending'); }
    else { eueLsDel(s.id); eueSetSave(s, 'saved'); }
  } catch (e) {
    s.inflight = null;
    if (s.dirty) eueLsSet(s);
    s.dirty = true;
    s.saveErr = errText(e);
    eueSetSave(s, 'error');
  }
}

window.addEventListener('hashchange', () => {
  const s = eue;
  if (!s) return;
  if (s.dirty) eueFlush(s);
  if (!ESTIMATE_HASH_RE.test(location.hash)) s.left = true;
});
['beforeunload', 'pagehide'].forEach(t => window.addEventListener(t, () => { if (eue && eue.dirty) eueFlush(eue); }));
document.addEventListener('visibilitychange', () => { if (document.hidden && eue && eue.dirty) eueFlush(eue); });

/* ---------- 部品 ---------- */
function eueId(p) { return p + '-' + (++eueUid); }
function eueField(label, control, hint) {
  const wrap = mk('div', 'rep-ff');
  if (!control.id) control.id = eueId('eu-auto');
  const l = mk('label', null, label);
  l.htmlFor = control.id;
  wrap.appendChild(l);
  if (hint) wrap.appendChild(mk('span', 'rep-hint', hint));
  wrap.appendChild(control);
  return wrap;
}
function eueInput(id, type, value, onInput, extra) {
  const i = document.createElement('input');
  i.type = type;
  if (id) i.id = id;
  i.value = value == null ? '' : value;
  const x = extra || {};
  if (x.placeholder) i.placeholder = x.placeholder;
  if (x.inputMode) i.inputMode = x.inputMode;
  if (x.maxLength) i.maxLength = x.maxLength;
  if (x.list) i.setAttribute('list', x.list);
  if (type === 'text') i.autocomplete = 'off';
  i.addEventListener('input', () => onInput(i.value, i));
  if (type !== 'text') i.addEventListener('change', () => onInput(i.value, i));
  return i;
}
function eueCheck(id, label, checked, onChange) {
  const l = mk('label', 'nu-chk');
  l.htmlFor = id;
  const i = document.createElement('input');
  i.type = 'checkbox';
  i.id = id;
  i.checked = !!checked;
  i.addEventListener('change', () => onChange(i.checked));
  l.append(i, mk('span', null, label));
  return l;
}
// 金額の入力文字列 → 整数（全角・カンマ・円記号を許す）。数字が無ければ 0
function euParseAmount(v) {
  const t = euNormNum(v);
  if (!/^-?\d*\.?\d*$/.test(t) || !/\d/.test(t)) return 0;
  const n = Math.round(Number(t));
  return Number.isFinite(n) ? n : 0;
}
function euParseQty(v) {
  const t = euNormNum(v);
  if (t === '') return '';
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

/* ---------- 画面の組み立て ---------- */
function eueBuild(s) {
  const els = s.els, d = s.data, ro = s.readOnly;
  const set = fn => { fn(d); eueChanged(s); };

  const top = mk('div', 'rep-between rep-ed-top');
  const fb = (typeof fieldBack === 'function' ? fieldBack(s.row.case_id) : null); // 現場用から開いたときは「‹ ツール」（js/field-ui.js。Task 18）
  els.back = dBtn(fb ? fb.label : '← 見積書一覧', 'back', async () => {
    if (s.busy) return;
    await eueFlush(s);
    location.hash = fb ? fb.hash : '#case/' + s.row.case_id + '/estimates';
  });
  top.appendChild(els.back);
  CaseBand.attach(top, els.back, s.caseRow).id = 'eu-place'; // Task 30: 物件名と号室の帯
  const saveBox = mk('div', 'rep-acts');
  els.save = mk('span', 'rep-save');
  els.save.id = 'eu-save';
  els.save.setAttribute('role', 'status');
  els.retry = dBtn('再試行', 'btn sm ghost inline', () => eueFlush(s));
  els.retry.id = 'eu-retry';
  els.retry.hidden = true;
  saveBox.append(els.save, els.retry);
  top.appendChild(saveBox);

  const head = mk('div', 'eu-head');
  const hl = mk('div');
  const no = mk('b', null, euNumberText(s.row, s.seriesNumber));
  no.id = 'eu-number';
  hl.append(no, mk('div', 'rep-sub', '第' + (Number(s.row.version) || 1) + '版 ・ ' + (s.caseRow.name || '')));
  const pill = euPill(s.row.status);
  pill.id = 'eu-status';
  head.append(hl, pill);

  const notice = mk('div', 'rep-sub');
  notice.id = 'eu-notice';
  notice.textContent = s.notice || '';
  notice.hidden = !s.notice;

  // Task 35: 再編集の印（再編集中／再編集あり（いつ・誰が）／再編集 n回）
  const reedit = eueReeditLine(s);

  const roBox = mk('div', 'rep-ro');
  roBox.id = 'eu-ro';
  roBox.textContent = s.row.status === 'superseded'
    ? 'これは古い版です（新しい版に差し替え済み）。表示のみで、編集はできません'
    : '提出済みの見積書は編集できません（表示のみ）。内容を変えるときは新しい版を作ります';
  roBox.hidden = !ro;

  els.val = mk('div', 'rep-val');
  els.val.id = 'eu-val';
  els.val.setAttribute('role', 'alert');

  /* ----- 基本情報 ----- */
  const c1 = mk('div', 'rep-card');
  c1.appendChild(mk('h3', null, '基本情報'));
  const cli = mk('div', 'eu-cli');
  els.client = eueInput('eu-client', 'text', d.client, v => set(x => { x.client = v; }), { placeholder: '例：大京管理 株式会社' });
  els.hon = document.createElement('select');
  els.hon.id = 'eu-honorific';
  [['御中', '御中'], ['様', '様']].forEach(o => els.hon.appendChild(new Option(o[1], o[0])));
  els.hon.value = d.honorific;
  els.hon.addEventListener('change', () => set(x => { x.honorific = els.hon.value; }));
  cli.append(eueField('宛名', els.client, '会社・管理組合は「御中」、個人は「様」'), eueField('敬称', els.hon));
  c1.appendChild(cli);
  els.subject = eueInput('eu-subject', 'text', d.subject, v => set(x => { x.subject = v; }), { placeholder: '例：【〇〇マンション】508号室 復旧工事' });
  c1.appendChild(eueField('件名', els.subject));
  const g = mk('div', 'rep-g2');
  els.issueDate = eueInput('eu-issue-date', 'date', d.issueDate, v => set(x => { x.issueDate = v; }));
  els.validUntil = eueInput('eu-valid-until', 'date', d.validUntil, v => set(x => { x.validUntil = v; }));
  g.append(eueField('見積日', els.issueDate), eueField('有効期限', els.validUntil));
  c1.appendChild(g);
  els.manager = eueInput('eu-manager', 'text', d.manager, v => set(x => { x.manager = v; }), { placeholder: '例：山田' });
  c1.appendChild(eueField('担当者', els.manager));

  /* ----- 明細（並び: 表 → ＋ 行を追加 → よく使う明細 → 税込合計を00に。固定のクイック追加は Task 22 で廃止） ----- */
  const c2 = mk('div', 'rep-card eu-lines-card');
  const c2h = mk('div', 'rep-between');
  c2h.appendChild(mk('h3', null, '明細'));
  if (!ro) c2h.appendChild(mk('span', 'rep-sub', '販売金額を入力（単価は 金額÷数量 で自動）'));
  c2.appendChild(c2h);
  // 業者の見積PDFの読み込み・利益率・粗利の枠（Task 19。js/estimate-import.js）
  const imp = EstimateImport.box(s, {
    apply: parsed => {
      const added = EstimateLogic.importToLines(parsed, s.margin);
      s.lines = EstimateLogic.mergeImported(s.lines, added);
      eueLinesRebuilt(s);
      return added.length;
    },
    source: path => { s.sourcePdf = path; eueChanged(s); }
  });
  if (imp) c2.appendChild(imp);
  c2.appendChild(EstimateImport.marginRow(s, n => {
    s.margin = n;
    s.lines = EstimateLogic.applyMargin(s.lines, n);
    eueLinesChanged(s);
  }));
  c2.appendChild(EstimateImport.profitBox(s));
  const dl = document.createElement('datalist');
  dl.id = 'eu-units';
  EU_UNITS.forEach(u => { const o = document.createElement('option'); o.value = u; dl.appendChild(o); });
  c2.appendChild(dl);
  const lh = mk('div', 'eu-lines-h' + (ro ? ' ro' : ''));
  lh.setAttribute('aria-hidden', 'true'); // 各欄には見えないラベルがある
  // 原価（Task 19）。単価（表示のみ）は2行目の原価の下
  [['', 'h-hd'], ['摘要 ／ 詳細', 'h-desc'], ['数量', 'r'], ['単位', ''], ['原価', 'r h-cost'], ['単価', 'r h-price'], ['販売金額', 'r'], ['', 'h-ops']]
    .forEach(([t, c]) => lh.appendChild(mk('div', c || null, t)));
  c2.appendChild(lh);
  els.lines = mk('div', 'eu-lines' + (ro ? ' ro' : ''));
  els.lines.id = 'eu-lines';
  c2.appendChild(els.lines);
  const add = dBtn('＋ 行を追加', 'eu-add-row', () => eueAddLine(s));
  add.id = 'eu-add-line';
  c2.appendChild(add);

  // よく使う明細（定型・Task 11 / Task 22）: 明細の下の唯一の追加候補（見積のフェーズの種類＋共通のボタン）。読み取り専用では出さない。
  // 固定のクイック追加（現場管理費・交通費・諸経費）は Task 22 で廃止（EstimateLogic.QUICK は残す。既存の諸経費の自動行は表示・再計算だけ続ける）
  if (!ro) c2.appendChild(EstimatePresets.section(s, { add: p => eueAddPreset(s, p) }));
  const q = mk('div', 'eu-quick eu-adj-row');
  els.adj = eueCheck('eu-adjust', '税込合計を00に', s.lines.some(eueIsAdj), on => eueToggleAdjust(s, on));
  els.adj.classList.add('eu-adj-chk');
  els.adj.title = '税込合計の下2桁が00になるよう、端数を値引きの行で調整します（明細を変えると取り直します）';
  q.append(els.adj);
  c2.appendChild(q);
  els.qMsg = mk('div', 'err');
  els.qMsg.id = 'eu-q-msg';
  c2.appendChild(els.qMsg);

  /* ----- 備考（固定の1行目「必須」→ 工期・工事時間・ホテル移動・荷物の片付け → 自由記入） ----- */
  const c3 = mk('div', 'rep-card');
  c3.appendChild(mk('h3', null, '備考'));
  const first = mk('div', 'eu-notes-first');
  first.append(mk('span', 'eu-req', '必須'), mk('span', null, EstimateLogic.NOTE_FIRST));
  c3.appendChild(first);
  const opts = mk('div', 'eu-note-opts');
  const nrow = (key, label, control, wrapper) => {
    const r = mk('div', 'eu-note-row');
    if (ro && !d.notes[key].on) r.hidden = true; // 読み取り専用では使っていない備考の行は出さない
    r.append(eueCheck('eu-note-' + key, label, d.notes[key].on, v => { set(x => { x.notes[key].on = v; }); control.disabled = ro || !v; eueNotesPv(s); }), wrapper || control);
    control.disabled = ro || !d.notes[key].on;
    return r;
  };
  const kokiBox = mk('span', 'eu-note-koki');
  els.koki = eueInput('eu-note-koki-val', 'text', d.notes.koki.val, v => { set(x => { x.notes.koki.val = v; }); eueNotesPv(s); }, { inputMode: 'numeric' });
  els.koki.setAttribute('aria-label', '工期の日数');
  kokiBox.append(els.koki, mk('span', null, '日間'));
  opts.appendChild(nrow('koki', '工期', els.koki, kokiBox));
  els.jikan = eueInput('eu-note-jikan-val', 'text', d.notes.jikan.val, v => { set(x => { x.notes.jikan.val = v; }); eueNotesPv(s); }, { placeholder: '例：9:00〜17:00' });
  els.jikan.setAttribute('aria-label', '工事時間');
  opts.appendChild(nrow('jikan', '工事時間', els.jikan));
  // Task 48 E: ホテル移動・荷物の片付け（必要／不要。もう一度押すと未選択）。片付けの「必要」は場所（複数・自由記載）を選ぶ
  const choiceRow = (key, label, cur, onPick) => {
    const r = mk('div', 'eu-note-row');
    r.dataset.note = key;
    if (ro && !cur) r.hidden = true;
    const g = mk('div', 'eu-choice');
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', label);
    const btns = [['need', '必要'], ['none', '不要']].map(([v, t]) => {
      const b = dBtn(t, 'eu-choice-b', () => { const nv = b.getAttribute('aria-pressed') === 'true' ? '' : v; paint(nv); onPick(nv); eueNotesPv(s); });
      b.id = 'eu-note-' + key + '-' + v;
      b.dataset.v = v;
      return b;
    });
    const paint = v => btns.forEach(b => { b.setAttribute('aria-pressed', b.dataset.v === v ? 'true' : 'false'); b.classList.toggle('on', b.dataset.v === v); });
    paint(cur);
    g.append(...btns);
    r.append(mk('span', 'eu-note-lb', label), g);
    return r;
  };
  opts.appendChild(choiceRow('hotel', 'ホテル移動', d.notes.hotel, v => set(x => { x.notes.hotel = v; })));
  const places = mk('div', 'eu-places');
  places.id = 'eu-note-places';
  places.hidden = d.notes.katazuke.sel !== 'need';
  places.appendChild(mk('span', 'eu-places-lb', '片付けをお願いする場所（複数可）'));
  EstimateLogic.KATAZUKE_PLACES.forEach(p => {
    const on = d.notes.katazuke.places.includes(p);
    const b = dBtn(p, 'eu-choice-b sm' + (on ? ' on' : ''), () => {
      const now = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', now ? 'true' : 'false');
      b.classList.toggle('on', now);
      set(x => { const k = x.notes.katazuke; k.places = EstimateLogic.KATAZUKE_PLACES.filter(q => (q === p ? now : k.places.includes(q))); });
      eueNotesPv(s);
    });
    b.dataset.place = p;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    places.appendChild(b);
  });
  els.kzFree = eueInput('eu-note-katazuke-free', 'text', d.notes.katazuke.free, v => { set(x => { x.notes.katazuke.free = v; }); eueNotesPv(s); }, { placeholder: '自由記載（例：浴室）' });
  els.kzFree.setAttribute('aria-label', '片付けをお願いする場所（自由記載）');
  places.appendChild(els.kzFree);
  const kzRow = choiceRow('katazuke', '荷物の片付け', d.notes.katazuke.sel, v => { set(x => { x.notes.katazuke.sel = v; }); places.hidden = v !== 'need'; });
  kzRow.appendChild(places);
  opts.appendChild(kzRow);
  if (ro && !['koki', 'jikan'].some(k => d.notes[k].on) && !d.notes.hotel && !d.notes.katazuke.sel) opts.hidden = true;
  c3.appendChild(opts);
  els.extra = document.createElement('textarea');
  els.extra.id = 'eu-note-extra';
  els.extra.className = 'short';
  els.extra.value = d.notes.extra;
  els.extra.placeholder = '例：養生は弊社にて行います。';
  els.extra.addEventListener('input', () => { set(x => { x.notes.extra = els.extra.value; }); eueNotesPv(s); });
  const ex = eueField('その他（自由記入）', els.extra);
  ex.style.marginTop = '10px';
  ex.style.marginBottom = '0';
  if (ro && !String(d.notes.extra || '').trim()) ex.hidden = true;
  c3.appendChild(ex);
  els.notesPv = mk('div', 'eu-notes-pv');
  els.notesPv.id = 'eu-notes-pv';
  c3.appendChild(els.notesPv);

  // 並び（PC=上のバー＋左 入力／右 紙面、スマホ=1段＋紙面の折りたたみ）は EstimateLayout
  // Task 36: 現場用は帯の下・入力欄の上に「調査の内容」の折りたたみ欄（管理画面には出さない）
  const sv = s.survey ? eueSurveyPanel(s) : null;
  EstimateLayout.mount(s, top, (sv ? [sv] : []).concat([head, notice], reedit ? [reedit] : [], [roBox, els.val, c1, c2, c3]));
  eueRenderLines(s);
  eueNotesPv(s);
  eueTotals(s);
  const left = $('eu-left');
  if (ro) {
    left.querySelectorAll('input, select, textarea, button').forEach(e => {
      if (e !== els.back && !e.closest('.eu-ver') && !e.closest('.sv-panel')) e.disabled = true;
    });
    add.hidden = true;
    q.hidden = true;
    left.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(e => { e.removeAttribute('placeholder'); });
  }
  // 読み取り専用: 入力欄は値の表示だけ（枠を薄く）・編集ボタンは出さない
  $('estimate-root').classList.toggle('eu-ro', !!ro);
  EstimateLayout.render(); // 紙面は入力欄が全部そろってから描く
  // 版の操作（無効化の後に足す）・紐付けた依頼
  const extra = [];
  const acts = eueActsCard(s);
  if (acts) extra.push(acts);
  const links = eueLinksCard(s);
  if (links) extra.push(links);
  if (extra.length) roBox.after(...extra);
}

/* ---------- 調査の内容（現場用。Task 36） ---------- */
// 開いた/閉じたは見積ごとにこの端末に覚える（初めは開いた状態）
const eueSvKey = id => 'genba-docs.est-survey.' + id;
function eueSvOpen(id) {
  try { return localStorage.getItem(eueSvKey(id)) !== 'closed'; } catch (e) { return true; }
}
function eueSvSetOpen(id, open) {
  try { if (open) localStorage.removeItem(eueSvKey(id)); else localStorage.setItem(eueSvKey(id), 'closed'); } catch (e) { /* 覚えられない端末では毎回開く */ }
}
// どの調査を出すか（PhaseLogic.estimateSurvey）と見積のフェーズ
function eueSurveyOf(s, rs) {
  const phases = Array.isArray(s.caseRow.phases) ? s.caseRow.phases : [];
  const estPhase = phases.find(p => p.id === s.row.phase_id) || null;
  if (rs.err) return { err: rs.err, src: null, estPhase };
  return { err: '', src: PhaseLogic.estimateSurvey(s.caseRow, rs.list, s.row.phase_id), estPhase };
}
function eueSurveyPanel(s) {
  const sv = s.survey;
  return SurveyView.panel({
    src: sv.src, estPhase: sv.estPhase, err: sv.err, open: eueSvOpen(s.id),
    onToggle: open => eueSvSetOpen(s.id, open),
    // 調査の内容ページへ（入力中の内容は移る前に保存する）
    onPage: async () => {
      if (s.busy) return;
      await eueFlush(s);
      if (eue !== s) return;
      location.hash = '#f/case/' + String(s.row.case_id).toLowerCase() + '/phase/' + String(sv.src.phase.id).toLowerCase() + '/survey/' + String(s.id).toLowerCase();
    }
  });
}

/* ---------- 版の操作（提出済み以降） ---------- */
// 送付: issued/sent/accepted の最新版 / 承諾: issued/sent の最新版 / 新しい版: issued/sent の最新版 / 差分: v2 以降
function eueActsCard(s) {
  const r = s.row, st = r.status, v = Number(r.version) || 1;
  if (st === 'draft' && v < 2) return null;
  const admin = !(typeof fieldHidesAdmin === 'function' && fieldHidesAdmin());
  const owner = !!(ctx && ctx.membership && ctx.membership.role === 'owner');
  let note = null; // Task 35: 現場用で送付済み → 「管理者に連絡」の案内
  const card = mk('div', 'rep-card eu-acts');
  card.id = 'eu-acts';
  const row = mk('div', 'rep-acts');
  const btn = (label, id, cls, fn) => { const b = dBtn(label, cls, fn); b.id = id; row.appendChild(b); return b; };
  if (st !== 'draft') {
    card.appendChild(mk('h3', null, st === 'accepted' ? 'この版は採用版です' : st === 'superseded' ? 'この版は旧版です' : 'この版の操作'));
    // 「依頼者へ送付」「承諾された」は管理者のみ（現場用で開いたときは出さない。Task 18）
    if (admin && s.latest && ['issued', 'sent', 'accepted'].includes(st)) btn('依頼元へ送付', 'eu-send', 'btn inline', () => eueSend(s));
    if (s.latest && ['issued', 'sent'].includes(st)) {
      if (admin) btn('承諾された', 'eu-accept', 'btn inline green', () => eueAccept(s));
      // 減額対応の新しい版は送付済みの版を旧版にする（管理者の「発注待ち」が戻る）ので管理者だけ（Task 23 I8）
      if (admin) btn('減額対応で新しい版を作る', 'eu-newver', 'btn ghost inline', () => eueNewVerPanel(s));
    }
    // Task 35 C: 提出済み（依頼元へ送る前）の最新版は、同じ番号のまま直せる（作業担当者・管理者。権限は DB の estimate_reedit が見る）
    const can = PhaseLogic.canReedit('estimate', r, { latest: !!s.latest });
    if (can.ok && (!admin || owner)) btn(admin ? '再編集する（同じ番号のまま直す）' : '再編集して管理者に知らせる', 'eu-reedit', 'btn ghost inline', () => eueReedit(s));
    else if (!admin && s.latest && can.reason) note = mk('div', 'rep-sub eu-reedit-no', can.reason);
  }
  // Task 35 B: 減額対応で作った新しい版（まだ提出していない下書き）は、やめて前の版に戻せる（管理者だけ）
  if (st === 'draft' && v >= 2 && !r.number && admin && owner) btn('この版をやめて前の版に戻す', 'eu-cancel-ver', 'btn ghost inline', () => eueCancelVer(s));
  if (v >= 2) btn('前の版との差分', 'eu-diff-open', 'btn sm ghost inline', () => { location.hash = '#estimate/' + s.id + '/diff'; });
  if (!row.firstChild && !note) return null;
  if (row.firstChild) card.appendChild(row);
  if (note) card.appendChild(note);
  const msg = mk('div', 'err');
  msg.id = 'eu-acts-msg';
  msg.setAttribute('role', 'alert');
  const panel = mk('div', 'eu-nv');
  panel.id = 'eu-nv';
  panel.hidden = true;
  card.append(msg, panel);
  s.els.acts = card; s.els.actsMsg = msg; s.els.nv = panel;
  return card;
}
function eueActsBusy(s, on) {
  s.busy = on || '';
  if (s.els.acts) s.els.acts.querySelectorAll('button, input').forEach(b => { b.disabled = !!on; });
  eueSyncBar(s);
}

// 紐付けた依頼（新しい版を送付すると反映済みになる）
function eueLinksCard(s) {
  const ids = (s.row.linked_request_ids || []).filter(Boolean);
  if (!ids.length) return null;
  const card = mk('div', 'rep-card');
  card.id = 'eu-links';
  card.appendChild(mk('b', null, 'この版で対応する依頼（' + ids.length + '件）'));
  card.appendChild(mk('div', 'rep-sub', 'この版を依頼元へ送付すると、タイムラインの依頼を「反映済み」にします'));
  const list = mk('div', 'eu-links');
  (s.linked || []).forEach(e => {
    const it = mk('div', 'eu-link');
    it.append(mk('span', 'rep-pill ' + (e.resolved_at ? 'p-ok' : 'p-wait'), e.resolved_at ? '反映済み' : '未対応'), mk('span', null, euStr(e.body)));
    list.appendChild(it);
  });
  card.appendChild(list);
  return card;
}

// 「減額対応で新しい版を作る」: 未対応の依頼をチェックで選ぶ（0件なら選択なし）→ EstimatesApi.newVersion → 新しい版の編集へ
async function eueNewVerPanel(s) {
  if (s.busy) return;
  const panel = s.els.nv;
  if (!panel.hidden) { panel.hidden = true; return; }
  setMsg('eu-acts-msg', '');
  panel.hidden = false;
  panel.replaceChildren(mk('div', 'rep-sub', '未対応の依頼を読み込み中…'));
  let reqs;
  try { reqs = await EstimatesApi.listOpenRequests(s.row.case_id); }
  catch (e) { if (eue === s) panel.replaceChildren(mk('div', 'err', '依頼を読み込めませんでした: ' + errText(e))); return; }
  if (eue !== s) return;
  const nodes = [mk('b', null, '第' + ((Number(s.row.version) || 1) + 1) + '版を作ります')];
  nodes.push(mk('div', 'rep-sub', '明細・備考をコピーした下書きを作ります（値引きの端数調整は外して計算し直します。見積日は今日）。この版は「旧版」になります'));
  const checks = [];
  if (!reqs.length) {
    const none = mk('div', 'empty', 'タイムラインに未対応の依頼はありません（紐付けなしで作れます）');
    none.id = 'eu-nv-none';
    nodes.push(none);
  } else {
    nodes.push(mk('div', 'rep-group-ttl', 'この版で対応する依頼を選ぶ（送付すると「反映済み」になります）'));
    reqs.forEach((r, i) => {
      const c = eueCheck('eu-nv-req' + (i + 1), euStr(r.body) || '（本文なし）', false, () => {});
      c.querySelector('input').value = r.id;
      c.classList.add('eu-nv-req');
      checks.push(c.querySelector('input'));
      nodes.push(c);
    });
  }
  const go = dBtn('この内容で新しい版を作る', 'btn inline', async () => {
    if (s.busy) return;
    const ids = checks.filter(c => c.checked).map(c => c.value);
    eueActsBusy(s, 'newver');
    go.textContent = '作成中…';
    let made = null, msg = '';
    try { made = await EstimatesApi.newVersion(s.row, ids); }
    catch (e) { msg = '新しい版を作れませんでした: ' + errText(e); }
    if (eue !== s) return;
    eueActsBusy(s, '');
    go.textContent = 'この内容で新しい版を作る';
    if (made && made.id) { location.hash = '#estimate/' + made.id; return; }
    setMsg('eu-acts-msg', msg);
  });
  go.id = 'eu-nv-go';
  go.style.marginTop = '10px';
  nodes.push(go);
  panel.replaceChildren(...nodes);
}

// 「承諾された」: confirm → EstimatesApi.accept → 採用版（対応フェーズの段階が「承諾待ち」から進む）
async function eueAccept(s) {
  if (s.busy) return;
  // 画面内の確認（confirm() は使わない。Task 23 M6）
  const ok = await askInline($('eu-acts'), 'この版（' + euNumberText(s.row) + '・' + euYen(s.row.total) + '）を、依頼元から発注を受けた（承諾された）採用版として記録しますか？',
    { okLabel: '採用版として記録する', id: 'eu-ask' });
  if (!ok || eue !== s || s.busy) return;
  eueActsBusy(s, 'accept');
  setMsg('eu-acts-msg', '');
  let row = null, msg = '';
  try { row = await EstimatesApi.accept(s.row); }
  catch (e) { msg = '承諾にできませんでした: ' + errText(e); }
  if (eue !== s) return;
  eueActsBusy(s, '');
  if (msg) { setMsg('eu-acts-msg', msg); return; }
  s.row = Object.assign({}, s.row, row);
  s.notice = '承諾（採用版）として記録しました';
  eueBuild(s);
  eueSyncBar(s);
}

// Task 35: 再編集の印の行（無ければ null）
function eueReeditLine(s) {
  const m = PhaseLogic.reeditMark(s.row);
  if (!m) return null;
  const box = mk('div', 'reedit-line' + (m.key === 'history' ? ' past' : ''));
  box.id = 'eu-reedit-mark';
  box.dataset.key = m.key;
  if (m.short) box.appendChild(mk('span', 'reedit-tag', m.short));
  const admin = !(typeof fieldHidesAdmin === 'function' && fieldHidesAdmin());
  const no = EstimatesApi.displayNumber(s.row);
  const tail = m.key === 'editing' ? '直して「提出する」を押すと、同じ番号' + (no ? '（' + no + '）' : '') + 'で提出し直し、管理者に知らせます'
    : m.key === 'edited' ? (admin ? '内容を確かめてから依頼元へ送付してください（送付すると印は消えます）' : '管理者が依頼元へ送付すると、この印は消えます')
      : '';
  const detail = m.key === 'history' ? m.text : [m.at ? PhaseLogic.fmtMDHM(m.at) : '', m.by].filter(Boolean).join(' ');
  box.appendChild(mk('span', null, [detail, tail].filter(Boolean).join('。')));
  return box;
}

// Task 35 C: 「再編集して管理者に知らせる」（管理画面は「再編集する」）: 画面内で確かめる → EstimatesApi.reedit → 同じ版を下書きで開き直す
async function eueReedit(s) {
  if (s.busy) return;
  const admin = !(typeof fieldHidesAdmin === 'function' && fieldHidesAdmin());
  const ok = await askInline($('eu-acts'), 'この見積書（' + euNumberText(s.row) + '）を再編集にしますか？\n番号はそのままで、同じ版の中身を直します。直して「提出する」を押すまでは「再編集中」になります。'
    + (admin ? '' : '\n再編集にしたことは管理者に自動で知らせます。'), { okLabel: '再編集にする', id: 'eu-ask' });
  if (!ok || eue !== s || s.busy) return;
  eueActsBusy(s, 'reedit');
  setMsg('eu-acts-msg', '');
  let row = null, msg = '';
  try { row = await EstimatesApi.reedit(s.row); }
  catch (e) { msg = '再編集にできませんでした: ' + errText(e); }
  if (eue !== s) return;
  eueActsBusy(s, '');
  if (msg) { setMsg('eu-acts-msg', msg); return; }
  eueFlash = { id: s.id, text: '再編集にしました。直して「提出する」を押すと、同じ番号で提出し直します' + (admin ? '' : '（管理者に知らせました）') };
  s.left = true;
  openEstimate(s.id);
}

// Task 35 B: 「この版をやめて前の版に戻す」（管理者だけ）: 画面内で確かめる → EstimatesApi.cancelVersion → 前の版の画面へ（「承諾された」が押せる）
async function eueCancelVer(s) {
  if (s.busy) return;
  const v = Number(s.row.version) || 2;
  const ok = await askInline($('eu-acts'), 'この第' + v + '版（下書き）をやめて、第' + (v - 1) + '版に戻しますか？\nこの下書きは消え、第' + (v - 1) + '版は旧版にする前の状態（提出済み／送付済み）に戻ります。紐付けた依頼の紐付けも外れます。',
    { okLabel: '第' + (v - 1) + '版に戻す', danger: true, id: 'eu-ask' });
  if (!ok || eue !== s || s.busy) return;
  eueActsBusy(s, 'cancel');
  setMsg('eu-acts-msg', '');
  await eueFlush(s); // 保留中の保存を先に終わらせる（消した後に保存が走らないように）
  let row = null, msg = '';
  try { row = await EstimatesApi.cancelVersion(s.row); }
  catch (e) { msg = '前の版に戻せませんでした: ' + errText(e); }
  if (eue !== s) return;
  eueActsBusy(s, '');
  if (msg) { setMsg('eu-acts-msg', msg); return; }
  eueLsDel(s.id);
  clearTimeout(s.timer);
  s.dirty = false;
  s.left = true;
  eueFlash = { id: row.id, text: '第' + v + '版をやめて、第' + row.version + '版（' + (EU_STATUS[row.status] || [''])[0] + '）に戻しました' };
  location.hash = '#estimate/' + row.id;
}

// 「依頼者へ送付」: 未送信の下書きがあれば開き直す。無ければ EstimatesApi.createMailDraft → ⑨
async function eueSend(s) {
  if (s.busy) return;
  eueActsBusy(s, 'send');
  setMsg('eu-acts-msg', '');
  let d = null, msg = '';
  try { d = (await EstimatesApi.findMailDraft(s.id)) || await EstimatesApi.createMailDraft(s.row); }
  catch (e) { msg = '送付の下書きを作れませんでした: ' + errText(e); }
  if (eue !== s) return;
  eueActsBusy(s, '');
  if (d && d.id) { location.hash = '#mail/' + d.id; return; }
  setMsg('eu-acts-msg', msg);
}

function eueNotesPv(s) {
  if (s.els.notesPv) s.els.notesPv.textContent = '紙面の備考:\n' + EstimateLogic.buildNotes(s.data.notes);
}

/* ---------- 明細 ---------- */
const eueLine = (s, id) => s.lines.find(l => l.id === id);

// 明細の値が変わった: 諸経費・値引き行を取り直し、表示中の自動計算欄と合計だけ更新（入力中の欄は触らない）
function eueLinesChanged(s) {
  s.lines = EstimatesApi.normalizeLines(s.lines);
  eueRefreshComputed(s);
  eueTotals(s);
  eueChanged(s);
}
// 行の並び・数が変わった: 正規化して全部描き直す
function eueLinesRebuilt(s) {
  s.lines = EstimatesApi.normalizeLines(s.lines);
  eueRenderLines(s);
  eueTotals(s);
  eueChanged(s);
}

function eueRefreshComputed(s) {
  s.lines.forEach(l => {
    const row = s.els.lines.querySelector('[data-id="' + l.id + '"]');
    if (!row) return;
    const pr = row.querySelector('.c-price .v');
    if (pr) pr.textContent = euYen(EstimateLogic.unitPrice(l));
    const amt = row.querySelector('.c-amt input');
    const costed = EstimateLogic.hasCost(l) && !l.priceOverride; // 原価 × 利益率で決まる行
    if (amt && (l.isAutoShokehi || eueIsAdj(l) || costed) && document.activeElement !== amt) amt.value = EstimateLogic.fmt(l.amount);
    eueOvrMark(row, l);
  });
}

function eueTotals(s) {
  const t = EstimateLogic.totals(s.lines);
  $('eu-t-subtotal').textContent = euYen(t.subtotal);
  $('eu-t-tax').textContent = euYen(t.tax);
  $('eu-t-total').textContent = euYen(t.total);
  $('eu-t-post').textContent = euYen(t.postTax);
  $('eu-t-post-box').hidden = !t.postTax;
  if (s.els.adj) s.els.adj.querySelector('input').checked = s.lines.some(eueIsAdj);
  EstimateImport.refresh(s); // 粗利の枠
  if (s.els.qMsg && t.subtotal < 0) s.els.qMsg.textContent = '小計がマイナスです。金額を見直してください（このままでは保存されません）';
  else if (s.els.qMsg && s.els.qMsg.textContent.startsWith('小計')) s.els.qMsg.textContent = '';
}

function eueRenderLines(s) {
  const ro = s.readOnly;
  const n = s.lines.length;
  const editable = s.lines.filter(l => !eueIsAdj(l));
  const nodes = s.lines.map((l, i) => eueLineEl(s, l, i, n, editable));
  s.els.lines.replaceChildren(...nodes);
  if (ro) s.els.lines.querySelectorAll('input, button').forEach(e => { e.disabled = true; });
}

function eueLineEl(s, l, i, n, editable) {
  const id = l.id;
  const adj = eueIsAdj(l), auto = !!l.isAutoShokehi;
  const row = mk('div', 'eu-ln' + (auto ? ' auto' : '') + (adj ? ' adj' : '') + (s.readOnly && !String(l.detail || '').trim() ? ' no-detail' : ''));
  row.dataset.id = id;
  if (!adj) row.dataset.drag = '1'; // ⠿ で動かせる行（値引きの調整行は常に末尾）
  const cell = (cls, label, control, forId) => {
    const c = mk('div', cls);
    if (label) {
      const lb = mk('label', 'eu-l', label);
      if (forId) lb.htmlFor = forId;
      c.appendChild(lb);
    }
    if (control) c.appendChild(control);
    return c;
  };
  const upd = fn => { const ln = eueLine(s, id); if (!ln) return; fn(ln); eueLinesChanged(s); };
  const pre = 'eu-ln' + (i + 1);
  const opBtn = (t, label, cls, fn, dis, title) => {
    const b = mk('button', cls || null, t);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    if (title) b.title = title;
    b.disabled = !!dis;
    b.addEventListener('click', fn);
    return b;
  };

  // 並び替え: PC（1100px以上）は ⠿ をドラッグ（↑↓キーでも可）、それより狭い画面は ↑↓ ボタン（CSS で出し分け）
  const hd = mk('div', 'c-hd eu-ops');
  if (adj) hd.appendChild(mk('span', 'eu-adj-tag', '調整'));
  else {
    const ei = editable.findIndex(x => x.id === id);
    const drag = opBtn('⠿', (i + 1) + '行目を並び替え（ドラッグ、または↑↓キー）', 'eu-drag', () => {}, false, 'ドラッグで並び替え（↑↓キーでも動かせます）');
    EstimateLayout.dragHandle(drag, s.els.lines, row, k => eueMoveTo(s, id, k), dir => eueMove(s, id, dir, 'eu-drag'));
    hd.append(drag,
      opBtn('↑', (i + 1) + '行目を上へ', 'up', () => eueMove(s, id, -1), ei <= 0),
      opBtn('↓', (i + 1) + '行目を下へ', 'down', () => eueMove(s, id, 1), ei >= editable.length - 1));
  }
  row.appendChild(hd);

  // 摘要（1行目）＋詳細（2行目・薄い）
  const desc = eueInput(pre + '-desc', 'text', l.description, v => upd(x => { x.description = v; }), { placeholder: '摘要（例：クロス張替え）' });
  desc.className = 'eu-desc';
  if (adj) desc.readOnly = true;
  row.appendChild(cell('c-desc', '摘要', desc, desc.id));

  const det = eueInput(pre + '-detail', 'text', l.detail, v => upd(x => { x.detail = v; }), { placeholder: '詳細（任意）' });
  det.className = 'eu-detail';
  if (adj) det.readOnly = true;
  row.appendChild(cell('c-detail', '詳細（任意）', det, det.id));

  if (auto) {
    // 諸経費: 数量の位置に %（自分・他の諸経費・値引きを除いた合計 × %）
    const pw = mk('div', 'eu-pct');
    const pct = eueInput(pre + '-pct', 'text', String(l.shokehiPct), v => upd(x => { const p = euParsePct(v); x.shokehiPct = Number.isFinite(p) && p >= 0 ? p : 0; }), { inputMode: 'decimal' });
    pct.className = 'eu-num';
    pw.append(pct, mk('span', null, '%'));
    row.appendChild(cell('c-qty', '諸経費の%', pw, pct.id));
  } else {
    const qty = eueInput(pre + '-qty', 'text', String(l.quantity), v => upd(x => { x.quantity = euParseQty(v); }), { inputMode: 'decimal', placeholder: '数量' });
    qty.className = 'eu-num eu-qty';
    if (adj) qty.readOnly = true;
    row.appendChild(cell('c-qty', '数量', qty, qty.id));
  }
  const unit = eueInput(pre + '-unit', 'text', l.unit, v => upd(x => { x.unit = v; }), { list: 'eu-units', maxLength: 10, placeholder: '単位' });
  unit.className = 'eu-unit';
  if (adj) unit.readOnly = true;
  row.appendChild(cell('c-unit', '単位', unit, unit.id));

  // 原価（Task 19。任意）。入れると 販売金額 = 原価 × (1 + 利益率/100)（個別に直した行はそのまま）
  const cost = eueInput(pre + '-cost', 'text', EstimateLogic.hasCost(l) ? EstimateLogic.fmt(l.cost) : '', v => upd(x => {
    const t = euNormNum(v);
    if (t === '') { delete x.cost; delete x.priceOverride; return; }
    x.cost = Math.max(0, euParseAmount(v));
    if (!x.priceOverride) x.amount = EstimateLogic.marginPrice(x.cost, s.margin);
  }), { inputMode: 'numeric', placeholder: '原価' });
  cost.className = 'eu-num eu-cost';
  if (auto || adj) { cost.readOnly = true; cost.value = ''; cost.placeholder = ''; }
  else {
    cost.addEventListener('focus', () => { const ln = eueLine(s, id); if (ln && EstimateLogic.hasCost(ln)) cost.value = String(ln.cost); });
    cost.addEventListener('blur', () => { const ln = eueLine(s, id); if (ln) cost.value = EstimateLogic.hasCost(ln) ? EstimateLogic.fmt(ln.cost) : ''; });
  }
  const costCell = cell('c-cost', '原価（円・任意）', null, cost.id);
  costCell.append(mk('span', 'eu-l2', '原価 '), cost);
  row.appendChild(costCell);

  // 単価は表示だけ（金額÷数量）
  const price = mk('div', 'c-price');
  price.append(mk('span', 'eu-l2', '単価 '), mk('span', 'v eu-num', euYen(EstimateLogic.unitPrice(l))));
  row.appendChild(price);

  // 金額: 入力中は数字のまま、確定（change/blur）で EstimateLogic.commitAmount → 3桁区切り
  // 原価のある行の販売金額を手で直したら「個別」（利益率を変えても戻らない。「…」から 原価×利益率 に戻せる）
  const amt = eueInput(pre + '-amt', 'text', EstimateLogic.fmt(l.amount), v => upd(x => { x.amount = euParseAmount(v); if (EstimateLogic.hasCost(x)) x.priceOverride = true; }), { inputMode: 'numeric', placeholder: '金額' });
  amt.className = 'eu-num eu-amt';
  if (auto || adj) amt.readOnly = true;
  else {
    amt.addEventListener('focus', () => { const ln = eueLine(s, id); if (ln) amt.value = ln.amount ? String(ln.amount) : ''; amt.select(); });
    amt.addEventListener('change', () => {
      const ln = eueLine(s, id);
      if (!ln) return;
      const fixed = EstimateLogic.commitAmount(Object.assign({}, ln, { amount: euParseAmount(amt.value) }));
      upd(x => { x.amount = fixed.amount; if (EstimateLogic.hasCost(x)) x.priceOverride = true; });
    });
    amt.addEventListener('blur', () => { const ln = eueLine(s, id); if (ln) amt.value = EstimateLogic.fmt(ln.amount); });
  }
  const amtCell = cell('c-amt', auto ? '金額（自動計算）' : adj ? '値引き（自動計算）' : '販売金額（円）', amt, amt.id);
  const ovr = mk('span', 'eu-ovr-tag', '個別');
  ovr.title = '販売金額を個別に直しています（利益率を変えても変わりません。「…」から 原価×利益率 に戻せます）';
  amtCell.appendChild(ovr);
  row.appendChild(amtCell);
  eueOvrMark(row, l);

  // 複製・削除（右端に縦に2つ）／調整行は「外す」
  const ops = mk('div', 'c-ops eu-ops');
  const more = mk('div', 'c-more eu-ops');
  if (adj) {
    ops.appendChild(opBtn('外す', '税込合計を00にするのをやめる', 'del', () => eueToggleAdjust(s, false)));
  } else {
    ops.append(
      opBtn('⧉', (i + 1) + '行目を複製', 'dup', () => eueDupLine(s, id), false, 'この行を複製（すぐ下に）'),
      opBtn('✕', (i + 1) + '行目を削除', 'del', () => eueDelLine(s, id), false, 'この行を削除'));
    // 「…」: その他の操作（よく使う明細に登録）。行の下に小さなメニューを開く・もう一度押すと閉じる
    more.appendChild(opBtn('…', (i + 1) + '行目のその他の操作', 'more', () => eueMoreMenu(s, id, row), false, 'その他（よく使う明細に登録）'));
  }
  if (s.readOnly) { hd.hidden = true; ops.hidden = true; more.hidden = true; } // 並び替え・複製・削除・外すは読み取り専用では出さない
  row.append(ops, more);
  return row;
}

// 「個別」の印（原価のある行で販売金額を手で直した）
function eueOvrMark(row, l) {
  const on = !!(l && l.priceOverride && EstimateLogic.hasCost(l));
  row.classList.toggle('ovr', on);
  const amt = row.querySelector('.c-amt input');
  if (amt) amt.title = on ? '個別に直した販売金額（利益率を変えても変わりません）' : '';
}
// 行の「…」メニュー（入力の無いメニュー。もう一度「…」を押すか、項目を押すと閉じる）
function eueMoreMenu(s, id, row) {
  const open = row.querySelector('.eu-more-menu');
  const btn = row.querySelector('.c-more .more');
  s.els.lines.querySelectorAll('.eu-more-menu').forEach(m => { m.remove(); });
  s.els.lines.querySelectorAll('.c-more .more[aria-expanded]').forEach(b => { b.setAttribute('aria-expanded', 'false'); });
  if (open || s.readOnly) return;
  const menu = mk('div', 'eu-more-menu');
  const reg = dBtn('★ よく使う明細に登録', 'btn sm ghost inline eu-more-reg', () => {
    menu.remove();
    if (btn) btn.setAttribute('aria-expanded', 'false');
    const ln = eueLine(s, id);
    if (ln) EstimatePresets.openRegister(s, ln);
  });
  menu.appendChild(reg);
  const cur = eueLine(s, id);
  if (cur && cur.priceOverride && EstimateLogic.hasCost(cur)) {
    const back = dBtn('↺ 原価×利益率に戻す', 'btn sm ghost inline eu-more-ovr', () => {
      menu.remove();
      if (btn) btn.setAttribute('aria-expanded', 'false');
      const ln = eueLine(s, id);
      if (!ln) return;
      delete ln.priceOverride;
      ln.amount = EstimateLogic.marginPrice(ln.cost, s.margin);
      eueLinesChanged(s);
    });
    menu.appendChild(back);
  }
  row.appendChild(menu);
  if (btn) btn.setAttribute('aria-expanded', 'true');
  reg.focus({ preventScroll: true });
}
// よく使う明細のボタン: 定型の行を末尾に足す（空の行は除く。行は定型の写しなので後で定型を変えても変わらない）。
// 金額が0なら金額の欄へ（入力待ち）
function eueAddPreset(s, preset) {
  if (s.readOnly) return;
  const l = EstimateLogic.presetToLine(preset);
  s.lines = s.lines.filter(x => EstimateLogic.isRealLine(x) || x.isAutoShokehi || eueIsAdj(x)).concat([l]);
  s.els.qMsg.textContent = '';
  eueLinesRebuilt(s);
  const el = s.els.lines.querySelector('[data-id="' + l.id + '"] .eu-amt');
  if (el && !l.amount) el.focus({ preventScroll: false });
}

function eueAddLine(s) {
  if (s.readOnly) return;
  const l = EstimateLogic.newLine();
  s.lines = s.lines.concat([l]);
  eueLinesRebuilt(s);
  const el = s.els.lines.querySelector('[data-id="' + l.id + '"] .eu-desc');
  if (el) el.focus({ preventScroll: false });
}
// focusCls: 動かした後にフォーカスを戻すボタン（既定は押した ↑/↓。⠿ の↑↓キーなら eu-drag）
function eueMove(s, id, dir, focusCls) {
  const ls = s.lines.slice();
  const i = ls.findIndex(l => l.id === id);
  const j = i + dir;
  if (s.readOnly || i < 0 || j < 0 || j >= ls.length || eueIsAdj(ls[j])) return;
  [ls[i], ls[j]] = [ls[j], ls[i]];
  s.lines = ls;
  eueLinesRebuilt(s);
  const b = s.els.lines.querySelector('[data-id="' + id + '"] .' + (focusCls || (dir < 0 ? 'up' : 'down')));
  if (b && !b.disabled) b.focus({ preventScroll: true });
}
// ⠿ のドラッグ: 動かせる行（調整行を除く）の中で k 番目へ
function eueMoveTo(s, id, k) {
  if (s.readOnly) return;
  const movable = s.lines.filter(l => !eueIsAdj(l));
  const i = movable.findIndex(l => l.id === id);
  if (i < 0 || i === k || k < 0 || k >= movable.length) return;
  const [it] = movable.splice(i, 1);
  movable.splice(k, 0, it);
  s.lines = movable.concat(s.lines.filter(eueIsAdj));
  eueLinesRebuilt(s);
  const b = s.els.lines.querySelector('[data-id="' + id + '"] .eu-drag');
  if (b) b.focus({ preventScroll: true });
}
function eueDupLine(s, id) {
  const i = s.lines.findIndex(l => l.id === id);
  if (i < 0) return;
  const copy = Object.assign(euClone(s.lines[i]), { id: EstimateLogic.newLine().id });
  s.lines = s.lines.slice(0, i + 1).concat([copy], s.lines.slice(i + 1));
  eueLinesRebuilt(s);
}
function eueDelLine(s, id) {
  let ls = s.lines.filter(l => l.id !== id);
  if (!ls.filter(l => !eueIsAdj(l)).length) ls = [EstimateLogic.newLine()].concat(ls);
  s.lines = ls;
  eueLinesRebuilt(s);
}
// 「税込合計を00に」: ON で値引き行を足す（端数0でも金額0の行で ON を保つ）、OFF で外す。端数は normalizeLines が毎回取り直す
function eueToggleAdjust(s, on) {
  if (s.readOnly) return;
  const has = s.lines.some(eueIsAdj);
  if (on && !has) {
    const r = EstimateLogic.adjustToHundred(s.lines);
    s.lines = r.action === 'added' ? r.lines
      : s.lines.concat([EstimateLogic.adjustLine(0)]);
  } else if (!on && has) {
    s.lines = s.lines.filter(l => !eueIsAdj(l));
  } else return;
  eueLinesRebuilt(s);
}

/* ---------- 入力チェック表示 ---------- */
function eueShowVal(s, errors, warn) {
  s.els.val.replaceChildren(...errors.map(t => mk('div', warn ? 'rep-val-w' : 'rep-val-e', t)));
  if (errors.length) s.els.val.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/* ---------- 下部バー ---------- */
function eueSyncBar(s) {
  const pdf = $('eu-pdf'), iss = $('eu-issue');
  pdf.disabled = !!s.busy;
  iss.hidden = s.readOnly;
  iss.disabled = !!s.busy;
  iss.textContent = s.busy === 'issue' ? '提出中…' : s.armIssue ? 'もう一度押すと提出します' : '提出する';
  iss.classList.toggle('green', !!s.armIssue);
  if (s.els.back) s.els.back.disabled = !!s.busy;
}
function eueDisarmIssue(s) {
  if (!s.armIssue) return;
  s.armIssue = false;
  clearTimeout(s.armTimer);
  eueSyncBar(s);
}

async function euePdf(s) {
  if (s.busy) return;
  s.busy = 'pdf';
  eueSyncBar(s);
  await eueFlush(s);
  s.busy = '';
  eueSyncBar(s);
  if (eue !== s) return;
  if (s.dirty && !s.readOnly) {
    eueShowVal(s, ['保存できていないため、PDFプレビューを開けません: ' + (s.saveErr || '')]);
    return;
  }
  location.hash = '#estimate/' + s.id + '/pdf';
}

// 提出: 画面内で2回押して確定（confirm は使わない）→ flush → validate → EstimatesApi.issue（番号が付く）→ 読み取り専用
async function eueIssue(s) {
  if (s.busy || s.readOnly) return;
  const v = EstimateLogic.validate({ data: s.data, lines: s.lines });
  const bad = eueBlocker(s);
  if (!v.ok || bad) { eueShowVal(s, v.errors.concat(bad ? [bad] : [])); return; }
  if (!s.armIssue) {
    s.armIssue = true;
    eueShowVal(s, [s.row.number ? '提出すると同じ番号（' + EstimatesApi.displayNumber(s.row) + '）で提出し直し、この版は編集できなくなります。よければもう一度「提出する」を押してください'
      : '提出すると見積番号が付き、この版は編集できなくなります。よければもう一度「提出する」を押してください'], true);
    clearTimeout(s.armTimer);
    s.armTimer = setTimeout(() => { if (eue === s) { eueDisarmIssue(s); s.els.val.replaceChildren(); } }, 8000);
    eueSyncBar(s);
    return;
  }
  s.armIssue = false;
  clearTimeout(s.armTimer);
  s.busy = 'issue';
  eueSyncBar(s);
  eueLockInputs(s, true); // 提出中の入力は保存されずに消えるので止める
  let row = null, msg = '';
  try {
    await eueFlush(s);
    if (s.dirty) throw new Error('保存できていません: ' + (s.saveErr || ''));
    row = await EstimatesApi.issue(s.id);
  } catch (e) {
    msg = '提出できませんでした: ' + errText(e);
  }
  s.busy = '';
  if (eue !== s) return;
  if (msg) { eueLockInputs(s, false); eueSyncBar(s); eueShowVal(s, msg.split('\n')); return; }
  eueLsDel(s.id);
  s.row = Object.assign({}, s.row, row);
  s.readOnly = true;
  s.latest = true;
  s.notice = (row && row.reedit_mark ? '再提出しました（' + EstimatesApi.displayNumber(s.row) + '）。管理者に知らせました。この版は編集できません'
    : '提出しました（' + EstimatesApi.displayNumber(s.row) + '）。この版は編集できません')
    + (row && row.autoNotice ? '。工事掲示の下書きを自動で作りました（案件ページの表の「工事掲示」から直せます）' : '')
    + (row && row.autoNoticeError ? '。工事掲示の下書きは作れませんでした（' + row.autoNoticeError + '）' : '');
  eueBuild(s);
  eueSetSave(s, '');
  eueSyncBar(s);
  EstimateLayout.scrollTop();
}

// 提出中は入力・行の操作を止める。解除時は元の無効状態（備考の未チェックの欄など）に戻す
function eueLockInputs(s, on) {
  const root = $('eu-left') || $('estimate-root'); // 上のバーのボタンは s.busy（eueSyncBar）で止める
  if (on) {
    s.locked = [];
    root.querySelectorAll('input, select, textarea, button').forEach(e => {
      if (e === s.els.back || e.disabled) return;
      e.disabled = true;
      s.locked.push(e);
    });
  } else {
    (s.locked || []).forEach(e => { e.disabled = false; });
    s.locked = null;
  }
}

/* ---------- 入口 ---------- */
function eueMessage(text, isErr, backHash) {
  EstimateLayout.unmount(); // ボタンを下部バーへ戻してから描き直す
  $('estimate-bar').hidden = true;
  const nodes = [];
  nodes.push(dBtn('← 戻る', 'back', () => { location.hash = backHash || ''; }));
  nodes.push(mk('div', isErr ? 'err' : 'empty', text));
  $('estimate-root').replaceChildren(...nodes);
}

async function openEstimate(id) {
  if (eue && eue.id === id && !eue.left && $('screen-estimate').classList.contains('active')) return; // 二重読み込み防止
  const seq = ++eueSeq;
  const prev = eue;
  showScreen('estimate');
  renderHeaders();
  eueMessage('読み込み中…', false);
  if (prev) {
    prev.left = true;
    clearTimeout(prev.timer);
    clearTimeout(prev.armTimer);
    if (prev.dirty) await eueFlush(prev); else await prev.chain;
  }
  if (seq !== eueSeq) return;
  eue = null;

  let row, caseRow, vers = [], linked = [], svReports = null;
  const fieldSv = typeof fieldHidesAdmin === 'function' && fieldHidesAdmin(); // Task 36: 現場用だけ「調査の内容」の欄
  try {
    row = await EstimatesApi.get(id);
    if (row) {
      [caseRow, vers, linked, svReports] = await Promise.all([
        typeof currentCase !== 'undefined' && currentCase && currentCase.id === row.case_id ? currentCase : CasesApi.getSummary(row.case_id),
        EstimatesApi.listVersions(row.series_id),
        EstimatesApi.linkedRequests(row),
        // 調査の報告書（読めなくても見積は開く。欄に読み込めなかったと出す）
        fieldSv ? ReportsApi.listByCase(row.case_id).then(r => ({ list: r || [] }), e => ({ err: errText(e) })) : null
      ]);
    }
  } catch (e) {
    if (seq !== eueSeq) return;
    eueMessage('見積書を読み込めませんでした: ' + errText(e), true);
    return;
  }
  if (seq !== eueSeq) return;
  if (!row) { eueMessage('見積書が見つかりません', false); return; }
  caseRow = caseRow || { id: row.case_id, name: '' };

  const s = {
    id: row.id, gen: seq, row, caseRow, data: eueNormData(row.data), lines: eueNormLines(row.lines),
    readOnly: row.status !== 'draft',
    dirty: false, rev: 0, timer: null, chain: Promise.resolve(), saveState: '', saveErr: '', lastSaved: null,
    busy: '', armIssue: false, armTimer: null, left: false, notice: '', els: {}, inflight: null, locked: null,
    latest: !(vers || []).some(v => (Number(v.version) || 0) > (Number(row.version) || 0)),
    seriesNumber: ((vers || []).find(v => v.number) || {}).number || '',
    linked: linked || [],
    // 利益率（%。見積ごと。未設定なら会社設定の既定値、無ければ 0）・読み込んだ業者PDF（Task 19・migration 036）
    margin: euMarginOf(row),
    sourcePdf: row.source_pdf_path || null,
    imp: null
  };

  if (svReports) s.survey = eueSurveyOf(s, svReports);
  if (eueFlash && eueFlash.id === s.id) s.notice = eueFlash.text;
  eueFlash = null;
  let restored = false;
  const ls = eueLsGet(s.id);
  if (ls && !s.readOnly) {
    // 端末の入力がサーバーと同じ（保存は届いている）なら何もしない
    const same = eueSameContent(ls, row) && (ls.m === undefined || EstimateLogic.normMargin(ls.m) === s.margin) && (ls.pdf === undefined || (ls.pdf || null) === s.sourcePdf);
    let use = !same && (eueSameStamp(ls.base, row.updated_at) || eueSameContent(ls.p, row));
    if (!same && !use) {
      use = await askLocalDraft('見積書', ls.t);
      if (seq !== eueSeq) return; // 聞いている間に別の画面へ（退避は残す）
    }
    if (use) {
      s.data = eueNormData(ls.d);
      s.lines = eueNormLines(ls.l);
      if (ls.m !== undefined && EstimateLogic.normMargin(ls.m) !== null) s.margin = EstimateLogic.normMargin(ls.m);
      if (ls.pdf !== undefined) s.sourcePdf = ls.pdf || null;
      s.dirty = true;
      restored = true;
    } else eueLsDel(s.id);
  } else if (ls) eueLsDel(s.id);

  eue = s;
  eueBuild(s);
  if (!restored && !s.readOnly && row.updated_at) s.lastSaved = new Date(row.updated_at); // Task 61: 開いたときも「保存しました HH:MM」
  eueSetSave(s, restored ? 'restored' : s.lastSaved ? 'saved' : '');
  $('estimate-bar').hidden = false;
  $('eu-pdf').onclick = () => euePdf(s);
  $('eu-issue').onclick = () => eueIssue(s);
  eueSyncBar(s);
  if (restored) eueFlush(s);
}

/* ======================= ⑮ PDFプレビュー ======================= */
let eupSeq = 0;
let eup = null;

function eupMessage(text, isErr, backId) {
  const nodes = [dBtn('← 見積書に戻る', 'back', () => { location.hash = backId ? '#estimate/' + backId : ''; })];
  nodes.push(mk('div', isErr ? 'err' : 'empty', text));
  $('estimate-pdf-root').replaceChildren(...nodes);
}

async function openEstimatePdf(id) {
  if (eup && eup.id === id && $('screen-estimate-pdf').classList.contains('active')) return;
  const gen = ++eupSeq;
  const st = eup = { id, gen, est: null, caseRow: null, logoUrl: '', busy: false };
  showScreen('estimate-pdf');
  renderHeaders();
  eupMessage('読み込み中…', false, id);
  // 編集画面の保存待ちがあれば先に終わらせる（最新の内容で描く）
  if (eue && eue.id === id && (eue.dirty || eue.timer)) await eueFlush(eue);
  let est, caseRow, logo;
  try {
    est = await EstimatesApi.get(id);
    if (gen !== eupSeq) return;
    if (!est) { eupMessage('見積書が見つかりません', false); return; }
    const org = ctx.org || {};
    [caseRow, logo] = await Promise.all([
      CasesApi.getSummary(est.case_id),
      org.logo_path ? AppStorage.getUrl(org.logo_path).catch(() => '') : Promise.resolve('')
    ]);
  } catch (e) {
    if (gen !== eupSeq) return;
    eupMessage('PDFプレビューを読み込めませんでした: ' + errText(e), true, id);
    return;
  }
  if (gen !== eupSeq) return;
  st.est = est;
  st.caseRow = caseRow || { id: est.case_id, name: '' };
  st.logoUrl = logo || '';

  const back = dBtn('← 見積書に戻る', 'back', () => { location.hash = '#estimate/' + id; });
  const top = mk('div', 'cb-row');
  top.appendChild(back);
  CaseBand.attach(top, back, st.caseRow).id = 'eu-pdf-place'; // Task 30: 物件名と号室の帯
  const head = mk('div', 'rep-between rep-pdf-head');
  const hl = mk('div');
  hl.append(mk('b', null, 'PDFプレビュー'), mk('div', 'rep-sub', euNumberText(est) + ' ・ ' + euYen(est.total) + '（税込）'));
  head.append(hl, euPill(est.status));
  const acts = mk('div', 'rep-acts');
  const dl = dBtn('PDFをダウンロード', 'btn inline', () => eupDownload(st));
  dl.id = 'eu-pdf-download';
  acts.appendChild(dl);
  const msg = mk('div', 'err');
  msg.id = 'eu-pdf-msg';
  const pv = mk('div');
  pv.id = 'eu-preview';
  const shr = mk('div', 'dsh-box'); // Task 68: 共有（メール・LINE）。管理者と、現場用で自分が登録した案件の作業担当者だけ（js/share-ui.js）
  shr.id = 'eu-pdf-share';
  $('estimate-pdf-root').replaceChildren(top, head, acts, shr, msg, pv);
  ShareUi.mount(shr, { doc: 'estimate', row: est, caseRow: st.caseRow, makeBlob: () => EstimatePdf.toBlob(st.est, st.caseRow, ctx.org || {}, st.logoUrl),
    onChange: () => { if (st === eup) { eup = null; openEstimatePdf(id); } } });
  try {
    EstimatePdf.preview(pv, est, st.caseRow, ctx.org || {}, st.logoUrl);
  } catch (e) {
    setMsg('eu-pdf-msg', 'プレビューを描けませんでした: ' + errText(e));
  }
}

async function eupDownload(st) {
  if (st.busy || st !== eup || !st.est) return;
  st.busy = true;
  const btn = $('eu-pdf-download');
  btn.disabled = true;
  btn.textContent = 'PDFを作成中…';
  setMsg('eu-pdf-msg', '');
  let blob = null, msg = '';
  try { blob = await EstimatePdf.toBlob(st.est, st.caseRow, ctx.org || {}, st.logoUrl); }
  catch (e) { msg = 'PDFを作成できませんでした: ' + errText(e); }
  st.busy = false;
  if (st !== eup) return;
  btn.disabled = false;
  btn.textContent = 'PDFをダウンロード';
  if (msg) { setMsg('eu-pdf-msg', msg); return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = EstimatePdf.fileName(st.est);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

let eupResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(eupResizeTimer);
  eupResizeTimer = setTimeout(() => {
    const pv = $('eu-preview');
    if (pv && $('screen-estimate-pdf').classList.contains('active')) EstimatePdf.fit(pv);
  }, 150);
});
window.addEventListener('hashchange', () => {
  if (eup && !ESTIMATE_PDF_HASH_RE.test(location.hash)) eup = null; // 戻ってきたら読み直す
});

/* ======================= ⑯ 版の差分 ======================= */
let eudSeq = 0;
let eudId = null;

function eudMessage(text, isErr, backId) {
  const nodes = [dBtn('← 見積書に戻る', 'back', () => { location.hash = backId ? '#estimate/' + backId : ''; })];
  nodes.push(mk('div', isErr ? 'err' : 'empty', text));
  $('estimate-diff-root').replaceChildren(...nodes);
}
const euSigned = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + '¥' + EstimateLogic.fmt(Math.abs(n));
const euLineLabel = l => [euStr(l.description) || '（摘要なし）', euStr(l.detail)].filter(Boolean).join(' ／ ') + (EstimateLogic.isAdjustLine(l) ? '（端数調整）' : '');
const euSignCls = n => (n < 0 ? 'down' : n > 0 ? 'up' : '');

async function openEstimateDiff(id) {
  if (eudId === id && $('screen-estimate-diff').classList.contains('active')) return;
  const seq = ++eudSeq;
  eudId = id;
  showScreen('estimate-diff');
  renderHeaders();
  eudMessage('読み込み中…', false, id);
  if (eue && eue.id === id && (eue.dirty || eue.timer)) await eueFlush(eue); // 編集中の版なら保存してから比べる
  let next, vers;
  try {
    next = await EstimatesApi.get(id);
    if (next) vers = await EstimatesApi.listVersions(next.series_id);
  } catch (e) {
    if (seq !== eudSeq) return;
    eudMessage('差分を読み込めませんでした: ' + errText(e), true, id);
    return;
  }
  if (seq !== eudSeq) return;
  if (!next) { eudMessage('見積書が見つかりません', false); return; }
  const v = Number(next.version) || 1;
  const prev = (vers || []).filter(x => (Number(x.version) || 0) < v).sort((a, b) => b.version - a.version)[0];
  if (!prev) { eudMessage('第1版なので、比べる前の版がありません', false, id); return; }
  const d = EstimateLogic.diff(prev, next);

  const back = dBtn('← 見積書に戻る', 'back', () => { location.hash = '#estimate/' + id; });
  const list = dBtn('見積書一覧', 'btn sm ghost inline', () => { location.hash = '#case/' + next.case_id + '/estimates'; });
  const top = mk('div', 'rep-between rep-ed-top');
  top.append(back, list);

  const head = mk('div', 'rep-card');
  head.appendChild(mk('h3', null, 'v' + prev.version + ' → v' + v + ' の差分'));
  head.appendChild(mk('div', 'rep-sub', (EstimatesApi.displayNumber(next) || EstimatesApi.displayNumber(prev) || '番号なし') + ' ・ ' + (euStr(next.data && next.data.subject) || '')));
  const tot = mk('dl', 'rep-auto eu-dtot');
  tot.id = 'eud-total';
  [['前の版（v' + prev.version + '）', euYen(d.total.prev)], ['この版（v' + v + '）', euYen(d.total.next)],
    ['見積金額の差', euSigned(d.total.delta)], ['小計の差（税抜）', euSigned(d.subtotalDelta)]]
    .forEach(([k, val], i) => {
      const dd = mk('dd', i >= 2 ? 'eu-num eu-diff' + (i === 2 ? (d.total.delta < 0 ? ' down' : d.total.delta > 0 ? ' up' : '') : '') : 'eu-num', val);
      if (i === 2) dd.id = 'eud-delta';
      tot.append(mk('dt', null, k), dd);
    });
  head.appendChild(tot);
  if (d.same) head.appendChild(mk('div', 'empty', '明細に違いはありません'));

  const section = (ttl, id, items, render) => {
    const c = mk('div', 'rep-card');
    c.id = id;
    c.appendChild(mk('h3', null, ttl + '（' + items.length + '行）'));
    if (!items.length) c.appendChild(mk('div', 'rep-sub', 'なし'));
    items.forEach(it => c.appendChild(render(it)));
    return c;
  };
  const row = (label, sub, amt, cls) => {
    const r = mk('div', 'eu-drow');
    const l = mk('div');
    l.append(mk('b', null, label), mk('div', 'rep-sub', sub));
    r.append(l, mk('div', 'eu-num eu-damt' + (cls ? ' ' + cls : ''), amt));
    return r;
  };
  const qty = l => (l.isAutoShokehi ? '諸経費 ' + l.shokehiPct + '%' : (l.quantity + ' ' + euStr(l.unit))) + (l.postTax ? ' ・ 税対象外' : '');
  const changed = section('金額・内容が変わった行', 'eud-changed', d.changed, c => row(euLineLabel(c.after),
    euYen(c.before.amount) + ' → ' + euYen(c.after.amount) + ' ・ ' + qty(c.after) + (euLineLabel(c.before) !== euLineLabel(c.after) ? ' ・ 前: ' + euLineLabel(c.before) : ''),
    euSigned(c.delta), c.delta < 0 ? 'down' : c.delta > 0 ? 'up' : ''));
  const added = section('追加した行', 'eud-added', d.added, l => row(euLineLabel(l), qty(l), euSigned(Number(l.amount) || 0), euSignCls(Number(l.amount) || 0)));
  const removed = section('削除した行', 'eud-removed', d.removed, l => row(euLineLabel(l), qty(l), euSigned(-(Number(l.amount) || 0)), euSignCls(-(Number(l.amount) || 0))));
  const same = mk('div', 'rep-sub', '変わらない行: ' + d.unchanged + '行');
  same.id = 'eud-unchanged';
  $('estimate-diff-root').replaceChildren(top, head, changed, added, removed, same);
}
window.addEventListener('hashchange', () => {
  if (eudId && !ESTIMATE_DIFF_HASH_RE.test(location.hash)) eudId = null; // 戻ってきたら読み直す
});
