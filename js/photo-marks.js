// js/photo-marks.js — 報告書の写真に付ける印（赤丸・矢印・コメント）の正規化・検査・描画・当たり判定（Task 14）
// 写真の元ファイルは変えない。reports.photos[] の各要素に marks を足す:
//   { type:'circle', x, y, w, h, color }      … 丸（楕円）。x,y = 左上、w,h = 幅・高さ（写真に対する 0〜1 の相対値）
//   { type:'arrow',  x1, y1, x2, y2, color }  … 矢印。始点 → 終点（先が三角）
//   { type:'text',   x, y, text, color }      … コメントの札。x,y = 札の左上（はみ出すときは写真の中に寄せて描く）
// 色は赤固定（COLOR）。線の太さは写真の短辺の 1%（最低 3px）。
// UMD: ブラウザでは window.PhotoMarks、node では module.exports（テスト用）。
// compose(src, marks, opts) だけはブラウザ専用（画像を読み込んで canvas に合成し data URL を返す）。
(function (root) {
  'use strict';
  const COLOR = '#e0001b';
  const MAX_MARKS = 20;
  const MAX_TEXT = 40;
  const TYPES = ['circle', 'arrow', 'text'];
  const MIN_SIZE = 0.01;      // これより小さい丸・短い矢印は捨てる（誤タップ）
  const r4 = v => Math.round(v * 10000) / 10000;
  const clamp01 = v => Math.min(1, Math.max(0, v));
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const chars = s => Array.from(String(s == null ? '' : s));

  /* ===== 正規化（壊れた値は捨て、範囲外は寄せる。保存・表示の前に必ず通す） ===== */
  function normalizeOne(m) {
    if (!m || typeof m !== 'object' || !TYPES.includes(m.type)) return null;
    if (m.type === 'circle') {
      let x = num(m.x), y = num(m.y), w = num(m.w), h = num(m.h);
      if (x == null || y == null || w == null || h == null) return null;
      if (w < 0) { x += w; w = -w; }   // 右下 → 左上へドラッグしたとき
      if (h < 0) { y += h; h = -h; }
      const x1 = clamp01(x), y1 = clamp01(y), x2 = clamp01(x + w), y2 = clamp01(y + h);
      if (x2 - x1 < MIN_SIZE || y2 - y1 < MIN_SIZE) return null;
      return { type: 'circle', x: r4(x1), y: r4(y1), w: r4(x2 - x1), h: r4(y2 - y1), color: COLOR };
    }
    if (m.type === 'arrow') {
      const a = [m.x1, m.y1, m.x2, m.y2].map(num);
      if (a.some(v => v == null)) return null;
      const [x1, y1, x2, y2] = a.map(clamp01);
      if (Math.hypot(x2 - x1, y2 - y1) < MIN_SIZE) return null;
      return { type: 'arrow', x1: r4(x1), y1: r4(y1), x2: r4(x2), y2: r4(y2), color: COLOR };
    }
    const x = num(m.x), y = num(m.y);
    const text = chars(m.text).join('').replace(/[\r\n\t]+/g, ' ').trim();
    if (x == null || y == null || !text) return null;
    return { type: 'text', x: r4(clamp01(x)), y: r4(clamp01(y)), text: chars(text).slice(0, MAX_TEXT).join(''), color: COLOR };
  }
  function normalize(marks) {
    if (!Array.isArray(marks)) return [];
    const out = [];
    for (const m of marks) {
      const n = normalizeOne(m);
      if (n) out.push(n);
      if (out.length >= MAX_MARKS) break;
    }
    return out;
  }

  /* ===== 検査（受け取った値をそのまま使ってよいか。DB の share_submit（migration 032）と同じ規則） ===== */
  function validate(marks) {
    const errors = [];
    if (marks == null) return { ok: true, errors };
    if (!Array.isArray(marks)) return { ok: false, errors: ['印の形が不正です'] };
    if (marks.length > MAX_MARKS) errors.push('印は1枚に' + MAX_MARKS + '個までです');
    const in01 = v => num(v) != null && v >= 0 && v <= 1;
    marks.forEach((m, i) => {
      const no = (i + 1) + '個目の印';
      if (!m || typeof m !== 'object' || Array.isArray(m) || !TYPES.includes(m.type)) { errors.push(no + 'の種類が不正です'); return; }
      if (m.color != null && m.color !== COLOR) errors.push(no + 'の色が不正です');
      if (m.type === 'circle') {
        if (![m.x, m.y, m.w, m.h].every(in01) || m.x + m.w > 1.0001 || m.y + m.h > 1.0001) errors.push(no + 'の位置が写真の外です');
      } else if (m.type === 'arrow') {
        if (![m.x1, m.y1, m.x2, m.y2].every(in01)) errors.push(no + 'の位置が写真の外です');
      } else {
        if (![m.x, m.y].every(in01)) errors.push(no + 'の位置が写真の外です');
        const n = typeof m.text === 'string' ? chars(m.text.trim()).length : 0;
        if (n < 1 || n > MAX_TEXT) errors.push(no + 'のコメントは1〜' + MAX_TEXT + '字です');
      }
    });
    return { ok: errors.length === 0, errors };
  }

  /* ===== 寸法（描画と当たり判定で同じ値を使う） ===== */
  // w,h = 描く先の写真の大きさ（px）
  function lineWidth(w, h) { return Math.max(3, Math.round(Math.min(w, h) * 0.01)); }
  function fontSize(w, h) { return Math.max(12, Math.round(Math.min(w, h) * 0.045)); }
  // 矢印の三角（先端からの長さ・幅）
  function headSize(w, h) { const lw = lineWidth(w, h); return { len: lw * 4.5, half: lw * 2.6 }; }
  // 札の箱。measure(text, fontPx) があればその幅、無ければ1文字=1em の概算（全角が多いため）
  function labelBox(m, w, h, measure) {
    const fs = fontSize(w, h);
    const pad = Math.round(fs * 0.4);
    const tw = measure ? measure(m.text, fs) : chars(m.text).length * fs;
    const bw = Math.min(w, Math.ceil(tw) + pad * 2), bh = Math.min(h, Math.round(fs * 1.25) + pad * 2);
    const x = Math.max(0, Math.min(w - bw, m.x * w)), y = Math.max(0, Math.min(h - bh, m.y * h));
    return { x, y, w: bw, h: bh, fs, pad };
  }

  /* ===== 描画（ctx は写真を描いた canvas。marks は正規化済みでなくてもよい） ===== */
  const FONT = (fs) => '700 ' + fs + "px 'Noto Sans JP','Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif";
  function drawArrow(ctx, m, w, h) {
    const ax = m.x1 * w, ay = m.y1 * h, bx = m.x2 * w, by = m.y2 * h;
    const ang = Math.atan2(by - ay, bx - ax);
    const hs = headSize(w, h);
    const len = Math.hypot(bx - ax, by - ay);
    const hl = Math.min(hs.len, len * 0.6), hw = hs.half * (hl / hs.len);
    const ex = bx - Math.cos(ang) * hl * 0.8, ey = by - Math.sin(ang) * hl * 0.8; // 線は三角の中で止める
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - Math.cos(ang) * hl + Math.cos(ang - Math.PI / 2) * hw, by - Math.sin(ang) * hl + Math.sin(ang - Math.PI / 2) * hw);
    ctx.lineTo(bx - Math.cos(ang) * hl + Math.cos(ang + Math.PI / 2) * hw, by - Math.sin(ang) * hl + Math.sin(ang + Math.PI / 2) * hw);
    ctx.closePath();
    ctx.fill();
  }
  function drawMarks(ctx, marks, w, h, opts) {
    const o = opts || {};
    const list = normalize(marks);
    const lw = lineWidth(w, h);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    list.forEach((m, i) => {
      const sel = o.selected === i;
      ctx.strokeStyle = COLOR;
      ctx.fillStyle = COLOR;
      ctx.lineWidth = lw;
      ctx.setLineDash([]);
      if (m.type === 'circle') {
        ctx.beginPath();
        ctx.ellipse((m.x + m.w / 2) * w, (m.y + m.h / 2) * h, Math.max(1, m.w * w / 2), Math.max(1, m.h * h / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (m.type === 'arrow') {
        drawArrow(ctx, m, w, h);
      } else {
        const b = labelBox(m, w, h, (t, fs) => { ctx.font = FONT(fs); return ctx.measureText(t).width; });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.lineWidth = Math.max(2, Math.round(lw * 0.6));
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        ctx.font = FONT(b.fs);
        ctx.textBaseline = 'middle';
        ctx.fillStyle = COLOR;
        ctx.fillText(m.text, b.x + b.pad, b.y + b.h / 2, b.w - b.pad * 2);
      }
      if (sel) { // 選んだ印（編集画面だけ）: 点線の枠
        const bb = bounds(m, w, h, ctx);
        ctx.strokeStyle = '#1a73e8';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(bb.x - lw, bb.y - lw, bb.w + lw * 2, bb.h + lw * 2);
      }
    });
    ctx.restore();
  }
  // 印の外枠（px）
  function bounds(m, w, h, ctx) {
    if (m.type === 'circle') return { x: m.x * w, y: m.y * h, w: m.w * w, h: m.h * h };
    if (m.type === 'arrow') {
      const xs = [m.x1 * w, m.x2 * w], ys = [m.y1 * h, m.y2 * h];
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.abs(xs[1] - xs[0]), h: Math.abs(ys[1] - ys[0]) };
    }
    const measure = ctx ? (t, fs) => { ctx.font = FONT(fs); return ctx.measureText(t).width; } : null;
    const b = labelBox(m, w, h, measure);
    return { x: b.x, y: b.y, w: b.w, h: b.h };
  }

  /* ===== 当たり判定: (px,py)（写真上の px）に一番上（後から付けた）の印の番号。無ければ -1 ===== */
  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function hitTest(marks, px, py, w, h, tol) {
    const list = normalize(marks);
    const t = tol != null ? tol : Math.max(12, lineWidth(w, h) * 3);
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.type === 'circle') {
        // 楕円の線の近く（内側の真ん中は写真を見たいので当たらない）
        const cx = (m.x + m.w / 2) * w, cy = (m.y + m.h / 2) * h, rx = m.w * w / 2, ry = m.h * h / 2;
        const ang = Math.atan2((py - cy) / ry, (px - cx) / rx);
        const ex = cx + rx * Math.cos(ang), ey = cy + ry * Math.sin(ang);
        if (Math.hypot(px - ex, py - ey) <= t) return i;
      } else if (m.type === 'arrow') {
        if (distToSeg(px, py, m.x1 * w, m.y1 * h, m.x2 * w, m.y2 * h) <= t) return i;
      } else {
        const b = labelBox(m, w, h);
        if (px >= b.x - t / 2 && px <= b.x + b.w + t / 2 && py >= b.y - t / 2 && py <= b.y + b.h + t / 2) return i;
      }
    }
    return -1;
  }

  /* ===== ブラウザ専用: 画像に印を合成した data URL（元の写真は変えない） ===== */
  // opts.maxEdge … 長辺をこの px 以下に縮める（サムネイル用）。opts.type / quality … 出力形式（既定 JPEG 0.92）
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (/^https?:/i.test(src)) img.crossOrigin = 'anonymous'; // 署名URL（Supabase Storage は CORS 可）。canvas を汚さない
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('画像を読み込めませんでした'));
      img.src = src;
    });
  }
  async function compose(src, marks, opts) {
    const o = opts || {};
    const img = await loadImage(src);
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) throw new Error('画像を読み込めませんでした');
    const k = o.maxEdge ? Math.min(1, o.maxEdge / Math.max(nw, nh)) : 1;
    const w = Math.max(1, Math.round(nw * k)), h = Math.max(1, Math.round(nh * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    drawMarks(ctx, marks, w, h);
    const url = c.toDataURL(o.type || 'image/jpeg', o.quality != null ? o.quality : 0.92);
    c.width = c.height = 0;
    return url;
  }

  const api = { COLOR, MAX_MARKS, MAX_TEXT, TYPES, normalize, validate, lineWidth, fontSize, labelBox, bounds, drawMarks, hitTest, compose };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PhotoMarks = api;
})(typeof window !== 'undefined' ? window : globalThis);
