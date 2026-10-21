// js/case-band.js — 物件名と号室の帯（Task 30）。案件に入ったあとの画面の上部に「{物件名} {号室}」を常に出す。
//   管理画面の編集画面: 「← 戻る」の行（rep-ed-top など）に帯を足し、その行を sticky にする（縦に増やさない）。
//   現場用のツールページはヘッダー（#fd-title）、担当者URLのページ（r.html）は js/vendor.js が同じ class で出す。
//   見た目は index.html / r.html の .cb-row / .cb-place。textContent だけで描く（innerHTML は使わない）。
const CaseBand = (() => {
  const text = c => (typeof PhaseLogic !== 'undefined' ? PhaseLogic.placeName(c || {}) : String((c && c.name) || '').trim());
  function set(el, c) {
    const t = text(c);
    el.textContent = t;
    el.title = t;
    el.hidden = !t;
    return el;
  }
  // row: 戻るボタンのある行。back: 戻るボタン（帯はその右）。caseRow: 案件（name・room）。cls: 帯に足す class
  function attach(row, back, caseRow, cls) {
    row.classList.add('cb-row');
    let b = row.querySelector(':scope > .cb-place');
    if (!b) {
      b = document.createElement('span');
      b.className = 'cb-place' + (cls ? ' ' + cls : '');
      if (back && back.parentNode === row) back.after(b);
      else row.prepend(b);
    }
    return set(b, caseRow);
  }
  return { text, set, attach };
})();
