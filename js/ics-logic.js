// js/ics-logic.js — Google カレンダーの購読用ファイル（iCalendar .ics・RFC 5545）を作る純粋関数（Task 55。ブラウザ: window.IcsLogic / node: module.exports）
// 予定 = cal_feed_events（migration 077）の events [{ id, title, start, end, address }]。終わりが無い・開始以前なら1時間。
// 時刻は TZID=Asia/Tokyo（VTIMEZONE つき。日本は夏時間なし = +0900 固定）。DTSTAMP は UTC。UID はフェーズごとに同じ（{id}@genba-docs）。
// 行の決まり: 改行は CRLF・1行 75 オクテット（UTF-8）を超えたら折り返す（次の行は空白1つで始める。文字の途中では切らない）・
// TEXT の \ ; , 改行はエスケープ。場所は住所の市区町村まで（cityOf）。入居者名・電話・金額は受け取らない
(function (root) {
  const JST_MS = 9 * 3600 * 1000;
  const HOUR_MS = 3600 * 1000;
  const pad = n => String(n).padStart(2, '0');
  const str = v => String(v == null ? '' : v).trim();
  // TEXT のエスケープ（RFC 5545 3.3.11）
  const esc = v => String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
  const bytes = s => new TextEncoder().encode(s).length;
  // 75 オクテットで折り返す（RFC 5545 3.1）。続きの行は先頭の空白1つも 75 に数える
  function fold(line) {
    const out = [];
    let cur = '', n = 0, limit = 75;
    for (const ch of line) { // for…of はサロゲートペアを1文字で回す
      const b = bytes(ch);
      if (n + b > limit) { out.push(cur); cur = ' '; n = 1; limit = 75; }
      cur += ch; n += b;
    }
    out.push(cur);
    return out.join('\r\n');
  }
  const ms = v => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
  const fmt = (t, off, z) => { const d = new Date(t + off);
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + (z ? 'Z' : ''); };
  const local = t => fmt(t, JST_MS, false); // 日本時間の壁時計
  const utc = t => fmt(t, 0, true);
  // 住所 → 都道府県＋市区町村（政令市は区まで・郡は町村まで）。分からなければ ''（番地まで出さない）
  function cityOf(address) {
    const a = str(address).replace(/^〒?\s*[0-9０-９]{3}[-－ー]?[0-9０-９]{4}\s*/, '').replace(/[\s　]+/g, '');
    const m = /^(.{2,3}?[都道府県])?(.+?郡)?(.+?市.{1,4}?区|.+?[市区町村])/.exec(a);
    return m ? (m[1] || '') + (m[2] || '') + m[3] : '';
  }
  // → .ics の文字列。opts.now = DTSTAMP（既定は今）・opts.name = カレンダーの名前
  function build(events, opts) {
    const o = opts || {};
    const stamp = utc(ms(o.now) != null ? ms(o.now) : Date.now());
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//genba-docs//calendar 1.0//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'X-WR-CALNAME:' + esc(o.name || '現場ドキュメント'), 'X-WR-TIMEZONE:Asia/Tokyo', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
      'BEGIN:VTIMEZONE', 'TZID:Asia/Tokyo', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900', 'TZNAME:JST',
      'END:STANDARD', 'END:VTIMEZONE'];
    for (const e of Array.isArray(events) ? events : []) {
      const s = e && ms(e.start);
      if (!e || !str(e.id) || s == null) continue;
      const en = ms(e.end) != null && ms(e.end) > s ? ms(e.end) : s + HOUR_MS;
      lines.push('BEGIN:VEVENT', 'UID:' + esc(str(e.id)) + '@genba-docs', 'DTSTAMP:' + stamp,
        'DTSTART;TZID=Asia/Tokyo:' + local(s), 'DTEND;TZID=Asia/Tokyo:' + local(en), 'SUMMARY:' + esc(str(e.title) || '予定'));
      const city = cityOf(e.address);
      if (city) lines.push('LOCATION:' + esc(city));
      lines.push('TRANSP:OPAQUE', 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }
  const api = { build, cityOf, esc, fold };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IcsLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
