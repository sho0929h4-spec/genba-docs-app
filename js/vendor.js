// js/vendor.js — ⑧ 協力業者の入力ページ（r.html#{token}。ログイン不要）  （Task 6）
// セキュリティ:
//   ・token は URL の # 以降にだけある（# 以降はサーバーへ送られない）。DB へは RPC の引数としてだけ渡す。
//     画面・console・localStorage には出さない（提出済みの目印だけ、token の SHA-256 の先頭を使う）。
//   ・Supabase クライアントはセッションなし（persistSession:false 等）で作る。協力業者が同じブラウザで
//     このアプリにログインしていても、ここは必ず anon として動く。r.html は js/supabase.js（既定の sb）を読まない。
//   ・anon ができるのは share_open / share_submit と、自分の share フォルダへの写真の新規アップロードだけ
//     （DB: migration 009/010。ファイル名は英数._- で .jpg、100件まで、上書き不可、読み取り・削除不可）。
// 入力欄は ⑥ と同じもの（js/report-form.js の rfBuildForm を共有。作業者欄なし・作業区分は発行時に決まっていて変更不可）。
// 入力内容と写真リスト（path, name, caption, phase, marks）は localStorage `share-{share_id}` に保存して再読込で復元する。
// 写真のプレビューはこの端末で選んだ写真（blob URL）だけ。anon は Storage から読めないので、再読込後はプレビューなし。
// PDFプレビューは出さない（anon は署名URLを作れず、ロゴ・写真を PDF に載せられないため。PDF は提出後に社内で作る）。
(() => {
  'use strict';
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'genba-vendor' }
  });
  const token = location.hash.slice(1);
  const MAX_PHOTOS = 100;
  const FILE_RE = /^[A-Za-z0-9._-]+\.jpe?g$/i;
  const $ = id => document.getElementById(id);
  const el = rfMk;
  let s = null; // 表示中の入力セッション

  // # を書き換えたら別のURLとして開き直す
  window.addEventListener('hashchange', () => location.reload());

  /* ---------- 補助 ---------- */
  const errMsg = e => (e && e.message ? String(e.message) : '通信に失敗しました。電波の良いところでもう一度お試しください');
  const pad = n => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const fmtDue = iso => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  // 頭文字: 「株式会社」「(株)」などは飛ばす
  const initial = name => {
    const t = String(name || '').replace(/^(株式会社|有限会社|合同会社|合資会社|合名会社|[(（][株有][)）])\s*/, '').trim();
    return Array.from(t || String(name || '') || '？')[0];
  };
  async function tokenMark() {
    return 'share-done-' + (await CryptoUtil.sha256Hex(token)).slice(0, 32); // 先頭16バイト = 32文字
  }
  const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 容量不足など */ } };
  const lsDel = k => { try { localStorage.removeItem(k); } catch (e) { /* 何もしない */ } };

  /* ---------- 全画面メッセージ ---------- */
  function full(icon, title, text, retry) {
    $('v-bar').hidden = true;
    const box = el('div', 'v-full');
    box.id = 'v-full';
    box.append(el('div', 'v-icon', icon), el('h1', null, title));
    if (text) box.appendChild(el('p', null, text));
    if (retry) {
      const b = el('button', 'btn ghost', 'もう一度読み込む');
      b.type = 'button';
      b.addEventListener('click', retry);
      box.appendChild(b);
    }
    $('v-root').replaceChildren(box);
  }

  /* ---------- 読み込み ---------- */
  async function boot() {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) {
      full('⚠️', 'URLが正しくありません', '届いたURLを最後までそのまま開いてください。分からない場合は依頼元の会社にご連絡ください。');
      return;
    }
    full('⏳', '読み込み中…');
    let res;
    try { res = await client.rpc('share_open', { p_token: token }); }
    catch (e) { res = { data: null, error: e }; }
    if (res.error || !res.data) {
      const m = errMsg(res.error);
      if (lsGet(await tokenMark())) {
        full('✅', 'この報告書は提出済みです', '提出はすでに完了しています。ありがとうございました。内容の変更が必要な場合は依頼元の会社にご連絡ください。');
      } else if (/無効|期限切れ|提出/.test(m)) {
        full('⚠️', m, '依頼元の会社に、新しいURLの発行をご依頼ください。');
      } else {
        full('⚠️', '読み込めませんでした', m, () => boot());
      }
      return;
    }
    start(res.data);
  }

  function start(info) {
    const r = info.report || {};
    const key = 'share-' + info.share_id;
    const wt = ReportLogic.MODES[r.work_type] ? r.work_type : 'investigate';
    s = {
      info, key, ro: false, els: {}, blobs: new Map(),
      f: {
        work_type: wt,
        room: r.room || '',
        work_date: r.work_date ? String(r.work_date).slice(0, 10) : '',
        time_start: r.time_start ? String(r.time_start).slice(0, 5) : '',
        time_end: r.time_end ? String(r.time_end).slice(0, 5) : '',
        data: ReportLogic.normalizeData(r.data)
      },
      report: { photos: [] },
      photoBusy: false, submitting: false, done: false,
      onDirty: () => { saveLocal(); clearVal(); },
      alive: () => s && !s.done
    };
    const restored = restoreLocal();
    if (!s.f.work_date) s.f.work_date = today();
    build(restored);
  }

  /* ---------- 端末への保存 ---------- */
  function saveLocal() {
    if (!s || s.done) return;
    const f = s.f;
    lsSet(s.key, {
      t: Date.now(),
      f: { room: f.room, work_date: f.work_date, time_start: f.time_start, time_end: f.time_end, data: f.data },
      photos: s.report.photos.map(p => ({ path: p.path, name: p.name, caption: p.caption || '', phase: p.phase || '', phaseNote: p.phaseNote || '', marks: PhotoMarks.normalize(p.marks) }))
    });
  }
  // 壊れた値・他の share の写真は捨てる
  function restoreLocal() {
    const o = lsGet(s.key);
    if (!o || typeof o !== 'object' || !o.f || typeof o.f !== 'object') return false;
    ['room', 'work_date', 'time_start', 'time_end'].forEach(k => { if (typeof o.f[k] === 'string') s.f[k] = o.f[k]; });
    if (o.f.data && typeof o.f.data === 'object' && !Array.isArray(o.f.data)) s.f.data = ReportLogic.normalizeData(o.f.data);
    const prefix = s.info.upload_prefix;
    const seen = new Set();
    s.report.photos = (Array.isArray(o.photos) ? o.photos : []).filter(p => {
      if (!p || typeof p.path !== 'string' || !p.path.startsWith(prefix)) return false;
      if (!FILE_RE.test(p.path.slice(prefix.length)) || seen.has(p.path)) return false;
      seen.add(p.path);
      return true;
    }).slice(0, MAX_PHOTOS).map(p => ({
      path: p.path,
      name: typeof p.name === 'string' ? p.name.slice(0, 120) : '',
      caption: typeof p.caption === 'string' ? p.caption.slice(0, 200) : '',
      // Task 21: 区分は今の5つにそろえる（古い下書きの旧区分も読み替え。自由記載は phaseNote）
      ...ReportLogic.photoPhaseOut({ phase: typeof p.phase === 'string' ? p.phase : '', phaseNote: typeof p.phaseNote === 'string' ? p.phaseNote : '' }),
      marks: PhotoMarks.normalize(p.marks)
    }));
    return true;
  }

  /* ---------- 画面 ---------- */
  function build(restored) {
    const info = s.info, L = ReportLogic;
    const orgName = (info.org && info.org.name) || '';
    document.title = '作業報告書の入力' + (orgName ? '｜' + orgName : '');
    $('v-logo').textContent = initial(orgName);
    $('v-org').textContent = orgName;
    $('v-hdr').hidden = false;

    const nodes = [];
    const head = el('div', 'rep-card');
    const top = el('div', 'rep-between');
    const vname = el('b', null, (String(info.vendor_name || '').trim() || '担当者') + ' 様'); // 名前は任意（空なら「担当者 様」。Task 24）
    vname.id = 'v-vendor';
    top.appendChild(vname);
    if (info.expires_at) { // 期限なし（null）のURLは期限を出さない
      const due = el('span', 'rep-pill', '入力期限 ' + fmtDue(info.expires_at));
      due.id = 'v-due';
      top.appendChild(due);
    }
    head.appendChild(top);
    const dl = el('dl', 'rep-auto');
    dl.id = 'v-info';
    [['物件名', info.case && info.case.name], ['現場住所', info.case && info.case.address], ['作業区分', L.WORK_TYPE_LABEL[s.f.work_type]]]
      .forEach(([k, v]) => { dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', null, v || '—')); });
    head.appendChild(dl);
    nodes.push(head);

    const note = el('div', 'rep-note',
      '途中で閉じても、入力内容と写真のリストはこの端末に保存されます。提出後は変更できません。' +
      '提出された内容は' + (orgName || '依頼元の会社') + 'が確認し、報告書（PDF）にします。');
    note.id = 'v-note';
    if (restored) note.textContent = 'この端末に保存していた入力を復元しました。' + note.textContent;
    nodes.push(note);

    s.els.val = el('div', 'rep-val');
    s.els.val.id = 'rp-val';
    s.els.val.setAttribute('role', 'alert');
    nodes.push(s.els.val);

    nodes.push(...rfBuildForm(s, {
      infoTitle: '号室・作業日・時間',
      fixedMode: true,
      photoHint: 'カメラで撮るか、アルバムから選べます。写真は自動で圧縮して、選んだ時点で送信します'
    }));
    s.els.photoInput.addEventListener('change', () => {
      const files = Array.from(s.els.photoInput.files || []);
      s.els.photoInput.value = '';
      const phase = rfTakePhase(s); // 「鍵返却の写真を追加」から開いたときは区分 key
      if (files.length) addPhotos(files, phase);
    });
    $('v-root').replaceChildren(...nodes);
    edApplyMode(s);
    renderPhotos();

    $('v-bar').hidden = false;
    $('v-submit').onclick = submit;
    syncBar();
  }

  function clearVal() { if (s.els.val && s.els.val.firstChild) s.els.val.replaceChildren(); }
  function showVal(errors, warnings) {
    const nodes = [];
    errors.forEach(t => nodes.push(el('div', 'rep-val-e', '⛔ ' + t)));
    warnings.forEach(t => nodes.push(el('div', 'rep-val-w', '⚠ ' + t)));
    s.els.val.replaceChildren(...nodes);
    if (nodes.length) s.els.val.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  function syncBar() { $('v-submit').disabled = s.photoBusy || s.submitting; }

  /* ---------- 写真 ---------- */
  function renderPhotos() {
    rfRenderPhotos(s, {
      thumb(p, i) {
        const url = s.blobs.get(p.path);
        const nMarks = PhotoMarks.normalize(p.marks).length;
        if (!url) {
          const box = el('div', 'rep-ph-img rep-ph-none', 'アップロード済み（プレビューなし）' + (nMarks ? '・印 ' + nMarks + '個' : ''));
          box.setAttribute('aria-label', 'No.' + (i + 1));
          return box;
        }
        const img = el('img', 'rep-ph-img');
        img.alt = 'No.' + (i + 1);
        img.src = url;
        if (nMarks) PhotoMarkEditor.thumbSrc(url, p.marks).then(u => { if (img.isConnected) img.src = u; });
        return img;
      },
      // 印（Task 14）: この端末で選んだ写真（プレビューがあるもの）だけ付けられる。保存は端末（localStorage）に。提出で送る
      canMark: p => s.blobs.has(p.path),
      mark(i) {
        const p = s.report.photos[i];
        if (!p || s.photoBusy || s.submitting || s.done || !s.blobs.has(p.path)) return;
        PhotoMarkEditor.open({
          src: s.blobs.get(p.path),
          marks: p.marks,
          title: 'No.' + (i + 1) + ' に印を付ける',
          onSave: async marks => {
            if (s.done) throw new Error('提出済みです');
            p.marks = marks;
            saveLocal();
          },
          onClose: () => { if (s && !s.done) renderPhotos(); }
        });
      },
      move(i, dir) {
        const a = s.report.photos, j = i + (dir < 0 ? -1 : 1);
        if (s.photoBusy || !a[i] || j < 0 || j >= a.length) return;
        [a[i], a[j]] = [a[j], a[i]];
        saveLocal();
        renderPhotos();
      },
      remove(i) {
        if (s.photoBusy || !confirm('この写真を一覧から外しますか？（提出しなければ報告書には入りません）')) return;
        s.report.photos.splice(i, 1);
        saveLocal();
        renderPhotos();
      },
      after: () => { rfSyncPhotoRows(s, s.photoBusy || s.submitting); syncBar(); }
    });
  }
  function photoMsg(text, isErr) {
    s.els.photoMsg.textContent = text || '';
    s.els.photoMsg.classList.toggle('err-on', !!isErr);
  }

  async function addPhotos(files, phase) {
    if (s.photoBusy || s.submitting) return;
    s.photoBusy = true;
    renderPhotos();
    const prefix = s.info.upload_prefix;
    const failures = [];
    let added = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (s.report.photos.length >= MAX_PHOTOS) { failures.push('写真は' + MAX_PHOTOS + '枚までです'); break; }
      photoMsg('写真をアップロード中 ' + (i + 1) + '/' + files.length);
      try {
        const p = await ImageUtil.prepareFile(file);
        if (p.type !== 'image/jpeg') throw new Error('写真ではありません');
        const path = prefix + CryptoUtil.uuid() + '.jpg';
        const { error } = await client.storage.from('files').upload(path, p.blob, { contentType: 'image/jpeg', upsert: false });
        if (error) throw new Error('送信できませんでした（URLの期限切れ・無効、または写真が多すぎる可能性があります）');
        s.blobs.set(path, URL.createObjectURL(p.blob));
        s.report.photos.push({ path, name: String(p.name || '').slice(0, 120), caption: '', phase: phase || '' });
        added++;
        saveLocal();
        renderPhotos();
      } catch (e) {
        failures.push('「' + file.name + '」: ' + errMsg(e));
      }
    }
    s.photoBusy = false;
    renderPhotos();
    if (failures.length) photoMsg(failures.length + '件追加できませんでした\n' + failures.join('\n'), true);
    else photoMsg(added + '枚追加しました');
  }

  /* ---------- 提出 ---------- */
  async function submit() {
    if (!s || s.photoBusy || s.submitting || s.done) return;
    const f = s.f;
    const photos = s.report.photos.map(p => {
      const o = Object.assign({ path: p.path, name: p.name || '', caption: p.caption || '' }, ReportLogic.photoPhaseOut(p));
      if (!o.phaseNote) delete o.phaseNote;
      const marks = PhotoMarks.normalize(p.marks);
      if (marks.length) o.marks = marks;
      return o;
    });
    const cur = { work_type: f.work_type, room: f.room, work_date: f.work_date, time_start: f.time_start, time_end: f.time_end, data: f.data, photos };
    const { errors, warnings } = ReportLogic.validate(cur);
    showVal(errors, warnings);
    if (errors.length) return;
    const q = (warnings.length ? '次の点を確認してください。\n' + warnings.map(w => '・' + w).join('\n') + '\n\n' : '') +
      '提出すると内容は変更できません。このまま提出しますか？';
    if (!confirm(q)) return;

    s.submitting = true;
    const locked = [];
    $('v-root').querySelectorAll('input,select,textarea,button').forEach(e => { if (!e.disabled) { e.disabled = true; locked.push(e); } });
    syncBar();
    const payload = {
      room: String(f.room || '').trim(),
      work_date: f.work_date,
      time_start: f.time_start || null,
      time_end: f.time_end || null,
      data: ReportLogic.normalizeData(f.data),
      photos
    };
    let error = null;
    try { ({ error } = await client.rpc('share_submit', { p_token: token, p_payload: payload })); }
    catch (e) { error = e; }
    if (error) {
      s.submitting = false;
      locked.forEach(e => { e.disabled = false; });
      renderPhotos();
      showVal(['提出できませんでした: ' + errMsg(error)], []);
      return;
    }
    s.done = true;
    lsDel(s.key);
    lsSet(await tokenMark(), 1);
    s.blobs.forEach(u => URL.revokeObjectURL(u));
    s.blobs.clear();
    window.scrollTo(0, 0);
    full('✅', '提出しました。ありがとうございました',
      ((s.info.org && s.info.org.name) || '依頼元の会社') + 'が内容を確認します。このページは閉じてかまいません。');
  }

  boot();
})();
