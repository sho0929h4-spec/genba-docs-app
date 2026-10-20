// js/report-edit.js — ⑥ 報告書の入力画面（#report/{id}）… openReport(id)  （Task 5b）
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）
// mk() は case-list.js、dBtn / errText は case-detail.js、showScreen / renderHeaders / setMsg / $ は app.js のものを使う
// 入力欄の描画（rfBuildForm / rfRenderPhotos / edApplyMode など）は js/report-form.js（⑧ r.html と共有）
//
// 画面遷移は location.hash の変更だけ。ルーターが openReport を呼ぶ。
// 自動保存: 入力から1.5秒で ReportsApi.save（photos は含めない）。写真のキャプション/区分を変えたときだけ photos も送る。
//   同時に localStorage `report-draft-{id}` へ退避（読み込み時のサーバー updated_at = base と、写真のキャプション/区分も）。
//   開いたとき、サーバーの updated_at が base と同じ（その後サーバーが変わっていない）ときだけ復元して保存し直す。違えばサーバー優先で破棄。
//   hashchange / beforeunload / 非表示化 / 提出 / PDFプレビュー前に、保留中の保存を flush する。
// 世代番号 edSeq: 古い読み込み応答は捨てる。保存は1報告書につき直列（s.chain）。

const ED_DELAY = 1500;
const ED_VENDOR = '__vendor__';
const edKey = id => 'report-draft-' + id;
let ed = null;      // 表示中の編集セッション
let edSeq = 0;      // openReport のたびに増やす

/* ---------- localStorage（使えない環境でも画面は動かす） ---------- */
function edLsGet(id) {
  try {
    const o = JSON.parse(localStorage.getItem(edKey(id)));
    return o && typeof o === 'object' && o.f && typeof o.f === 'object' ? o : null;
  } catch (e) { return null; }
}
function edLsSet(s) {
  try {
    const photos = (s.report.photos || []).map(p => ({ path: p.path, caption: p.caption || '', phase: p.phase || '', phaseNote: p.phaseNote || '', marks: PhotoMarks.normalize(p.marks) }));
    localStorage.setItem(edKey(s.id), JSON.stringify({ t: Date.now(), base: s.report.updated_at || null, f: edCollect(s), photos }));
  } catch (e) { /* 容量不足など。サーバ保存が本線 */ }
}
function edLsDel(id) { try { localStorage.removeItem(edKey(id)); } catch (e) { /* 何もしない */ } }

/* ---------- 入力値 ⇔ 保存する列 ---------- */

// 保存する列（photos は含めない）。data は参照を渡さず複製する
function edCollect(s) {
  const f = s.f;
  return {
    work_type: f.work_type,
    room: String(f.room || '').trim() || null,
    work_date: f.work_date || null,
    time_start: f.time_start || null,
    time_end: f.time_end || null,
    worker_id: f.worker_id || null,
    worker_name: f.worker_id ? null : (String(f.worker_name || '').trim() || null),
    data: JSON.parse(JSON.stringify(f.data))
  };
}
function edFromRow(r) {
  return {
    work_type: ReportLogic.MODES[r.work_type] ? r.work_type : 'investigate',
    room: r.room || '',
    work_date: r.work_date ? String(r.work_date).slice(0, 10) : '',
    time_start: r.time_start ? String(r.time_start).slice(0, 5) : '',
    time_end: r.time_end ? String(r.time_end).slice(0, 5) : '',
    worker_id: r.worker_id || null,
    worker_name: r.worker_name || '',
    data: ReportLogic.normalizeData(r.data)
  };
}
// localStorage の退避を入力値へ戻す（壊れた値は無視して、サーバの値を残す）
function edApplyDraft(f, d) {
  if (ReportLogic.MODES[d.work_type]) f.work_type = d.work_type;
  ['room', 'work_date', 'time_start', 'time_end'].forEach(k => { if (typeof d[k] === 'string') f[k] = d[k]; else if (d[k] === null) f[k] = ''; });
  if ('worker_id' in d) f.worker_id = typeof d.worker_id === 'string' ? d.worker_id : null;
  if ('worker_name' in d) f.worker_name = typeof d.worker_name === 'string' ? d.worker_name : '';
  if (d.data && typeof d.data === 'object' && !Array.isArray(d.data)) f.data = ReportLogic.normalizeData(d.data);
}

/* ---------- 保存 ---------- */
function edSetSave(s, state) {
  s.saveState = state;
  const el = s.els.save;
  if (!el) return;
  const retry = s.els.retry;
  retry.hidden = state !== 'error';
  el.className = 'rep-save' + (state === 'saved' ? '' : state === 'error' ? ' err' : ' busy');
  if (state === 'pending') el.textContent = '保存待ち…';
  else if (state === 'saving') el.textContent = '保存中…';
  else if (state === 'saved') el.textContent = '自動保存 ' + edHm(s.lastSaved || new Date());
  else if (state === 'error') el.textContent = '保存できませんでした: ' + (s.saveErr || '');
  else if (state === 'restored') { el.className = 'rep-save busy'; el.textContent = '前回の未保存の入力を復元しました'; }
  else el.textContent = '';
}

function edMarkDirty(s, photos) {
  if (s.ro || s.submitted) return;
  s.dirty = true;
  if (photos) s.photosDirty = true;
  edLsSet(s);
  edClearVal(s);
  edSetSave(s, 'pending');
  clearTimeout(s.timer);
  s.timer = setTimeout(() => edFlush(s), ED_DELAY);
}

// 保留中の保存を今すぐ実行し、終わるまで待つ（保存は直列。失敗しても throw しない: s.dirty が残る）
function edFlush(s) {
  clearTimeout(s.timer);
  s.timer = null;
  s.chain = s.chain.then(() => edDoSave(s)).catch(e => { // 想定外の例外でも以降の保存を止めない
    s.dirty = true;
    s.saveErr = errText(e);
    edSetSave(s, 'error');
  });
  return s.chain;
}
async function edDoSave(s) {
  if (s.ro || (!s.dirty && !s.photosDirty)) return;
  const fields = edCollect(s);
  const withPhotos = s.photosDirty;
  const patch = withPhotos ? Object.assign(fields, { photos: (s.report.photos || []).map(p => Object.assign({}, p)) }) : fields;
  s.dirty = false;
  s.photosDirty = false;
  edSetSave(s, 'saving');
  try {
    const row = await ReportsApi.save(s.id, patch);
    if (row && row.updated_at) s.report.updated_at = row.updated_at;
    s.lastSaved = new Date();
    if (s.dirty || s.photosDirty) { edLsSet(s); edSetSave(s, 'pending'); } // 保存中にさらに入力があった（次のタイマーで保存）。退避の base を新しいサーバー値に合わせる
    else { edLsDel(s.id); edSetSave(s, 'saved'); }
  } catch (e) {
    s.dirty = true;
    if (withPhotos) s.photosDirty = true;
    s.saveErr = errText(e);
    edSetSave(s, 'error');
  }
}
const edPending = s => !!s && (s.dirty || s.photosDirty);

window.addEventListener('hashchange', () => { edStopVoice(); if (ed && edPending(ed)) edFlush(ed); });
window.addEventListener('beforeunload', () => { if (ed && edPending(ed)) edFlush(ed); });
document.addEventListener('visibilitychange', () => { if (document.hidden && ed && edPending(ed)) edFlush(ed); });

/* ---------- 入力チェック表示 ---------- */
function edClearVal(s) { if (s.els.val && s.els.val.firstChild) s.els.val.replaceChildren(); }
function edShowVal(s, errors, warnings) {
  const box = s.els.val;
  const nodes = [];
  errors.forEach(t => nodes.push(mk('div', 'rep-val-e', '⛔ ' + t)));
  warnings.forEach(t => nodes.push(mk('div', 'rep-val-w', '⚠ ' + t)));
  box.replaceChildren(...nodes);
  if (nodes.length) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/* ---------- 画面の組み立て（入力欄は js/report-form.js の rfBuildForm を共有） ---------- */
function edBuild(s) {
  const L = ReportLogic, els = s.els;
  const ro = s.ro;
  const nodes = [];

  // 上部: 戻る・保存状態
  const top = mk('div', 'rep-between rep-ed-top');
  const fb = (typeof fieldBack === 'function' ? fieldBack(s.report.case_id) : null); // 現場用から開いたときは「‹ ツール」（js/field-ui.js。Task 18）
  els.back = dBtn(fb ? fb.label : '← 報告書一覧', 'back', async () => {
    if (s.photoBusy || s.submitting) return;
    await edFlush(s);
    location.hash = fb ? fb.hash : '#case/' + s.report.case_id + '/reports';
  });
  top.appendChild(els.back);
  const saveBox = mk('div', 'rep-acts');
  els.save = mk('span', 'rep-save');
  els.save.id = 'rp-save';
  els.save.setAttribute('role', 'status');
  els.retry = dBtn('再試行', 'btn sm ghost inline', () => edFlush(s));
  els.retry.id = 'rp-retry';
  els.retry.hidden = true;
  saveBox.append(els.save, els.retry);
  top.appendChild(saveBox);
  nodes.push(top);
  els.notice = mk('div', 'rep-sub');
  els.notice.id = 'rp-notice';
  els.notice.textContent = s.notice || '';
  els.notice.hidden = !s.notice;
  nodes.push(els.notice);

  // 入力チェックの表示場所
  els.val = mk('div', 'rep-val');
  els.val.id = 'rp-val';
  els.val.setAttribute('role', 'alert');
  nodes.push(els.val);

  if (s.lock) {
    const d = s.lock.expires_at ? new Date(s.lock.expires_at) : null; // 期限なしは null
    const box = mk('div', 'rep-ro', '');
    box.id = 'rp-lock';
    box.appendChild(mk('b', null, s.lock.vendor_name + '様（作業員）がこの報告書を入力中です' + (d ? '（' + (d.getMonth() + 1) + '/' + d.getDate() + 'まで）' : '')));
    box.appendChild(mk('div', null, '作業員に渡したURLが有効なあいだは、入力が重ならないようにここでは編集できません。作業員が提出すると編集できるようになります。'));
    box.appendChild(mk('div', null, '自分で入力する場合は、URLを取り消してください（作業員はそのURLで続きを入力できなくなります）。'));
    const act = mk('div', 'rep-lock-act');
    const rv = mk('button', 'btn sm', 'URLを取り消して自分で入力する');
    rv.type = 'button'; rv.id = 'rp-lock-revoke';
    const a = mk('a', null, '協力業者URLの管理へ');
    a.href = '#case/' + s.report.case_id + '/share';
    act.appendChild(rv); act.appendChild(a);
    box.appendChild(act);
    rv.addEventListener('click', () => {
      // 画面内の確認（confirm() は使わない）
      act.replaceChildren();
      act.appendChild(mk('span', null, s.lock.vendor_name + '様のURLを取り消します。よろしいですか？'));
      const ok = mk('button', 'btn sm', '取り消して編集する'); ok.type = 'button'; ok.id = 'rp-lock-revoke-ok';
      const no = mk('button', 'btn sm ghost', 'やめる'); no.type = 'button';
      act.appendChild(ok); act.appendChild(no);
      no.addEventListener('click', () => { act.replaceChildren(rv, a); });
      ok.addEventListener('click', async () => {
        ok.disabled = true; no.disabled = true;
        try { await ReportsApi.revokeShare(s.lock.id); }
        catch (e) { ok.disabled = false; no.disabled = false; act.appendChild(mk('div', 'err', 'URLを取り消せませんでした: ' + errText(e))); return; }
        if (!s.alive()) return;
        openReport(s.id); // 取り消し後は読み込み直して編集できる状態に（端末に退避した入力があれば復元される）
      });
    });
    nodes.push(box);
  } else if (ro) nodes.push(mk('div', 'rep-ro', 'この報告書は「' + L.statusLabel(s.report.status) + '」のため、内容は変更できません（読み取り専用）'));

  const info = s.info;
  nodes.push(...rfBuildForm(s, {
    infoTitle: '案件情報（自動で入ります）',
    // Task 20: 対応フェーズの報告書は作業区分が決まっている（調査→調査／原因元工事→設備修繕／復旧工事→復旧工事。切替を出さない）
    fixedMode: !!s.fixed,
    fixedLabel: s.fixed ? L.WORK_TYPE_LABEL[s.f.work_type] : '',
    fixedHint: s.fixed ? (s.fixed.title ? s.fixed.title + 'の報告書なので変えられません' : '対応フェーズの報告書なので変えられません') : '',
    infoRows: [['物件名', info.name], ['現場住所', info.address], ['元請け', info.client_name], ['案件No', String(s.report.case_id || '').slice(0, 8).toUpperCase()]],
    // 作業者: メンバー or 協力業者（名前を入力）
    afterRoom(g2, basic) {
      const known = s.members.some(m => m.user_id === s.f.worker_id);
      const wopts = [['', '— 選択してください —']];
      s.members.forEach(m => wopts.push([m.user_id, (m.display_name || '(名前なし)') + (m.user_id === ctx.user.id ? '（自分）' : '')]));
      if (s.f.worker_id && !known) wopts.push([s.f.worker_id, '（不明なメンバー）']);
      wopts.push([ED_VENDOR, '協力業者（名前を入力）']);
      const wval = s.f.worker_id ? s.f.worker_id : (String(s.f.worker_name || '').trim() ? ED_VENDOR : '');
      els.worker = edSelect('rp-worker', wopts, wval, v => {
        if (v === ED_VENDOR) { s.f.worker_id = null; s.f.worker_name = els.vendor.value; }
        else { s.f.worker_id = v || null; s.f.worker_name = ''; }
        syncVendor();
        edMarkDirty(s);
        if (v === ED_VENDOR) els.vendor.focus();
      });
      g2.appendChild(edField('作業者 *', els.worker));
      els.vendor = edInput('rp-vendor', 'text', s.f.worker_name, v => { s.f.worker_name = v; edMarkDirty(s); }, { placeholder: '協力業者名', autocomplete: 'off' });
      els.vendorWrap = edField('協力業者名', els.vendor);
      const syncVendor = () => { els.vendorWrap.hidden = els.worker.value !== ED_VENDOR; };
      basic.appendChild(els.vendorWrap);
      syncVendor();
    }
  }));
  els.photoInput.addEventListener('change', () => {
    const files = Array.from(els.photoInput.files || []);
    els.photoInput.value = '';
    const phase = rfTakePhase(s); // 「鍵返却の写真を追加」から開いたときは区分 key
    if (files.length) edAddPhotos(s, files, phase);
  });

  $('report-root').replaceChildren(...nodes);
  // ro のときは入力欄を全部 disabled（リード専用）
  if (ro) $('report-root').querySelectorAll('input,select,textarea').forEach(e => { e.disabled = true; });
}

/* ---------- 写真 ---------- */
function edPhotoUrl(s, path) {
  if (!s.urls.has(path)) {
    const p = ReportsApi.photoUrl(path);
    p.catch(() => s.urls.delete(path)); // 失敗は覚えない（次の描画でやり直す）
    s.urls.set(path, p);
  }
  return s.urls.get(path);
}

// PDFプレビュー・提出・戻るは、写真の処理中/提出中は押せない
function edSyncNav(s) {
  const lock = s.photoBusy || s.submitting;
  $('rep-to-pdf').disabled = lock;
  $('rep-submit').disabled = lock;
  $('rep-confirm').disabled = lock;
  if (s.els.back) s.els.back.disabled = s.photoBusy || s.submitting;
}

function edSyncPhotoDisabled(s) {
  edSyncNav(s);
  rfSyncPhotoRows(s, s.photoBusy || s.ro);
}

function edRenderPhotos(s) {
  rfRenderPhotos(s, {
    thumb(p, i) {
      const img = mk('img', 'rep-ph-img');
      img.alt = 'No.' + (i + 1);
      img.loading = 'lazy';
      edPhotoUrl(s, p.path).then(u => PhotoMarkEditor.thumbSrc(u, p.marks))
        .then(u => { if (ed === s && img.isConnected) img.src = u; }).catch(() => { /* 灰色の枠のまま */ });
      return img;
    },
    mark: i => edOpenMarks(s, i),
    move: (i, dir) => edPhotoOp(s, () => ReportsApi.movePhoto(s.report, i, dir)),
    remove(i) {
      if (s.photoBusy || !confirm('この写真を削除しますか？')) return;
      edPhotoOp(s, () => ReportsApi.removePhoto(s.report, i));
    },
    after: () => edSyncPhotoDisabled(s)
  });
}

// 印（Task 14）: 空なら marks を持たせない（印のない写真は今までと同じ形）
function edSetMarks(p, marks) {
  if (marks && marks.length) p.marks = marks;
  else delete p.marks;
}
// 写真に印を付ける全画面シート。保存は写真のキャプションと同じ自動保存の道（photos ごと送る）を、終わるまで待つ
async function edOpenMarks(s, i) {
  if (s.photoBusy || s.ro || s.submitting) return;
  const p = (s.report.photos || [])[i];
  if (!p) return;
  let url;
  try { url = await edPhotoUrl(s, p.path); }
  catch (e) { edPhotoMsg(s, '写真を読み込めませんでした: ' + errText(e), true); return; }
  if (ed !== s || s.ro) return;
  PhotoMarkEditor.open({
    src: url,
    marks: p.marks,
    title: 'No.' + (i + 1) + ' に印を付ける',
    async onSave(marks) {
      if (ed !== s || s.ro) throw new Error('この報告書は今は変更できません');
      edSetMarks(p, marks);
      edMarkDirty(s, true);
      await edFlush(s);
      if (edPending(s)) throw new Error(s.saveErr || '通信を確認して、もう一度「保存」を押してください');
    },
    onClose: () => { if (ed === s) edRenderPhotos(s); }
  });
}

function edPhotoMsg(s, text, isErr) {
  s.els.photoMsg.textContent = text || '';
  s.els.photoMsg.classList.toggle('err-on', !!isErr);
}

// 写真の追加・削除・並び替えは1つずつ。実行中は写真まわりの操作を無効化する。先に保存待ちの入力を保存
async function edPhotoOp(s, fn) {
  if (s.photoBusy || s.ro) return;
  s.photoBusy = true;
  edSyncPhotoDisabled(s);
  edPhotoMsg(s, '');
  try {
    await edFlush(s);
    if (edPending(s)) throw new Error('入力を保存できていないため、写真は変更できません。通信を確認して「再試行」してください');
    await fn();
  } catch (e) {
    edPhotoMsg(s, '写真を変更できませんでした: ' + errText(e), true);
  } finally {
    s.photoBusy = false;
    if (edPending(s)) edLsSet(s); // 写真操作でサーバーの updated_at が進んだので、退避の base も合わせる
    if (ed === s) edRenderPhotos(s);
  }
}

async function edAddPhotos(s, files, phase) {
  if (s.photoBusy || s.ro) return;
  const failures = [];
  await edPhotoOp(s, async () => {
    for (let i = 0; i < files.length; i++) {
      if (ed !== s) return;
      edPhotoMsg(s, '写真をアップロード中 ' + (i + 1) + '/' + files.length);
      try {
        await ReportsApi.addPhoto(s.report, files[i], { phase: phase || '' });
        edRenderPhotos(s);
        edSyncPhotoDisabled(s);
      } catch (e) {
        failures.push('「' + files[i].name + '」: ' + errText(e));
      }
    }
    edPhotoMsg(s, '');
  });
  if (failures.length && ed === s) edPhotoMsg(s, failures.length + '枚アップロードできませんでした\n' + failures.join('\n'), true);
  else if (ed === s && !s.photoBusy && !s.els.photoMsg.textContent) edPhotoMsg(s, files.length + '枚追加しました');
}

/* ---------- 下部バー（PDFプレビュー・提出） ---------- */
// 提出/確認の通信中は入力欄も無効化する（打鍵の取りこぼし防止）。戻すときは、ここで無効化したものだけ戻す
function edSetBarBusy(s, busy) {
  edSyncNav(s);
  if (busy) {
    s.locked = [];
    $('report-root').querySelectorAll('input,select,textarea,button').forEach(e => {
      if (!e.disabled) { e.disabled = true; s.locked.push(e); }
    });
  } else {
    (s.locked || []).forEach(e => { e.disabled = false; });
    s.locked = [];
    if (s.els.photoList) edSyncPhotoDisabled(s);
  }
}

async function edGoPdf(s) {
  if (s.submitting || s.photoBusy) return;
  s.submitting = true;
  edSetBarBusy(s, true);
  try {
    await edFlush(s);
    if (edPending(s) && !confirm('保存できていない入力があります。このままPDFプレビューへ進みますか？\n（プレビューには保存済みの内容が出ます）')) return;
    location.hash = '#report/' + s.id + '/pdf';
  } finally {
    s.submitting = false;
    edSetBarBusy(s, false);
  }
}

async function edSubmit(s) {
  if (s.submitting || s.ro || s.photoBusy) return;
  s.submitting = true;
  edSetBarBusy(s, true);
  try {
    if (s.photoBusy) { edShowVal(s, ['写真の処理が終わるまでお待ちください'], []); return; }
    await edFlush(s);
    if (edPending(s)) { edShowVal(s, ['入力を保存できていません。通信を確認して、上の「再試行」を押してください'], []); return; }
    const cur = Object.assign({}, s.report, edCollect(s));
    const { errors, warnings } = ReportLogic.validate(cur);
    if (!cur.worker_id && !String(cur.worker_name || '').trim()) errors.push('作業者を選んでください');
    edShowVal(s, errors, warnings);
    if (errors.length) return;
    if (warnings.length && !confirm('このまま提出しますか？\n\n' + warnings.map(w => '・' + w).join('\n'))) return;
    try {
      await ReportsApi.submit(s.report);
    } catch (e) {
      edShowVal(s, ['提出できませんでした: ' + errText(e)], []);
      return;
    }
    s.submitted = true;
    s.ro = true;
    clearTimeout(s.timer);
    edLsDel(s.id);
    const fb = (typeof fieldBack === 'function' ? fieldBack(s.report.case_id) : null);
    location.hash = fb ? fb.hash : '#case/' + s.report.case_id + '/reports';
  } finally {
    s.submitting = false;
    edSetBarBusy(s, false);
  }
}

/* ---------- 入口 ---------- */
function edMessage(text, isErr) {
  $('report-bar').hidden = true;
  $('report-root').replaceChildren(mk('div', isErr ? 'err' : 'empty', text));
}

async function openReport(id) {
  const seq = ++edSeq;
  const prev = ed;
  edStopVoice();
  showScreen('report');
  renderHeaders();
  edMessage('読み込み中…', false);
  // 直前の画面で保留中の保存を終わらせてから読み込む（同じ報告書に戻ったとき古い内容を読まないため）
  if (prev) { clearTimeout(prev.timer); await edFlush(prev); }
  if (seq !== edSeq) return;
  ed = null;

  let r, info, members, shares;
  try {
    r = await ReportsApi.get(id);
    if (r) {
      [info, members, shares] = await Promise.all([
        currentCase && currentCase.id === r.case_id ? currentCase : CasesApi.getSummary(r.case_id),
        CasesApi.listMembers(),
        r.status === 'draft' ? ReportsApi.listShares(r.id) : Promise.resolve([])
      ]);
    }
  } catch (e) {
    if (seq !== edSeq) return;
    edMessage('報告書を読み込めませんでした: ' + errText(e), true);
    return;
  }
  if (seq !== edSeq) return;
  if (!r) { edMessage('報告書が見つかりません', false); return; }

  // 協力業者が入力中（有効なURLがある）下書きは読み取り専用（DB もトリガーで社内の更新を拒否する: migration 011）
  const lock = (shares || []).find(ReportsApi.shareActive) || null;
  const s = {
    id: r.id, gen: seq, report: r, info: info || { name: '（案件情報を取得できません）' }, members: members || [],
    f: edFromRow(r), ro: r.status !== 'draft' || !!lock, lock,
    dirty: false, photosDirty: false, timer: null, chain: Promise.resolve(), saveState: '', saveErr: '', lastSaved: null,
    photoBusy: false, submitting: false, submitted: false, urls: new Map(), els: {},
    onDirty: edMarkDirty, alive: () => ed === s
  };
  r.photos = Array.isArray(r.photos) ? r.photos : [];

  // 端末に退避した入力の復元（下書きのときだけ）。端末の時計は使わず、退避した時点のサーバー updated_at（base）と
  // 今のサーバー updated_at が同じ（＝その後サーバーが変わっていない）ときだけ戻す。違えばサーバー優先で退避を捨てる
  let restored = false;
  if (s.ro) { if (!lock) edLsDel(s.id); } // 入力中ロックの間は退避を残す（URLを無効にしたら復元できる）
  else {
    const ls = edLsGet(s.id);
    if (ls) {
      if (edSameStamp(ls.base, r.updated_at)) {
        edApplyDraft(s.f, ls.f);
        if (edApplyPhotoDraft(r.photos, ls.photos)) s.photosDirty = true;
        s.dirty = true;
        restored = true;
      } else {
        edLsDel(s.id);
        s.notice = 'この端末に未保存の入力がありましたが、他で更新されたため破棄しました';
      }
    }
  }
  // 作業日の既定: 新規作成直後（何も入力されていない下書き）は今日（旧ツールどおり）
  const fresh = !s.ro && !restored && edIsUntouched(r, s.f);
  if (fresh) s.f.work_date = CaseLogic.todayStr();
  // Task 20: フェーズ付きの報告書は作業区分をフェーズの種類で固定（違っていたら直して保存する）
  s.fixed = edFixedOf(r, s.info);
  const retype = !!s.fixed && s.fixed.type !== s.f.work_type;
  if (s.fixed) s.f.work_type = s.fixed.type;

  ed = s;
  edBuild(s);
  edApplyMode(s);
  edRenderPhotos(s);
  edSetSave(s, restored ? 'restored' : '');

  const bar = $('report-bar');
  bar.hidden = false;
  $('rep-submit').hidden = s.ro;
  // 提出済み（確認待ち）のときだけ「確認する」。現場用（Task 18）では出さない（確認・送付は管理者側）
  $('rep-confirm').hidden = r.status !== 'submitted' || (typeof fieldHidesAdmin === 'function' && fieldHidesAdmin());
  $('rep-confirm').textContent = '確認する';
  $('rep-to-pdf').onclick = () => edGoPdf(s);
  $('rep-submit').onclick = () => edSubmit(s);
  $('rep-confirm').onclick = () => edConfirm(s);
  edSetBarBusy(s, false);

  if (fresh || (retype && !restored)) edMarkDirty(s); // 既定の作業日・固定した作業区分をサーバーにも保存する
  else if (restored) edFlush(s);
}

// フェーズ付きの報告書 → { type: 作業区分, title: '調査 1回目' }。フェーズが見つからないときは今の区分のまま固定。フェーズ無しは null（従来どおり選べる）
function edFixedOf(r, info) {
  if (!r.phase_id) return null;
  const phases = info && Array.isArray(info.phases) ? info.phases : [];
  const p = phases.find(x => x.id === r.phase_id) || null;
  const type = (p && ReportLogic.WORK_TYPE_OF_PHASE[p.kind]) || (ReportLogic.MODES[r.work_type] ? r.work_type : 'investigate');
  const title = p && typeof PhaseLogic !== 'undefined' ? PhaseLogic.phaseTitle(p, p.seq) : '';
  return { type, title };
}

/* ---------- 復元の補助 ---------- */
function edSameStamp(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const x = Date.parse(a), y = Date.parse(b);
  return Number.isFinite(x) && x === y;
}
// 退避の写真は「パスが一致するものの キャプション/区分/印だけ」戻す（増減は戻さない）。変えたものがあれば true
function edApplyPhotoDraft(photos, saved) {
  if (!Array.isArray(saved)) return false;
  let changed = false;
  saved.forEach(sp => {
    const p = photos.find(x => x.path === sp.path);
    if (!p) return;
    const cap = typeof sp.caption === 'string' ? sp.caption : (p.caption || '');
    const ph = typeof sp.phase === 'string' ? sp.phase : (p.phase || '');
    const pn = typeof sp.phaseNote === 'string' ? sp.phaseNote.slice(0, ReportLogic.PHASE_NOTE_MAX) : (p.phaseNote || '');
    if ((p.caption || '') !== cap || (p.phase || '') !== ph || (p.phaseNote || '') !== pn) { p.caption = cap; p.phase = ph; p.phaseNote = pn; changed = true; }
    if (Array.isArray(sp.marks)) {
      const mk2 = PhotoMarks.normalize(sp.marks);
      if (JSON.stringify(mk2) !== JSON.stringify(PhotoMarks.normalize(p.marks))) { edSetMarks(p, mk2); changed = true; }
    }
  });
  return changed;
}
// 何も入力されていない新規の下書きか
function edIsUntouched(r, f) {
  const emptyJson = JSON.stringify(ReportLogic.emptyData());
  return !f.work_date && !String(f.room || '').trim() && !f.time_start && !f.time_end &&
    JSON.stringify(f.data) === emptyJson && (r.photos || []).length === 0;
}

/* ---------- ⑥から確認する（提出済みのとき） ---------- */
async function edConfirm(s) {
  if (s.submitting || s.photoBusy || s.report.status !== 'submitted') return;
  if (!confirm('この報告書を確認済みにしますか？\n確認すると、依頼者へ送る報告メールの下書きが作られます。')) return;
  s.submitting = true;
  edSetBarBusy(s, true);
  let draft = null;
  try {
    draft = await ReportsApi.confirm(s.report, s.info);
  } catch (e) {
    if (e && e.report) { // 確認は済み、下書きメールの作成だけ失敗
      s.report = Object.assign(s.report, e.report);
      $('rep-confirm').hidden = true;
      $('rep-submit').hidden = true;
      edShowVal(s, [errText(e) + '（報告書一覧の「送付メールの下書きを作る」からも作れます）'], []);
    } else {
      edShowVal(s, ['確認できませんでした: ' + errText(e)], []);
    }
    return;
  } finally {
    s.submitting = false;
    edSetBarBusy(s, false);
  }
  if (ed !== s) return;
  if (typeof openMailDraft === 'function' && draft && draft.id) openMailDraft(draft.id);
  else location.hash = '#case/' + s.report.case_id + '/reports';
}
