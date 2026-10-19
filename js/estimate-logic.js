// js/estimate-logic.js — 見積書の純粋関数（ブラウザ: window.EstimateLogic / node: module.exports）
// 旧「見積書作成ツール」(freee-quote-builder/templates/invoice.html) の計算・文言を写している。
// 金額は整数円・四捨五入（Math.round）。紙面計算 renderPaper が唯一の正:
//   subtotal = postTax 以外の amount 合計 / tax = round(subtotal*0.1) / total = subtotal + tax + postTax 合計
// 明細行の形: { id, description, detail, quantity, unit, amount, isAutoShokehi?, shokehiPct?, postTax?, isAdjust? }
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
  // notes = { koki:{on,val}, jikan:{on,val}, nimotsu:{on,val}, extra }（est.data.notes。data ごとでも可）
  function defaultNotes() {
    return { koki: { on: false, val: '3' }, jikan: { on: false, val: '' }, nimotsu: { on: false, val: '' }, extra: '' };
  }
  function buildNotes(notes) {
    let n = notes || {};
    if (n.notes && typeof n.notes === 'object') n = n.notes;
    const out = [NOTE_FIRST];
    const opts = [['koki', '工期'], ['jikan', '工事時間'], ['nimotsu', '荷物の移動依頼']];
    opts.forEach(([key, label]) => {
      const o = n[key];
      if (!o || !o.on) return;
      let text = o.val == null ? '' : String(o.val).trim();
      if (key === 'koki' && text) text = `${parseInt(text, 10) || 0}日間`;
      out.push(text ? `${label}：${text}` : `${label}：`);
    });
    const extra = n.extra == null ? '' : String(n.extra);
    if (extra.trim()) out.push(extra.trim());
    return out.join('\n');
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
  // 定型 → 明細行（新しい id）。unitPrice があれば 金額 = 単価×数量。税対象外・諸経費の自動行にはしない
  function presetToLine(preset) {
    const src = preset && preset.line && typeof preset.line === 'object' ? preset.line : (preset || {});
    const q = finite(src.quantity) && Number(src.quantity) >= 0 ? Number(src.quantity) : 1;
    const amount = finite(src.unitPrice) ? Math.round(Number(src.unitPrice) * q) : Math.round(num(src.amount));
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
  // 見積のフェーズの種類に合う定型（その種類 → 共通の順。種類の中は sort → 作成順）
  function presetKindsFor(phaseKind) {
    return ['survey', 'cause', 'repair'].includes(phaseKind) ? [phaseKind, 'common'] : ['common'];
  }
  const presetOrder = (a, b) => (num(a.sort) - num(b.sort)) || String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id || '').localeCompare(String(b.id || ''));
  function presetsFor(presets, phaseKind) {
    const kinds = presetKindsFor(phaseKind);
    return (presets || []).filter(p => p && kinds.includes(p.kind))
      .sort((a, b) => (kinds.indexOf(a.kind) - kinds.indexOf(b.kind)) || presetOrder(a, b));
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
  // ↑↓: 同じ種類の中で dir（-1 / 1）へ1つ動かす。返り値は sort を変える行だけ [{ id, sort }]（並び = 0,1,2… に振り直す）
  function movePreset(presets, id, dir) {
    const me = (presets || []).find(p => p && p.id === id);
    if (!me) return [];
    const list = (presets || []).filter(p => p && p.kind === me.kind).sort(presetOrder);
    const i = list.findIndex(p => p.id === id), j = i + dir;
    if (j < 0 || j >= list.length) return [];
    [list[i], list[j]] = [list[j], list[i]];
    return list.map((p, k) => ({ id: p.id, sort: k, old: num(p.sort) })).filter(x => x.sort !== x.old).map(x => ({ id: x.id, sort: x.sort }));
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
    });
    return { ok: errors.length === 0, errors };
  }

  const api = {
    QUICK, NOTE_FIRST, TAX_RATE,
    todayStr, addDays,
    newLine, isRealLine, totals, withTotals,
    recalcShokehi, addShokehi, addQuick, adjustToHundred, adjustLine, isAdjustLine,
    unitPrice, commitAmount, normAmount,
    defaultNotes, buildNotes,
    emptyEstimate, nextVersionFrom, diff,
    formatNumber, fileName, fmt, yen,
    hankoParts, hankoCols, validate,
    PRESET_KINDS, PRESET_KIND_LABEL, PRESET_LABEL_MAX,
    presetToLine, lineToPreset, presetDefaultLabel, validatePreset, presetKindsFor, presetsFor, groupPresets, nextPresetSort, movePreset
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EstimateLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
