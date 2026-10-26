// js/case-request.js — 案件ページの「依頼内容」の欄（依頼元の下。Task 28 / migration 052 の cases.request）
// 依頼元から聞いた内容をまとめる場所: 依頼内容（自由記載）／症状（押すと☑・複数）／被害箇所／怪しい箇所／事前に共有された写真（複数・キャプション）。
// 見た目は依頼元の欄と同じカード。ふだんは読むだけの表示（文章は3行で折りたたみ・写真は小さなサムネイルの横並び・押すと拡大: js/request-view.js）、
// 「編集」でその場で入力（入力から1.5秒で自動保存。保存中に入力しても失わない＝次の保存に回す）。写真は選んだ時点で圧縮して保存する。
// 保存したら、未送信の担当者への確認依頼メールの下書きの「■ 依頼内容」も直す（PhasesApi.syncStaffNoticeDrafts）。
// 担当者への確認依頼メール・🔔・現場用のツールページ・担当者URLのページ（r.html）に出る（依頼元の連絡先・金額は出さない）。
// ユーザー入力は createElement + textContent / value で描画する（innerHTML は使わない）。alert/confirm は使わない（削除は画面内で確かめる）
// mk() は case-list.js、dBtn / errText / currentCase / caseMembers は case-detail.js、edCheck / edSetOn は report-form.js、askInline は app.js
const CaseRequest = (() => {
  const DELAY = 1500;
  const sessions = new Map(); // caseId → { caseId, v, editing, dirty, saving, timer, chain, state, err, lastSaved, photoBusy, els }
  const json = v => JSON.stringify(PhaseLogic.normalizeRequest(v));

  function session(c) {
    let s = sessions.get(c.id);
    const server = json(c.request);
    if (!s) {
      s = { caseId: c.id, v: PhaseLogic.normalizeRequest(c.request), serverJson: server, editing: false, dirty: false, saving: false,
        timer: null, chain: Promise.resolve(), state: '', err: '', lastSaved: null, photoBusy: false, photoMsg: '', box: null, els: {} };
      sessions.set(c.id, s);
    } else if (!s.dirty && !s.saving && !s.timer && !s.photoBusy && s.serverJson !== server) {
      // 別の画面・別の人が変えた（こちらに未保存の入力は無い）→ サーバーの値にする
      Object.assign(s, { v: PhaseLogic.normalizeRequest(c.request), serverJson: server });
      if (s.editing) s.rebuild = true;
    }
    return s;
  }

  // 案件ページの欄（buildDetail が1回だけ呼ぶ。描き直しても同じ要素を使う）
  function section(c) {
    const s = session(c);
    const box = mk('div', 'taio rq-box');
    box.id = 'case-request';
    s.box = box;
    paint(s);
    return box;
  }
  // 案件を読み直したとき（依頼元の欄の再描画と一緒）。入力中は描き直さない
  function refresh(c) {
    const s = sessions.get(c.id);
    if (!s || !s.box || !s.box.isConnected) return;
    const before = s.serverJson;
    session(c);
    if (!s.editing && s.serverJson !== before) paint(s);
    else if (s.editing && s.rebuild) { s.rebuild = false; paint(s); }
  }

  function paint(s) {
    const box = s.box;
    if (!box) return;
    const head = mk('div', 'taio-head');
    head.appendChild(mk('b', null, '依頼内容'));
    const acts = mk('span', 'pty-head-acts');
    const tg = dBtn(s.editing ? '編集を終える' : '編集', 'linkbtn rq-edit', () => toggle(s));
    tg.id = 'rq-edit';
    tg.setAttribute('aria-expanded', s.editing ? 'true' : 'false');
    acts.appendChild(tg);
    head.appendChild(acts);
    const nodes = [head];
    if (s.editing) nodes.push(editor(s));
    else {
      const v = RequestView.build(s.v, { photoUrl: p => CasesApi.requestPhotoUrl(p), id: 'rq-view' });
      if (v) nodes.push(v);
      else { // 空なら見出しの行に1行で（縦に伸ばさない）
        const e = mk('span', 'pty-none rq-empty', 'まだありません（依頼元から聞いた内容・症状・写真を「編集」から）');
        e.id = 'rq-empty';
        head.insertBefore(e, acts);
      }
      if (s.state === 'error') nodes.push(saveLine(s));
    }
    box.classList.toggle('empty', !s.editing && !PhaseLogic.hasRequest(s.v));
    box.replaceChildren(...nodes);
    setState(s, s.state);
  }

  async function toggle(s) {
    if (!s.editing) { s.editing = true; paint(s); const t = s.box.querySelector('.rq-in-text'); if (t) t.focus(); return; }
    // 閉じる前に保存を終わらせる（失敗したら開いたまま）
    if (s.dirty || s.timer) await flush(s);
    if (s.dirty || s.photoBusy) { setState(s, s.photoBusy ? 'saving' : 'error'); return; }
    s.editing = false;
    paint(s);
  }

  /* ---- 入力欄 ---- */
  function field(label, ctl) {
    const l = mk('label', 'ph-rl rq-f', label);
    l.appendChild(ctl);
    return l;
  }
  function textArea(s, key, cls, rows, max, ph) {
    const ta = document.createElement('textarea');
    ta.className = cls;
    ta.rows = rows;
    ta.maxLength = max;
    ta.placeholder = ph;
    ta.value = s.v[key];
    ta.addEventListener('input', () => { s.v[key] = ta.value; changed(s); });
    return ta;
  }
  // Task 66: 調査依頼項目の選択（押すと☑・複数可）。排水テストは場所（複数可＋自由記載）、その他は自由記載。
  //   案件の登録（現場用 #f/new・管理者の新規案件）と依頼内容の編集で共通。onChange(items) に PhaseLogic.normalizeItems の形を渡す
  function itemsPicker(init, onChange, idp) {
    const PL = PhaseLogic;
    let items = PL.normalizeItems(init);
    const find = k => items.find(x => x.key === k);
    const emit = () => onChange(PL.normalizeItems(items));
    const box = mk('div', 'rqi');
    box.id = idp;
    const grid = mk('div', 'rep-checks grid rqi-grid');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', '調査依頼項目');
    const textIn = (cls, max, ph, aria, get, set) => {
      const i = document.createElement('input');
      i.type = 'text';
      i.className = cls;
      i.maxLength = max;
      i.autocomplete = 'off';
      i.placeholder = ph;
      i.setAttribute('aria-label', aria);
      i.value = get();
      i.addEventListener('input', () => { set(i.value); emit(); });
      return i;
    };
    // 排水テストの場所
    const drain = mk('div', 'rqi-sub');
    drain.id = idp + '-drain';
    drain.appendChild(mk('div', 'rqi-k', '排水テストの場所（押して選ぶ・複数可）'));
    const pg = mk('div', 'rep-checks grid rqi-places');
    pg.setAttribute('role', 'group');
    pg.setAttribute('aria-label', '排水テストの場所');
    const placeOther = textIn('rqi-place-other', 100, '例: ベランダ', '排水テストの場所（自由記載）',
      () => (find('drain') || {}).placeOther || '', v => { find('drain').placeOther = v; });
    const pl = mk('label', 'rqi-f', '自由記載');
    pl.appendChild(placeOther);
    drain.append(pg, pl);
    // その他
    const otherIn = textIn('rqi-other', 200, '例: 給湯器まわりも見てほしい', '調査依頼項目（その他）',
      () => (find('other') || {}).text || '', v => { find('other').text = v; });
    const other = mk('label', 'rqi-f rqi-sub', 'その他（自由記載）');
    other.id = idp + '-other';
    other.appendChild(otherIn);
    const placeBtns = PL.DRAIN_PLACES.map(p => {
      const b = edCheck(p, false, false, on => {
        const d = find('drain');
        const set = new Set(d.places);
        if (on) set.add(p); else set.delete(p);
        d.places = PL.DRAIN_PLACES.filter(x => set.has(x));
        emit();
      });
      b.dataset.place = p;
      pg.appendChild(b);
      return b;
    });
    const sync = () => {
      const d = find('drain');
      drain.hidden = !d;
      other.hidden = !find('other');
      placeBtns.forEach(b => edSetOn(b, !!d && d.places.includes(b.dataset.place)));
      placeOther.value = d ? d.placeOther : '';
      otherIn.value = (find('other') || {}).text || '';
    };
    PL.REQUEST_ITEMS.forEach(d => {
      const b = edCheck(d.label, !!find(d.key), false, on => {
        items = PL.normalizeItems(on ? items.concat([{ key: d.key }]) : items.filter(x => x.key !== d.key));
        sync();
        emit();
      });
      b.dataset.key = d.key;
      grid.appendChild(b);
    });
    box.append(grid, drain, other);
    sync();
    return box;
  }
  function editor(s) {
    const wrap = mk('div', 'rq-editor');
    s.els = {};
    wrap.appendChild(field('依頼内容（依頼元から聞いた内容）', textArea(s, 'text', 'rq-in-text', 3, PhaseLogic.REQUEST_TEXT_MAX,
      '例: 402号室の浴室下から階下302号室の天井に漏水')));
    wrap.appendChild(mk('div', 'ph-cau-t', '調査依頼項目（押して選ぶ・複数可）'));
    wrap.appendChild(itemsPicker(s.v.items, v => { s.v.items = v; changed(s); }, 'rq-items'));
    // 症状
    wrap.appendChild(mk('div', 'ph-cau-t', '症状（押して選ぶ・複数可）'));
    const grid = mk('div', 'rep-checks grid rq-symptoms');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', '症状');
    const other = document.createElement('input');
    other.type = 'text';
    other.className = 'rq-in-symptomOther';
    other.maxLength = 200;
    other.autocomplete = 'off';
    other.placeholder = '例: 夜になると水が落ちる';
    other.value = s.v.symptomOther;
    other.setAttribute('aria-label', '症状（その他）');
    other.addEventListener('input', () => { s.v.symptomOther = other.value; changed(s); });
    const ow = field('その他（自由記載）', other);
    ow.classList.add('rq-other');
    const sync = () => { ow.hidden = !s.v.symptoms.includes('other'); };
    PhaseLogic.REQUEST_SYMPTOMS.forEach(x => {
      const b = edCheck(x.label, s.v.symptoms.includes(x.key), false, on => {
        const set = new Set(s.v.symptoms);
        if (on) set.add(x.key); else set.delete(x.key);
        s.v.symptoms = PhaseLogic.REQUEST_SYMPTOMS.map(y => y.key).filter(k => set.has(k));
        sync();
        changed(s);
      });
      b.dataset.key = x.key;
      grid.appendChild(b);
    });
    sync();
    wrap.append(grid, ow);
    wrap.appendChild(field('被害箇所', textArea(s, 'damage', 'rq-in-damage', 2, PhaseLogic.REQUEST_FIELD_MAX, '例: 302号室 洋室の天井・壁')));
    wrap.appendChild(field('怪しい箇所', textArea(s, 'suspect', 'rq-in-suspect', 2, PhaseLogic.REQUEST_FIELD_MAX, '例: 402号室 浴室の排水まわり')));
    // 写真
    wrap.appendChild(mk('div', 'ph-cau-t', '事前に共有された写真（依頼元から届いた写真。' + PhaseLogic.REQUEST_PHOTOS_MAX + '枚まで）'));
    const list = mk('div', 'rq-plist');
    s.els.plist = list;
    wrap.appendChild(list);
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.multiple = true;
    file.className = 'sr-only';
    file.id = 'rq-file';
    file.addEventListener('change', () => {
      const files = Array.from(file.files || []);
      file.value = '';
      if (files.length) addPhotos(s, files);
    });
    const add = Icon.prepend(dBtn('写真を追加', 'btn sm ghost inline rq-add', () => file.click()), 'camera');
    add.id = 'rq-add';
    s.els.add = add;
    const pm = mk('span', 'rep-sub rq-pmsg', s.photoMsg || '');
    pm.id = 'rq-pmsg';
    pm.setAttribute('role', 'status');
    s.els.pmsg = pm;
    const pr = mk('div', 'rq-prow');
    pr.append(add, pm, file);
    wrap.appendChild(pr);
    fillPhotos(s);
    wrap.appendChild(saveLine(s));
    return wrap;
  }
  function saveLine(s) {
    const sv = mk('div', 'ph-res-save');
    const save = mk('span', 'rep-save rq-save');
    save.id = 'rq-save';
    save.setAttribute('role', 'status');
    const retry = dBtn('再試行', 'btn sm ghost inline rq-retry', () => flush(s));
    retry.hidden = true;
    sv.append(save, retry);
    s.els.save = save;
    s.els.retry = retry;
    return sv;
  }

  function fillPhotos(s) {
    const list = s.els.plist;
    if (!list) return;
    const ps = s.v.photos;
    if (!s.urls) s.urls = new Map();
    const urlOf = x => {
      if (!s.urls.has(x.path)) s.urls.set(x.path, CasesApi.requestPhotoUrl(x.path).catch(e => { s.urls.delete(x.path); throw e; }));
      return s.urls.get(x.path);
    };
    if (!ps.length) { list.replaceChildren(mk('div', 'ph-sub rq-pnone', 'まだありません')); }
    else {
      list.replaceChildren(...ps.map((p, i) => {
        const row = mk('div', 'rq-prow-i');
        row.dataset.path = p.path;
        // サムネイル（押すと i 番目から全部の写真を順に見られる）
        const th = mk('div', 'rq-thumbs one');
        const tb = dBtn('', 'rq-thumb', () => RequestView.openViewer(s.v.photos, s.v.photos.indexOf(p), urlOf));
        tb.setAttribute('aria-label', '写真' + (i + 1) + 'を拡大');
        const im = document.createElement('img');
        im.alt = p.caption || '写真' + (i + 1);
        urlOf(p).then(u => { if (u) im.src = u; }, () => { tb.classList.add('none'); im.alt = '写真を開けませんでした'; });
        tb.appendChild(im);
        th.appendChild(tb);
        const cap = document.createElement('input');
        cap.type = 'text';
        cap.className = 'rq-cap';
        cap.maxLength = 200;
        cap.placeholder = 'キャプション（例: 302 天井のシミ）';
        cap.value = p.caption || '';
        cap.setAttribute('aria-label', '写真' + (i + 1) + 'のキャプション');
        cap.addEventListener('input', () => { p.caption = cap.value; changed(s); });
        const del = dBtn('削除', 'linkbtn rq-del', async b => {
          const ok = await askInline(row, 'この写真を削除しますか？（元に戻せません）', { okLabel: '削除する', danger: true, id: 'rq-del-ask' });
          if (ok) removePhoto(s, p.path, b);
        });
        del.setAttribute('aria-label', '写真' + (i + 1) + 'を削除');
        del.disabled = s.photoBusy;
        const f = mk('div', 'rq-pf');
        f.append(cap, del);
        row.append(th, f);
        return row;
      }));
    }
    if (s.els.add) s.els.add.disabled = s.photoBusy || ps.length >= PhaseLogic.REQUEST_PHOTOS_MAX;
  }
  function photoMsg(s, text) {
    s.photoMsg = text;
    if (s.els.pmsg) s.els.pmsg.textContent = text;
  }

  async function addPhotos(s, files) {
    if (s.photoBusy) return;
    const room = PhaseLogic.REQUEST_PHOTOS_MAX - s.v.photos.length;
    const take = files.slice(0, Math.max(0, room));
    s.photoBusy = true;
    fillPhotos(s);
    const errs = [];
    if (files.length > take.length) errs.push('写真は' + PhaseLogic.REQUEST_PHOTOS_MAX + '枚までです');
    for (let i = 0; i < take.length; i++) {
      photoMsg(s, '写真を保存しています… ' + (i + 1) + '/' + take.length);
      let ph = null;
      try { ph = await CasesApi.uploadRequestPhoto(s.caseId, take[i]); }
      catch (e) { errs.push(errText(e)); continue; }
      s.v.photos.push(ph);
      s.dirty = true;
      await flush(s);
      if (s.dirty) { // 保存できなかった → 取り消してファイルも消す
        s.v.photos = s.v.photos.filter(x => x.path !== ph.path);
        try { await CasesApi.removeRequestFile(ph, false); } catch (_) { /* 何もしない */ }
        errs.push('「' + take[i].name + '」を保存できませんでした');
        s.dirty = json(s.v) !== s.serverJson;
        break;
      }
      await CasesApi.countRequestPhoto(ph);
      fillPhotos(s);
    }
    s.photoBusy = false;
    photoMsg(s, errs.join('\n'));
    fillPhotos(s);
  }
  async function removePhoto(s, path, b) {
    if (s.photoBusy) return;
    const p = s.v.photos.find(x => x.path === path);
    if (!p) return;
    s.photoBusy = true;
    if (b) b.disabled = true;
    photoMsg(s, '削除しています…');
    s.v.photos = s.v.photos.filter(x => x.path !== path);
    s.dirty = true;
    await flush(s);
    if (s.dirty) {
      s.v.photos.push(p); // 保存できなかった → 戻す（並びは最後）
      photoMsg(s, '削除できませんでした: ' + (s.err || ''));
    } else {
      try { await CasesApi.removeRequestFile(p, true); } catch (e) { console.warn('写真ファイルの削除に失敗', e); }
      photoMsg(s, '');
    }
    s.photoBusy = false;
    fillPhotos(s);
  }

  /* ---- 自動保存 ---- */
  function changed(s) {
    s.dirty = true;
    setState(s, 'pending');
    clearTimeout(s.timer);
    s.timer = setTimeout(() => flush(s), DELAY);
  }
  function flush(s) {
    clearTimeout(s.timer);
    s.timer = null;
    s.chain = s.chain.then(() => doSave(s)).catch(e => {
      s.dirty = true;
      s.err = errText(e);
      setState(s, 'error');
    });
    return s.chain;
  }
  function flushAll() { sessions.forEach(s => { if (s.dirty || s.timer) flush(s); }); }
  async function doSave(s) {
    if (!s.dirty) return;
    const val = JSON.parse(JSON.stringify(s.v));
    s.dirty = false;
    s.saving = true;
    setState(s, 'saving');
    let row = null, msg = '';
    try { row = await CasesApi.saveRequest(s.caseId, val); }
    catch (e) { msg = errText(e); }
    s.saving = false;
    if (msg) { s.dirty = true; s.err = msg; setState(s, 'error'); return; }
    s.serverJson = json(row.request);
    s.lastSaved = new Date();
    const c = typeof currentCase !== 'undefined' && currentCase && currentCase.id === s.caseId ? currentCase : null;
    if (c) c.request = row.request;
    s.mailNote = '';
    // 担当者への確認依頼メールの下書き（未送信）の「■ 依頼内容」を直す
    if (c && typeof PhasesApi !== 'undefined' && PhasesApi.syncStaffNoticeDrafts) {
      try {
        const n = await PhasesApi.syncStaffNoticeDrafts(c, typeof caseMembers !== 'undefined' ? caseMembers : []);
        if (n) s.mailNote = '（担当者へのメールの下書きにも反映しました）';
      } catch (e) { console.warn('担当者へのメールの下書きを直せませんでした', e); }
    }
    setState(s, s.dirty ? 'pending' : 'saved');
  }
  function setState(s, state) {
    s.state = state;
    const el = s.els.save;
    if (!el || !el.isConnected) return;
    s.els.retry.hidden = state !== 'error';
    el.className = 'rep-save rq-save' + (state === 'saved' ? '' : state === 'error' ? ' err' : ' busy');
    el.dataset.state = state;
    if (state === 'pending') el.textContent = '保存待ち…';
    else if (state === 'saving') el.textContent = '保存中…';
    else if (state === 'saved') el.textContent = '自動保存 ' + PhaseLogic.fmtMDHM(s.lastSaved || new Date()).split(' ')[1] + (s.mailNote || '');
    else if (state === 'error') el.textContent = '保存できませんでした: ' + (s.err || '');
    else el.textContent = '';
  }
  // 保存待ちがあるか（画面を離れる前の確認用）
  const pending = caseId => { const s = sessions.get(caseId); return !!(s && (s.dirty || s.timer || s.saving || s.photoBusy)); };

  window.addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });
  return { section, refresh, flushAll, pending, itemsPicker };
})();
