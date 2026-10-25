// js/notice-logic.js — 工事掲示の文言・書式（画面に依存しない純粋関数）
// ブラウザ: window.NoticeLogic / node: module.exports
// 文言・挙動は旧「工事掲示PDF作成ツール」(/Users/s/koji-keiji-pdf/app.js) を一字一句そのまま移植している。
(function (root) {
  // 工事内容の選択肢。本文・注記の文言はここが唯一の定義元。extra を持つものはチェック時だけ自由記入欄が出る。
  const WORK_TYPES = [
    { key: 'noise',     label: '音が出る工事',               text: '作業中は騒音が発生いたします。' },
    { key: 'vibration', label: '振動がある工事',             text: '作業中は振動が発生いたします。' },
    { key: 'water',     label: '断水がある',                 text: '断水中はトイレ・浴室・キッチン・洗面台など、水回りのご使用をお控えください。' },
    { key: 'drain',     label: '排水制限がある',             text: '作業中はキッチン・浴室・洗面台・洗濯機など、排水を伴うご使用をお控えください。',
      extra: { id: 'drainRooms', label: '排水制限のかかる号室', placeholder: '例：501〜503号室、全戸' } },
    { key: 'traffic',   label: '通行制限がある',             text: '作業中は一部通行しにくい場合がございます。' },
    { key: 'odor',      label: '臭気が発生する可能性がある', text: '作業中は一時的に臭気が発生する可能性がございます。' },
    { key: 'other',     label: 'その他（自由記入）',         text: '',
      extra: { id: 'otherWorkText', label: 'その他の工事内容', placeholder: '例：高圧洗浄機を使用いたします' } }
  ];

  // 騒音と振動が同時選択されたときにまとめる文言
  const NOISE_VIBRATION_TEXT = '作業中は騒音・振動が発生いたします。';

  // 太字の箇所（Task 34）: 強調の設定は廃止し、次を常に太字・黒にする
  //   号室（件名・本文の「○○号室にて」・【工事場所】）… strongParts で切り出す
  //   【工事内容】の※注記・【排水制限】の行（号室を含む）… detailRows の strong / 呼び出し側で注記を太字
  // 保存済みデータの emphasis* は読まない（残っていても無視）

  // 決まり文句（旧 A:402-406）
  const FIXED_TEXTS = {
    greeting: '〜工事施工のご挨拶〜',
    opening: '拝啓　時下益々ご清栄のこととお慶び申し上げます。',
    closing: '敬具',
    ki: '記',
    contactTitle: 'お問い合わせ先'
  };

  const REQUIRED = [
    { id: 'propertyName', label: '物件名' },
    { id: 'roomNo',       label: '号室' },
    { id: 'workName',     label: '工事名称' }
  ];

  const DEFAULT_WORK_NAME = '工事';

  const defaultWorkTypes = () => {
    const o = {};
    WORK_TYPES.forEach(w => { o[w.key] = false; });
    return o;
  };

  // ---------- 小道具（旧 A:93-171） ----------
  function num(v) { const n = parseInt(v, 10); return isNaN(n) ? null : n; }

  // 「502」→「502号室」。すでに「号室」を含む場合は重複させない。
  function normalizeRoom(value) {
    const s = String(value || '').trim();
    if (!s) return '';
    if (/号室\s*$/.test(s)) return s.replace(/\s*$/, '');
    if (/号\s*$/.test(s)) return s.replace(/\s*$/, '') + '室';
    return s + '号室';
  }

  // 複数の号室向け。「501〜503」→「501〜503号室」。「全戸」のように数字で終わらない書き方はそのまま。
  function normalizeRooms(value) {
    const s = String(value || '').trim();
    if (!s) return '';
    return /[0-9０-９]$/.test(s) ? normalizeRoom(s) : s;
  }

  // 自由記入の文を本文用に整える。句点が無ければ足す。
  function asSentence(value) {
    const s = String(value || '').trim();
    if (!s) return '';
    return /[。．.！!？?]$/.test(s) ? s : s + '。';
  }

  // 「08:30」→「8:30」
  function formatTime(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    const m = s.match(/^(\d{1,2}):(\d{2})/);
    return m ? String(Number(m[1])) + ':' + m[2] : s;
  }

  function dateParts(v) {
    const p = String(v || '').split('-');
    if (p.length !== 3) return null;
    const y = num(p[0]), m = num(p[1]), day = num(p[2]);
    if (!y || !m || !day) return null;
    return { y, m, d: day, key: y * 10000 + m * 100 + day };
  }

  // ファイル名に使えない文字を置換
  function safeFileName(s) {
    return String(s || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[\x00-\x1f]/g, '')
      .replace(/\s+/g, '_')
      .replace(/^[.\s]+|[.\s]+$/g, '');
  }

  // ---------- 初期値・宛名 ----------
  // caseRow: 案件行（name を物件名に使う）。now はテスト用。
  function emptyData(caseRow, now) {
    now = now || new Date();
    return {
      propertyName: (caseRow && caseRow.name) || '',
      addressee: '', addresseeEdited: false,
      noticeYear: now.getFullYear(), noticeMonth: now.getMonth() + 1,
      noticeDay: '', noticeKichijitsu: true,
      workDate: '', workDateEnd: '', workDateTbd: false,
      timeStart: '', timeEnd: '', timePlanned: true,
      roomNo: '', workName: DEFAULT_WORK_NAME,
      workTypes: defaultWorkTypes(), drainRooms: '', otherWorkText: '', otherNotice: '',
      contact: { company: '', address: '', tel: '' },
      overrides: {}
    };
  }

  // 宛名は物件名から自動生成（旧 A:314-318）
  function autoAddressee(name) {
    const p = String(name || '').trim();
    return p ? p + 'に居住中の皆様へ' : '';
  }

  // 表示する宛名。手入力（addresseeEdited）優先、空なら自動生成、物件名も空ならプレースホルダ（旧 A:398）
  function addresseeText(data) {
    const auto = autoAddressee(data.propertyName);
    const typed = data.addresseeEdited ? String(data.addressee || '').trim() : '';
    return typed || auto || '（物件名）に居住中の皆様へ';
  }

  // ---------- 日付・時間 ----------
  function formatNoticeDate(d) {
    const y = num(d.noticeYear), m = num(d.noticeMonth);
    if (!y || !m) return '';
    const base = y + '年' + m + '月';
    if (d.noticeKichijitsu) return base + '吉日';
    const day = num(d.noticeDay);
    return day ? base + day + '日' : base;
  }

  // 1日なら「2026年9月9日」。期間なら「2026年9月7日 〜 9月9日」。年をまたぐときだけ終了日にも年を付ける。
  function formatWorkDate(d) {
    if (d.workDateTbd) return '未定';
    const s = dateParts(d.workDate);
    if (!s) return '未定';
    const start = s.y + '年' + s.m + '月' + s.d + '日';
    const e = dateParts(d.workDateEnd);
    // 終了日が無い・同じ日・開始より前なら1日だけの表示
    if (!e || e.key <= s.key) return start;
    return start + ' 〜 ' + (e.y !== s.y ? e.y + '年' : '') + e.m + '月' + e.d + '日';
  }

  function formatWorkTime(d) {
    const s = formatTime(d.timeStart), e = formatTime(d.timeEnd);
    if (!s && !e) return '';
    const t = s && e ? s + ' 〜 ' + e : (s || e);
    return d.timePlanned ? t + '（予定）' : t;
  }

  // ---------- 文章 ----------
  // 選択された工事内容だけを文章化する。未選択の文言は出さない（旧 A:176-194）
  function bodySentences(d) {
    const workTypes = d.workTypes || {};
    const out = [];
    if (workTypes.noise && workTypes.vibration) {
      out.push(NOISE_VIBRATION_TEXT);
    } else {
      if (workTypes.noise) out.push(WORK_TYPES[0].text);
      if (workTypes.vibration) out.push(WORK_TYPES[1].text);
    }
    WORK_TYPES.forEach(w => {
      if (w.key === 'noise' || w.key === 'vibration') return;
      if (!workTypes[w.key]) return;
      const t = w.key === 'other' ? asSentence(d.otherWorkText) : w.text;
      if (t) out.push(t);
    });
    return out.filter((t, i) => out.indexOf(t) === i);
  }

  // 注記は先頭「※」・末尾「。」除去（旧 A:197-199）
  function noteLines(d) {
    return bodySentences(d).map(t => '※' + t.replace(/。$/, ''));
  }

  // 第2・第3段落の定型文（旧 A:340-344）
  function fixedParagraphs() {
    return {
      second: ['近隣にお住まいの皆様にはご不便とご迷惑をおかけいたしますが、',
               '細心の注意を払いながら安全第一に工事を進めて参りますので、',
               'ご理解とご協力の程、宜しくお願いいたします。'],
      third: ['なお、何かお気づきの点がございましたら下記連絡先までご一報下さいます様、',
              '重ねて宜しくお願い申し上げます。']
    };
  }

  const roomLabel = d => normalizeRoom(d.roomNo) || '（号室）';
  const workNameLabel = d => String(d.workName || '').trim() || '（工事名称）';

  // 件名（旧 A:408）
  function subjectText(d) {
    return '「　' + roomLabel(d) + '　' + workNameLabel(d) + 'のお知らせ　」';
  }

  // 本文3段落（各段落は行の配列）。第1段落 = 導入文 + 注意文 + その他のお知らせ（旧 A:334-346）
  function bodyParagraphs(d) {
    const p1 = ['下記のとおり、' + roomLabel(d) + 'にて' + workNameLabel(d) + 'を実施いたします。']
      .concat(bodySentences(d));
    String(d.otherNotice || '').split(/\r?\n/).forEach(t => {
      if (t.trim()) p1.push(t.trim());
    });
    const f = fixedParagraphs();
    return [p1, f.second, f.third];
  }

  // 文を [{ text, strong }] に分ける。号室（roomLabel。空ならプレースホルダ）の所だけ strong
  function strongParts(text, d) {
    const s = String(text == null ? '' : text);
    const room = roomLabel(d);
    const out = [];
    let i = 0;
    for (;;) {
      const j = s.indexOf(room, i);
      if (j < 0) break;
      if (j > i) out.push({ text: s.slice(i, j), strong: false });
      out.push({ text: room, strong: true });
      i = j + room.length;
    }
    if (i < s.length || !out.length) out.push({ text: s.slice(i), strong: false });
    return out;
  }

  // 記書きの行（旧 A:430-439）。strong: 行全体を太字（【排水制限】）。※注記は常に太字（呼び出し側）
  function detailRows(d) {
    const rows = [];
    const propertyText = String(d.propertyName || '').trim() || '（物件名）';
    rows.push({ key: 'place', label: '【工事場所】', value: propertyText + '　' + roomLabel(d), notes: [], strong: false });
    rows.push({ key: 'content', label: '【工事内容】', value: workNameLabel(d), notes: noteLines(d), strong: false });
    // 排水制限は号室を書いたときだけ独立した行にする
    if (d.workTypes && d.workTypes.drain) {
      const drainText = normalizeRooms(d.drainRooms);
      if (drainText) rows.push({ key: 'drain', label: '【排水制限】', value: drainText, notes: [], strong: true });
    }
    rows.push({ key: 'date', label: '【工事日】', value: formatWorkDate(d), notes: [], strong: false });
    const timeText = formatWorkTime(d);
    if (timeText) rows.push({ key: 'time', label: '【作業時間】', value: timeText, notes: [], strong: false });
    return rows;
  }

  // ---------- ファイル名・検証 ----------
  // 工事掲示_{物件名}_{号室}_{工事日}.pdf（旧 A:757-762）。物件名が空なら案件名
  function fileName(d, caseName) {
    const dateText = formatWorkDate(d).replace(/\s+/g, '');
    // 物件名は前後の空白を落とす（空白だけなら案件名）。空白のまま safeFileName に渡すと先頭末尾が _ になる
    const name = String(d.propertyName || '').trim() || String(caseName || '').trim();
    return '工事掲示_' + safeFileName(name) + '_' +
      safeFileName(normalizeRoom(d.roomNo)) + '_' + safeFileName(dateText) + '.pdf';
  }

  // 必須: 物件名・号室・工事名称（旧 A:681-696）
  function validate(d) {
    const missing = REQUIRED.filter(r => !String(d[r.id] || '').trim());
    return {
      ok: missing.length === 0,
      missing,
      message: missing.length ? '必須項目が未入力です：' + missing.map(m => m.label).join('、') : ''
    };
  }

  const api = {
    WORK_TYPES, NOISE_VIBRATION_TEXT, FIXED_TEXTS, REQUIRED,
    emptyData, autoAddressee, addresseeText,
    bodySentences, noteLines, bodyParagraphs, fixedParagraphs, subjectText, detailRows, strongParts,
    formatNoticeDate, formatWorkDate, formatWorkTime,
    normalizeRoom, normalizeRooms, asSentence, safeFileName,
    fileName, validate
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NoticeLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
