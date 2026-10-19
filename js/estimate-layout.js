// js/estimate-layout.js — 見積書の編集画面（⑭ #estimate/{id}）の並び（Task 15。旧「見積書作成ツール」と同じ2段組み）
//   PC（幅1100px以上）: 上のバー（← 見積書一覧・自動保存・PDFプレビュー・提出する）
//                       ＋ 左 520px の入力パネル（縦スクロール）＋ 右 紙面プレビュー（A4 を縮小。ページが複数なら縦に並べる）
//   スマホ（1100px未満）: 1段。入力の下に「紙面プレビュー」の折りたたみ（開いたときだけ描く）。下部バー（合計・ボタン）は今のまま
// 紙面は EstimatePdf.buildPages（PDF と同じ描画）を使う。入力から 300ms で描き直す（estimate-ui の eueChanged → changed）。
// 「PDFプレビュー」「提出する」のボタン（#eu-btns）は1組だけ。PC では上のバーへ、スマホでは下部バーへ動かす
//   （estimate-root を描き直す前に rescue で下部バーへ戻す。ボタンの onclick は estimate-ui が付ける）。
// 明細の並び替え（dragHandle）: ⠿ をドラッグ（マウス・指どちらも。pointer events）、または ⠿ にフォーカスして ↑↓ キー。
// ユーザー入力は createElement + textContent で描く（innerHTML は使わない）。mk は case-list.js のものを使う。
const EstimateLayout = (() => {
  const PC_QUERY = '(min-width:1100px)';
  const A4_W = 793.7, A4_H = 1122.5; // 595.28pt × 841.89pt を px に
  const DELAY = 300;
  const mq = window.matchMedia(PC_QUERY);
  let cur = null;        // { s, root, slot, left, pv, body, pages, toggle, timer, stale }
  let logo = { path: '', url: '', p: null };
  let resizeTimer = null;

  const isPc = () => mq.matches;
  const org = () => (typeof ctx !== 'undefined' && ctx && ctx.org) || {};
  const btns = () => document.getElementById('eu-btns');
  const bar = () => document.getElementById('estimate-bar');

  // ボタン（PDFプレビュー・提出する）を下部バーへ戻す。estimate-root を描き直す前に必ず呼ぶ
  function rescue() {
    const b = btns(), br = bar();
    if (b && br && b.parentNode !== br) br.appendChild(b);
  }
  function placeButtons() {
    const b = btns();
    if (!b || !cur) return;
    if (isPc()) { if (b.parentNode !== cur.slot) cur.slot.appendChild(b); }
    else rescue();
  }

  /* ---------- 組み立て ---------- */
  // top: 上の行（← 見積書一覧・自動保存）。left: 入力パネルの中身（上から順に）
  function mount(s, top, left) {
    rescue();
    const root = document.getElementById('estimate-root');
    top.classList.add('eu-topbar');
    const slot = mk('div', 'eu-top-slot');
    top.appendChild(slot);

    const lp = mk('div', 'eu-left');
    lp.id = 'eu-left';
    lp.append(...left);

    const pv = mk('section', 'eu-pv' + (s.pvOpen ? ' open' : ''));
    pv.id = 'eu-pv';
    pv.setAttribute('aria-label', '紙面プレビュー');
    const toggle = mk('button', 'eu-pv-toggle');
    toggle.type = 'button';
    toggle.id = 'eu-pv-toggle';
    toggle.setAttribute('aria-controls', 'eu-pv-body');
    toggle.setAttribute('aria-expanded', s.pvOpen ? 'true' : 'false');
    const tl = mk('span', null, '紙面プレビュー');
    const ts = mk('span', 'eu-pv-state', s.pvOpen ? '閉じる ▲' : '開く ▼');
    toggle.append(tl, ts);
    const body = mk('div', 'eu-pv-body');
    body.id = 'eu-pv-body';
    const h = mk('div', 'eu-pv-h', s.readOnly ? '紙面プレビュー（PDFと同じ並び）' : '紙面プレビュー（PDFと同じ並び。入力すると自動で変わります）');
    const msg = mk('div', 'err');
    msg.id = 'eu-pv-msg';
    const pages = mk('div', 'eu-pv-pages');
    pages.id = 'eu-paper';
    body.append(h, msg, pages);
    pv.append(toggle, body);

    const split = mk('div', 'eu-split');
    split.append(lp, pv);
    root.replaceChildren(top, split);
    root.classList.add('eu-split-on');

    if (cur) clearTimeout(cur.timer);
    cur = { s, root, slot, left: lp, pv, body, pages, msg, toggle, toggleState: ts, timer: null, stale: true };
    const me = cur;
    toggle.addEventListener('click', () => {
      s.pvOpen = !s.pvOpen;
      pv.classList.toggle('open', s.pvOpen);
      toggle.setAttribute('aria-expanded', s.pvOpen ? 'true' : 'false');
      ts.textContent = s.pvOpen ? '閉じる ▲' : '開く ▼';
      if (s.pvOpen && cur === me) render();
    });
    placeButtons();
    loadLogo(); // 紙面は estimate-ui が入力欄を作り終えてから render を呼ぶ
  }

  // 画面を離れる・メッセージに置き換える前
  function unmount() {
    rescue();
    if (cur) clearTimeout(cur.timer);
    cur = null;
    const root = document.getElementById('estimate-root');
    if (root) root.classList.remove('eu-split-on');
  }

  /* ---------- 紙面 ---------- */
  const visible = c => !!(c && c.pages.isConnected && c.body.offsetParent !== null);

  function loadLogo() {
    const path = org().logo_path || '';
    if (!path) { logo = { path: '', url: '', p: null }; return; }
    if (logo.path === path && (logo.url || logo.p)) return;
    const p = Promise.resolve().then(() => AppStorage.getUrl(path)).catch(() => '');
    logo = { path, url: '', p };
    p.then(url => {
      if (logo.p !== p) return;
      logo.url = url || '';
      logo.p = null;
      if (url && cur) render();
    });
  }

  function estOf(s) {
    return { data: s.data, lines: s.lines, number: s.row.number, version: s.row.version, status: s.row.status };
  }

  function render() {
    const c = cur;
    if (!c) return;
    clearTimeout(c.timer);
    c.timer = null;
    if (!visible(c)) { c.stale = true; return; }
    c.stale = false;
    let pages;
    try {
      pages = EstimatePdf.buildPages(estOf(c.s), c.s.caseRow, org(), logo.url);
    } catch (e) {
      c.msg.textContent = '紙面を描けませんでした: ' + (e && e.message ? e.message : String(e));
      return;
    }
    c.msg.textContent = '';
    const sheets = pages.map(p => {
      const w = mk('div', 'eu-sheet');
      w.dataset.page = p.dataset.page || '';
      w.appendChild(p);
      return w;
    });
    c.pages.replaceChildren(...sheets);
    EstimatePdf.fitText(c.pages);
    fit();
  }

  // 幅に合わせて縮小（拡大はしない）。外枠の大きさも縮めて、ページを縦に詰めて並べる
  function fit() {
    const c = cur;
    if (!visible(c)) return;
    const cs = getComputedStyle(c.pages);
    const avail = c.pages.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const r = Math.max(0.1, Math.min(1, avail / A4_W));
    c.pages.querySelectorAll('.eu-sheet').forEach(w => {
      w.style.width = (A4_W * r) + 'px';
      w.style.height = (A4_H * r) + 'px';
      const p = w.firstElementChild;
      if (p) { p.style.transformOrigin = 'top left'; p.style.transform = 'scale(' + r + ')'; }
    });
    c.pages.dataset.scale = String(Math.round(r * 1000) / 1000);
  }

  // 入力が変わった（estimate-ui の eueChanged から）。300ms 待ってから描き直す
  function changed(s) {
    const c = cur;
    if (!c || c.s !== s) return;
    clearTimeout(c.timer);
    c.timer = setTimeout(render, DELAY);
  }

  // 提出の後など: 入力パネルを先頭へ
  function scrollTop() {
    if (cur && cur.left) cur.left.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  mq.addEventListener('change', () => {
    if (!cur) return;
    placeButtons();
    if (cur.stale || visible(cur)) render();
  });
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (cur && visible(cur)) { if (cur.stale) render(); else fit(); } }, 120);
  });

  /* ---------- 明細の並び替え（⠿） ---------- */
  // btn: ⠿ のボタン。list: 明細の入れ物。row: この行。onDrop(k): 動かせる行の中で k 番目へ。onKey(dir): ↑↓ キー
  function dragHandle(btn, list, row, onDrop, onKey) {
    btn.addEventListener('keydown', e => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      onKey(e.key === 'ArrowUp' ? -1 : 1);
    });
    btn.addEventListener('pointerdown', e => {
      if (btn.disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      const others = Array.from(list.querySelectorAll('.eu-ln[data-drag="1"]')).filter(r => r !== row);
      const from = Array.from(list.querySelectorAll('.eu-ln[data-drag="1"]')).indexOf(row);
      const scroller = list.closest('.eu-left');
      const st = { k: from, moved: false, y0: e.clientY };
      try { btn.setPointerCapture(e.pointerId); } catch (err) { /* 古いブラウザ */ }
      row.classList.add('row-dragging');
      const clear = () => others.forEach(r => r.classList.remove('drop-before', 'drop-after'));
      const move = ev => {
        if (Math.abs(ev.clientY - st.y0) > 4) st.moved = true;
        if (!st.moved) return;
        if (scroller && getComputedStyle(scroller).overflowY === 'auto') {
          const b = scroller.getBoundingClientRect();
          if (ev.clientY < b.top + 48) scroller.scrollTop -= 14;
          else if (ev.clientY > b.bottom - 48) scroller.scrollTop += 14;
        }
        let k = 0;
        others.forEach(r => { const b = r.getBoundingClientRect(); if (b.top + b.height / 2 < ev.clientY) k++; });
        st.k = k;
        clear();
        if (k < others.length) others[k].classList.add('drop-before');
        else if (others.length) others[others.length - 1].classList.add('drop-after');
      };
      const end = ev => {
        btn.removeEventListener('pointermove', move);
        btn.removeEventListener('pointerup', end);
        btn.removeEventListener('pointercancel', end);
        try { btn.releasePointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
        clear();
        row.classList.remove('row-dragging');
        if (ev.type === 'pointerup' && st.moved && st.k !== from) onDrop(st.k);
      };
      btn.addEventListener('pointermove', move);
      btn.addEventListener('pointerup', end);
      btn.addEventListener('pointercancel', end);
    });
  }

  return { mount, unmount, rescue, changed, render, fit, scrollTop, dragHandle, isPc, PC_QUERY };
})();
