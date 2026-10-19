// js/photo-mark-editor.js — 写真に印（赤丸・矢印・コメント）を付ける全画面の編集シート（Task 14）
// 報告書の入力画面（report-edit.js）と協力業者ページ（r.html / vendor.js）で共有する。社内アプリの関数は使わない。
// 依存: PhotoMarks（js/photo-marks.js）
//
//   PhotoMarkEditor.open({ src, marks, title, onSave: async marks => {...} })
//     src    … 写真の URL（署名URL / blob URL / data URL）
//     marks  … 今の印（PhotoMarks.normalize してから編集する）
//     onSave … 「保存」で正規化済みの marks を渡す。throw したらシートに理由を出して閉じない
//
// 規則: 外側クリック・Esc では閉じない（× とキャンセルだけ。変更があれば画面内で確かめる）。alert / confirm を使わない。
//       描画は createElement + textContent（innerHTML を使わない）。入力欄 16px、押す所 36px 以上。
//       操作は Pointer Events（マウスも指も同じ）。canvas は touch-action:none でスクロールさせない。
const PhotoMarkEditor = (() => {
  'use strict';
  const PM = () => window.PhotoMarks;
  const DRAG_PX = 6;   // これ以上動いたらドラッグ（それ未満はタップ）
  const TOOLS = {
    circle: { icon: '⭕', label: '丸', hint: '囲みたい所をなぞる（ドラッグ）と丸になります。タップでも丸を置けます' },
    arrow: { icon: '➡', label: '矢印', hint: '始点から先端へなぞる（ドラッグ）と矢印になります' },
    text: { icon: 'T', label: 'コメント', hint: 'コメントを置きたい所をタップして、文字を入れてください（40字まで）' }
  };

  const CSS = `
.pme{position:fixed;inset:0;z-index:2000;background:#0f172a;color:#fff;display:flex;flex-direction:column;
  padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);
  font-family:'Noto Sans JP','Hiragino Kaku Gothic ProN',sans-serif;-webkit-user-select:none;user-select:none;}
.pme *{box-sizing:border-box;}
.pme [hidden]{display:none !important;}
.pme-hd{display:flex;align-items:center;gap:8px;padding:8px 12px;min-width:0;}
.pme-hd h2{flex:1;min-width:0;font-size:15px;font-weight:700;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pme button{font-family:inherit;cursor:pointer;}
.pme-x{width:44px;height:44px;border:0;border-radius:10px;background:rgba(255,255,255,.12);color:#fff;font-size:22px;line-height:1;flex:none;}
.pme-tools{display:flex;gap:6px;padding:0 12px 6px;flex-wrap:wrap;}
.pme-tool{min-width:44px;min-height:44px;padding:0 10px;border:1.5px solid rgba(255,255,255,.35);border-radius:10px;background:transparent;color:#fff;font-size:14px;font-weight:700;display:inline-flex;align-items:center;gap:4px;}
.pme-tool .pme-ic{font-size:18px;line-height:1;}
.pme-tool[aria-pressed="true"]{background:#fff;color:#c00018;border-color:#fff;}
.pme-tool:disabled{opacity:.35;cursor:default;}
.pme-tool.pme-del{border-color:#ff8a8a;color:#ffb3b3;}
.pme-sep{flex:1;}
.pme-hint{padding:0 12px 6px;font-size:12px;color:#cbd5e1;min-height:18px;overflow-wrap:anywhere;}
.pme-stage{flex:1;min-height:0;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:4px 8px;}
.pme-cv{display:block;touch-action:none;background:#334155;max-width:100%;max-height:100%;cursor:crosshair;}
.pme-load{color:#cbd5e1;font-size:13px;}
.pme-txt{position:absolute;display:flex;gap:6px;align-items:center;background:#fff;border:2px solid #e0001b;border-radius:10px;padding:6px;box-shadow:0 6px 20px rgba(0,0,0,.35);width:min(360px,calc(100% - 16px));}
.pme-txt input{flex:1;min-width:0;font-size:16px;padding:8px 10px;border:1.5px solid #cbd5e1;border-radius:8px;color:#1e293b;background:#fff;font-family:inherit;-webkit-user-select:text;user-select:text;}
.pme-txt button{min-height:40px;min-width:44px;padding:0 10px;border:0;border-radius:8px;font-size:14px;font-weight:700;}
.pme-txt .pme-ok{background:#e0001b;color:#fff;}
.pme-txt .pme-no{background:#e2e8f0;color:#1e293b;}
.pme-ft{display:flex;align-items:center;gap:8px;padding:8px 12px 10px;flex-wrap:wrap;}
.pme-msg{flex:1;min-width:160px;font-size:13px;color:#cbd5e1;overflow-wrap:anywhere;}
.pme-msg.err{color:#ffb3b3;font-weight:700;}
.pme-btn{min-height:44px;padding:0 18px;border-radius:10px;font-size:15px;font-weight:700;border:1.5px solid #fff;background:transparent;color:#fff;}
.pme-btn.pri{background:#e0001b;border-color:#e0001b;}
.pme-btn:disabled{opacity:.5;cursor:default;}
.pme-ask{display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%;background:#fff;color:#1e293b;border-radius:10px;padding:8px 10px;}
.pme-ask span{flex:1;min-width:160px;font-size:13px;font-weight:700;}
.pme-ask .pme-btn{border-color:#1a3a5c;color:#1a3a5c;min-height:40px;font-size:14px;}
.pme-ask .pme-btn.pri{color:#fff;}
/* 写真の一覧（報告書の入力・協力業者ページ）: サムネイルの下の「印を付ける」 */
.rep-ph-t{display:flex;flex-direction:column;gap:4px;min-width:0;}
.rep-ph-t .rep-ph-img.pme-open{cursor:pointer;}
.rep-ph-mark{min-height:36px;width:100%;padding:0 4px;border:1.5px solid #e0001b;border-radius:8px;background:#fff;color:#c00018;font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:inherit;cursor:pointer;}
.rep-ph-mark.has{background:#fdecea;}
.rep-ph-mark:disabled{opacity:.45;cursor:default;}
@media(max-width:560px){.rep-ph-mark{font-size:11px;padding:0 2px;} .pme-tool{padding:0 8px;} .pme-tool .pme-lb{display:none;}}
`;
  function injectCss() {
    if (document.getElementById('pme-style')) return;
    const s = document.createElement('style');
    s.id = 'pme-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const btn = (cls, text, id, onClick) => {
    const b = mk('button', cls, text);
    b.type = 'button';
    if (id) b.id = id;
    if (onClick) b.addEventListener('click', onClick);
    return b;
  };

  let cur = null; // 開いているシート

  function open(opts) {
    injectCss();
    if (cur) cur.close();
    const o = opts || {};
    const st = {
      marks: PM().normalize(o.marks), orig: '', history: [], tool: 'circle', selected: -1,
      img: null, drag: null, saving: false, textAt: null, closed: false
    };
    st.orig = JSON.stringify(st.marks);
    const changed = () => JSON.stringify(st.marks) !== st.orig;
    const opener = document.activeElement;

    /* ---------- 組み立て ---------- */
    const root = mk('div', 'pme');
    root.id = 'pme';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    const hd = mk('div', 'pme-hd');
    const h = mk('h2', null, o.title || '写真に印を付ける');
    h.id = 'pme-title';
    root.setAttribute('aria-labelledby', h.id);
    const x = btn('pme-x', '×', 'pme-close', () => askClose());
    x.setAttribute('aria-label', '閉じる');
    hd.append(h, x);

    const tools = mk('div', 'pme-tools');
    tools.setAttribute('role', 'toolbar');
    tools.setAttribute('aria-label', '印の道具');
    const toolBtns = {};
    Object.keys(TOOLS).forEach(k => {
      const t = TOOLS[k];
      const b = btn('pme-tool', null, 'pme-tool-' + k, () => setTool(k));
      b.append(mk('span', 'pme-ic', t.icon), mk('span', 'pme-lb', t.label));
      b.setAttribute('aria-label', t.label);
      toolBtns[k] = b;
      tools.appendChild(b);
    });
    tools.appendChild(mk('span', 'pme-sep'));
    const undoB = btn('pme-tool', null, 'pme-undo', () => undo());
    undoB.append(mk('span', 'pme-ic', '↩'), mk('span', 'pme-lb', '1つ戻す'));
    undoB.setAttribute('aria-label', '1つ戻す');
    const delB = btn('pme-tool pme-del', null, 'pme-del', () => delSelected());
    delB.append(mk('span', 'pme-ic', '✕'), mk('span', 'pme-lb', 'この印を消す'));
    delB.setAttribute('aria-label', '選んだ印を消す');
    const clearB = btn('pme-tool', null, 'pme-clear', () => clearAll());
    clearB.append(mk('span', 'pme-ic', '🗑'), mk('span', 'pme-lb', '全部消す'));
    clearB.setAttribute('aria-label', '全部消す');
    tools.append(undoB, delB, clearB);

    const hint = mk('div', 'pme-hint');
    hint.id = 'pme-hint';
    hint.setAttribute('aria-live', 'polite');

    const stage = mk('div', 'pme-stage');
    const loading = mk('div', 'pme-load', '写真を読み込み中…');
    const cv = document.createElement('canvas');
    cv.className = 'pme-cv';
    cv.id = 'pme-canvas';
    cv.setAttribute('aria-label', '写真（印を付ける場所）');
    cv.hidden = true;
    stage.append(loading, cv);

    const ft = mk('div', 'pme-ft');
    const msg = mk('div', 'pme-msg');
    msg.id = 'pme-msg';
    msg.setAttribute('role', 'status');
    const cancel = btn('pme-btn', 'キャンセル', 'pme-cancel', () => askClose());
    const save = btn('pme-btn pri', '保存', 'pme-save', () => doSave());
    ft.append(msg, cancel, save);

    root.append(hd, tools, hint, stage, ft);

    /* ---------- 表示 ---------- */
    const setMsg = (t, err) => { msg.textContent = t || ''; msg.classList.toggle('err', !!err); };
    function sync() {
      Object.keys(toolBtns).forEach(k => toolBtns[k].setAttribute('aria-pressed', st.tool === k ? 'true' : 'false'));
      undoB.disabled = st.saving || !st.history.length;
      clearB.disabled = st.saving || !st.marks.length;
      delB.hidden = st.selected < 0;
      Object.values(toolBtns).forEach(b => { b.disabled = st.saving; });
      save.disabled = st.saving || !st.img;
      cancel.disabled = st.saving;
      x.disabled = st.saving;
      cv.dataset.count = String(st.marks.length);
      cv.dataset.types = st.marks.map(m => m.type).join(',');
    }
    function setTool(k) {
      st.tool = k;
      st.selected = -1;
      closeText();
      hint.textContent = TOOLS[k].hint;
      sync();
      draw();
    }
    function layout() {
      if (!st.img) return;
      const nw = st.img.naturalWidth, nh = st.img.naturalHeight;
      const r = stage.getBoundingClientRect();
      const aw = Math.max(50, r.width - 16), ah = Math.max(50, r.height - 8);
      const k = Math.min(aw / nw, ah / nh);
      const cw = Math.max(1, Math.floor(nw * k)), ch = Math.max(1, Math.floor(nh * k));
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      cv.style.width = cw + 'px';
      cv.style.height = ch + 'px';
      cv.width = Math.round(cw * dpr);
      cv.height = Math.round(ch * dpr);
      draw();
    }
    function draw() {
      if (!st.img || st.closed) return;
      const ctx = cv.getContext('2d');
      const W = cv.width, H = cv.height;
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(st.img, 0, 0, W, H);
      const list = st.drag && st.drag.mark ? [...st.marks, st.drag.mark] : st.marks;
      PM().drawMarks(ctx, list, W, H, { selected: st.selected });
    }

    /* ---------- 編集 ---------- */
    function push(next) {
      st.history.push(st.marks);
      if (st.history.length > 100) st.history.shift();
      st.marks = next;
      st.selected = -1;
      setMsg('');
      sync();
      draw();
    }
    function add(m) {
      if (st.marks.length >= PM().MAX_MARKS) { setMsg('印は1枚に' + PM().MAX_MARKS + '個までです', true); return false; }
      const n = PM().normalize([m]);
      if (!n.length) return false;
      push([...st.marks, n[0]]);
      return true;
    }
    function undo() {
      if (!st.history.length || st.saving) return;
      closeText();
      st.marks = st.history.pop();
      st.selected = -1;
      setMsg('');
      sync();
      draw();
    }
    function clearAll() {
      if (!st.marks.length || st.saving) return;
      closeText();
      push([]);
      setMsg('全部消しました（↩ で戻せます）');
    }
    function delSelected() {
      if (st.selected < 0 || st.saving) return;
      const i = st.selected;
      push(st.marks.filter((_, j) => j !== i));
      setMsg('印を消しました（↩ で戻せます）');
    }

    /* ---------- 指・マウス ---------- */
    const rel = ev => {
      const r = cv.getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)),
        y: Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)),
        px: ev.clientX - r.left, py: ev.clientY - r.top, cw: r.width, ch: r.height
      };
    };
    cv.addEventListener('pointerdown', ev => {
      if (st.saving || !st.img || st.drag) return;
      if (ev.button != null && ev.button > 0) return;
      ev.preventDefault();
      closeText();
      try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* 何もしない */ }
      const p = rel(ev);
      st.drag = { id: ev.pointerId, start: p, moved: false, mark: null };
    });
    cv.addEventListener('pointermove', ev => {
      const d = st.drag;
      if (!d || d.id !== ev.pointerId) return;
      ev.preventDefault();
      const p = rel(ev);
      if (!d.moved && Math.hypot(p.px - d.start.px, p.py - d.start.py) < DRAG_PX) return;
      d.moved = true;
      if (st.tool === 'circle') d.mark = { type: 'circle', x: d.start.x, y: d.start.y, w: p.x - d.start.x, h: p.y - d.start.y };
      else if (st.tool === 'arrow') d.mark = { type: 'arrow', x1: d.start.x, y1: d.start.y, x2: p.x, y2: p.y };
      draw();
    });
    const endDrag = (ev, cancelled) => {
      const d = st.drag;
      if (!d || d.id !== ev.pointerId) return;
      st.drag = null;
      if (cancelled) { draw(); return; }
      const p = d.start;
      if (d.moved && d.mark) { if (!add(d.mark)) draw(); return; }
      if (d.moved) { draw(); return; } // コメントの道具でドラッグした
      // タップ: 印に当たればそれを選ぶ（✕ で消せる）。当たらなければ道具ごとの動き
      const W = cv.width, H = cv.height, k = W / p.cw;
      const hit = PM().hitTest(st.marks, p.px * k, p.py * k, W, H, Math.max(14 * k, PM().lineWidth(W, H) * 3));
      if (hit >= 0) {
        st.selected = st.selected === hit ? -1 : hit;
        setMsg(st.selected >= 0 ? '印を選びました。「この印を消す」で消せます' : '');
        sync();
        draw();
        return;
      }
      if (st.selected >= 0) { st.selected = -1; setMsg(''); sync(); draw(); return; }
      if (st.tool === 'circle') {
        const s = 0.18 * Math.min(p.cw, p.ch); // 短辺の 18% の丸
        const w = s / p.cw, h = s / p.ch;
        add({ type: 'circle', x: Math.min(1 - w, Math.max(0, p.x - w / 2)), y: Math.min(1 - h, Math.max(0, p.y - h / 2)), w, h });
      } else if (st.tool === 'arrow') {
        setMsg('矢印は、始点から先端へ指（マウス）でなぞってください');
      } else {
        openText(p);
      }
    };
    cv.addEventListener('pointerup', ev => endDrag(ev, false));
    cv.addEventListener('pointercancel', ev => endDrag(ev, true));

    /* ---------- コメントの入力欄（タップした位置） ---------- */
    let txt = null;
    function openText(p) {
      closeText();
      if (st.marks.length >= PM().MAX_MARKS) { setMsg('印は1枚に' + PM().MAX_MARKS + '個までです', true); return; }
      st.textAt = { x: p.x, y: p.y };
      txt = mk('div', 'pme-txt');
      txt.id = 'pme-text';
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.id = 'pme-text-input';
      inp.maxLength = PM().MAX_TEXT;
      inp.placeholder = 'コメント（40字まで）';
      inp.autocomplete = 'off';
      inp.setAttribute('aria-label', 'コメント');
      const ok = btn('pme-ok', '追加', 'pme-text-ok', () => commitText());
      const no = btn('pme-no', 'やめる', 'pme-text-no', () => closeText());
      inp.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); commitText(); }
      });
      txt.append(inp, ok, no);
      stage.appendChild(txt);
      // 位置: タップした所の少し下（入りきらなければ上・左右は画面内に寄せる）
      const sr = stage.getBoundingClientRect(), cr = cv.getBoundingClientRect();
      const tw = txt.offsetWidth, th = txt.offsetHeight;
      let left = cr.left - sr.left + p.px - 20, top = cr.top - sr.top + p.py + 12;
      left = Math.max(8, Math.min(sr.width - tw - 8, left));
      if (top + th > sr.height - 4) top = cr.top - sr.top + p.py - th - 12;
      top = Math.max(4, top);
      txt.style.left = left + 'px';
      txt.style.top = top + 'px';
      inp.focus();
    }
    function commitText() {
      if (!txt || !st.textAt) return;
      const v = txt.querySelector('input').value.trim();
      if (!v) { closeText(); return; }
      const at = st.textAt;
      closeText();
      add({ type: 'text', x: at.x, y: at.y, text: v });
    }
    function closeText() {
      if (txt) { txt.remove(); txt = null; }
      st.textAt = null;
    }

    /* ---------- 閉じる・保存 ---------- */
    let ask = null;
    function askClose() {
      if (st.saving) return;
      closeText();
      if (!changed()) { close(); return; }
      if (ask) return;
      ask = mk('div', 'pme-ask');
      ask.id = 'pme-ask';
      const no = btn('pme-btn', '編集に戻る', 'pme-ask-back', () => { ask.remove(); ask = null; });
      const yes = btn('pme-btn pri', '保存せずに閉じる', 'pme-ask-discard', () => close());
      ask.append(mk('span', null, '付けた印を保存せずに閉じますか？'), no, yes);
      ft.prepend(ask);
      no.focus();
    }
    async function doSave() {
      if (st.saving || !st.img) return;
      closeText();
      const marks = PM().normalize(st.marks);
      const v = PM().validate(marks);
      if (!v.ok) { setMsg(v.errors[0], true); return; }
      st.saving = true;
      setMsg('保存中…');
      sync();
      try {
        if (typeof o.onSave === 'function') await o.onSave(marks);
      } catch (e) {
        st.saving = false;
        setMsg('保存できませんでした: ' + (e && e.message ? e.message : '通信を確認してもう一度お試しください'), true);
        sync();
        return;
      }
      close();
    }
    // Esc では閉じない（シートより奥の画面にも届かせない）
    const onKey = ev => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); }
    };
    const onResize = () => layout();
    const prevOverflow = document.documentElement.style.overflow;
    function close() {
      if (st.closed) return;
      st.closed = true;
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      document.documentElement.style.overflow = prevOverflow;
      root.remove();
      if (cur === handle) cur = null;
      if (typeof o.onClose === 'function') { try { o.onClose(); } catch (e) { /* 何もしない */ } }
      if (opener && opener.isConnected && typeof opener.focus === 'function') { try { opener.focus({ preventScroll: true }); } catch (e) { /* 何もしない */ } }
    }

    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    document.documentElement.style.overflow = 'hidden';
    document.body.appendChild(root);
    setTool('circle');
    toolBtns.circle.focus();

    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (st.closed) return;
      st.img = img;
      loading.remove();
      cv.hidden = false;
      layout();
      sync();
    };
    img.onerror = () => {
      if (st.closed) return;
      loading.textContent = '写真を読み込めませんでした。閉じてもう一度お試しください';
    };
    img.src = o.src || '';

    const handle = { close, root, get marks() { return st.marks.slice(); } };
    cur = handle;
    return handle;
  }

  // 一覧のサムネイル: 印があれば合成した画像、無ければ元の写真（合成に失敗したら元の写真）
  function thumbSrc(src, marks) {
    const list = PM().normalize(marks);
    if (!list.length || !src) return Promise.resolve(src);
    return PM().compose(src, list, { maxEdge: 480, quality: 0.85 }).catch(() => src);
  }

  if (document.head) injectCss(); // 一覧の「印を付ける」ボタンの見た目もここにあるので、読み込んだ時点で入れる
  return { open, thumbSrc, injectCss, isOpen: () => !!cur };
})();
