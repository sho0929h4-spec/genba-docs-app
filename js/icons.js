// js/icons.js — 線のアイコン（Task 44。絵文字の代わり）。全部同じ書き方: 24 の枠・線は currentColor・太さ 1.75・角は丸・塗りなし。
// 形は Lucide（ISC ライセンス）の線画に合わせた。SVG は createElementNS で作る（innerHTML は使わない）。
//   Icon.el(name, { size: 16|20|24, label })  label があれば role=img + aria-label、無ければ飾り（aria-hidden）
//   Icon.prepend(el, name, size)               el の先頭にアイコン（文字の前の小さな印）。el を返す
//   Icon.dot(ball, label)                      自社の番（us）・相手待ち（them）の小さな丸（CSS の .dot）
//   Icon.hydrate(root)                         静的 HTML の <span data-icon="名前" data-size="20"> にアイコンを入れる
const Icon = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const c = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
  const rr = (x, y, w, h, r) => `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;
  const P = {
    settings: ['M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z', c(12, 12, 3)],
    yen: ['M12 9.5V21', 'M12 9.5 6 3', 'M12 9.5 18 3', 'M6 15h12', 'M6 11h12'],
    home: ['M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8', 'M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
    tasks: ['m3 17 2 2 4-4', 'm3 7 2 2 4-4', 'M13 6h8', 'M13 12h8', 'M13 18h8'],
    pen: ['M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7', 'M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z'],
    report: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M10 9H8', 'M16 13H8', 'M16 17H8'],
    receipt: ['M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z', 'M8 8h8', 'M8 12h8', 'M8 16h5'],
    megaphone: ['m3 11 18-5v12L3 14v-3z', 'M11.6 16.8a3 3 0 1 1-5.8-1.6'],
    clipboard: [rr(8, 2, 8, 4, 1), 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2', 'M12 11h4', 'M12 16h4', 'M8 11h.01', 'M8 16h.01'],
    pin: ['M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0', c(12, 10, 3)],
    door: ['M13 4h3a2 2 0 0 1 2 2v14', 'M2 20h3', 'M13 20h9', 'M10 12v.01', 'M13 4.562v16.157a1 1 0 0 1-1.242.97L5 20V5.562a2 2 0 0 1 1.515-1.94l4-1A2 2 0 0 1 13 4.561Z'],
    phone: ['M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z'],
    mail: [rr(2, 4, 20, 16, 2), 'm22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7'],
    message: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
    chat: ['M7.9 20A9 9 0 1 0 4 16.1L2 22Z'],
    bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
    clock: [c(12, 12, 10), 'M12 6v6l4 2'],
    calendar: [rr(3, 4, 18, 18, 2), 'M16 2v4', 'M8 2v4', 'M3 10h18'],
    user: ['M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2', c(12, 7, 4)],
    link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
    camera: ['M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z', c(12, 13, 3)],
    clip: ['m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48'],
    search: [c(11, 11, 8), 'm21 21-4.3-4.3'],
    alert: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
    check: ['M20 6 9 17l-5-5'],
    checkCircle: [c(12, 12, 10), 'm9 12 2 2 4-4'],
    x: ['M18 6 6 18', 'm6 6 12 12'],
    trash: ['M3 6h18', 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6', 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2'],
    undo: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11'],
    pencil: ['M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z', 'm15 5 4 4'],
    mic: ['M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3'],
    circle: [c(12, 12, 9)],
    arrow: ['M5 12h14', 'm12 5 7 7-7 7'],
    down: ['m6 9 6 6 6-6'],
    download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
    image: [rr(3, 3, 18, 18, 2), c(9, 9, 2), 'm21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21'],
    send: ['m22 2-7 20-4-9-9-4Z', 'M22 2 11 13']
  };
  function el(name, opts) {
    const o = opts || {};
    const size = o.size || 16;
    const svg = document.createElementNS(NS, 'svg');
    const set = (n, k, v) => n.setAttribute(k, v);
    set(svg, 'viewBox', '0 0 24 24'); set(svg, 'width', size); set(svg, 'height', size);
    set(svg, 'fill', 'none'); set(svg, 'stroke', 'currentColor'); set(svg, 'stroke-width', '1.75');
    set(svg, 'stroke-linecap', 'round'); set(svg, 'stroke-linejoin', 'round');
    set(svg, 'class', 'ic ic-' + name);
    if (o.label) { set(svg, 'role', 'img'); set(svg, 'aria-label', o.label); } else set(svg, 'aria-hidden', 'true');
    set(svg, 'focusable', 'false');
    for (const d of P[name] || []) { const p = document.createElementNS(NS, 'path'); set(p, 'd', d); svg.appendChild(p); }
    return svg;
  }
  function prepend(node, name, size) {
    const s = el(name, { size: size || 16 });
    s.classList.add('ic-lead');
    node.insertBefore(s, node.firstChild);
    return node;
  }
  function dot(ball, label) {
    const s = document.createElement('span');
    s.className = 'dot ' + (ball === 'them' ? 'them' : 'us');
    if (label) { s.setAttribute('role', 'img'); s.setAttribute('aria-label', label); } else s.setAttribute('aria-hidden', 'true');
    return s;
  }
  function hydrate(root) {
    (root || document).querySelectorAll('[data-icon]').forEach(n => {
      n.replaceChildren(el(n.dataset.icon, { size: Number(n.dataset.size) || 20 }));
    });
  }
  return { el, prepend, dot, hydrate, names: Object.keys(P) };
})();
if (typeof document !== 'undefined') Icon.hydrate(document);
