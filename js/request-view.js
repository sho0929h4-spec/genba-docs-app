// js/request-view.js — 案件の「依頼内容」の表示（読むだけ）・写真の拡大・「到着が遅れそう」のシートと入居者の電話（Task 28 / migration 052）
// 社内の画面（index.html: 案件ページ・現場用のツールページ）と担当者URLのページ（r.html）で共通に使う。
// 中身の整形は PhaseLogic（js/phase-logic.js の normalizeRequest / requestItems / lateLabel / parseLateMinutes）。
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。alert/confirm は使わない。
// 入力のあるシート（到着が遅れそう）は外側クリック・Esc で閉じない（× とキャンセルだけ）。入力の無い写真の拡大は Esc・外側でも閉じる
const RequestView = (() => {
  const L = () => window.PhaseLogic;
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const btn = (text, cls, onClick) => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', () => onClick(b));
    return b;
  };
  const FOLD_CHARS = 90; // これより長い・3行より多い文は3行で折りたたむ（「もっと見る」）

  // 文（3行で折りたたみ）
  function foldText(text, cls) {
    const wrap = el('div', 'rq-fold');
    const t = el('div', 'rq-t ' + (cls || ''), text);
    wrap.appendChild(t);
    if (text.split('\n').length > 3 || text.length > FOLD_CHARS) {
      t.classList.add('clamp');
      const more = btn('もっと見る', 'rq-more', b => {
        const open = t.classList.toggle('clamp') === false;
        b.textContent = open ? '閉じる' : 'もっと見る';
        b.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      more.setAttribute('aria-expanded', 'false');
      wrap.appendChild(more);
    }
    return wrap;
  }

  // 写真のサムネイル（横並び）。押すと拡大。photoUrl(path) → Promise<url>
  function thumbs(photos, photoUrl) {
    const row = el('div', 'rq-thumbs');
    const urls = new Map();
    const getUrl = p => {
      if (!urls.has(p.path)) urls.set(p.path, Promise.resolve().then(() => photoUrl(p.path)));
      return urls.get(p.path);
    };
    photos.forEach((p, i) => {
      const b = btn('', 'rq-thumb', () => openViewer(photos, i, getUrl));
      b.setAttribute('aria-label', '写真' + (i + 1) + 'を拡大' + (p.caption ? '（' + p.caption + '）' : ''));
      b.dataset.path = p.path;
      const im = el('img');
      im.alt = p.caption || '写真' + (i + 1);
      im.loading = 'lazy';
      getUrl(p).then(u => { if (u) im.src = u; }, () => { b.classList.add('none'); im.alt = '写真を開けませんでした'; });
      b.appendChild(im);
      row.appendChild(b);
    });
    return row;
  }

  // 依頼内容の区画（読むだけ）。空なら null
  //   o: { photoUrl(path) → Promise<url>, title（見出し。空なら出さない）, id, cls,
  //        plain（Task 63: 項目ごとの折りたたみ・写真を出さない。募集のカード・タスクの詳細） }
  function build(raw, o) {
    const opt = o || {};
    const PL = L();
    if (opt.plain ? !PL.requestItems(raw).length : !PL.hasRequest(raw)) return null;
    const r = PL.normalizeRequest(raw);
    const box = el('div', 'rq-view' + (opt.cls ? ' ' + opt.cls : ''));
    if (opt.id) box.id = opt.id;
    if (opt.title) box.appendChild(el('b', 'rq-title', opt.title));
    PL.requestItems(r).forEach(it => {
      const row = el('div', 'rq-row');
      row.dataset.key = it.key;
      if (it.key !== 'text') row.appendChild(el('div', 'rq-k', it.label));
      // Task 66: 「養生対応（入居者確認必要）」は目立つ印（作業担当者が当日 入居者に確かめる）
      if (it.key === 'items' && PL.needsTenantCheck(r)) {
        const m = el('span', 'rq-mark', '入居者に確認');
        m.title = '養生対応は入居者に確認が必要です';
        row.firstChild.append(' ', m);
      }
      if (it.key === 'symptoms') {
        const chips = el('div', 'rq-chips');
        PL.REQUEST_SYMPTOMS.filter(x => r.symptoms.includes(x.key)).forEach(x => {
          chips.appendChild(el('span', 'rq-chip', x.key === 'other' && String(r.symptomOther).trim() ? 'その他（' + String(r.symptomOther).trim() + '）' : x.label));
        });
        row.appendChild(chips);
      } else row.appendChild(opt.plain ? el('div', 'rq-t' + (it.key === 'text' ? ' main' : ''), it.text) : foldText(it.text, it.key === 'text' ? 'main' : ''));
      box.appendChild(row);
    });
    if (r.photos.length && !opt.plain) {
      const row = el('div', 'rq-row');
      row.dataset.key = 'photos';
      row.appendChild(el('div', 'rq-k', '事前に共有された写真（' + r.photos.length + '枚・押すと拡大）'));
      row.appendChild(thumbs(r.photos, opt.photoUrl || (() => Promise.resolve(''))));
      box.appendChild(row);
    }
    return box;
  }

  // Task 33: 「📋 依頼内容」の一番上の、訪問する号室ごとの1行（PhaseLogic.visitTaskRows）＋当日の注意
  //   402号室（加害部屋）→ 原因調査・耐圧テスト
  //     怪しい箇所: 給湯給水系統／補足: 浴室の下を先に（小さく）
  //   当日の注意: …
  //   o: { id }
  function visitRows(plan, caseRow, kind, o) {
    const v = L().visitTaskRows(plan, caseRow, kind);
    const box = el('div', 'rq-visit');
    if (o && o.id) box.id = o.id;
    v.rows.forEach(r => {
      const row = el('div', 'rq-vrow' + (r.extra ? ' extra' : ''));
      row.dataset.room = r.room;
      row.dataset.from = r.mustFrom;
      // 号室（太字）＋役割の小さなタグ（加害部屋／被害部屋／その他。既存の .rm-tag）＋「→ 必要な対応」
      const head = el('div', 'rq-vhead');
      head.appendChild(el('b', 'rq-vroom', r.name));
      if (r.roleText) {
        const tag = el('span', 'rm-tag ' + (r.role || 'other'), r.roleText);
        head.appendChild(document.createTextNode(' '));
        head.appendChild(tag);
      }
      head.appendChild(document.createTextNode(' '));
      head.appendChild(el('span', 'rq-vmust', '→ ' + r.must));
      row.appendChild(head);
      if (r.extra) row.appendChild(el('div', 'rq-vsub', '今回行く部屋には入っていません'));
      if (r.sub) row.appendChild(el('div', 'rq-vsub', r.sub));
      box.appendChild(row);
    });
    if (v.note) {
      const n = el('div', 'rq-vnote');
      n.appendChild(el('b', null, '当日の注意: '));
      n.appendChild(document.createTextNode(v.note));
      box.appendChild(n);
    }
    return box;
  }

  /* ---------- 写真の拡大 ---------- */
  function openViewer(photos, index, getUrl) {
    const prev = document.getElementById('pv-bg');
    if (prev) prev.remove();
    const opener = document.activeElement;
    let i = index;
    const bg = el('div', 'pv-bg');
    bg.id = 'pv-bg';
    bg.setAttribute('role', 'dialog');
    bg.setAttribute('aria-modal', 'true');
    bg.setAttribute('aria-label', '写真の拡大');
    const img = el('img', 'pv-img');
    const cap = el('div', 'pv-cap');
    const count = el('span', 'pv-n');
    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      bg.remove();
      if (opener && opener.isConnected) opener.focus();
    };
    const show = () => {
      const p = photos[i];
      img.removeAttribute('src');
      img.alt = p.caption || '写真' + (i + 1);
      getUrl(p).then(u => { if (photos[i] === p && u) img.src = u; }, () => { img.alt = '写真を開けませんでした'; });
      cap.textContent = p.caption || '';
      cap.hidden = !p.caption;
      count.textContent = (i + 1) + ' / ' + photos.length;
      prevB.disabled = i === 0;
      nextB.disabled = i === photos.length - 1;
    };
    const x = btn('×', 'pv-x', close);
    x.setAttribute('aria-label', '閉じる');
    const prevB = btn('‹', 'pv-nav prev', () => { if (i > 0) { i--; show(); } });
    prevB.setAttribute('aria-label', '前の写真');
    const nextB = btn('›', 'pv-nav next', () => { if (i < photos.length - 1) { i++; show(); } });
    nextB.setAttribute('aria-label', '次の写真');
    const top = el('div', 'pv-top');
    top.append(count, x);
    const mid = el('div', 'pv-mid');
    mid.append(prevB, img, nextB);
    bg.append(top, mid, cap);
    if (photos.length < 2) { prevB.hidden = true; nextB.hidden = true; count.hidden = true; }
    bg.addEventListener('click', e => { if (e.target === bg || e.target === mid) close(); });
    const onKey = e => {
      if (!bg.isConnected) { document.removeEventListener('keydown', onKey, true); return; }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowLeft') prevB.click();
      else if (e.key === 'ArrowRight') nextB.click();
    };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(bg);
    show();
    x.focus();
  }

  /* ---------- 到着が遅れそう ---------- */
  const LATE_BTN = '到着が遅れそう（押すと管理者に報告し、入居者の電話番号が出ます）';

  // 入居者の電話（報告後）または「到着が遅れそう」のボタン
  //   o: { residents: [{ label, name, tel }], late: late_at（あれば電話を出す）, onLate()（ボタンを押したとき）, disabled, id, note,
  //        own（Task 37: 自分で登録した案件。遅れの報告なしで最初から電話を出す） }
  function residentsBox(o) {
    const box = el('div', 'lt-box');
    if (o.id) box.id = o.id;
    if (o.late || o.own) {
      const list = (o.residents || []).filter(x => x.tel || x.name);
      const head = el('div', 'lt-done', o.late
        ? '到着の遅れを報告しました' + (o.lateText ? '（' + o.lateText + '）' : '') + '。入居者の電話:'
        : '入居者の連絡先（自分で登録した案件）:');
      box.appendChild(head);
      if (!list.length) box.appendChild(el('div', 'lt-none', '入居者の電話番号は登録されていません'));
      list.forEach(x => {
        const who = [x.label, x.name ? x.name + '様' : ''].filter(Boolean).join(' ');
        if (x.email && !x.tel) {
          const a = Icon.prepend(el('a', 'lt-tel', (who ? who + ' ' : '') + x.email), 'mail');
          a.href = 'mailto:' + x.email;
          box.appendChild(a);
        } else if (x.tel) {
          const a = Icon.prepend(el('a', 'lt-tel', (who ? who + ' ' : '') + x.tel), 'phone');
          a.href = 'tel:' + String(x.tel).replace(/[^0-9+]/g, '');
          box.appendChild(a);
        } else box.appendChild(el('div', 'lt-none', who + '（電話番号なし）'));
      });
      return box;
    }
    const b = btn(LATE_BTN, 'lt-btn', () => { if (o.onLate) o.onLate(b); });
    Icon.prepend(b, 'clock');
    b.disabled = !!o.disabled;
    box.appendChild(b);
    if (o.note) box.appendChild(el('div', 'lt-none', o.note));
    return box;
  }

  // シート: 遅れる見込み（15分／30分／1時間／その他（入力））と一言（任意）→「報告する」
  //   o: { title（どの対応か）, onSubmit: async (minutes, note) => result（失敗は throw）, onDone(result) }
  function openLateSheet(o) {
    const prev = document.getElementById('lt-sheet');
    if (prev) prev.remove();
    const PL = L();
    const opener = document.activeElement;
    const st = { busy: false, minutes: null, other: false };
    const bg = el('div', 'lt-bg');
    bg.id = 'lt-sheet';
    const dlg = el('div', 'lt-sheet');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'lt-sheet-title');
    const close = () => { if (st.busy) return; bg.remove(); if (opener && opener.isConnected) opener.focus(); };
    const hd = el('div', 'lt-hd');
    const h = el('h3', null, '到着が遅れそう');
    h.id = 'lt-sheet-title';
    const x = btn('×', 'lt-x', close);
    x.setAttribute('aria-label', '閉じる');
    hd.append(h, x);
    dlg.appendChild(hd);
    dlg.appendChild(el('div', 'lt-sub', (o.title ? o.title + '。' : '') + '報告すると管理者に届き、このあと入居者の電話番号が表示されます。'));
    dlg.appendChild(el('div', 'lt-label', '遅れる見込み'));
    const chips = el('div', 'lt-chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', '遅れる見込み');
    const other = el('input', 'lt-other');
    other.type = 'text';
    other.id = 'lt-other';
    other.maxLength = 10;
    other.autocomplete = 'off';
    other.placeholder = '例: 45（分）・1時間半';
    other.setAttribute('aria-label', '遅れる見込み（その他）');
    const otherWrap = el('label', 'lt-f', 'その他（分 か「1時間半」のように）');
    otherWrap.appendChild(other);
    otherWrap.hidden = true;
    const sync = () => {
      chips.querySelectorAll('button').forEach(b => {
        const on = b.dataset.minutes === 'other' ? st.other : !st.other && String(st.minutes) === b.dataset.minutes;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      otherWrap.hidden = !st.other;
    };
    PL.LATE_CHOICES.forEach(c => {
      const b = btn(c.label, 'lt-chip', () => { st.minutes = c.minutes; st.other = false; err.textContent = ''; sync(); });
      b.dataset.minutes = String(c.minutes);
      chips.appendChild(b);
    });
    const ob = btn('その他', 'lt-chip', () => { st.other = true; err.textContent = ''; sync(); other.focus(); });
    ob.dataset.minutes = 'other';
    chips.appendChild(ob);
    dlg.appendChild(chips);
    dlg.appendChild(otherWrap);
    const note = el('input', 'lt-note');
    note.type = 'text';
    note.id = 'lt-note';
    note.maxLength = 200;
    note.autocomplete = 'off';
    note.placeholder = '例: 渋滞しています';
    const nl = el('label', 'lt-f', '一言（任意）');
    nl.appendChild(note);
    dlg.appendChild(nl);
    const err = el('div', 'lt-err');
    err.id = 'lt-err';
    err.setAttribute('role', 'alert');
    dlg.appendChild(err);
    const acts = el('div', 'lt-acts');
    const cancel = btn('キャンセル', 'lt-cancel', close);
    const send = btn('報告する', 'lt-send', async () => {
      if (st.busy) return;
      const minutes = st.other ? PL.parseLateMinutes(other.value) : st.minutes;
      if (!minutes) {
        err.textContent = st.other ? '遅れる見込みを 1〜600 分で入れてください（例: 45・1時間半）' : '遅れる見込みを選んでください';
        return;
      }
      st.busy = true;
      err.textContent = '';
      const all = [x, cancel, send, other, note, ...chips.querySelectorAll('button')];
      all.forEach(e => { e.disabled = true; });
      send.textContent = '報告しています…';
      let res = null, e2 = '';
      try { res = await o.onSubmit(minutes, note.value.trim()); }
      catch (e) { e2 = '報告できませんでした: ' + (e && e.message ? e.message : String(e)); }
      st.busy = false;
      if (e2) {
        err.textContent = e2;
        all.forEach(e => { e.disabled = false; });
        send.textContent = '報告する';
        return;
      }
      bg.remove();
      if (typeof o.onDone === 'function') o.onDone(res, minutes);
    });
    acts.append(cancel, send);
    dlg.appendChild(acts);
    bg.appendChild(dlg);
    document.body.appendChild(bg);
    sync();
    const first = chips.querySelector('button');
    if (first) first.focus();
  }

  return { build, visitRows, thumbs, openViewer, residentsBox, openLateSheet, LATE_BTN };
})();
