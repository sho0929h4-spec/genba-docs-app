// js/estimate-logic.js — 見積書の純粋関数（ブラウザ: window.EstimateLogic / node: module.exports）
// 旧「見積書作成ツール」(freee-quote-builder/templates/invoice.html) の計算・文言を写している。
// 金額は整数円・四捨五入（Math.round）。紙面計算 renderPaper が唯一の正:
//   subtotal = postTax 以外の amount 合計 / tax = round(subtotal*0.1) / total = subtotal + tax + postTax 合計
// 明細行の形: { id, description, detail, quantity, unit, amount, isAutoShokehi?, shokehiPct?, postTax?, isAdjust?, cost?, priceOverride? }
// cost: 原価（業者の見積PDFから読み込んだ金額。Task 19）。priceOverride: 販売金額 amount を個別に直した印（利益率を変えても戻らない）
// isAdjust: 「税込合計を00に」で入る値引き調整行の内部フラグ。摘要が「値引き」の postTax 行でも、フラグが無ければ調整行ではない
// 単価は保存しない（表示用に 金額÷数量 で毎回算出）。
(function (root) {
  const TAX_RATE = 0.1;
  const NOTE_FIRST = '工事における電気、水道などの提供をお願いいたします。';   // 旧 buildNotesText :2385
  const QUICK = {                                                          // 旧 :1677-1679
    kanri: { description: '現場管理費', quantity: 1, unit: '日', unitPrice: 18000 },
    kotsu: { description: '交通費', quantity: 1, unit: '台', unitPrice: 6000 },
    shokehiPct: 10
  };
  const ADJUST_DESC = '値引き';                                              // 旧 toggleAdjustTotal :1635,1664
  const VALID_DAYS = 14;                                                   // 旧 _todayStr(14) :2563

  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const pad = n => String(n).padStart(2, '0');

  // ── 日付（ローカル日付。toISOString は日本の早朝に前日へずれるので使わない）─────────
  function todayStr(d) {
    d = d || new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function toYmd(today) {
    if (!today) return todayStr();
    if (today instanceof Date) return todayStr(today);
    return String(today);
  }
  function addDays(ymd, n) {
    const [y, m, d] = ymd.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }
  function isYmd(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    return addDays(s, 0) === s;
  }

  // ── 行 ─────────────────────────────────────────────────────────────────────
  let seq = 0;
  function newId() {
    seq += 1;
    return 'l' + Date.now().toString(36) + seq.toString(36) + Math.floor(Math.random() * 0x10000).toString(36);
  }
  function newLine(init) {
    return Object.assign({ id: newId(), description: '', detail: '', quantity: 1, unit: '式', amount: 0 }, init || {});
  }
  // 実データのある行か（旧 isRealItem :2223）。詳細だけの行は前行の続きの注記なので残す
  function isRealLine(it) {
    if (!it) return false;
    return !!(String(it.description || '').trim() || String(it.detail || '').trim() || num(it.amount));
  }

  // ── 計算 ───────────────────────────────────────────────────────────────────
  function totals(lines) {
    const ls = lines || [];
    const subtotal = ls.filter(l => !l.postTax).reduce((s, l) => s + num(l.amount), 0);
    const postTax = ls.filter(l => l.postTax).reduce((s, l) => s + num(l.amount), 0);
    const tax = Math.round(subtotal * TAX_RATE);
    return { subtotal, tax, postTax, total: subtotal + tax + postTax };
  }
  function withTotals(est) {
    const t = totals(est.lines);
    return Object.assign({}, est, { subtotal: t.subtotal, tax: t.tax, total: t.total });
  }

  // 諸経費の自動行: 自分・他の諸経費・postTax を除いた合計 × pct/100（旧 _recalcShokehi :1604）
  function recalcShokehi(lines) {
    const ls = lines || [];
    const base = ls.filter(x => !x.isAutoShokehi && !x.postTax).reduce((s, x) => s + num(x.amount), 0);
    return ls.map(it => {
      if (!it.isAutoShokehi) return it;
      const pct = num(it.shokehiPct);
      return Object.assign({}, it, { amount: Math.round(base * pct / 100) });
    });
  }
  function addShokehi(lines, pct) {
    const p = parseFloat(pct);
    if (isNaN(p) || p <= 0) return null;            // 旧 addShokehi :1680-1682（アラートして追加しない）
    const row = newLine({ description: '諸経費', quantity: 1, unit: '式', amount: 0, isAutoShokehi: true, shokehiPct: p });
    return recalcShokehi((lines || []).concat([row]));
  }
  function addQuick(lines, key) {
    const q = QUICK[key];
    if (!q || typeof q !== 'object') return null;
    const row = newLine({ description: q.description, quantity: q.quantity, unit: q.unit, amount: q.unitPrice * q.quantity });
    return recalcShokehi((lines || []).concat([row]));
  }

  // 税込合計を00に（旧 toggleAdjustTotal :1633）。値引き行（postTax）の追加／除去のトグル。
  // 返り値 { lines, action: 'added'|'removed'|'already', remainder }
  const isAdjustLine = l => !!l && l.isAdjust === true && !!l.postTax;
  function adjustLine(amount) {
    return newLine({ description: ADJUST_DESC, quantity: 1, unit: '式', amount: Math.round(num(amount)) || 0, postTax: true, isAdjust: true });
  }
  function adjustToHundred(lines) {
    const ls = lines || [];
    const idx = ls.findIndex(isAdjustLine);
    if (idx >= 0) {
      const rest = ls.filter((_, i) => i !== idx);
      return { lines: rest.length ? rest : [newLine()], action: 'removed', remainder: 0 };
    }
    const total = totals(ls).total;
    const remainder = ((total % 100) + 100) % 100;
    if (remainder === 0) return { lines: ls.slice(), action: 'already', remainder: 0 };
    const row = adjustLine(-remainder);
    return { lines: ls.concat([row]), action: 'added', remainder };
  }

  // 単価 = 金額÷数量（旧 unitPriceOf :2232）。数量0なら金額
  function unitPrice(line) {
    const q = num(line.quantity);
    if (!q) return num(line.amount);
    return Math.round(num(line.amount) / q);
  }
  // 金額確定時に「単価×数量」へ丸め直し、紙の掛け算を合わせる（旧 efAmtCommit :1475）
  function commitAmount(line) {
    const q = num(line.quantity);
    if (q <= 0) return line;
    const up = Math.round(num(line.amount) / q);
    const fix = Math.round(up * q);
    if (fix === Number(line.amount)) return line;
    return Object.assign({}, line, { amount: fix });
  }
  // 旧 _normAmt :2230。金額が無ければ 単価×数量 で逆算
  function normAmount(it) {
    const q = num(it.quantity);
    let amt = num(it.amount);
    const up0 = num(it.unit_price);
    if (!amt && up0 && q) amt = Math.round(up0 * q);
    return { amount: amt, unit_price: q ? Math.round(amt / q) : amt };
  }

  // ── 備考 ───────────────────────────────────────────────────────────────────
  // notes = { koki:{on,val}, jikan:{on,val}, hotel: 'need'|'none'|'', katazuke: { sel: 'need'|'none'|'', places: [], free }, extra }（est.data.notes。data ごとでも可）
  //   Task 48 E: 「荷物の移動依頼」（nimotsu:{on,val}）は「ホテル移動」「荷物の片付け」（必要／不要）に置き換えた。前からある nimotsu.on は 片付け 必要（場所なし）として読む
  const KATAZUKE_PLACES = ['トイレ', '洗面所', 'キッチン', '洗濯機'];
  const HOTEL_TEXT = '工事期間中はホテル等への一時移動が必要です。';
  const katazukeText = places => `工事箇所${places.length ? `（${places.join('・')}）` : ''}周辺のお荷物の片付けをお願いいたします。`;
  function defaultNotes() {
    return { koki: { on: false, val: '3' }, jikan: { on: false, val: '' }, hotel: '', katazuke: { sel: '', places: [], free: '' }, extra: '' };
  }
  // 備考の欄 → { hotel, katazuke: 'need'|'none'|''（未選択）, places: 選んだ場所＋自由記載 }
  function noteChoices(notes) {
    let n = notes || {};
    if (n.notes && typeof n.notes === 'object') n = n.notes;
    const sel = v => (v === 'need' || v === 'none' ? v : '');
    const k = n.katazuke && typeof n.katazuke === 'object' ? n.katazuke : {};
    const katazuke = sel(k.sel) || (n.nimotsu && n.nimotsu.on ? 'need' : '');
    const free = k.free == null ? '' : String(k.free).trim();
    const places = katazuke === 'need' ? KATAZUKE_PLACES.filter(p => Array.isArray(k.places) && k.places.includes(p)).concat(free ? [free] : []) : [];
    return { hotel: sel(n.hotel), katazuke, places };
  }
  // 紙面の備考: 1行目（必須）→ 工期 → 工事時間 → ホテル移動・荷物の片付け（必要のときだけ。不要は書かない）→ 自由記入
  function buildNotes(notes) {
    let n = notes || {};
    if (n.notes && typeof n.notes === 'object') n = n.notes;
    const out = [NOTE_FIRST];
    [['koki', '工期'], ['jikan', '工事時間']].forEach(([key, label]) => {
      const o = n[key];
      if (!o || !o.on) return;
      let text = o.val == null ? '' : String(o.val).trim();
      if (key === 'koki' && text) text = `${parseInt(text, 10) || 0}日間`;
      out.push(text ? `${label}：${text}` : `${label}：`);
    });
    const ch = noteChoices(n);
    if (ch.hotel === 'need') out.push(HOTEL_TEXT);
    if (ch.katazuke === 'need') out.push(katazukeText(ch.places));
    const extra = n.extra == null ? '' : String(n.extra);
    if (extra.trim()) out.push(extra.trim());
    return out.join('\n');
  }

  // ── 工事の日程の条件（Task 47・48）────────────────────────────────────────────
  // 見積書の備考（工期○日間・工事時間・ホテル移動・荷物の片付け）と明細の品名・内容（断水・排水制限）から日程を決めるための条件を取り出す。
  //   est: 見積書の行 { data: { notes }, lines } か case_summaries の見積の要素 { notes, line_texts }。notes は備考の欄（buildNotes の形）か文字
  //   → { days: '2日間'|'', time: '9:00〜17:00'|'', hotel: '必要'|'不要'|'', katazuke: '必要（トイレ・キッチン）'|'必要'|'不要'|'', water, drain,
  //       missing: ['工期','工事時間','ホテル移動','荷物の片付け'] の無いもの（未選択）}
  //   文字の備考（読み込んだ見積）は「不要」を書かないので、書いてあれば必要・無ければ未記入
  const COND_ITEMS = ['工期', '工事時間', 'ホテル移動', '荷物の片付け'];
  function conditions(est) {
    const e = est || {};
    const raw = e.data && e.data.notes !== undefined ? e.data.notes : e.notes;
    const isObj = raw && typeof raw === 'object';
    const notes = typeof raw === 'string' ? raw : isObj ? buildNotes(raw) : '';
    const lineText = (Array.isArray(e.line_texts) ? e.line_texts
      : (Array.isArray(e.lines) ? e.lines : []).map(l => [l && l.description, l && l.detail].filter(Boolean).join(' '))).map(String).join('\n');
    const all = notes + '\n' + lineText;
    const kokiM = /工期[：:]\s*(\d+)\s*日/.exec(notes);
    const days = kokiM && Number(kokiM[1]) > 0 ? `${Number(kokiM[1])}日間` : '';
    const jikanM = /工事時間[：:][ \t\u3000]*([^\n]*)/.exec(notes);
    const time = jikanM ? jikanM[1].trim() : '';
    let ch;
    if (isObj) ch = noteChoices(raw);
    else {
      const placeM = /工事箇所（([^）]*)）周辺のお荷物の片付け/.exec(notes);
      ch = { hotel: /ホテル等への一時移動が必要/.test(notes) ? 'need' : '',
        katazuke: placeM || /お荷物の片付け|荷物の移動依頼|荷物の移動をお願い/.test(notes) ? 'need' : '', places: placeM ? placeM[1].split('・').filter(Boolean) : [] };
    }
    const hotel = ch.hotel === 'need' ? '必要' : ch.hotel === 'none' ? '不要' : '';
    const katazuke = ch.katazuke === 'need' ? (ch.places.length ? `必要（${ch.places.join('・')}）` : '必要') : ch.katazuke === 'none' ? '不要' : '';
    const water = /断水/.test(all);
    const drain = /排水(制限|停止|不可|禁止)|排水を伴うご使用をお控え/.test(all);
    const missing = COND_ITEMS.filter((_, i) => ![days, time, hotel, katazuke][i]);
    return { days, time, hotel, katazuke, water, drain, missing };
  }
  // 工事時間の文字 '9:00〜17:00' → { start: '09:00', end: '17:00' } か null（工事掲示の時刻に使う）
  function timeRange(text) {
    const m = /(\d{1,2})[:：](\d{2})\s*[〜~～\-－ーから]+\s*(\d{1,2})[:：](\d{2})/.exec(String(text || ''));
    if (!m) return null;
    const hm = (h, mi) => (+h <= 23 && +mi <= 59 ? `${String(+h).padStart(2, '0')}:${mi}` : '');
    const start = hm(m[1], m[2]), end = hm(m[3], m[4]);
    return start && end && start < end ? { start, end } : null;
  }

  // ── 作成・版 ────────────────────────────────────────────────────────────────
  function emptyEstimate(caseRow, org, me, today) {
    const c = caseRow || {};
    const t = toYmd(today);
    const lines = [newLine()];
    return {
      version: 1,
      status: 'draft',
      data: {
        client: c.client_name || '',
        honorific: '御中',
        subject: c.name || '',
        manager: c.assignee_name || (me && me.display_name) || '',
        issueDate: t,
        validUntil: addDays(t, VALID_DAYS),
        notes: defaultNotes()
      },
      lines,
      subtotal: 0, tax: 0, total: 0
    };
  }
  const clone = v => JSON.parse(JSON.stringify(v));
  // 値引き調整行（isAdjust）は合計が変わるので引き継がず、諸経費は再計算、日付は更新
  function nextVersionFrom(est, today) {
    const t = toYmd(today);
    let lines = (est.lines || []).filter(l => !isAdjustLine(l)).map(clone);
    if (!lines.length) lines = [newLine()];
    lines = recalcShokehi(lines);
    const data = clone(est.data || {});
    data.issueDate = t;
    data.validUntil = addDays(t, VALID_DAYS);
    const tt = totals(lines);
    return {
      series_id: est.series_id,
      version: (Number(est.version) || 1) + 1,
      status: 'draft',
      data,
      lines,
      subtotal: tt.subtotal, tax: tt.tax, total: tt.total,
      linked_request_ids: []
    };
  }

  // 行単位の差分。id が合うものを先に、残りは摘要が同じもの同士を出現順に突き合わせる
  const lineKey = l => JSON.stringify([String(l.description || ''), String(l.detail || ''), num(l.quantity), String(l.unit || ''), num(l.amount), !!l.postTax]);
  const sameLine = (a, b) => lineKey(a) === lineKey(b);
  function diff(prev, next) {
    const pl = ((prev && prev.lines) || []).filter(isRealLine);
    const nl = ((next && next.lines) || []).filter(isRealLine);
    const pairs = [];
    const usedP = new Set(), usedN = new Set();
    nl.forEach((n, ni) => {
      if (!n.id) return;
      const pi = pl.findIndex((p, i) => !usedP.has(i) && p.id === n.id);
      if (pi >= 0) { usedP.add(pi); usedN.add(ni); pairs.push([pl[pi], n]); }
    });
    nl.forEach((n, ni) => {
      if (usedN.has(ni)) return;
      const pi = pl.findIndex((p, i) => !usedP.has(i) && (p.description || '') === (n.description || ''));
      if (pi >= 0) { usedP.add(pi); usedN.add(ni); pairs.push([pl[pi], n]); }
    });
    const added = nl.filter((_, i) => !usedN.has(i));
    const removed = pl.filter((_, i) => !usedP.has(i));
    const changed = [];
    let unchanged = 0;
    pairs.forEach(([p, n]) => {
      if (sameLine(p, n)) unchanged += 1;
      else changed.push({ before: p, after: n, delta: num(n.amount) - num(p.amount) });
    });
    const pt = totals(prev && prev.lines), nt = totals(next && next.lines);
    return {
      added, removed, changed, unchanged,
      subtotalDelta: nt.subtotal - pt.subtotal,
      total: { prev: pt.total, next: nt.total, delta: nt.total - pt.total },
      same: !added.length && !removed.length && !changed.length && pt.total === nt.total
    };
  }

  // ── 番号・ファイル名・書式 ─────────────────────────────────────────────────────
  function formatNumber(n, version) {
    const base = 'EST-' + String(Math.trunc(num(n))).padStart(10, '0');
    const v = Number(version) || 1;
    return v >= 2 ? `${base}-v${v}` : base;
  }
  function fileName(est) {
    const e = est || {};
    const subj = String((e.data && e.data.subject) || '').trim().replace(/[\\/:*?"<>|\r\n\t]/g, '_');
    const v = Number(e.version) || 1;
    return (subj ? `見積書_${subj}` : '見積書') + (v >= 2 ? `_v${v}` : '') + '.pdf';
  }
  function fmt(n) {
    const v = Math.round(num(n));
    const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (v < 0 ? '-' : '') + s;
  }
  function yen(n) {
    const v = Math.round(num(n));
    return (v < 0 ? '-' : '') + '¥' + fmt(Math.abs(v));
  }

  // ── 社印（旧 hankoSplit :1773 / _hankoCol :1796）───────────────────────────────
  const HOJIN = ['株式会社', '有限会社', '合同会社', '合資会社', '合名会社',
    '一般社団法人', '一般財団法人', '医療法人', '社会福祉法人', '同族会社'];
  // 右の列から下へ読む。法人格で前半（右列）・後半（左列）に割る
  function hankoParts(name) {
    const s = String(name || '').replace(/\s/g, '');
    if (!s) return { right: '', left: '' };
    for (const h of HOJIN) {
      if (s.startsWith(h)) return { right: h, left: s.slice(h.length) };    // 前株
      if (s.endsWith(h)) return { right: s.slice(0, -h.length), left: h };  // 後株
    }
    const n = Math.ceil(s.length / 2);                                       // 法人格なし: 真ん中で割る（奇数は右が長い）
    return { right: s.slice(0, n), left: s.slice(n) };
  }
  const HANKO_MAX_FS = 21;
  const round1 = v => Number(v.toFixed(1));
  function hankoCol(chars, x) {
    const n = chars.length;
    if (!n) return { x, chars: [] };
    const step = Math.min(84 / n, HANKO_MAX_FS / 0.9);     // 枠の内側 y=7〜91 に等分
    const size = step * 0.9;
    const top = 7 + (84 - step * n) / 2;                    // 頭打ち分は上下中央に寄せる
    return {
      x,
      chars: chars.map((c, i) => ({
        c,
        y: round1(top + step * (i + 1)),
        fs: round1(/[・･.,\-ー–—]/.test(c) ? size * 0.8 : size)
      }))
    };
  }
  // 100x100 viewBox の角印に置く文字の座標（左列 x=35・右列 x=71）
  function hankoCols(name) {
    const p = hankoParts(name);
    return { left: hankoCol(Array.from(p.left), 35), right: hankoCol(Array.from(p.right), 71) };
  }

  // ── よく使う明細（定型・migration 029 estimate_presets）──────────────────────────
  // preset = { id, kind, label, line: {description, detail?, quantity, unit, amount, unitPrice?, postTax?:false}, sort, created_at }
  const PRESET_KINDS = ['common', 'survey', 'cause', 'repair'];
  const PRESET_KIND_LABEL = { common: '共通', survey: '調査', cause: '原因元工事', repair: '復旧工事' };
  const PRESET_LABEL_MAX = 40;
  const chars = v => Array.from(String(v == null ? '' : v));
  const finite = v => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)));
  const presetSrc = preset => (preset && preset.line && typeof preset.line === 'object' ? preset.line : (preset || {}));
  // 定型の金額（unitPrice があれば 単価×数量・四捨五入）
  function presetAmount(preset) {
    const src = presetSrc(preset);
    const q = finite(src.quantity) && Number(src.quantity) >= 0 ? Number(src.quantity) : 1;
    return (finite(src.unitPrice) ? Math.round(Number(src.unitPrice) * q) : Math.round(num(src.amount))) || 0;
  }
  // 定型 → 明細行（新しい id）。unitPrice があれば 金額 = 単価×数量。税対象外・諸経費の自動行にはしない。
  // 行は定型の写し（後で定型を変えても作った見積書の行・金額は変わらない）。古い行の step（Task 22・廃止）は持たせない
  function presetToLine(preset) {
    const src = presetSrc(preset);
    const q = finite(src.quantity) && Number(src.quantity) >= 0 ? Number(src.quantity) : 1;
    const amount = presetAmount(preset);
    return newLine({
      description: String(src.description == null ? '' : src.description),
      detail: String(src.detail == null ? '' : src.detail),
      quantity: q,
      unit: src.unit == null || src.unit === '' ? '式' : String(src.unit),
      amount: amount || 0
    });
  }
  // 明細行 → 定型の line（DB の形）。登録できない行（諸経費の自動行・税対象外・摘要が空）は null
  function lineToPreset(line) {
    const l = line || {};
    if (l.isAutoShokehi || l.postTax || l.isAdjust) return null;
    const description = String(l.description == null ? '' : l.description).trim();
    if (!description) return null;
    const out = { description, quantity: num(l.quantity), unit: String(l.unit == null ? '' : l.unit), amount: Math.round(num(l.amount)) || 0, postTax: false };
    const detail = String(l.detail == null ? '' : l.detail).trim();
    if (detail) out.detail = detail;
    return out;
  }
  // 名前の初期値 = 摘要（40字まで）
  function presetDefaultLabel(line) {
    return chars(String((line && line.description) || '').trim()).slice(0, PRESET_LABEL_MAX).join('');
  }
  // DB の check（029）と同じ判定。{ ok, errors }
  function validatePreset(p) {
    const errors = [];
    const x = p || {};
    if (!PRESET_KINDS.includes(x.kind)) errors.push('種類を選んでください');
    const label = String(x.label == null ? '' : x.label);
    if (!label.trim()) errors.push('名前を入力してください');
    else if (chars(label).length > PRESET_LABEL_MAX) errors.push('名前は' + PRESET_LABEL_MAX + '字までです');
    const l = x.line || {};
    const d = String(l.description == null ? '' : l.description).trim();
    if (!d) errors.push('摘要を入力してください');
    else if (chars(d).length > 200) errors.push('摘要は200字までです');
    if (l.detail != null && chars(l.detail).length > 500) errors.push('詳細は500字までです');
    if (chars(l.unit).length > 10) errors.push('単位は10字までです');
    if (typeof l.quantity !== 'number' || !Number.isFinite(l.quantity) || l.quantity < 0 || l.quantity > 1000000) errors.push('数量が正しくありません');
    if (typeof l.amount !== 'number' || !Number.isInteger(l.amount) || Math.abs(l.amount) > 1e12) errors.push('金額は整数の円で入力してください');
    if (l.postTax) errors.push('税対象外の行は登録できません');
    return { ok: errors.length === 0, errors };
  }
  // 自分専用（owner_user_id あり。RLS で本人の分しか来ない）／会社共通（null）。Task 49 / migration 068
  const presetTier = p => (p && p.owner_user_id ? 'mine' : 'company');
  // 見積のフェーズの種類に合う定型（自分専用 → 会社共通、その中で その種類 → 共通の順。種類の中は sort → 作成順）
  function presetKindsFor(phaseKind) {
    return ['survey', 'cause', 'repair'].includes(phaseKind) ? [phaseKind, 'common'] : ['common'];
  }
  const presetOrder = (a, b) => (num(a.sort) - num(b.sort)) || String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id || '').localeCompare(String(b.id || ''));
  function presetsFor(presets, phaseKind) {
    const kinds = presetKindsFor(phaseKind);
    return (presets || []).filter(p => p && kinds.includes(p.kind))
      .sort((a, b) => (presetTier(a) === presetTier(b) ? 0 : presetTier(a) === 'mine' ? -1 : 1)
        || (kinds.indexOf(a.kind) - kinds.indexOf(b.kind)) || presetOrder(a, b));
  }
  // 編集シートの一覧: 種類ごと（共通 → 調査 → 原因元工事 → 復旧工事）。空の種類も返す
  function groupPresets(presets) {
    return PRESET_KINDS.map(kind => ({
      kind, label: PRESET_KIND_LABEL[kind],
      items: (presets || []).filter(p => p && p.kind === kind).sort(presetOrder)
    }));
  }
  function nextPresetSort(presets, kind) {
    const ss = (presets || []).filter(p => p && p.kind === kind).map(p => num(p.sort));
    return ss.length ? Math.max(...ss) + 1 : 0;
  }
  // ↑↓: 同じ段（自分専用／会社共通）・同じ種類の中で dir（-1 / 1）へ1つ動かす。返り値は sort を変える行だけ [{ id, sort }]（並び = 0,1,2… に振り直す）
  function movePreset(presets, id, dir) {
    const me = (presets || []).find(p => p && p.id === id);
    if (!me) return [];
    const list = (presets || []).filter(p => p && p.kind === me.kind && presetTier(p) === presetTier(me)).sort(presetOrder);
    const i = list.findIndex(p => p.id === id), j = i + dir;
    if (j < 0 || j >= list.length) return [];
    [list[i], list[j]] = [list[j], list[i]];
    return list.map((p, k) => ({ id: p.id, sort: k, old: num(p.sort) })).filter(x => x.sort !== x.old).map(x => ({ id: x.id, sort: x.sort }));
  }


  // ── 原価・利益率・業者の見積PDFの読み込み（対応フェーズ Task 19。旧 invoice.html applyProfit / updateProfitSummary・
  //    utils/pdf_parser.py の Strategy 2「pypdf text + regex」を移植）────────────────────────────────
  // 明細行に cost（原価。整数の円・0 以上。任意）と priceOverride（販売金額を個別に直した印）を持つ。
  // 販売金額 amount = 原価 × (1 + 利益率/100) を四捨五入。priceOverride の行・原価の無い行・諸経費の自動行・税対象外の行は変えない。
  // 合計（totals）は今まで通り amount だけ。PDF には amount だけが出る
  const MARGIN_MAX = 999;
  const IMPORT_MAX_ITEMS = 300;
  const hasCost = l => !!l && l.cost !== undefined && l.cost !== null && l.cost !== '' && Number.isFinite(Number(l.cost));
  // 利益率の入力値 → 数値（0〜999・小数2桁）。空・不正は null
  function normMargin(v) {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = Number(String(v).trim());
    if (!Number.isFinite(n) || n < 0 || n > MARGIN_MAX) return null;
    return Math.round(n * 100) / 100;
  }
  function marginPrice(cost, pct) {
    return Math.round(num(cost) * (1 + num(pct) / 100));
  }
  function applyMargin(lines, pct) {
    const ls = (lines || []).map(l => {
      if (!hasCost(l) || l.priceOverride || l.isAutoShokehi || l.postTax) return l;
      return Object.assign({}, l, { amount: marginPrice(l.cost, pct) });
    });
    return recalcShokehi(ls);
  }
  // 原価の合計・販売の合計（税抜の小計）・粗利（額と%。% = 粗利 ÷ 販売 × 100 を小数1桁）。
  // 原価のある行が1つも無ければ null（枠を出さない）
  function profitSummary(lines) {
    const ls = lines || [];
    const costed = ls.filter(l => hasCost(l) && !l.postTax);
    if (!costed.length) return null;
    const cost = costed.reduce((s, l) => s + Math.round(num(l.cost)), 0);
    const sell = ls.filter(l => !l.postTax).reduce((s, l) => s + num(l.amount), 0);
    const profit = sell - cost;
    const pct = sell > 0 ? Math.round(profit / sell * 1000) / 10 : 0;
    const noCost = ls.filter(l => !l.postTax && !hasCost(l) && isRealLine(l) && !l.isAutoShokehi).length;
    return { cost, sell, profit, pct, overrides: ls.filter(l => l.priceOverride && hasCost(l)).length, noCost };
  }
  // Task 35: 原価の税込合計（対応の表の「原価 ¥…」）。税の扱いは見積の合計（totals）と同じ:
  //   原価のある税対象の行の原価の合計 → 消費税 round(×0.1) → 税対象外（postTax）の行の原価はそのまま足す。
  //   原価のある行が1つも無ければ null（表は「原価 —」）
  function costTotals(lines) {
    const ls = (lines || []).filter(hasCost);
    if (!ls.length) return null;
    const subtotal = ls.filter(l => !l.postTax).reduce((s, l) => s + Math.round(num(l.cost)), 0);
    const postTax = ls.filter(l => l.postTax).reduce((s, l) => s + Math.round(num(l.cost)), 0);
    const tax = Math.round(subtotal * TAX_RATE);
    return { subtotal, tax, postTax, total: subtotal + tax + postTax };
  }
  // 読み取り結果（AI も文字抽出も同じ形 { items: [{description, detail, quantity, unit, amount, unit_price?}], total, totalEx, subject, notes }）
  // → 明細行（cost = 読み取った金額。amount = 原価 × 利益率）。摘要も詳細も無い行は捨てる。マイナスの行（値引き）は原価を持たない販売行に
  function importItems(items) {
    const out = [];
    for (const it of Array.isArray(items) ? items : []) {
      if (!it || typeof it !== 'object') continue;
      const description = String(it.description == null ? '' : it.description).replace(/\s+/g, ' ').trim().slice(0, 200);
      const detail = String(it.detail == null ? '' : it.detail).replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!description && !detail) continue;
      const toN = v => { const n = Number(String(v == null ? '' : v).replace(/[,，¥￥円()（）\s]/g, '')); return Number.isFinite(n) ? n : 0; };
      let q = toN(it.quantity);
      if (!(q > 0)) q = 1;
      q = Math.round(q * 100) / 100;
      let amount = Math.round(toN(it.amount));
      if (!amount && toN(it.unit_price)) amount = Math.round(toN(it.unit_price) * q);
      if (Math.abs(amount) > 100000000000) continue;
      const unit = String(it.unit == null || it.unit === '' ? '式' : it.unit).trim().slice(0, 10) || '式';
      out.push({ description, detail, quantity: q, unit, amount });
      if (out.length >= IMPORT_MAX_ITEMS) break;
    }
    return out;
  }
  function importToLines(parsed, pct) {
    const items = importItems(parsed && parsed.items);
    return items.map(it => it.amount < 0
      ? newLine({ description: it.description, detail: it.detail, quantity: it.quantity, unit: it.unit, amount: it.amount })
      : newLine({ description: it.description, detail: it.detail, quantity: it.quantity, unit: it.unit, cost: it.amount, amount: marginPrice(it.amount, pct) }));
  }
  // 今の明細に読み込んだ行を足す: 中身の無い行（新規の空行）だけなら置き換え、あれば末尾に（諸経費の自動行・税対象外の行より前）
  function mergeImported(lines, added) {
    const cur = (lines || []).filter(isRealLine);
    if (!cur.length) return recalcShokehi(added.slice());
    const tailIdx = (lines || []).findIndex(l => l.isAutoShokehi || l.postTax);
    const ls = (lines || []).filter(l => isRealLine(l) || l.isAutoShokehi || l.postTax);
    const cut = tailIdx < 0 ? ls.length : ls.findIndex(l => l.isAutoShokehi || l.postTax);
    return recalcShokehi(ls.slice(0, cut).concat(added, ls.slice(cut)));
  }
  // 読み取った明細の合計と PDF の合計の照合（旧 verifyParse）。{ sum, ref, basis: 'ex'|'inc'|null, ok, gap }
  function verifyImport(items, total, totalEx) {
    const its = importItems(items);
    const sum = its.reduce((s, it) => s + it.amount, 0);
    const inc = Math.round(num(total)), ex = Math.round(num(totalEx));
    if (!its.length || (!inc && !ex)) return { sum, ref: 0, basis: null, ok: null, gap: 0 };
    const withTax = sum + Math.round(sum * TAX_RATE);
    if (ex && Math.abs(sum - ex) <= 1) return { sum, ref: ex, basis: 'ex', ok: true, gap: 0 };
    if (inc && Math.abs(sum - inc) <= 1) return { sum, ref: inc, basis: 'ex', ok: true, gap: 0 };
    if (inc && Math.abs(withTax - inc) <= 1) return { sum, ref: inc, basis: 'inc', ok: true, gap: 0 };
    const ref = ex || Math.round(inc / (1 + TAX_RATE));
    return { sum, ref, basis: 'ex', ok: false, gap: ref - sum };
  }

  // ── ブラウザ側の文字抽出（pdf.js の textContent → 行 → 正規表現）──────────────────
  // pages: [[{ str, x, y, w? }]]（1ページ = pdf.js の items。x, y は transform[4], transform[5]）。
  // 同じ高さ（±2.5pt）の文字を左から並べて1行に。離れた文字の間には空白を入れる
  function pdfTextLines(pages) {
    const out = [];
    for (const items of Array.isArray(pages) ? pages : []) {
      const rows = [];
      for (const it of Array.isArray(items) ? items : []) {
        const str = String((it && it.str) || '');
        if (!str.trim()) continue;
        const y = num(it.y), x = num(it.x);
        let row = rows.find(r => Math.abs(r.y - y) <= 2.5);
        if (!row) { row = { y, parts: [] }; rows.push(row); }
        row.parts.push({ x, w: num(it.w), str });
      }
      rows.sort((a, b) => b.y - a.y); // PDF の y は下から上
      for (const r of rows) {
        r.parts.sort((a, b) => a.x - b.x);
        let line = '', end = null;
        for (const p of r.parts) {
          if (line && (end === null || p.x - end > 1.5)) line += ' ';
          line += p.str;
          end = p.w ? p.x + p.w : null;
        }
        out.push(line.replace(/[ 　\t]+/g, ' ').trim());
      }
    }
    return out.filter(Boolean);
  }
  const UNITS_RE = '(?:人工|式|個|台|本|枚|セット|ヶ月|か月|ヵ月|回|人|箇所|ヶ所|件|組|冊|部|m2|m²|㎡|m|ｍ|㎝|cm|脚|面|棟|戸|ヵ所)';
  const NUM_RE = '\\d{1,3}(?:,\\d{3})*';
  const SKIP_EXACT = ['計', 'No', 'No.', '現場管理費合計'];
  const SKIP_SUBSTR = ['小計', '消費税', '請求金額', '見積金額', '合計', '内訳', '単価', '金額', '摘要', '数量', '明細金額', '税抜', '税込',
    '備考', '商品名', '品名', '総合計', '御見積金額', '請求合計', '税込合計', '税込金額'];
  const RE_A = new RegExp('^(.+?)\\s+(' + NUM_RE + ')\\s+(' + NUM_RE + ')(\\d+)\\s+(' + UNITS_RE + ')\\s*$'); // 摘要 単価 金額数量 単位（freee 形式）
  const RE_B = new RegExp('^(.+?)\\s+(\\d+)\\s*(' + UNITS_RE + ')\\s+(' + NUM_RE + ')\\s+(' + NUM_RE + ')\\s*$'); // 摘要 数量 単位 単価 金額
  const RE_C = new RegExp('^(.+?)\\s+(' + NUM_RE + ')\\s+(' + NUM_RE + ')\\s*$'); // 摘要 単価 金額
  const RE_D = new RegExp('^(.+?)\\s+\\((' + NUM_RE + ')\\)\\s*$'); // 摘要 (金額)
  const RE_E = new RegExp('^(.+?)\\s+.+\\s+\\((' + NUM_RE + ')\\)\\s*$'); // 摘要 説明 (金額)
  const normWord = s => String(s || '').replace(/[ 　]/g, '').trim();
  function skipDesc(d) {
    const n = normWord(d);
    if (!n) return true;
    if (SKIP_EXACT.includes(n) || n.toLowerCase() === 'no' || n.toLowerCase() === 'no.') return true;
    return SKIP_SUBSTR.some(k => n.includes(k));
  }
  const toInt = s => parseInt(String(s).replace(/,/g, ''), 10) || 0;
  const row = (description, quantity, unit, unitPrice, amount) => ({ description, detail: '', quantity, unit, unit_price: unitPrice, amount });
  function regexLine(line) {
    let m = RE_A.exec(line);
    if (m) {
      const d = m[1].trim();
      if (skipDesc(d)) return null;
      const amt = toInt(m[3]);
      return amt > 0 ? row(d, toInt(m[4]), m[5], toInt(m[2]), amt) : null;
    }
    m = RE_B.exec(line);
    if (m) {
      const d = m[1].trim();
      if (skipDesc(d)) return null;
      const amt = toInt(m[5]);
      return amt > 0 ? row(d, toInt(m[2]), m[3], toInt(m[4]), amt) : null;
    }
    m = RE_D.exec(line);
    if (m) {
      const d = m[1].trim();
      if (skipDesc(d) || d.length < 2) return null;
      const amt = toInt(m[2]);
      return amt > 0 ? row(d, 1, '式', amt, amt) : null;
    }
    m = RE_E.exec(line);
    if (m) {
      const d = m[1].trim();
      if (skipDesc(d) || d.length < 2) return null;
      const amt = toInt(m[2]);
      return amt > 0 ? row(d, 1, '式', amt, amt) : null;
    }
    m = RE_C.exec(line);
    if (m) {
      const d = m[1].trim();
      if (skipDesc(d) || d.length < 2) return null;
      const up = toInt(m[2]), amt = toInt(m[3]);
      return up > 0 && amt > 0 ? row(d, 1, '式', up, amt) : null;
    }
    return null;
  }
  // サマリー行（直後の4件以上の連続した行の合計と同じ金額の行）を除く（旧 _dedup_summary_items）
  function dedupSummary(items) {
    const idx = items.map((it, j) => (it.amount > 0 ? j : -1)).filter(j => j >= 0);
    if (idx.length < 3) return items;
    const amounts = idx.map(j => items[j].amount);
    const rm = new Set();
    for (let i = 0; i < amounts.length; i++) {
      let s = 0;
      for (let end = i + 1; end < amounts.length; end++) {
        s += amounts[end];
        if (s === amounts[i] && end - i >= 4) { rm.add(idx[i]); break; }
        if (s > amounts[i]) break;
      }
    }
    return items.filter((_, j) => !rm.has(j));
  }
  // 「本体＋税＝税込」が成り立つ3つ組から (税抜, 税込) を探す（旧 _extract_totals。ラベルは読まない）
  function extractTotals(text) {
    const nums = new Set();
    const re = /\d{1,3}(?:,\d{3})+|\d{4,}/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
      const v = toInt(m[0]);
      if (v >= 1000 && v <= 1e10) nums.add(v);
    }
    let best = { ex: 0, inc: 0 };
    for (const ex of nums) {
      for (const rate of [0.10, 0.08]) {
        for (const tax of new Set([Math.floor(ex * rate), Math.round(ex * rate)])) {
          const inc = ex + tax;
          if (nums.has(tax) && nums.has(inc) && inc > best.inc) best = { ex, inc };
        }
      }
    }
    return best;
  }
  const SUBJECT_RE = /(?:件名|工事件名|工事名称|工事名|物件名|案件名|現場名)[ 　：:]?\s*(.+)/;
  // 行の配列 → { items, total, totalEx, subject }（旧 Strategy 2）
  function parseEstimateText(lines) {
    const ls = (Array.isArray(lines) ? lines : String(lines || '').split('\n')).map(l => String(l).trim()).filter(l => l.length >= 2);
    const items = [], seen = new Set();
    for (const line of ls) {
      const it = regexLine(line);
      if (!it) continue;
      const key = it.description + '\u0000' + it.amount;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(it);
    }
    const text = ls.join('\n');
    const t = extractTotals(text);
    let subject = '';
    for (const l of ls) { const m = SUBJECT_RE.exec(l); if (m && m[1].replace(/^[\s　：:]+/, '').trim()) { subject = m[1].replace(/^[\s　：:]+/, '').trim().slice(0, 100); break; } }
    return { items: dedupSummary(items).slice(0, IMPORT_MAX_ITEMS), total: t.inc, totalEx: t.ex, subject };
  }

  // ── 検証 ───────────────────────────────────────────────────────────────────
  function validate(est) {
    const errors = [];
    const d = (est && est.data) || {};
    if (!String(d.client || '').trim()) errors.push('宛名を入力してください');
    if (!String(d.subject || '').trim()) errors.push('件名を入力してください');
    if (!isYmd(d.issueDate)) errors.push('見積日が正しくありません');
    if (!isYmd(d.validUntil)) errors.push('有効期限が正しくありません');
    else if (isYmd(d.issueDate) && d.validUntil < d.issueDate) errors.push('有効期限が見積日より前です');
    const real = ((est && est.lines) || []).filter(isRealLine);
    if (!real.length) errors.push('明細を1行以上入力してください');
    real.forEach((l, i) => {
      const label = `明細${i + 1}行目`;
      const q = Number(l.quantity);
      if (l.quantity === '' || !Number.isFinite(q) || q < 0) errors.push(`${label}: 数量が正しくありません`);
      if (!Number.isInteger(Number(l.amount || 0))) errors.push(`${label}: 金額は整数の円で入力してください`);
      if (l.isAutoShokehi && !(Number(l.shokehiPct) >= 0)) errors.push(`${label}: 諸経費の%が正しくありません`);
      if (hasCost(l) && !(Number.isInteger(Number(l.cost)) && Number(l.cost) >= 0)) errors.push(`${label}: 原価は0以上の整数の円で入力してください`);
    });
    return { ok: errors.length === 0, errors };
  }

  /* ---- Task 61: 他社の見積もり（Excel・CSV）の表 → 読み取り結果の items（importItems の形）---- */
  // 見出しの言葉 → 列の役割。摘要は必須、金額か単価のどちらかが要る
  const SHEET_HEADS = {
    description: ['摘要', '品名', '項目', '内容', '名称', '品目', '工事名'],
    quantity: ['数量', '員数', '個数'],
    unit: ['単位'],
    unit_price: ['単価'],
    amount: ['金額', '価格', '見積額']
  };
  const SHEET_ROLES = Object.keys(SHEET_HEADS);
  const SHEET_SCAN_ROWS = 30; // 見出しを探す行数（表の上に宛名・件名などがある）
  const cellText = v => String(v == null ? '' : v).replace(/[\s　]+/g, ' ').trim();
  // 見出しの文字 → 役割（無ければ ''）
  function sheetHeadRole(v) {
    const t = cellText(v).replace(/\s/g, '');
    if (!t || t.length > 12) return '';
    return SHEET_ROLES.find(r => SHEET_HEADS[r].some(w => t.includes(w))) || '';
  }
  // 数（"1,200" "¥3,000" "△500"（マイナス）・全角も）。読めなければ 0
  function sheetNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    let t = cellText(v).replace(/[０-９．－]/g, c => (c === '．' ? '.' : c === '－' ? '-' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0)));
    const neg = /^[△▲\-−]/.test(t) || /^\(.*\)$/.test(t);
    t = t.replace(/[^0-9.]/g, '');
    const n = Number(t);
    return t && Number.isFinite(n) ? (neg ? -n : n) : 0;
  }
  // 表（行の配列。各行はセルの配列）→ { header: 見出しの行の番号, cols: { description, quantity, unit, unit_price, amount }（無い役割は -1）} か null
  function detectColumns(rows) {
    const rs = Array.isArray(rows) ? rows : [];
    for (let r = 0; r < Math.min(rs.length, SHEET_SCAN_ROWS); r++) {
      const cols = { description: -1, quantity: -1, unit: -1, unit_price: -1, amount: -1 };
      (Array.isArray(rs[r]) ? rs[r] : []).forEach((c, i) => { const role = sheetHeadRole(c); if (role && cols[role] < 0) cols[role] = i; });
      if (cols.description >= 0 && (cols.amount >= 0 || cols.unit_price >= 0)) return { header: r, cols };
    }
    return null;
  }
  // 見出しの下の行 → items。摘要が空・小計／合計／消費税の行・金額も単価も無い行（見出しだけの行）は入れない。金額が無ければ 単価×数量
  const SHEET_SUM_RE = /^(小計|合計|総計|総合計|消費税|税込|税抜|御見積金額|お見積金額|見積金額)/;
  function rowsToItems(rows, m) {
    const rs = Array.isArray(rows) ? rows : [];
    const c = (m && m.cols) || {};
    const at = (row, k) => (c[k] >= 0 && Array.isArray(row) ? row[c[k]] : '');
    const out = [];
    for (let r = (m && m.header >= 0 ? m.header : -1) + 1; r < rs.length && out.length < IMPORT_MAX_ITEMS; r++) {
      const row = rs[r];
      const description = cellText(at(row, 'description')).slice(0, 200);
      if (!description || SHEET_SUM_RE.test(description.replace(/\s/g, ''))) continue;
      const qRaw = sheetNum(at(row, 'quantity'));
      const quantity = qRaw > 0 ? qRaw : 1;
      const price = sheetNum(at(row, 'unit_price'));
      let amount = c.amount >= 0 ? sheetNum(at(row, 'amount')) : 0;
      if (!amount && price) amount = Math.round(price * quantity);
      if (!amount) continue;
      out.push({ description, quantity, unit: cellText(at(row, 'unit')).slice(0, 10), unit_price: price, amount: Math.round(amount) });
    }
    return out;
  }
  // CSV の文字 → 行の配列（"…" の中のカンマ・改行・"" に対応。区切りはカンマ、1行目にカンマが無くタブがあればタブ）
  function parseCsv(text) {
    const t = String(text == null ? '' : text).replace(/^﻿/, '');
    const first = t.split(/\r?\n/, 1)[0] || '';
    const sep = !first.includes(',') && first.includes('\t') ? '\t' : ',';
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (q) {
        if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
      } else if (ch === '"' && cell === '') q = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && t[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  const api = {
    QUICK, NOTE_FIRST, TAX_RATE,
    todayStr, addDays,
    newLine, isRealLine, totals, withTotals,
    recalcShokehi, addShokehi, addQuick, adjustToHundred, adjustLine, isAdjustLine,
    unitPrice, commitAmount, normAmount,
    defaultNotes, buildNotes, KATAZUKE_PLACES, noteChoices, COND_ITEMS, conditions, timeRange,
    emptyEstimate, nextVersionFrom, diff,
    formatNumber, fileName, fmt, yen,
    hankoParts, hankoCols, validate,
    MARGIN_MAX, IMPORT_MAX_ITEMS, hasCost, normMargin, marginPrice, applyMargin, profitSummary, costTotals, importItems, importToLines, mergeImported, verifyImport,
    pdfTextLines, parseEstimateText, extractTotals, dedupSummary,
    SHEET_HEADS, sheetHeadRole, sheetNum, detectColumns, rowsToItems, parseCsv,
    PRESET_KINDS, PRESET_KIND_LABEL, PRESET_LABEL_MAX,
    presetAmount, presetTier, presetToLine, lineToPreset, presetDefaultLabel, validatePreset, presetKindsFor, presetsFor, groupPresets, nextPresetSort, movePreset
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EstimateLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
