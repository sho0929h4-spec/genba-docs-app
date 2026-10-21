// js/daily-pdf.js — 日報の PDF（Task 32）。A4 縦1ページ。入りきらないときは文字を小さくして1ページに収め、
// いちばん小さい文字でも溢れたら2ページ目へ（行の切れ目で分ける）。報告書 PDF（js/report-pdf.js）と同じ作り（html2canvas 1.4.1 ＋ jsPDF 2.5.1）。
// グローバル: window.DailyPdf = { FONT_STEPS, build, toBlob, fileName }
// 中身は DailyLogic.view(...) の値（見出し「日報 YYYY年M月D日（曜） 氏名」・会社名・4区画・一言）＋ 写真（小さく最大3枚。URL の配列）。
// ユーザー入力が入るので、描画はすべて createElement + textContent（innerHTML は使わない）
(function () {
  const PAGE_W_MM = 210, PAGE_H_MM = 297;
  const PAD_MM = 12;
  const FONT_STEPS = [10.5, 10, 9.5, 9, 8.5, 8, 7.5, 7]; // pt。上から順に試す
  const IMG_TIMEOUT_MS = 20000;

  const CSS = `
.dp-page,.dp-page *{box-sizing:border-box;margin:0;padding:0;}
.dp-page{background:#fff;width:210mm;padding:${PAD_MM}mm ${PAD_MM}mm;color:#1e293b;line-height:1.45;font-family:'Noto Sans JP','Yu Gothic','Hiragino Kaku Gothic ProN',sans-serif;text-align:left;}
.dp-head{display:flex;align-items:flex-end;justify-content:space-between;gap:4mm;padding-bottom:2.5mm;border-bottom:2.5px solid #1a3a5c;margin-bottom:3mm;}
.dp-title{font-size:1.55em;font-weight:700;color:#1a3a5c;overflow-wrap:anywhere;}
.dp-org{font-size:1em;font-weight:700;color:#1a3a5c;text-align:right;overflow-wrap:anywhere;max-width:70mm;}
.dp-sec{background:#1a3a5c;color:#fff;padding:1.2mm 3mm;font-weight:700;font-size:1em;margin-top:2.5mm;}
.dp-rows{border:1px solid #c8d6e5;border-top:none;padding:1.5mm 3mm;}
.dp-row{padding:.8mm 0;border-bottom:1px dashed #e2e8f0;overflow-wrap:anywhere;}
.dp-row:last-child{border-bottom:none;}
.dp-main{font-weight:700;}
.dp-sub{color:#475569;font-size:.92em;padding-left:3mm;}
.dp-none{color:#94a3b8;}
.dp-time{display:flex;justify-content:space-between;gap:4mm;}
.dp-time span:last-child{white-space:nowrap;font-weight:700;}
.dp-total{font-weight:700;color:#1a3a5c;text-align:right;padding-top:1mm;}
.dp-note{white-space:pre-wrap;overflow-wrap:anywhere;}
.dp-photos{display:flex;gap:3mm;padding:2mm 3mm;border:1px solid #c8d6e5;border-top:none;}
.dp-ph{width:58mm;height:42mm;background:#f4f7fb;border:1px solid #e2e8f0;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;}
.dp-ph img{display:block;}
.dp-ph-fail{color:#94a3b8;font-size:.85em;}
`;
  function injectCss() {
    if (document.getElementById('dp-css')) return;
    const st = document.createElement('style');
    st.id = 'dp-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // v = DailyLogic.view(...)、photos = [url]（3枚まで）、pt = 文字の大きさ
  function build(v, photos, pt) {
    injectCss();
    const page = el('div', 'dp-page');
    page.style.fontSize = pt + 'pt';
    const head = el('div', 'dp-head dp-blk');
    head.appendChild(el('div', 'dp-title', v.title));
    if (v.org) head.appendChild(el('div', 'dp-org', v.org));
    page.appendChild(head);
    const section = (title, fill) => {
      page.appendChild(el('div', 'dp-sec dp-blk', title));
      const box = el('div', 'dp-rows');
      fill(box);
      page.appendChild(box);
    };
    (v.sections || []).forEach(s => section(s.title, box => {
      if (!s.rows.length) box.appendChild(el('div', 'dp-row dp-none dp-blk', 'なし'));
      s.rows.forEach(r => {
        const row = el('div', 'dp-row dp-blk');
        row.appendChild(el('div', 'dp-main', r.text));
        (r.sub || []).forEach(x => row.appendChild(el('div', 'dp-sub', x)));
        box.appendChild(row);
      });
    }));
    section('かかった時間', box => {
      if (!v.time.rows.length) box.appendChild(el('div', 'dp-row dp-none dp-blk', 'なし'));
      v.time.rows.forEach(r => {
        const row = el('div', 'dp-row dp-time dp-blk');
        row.append(el('span', null, r.label), el('span', null, r.value));
        box.appendChild(row);
      });
      box.appendChild(el('div', 'dp-total dp-blk', v.time.total));
    });
    // 一言は1行ずつ（2ページ目に分けるとき、行の途中で切れないように）
    if (v.note) section('一言', box => {
      const row = el('div', 'dp-row dp-note');
      String(v.note).split('\n').forEach(line => row.appendChild(el('div', 'dp-nl dp-blk', line || '\u00a0')));
      box.appendChild(row);
    });
    const ph = (photos || []).slice(0, 3);
    if (ph.length) {
      page.appendChild(el('div', 'dp-sec dp-blk', '写真'));
      const box = el('div', 'dp-photos dp-blk');
      ph.forEach(src => {
        const cell = el('div', 'dp-ph');
        const img = document.createElement('img');
        img.alt = '写真';
        if (/^https?:/i.test(src)) img.crossOrigin = 'anonymous';
        img.src = src;
        cell.appendChild(img);
        box.appendChild(cell);
      });
      page.appendChild(box);
    }
    return page;
  }

  function waitImg(img) {
    const done = new Promise(resolve => {
      if (img.complete) return resolve();
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    });
    return Promise.race([done, new Promise(r => setTimeout(r, IMG_TIMEOUT_MS))]).then(() => {
      if (!img.complete || !img.naturalWidth) {
        const cell = img.parentNode;
        img.remove();
        if (cell) cell.appendChild(el('span', 'dp-ph-fail', '写真を読み込めませんでした'));
      }
    });
  }
  // html2canvas は object-fit を描かないので、枠に収まる寸法を自分で付ける
  function layoutPhotos(page) {
    page.querySelectorAll('.dp-ph img').forEach(img => {
      const box = img.parentNode;
      const bw = box.clientWidth, bh = box.clientHeight, nw = img.naturalWidth, nh = img.naturalHeight;
      if (!bw || !bh || !nw || !nh) return;
      const r = Math.min(bw / nw, bh / nh);
      Object.assign(img.style, { width: nw * r + 'px', height: nh * r + 'px' });
    });
  }
  // ページの高さ（px）
  const pageHpx = page => page.offsetWidth * PAGE_H_MM / PAGE_W_MM;
  // 2ページ以上に分ける切れ目（行の境目）→ [{ y, h, off }]（off = そのページの上の余白 px）
  function slicesOf(page) {
    const H = page.scrollHeight, P = pageHpx(page), pad = page.offsetWidth * PAD_MM / PAGE_W_MM;
    if (H <= P + 0.5) return [{ y: 0, h: H, off: 0 }];
    const top = page.getBoundingClientRect().top;
    const cuts = Array.from(page.querySelectorAll('.dp-blk')).map(b => b.getBoundingClientRect().top - top).filter(y => y > 0).sort((a, b) => a - b);
    const out = [];
    let y = 0, off = 0;
    while (y < H - 0.5) {
      const room = P - off - pad; // 上（2ページ目から）と下の余白を除いた高さ
      let end = y + room;
      if (end < H) {
        const c = cuts.filter(x => x > y + 1 && x <= end).pop();
        if (c) end = c;
      } else end = H;
      out.push({ y, h: end - y, off });
      y = end;
      off = pad;
      if (out.length > 20) break;
    }
    return out;
  }

  // PDF（Blob）。o: { photos: [url], onPage(jpgDataUrl, index), scale, quality }
  //   → { blob, pages（ページ数）, pt（使った文字の大きさ）, images（各ページの JPEG。プレビュー用） }
  async function toBlob(v, o) {
    const opt = o || {};
    if (typeof window.html2canvas !== 'function' || !window.jspdf || !window.jspdf.jsPDF) {
      throw new Error('PDFライブラリを読み込めませんでした。通信状況を確認して再読み込みしてください');
    }
    const host = document.createElement('div');
    host.className = 'dp-capture';
    host.setAttribute('aria-hidden', 'true');
    Object.assign(host.style, { position: 'absolute', left: '-10000px', top: '0', width: '210mm', zIndex: '-1', pointerEvents: 'none' });
    document.body.appendChild(host);
    try {
      let page = null, pt = FONT_STEPS[0];
      for (const step of FONT_STEPS) {
        pt = step;
        page = build(v, opt.photos, step);
        host.replaceChildren(page);
        await Promise.all(Array.from(page.querySelectorAll('img')).map(waitImg));
        if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) { /* 無視 */ } }
        layoutPhotos(page);
        if (page.scrollHeight <= pageHpx(page) + 0.5) break;
      }
      const slices = slicesOf(page);
      const scale = opt.scale || 2, quality = opt.quality || 0.9;
      const canvas = await window.html2canvas(page, { scale, useCORS: true, allowTaint: false, backgroundColor: '#ffffff', logging: false, scrollX: 0, scrollY: 0 });
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      const s = canvas.width / page.offsetWidth;
      const outW = canvas.width, outH = Math.round(canvas.width * PAGE_H_MM / PAGE_W_MM);
      const images = [];
      slices.forEach((sl, i) => {
        const c = document.createElement('canvas');
        c.width = outW; c.height = outH;
        const g = c.getContext('2d');
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, outW, outH);
        const sy = Math.round(sl.y * s), sh = Math.min(Math.round(sl.h * s), canvas.height - sy, outH - Math.round(sl.off * s));
        if (sh > 0) g.drawImage(canvas, 0, sy, outW, sh, 0, Math.round(sl.off * s), outW, sh);
        const jpg = c.toDataURL('image/jpeg', quality);
        if (i > 0) doc.addPage('a4', 'portrait');
        doc.addImage(jpg, 'JPEG', 0, 0, PAGE_W_MM, PAGE_H_MM);
        images.push(jpg);
        if (typeof opt.onPage === 'function') opt.onPage(jpg, i);
        c.width = c.height = 0;
      });
      canvas.width = canvas.height = 0;
      const out = doc.output('blob');
      const blob = out.type === 'application/pdf' ? out : new Blob([out], { type: 'application/pdf' });
      return { blob, pages: slices.length, pt, images };
    } finally {
      host.remove();
    }
  }

  // 保存名 '日報_2026-10-21_鈴木.pdf'（ファイル名に使えない文字は _）
  const fileName = (ymd, name) => `日報_${ymd}_${String(name || '名前なし').replace(/[\\/:*?"<>|#%&{}$!'@+`=\s]/g, '_').slice(0, 40)}.pdf`;

  window.DailyPdf = { FONT_STEPS, build, toBlob, fileName };
})();
