// js/notice-ui.js — 工事掲示の一覧（#case/{id}/notices）… openNotices(caseId)
// 編集画面（#notice/{id}）は js/notice-edit.js。
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）
// mk() は case-list.js、dBtn / errText は case-detail.js、showScreen / renderHeaders / setMsg / $ は app.js のものを使う
//
// 画面遷移はすべて location.hash の変更で行う（hashchange → routeFromHash → openXxx）。
// 世代番号 ntlSeq: 開く/再読み込みのたびに増やし、古い応答は捨てる。

let ntlCaseId = null;    // 表示中（または読み込み中）の案件ID
let ntlSeq = 0;
let ntlSummary = null;   // case_summaries の1行
let ntlRows = [];        // notices の行（工事日の新しい順。未定・空が先頭）
let ntlBusy = false;     // 作成・複製・削除の実行中（二重実行を防ぐ）

function ntlBackToCase() {
  const fb = (typeof fieldBack === 'function' ? fieldBack(ntlCaseId) : null); // 現場用から開いたときは「‹ ツール」（js/field-ui.js。Task 18）
  return dBtn(fb ? fb.label : '← ' + (ntlSummary ? ntlSummary.name : '案件へ'), 'back', () => {
    location.hash = fb ? fb.hash : '#case/' + ntlCaseId;
  });
}

function ntlMessage(text, isErr, retryId) {
  const nodes = [ntlBackToCase()];
  nodes.push(mk('div', isErr ? 'err' : 'empty', text));
  if (retryId) nodes.push(dBtn('再読み込み', 'btn sm ghost inline', () => ntlLoad(retryId)));
  $('notices-root').replaceChildren(...nodes);
}

// 一覧の行クリック等 → location.hash 変更 → hashchange → routeFromHash → openNotices が2回走るので、
// 同じ案件を表示中/読み込み中なら何もしない。再読み込みは ntlLoad / ntlRefresh を直接呼ぶ
function openNotices(caseId) {
  if (!caseId) return;
  if (ntlCaseId === caseId && $('screen-notices').classList.contains('active')) return;
  showScreen('notices');
  renderHeaders();
  const h = '#case/' + caseId + '/notices';
  if (location.hash !== h) location.hash = h;
  return ntlLoad(caseId);
}

async function ntlLoad(caseId) {
  const seq = ++ntlSeq;
  ntlCaseId = caseId;
  ntlSummary = null;
  ntlRows = [];
  ntlBusy = false;
  ntlMessage('読み込み中…', false);
  // 編集画面の保存が残っていれば終わるのを待つ（ブラウザの戻るで来たとき、古い行を読んで複製してしまわないため）
  if (typeof nteSettle === 'function') { await nteSettle(); if (seq !== ntlSeq) return; }
  let res;
  try {
    res = await Promise.all([CasesApi.getSummary(caseId), NoticesApi.listByCase(caseId)]);
  } catch (e) {
    if (seq !== ntlSeq) return;
    ntlMessage('掲示の読み込みに失敗しました: ' + errText(e), true, caseId);
    return;
  }
  if (seq !== ntlSeq) return; // より新しい読み込みが始まっている
  if (!res[0]) { ntlMessage('案件が見つかりません', false); return; }
  ntlSummary = res[0];
  ntlRows = res[1] || [];
  ntlBuild();
}

// 操作の後の再読み込み。'' = 成功 or 古い応答として破棄 / 文字列 = 失敗メッセージ
async function ntlRefresh() {
  const seq = ++ntlSeq;
  let rows;
  try {
    rows = await NoticesApi.listByCase(ntlCaseId);
  } catch (e) {
    return seq === ntlSeq ? errText(e) : '';
  }
  if (seq !== ntlSeq) return '';
  ntlRows = rows || [];
  ntlRenderCount();
  ntlRenderList();
  return '';
}

function ntlBuild() {
  const head = mk('div', 'rep-between');
  head.appendChild(mk('h3', null, '📢 工事掲示'));
  const cnt = mk('span', 'rep-sub');
  cnt.id = 'ntl-count';
  head.appendChild(cnt);

  const acts = mk('div', 'rep-acts rep-top-acts');
  // 号室の初期値（この案件の部屋／関係する部屋から選ぶ。候補が無ければ出さない。Task 12）
  const pick = ntlRoomPicker(ntlSummary, 'ntl-room');
  if (pick) acts.appendChild(pick.el);
  const create = dBtn('＋ 掲示を作成', 'btn inline', () => ntlCreate(pick ? pick.value() : ''));
  create.id = 'ntl-create';
  acts.appendChild(create);

  const note = mk('div', 'rep-sub', '1つの掲示 = 1つの号室です。別の号室は「複製」で作ります');
  const err = mk('div', 'err');
  err.id = 'ntl-err';
  const list = mk('div');
  list.id = 'ntl-list';

  const card = mk('div', 'rep-card');
  card.append(head, acts, note, err, list);
  $('notices-root').replaceChildren(ntlBackToCase(), card);
  ntlRenderCount();
  ntlRenderList();
}

function ntlRenderCount() {
  const el = $('ntl-count');
  if (el) el.textContent = 'この案件の掲示 ' + ntlRows.length + '件';
}

function ntlStamp(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 一覧の工事日表示（NoticeLogic.formatWorkDate は編集画面のキー名を使うので変換する）
function ntlWorkDateText(n) {
  return NoticeLogic.formatWorkDate({ workDate: n.work_date, workDateEnd: n.work_date_end, workDateTbd: !!n.work_date_tbd });
}

function ntlRenderList() {
  const box = $('ntl-list');
  if (!box) return;
  if (ntlRows.length === 0) {
    box.replaceChildren(mk('div', 'empty', 'この案件の掲示はまだありません'));
    return;
  }
  box.replaceChildren(...ntlRows.map(ntlRowEl));
  ntlSetBusy(ntlBusy);
}

function ntlRowEl(n) {
  const row = mk('div', 'rep-row');
  row.dataset.id = n.id;
  const room = NoticeLogic.normalizeRoom(n.room) || '号室未入力';
  const top = mk('div', 'rep-between');
  top.appendChild(mk('b', null, room + '　' + (n.work_name || '工事名称未入力')));
  row.appendChild(top);
  const sub = '工事日: ' + ntlWorkDateText(n) + (n.updated_at ? ' ・ 更新 ' + ntlStamp(n.updated_at) : '');
  row.appendChild(mk('div', 'rep-sub', sub));

  const acts = mk('div', 'rep-acts');
  acts.style.marginTop = '6px';
  acts.appendChild(dBtn('開く', 'btn sm inline', () => { location.hash = '#notice/' + n.id; }));
  acts.appendChild(dBtn('複製', 'btn sm ghost inline', () => ntlDuplicate(n)));
  if (!(typeof fieldHidesAdmin === 'function' && fieldHidesAdmin())) acts.appendChild(dBtn('削除', 'btn sm ghost inline danger', () => ntlRemove(n))); // 削除は管理画面だけ（Task 18）
  row.appendChild(acts);
  return row;
}

// 実行中は一覧と作成のボタンを全部無効にする（別の操作が割り込まないように）
function ntlSetBusy(on) {
  ntlBusy = on;
  const create = $('ntl-create');
  if (create) create.disabled = on;
  const box = $('ntl-list');
  if (box) box.querySelectorAll('button').forEach(b => { b.disabled = on; });
}

// 作成・複製・削除の共通ラッパー。fn が新しい行を返したら編集画面へ。それ以外は一覧を最新にする
async function ntlRun(label, fn) {
  if (ntlBusy) return;
  const id = ntlCaseId;
  setMsg('ntl-err', '');
  ntlSetBusy(true);
  let errMsg = '', made = null;
  try {
    made = await fn();
  } catch (e) {
    errMsg = label + 'に失敗しました: ' + errText(e);
  }
  if (id !== ntlCaseId) { ntlBusy = false; return; } // 操作中に別の案件へ移った
  if (made && made.id && !errMsg) { ntlBusy = false; location.hash = '#notice/' + made.id; return; }
  const m = await ntlRefresh(); // 最新になるまでボタンは無効のまま
  if (id !== ntlCaseId) return;
  ntlSetBusy(false);
  const parts = [errMsg, m ? '最新の表示に更新できませんでした: ' + m : ''].filter(Boolean);
  if (parts.length) setMsg('ntl-err', parts.join('\n'));
}

function ntlCreate(roomNo) {
  return ntlRun('作成', () => NoticesApi.create(ntlCaseId, ntlSummary, roomNo ? { data: { roomNo } } : {}));
}

// 工事掲示の号室の初期値を選ぶ欄（Task 12）。候補 = この案件の部屋（cases.room）＋関係する部屋（PhaseLogic.roomChoices）。
//   候補が無ければ null。既定はこの案件の部屋（無ければ「空欄（あとで入れる）」）
//   → { el, value() }（value は号室の文字列。'' = 空欄）。フェーズ詳細ページの「📢 工事掲示を作る」（js/phase-ui.js）でも使う
function ntlRoomPicker(caseRow, id) {
  if (typeof PhaseLogic === 'undefined') return null;
  const choices = PhaseLogic.roomChoices(caseRow);
  if (!choices.length) return null;
  const wrap = mk('label', 'ntl-room');
  wrap.appendChild(mk('span', 'ntl-room-l', '号室の初期値'));
  const sel = document.createElement('select');
  sel.id = id;
  choices.forEach(c => { const o = new Option(c.label, c.value); o.dataset.key = c.key; sel.appendChild(o); });
  sel.appendChild(new Option('空欄（あとで入れる）', ''));
  sel.value = choices[0].key === 'case' ? choices[0].value : '';
  wrap.appendChild(sel);
  return { el: wrap, value: () => sel.value };
}

function ntlDuplicate(n) {
  return ntlRun('複製', () => NoticesApi.duplicate(n));
}

function ntlRemove(n) {
  if (ntlBusy) return;
  const room = NoticeLogic.normalizeRoom(n.room) || '号室未入力';
  if (!confirm('この掲示を削除しますか？\n' + room + '　' + (n.work_name || '工事名称未入力') + '\n（元に戻せません）')) return;
  return ntlRun('削除', async () => {
    await NoticesApi.remove(n.id);
    // 削除に成功してから端末の退避を消す（失敗したときは掲示が残るので、下書きも残す）
    try { localStorage.removeItem('notice-draft-' + n.id); } catch (e) { /* 何もしない */ }
    return null;
  });
}
