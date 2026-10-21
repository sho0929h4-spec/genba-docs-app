// js/phase-detail.js — フェーズ詳細ページ #case/{caseId}/phase/{phaseId}（対応フェーズ Task 9）
// 案件ページのカードに縦に並んでいた中身を全部このページに出す（描画は js/phase-ui.js の renderPhaseDetail）。
// このファイルは ページの入口（openCasePhase: app.js の routeFromHash から）・見出し・「← 案件に戻る」と、
// その1区画「作業担当者への指示」（case_phases.plan。migration 028 → Task 25 で号室ごと）: まず号室を選び（この案件の部屋＋関係する部屋・
//   ＋ 部屋を追加）、号室ごとに 怪しい箇所・具体的な指示内容（押すと☑）・自由記載（補足）、案件全体の当日の注意。
//   入力から1.5秒で自動保存（PhasesApi.saveBrief）。保存中に入力しても失わない（次の保存に回す）。描き直しても同じ要素を使う。
//   指示は担当者への確認依頼・前日のお知らせ（staff_notice）の本文と 🔔 の一覧・作業担当者の段に出る。お客様向けのメールには一切出さない
// ユーザー入力は createElement + textContent / value で描画する（innerHTML は使わない）。alert/confirm は使わない
// mk() は case-list.js、dBtn / errText / currentCase / caseMembers / caseGen / caseDetailId は case-detail.js、showScreen / $ は app.js

let pdSeq = 0; // ページを開くたびに増やす（古い読み込みを捨てる）
let pdWhenFor = null; // 次に開くときに日時の入力欄を開くフェーズ（やること #tasks の「工事日を決める」「調査日を決める」。Task 17）

// フェーズ詳細ページを開いて、日時（調査日時・工事日）の入力欄を開く
function pdOpenWhen(caseId, phaseId) {
  const h = '#case/' + caseId + '/phase/' + phaseId;
  pdWhenFor = String(phaseId).toLowerCase();
  if (location.hash.toLowerCase() === h.toLowerCase()) openCasePhase(caseId, phaseId);
  else location.hash = h;
}

function pdBackBtn(caseId) {
  const b = dBtn('← 案件に戻る', 'back pd-back', () => { location.hash = '#case/' + caseId; });
  b.id = 'pd-back';
  return b;
}

// #case/{caseId}/phase/{phaseId}（担当者への確認依頼のリンク・案件ページの「詳しく見る」・🔔 の一覧・チーム状況から）
async function openCasePhase(caseId, phaseId) {
  caseId = String(caseId).toLowerCase();
  phaseId = String(phaseId).toLowerCase();
  const seq = ++pdSeq;
  const openWhen = pdWhenFor === phaseId;
  pdWhenFor = null;
  showScreen('phase');
  renderHeaders();
  const root = $('phase-detail-root');
  const msg = (text, isErr, retry) => {
    const nodes = [pdBackBtn(caseId), mk('div', isErr ? 'err' : 'empty', text)];
    if (retry) nodes.push(dBtn('再読み込み', 'btn sm ghost inline', () => openCasePhase(caseId, phaseId)));
    root.replaceChildren(...nodes);
  };
  // 案件（currentCase・社内メンバー）は案件ページと共通の変数。開くたびに読み直す（依頼元・担当者の変更を反映するため）
  const gen = ++caseGen; // 案件ページの欄（対応フェーズ・タイムライン）の古い操作結果も捨てる
  caseDetailId = caseId;
  currentCase = null;
  caseMembers = [];
  msg('読み込み中…', false);
  let res;
  try { res = await Promise.all([CasesApi.getSummary(caseId), CasesApi.listMembers()]); }
  catch (e) {
    if (gen === caseGen && seq === pdSeq) msg('案件の読み込みに失敗しました: ' + errText(e), true, true);
    return;
  }
  if (gen !== caseGen || seq !== pdSeq) return;
  if (!res[0]) { msg('案件が見つかりません', false); return; }
  currentCase = res[0];
  caseMembers = res[1] || [];
  const c = currentCase;
  const head = mk('div', 'pd-head');
  const place = [c.name, PhaseLogic.roomLabel(c.room)].filter(Boolean).join(' ');
  head.appendChild(mk('div', 'pd-case', place));
  const t = mk('h2', 'pd-title', 'フェーズ');
  t.id = 'pd-title';
  head.appendChild(t);
  const body = mk('div', 'pd-body');
  body.id = 'phase-detail-body';
  root.replaceChildren(pdBackBtn(caseId), head, body);
  window.scrollTo(0, 0);
  return renderPhaseDetail(body, { id: phaseId }, { openWhen });
}

// 見出し（phase-ui の描画のたびに呼ばれる）
function pdSyncHead(p, title) {
  const t = $('pd-title');
  if (t && t.textContent !== title) t.textContent = title;
  document.title = title + ' - 現場ドキュメント';
}
window.addEventListener('hashchange', () => { if (!/\/phase\//.test(location.hash)) document.title = '現場ドキュメント'; });

/* ---------- 現場担当への指示（case_phases.plan） ---------- */
const PD_BRIEF_DELAY = 1500;
const PD_BRIEF_MAX = 500; // 補足・当日の注意の文字数（DB は全体で 10000 バイトまで。号室ごとに書くので短めに）
const pdBrief = new Map();  // phaseId → セッション（描き直しても入力中の値・要素を引き継ぐ）
const pdBriefJson = v => JSON.stringify(PhaseLogic.normalizeBrief(v));

function pdBriefSession(p) {
  let bs = pdBrief.get(p.id);
  const server = pdBriefJson(p.plan);
  if (bs && bs.caseId !== p.case_id) bs = null;
  if (!bs) {
    bs = { id: p.id, caseId: p.case_id, kind: p.kind, v: PhaseLogic.normalizeBrief(p.plan), serverJson: server,
      dirty: false, saving: false, timer: null, chain: Promise.resolve(), state: '', err: '', lastSaved: null, mailNote: '', el: null, els: {} };
    pdBrief.set(p.id, bs);
  } else if (!bs.dirty && !bs.saving && !bs.timer && bs.serverJson !== server) {
    // 別の画面・別の人が変えた（こちらに未保存の入力は無い）→ サーバーの値で作り直す
    Object.assign(bs, { v: PhaseLogic.normalizeBrief(p.plan), serverJson: server, el: null, els: {} });
  }
  return bs;
}
// 今の指示（入力中ならその値）
function pdBriefValue(p) {
  const bs = pdBrief.get(p.id);
  return bs && bs.caseId === p.case_id ? bs.v : p.plan;
}
const pdBriefHas = p => PhaseLogic.hasBrief(pdBriefValue(p));

// phase-ui の詳細ページの段「作業担当者への指示」の中身
function phBriefBody(p) {
  const bs = pdBriefSession(p);
  if (!bs.el) pdBriefBuild(bs);
  else if (bs.els.picker) bs.els.picker.repaint(); // 号室の候補（関係する部屋）が変わっていれば出し直す
  pdBriefSetState(bs, bs.state);
  return bs.el;
}

/* ---------- 号室の選び方（指示・調査結果で共通。Task 25） ---------- */
// この案件の部屋＋関係する部屋を「☑ 402号室（加害部屋）」の行で出す（押すと区画を足す／外す）。区画にあって候補に無い号室（旧い指示の
// 「号室未設定」・消した部屋）も出す。「＋ 部屋を追加」は関係する部屋のシート（js/case-rooms.js）を開き、足した部屋の区画も作る
//   o: { rooms: () => 今の区画の配列, onToggle(choice, on, btn), onAdded(choice), label }
function pdRoomPicker(o) {
  const wrap = mk('div', 'pd-rooms');
  const paint = () => {
    const have = o.rooms();
    const choices = PhaseLogic.planRoomChoices(currentCase);
    have.forEach(b => {
      if (!choices.some(c => c.room === b.room)) choices.push({ room: b.room, role: b.role, label: PhaseLogic.briefRoomHead(b) });
    });
    const grid = mk('div', 'rep-checks grid pd-room-checks');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', o.label || '号室');
    choices.forEach(c => {
      const on = have.some(b => b.room === c.room);
      const btn = edCheck(c.label, on, false, now => o.onToggle(c, now, btn));
      btn.classList.add('pd-room');
      btn.dataset.room = c.room;
      grid.appendChild(btn);
    });
    const nodes = [grid];
    if (!choices.length) nodes.unshift(mk('div', 'ph-sub', 'この案件の号室がありません。「＋ 部屋を追加」で号室を登録してください'));
    if (typeof CaseRooms !== 'undefined' && currentCase) {
      const add = dBtn('＋ 部屋を追加', 'linkbtn pd-room-add', () => {
        const before = new Set(PhaseLogic.planRoomChoices(currentCase).map(c => c.room));
        const cid = currentCase.id;
        CaseRooms.openSheet(currentCase, null, async () => {
          try {
            const row = await CasesApi.getSummary(cid);
            if (row && currentCase && currentCase.id === cid) currentCase = Object.assign(currentCase, { rooms: row.rooms });
          } catch (e) { console.warn('関係する部屋の読み込みに失敗', e); }
          const added = PhaseLogic.planRoomChoices(currentCase).find(c => !before.has(c.room));
          if (added && o.onAdded) o.onAdded(added);
          paint();
          if (typeof notifyTimeline === 'function') notifyTimeline();
        });
      });
      nodes.push(add);
    }
    wrap.replaceChildren(...nodes);
  };
  wrap.repaint = paint;
  paint();
  return wrap;
}

// 押すと☑の行のまとまり（区画の中の 怪しい箇所／具体的な指示内容）。その他を選ぶと自由記載の欄
function pdBriefChecks(bs, block, title, key, list, otherKey, otherPh) {
  const frag = document.createDocumentFragment();
  frag.appendChild(mk('div', 'ph-cau-t', title));
  const grid = mk('div', 'rep-checks grid pd-brief-g');
  grid.dataset.group = key;
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', title);
  const other = document.createElement('input');
  other.type = 'text';
  other.className = 'pd-brief-' + otherKey;
  other.maxLength = 200;
  other.autocomplete = 'off';
  other.placeholder = otherPh;
  other.value = block[otherKey];
  other.setAttribute('aria-label', title + '（その他）');
  other.addEventListener('input', () => { block[otherKey] = other.value; pdBriefChanged(bs); });
  const otherWrap = mk('label', 'ph-rl pd-brief-other', 'その他（自由記載）');
  otherWrap.appendChild(other);
  const sync = () => { otherWrap.hidden = !block[key].includes('other'); };
  list.forEach(c => {
    const btn = edCheck(c.label, block[key].includes(c.key), false, on => {
      const set = new Set(block[key]);
      if (on) set.add(c.key); else set.delete(c.key);
      block[key] = list.map(x => x.key).filter(k => set.has(k));
      sync();
      pdBriefChanged(bs);
    });
    btn.dataset.key = c.key;
    grid.appendChild(btn);
  });
  sync();
  frag.append(grid, otherWrap);
  return frag;
}
// 号室の区画1つ（怪しい箇所・具体的な指示内容・補足）
function pdBriefRoomEl(bs, block) {
  const box = mk('div', 'pd-room-block');
  box.dataset.room = block.room;
  const hd = mk('div', 'pd-room-hd');
  hd.appendChild(mk('b', null, PhaseLogic.briefRoomHead(block)));
  box.appendChild(hd);
  box.appendChild(pdBriefChecks(bs, block, '怪しい箇所（押して選ぶ・複数可）', 'suspects', PhaseLogic.BRIEF_SUSPECTS, 'suspectOther', '例: 天井裏の配管'));
  box.appendChild(pdBriefChecks(bs, block, '具体的な指示内容（押して選ぶ・複数可）', 'tasks', PhaseLogic.BRIEF_TASKS, 'taskOther', '例: 家具の移動をお願いする'));
  const ta = document.createElement('textarea');
  ta.className = 'pd-brief-note';
  ta.rows = 2;
  ta.maxLength = PD_BRIEF_MAX;
  ta.placeholder = bs.kind === 'survey' ? '例: 浴室の下から先に。天井点検口あり' : '例: 天井ボードの張替え範囲を写真で残す';
  ta.value = block.note;
  ta.addEventListener('input', () => { block.note = ta.value; pdBriefChanged(bs); });
  const l = mk('label', 'ph-rl', '自由記載（補足）');
  l.appendChild(ta);
  box.appendChild(l);
  return box;
}
function pdBriefRoomsFill(bs) {
  const host = bs.els.blocks;
  if (!host) return;
  host.replaceChildren(...bs.v.rooms.map(b => pdBriefRoomEl(bs, b)));
  if (!bs.v.rooms.length) host.appendChild(mk('div', 'ph-sub pd-room-none', '上で号室を選ぶと、その号室の指示を書く欄が出ます'));
}
const pdBriefBlockHas = b => !!(b.suspects.length || b.tasks.length || String(b.note || '').trim() || String(b.suspectOther || '').trim() || String(b.taskOther || '').trim());

function pdBriefBuild(bs) {
  const box = mk('div', 'ph-brief');
  box.dataset.phaseId = bs.id;
  bs.els = {};
  box.appendChild(mk('div', 'ph-sub', '現場に行く作業担当者への指示です（社内だけ。お客様へのメールには出ません）。' +
    '下の「担当者に知らせる」の確認依頼メールと、担当者の「🔔 確認してください」・現場用のツールページ・担当者URLのページに入ります'));
  box.appendChild(mk('div', 'ph-cau-t', 'まず号室を選ぶ（押すと☑）'));
  const blocks = mk('div', 'pd-room-blocks');
  const addBlock = c => {
    if (bs.v.rooms.some(b => b.room === c.room)) return;
    bs.v.rooms.push({ room: c.room, role: c.role || '', suspects: [], suspectOther: '', tasks: [], taskOther: '', note: '' });
    pdBriefRoomsFill(bs);
    pdBriefChanged(bs);
  };
  const picker = pdRoomPicker({
    label: '指示を書く号室',
    rooms: () => bs.v.rooms,
    onAdded: addBlock,
    onToggle: async (c, on, btn) => {
      if (on) { addBlock(c); return; }
      const b = bs.v.rooms.find(x => x.room === c.room);
      if (b && pdBriefBlockHas(b)) {
        // 書いた指示が消えるので画面内で確かめる（confirm は使わない）
        const ok = await askInline(bs.els.blocks, PhaseLogic.briefRoomHead(b) + 'の指示を消しますか？', { okLabel: '消す', id: 'pd-room-ask', prepend: true });
        if (!ok) { edSetOn(btn, true); return; }
      }
      bs.v.rooms = bs.v.rooms.filter(x => x.room !== c.room);
      pdBriefRoomsFill(bs);
      bs.els.picker.repaint();
      pdBriefChanged(bs);
    }
  });
  box.appendChild(picker);
  box.appendChild(blocks);
  bs.els.picker = picker;
  bs.els.blocks = blocks;
  pdBriefRoomsFill(bs);
  const ta = document.createElement('textarea');
  ta.className = 'pd-brief-visitNote';
  ta.rows = 2;
  ta.maxLength = PD_BRIEF_MAX;
  ta.placeholder = '例: 鍵は管理人室・駐車は来客用 2番・入居者様 090-…';
  ta.value = bs.v.visitNote;
  ta.addEventListener('input', () => { bs.v.visitNote = ta.value; pdBriefChanged(bs); });
  const vl = mk('label', 'ph-rl', '当日の注意（鍵・駐車・連絡先など。案件全体）');
  vl.appendChild(ta);
  box.appendChild(vl);
  const sv = mk('div', 'ph-res-save');
  const save = mk('span', 'rep-save pd-brief-save');
  save.setAttribute('role', 'status');
  const retry = dBtn('再試行', 'btn sm ghost inline pd-brief-retry', () => pdBriefFlush(bs));
  retry.hidden = true;
  sv.append(save, retry);
  box.appendChild(sv);
  Object.assign(bs.els, { save, retry });
  bs.el = box;
}

function pdBriefSetState(bs, state) {
  bs.state = state;
  const el = bs.els.save;
  if (!el) return;
  bs.els.retry.hidden = state !== 'error';
  el.className = 'rep-save pd-brief-save' + (state === 'saved' ? '' : state === 'error' ? ' err' : ' busy');
  el.dataset.state = state;
  if (state === 'pending') el.textContent = '保存待ち…';
  else if (state === 'saving') el.textContent = '保存中…';
  else if (state === 'saved') el.textContent = '自動保存 ' + PhaseLogic.fmtMDHM(bs.lastSaved || new Date()).split(' ')[1] + (bs.mailNote || '');
  else if (state === 'error') el.textContent = '保存できませんでした: ' + (bs.err || '');
  else el.textContent = '';
}

function pdBriefChanged(bs) {
  bs.dirty = true;
  if (currentCase && currentCase.id === bs.caseId) bs.caseRow = currentCase; // 画面を離れた直後の保存でも依頼元・担当者の名前を使えるように
  pdBriefSetState(bs, 'pending');
  clearTimeout(bs.timer);
  bs.timer = setTimeout(() => pdBriefFlush(bs), PD_BRIEF_DELAY);
  pdBriefApply(bs); // 作業担当者の段の要約・段の丸はすぐ変える
}
// 保留中の保存を今すぐ実行し、終わるまで待つ（直列。失敗しても throw しない: bs.dirty が残る）
function pdBriefFlush(bs) {
  clearTimeout(bs.timer);
  bs.timer = null;
  bs.chain = bs.chain.then(() => pdBriefDoSave(bs)).catch(e => {
    bs.dirty = true;
    bs.err = errText(e);
    pdBriefSetState(bs, 'error');
  });
  return bs.chain;
}
// 表示中の案件の保存を全部終わらせる（担当者に知らせる・確認依頼を開く前。本文を最新にするため）
function pdBriefSettle() {
  const cid = currentCase ? currentCase.id : null;
  const list = [...pdBrief.values()].filter(bs => bs.caseId === cid);
  return Promise.all(list.map(bs => (bs.dirty || bs.timer ? pdBriefFlush(bs) : bs.chain)));
}
function pdBriefFlushAll() {
  pdBrief.forEach(bs => { if (bs.dirty || bs.timer) pdBriefFlush(bs); });
}

async function pdBriefDoSave(bs) {
  if (!bs.dirty) return;
  const val = JSON.parse(JSON.stringify(bs.v));
  bs.dirty = false;
  bs.saving = true;
  pdBriefSetState(bs, 'saving');
  const caseRow = currentCase && currentCase.id === bs.caseId ? currentCase : bs.caseRow || { id: bs.caseId };
  let saved = null, drafts = [], msg = '';
  try {
    const r = await PhasesApi.saveBrief({ id: bs.id, case_id: bs.caseId, kind: bs.kind }, val, caseRow,
      typeof caseMembers !== 'undefined' ? caseMembers : []);
    saved = r.phase;
    drafts = r.drafts || [];
  } catch (e) {
    saved = (e && e.phase) || null; // 指示は保存できて、下書きだけ直せなかったときは e.phase がある
    msg = errText(e);
  }
  bs.saving = false;
  if (saved) {
    bs.serverJson = pdBriefJson(saved.plan);
    bs.lastSaved = new Date();
    bs.mailNote = drafts.length ? '（担当者へのメールの下書きにも反映しました）' : '';
    const s = typeof ph !== 'undefined' ? ph : null;
    if (s && s.data && s.caseId === bs.caseId) {
      const p = s.data.phases.find(x => x.id === bs.id);
      if (p) { p.plan = saved.plan; if (saved.updated_at) p.updated_at = saved.updated_at; }
      drafts.forEach(d => { const i = s.data.drafts.findIndex(x => x.id === d.id); if (i >= 0) s.data.drafts[i] = d; });
    }
  }
  if (msg) { // 失敗: 次の保存（再試行・次の入力）でもう一度送る
    bs.dirty = true;
    bs.err = msg;
    pdBriefSetState(bs, 'error');
    return;
  }
  pdBriefSetState(bs, bs.dirty ? 'pending' : 'saved');
}

// 入力に合わせて、詳細ページの作業担当者の段の「指示あり: …」と、この段の丸だけ書き換える（カードは描き直さない）
function pdBriefApply(bs) {
  const s = typeof ph !== 'undefined' ? ph : null;
  if (!s || !s.root || !s.data) return;
  const p = s.data.phases.find(x => x.id === bs.id);
  if (!p) return;
  const sum = s.root.querySelector('.ph-wk-brief[data-phase-id="' + bs.id + '"]');
  if (sum && typeof phFillWorkerBrief === 'function') phFillWorkerBrief(sum, p);
  // Task 28: 作業担当者の段の「指示が空のまま知らせます」の注意
  s.root.querySelectorAll('.ph-wk-empty[data-phase-id="' + bs.id + '"]').forEach(e => { e.hidden = PhaseLogic.hasBrief(bs.v); });
  const st = bs.el && bs.el.closest('.ph-st[data-step=brief]'); // Task 28 で指示は作業担当者の段の中（段の丸は変えない）
  if (st) {
    const on = PhaseLogic.hasBrief(bs.v);
    st.className = 'ph-st ' + (on ? 'done' : 'later');
    const dot = st.querySelector('.ph-dot');
    if (dot) dot.textContent = on ? '✓' : st.dataset.n || '';
  }
}
