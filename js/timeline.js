// js/timeline.js — 案件詳細のタイムライン（投稿・写真/PDF添付・依頼の反映済み管理・削除・操作の自動記録）
// ユーザー入力・ファイル名は createElement + textContent で描画する（innerHTML は使わない）
// mk() は case-list.js、memberName / errText は case-detail.js、ctx は app.js のものを使う
// 投稿できるのは メモ・依頼された・決定事項。操作の記録（system）は各 API が操作の成功後に1行書く。
// お客様へのお知らせ（type 'customer'）はお客様ページの廃止で投稿をやめた（過去の記録は「お客様へ」として表示だけ）
//
// case-detail.js から呼ばれる:
//   renderTimeline(rootEl) … 案件を読み込むたびに1回（currentCase は設定済み）
//   refreshTimeline()      … 自動記録(system)が増えた後
//
// 古い応答の捨て方:
//   tlInst … いま画面にあるタイムライン1つ分の状態。renderTimeline のたびに作り直す
//   inst.listSeq … 一覧取得ごとの番号。後から始まった取得があれば前の応答は捨てる
//   投稿の完了時は「その案件のタイムラインがいま表示中か」を確かめてから画面を触る
let tlInst = null;
const tlNewDraft = caseId => ({ caseId, type: 'memo', body: '', files: [], posting: false });
let tlDraft = tlNewDraft(null);

const TL_TYPES = [['memo', 'メモ'], ['request', '依頼された'], ['decision', '決定事項']];
const TL_TAG_CLASS = { memo: 'memo', request: 'req', decision: 'dec', system: 'sys', customer: 'cust' };
const tlTagLabel = t => (t === 'customer' ? 'お客様へ' : CaseLogic.entryLabel(t));
const TL_PH_MEMO = '記録を残す（LINEのスクショ貼り付けOK）';
const TL_URL_TTL = 50 * 60 * 1000; // 署名URLは1時間有効。余裕を見て50分で取り直す

const tlLive = inst => inst === tlInst && inst.root.isConnected;

function tlFileOk(f) {
  return f && (f.type === 'application/pdf' || (f.type || '').startsWith('image/'));
}

// ---- 署名URL（描画時に取得。同じ添付は inst 内でキャッシュ） ----
function tlSignedUrl(inst, path) {
  const hit = inst.urls.get(path);
  if (hit && Date.now() - hit.at < TL_URL_TTL) return hit.p;
  const rec = { p: (async () => CasesApi.attachmentUrl(path))(), at: Date.now() };
  inst.urls.set(path, rec);
  rec.p.catch(() => { if (inst.urls.get(path) === rec) inst.urls.delete(path); });
  return rec.p;
}

// ---- 入口 ----
function renderTimeline(root) {
  const c = currentCase;
  if (!c) return;
  if (tlDraft.caseId !== c.id) tlDraft = tlNewDraft(c.id);

  const inst = { root, caseId: c.id, listSeq: 0, entries: null, busy: new Set(), urls: new Map() };
  tlInst = inst;

  const ttl = mk('div', 'taio-head');
  ttl.appendChild(mk('b', null, 'タイムライン'));

  // -- 入力欄 --
  const box = mk('div', 'tl-input');
  const typeRow = mk('div', 'tl-type');
  const chipEls = TL_TYPES.map(([key, label]) => {
    const b = mk('button', 'chip', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (tlDraft.posting) return;
      tlDraft.type = key;
      err.textContent = '';
      syncChips();
    });
    typeRow.appendChild(b);
    return [key, b];
  });

  const ta = document.createElement('textarea');
  ta.placeholder = TL_PH_MEMO;
  ta.rows = 3;
  ta.addEventListener('input', () => { tlDraft.body = ta.value; });
  ta.addEventListener('paste', ev => {
    const fs = Array.from((ev.clipboardData && ev.clipboardData.files) || []).filter(tlFileOk);
    if (fs.length === 0) return;
    ev.preventDefault();
    addFiles(fs);
  });

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = 'image/*,application/pdf';
  fileInput.hidden = true;
  fileInput.addEventListener('change', () => {
    const picked = Array.from(fileInput.files || []);
    fileInput.value = '';
    addFiles(picked);
  });

  const fileList = mk('div', 'tl-files');
  const err = mk('div', 'err');
  const status = mk('span', 'tl-status');
  const attach = Icon.prepend(mk('button', 'attach', '写真・ファイル添付'), 'clip', 14);
  attach.type = 'button';
  attach.addEventListener('click', () => { if (!tlDraft.posting) fileInput.click(); });
  const submit = mk('button', 'btn sm', '記録する');
  submit.type = 'button';
  submit.addEventListener('click', () => post());

  const right = mk('span', 'tl-right');
  right.append(status, submit);
  const actions = mk('div', 'tl-actions');
  actions.append(attach, right);
  box.append(typeRow, ta, fileList, actions, err, fileInput);

  // -- 一覧 --
  const listErr = mk('div', 'err');
  const listBox = mk('div', 'tl-list');
  inst.listErr = listErr;
  inst.listBox = listBox;

  root.replaceChildren(ttl, box, listErr, listBox);

  function syncChips() {
    chipEls.forEach(([key, b]) => b.classList.toggle('on', tlDraft.type === key));
  }

  function renderFiles() {
    const busy = tlDraft.posting;
    fileList.replaceChildren(...tlDraft.files.map((f, i) => {
      const chip = mk('span', 'tl-file');
      chip.appendChild(Icon.prepend(mk('span', 'tl-file-name', f.name || 'ファイル'), f.type === 'application/pdf' ? 'report' : 'image', 14));
      const x = mk('button', 'tl-file-x', '×');
      x.type = 'button';
      x.title = '外す';
      x.disabled = busy;
      x.addEventListener('click', () => {
        if (tlDraft.posting) return;
        tlDraft.files.splice(i, 1);
        renderFiles();
      });
      chip.appendChild(x);
      return chip;
    }));
  }

  function setBusy() {
    const busy = tlDraft.posting;
    ta.disabled = busy;
    submit.disabled = busy;
    attach.disabled = busy;
    chipEls.forEach(([, b]) => { b.disabled = busy; });
    status.textContent = busy ? (tlDraft.files.length > 0 ? 'アップロード中…' : '記録中…') : '';
    renderFiles();
  }

  function syncForm() {
    ta.value = tlDraft.body;
    syncChips();
    setBusy();
  }

  function addFiles(fs) {
    if (tlDraft.posting) return;
    err.textContent = '';
    const ok = fs.filter(tlFileOk);
    if (ok.length < fs.length) err.textContent = '写真かPDF以外は添付できません';
    tlDraft.files.push(...ok);
    renderFiles();
  }

  async function post() {
    const d = tlDraft;
    if (d.posting) return;
    const caseId = d.caseId;
    const type = d.type;
    const body = ta.value.trim();
    const files = d.files.slice();
    err.textContent = '';
    if (!body && files.length === 0) {
      err.textContent = '内容を入力するか、ファイルを添付してください';
      ta.focus();
      return;
    }
    d.posting = true;
    setBusy();
    let failure = null;
    try {
      await CasesApi.addEntry(caseId, type, body, files);
    } catch (e) {
      failure = e;
    }
    d.posting = false;
    // 案件が切り替わっていたら、投稿結果で別の案件の表示を触らない
    const cur = tlInst;
    const live = !!cur && cur.caseId === caseId && cur.root.isConnected;
    if (!failure && tlDraft === d) {
      d.body = '';
      d.files = [];
      d.type = 'memo';
    }
    if (!live) return;
    cur.syncForm();
    if (failure) {
      cur.formErr.textContent = '記録に失敗しました: ' + errText(failure);
    } else {
      cur.formErr.textContent = '';
      tlLoadList(cur);
    }
  }

  inst.syncForm = syncForm;
  inst.formErr = err;
  syncForm();

  inst.listBox.replaceChildren(mk('div', 'empty', '読み込み中…'));
  tlLoadList(inst);
}

// 自動記録が増えた後などに case-detail.js から呼ばれる
function refreshTimeline() {
  const inst = tlInst;
  if (!inst || !currentCase || inst.caseId !== currentCase.id || !inst.root.isConnected) return;
  tlLoadList(inst);
}

// ---- 一覧の取得と描画 ----
async function tlLoadList(inst) {
  const seq = ++inst.listSeq;
  let rows;
  try {
    rows = await CasesApi.listEntries(inst.caseId);
  } catch (e) {
    if (!tlLive(inst) || seq !== inst.listSeq) return;
    if (inst.entries) {
      inst.listErr.textContent = '最新の記録に更新できませんでした: ' + errText(e);
    } else {
      const retry = mk('button', 'btn sm ghost inline', '再読み込み');
      retry.type = 'button';
      retry.addEventListener('click', () => {
        inst.listBox.replaceChildren(mk('div', 'empty', '読み込み中…'));
        tlLoadList(inst);
      });
      inst.listErr.textContent = '';
      inst.listBox.replaceChildren(mk('div', 'err', '記録の読み込みに失敗しました: ' + errText(e)), retry);
    }
    return;
  }
  if (!tlLive(inst) || seq !== inst.listSeq) return;
  inst.entries = rows || [];
  inst.listErr.textContent = '';
  tlRenderList(inst);
}

function tlRenderList(inst) {
  if (!tlLive(inst) || !inst.entries) return;
  if (inst.entries.length === 0) {
    inst.listBox.replaceChildren(mk('div', 'empty', 'まだ記録がありません'));
    return;
  }
  inst.listBox.replaceChildren(...inst.entries.map(e => tlEntryEl(inst, e)));
}

function tlCanDelete(e) {
  if (e.type === 'system') return false;
  return e.created_by === ctx.user.id || ctx.membership.role === 'owner';
}

function tlEntryEl(inst, e) {
  const box = mk('div', 'entry');

  const who = mk('div', 'who');
  const left = mk('span');
  left.appendChild(mk('span', 'tag ' + (TL_TAG_CLASS[e.type] || 'memo'), tlTagLabel(e.type)));
  left.appendChild(document.createTextNode(
    e.type === 'system' ? 'システム' : (e.created_by ? memberName(e.created_by) : '不明')));
  who.append(left, mk('span', null, CaseLogic.formatDateTime(e.created_at)));
  box.appendChild(who);

  if (e.body) box.appendChild(mk('div', 'body', e.body));

  const atts = Array.isArray(e.attachments) ? e.attachments : [];
  if (atts.length > 0) {
    const row = mk('div', 'tl-atts');
    atts.forEach(a => row.appendChild(tlAttachEl(inst, a)));
    box.appendChild(row);
  }

  const busy = inst.busy.has(e.id);
  const foot = mk('div', 'entry-foot');
  if (e.type === 'request') {
    const done = !!e.resolved_at;
    const b = mk('button', 'req-status' + (done ? ' ok' : ''), done ? '反映済み ✓' : '未対応 → タップで「反映済み」に');
    b.type = 'button';
    b.disabled = busy;
    b.addEventListener('click', () => tlToggleResolved(inst, e));
    foot.appendChild(b);
  }
  if (tlCanDelete(e)) {
    const d = mk('button', 'linkbtn danger', '削除');
    d.type = 'button';
    d.disabled = busy;
    d.addEventListener('click', () => tlDelete(inst, e));
    foot.appendChild(d);
  }
  if (foot.childNodes.length > 0) box.appendChild(foot);
  return box;
}

// 添付1件。署名URLは描画時に取得し、取れたら差し替える。失敗したらファイル名表示
function tlAttachEl(inst, a) {
  const name = a.name || 'ファイル';
  const isImg = (a.type || '').startsWith('image/');
  const slot = mk('span', 'att');
  const plain = suffix => slot.replaceChildren(Icon.prepend(mk('span', 'att-name', name + (suffix || '')), isImg ? 'image' : 'report', 14));

  if (isImg) slot.appendChild(mk('span', 'thumb', '…'));
  else plain('');

  tlSignedUrl(inst, a.path).then(url => {
    if (!slot.isConnected) return; // 一覧が描き直された
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = name;
    if (isImg) {
      link.className = 'thumb-link';
      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = name;
      img.addEventListener('error', () => plain('（表示できません）'));
      img.src = url;
      link.appendChild(img);
    } else {
      link.className = 'att-link';
      link.textContent = name;
      Icon.prepend(link, 'report', 14);
    }
    slot.replaceChildren(link);
  }).catch(() => {
    if (slot.isConnected) plain('（開けません）');
  });
  return slot;
}

// ---- 操作（反映済みトグル・削除） ----
async function tlToggleResolved(inst, e) {
  if (inst.busy.has(e.id)) return;
  inst.busy.add(e.id);
  inst.listErr.textContent = '';
  tlRenderList(inst);
  let row = null;
  let failure = null;
  try {
    row = await CasesApi.setResolved(e.id, !e.resolved_at);
  } catch (ex) {
    failure = ex;
  }
  inst.busy.delete(e.id);
  if (!tlLive(inst)) return;
  if (failure) {
    inst.listErr.textContent = '反映済みの変更に失敗しました: ' + errText(failure);
  } else if (row && inst.entries) {
    const i = inst.entries.findIndex(x => x.id === e.id);
    if (i >= 0) inst.entries[i] = row;
  }
  tlRenderList(inst);
}

async function tlDelete(inst, e) {
  if (inst.busy.has(e.id)) return;
  if (!confirm('この記録を削除しますか？添付ファイルも削除されます。')) return;
  inst.busy.add(e.id);
  inst.listErr.textContent = '';
  tlRenderList(inst);
  let failure = null;
  try {
    await CasesApi.deleteEntry(e);
  } catch (ex) {
    failure = ex;
  }
  inst.busy.delete(e.id);
  if (!tlLive(inst)) return;
  if (failure) {
    inst.listErr.textContent = '削除に失敗しました: ' + errText(failure);
  } else if (inst.entries) {
    inst.entries = inst.entries.filter(x => x.id !== e.id);
  }
  tlRenderList(inst);
}
