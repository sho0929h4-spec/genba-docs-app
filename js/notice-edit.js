// js/notice-edit.js — 工事掲示の作成・編集画面（#notice/{id}）… openNotice(id)
// 左に入力・右にライブプレビュー（960px未満は入力の下にプレビュー）。一覧は js/notice-ui.js。
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）
// mk() は case-list.js、dBtn / errText は case-detail.js、showScreen / renderHeaders / setMsg / $ は app.js のものを使う
// 文言・書式は NoticeLogic（js/notice-logic.js）、A4描画とPDFは NoticePdf（js/notice-pdf.js）、DBは NoticesApi。
//
// 自動保存: 入力から1.5秒で NoticesApi.save（data と一覧用の列を一緒に保存）。
//   同時に localStorage `notice-draft-{id}` へ退避（読み込み時のサーバー updated_at = base も）。
//   開いたとき、サーバーの updated_at が base と同じ（または送信中だった中身 p がサーバーと同じ）なら復元して保存し直す。
//   Task 61: それ以外でサーバーと中身が違えば、どちらを使うか聞く（askLocalDraft。勝手に捨てない・勝手に上書きしない）。
//   hashchange / beforeunload / pagehide（iPhone は beforeunload が来ない）/ 非表示化 / PDF作成 / 複製の前に、保留中の保存を flush する。
// プレビュー: 入力から300msで再描画。画面を離れるとき NoticePdf.dispose で ResizeObserver を解除する。
// 世代番号 nteSeq: 古い読み込み応答は捨てる。保存は1掲示につき直列（s.chain）。

const NTE_DELAY = 1500;
const NTE_PV_DELAY = 300;
const NTE_MAX_LEN = 80; // 号室・工事名称の上限（migration 015 の制約）
// app.js より先に読み込まれるので UUID_RE は使わず、同じ形をここに書く（app.js のルーターもこれを使う）
const NOTICE_HASH_RE = /^#notice\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const nteKey = id => 'notice-draft-' + id;
let nte = null;     // 表示中の編集セッション
let nteSeq = 0;     // openNotice のたびに増やす
let nteUid = 0;

/* ---------- この画面だけのCSS（index.html の工事掲示CSSに足りない分。ここで注入する） ---------- */
// ・PC: 入力を下へスクロールしてもプレビューが見え続けるよう、プレビュー列を sticky にする。
//   index.html の `html,body{overflow-x:hidden}` で body がスクロールの親になり sticky が効かなくなるため、この画面の間だけ body を clip にする
// ・スマホ: 入力↔プレビューのジャンプボタンを出す（PCでは隠す）
(function nteInjectStyle() {
  if (document.getElementById('nt-style')) return;
  const st = document.createElement('style');
  st.id = 'nt-style';
  st.textContent = [
    'body:has(#screen-notice.active){overflow-x:clip;}',
    '.nu-jump{margin:0 0 12px;}',
    '.nu-jump .btn{width:100%;max-width:none;}',
    '@media(min-width:960px){',
    '  .nu-jump{display:none;}',
    '  .nu-pv-col{position:sticky;top:12px;max-height:calc(100vh - 90px);max-height:calc(100dvh - 90px);overflow-y:auto;margin-top:0;}',
    '}'
  ].join('\n');
  document.head.appendChild(st);
})();

const nteClone = v => JSON.parse(JSON.stringify(v));
const nteObj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const nteStr = v => (v == null ? '' : String(v));

/* ---------- localStorage（使えない環境でも画面は動かす） ---------- */
function nteLsGet(id) {
  try {
    const o = JSON.parse(localStorage.getItem(nteKey(id)));
    return o && typeof o === 'object' && o.d && typeof o.d === 'object' && !Array.isArray(o.d) ? o : null;
  } catch (e) { return null; }
}
function nteLsSet(s) {
  try { localStorage.setItem(nteKey(s.id), JSON.stringify({ t: Date.now(), base: s.row.updated_at || null, d: s.data, p: s.inflight || null })); }
  catch (e) { /* 容量不足など。サーバ保存が本線 */ }
}
function nteLsDel(id) { try { localStorage.removeItem(nteKey(id)); } catch (e) { /* 何もしない */ } }

/* ---------- data の正規化（足りないキーは初期値で埋める。知らないキーは残す） ---------- */
function nteNormalize(raw, caseRow) {
  const base = NoticeLogic.emptyData(caseRow);
  const d = nteObj(raw);
  const out = Object.assign({}, base, d);
  out.workTypes = Object.assign({}, base.workTypes, nteObj(d.workTypes));
  out.contact = Object.assign({}, base.contact, nteObj(d.contact));
  out.overrides = nteObj(d.overrides);
  Object.keys(out.workTypes).forEach(k => { out.workTypes[k] = !!out.workTypes[k]; });
  ['propertyName', 'addressee', 'workDate', 'workDateEnd', 'timeStart', 'timeEnd', 'roomNo', 'workName', 'drainRooms',
    'otherWorkText', 'otherNotice'].forEach(k => { out[k] = nteStr(out[k]); });
  ['company', 'address', 'tel'].forEach(k => { out.contact[k] = nteStr(out.contact[k]); });
  ['addresseeEdited', 'noticeKichijitsu', 'workDateTbd', 'timePlanned'].forEach(k => { out[k] = !!out[k]; });
  return out;
}

/* ---------- 入力の整合（DB の制約: migration 015 work_date_end >= work_date） ---------- */
// 終了日が開始日より前なら保存できない。問題が無ければ ''
// 「工事日は未定」のときは日付を使わない（一覧用の列も null で保存する）ので調べない
function nteDateError(d) {
  if (d.workDateTbd) return '';
  const a = String(d.workDate || ''), b = String(d.workDateEnd || '');
  return a && b && b < a ? '工事日の終了は開始日以降にしてください（このままでは保存されません）' : '';
}
function nteShowDateErr(s) {
  const msg = nteDateError(s.data);
  s.els.dateErr.textContent = msg;
  s.els.dateErr.hidden = !msg;
  return msg;
}

/* ---------- 保存 ---------- */
function nteSetSave(s, state) {
  s.saveState = state;
  const el = s.els.save;
  if (!el) return;
  s.els.retry.hidden = state !== 'error';
  el.className = 'rep-save' + (state === 'saved' ? '' : state === 'error' ? ' err' : ' busy');
  const p = n => String(n).padStart(2, '0');
  if (state === 'pending') el.textContent = '保存待ち…';
  else if (state === 'saving') el.textContent = '保存中…';
  else if (state === 'saved') { const d = s.lastSaved || new Date(); el.textContent = '保存しました ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  else if (state === 'error') el.textContent = '保存できませんでした: ' + (s.saveErr || '');
  else if (state === 'invalid') { el.className = 'rep-save err'; el.textContent = '入力に誤りがあるため保存していません'; }
  else if (state === 'restored') { el.className = 'rep-save busy'; el.textContent = '前回の未保存の入力を復元しました'; }
  else el.textContent = '';
}

// 入力が変わったとき: 退避・保存待ち・プレビュー再描画の予約
function nteChanged(s) {
  s.rev++;
  s.dirty = true;
  nteLsSet(s);
  if (s.els.val && s.els.val.firstChild) s.els.val.replaceChildren();
  if (s.els.dateErr) nteShowDateErr(s);
  nteSetSave(s, 'pending');
  clearTimeout(s.timer);
  s.timer = setTimeout(() => nteFlush(s), NTE_DELAY);
  clearTimeout(s.pvTimer);
  s.pvTimer = setTimeout(() => nteRenderPreview(s), NTE_PV_DELAY);
}

// 保留中の保存を今すぐ実行し、終わるまで待つ（保存は直列。失敗しても throw しない: s.dirty が残る）
function nteFlush(s) {
  clearTimeout(s.timer);
  s.timer = null;
  s.chain = s.chain.then(() => nteDoSave(s)).catch(e => { // 想定外の例外でも以降の保存を止めない
    s.dirty = true;
    s.saveErr = errText(e);
    nteSetSave(s, 'error');
  });
  return s.chain;
}
async function nteDoSave(s) {
  if (!s.dirty) return;
  if (nteDateError(s.data)) { nteSetSave(s, 'invalid'); return; } // 保存しない（直すと次の自動保存で保存される）
  const data = nteClone(s.data);
  s.dirty = false;
  s.inflight = data;
  nteLsSet(s); // Task 61: 送信中の中身も退避（届いた後にページが閉じても、開き直したとき「自分の保存」と分かる）
  nteSetSave(s, 'saving');
  try {
    const row = await NoticesApi.save(s.id, data);
    s.inflight = null;
    if (row && row.updated_at) s.row.updated_at = row.updated_at;
    s.lastSaved = new Date();
    if (s.dirty) { nteLsSet(s); nteSetSave(s, 'pending'); } // 保存中にさらに入力があった（次のタイマーで保存）。退避の base を新しいサーバー値に合わせる
    else { nteLsDel(s.id); nteSetSave(s, 'saved'); }
  } catch (e) {
    s.inflight = null;
    s.dirty = true;
    s.saveErr = errText(e);
    nteSetSave(s, 'error');
  }
}

// 編集画面の保存が全部終わるのを待つ（一覧など他の画面が、保存前の古い行を読まないため）。保留中の保存があれば今すぐ始める
function nteSettle() {
  const s = nte;
  if (!s) return Promise.resolve();
  if (s.timer) nteFlush(s);
  return s.chain;
}

window.addEventListener('hashchange', () => {
  const s = nte;
  if (!s) return;
  if (s.dirty) nteFlush(s);
  // 掲示の画面から出た: プレビューの監視を止める（同じ掲示のままなら何もしない）
  if (!NOTICE_HASH_RE.test(location.hash)) nteLeave(s);
});
['beforeunload', 'pagehide'].forEach(t => window.addEventListener(t, () => { if (nte && nte.dirty) nteFlush(nte); }));
document.addEventListener('visibilitychange', () => { if (document.hidden && nte && nte.dirty) nteFlush(nte); });

function nteLeave(s) {
  clearTimeout(s.pvTimer);
  s.pvTimer = null;
  if (s.els.preview) NoticePdf.dispose(s.els.preview);
  s.left = true;
}

/* ---------- 部品 ---------- */
function nteId(prefix) { return prefix + '-' + (++nteUid); }

function nteField(label, control, hint) {
  const wrap = mk('div', 'rep-ff');
  if (!control.id) control.id = nteId('nt-auto');
  const l = mk('label', null, label);
  l.htmlFor = control.id;
  wrap.appendChild(l);
  if (hint) wrap.appendChild(mk('span', 'rep-hint', hint));
  wrap.appendChild(control);
  return wrap;
}
function nteInput(id, type, value, onInput, extra) {
  const i = document.createElement('input');
  i.type = type;
  i.id = id;
  i.value = value == null ? '' : value;
  if (extra && extra.placeholder) i.placeholder = extra.placeholder;
  if (extra && extra.min != null) i.min = extra.min;
  if (extra && extra.max != null) i.max = extra.max;
  if (extra && extra.maxLength) i.maxLength = extra.maxLength;
  if (type === 'text') i.autocomplete = 'off';
  const h = () => onInput(i.value);
  i.addEventListener('input', h);
  if (type !== 'text') i.addEventListener('change', h);
  return i;
}
function nteSelect(id, options, value, onChange) {
  const sel = document.createElement('select');
  sel.id = id;
  options.forEach(o => sel.appendChild(new Option(o[1], o[0])));
  sel.value = value;
  if (sel.value !== value) sel.value = options.length ? options[0][0] : '';
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}
function nteCheck(id, label, checked, onChange) {
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
const nteIntOrEmpty = v => { const n = parseInt(v, 10); return isNaN(n) ? '' : n; };

/* ---------- 画面の組み立て ---------- */
function nteBuild(s) {
  const NL = NoticeLogic, els = s.els, d = s.data;
  const set = fn => { fn(d); nteChanged(s); };

  // 上部: 戻る・保存状態
  const top = mk('div', 'rep-between rep-ed-top');
  const fb = (typeof fieldBack === 'function' ? fieldBack(s.row.case_id) : null); // 現場用から開いたときは「‹ ツール」（js/field-ui.js。Task 18）
  els.back = dBtn(fb ? fb.label : '← 掲示一覧', 'back', async () => {
    if (s.busy) return;
    await nteFlush(s);
    if (s.timer) await nteFlush(s); // 保存中に入力が続いた分
    if (nte !== s) return;
    if (s.dirty) { // 保存失敗・日付エラーが残っている。端末には残してあるので、そのことを伝えてから戻る
      nteLsSet(s);
      if (!(await askPopup('未保存の変更があります。この端末に残しています。\nこのまま一覧に戻りますか？', { title: '保存できていません', okLabel: 'このまま戻る' })) || nte !== s) return;
    }
    location.hash = fb ? fb.hash : '#case/' + s.row.case_id + '/notices';
  });
  top.appendChild(els.back);
  CaseBand.attach(top, els.back, s.caseRow).id = 'nt-place'; // Task 30: 物件名と号室の帯
  const saveBox = mk('div', 'rep-acts');
  els.save = mk('span', 'rep-save');
  els.save.id = 'nt-save';
  els.save.setAttribute('role', 'status');
  els.retry = dBtn('再試行', 'btn sm ghost inline', () => nteFlush(s));
  els.retry.id = 'nt-retry';
  els.retry.hidden = true;
  saveBox.append(els.save, els.retry);
  top.appendChild(saveBox);

  const notice = mk('div', 'rep-sub');
  notice.id = 'nt-notice';
  notice.textContent = s.notice || '';
  notice.hidden = !s.notice;

  els.val = mk('div', 'rep-val');
  els.val.id = 'nt-val';
  els.val.setAttribute('role', 'alert');

  /* ----- 入力カード ----- */
  // 宛名: 手入力があれば優先。手で消したら自動生成に戻る
  const addrAuto = () => NL.autoAddressee(d.propertyName);
  const addrShown = () => (d.addresseeEdited ? d.addressee : addrAuto());

  const card1 = mk('div', 'rep-card');
  card1.appendChild(mk('h3', null, '宛先・日付'));
  els.prop = nteInput('nt-prop', 'text', d.propertyName, v => {
    set(x => { x.propertyName = v; });
    if (!d.addresseeEdited) { els.addr.value = addrAuto(); }
    els.addr.placeholder = addrAuto();
  }, { placeholder: '例：グランメゾン中野' });
  card1.appendChild(nteField('物件名 *', els.prop, '案件名が入っています。必要なら書き換えられます'));

  els.addr = nteInput('nt-addr', 'text', addrShown(), v => {
    set(x => {
      if (v.trim() === '') { x.addresseeEdited = false; x.addressee = ''; }
      else { x.addresseeEdited = true; x.addressee = v; }
    });
  }, { placeholder: addrAuto() || '○○に居住中の皆様へ' });
  els.addr.addEventListener('change', () => { if (!d.addresseeEdited) els.addr.value = addrAuto(); });
  card1.appendChild(nteField('宛名', els.addr, '物件名から自動で作ります。書き換えると、そちらが優先されます'));
  const resetAddr = dBtn('自動生成に戻す', 'btn sm ghost inline', () => {
    set(x => { x.addresseeEdited = false; x.addressee = ''; });
    els.addr.value = addrAuto();
  });
  resetAddr.id = 'nt-addr-reset';
  resetAddr.style.marginBottom = '12px';
  card1.appendChild(resetAddr);

  // 通知日: 年・月・日。「吉日」ON のあいだ日は隠す
  const dayWrap = mk('div');
  els.day = nteInput('nt-day', 'number', d.noticeDay, v => set(x => { x.noticeDay = nteIntOrEmpty(v); }), { min: 1, max: 31 });
  dayWrap.appendChild(nteField('日', els.day));
  const syncDay = () => { dayWrap.hidden = !!d.noticeKichijitsu; };
  const g3 = mk('div', 'nu-g3');
  els.year = nteInput('nt-year', 'number', d.noticeYear, v => set(x => { x.noticeYear = nteIntOrEmpty(v); }), { min: 2000, max: 2100 });
  const months = Array.from({ length: 12 }, (_, i) => [String(i + 1), (i + 1) + '月']);
  els.month = nteSelect('nt-month', months, String(d.noticeMonth || 1), v => set(x => { x.noticeMonth = parseInt(v, 10); }));
  g3.append(nteField('通知日 年', els.year), nteField('月', els.month), dayWrap);
  card1.appendChild(g3);
  els.kichi = nteCheck('nt-kichi', '吉日にする（日付を書かない）', d.noticeKichijitsu, v => { set(x => { x.noticeKichijitsu = v; }); syncDay(); });
  card1.appendChild(els.kichi);
  syncDay();

  /* ----- 工事 ----- */
  const card2 = mk('div', 'rep-card');
  card2.appendChild(mk('h3', null, '工事'));
  els.room = nteInput('nt-room', 'text', d.roomNo, v => set(x => { x.roomNo = v; }), { placeholder: '例：502（「号室」は自動で付きます）', maxLength: NTE_MAX_LEN });
  els.work = nteInput('nt-workname', 'text', d.workName, v => set(x => { x.workName = v; }), { placeholder: '例：復旧工事', maxLength: NTE_MAX_LEN });
  const g2 = mk('div', 'rep-g2');
  g2.append(nteField('号室 *', els.room), nteField('工事名称 *', els.work));
  card2.appendChild(g2);

  // 工事日: 開始・終了（終了が空なら1日）・未定
  els.date = nteInput('nt-date', 'date', d.workDate, v => set(x => { x.workDate = v; }));
  els.dateEnd = nteInput('nt-date-end', 'date', d.workDateEnd, v => set(x => { x.workDateEnd = v; }));
  const gd = mk('div', 'rep-g2');
  gd.append(nteField('工事日 開始', els.date), nteField('終了（1日だけなら空）', els.dateEnd));
  card2.appendChild(gd);
  els.dateErr = mk('div', 'err');
  els.dateErr.id = 'nt-date-err';
  els.dateErr.setAttribute('role', 'alert');
  els.dateErr.hidden = true;
  els.dateErr.style.marginTop = '-4px';
  els.dateErr.style.marginBottom = '8px';
  card2.appendChild(els.dateErr);
  const syncTbd = () => { els.date.disabled = els.dateEnd.disabled = !!d.workDateTbd; };
  els.tbd = nteCheck('nt-tbd', '工事日は未定', d.workDateTbd, v => { set(x => { x.workDateTbd = v; }); syncTbd(); });
  card2.appendChild(els.tbd);
  syncTbd();
  nteShowDateErr(s);

  // 作業時間
  els.tStart = nteInput('nt-time-start', 'time', d.timeStart, v => set(x => { x.timeStart = v; }));
  els.tEnd = nteInput('nt-time-end', 'time', d.timeEnd, v => set(x => { x.timeEnd = v; }));
  const gt = mk('div', 'rep-g2');
  gt.append(nteField('作業時間 開始', els.tStart), nteField('終了', els.tEnd));
  card2.appendChild(gt);
  els.planned = nteCheck('nt-planned', '「（予定）」を付ける', d.timePlanned, v => set(x => { x.timePlanned = v; }));
  card2.appendChild(els.planned);

  /* ----- 工事内容 ----- */
  const card3 = mk('div', 'rep-card');
  card3.appendChild(mk('h3', null, '工事内容（当てはまるものを選ぶ）'));
  NL.WORK_TYPES.forEach(w => {
    card3.appendChild(nteCheck('nt-wt-' + w.key, w.label, d.workTypes[w.key], v => {
      set(x => { x.workTypes[w.key] = v; });
      if (w.extra) wrap.hidden = !v;
    }));
    let wrap = null;
    if (w.extra) {
      wrap = mk('div', 'nu-extra');
      const inp = nteInput('nt-' + w.extra.id, 'text', d[w.extra.id], v => set(x => { x[w.extra.id] = v; }), { placeholder: w.extra.placeholder });
      wrap.appendChild(nteField(w.extra.label, inp));
      wrap.hidden = !d.workTypes[w.key];
      card3.appendChild(wrap);
    }
  });
  els.other = document.createElement('textarea');
  els.other.id = 'nt-other-notice';
  els.other.value = d.otherNotice;
  els.other.placeholder = '例：工事期間中は共用廊下に資材を置かせていただきます。';
  els.other.addEventListener('input', () => set(x => { x.otherNotice = els.other.value; }));
  const otherBox = mk('div');
  otherBox.style.marginTop = '12px';
  otherBox.appendChild(nteField('その他のお知らせ（1行ずつ本文に入ります）', els.other));
  card3.appendChild(otherBox);

  /* ----- お問い合わせ先 ----- */
  const card5 = mk('div', 'rep-card');
  card5.appendChild(mk('h3', null, 'お問い合わせ先'));
  els.contact = mk('dl', 'rep-auto');
  els.contact.id = 'nt-contact';
  card5.appendChild(els.contact);
  card5.appendChild(mk('div', 'rep-hint', '作成した時点の会社情報を保存しています。会社マスタを変えても、過去の掲示は変わりません'));
  const crow = mk('div', 'rep-acts');
  crow.style.marginTop = '8px';
  els.cBtn = dBtn('会社マスタの最新に更新', 'btn sm ghost inline', () => nteRefreshContact(s));
  els.cBtn.id = 'nt-contact-refresh';
  els.cMsg = mk('span', 'rep-sub');
  els.cMsg.id = 'nt-contact-msg';
  els.cMsg.setAttribute('role', 'status');
  crow.append(els.cBtn, els.cMsg);
  card5.appendChild(crow);

  // スマホ: プレビューへ飛ぶボタン（入力の先頭付近）。PCでは CSS で隠す
  const jumpSmooth = () => (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
  const toPv = mk('div', 'nu-jump');
  els.toPv = dBtn('プレビューを見る ↓', 'btn sm ghost', () => pvCol.scrollIntoView({ block: 'start', behavior: jumpSmooth() }));
  els.toPv.id = 'nt-to-pv';
  toPv.appendChild(els.toPv);

  const form = mk('div', 'nu-form');
  form.append(toPv, card1, card2, card3, card5);

  /* ----- プレビュー ----- */
  const pvTtl = mk('div', 'rep-between');
  pvTtl.appendChild(mk('h3', null, 'プレビュー（A4縦1枚）'));
  els.pvWarn = mk('div', 'rep-val');
  els.pvWarn.id = 'nt-pv-warn';
  els.pvWarn.setAttribute('role', 'status');
  els.preview = mk('div');
  els.preview.id = 'nt-preview';
  const toForm = mk('div', 'nu-jump');
  els.toForm = dBtn('入力に戻る ↑', 'btn sm ghost', () => form.scrollIntoView({ block: 'start', behavior: jumpSmooth() }));
  els.toForm.id = 'nt-to-form';
  toForm.appendChild(els.toForm);
  const pvCol = mk('div', 'nu-pv-col');
  pvCol.append(toForm, pvTtl, els.pvWarn, els.preview);

  const layout = mk('div', 'nu-layout');
  layout.append(form, pvCol);
  // Task 79: LINE・メールで共有（js/share-ui.js。出せない人には ShareUi が隠す）
  els.share = mk('div', 'dsh-box');
  els.share.id = 'nt-share';
  $('notice-root').replaceChildren(top, notice, els.val, els.share, layout);
  nteRenderContact(s);
}

function nteRenderContact(s) {
  const c = s.data.contact || {};
  const rows = [['会社名', c.company], ['住所', c.address], ['電話', c.tel]];
  const nodes = [];
  rows.forEach(([k, v]) => {
    nodes.push(mk('dt', null, k));
    const dd = mk('dd', null, v || '（未登録）');
    if (!v) dd.style.color = 'var(--muted)';
    nodes.push(dd);
  });
  s.els.contact.replaceChildren(...nodes);
}

// 会社マスタの最新で連絡先を上書きして保存（保存は直列の s.chain の中で行う）
async function nteRefreshContact(s) {
  if (s.busy || s.refreshing) return;
  const bad = nteDateError(s.data);
  if (bad) { s.els.cMsg.textContent = '先に工事日を直してください'; return; }
  s.refreshing = true;
  s.els.cBtn.disabled = true;
  s.els.cMsg.textContent = '更新中…';
  clearTimeout(s.timer);
  s.timer = null;
  let msg = '';
  s.chain = s.chain.then(async () => {
    const rev = s.rev;
    try {
      const row = await NoticesApi.refreshContact(s.id, nteClone(s.data));
      if (row && row.updated_at) s.row.updated_at = row.updated_at;
      s.data.contact = Object.assign({ company: '', address: '', tel: '' }, nteObj(row && row.data && row.data.contact));
      s.lastSaved = new Date();
      if (s.rev === rev) { s.dirty = false; nteLsDel(s.id); nteSetSave(s, 'saved'); }
      else { nteLsSet(s); nteSetSave(s, 'pending'); } // 更新中にさらに入力があった
      msg = '更新しました';
    } catch (e) {
      msg = '更新できませんでした: ' + errText(e);
    }
  });
  await s.chain;
  s.refreshing = false;
  if (nte !== s) return;
  s.els.cBtn.disabled = false;
  s.els.cMsg.textContent = msg;
  nteRenderContact(s);
  clearTimeout(s.pvTimer);
  nteRenderPreview(s);
  if (s.dirty) s.timer = setTimeout(() => nteFlush(s), NTE_DELAY);
}

/* ---------- プレビュー ---------- */
function nteRenderPreview(s) {
  if (nte !== s || s.left) return;
  const r = NoticePdf.preview(s.els.preview, s.data, s.caseRow);
  s.fit = r;
  const nodes = [];
  if (r.overflow) {
    nodes.push(mk('div', 'rep-val-e', '1ページに収まりません。文字を最小の80%まで小さくしても、下の部分が切れます。その他のお知らせなどを減らしてください'));
  } else if (r.scale < 1) {
    nodes.push(mk('div', 'rep-sub', '1ページに収めるため、文字を ' + Math.round(r.scale * 100) + '% に小さくしています'));
  }
  s.els.pvWarn.replaceChildren(...nodes);
}

/* ---------- 入力チェック表示 ---------- */
function nteShowVal(s, errors) {
  s.els.val.replaceChildren(...errors.map(t => mk('div', 'rep-val-e', t)));
  if (errors.length) s.els.val.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/* ---------- 下部バー ---------- */
function nteSyncBar(s) {
  const pdf = $('nt-pdf'), dup = $('nt-dup');
  pdf.disabled = dup.disabled = s.busy;
  pdf.textContent = s.busy === 'pdf' ? 'PDFを作成中…' : 'PDFをダウンロード';
  dup.textContent = '別の号室に複製'; // 下部バーで1行に収まる長さ（index.html の初期文言は長いので上書きする）
  if (s.els.back) s.els.back.disabled = !!s.busy;
}

// 入力チェック用の data（物件名が空なら案件名で補う。PDF・ファイル名と同じ扱い）
function nteChecked(s) {
  const d = nteClone(s.data);
  if (!String(d.propertyName || '').trim()) d.propertyName = nteStr(s.caseRow && s.caseRow.name);
  return d;
}

// PDF の前の入力チェック（ダウンロード・共有で同じ。Task 79）。だめなら画面に出して false
function nteValid(s) {
  const v = NoticeLogic.validate(nteChecked(s));
  const errs = [];
  if (!v.ok) errs.push(v.message);
  const de = nteDateError(s.data);
  if (de) errs.push(de);
  if (errs.length) nteShowVal(s, errs);
  return !errs.length;
}
// 1ページに収まらないときはこのまま作るか聞く
async function nteFits(s) {
  return !NoticePdf.check(s.data, s.caseRow).overflow
    || askPopup('1ページに収まらず、下の部分が切れます。このままPDFを作りますか？', { title: '1ページに収まりません', okLabel: 'このまま作る' });
}

async function nteDownload(s) {
  if (s.busy || !nteValid(s)) return;
  s.busy = 'pdf';
  nteSyncBar(s);
  let blob = null, errMsg = '';
  try {
    await nteFlush(s);
    if (!(await nteFits(s))) return;
    blob = await NoticePdf.toBlob(s.data, s.caseRow);
  } catch (e) {
    errMsg = 'PDFを作成できませんでした: ' + errText(e);
  } finally {
    s.busy = '';
    nteSyncBar(s);
  }
  if (errMsg) { nteShowVal(s, [errMsg]); return; }
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = NoticePdf.fileName(s.data, s.caseRow);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  // Task 80: 出した記録（報告書の「工事掲示を取り外した」の条件）。失敗してもダウンロードは済んでいる
  NoticesApi.markIssued(s.id).catch(e => console.warn('ダウンロードの記録に失敗', e));
}

// 今の入力を元に、号室を空にした新しい掲示を作って開く
async function nteDuplicate(s) {
  if (s.busy) return;
  const de = nteDateError(s.data);
  if (de) { nteShowVal(s, [de]); return; }
  s.busy = 'dup';
  nteSyncBar(s);
  let made = null, errMsg = '';
  try {
    await nteFlush(s);
    made = await NoticesApi.duplicate({ case_id: s.row.case_id, data: nteClone(s.data) });
  } catch (e) {
    errMsg = '複製できませんでした: ' + errText(e);
  } finally {
    s.busy = '';
    nteSyncBar(s);
  }
  if (errMsg) { nteShowVal(s, [errMsg]); return; }
  if (nte !== s || !made) return;
  location.hash = '#notice/' + made.id; // → openNotice（号室の欄にフォーカス）
}

/* ---------- 共有（Task 79。報告書・見積書と同じ ShareUi・doc 'notice'） ---------- */
function nteMountShare(s) {
  const o = {
    doc: 'notice', row: s.row, caseRow: s.caseRow,
    get data() { return s.data; }, // 件名の号室・ファイル名は開いた時点の入力
    // ダウンロードと同じ入力チェック → 保存 → 1ページに収まらないときの確認
    before: async () => {
      if (s.busy || !nteValid(s)) return false;
      s.busy = 'share';
      nteSyncBar(s);
      try {
        await nteFlush(s);
        return nte === s && await nteFits(s);
      } catch (e) {
        nteShowVal(s, ['共有の準備ができませんでした: ' + errText(e)]);
        return false;
      } finally {
        s.busy = '';
        nteSyncBar(s);
      }
    },
    makeBlob: () => NoticePdf.toBlob(s.data, s.caseRow),
    onChange: () => { if (nte === s) ShareUi.mount(s.els.share, o); }
  };
  ShareUi.mount(s.els.share, o);
}

/* ---------- 入口 ---------- */
function nteMessage(text, isErr, back) {
  $('notice-bar').hidden = true;
  const nodes = [];
  const field = typeof fieldHidesAdmin === 'function' && fieldHidesAdmin();
  if (back) nodes.push(dBtn(field ? '‹ 案件' : '← 案件一覧へ', 'back', () => { location.hash = field ? '#f' : ''; }));
  nodes.push(mk('div', isErr ? 'err' : 'empty', text));
  $('notice-root').replaceChildren(...nodes);
}

async function openNotice(id) {
  const seq = ++nteSeq;
  const prev = nte;
  showScreen('notice');
  renderHeaders();
  nteMessage('読み込み中…', false);
  // 直前の画面で保留中の保存を終わらせてから読み込む（同じ掲示に戻ったとき古い内容を読まないため）
  if (prev) {
    nteLeave(prev);
    clearTimeout(prev.timer);
    if (prev.dirty) await nteFlush(prev); else await prev.chain;
  }
  if (seq !== nteSeq) return;
  nte = null;

  let row, caseRow;
  try {
    row = await NoticesApi.get(id);
    if (row) caseRow = currentCase && currentCase.id === row.case_id ? currentCase : await CasesApi.getSummary(row.case_id);
  } catch (e) {
    if (seq !== nteSeq) return;
    nteMessage('掲示を読み込めませんでした: ' + errText(e), true, true);
    return;
  }
  if (seq !== nteSeq) return;
  if (!row) { nteMessage('掲示が見つかりません', false, true); return; }
  caseRow = caseRow || { id: row.case_id, name: '' };

  const s = {
    id: row.id, gen: seq, row, caseRow, data: nteNormalize(row.data, caseRow),
    dirty: false, rev: 0, timer: null, pvTimer: null, chain: Promise.resolve(), saveState: '', saveErr: '', lastSaved: null,
    busy: '', refreshing: false, left: false, fit: null, notice: '', els: {}
  };

  // 端末に退避した入力の復元。端末の時計は使わず、退避した時点のサーバー updated_at（base）と
  // 今のサーバー updated_at が同じ（＝その後サーバーが変わっていない）か、送信中だった中身 p がサーバーと同じなら戻す。
  // Task 61: それ以外でサーバーと中身が違えば、どちらを使うか聞く（勝手に捨てない）。中身が同じなら退避を消すだけ
  let restored = false;
  const ls = nteLsGet(s.id);
  if (ls) {
    const sameAs = d => euStable(nteNormalize(d, caseRow)) === euStable(s.data); // euStable は estimate-ui.js
    const same = sameAs(ls.d);
    let use = !same && (nteSameStamp(ls.base, row.updated_at) || (ls.p && typeof ls.p === 'object' && sameAs(ls.p)));
    if (!same && !use) {
      use = await askLocalDraft('工事掲示', ls.t);
      if (seq !== nteSeq) return; // 聞いている間に別の画面へ（退避は残す）
    }
    if (use) {
      s.data = nteNormalize(ls.d, caseRow);
      s.dirty = true;
      restored = true;
    } else nteLsDel(s.id);
  }

  nte = s;
  nteBuild(s);
  if (!restored && row.updated_at) s.lastSaved = new Date(row.updated_at); // Task 61: 開いたときも「保存しました HH:MM」
  nteSetSave(s, restored ? 'restored' : s.lastSaved ? 'saved' : '');
  const bar = $('notice-bar');
  bar.hidden = false;
  $('nt-pdf').onclick = () => nteDownload(s);
  $('nt-dup').onclick = () => nteDuplicate(s);
  nteSyncBar(s);
  nteMountShare(s);
  nteRenderPreview(s); // 画面を表示してから描画する（非表示のままだと幅が0で縮小倍率が狂う）
  if (restored) nteFlush(s);
  // 複製した直後など、号室が空ならそこから入力してもらう
  if (!restored && !String(s.data.roomNo || '').trim()) s.els.room.focus({ preventScroll: true });
}

function nteSameStamp(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const x = Date.parse(a), y = Date.parse(b);
  return Number.isFinite(x) && x === y;
}
