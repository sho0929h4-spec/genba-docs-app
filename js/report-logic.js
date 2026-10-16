// js/report-logic.js — 報告書の区分定義・入力チェック・PDF結果表・メール文面（画面に依存しない純粋関数）
// ブラウザ: window.ReportLogic / node: module.exports
// 選択肢・文言は旧ツール（claude code/report-tool/index.html）から写したもの。行番号はコメントに記載
(function (root) {
  /* ---- 旧ツール 432–435行 ---- */
  const INV_ITEMS = ['目視確認', '耐圧テスト（給水管）', '耐圧テスト（給湯管）', 'スコープカメラ調査', '開口調査', '排水テスト', '給湯管更新・交換', '給水管更新・交換', '配管修繕', '水栓交換', '開口補修・復旧', '防水工事'];
  const RESTORE_PLACES = ['廊下', 'キッチン', '洗面所', '浴室', 'トイレ', '居室', 'ベランダ'];
  const RESTORE_PARTS = ['天井', '壁', '床', 'ダウンライト'];
  const AFTER_STATUS = ['正常に復旧', '様子見（経過観察）', '一部未完了（再訪予定）', '要追加工事'];

  /* ---- 旧ツール 296–299行（漏水の状況）・305–309行（漏水時の対応。value と表示が違うのは元栓だけ） ---- */
  const LEAK_STATUS = ['止まっている', '漏れている（継続的）', '漏れている（断続的）'];
  const LEAK_ACTIONS = [
    { value: '養生対応済み', label: '養生対応済み' },
    { value: 'すでに養生対応済み', label: 'すでに養生対応済み' },
    { value: '入居者希望により養生せず', label: '入居者希望により養生せず' },
    { value: '元栓閉め', label: '元栓を閉めた' }
  ];
  const LEAK_ACTION_MAIN_VALVE = '元栓閉め';

  /* ---- 旧ツール 438–468行 ---- */
  const WORK_CHECKLISTS = {
    investigate: [
      '入居者へ水をこぼしていないかヒアリングし、現場と整合するか確認した',
      '作業で出たゴミ・チリの清掃を終えた',
      '写真の手ブレがないか確認した',
      '不具合のある設備の型番・年式が分かる写真を撮影した'
    ],
    repair: [
      '設備の動作確認をした（通水・通電・排水など）',
      '交換・修繕箇所から漏れ・不具合がないか確認した',
      '既存設備の型番・年式が分かる写真を撮影した',
      '作業で出たゴミ・チリの清掃を終えた',
      '入居者へ作業内容を説明し、現場と整合するか確認した',
      '写真の手ブレがないか確認した'
    ],
    restore: [
      '施工範囲の養生・下地処理を適切に行った',
      '作業前・作業中・作業後の写真を撮影した',
      '使用材料・色・仕上げが既存と調和している',
      '乾燥・硬化時間を確保した（塗装・防水など）',
      '作業で出たゴミ・チリの清掃・原状回復をした',
      '入居者へ作業完了を説明し、現場と整合するか確認した',
      '写真の手ブレがないか確認した'
    ]
  };
  const KEY_CHECKLIST = [
    '鍵を借りた（借りていない場合はチェック不要）',
    '鍵を返却した',
    '返却時の写真をアップロードした'
  ];

  /* ---- 旧ツール 521–522行 ---- */
  const PHASES = { '': '— フェーズ —', before: '対応前', investigating: '対応中', done: '対応後', wbefore: '作業前', wduring: '作業中', wafter: '作業後', yojo: '養生' };
  const PHASE_COLORS = { before: '#2563eb', investigating: '#ea580c', done: '#0d9488', wbefore: '#2563eb', wduring: '#ea580c', wafter: '#0d9488', yojo: '#7c3aed' };

  /* ---- 旧ツールの入力欄の文言（289–359行・655行） ---- */
  const FREE_CHIP = '自由記載'; // 自由記載チップ。data の配列に入っていれば ON
  const TEXT = {
    f1Hint: '実施した作業・調査の詳細・手順・確認箇所など',
    leakLabel: '漏水の状況',
    leakActionLabel: '漏水時の対応',
    leakRoomPlaceholder: '号室（例：605）',
    afterLabel: '対応後の状況',
    afterNotePlaceholder: '補足（任意・自由記載）',
    f2Label: '原因',
    f2Hint: '特定できた場合のみ。不明な場合は次の対応方針へ。',
    reasonLabel: '原因と判断した理由',
    reasonHint: 'そう判断した根拠・確認した事実など（自由記載）',
    f4Label: '次の対応方針',
    f4Hint: '原因不明時や追加工事が必要な場合の方針',
    ctxPhotoHint: 'ここで追加した写真は下の「作業写真」にまとまります',
    selectPlaceholder: '— 選択してください —',
    freePlaceholder: '自由記載',
    checklistTitle: 'チェックリスト',
    workChecklistTitle: '作業チェックリスト',
    keyChecklistTitle: '鍵の取り扱い（借りた場合のみ）',
    keyReturnLabel: '鍵の返却方法',
    keyReturnPlaceholder: '例：管理会社へ手渡し／ポスト投函　※返却がない場合は空欄',
    photoCaptionPlaceholder: 'キャプション（例：玄関から居室方向を撮影）',
    noData: '記録なし'
  };

  /* ---- 旧ツール 470–519行（MODES）。checkGroups の field / freeField は新アプリの data のキー ---- */
  const MODES = {
    investigate: {
      label: '調査',
      checkCardTitle: '作業実施項目', contentCardTitle: '作業内容',
      checkGroups: [{ title: null, items: INV_ITEMS, free: true, freePrefix: 'その他', field: 'items', freeField: 'itemsFree' }],
      f1Label: '作業実施内容', f1Req: true,
      showLeak: true, showAfter: false, showF2: true, showReason: true, showF4: true,
      f1ph: '例：605号室キッチン脇のダウンライトまわりから漏水を確認。給水管の耐圧テストを実施。',
      ctxPhotoLabel: '原因箇所の写真',
      rSection: '調査結果',
      rRows: [
        { label: '作業実施内容', field: 'f1' },
        { label: '漏水の状況', field: 'leak' },
        { label: '漏水時の対応', field: 'leakAction' },
        { label: '原　因', field: 'f2' },
        { label: '原因と判断した理由', field: 'reason' },
        { label: '次の対応方針', field: 'f4', next: true }
      ]
    },
    repair: {
      label: '設備修繕',
      checkCardTitle: null, contentCardTitle: '作業内容',
      checkGroups: [],
      f1Label: '作業実施内容', f1Req: true,
      showLeak: false, showAfter: true, showF2: false, showReason: false, showF4: false,
      f1ph: '例：既存給湯管を撤去し新規樹脂管（16mm）に更新。接続部の防水処理を実施。通水確認済み。漏水なし。',
      ctxPhotoLabel: '年式・型番が分かる写真',
      rSection: '作業結果',
      rRows: [
        { label: '作業実施内容', field: 'f1' },
        { label: '対応後の状況', field: 'afterStatus' }
      ]
    },
    restore: {
      label: '復旧工事',
      checkCardTitle: '施工範囲', contentCardTitle: '作業内容',
      checkGroups: [
        { title: '場所', items: RESTORE_PLACES, free: true, freePrefix: '場所その他', field: 'scopePlaces', freeField: 'scopePlaceFree' },
        { title: '部位', items: RESTORE_PARTS, free: true, freePrefix: '部位その他', field: 'scopeParts', freeField: 'scopePartFree' }
      ],
      f1Label: '申し送り', f1Req: false,
      showLeak: false, showAfter: false, showF2: false, showReason: false, showF4: false,
      f1ph: '入居者からの伝達事項・引き継ぎ事項などがあれば記載',
      ctxPhotoLabel: '作業前・作業中・作業後・養生の写真',
      rSection: '作業結果',
      rRows: [
        { label: '申し送り', field: 'f1' }
      ]
    }
  };
  const WORK_TYPE_LABEL = { investigate: '調査', repair: '設備修繕', restore: '復旧工事' };
  const STATUS_LABEL = { draft: '下書き', submitted: '提出済み・確認待ち', confirmed: '確認済み', sent: '依頼者へ送付済み' };

  const modeOf = wt => MODES[wt] || MODES.investigate;
  const str = v => (v == null ? '' : String(v));
  const trim = v => str(v).trim();
  const arr = v => (Array.isArray(v) ? v : []);

  function emptyData() {
    return {
      items: [], itemsFree: '', f1: '', leak: '', leakAction: '', leakRoom: '', reason: '', f2: '', f4: '',
      afterSel: '', afterNote: '', scopePlaces: [], scopePlaceFree: '', scopeParts: [], scopePartFree: '',
      workChecklist: [], keyChecklist: [], keyReturn: ''
    };
  }
  // 欠けたキーを初期値で補う（古い下書きや協力業者の提出でも落ちないように）
  function normalizeData(data) {
    return Object.assign(emptyData(), data && typeof data === 'object' ? data : {});
  }

  // 旧 getLeakAction（629–633行）。「漏れている〜」以外では対応は出さない（旧 onLeakChange 620–622行で空にしていた）
  function leakActionText(d) {
    if (!str(d.leak).startsWith('漏れている')) return '';
    let v = trim(d.leakAction);
    if (v === LEAK_ACTION_MAIN_VALVE) {
      const rm = trim(d.leakRoom).replace(/号室$/, '');
      v = (rm ? rm + '号室' : '') + LEAK_ACTION_MAIN_VALVE;
    }
    return v;
  }
  // 旧 getAfterStatus（803–807行）
  const afterStatusText = d => [trim(d.afterSel), trim(d.afterNote)].filter(Boolean).join('　');

  // 旧 getCheckedItems（667–677行）: グループ順・定義順、自由記載は最後に `接頭辞: 本文`（本文なしは接頭辞だけ）
  function chipsForPdf(report) {
    const cfg = modeOf(report.work_type);
    const d = normalizeData(report.data);
    const out = [];
    cfg.checkGroups.forEach(g => {
      const sel = arr(d[g.field]);
      g.items.forEach(it => { if (sel.includes(it)) out.push(it); });
      sel.forEach(v => { if (v !== FREE_CHIP && !g.items.includes(v) && trim(v)) out.push(v); }); // 定義外の値も落とさない
      if (g.free) {
        const t = trim(d[g.freeField]);
        if (t) out.push(`${g.freePrefix}: ${t}`);
        else if (sel.includes(FREE_CHIP)) out.push(g.freePrefix);
      }
    });
    return out;
  }

  // 旧 validate（750–771行）。物件名は案件から来るので対象外
  function validate(report) {
    const errors = [], warnings = [];
    const cfg = modeOf(report.work_type);
    const d = normalizeData(report.data);
    if (!trim(report.room)) errors.push('号室が未入力です');
    if (!trim(report.work_date)) errors.push('作業日が未入力です');
    if (cfg.f1Req && !trim(d.f1)) errors.push(`「${cfg.f1Label}」が未入力です`);
    if (cfg.checkGroups.length > 0 && chipsForPdf(report).length === 0) warnings.push(`${cfg.checkCardTitle}が1件も選択されていません`);
    if (arr(report.photos).length === 0) warnings.push('写真が1枚もアップロードされていません');
    const ts = trim(report.time_start), te = trim(report.time_end);
    if (!ts) warnings.push('作業開始時刻が未入力です');
    if (ts && te && te < ts) errors.push('作業終了時間が開始時間より前になっています');
    return { errors, warnings };
  }

  // 旧 buildReportContent の resultRows（998–1002行）: rRows の並び・値がない行は出さない
  function resultRows(report) {
    const cfg = modeOf(report.work_type);
    const d = normalizeData(report.data);
    const vals = {
      f1: trim(d.f1), f2: trim(d.f2), f4: trim(d.f4), reason: trim(d.reason),
      leak: trim(d.leak), leakAction: leakActionText(d), afterStatus: afterStatusText(d)
    };
    return cfg.rRows
      .map(r => ({ label: r.label, value: vals[r.field] || '', next: !!r.next }))
      .filter(r => r.value);
  }

  /* ---- 日付・時刻（曜日は UTC で計算してタイムゾーンに依存しない） ---- */
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  function parseYmd(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(trim(ymd));
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    return { y, m: mo, d, wd: WD[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()] };
  }
  // 旧 fmtDate（1124行）と同じ形
  function fmtDateJa(ymd) {
    const p = parseYmd(ymd);
    return p ? `${p.y}年${p.m}月${p.d}日（${p.wd}）` : '';
  }
  // 旧 collectData の timeStr（776行）
  function timeRange(start, end) {
    const ts = trim(start), te = trim(end);
    return ts && te ? `${ts} 〜 ${te}` : ts ? `${ts} 〜` : '';
  }

  // 旧 downloadPDF（948–949行）+ propFull（994行）。ファイル名に使えない文字は _ に
  function fileName(caseName, room) {
    const base = [trim(caseName), trim(room)].filter(Boolean).join('　');
    return `【報告書】${base.replace(/[\\/:*?"<>|]/g, '_')}.pdf`;
  }

  /* ---- 送付メール（ワイヤーフレーム⑨） ---- */
  const PDF_LINK = '{{PDF_LINK}}';
  // 差し込む値からマーカー文字列を除いて、本文中の {{PDF_LINK}} を1個だけにする
  // 1回の除去では入れ子（{{PDF_{{PDF_LINK}}LINK}}）で再生成されるので、消えるまで繰り返す
  const stripMarker = v => { let x = str(v); while (x.includes(PDF_LINK)) x = x.split(PDF_LINK).join(''); return x; };
  const t = v => stripMarker(v).trim();
  const oneLine = v => t(v).replace(/\s*\r?\n\s*/g, ' ');
  function buildMail({ caseRow, org, report }) {
    caseRow = caseRow || {}; org = org || {}; report = report || {};
    const cfg = modeOf(report.work_type);
    const wt = MODES[report.work_type] ? report.work_type : 'investigate';
    const d = normalizeData(report.data);
    const prop = [t(caseRow.name), t(report.room)].filter(Boolean).join(' ');
    const p = parseYmd(report.work_date);
    const orgName = t(org.name);
    // 導入文の語: 調査で漏水の状況が入っているときだけ「漏水調査」（⑨）、それ以外は区分名
    const workPhrase = cfg.showLeak && t(d.leak) ? '漏水調査' : WORK_TYPE_LABEL[wt];

    const subject = `【作業報告書】${prop}（${[p ? `${p.m}/${p.d}` : '', WORK_TYPE_LABEL[wt]].filter(Boolean).join(' ')}）`;

    const facts = [];
    if (p) {
      const ts = t(report.time_start), te = t(report.time_end);
      const time = ts ? `${ts}〜${te}` : '';
      facts.push(`■ 作業日　${p.m}月${p.d}日（${p.wd}）${time}`);
    }
    if (cfg.showF2 && oneLine(d.f2)) facts.push(`■ 原因　　${oneLine(d.f2)}`);
    if (cfg.showF4 && oneLine(d.f4)) facts.push(`■ 次の対応　${oneLine(d.f4)}`);

    const sign = [orgName, [t(org.address), t(org.tel)].filter(Boolean).join(' ／ '), t(org.email)].filter(Boolean);

    const lines = [
      t(caseRow.client_name) ? `${t(caseRow.client_name)} ご担当者様` : 'ご担当者様',
      '',
      `いつもお世話になっております。${orgName ? orgName + 'です。' : ''}`,
      `${prop}の${workPhrase}が完了しましたので、作業報告書をお送りいたします。`,
      ''
    ];
    if (facts.length) lines.push(...facts, '');
    lines.push(PDF_LINK, '', 'ご確認のほどよろしくお願いいたします。', '', '――――――――――', ...sign);

    return { to: t(caseRow.client_email), subject, body: lines.join('\n') };
  }

  // 日本語は1文字≒9文字に符号化される。iOS Mail / macOS Mail / Gmail のハンドラは数千文字の mailto を開けるので 8000 まで許す
  const MAILTO_MAX = 8000;
  const SHORT_NOTE = '詳細は添付リンクをご確認ください。';
  const encBody = b => encodeURIComponent(str(b).replace(/\r?\n/g, '\r\n'));
  function mailtoRaw(to, cc, subject, body) {
    const addr = trim(to).split(/\s*,\s*/).filter(Boolean).map(a => encodeURIComponent(a).replace(/%40/g, '@')).join(',');
    const q = [];
    if (trim(cc)) q.push('cc=' + encodeURIComponent(trim(cc)));
    q.push('subject=' + encodeURIComponent(str(subject)));
    q.push('body=' + encBody(body));
    return `mailto:${addr}?${q.join('&')}`;
  }
  // body は {{PDF_LINK}} を含んだまま渡し、link（例「報告書PDF: URL」）で差し込む。
  // 長すぎる URL はメールアプリ側で切れるので、本文を短縮（宛名・{{PDF_LINK}} の行は残す）。
  // 第1段階: 宛名 / 詳細は〜 / リンク行、第2段階: 宛名も落とす
  // 戻り値は { url, shortened }。shortened = 本文を短縮した（全文は入っていない）
  function buildMailto({ to, cc, subject, body, link }) {
    // link が無い（null/空）ときはマーカー行ごと除去し、直後の空行（末尾なら直前の空行）も詰める
    const fill = b => {
      if (trim(link)) return b.split(PDF_LINK).join(str(link));
      const ls = b.split(/\r?\n/), out = [];
      for (let i = 0; i < ls.length; i++) {
        if (!ls[i].includes(PDF_LINK)) { out.push(ls[i]); continue; }
        if (ls[i + 1] === '') i++;
      }
      while (out.length && out[out.length - 1] === '') out.pop(); // 末尾がマーカーだったときの空行
      return out.join('\n');
    };
    const build = b => mailtoRaw(to, cc, subject, fill(b));
    const full = build(str(body));
    if (full.length <= MAILTO_MAX) return { url: full, shortened: false };
    const ls = str(body).split(/\r?\n/);
    const links = ls.filter(l => l.includes(PDF_LINK));
    const tail = links.length ? ['', ...links] : [];
    const withName = build([ls[0], '', SHORT_NOTE, ...tail].join('\n'));
    if (withName.length <= MAILTO_MAX) return { url: withName, shortened: true };
    return { url: build([SHORT_NOTE, ...tail].join('\n')), shortened: true };
  }
  // 互換: URL 文字列だけ返す
  function mailtoUrl(opts) { return buildMailto(opts).url; }

  const statusLabel = s => STATUS_LABEL[s] || str(s);

  const api = {
    MODES, WORK_TYPE_LABEL, STATUS_LABEL, INV_ITEMS, RESTORE_PLACES, RESTORE_PARTS, AFTER_STATUS,
    LEAK_STATUS, LEAK_ACTIONS, LEAK_ACTION_MAIN_VALVE, WORK_CHECKLISTS, KEY_CHECKLIST, PHASES, PHASE_COLORS, FREE_CHIP, TEXT, PDF_LINK,
    emptyData, normalizeData, validate, resultRows, chipsForPdf, fmtDateJa, timeRange, fileName,
    buildMail, mailtoUrl, buildMailto, statusLabel
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReportLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
