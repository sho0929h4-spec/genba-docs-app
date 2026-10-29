// js/dt-input.js — 日付と時刻を別々に選ぶ欄（Task 67）。日付 = input[type=date]、時刻 = select（30分きざみ。iOS Safari は step を見ないので select）
//   値は ISO（日本時間として読む・書く。端末のTZに依存しない）。そろっていなければ null
//   DtInput.el({ id, cls, label, iso, onChange }) → { el, date, time, get(fallbackYmd) → ISO|null, set(iso), setHm('HH:MM'), focus() }
//     id … 外側の id（日付は id-d・時刻は id-t）。cls … 外側に足す class。fallbackYmd … 日付が空で時刻だけのときに使う日（終了予定 = 開始の日）
//   30分きざみでない時刻（前に入れた値）は、その時刻を選択肢に足して見せる
(function (root) {
  const JST = 9 * 3600 * 1000;
  const pad = n => String(n).padStart(2, '0');
  const SLOTS = Array.from({ length: 48 }, (_, i) => pad(Math.floor(i / 2)) + ':' + (i % 2 ? '30' : '00'));
  // ISO → { ymd, hm }（日本時間）。読めなければ空
  function split(iso) {
    const t = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t)) return { ymd: '', hm: '' };
    const s = new Date(t + JST).toISOString();
    return { ymd: s.slice(0, 10), hm: s.slice(11, 16) };
  }
  // 'YYYY-MM-DD' と 'HH:MM'（日本時間）→ ISO。どちらか空・無い日（2月30日など）なら null
  function join(ymd, hm) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hm || '')) return null;
    const t = Date.parse(ymd + 'T' + hm + ':00+09:00');
    if (!Number.isFinite(t)) return null;
    const iso = new Date(t).toISOString();
    return split(iso).ymd === ymd ? iso : null;
  }
  // 'HH:MM' → 30分きざみに切り下げ（9:10 → 09:00、9:45 → 09:30）。読めなければ ''
  function snap(hm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '');
    if (!m || +m[1] > 23 || +m[2] > 59) return '';
    return pad(+m[1]) + ':' + (+m[2] < 30 ? '00' : '30');
  }

  function el(o) {
    const x = o || {};
    const box = document.createElement('div');
    box.className = 'dt-in' + (x.cls ? ' ' + x.cls : '');
    if (x.id) box.id = x.id;
    const date = document.createElement('input');
    date.type = 'date';
    date.className = 'dt-date';
    if (x.id) date.id = x.id + '-d';
    date.setAttribute('aria-label', (x.label || '') + 'の日付');
    const time = document.createElement('select');
    time.className = 'dt-time';
    if (x.id) time.id = x.id + '-t';
    time.setAttribute('aria-label', (x.label || '') + 'の時刻');
    const opt = (v, text) => { const op = document.createElement('option'); op.value = v; op.textContent = text; return op; };
    time.appendChild(opt('', '時刻'));
    SLOTS.forEach(hm => time.appendChild(opt(hm, hm)));
    box.append(date, time);
    const api = {
      el: box, date, time,
      get: fallbackYmd => join(date.value || (time.value ? fallbackYmd || '' : ''), time.value),
      set(iso) {
        const p = split(iso);
        date.value = p.ymd;
        api.setHm(p.hm);
      },
      // 時刻だけ入れる（Task 70: 見積書の工事時間。日付はそのまま）
      setHm(hm) {
        if (hm && !Array.from(time.options).some(op => op.value === hm)) {
          const after = Array.from(time.options).find(op => op.value > hm); // 時刻の順に差し込む
          time.insertBefore(opt(hm, hm), after || null);
        }
        time.value = hm || '';
      },
      focus() { (!date.value || time.value ? date : time).focus(); }
    };
    api.set(x.iso);
    if (x.onChange) box.addEventListener('input', x.onChange); // 日付・select とも input が出る（中から外へ伝わる）
    return api;
  }

  const api = { SLOTS, split, join, snap, el };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DtInput = api;
})(typeof window !== 'undefined' ? window : globalThis);
