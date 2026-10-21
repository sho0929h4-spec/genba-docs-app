// js/report-logic.js — 報告書の区分定義・入力チェック・PDF結果表・メール文面（画面に依存しない純粋関数）
// ブラウザ: window.ReportLogic / node: module.exports
// 選択肢・文言は旧ツール（claude code/report-tool/index.html）から写したもの。行番号はコメントに記載
(function (root) {
  /* ---- 旧ツール 432–435行 ---- */
  // INV_ITEMS は旧ツールの作業実施項目（古い報告書 data.items の表示用だけ。新しい入力では使わない。Task 20）
  const INV_ITEMS = ['目視確認', '耐圧テスト（給水管）', '耐圧テスト（給湯管）', 'スコープカメラ調査', '開口調査', '排水テスト', '給湯管更新・交換', '給水管更新・交換', '配管修繕', '水栓交換', '開口補修・復旧', '防水工事'];
  /* ---- Task 20（2026-10-20 ユーザー指示）: 調査の作業実施項目は次の7つだけ（その他 = 自由記載の欄。data.workItems / workItemOther） ---- */
  const WORK_ITEM_OTHER = 'その他';
  const INV_WORK_ITEMS = ['目視確認', '排水テスト', '耐圧テスト', '養生対応', 'PS内漏れ確認', '開口調査', WORK_ITEM_OTHER];
  // 原因（複数選択。data.causes = [{ key, detail }]）。input: detail = 選んだときだけ出る1行の「詳細」、
  //   tenant = 入居者やらかしの「理由」（data.causeTenantReason）、other = 自由記載（data.causeOther）
  const CAUSES = [
    { key: 'tenant', label: '入居者やらかし', input: 'tenant' },
    { key: 'hot_pipe', label: '給湯管' },
    { key: 'water_pipe', label: '給水管' },
    { key: 'washer', label: '洗濯機', input: 'detail' },
    { key: 'toilet', label: 'トイレ', input: 'detail' },
    { key: 'kitchen', label: 'キッチン', input: 'detail' },
    { key: 'washroom', label: '洗面所', input: 'detail' },
    { key: 'bath', label: '浴室', input: 'detail' },
    { key: 'balcony', label: 'ベランダ', input: 'detail' },
    { key: 'other', label: 'その他', input: 'other' }
  ];
  const CAUSE_KEYS = CAUSES.map(c => c.key);
  // 次の対応方針（1つ選ぶ。data.nextAction = { type, estimateDue, reason, detail, other }）
  const NEXT_ACTIONS = [
    { key: 'cause', label: '原因元工事' },
    { key: 'resurvey', label: '再調査' },
    { key: 'other', label: 'その他' }
  ];
  const NEXT_KEYS = NEXT_ACTIONS.map(n => n.key);
  // お部屋の状況（Task 21 追加。任意。data.roomStatus = { luggage: 'many'|'few'|null, pet: true|false|null, residents: 0〜20|null }）
  const ROOM_LUGGAGE = [{ key: 'many', label: '多い' }, { key: 'few', label: '少ない' }];
  const ROOM_PET = [{ key: true, label: 'あり' }, { key: false, label: 'なし' }];
  const RESIDENTS_MAX = 20;
  // 報告書の作業区分はフェーズの種類で決まる（調査→調査／原因元工事→設備修繕／復旧工事→復旧工事。Task 20）
  const WORK_TYPE_OF_PHASE = { survey: 'investigate', cause: 'repair', repair: 'restore' };
  const RESTORE_PLACES = ['廊下', 'キッチン', '洗面所', '浴室', 'トイレ', '居室', 'ベランダ'];
  const RESTORE_PARTS = ['天井', '壁', '床', 'ダウンライト'];
  const AFTER_STATUS = ['正常に復旧', '様子見（経過観察）', '一部未完了（再訪予定）', '要追加工事'];
  // Task 26: 「正常に復旧」以外は理由（自由記載・必須）。データは今までの自由記載 data.afterNote をそのまま使う（正常に復旧のときは任意の補足）
  const AFTER_OK = '正常に復旧';
  const afterNeedsReason = d => { const v = trim((d || {}).afterSel); return !!v && v !== AFTER_OK; };

  /* ---- 旧ツール 296–299行（漏水の状況）・305–309行（漏水時の対応。value と表示が違うのは元栓だけ） ---- */
  const LEAK_STATUS = ['止まっている', '漏れている（継続的）', '漏れている（断続的）'];
  const LEAK_ACTIONS = [
    { value: '養生対応済み', label: '養生対応済み' },
    { value: 'すでに養生対応済み', label: 'すでに養生対応済み' },
    { value: '入居者希望により養生せず', label: '入居者希望により養生せず' },
    { value: '元栓閉め', label: '元栓を閉めた' },
    // Task 21: その他（選ぶと1行の自由記載 data.leakActionOther。PDF にはその文を出す）
    { value: 'その他', label: 'その他（自由記載）' }
  ];
  const LEAK_ACTION_MAIN_VALVE = '元栓閉め';
  const LEAK_ACTION_OTHER = 'その他';

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
  // 旧ツールの鍵の3項目（古い報告書 data.keyChecklist の読み替え用だけ。新しい入力は data.keyBorrowed / keyReturned。Task 21）
  const KEY_CHECKLIST = [
    '鍵を借りた（借りていない場合はチェック不要）',
    '鍵を返却した',
    '返却時の写真をアップロードした'
  ];
  // Task 21: 鍵の取り扱いは「鍵を借りた」を押したときだけ、返却のチェック・返却時の写真（区分「鍵返却」）・コメントを出す
  const KEY_TEXT = { borrowed: '鍵を借りた（借りた場合だけ）', borrowedPdf: '鍵を借りた', returned: '鍵を返却した' };

  /* ---- 写真の区分（Task 21: 作業前／作業中／作業後／鍵返却／自由記載 の5つだけ。自由記載は photo.phaseNote に文字） ---- */
  const PHOTO_FREE = 'free';
  const PHOTO_KEY = 'key';
  const PHASES = { '': '— 区分 —', wbefore: '作業前', wduring: '作業中', wafter: '作業後', key: '鍵返却', free: '自由記載' };
  const PHASE_COLORS = { wbefore: '#2563eb', wduring: '#ea580c', wafter: '#0d9488', key: '#7c3aed', free: '#64748b' };
  // 旧区分の読み替え（表示だけ。データは変えない）: 対応前→作業前、対応中→作業中、対応後→作業後、養生→作業前
  const LEGACY_PHASES = { before: 'wbefore', investigating: 'wduring', done: 'wafter', yojo: 'wbefore' };
  const LEGACY_PHASE_LABELS = { '対応前': 'wbefore', '対応中': 'wduring', '対応後': 'wafter', '養生': 'wbefore' };
  const PHASE_NOTE_MAX = 30;

  /* ---- 旧ツールの入力欄の文言（289–359行・655行） ---- */
  const FREE_CHIP = '自由記載'; // 自由記載チップ。data の配列に入っていれば ON
  const TEXT = {
    f1Hint: '実施した作業・調査の詳細・手順・確認箇所など',
    leakLabel: '漏水の状況',
    leakActionLabel: '漏水時の対応',
    leakRoomPlaceholder: '号室（例：605）',
    leakOtherPlaceholder: '漏水時の対応（自由記載）',
    afterLabel: '対応後の状況',
    afterNotePlaceholder: '補足（任意・自由記載）',
    afterReasonLabel: '理由 *',
    afterReasonPlaceholder: '「正常に復旧」でない理由（必須・自由記載）',
    f2Label: '原因',
    f2Hint: '特定できた場合のみ。不明な場合は次の対応方針へ。',
    reasonLabel: '原因と判断した理由',
    reasonHint: 'そう判断した根拠・確認した事実など（自由記載）',
    // Task 26: 記載例（薄い文字）。社内・現場用・担当者URL のページ（r.html）で共通
    reasonPlaceholder: 'トイレ、キッチン、洗濯機、浴室を全て排水テストをしたとこと、浴室の点検口から覗くと微妙に水漏れしていることを目視で確認し、階下被害部屋の被害箇所との落水量も辻褄があうため原因と断定しました。',
    f4Label: '次の対応方針',
    f4Hint: '原因不明時や追加工事が必要な場合の方針',
    f2Pick: '当てはまるものを押してください（複数可）',
    f4Pick: '1つ選んでください',
    legacyF2: '原因（以前の書き方の記載）',
    legacyF4: '次の対応方針（以前の書き方の記載）',
    legacyItems: '以前の項目',
    detailPlaceholder: '詳細（例：排水ホースの外れ）',
    tenantReasonLabel: '入居者やらかしの理由',
    tenantReasonPlaceholder: '例：洗濯機の排水ホースを外したまま使用',
    causeOtherLabel: '原因（その他）',
    workItemOtherPlaceholder: 'その他の作業（自由記載）',
    estimateDueLabel: '見積書提案期日',
    estimateDueHint: '提出すると、案件の管理者に「見積書作成必要（期日）」として知らせます',
    resurveyDueHint: '提出すると「調査（次の回）」が作られ、作業担当者の 🔔 に「見積書を仕上げて提出（期限）」が入ります',
    resurveyReasonLabel: '再調査の理由',
    resurveyDetailLabel: '再調査の内容',
    nextOtherLabel: '次の対応方針（その他）',
    selectPlaceholder: '— 選択してください —',
    freePlaceholder: '自由記載',
    checklistTitle: 'チェックリスト',
    workChecklistTitle: '作業チェックリスト',
    keyChecklistTitle: '鍵の取り扱い',
    keyReturnLabel: '鍵の返却方法',
    keyReturnPlaceholder: '例：元請へ手渡し／ポスト投函',
    keyPhotoLabel: '返却時の写真',
    keyPhotoAdd: '鍵返却の写真を追加',
    photoAdd: '現場写真を追加',
    photoAddHint: 'カメラで撮るか、アルバムから選べます。写真は自動で圧縮して保存します',
    phaseNotePlaceholder: '区分（自由記載）',
    photoCaptionPlaceholder: 'キャプション（例：玄関から居室方向を撮影）',
    noData: '記録なし'
  };

  /* ---- 旧ツール 470–519行（MODES）。checkGroups の field / freeField は新アプリの data のキー ---- */
  const MODES = {
    investigate: {
      label: '調査',
      checkCardTitle: '作業実施項目', contentCardTitle: '作業内容',
      // Task 20: 7つの項目。「その他」は自由記載の欄を出すチップ（freeChip）
      checkGroups: [{ title: null, items: INV_WORK_ITEMS.filter(x => x !== WORK_ITEM_OTHER), free: true, freeChip: WORK_ITEM_OTHER, freePrefix: 'その他', field: 'workItems', freeField: 'workItemOther' }],
      // 古い報告書（旧ツールの12項目 data.items / itemsFree）。表示と PDF のためだけ
      legacyGroups: [{ title: null, items: INV_ITEMS, free: true, freePrefix: 'その他', field: 'items', freeField: 'itemsFree' }],
      f1Label: '作業実施内容', f1Req: true,
      showLeak: true, showAfter: false, showF2: true, showReason: true, showF4: true, pickCause: true, pickNext: true,
      f1ph: '例：605号室キッチン脇のダウンライトまわりから漏水を確認。給水管の耐圧テストを実施。',
      rSection: '調査結果',
      rRows: [
        { label: '作業実施内容', field: 'f1' },
        { label: '漏水の状況', field: 'leak' },
        { label: '漏水時の対応', field: 'leakAction' },
        { label: '原　因', field: 'f2' },
        { label: '原因と判断した理由', field: 'reason' },
        { label: '次の対応方針', field: 'f4', next: true },
        { label: 'お部屋の状況', field: 'roomStatus' }
      ]
    },
    repair: {
      label: '設備修繕',
      checkCardTitle: null, contentCardTitle: '作業内容',
      checkGroups: [],
      f1Label: '作業実施内容', f1Req: true,
      showLeak: false, showAfter: true, showF2: false, showReason: false, showF4: false,
      f1ph: '例：既存給湯管を撤去し新規樹脂管（16mm）に更新。接続部の防水処理を実施。通水確認済み。漏水なし。',
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
      rSection: '作業結果',
      rRows: [
        { label: '申し送り', field: 'f1' }
      ]
    }
  };
  const WORK_TYPE_LABEL = { investigate: '調査', repair: '設備修繕', restore: '復旧工事' };
  const STATUS_LABEL = { draft: '下書き', submitted: '提出済み・確認待ち', confirmed: '確認済み', sent: '依頼元へ送付済み' };

  const modeOf = wt => MODES[wt] || MODES.investigate;
  const str = v => (v == null ? '' : String(v));
  const trim = v => str(v).trim();
  const arr = v => (Array.isArray(v) ? v : []);

  const emptyRoom = () => ({ luggage: null, pet: null, residents: null });
  // お部屋の状況の正規化（知らない値は null。入居者数は 0〜20 の整数だけ）
  function normalizeRoom(v) {
    const r = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    const n = typeof r.residents === 'number' ? r.residents : (typeof r.residents === 'string' && /^\d{1,2}$/.test(r.residents.trim()) ? +r.residents.trim() : NaN);
    return {
      luggage: r.luggage === 'many' || r.luggage === 'few' ? r.luggage : null,
      pet: typeof r.pet === 'boolean' ? r.pet : null,
      residents: Number.isInteger(n) && n >= 0 && n <= RESIDENTS_MAX ? n : null
    };
  }
  // 「荷物量 多い・ペット あり・入居者 2人」（未入力の項目は省く。全部空なら ''）
  function roomStatusText(data) {
    const r = normalizeRoom(data && data.roomStatus);
    const out = [];
    if (r.luggage) out.push('荷物量 ' + ROOM_LUGGAGE.find(x => x.key === r.luggage).label);
    if (r.pet !== null) out.push('ペット ' + (r.pet ? 'あり' : 'なし'));
    if (r.residents !== null) out.push('入居者 ' + r.residents + '人');
    return out.join('・');
  }
  const emptyNext = () => ({ type: '', estimateDue: '', reason: '', detail: '', other: '' });
  function emptyData() {
    return {
      items: [], itemsFree: '', f1: '', leak: '', leakAction: '', leakActionOther: '', leakRoom: '', reason: '', f2: '', f4: '',
      afterSel: '', afterNote: '', scopePlaces: [], scopePlaceFree: '', scopeParts: [], scopePartFree: '',
      workChecklist: [], keyChecklist: [], keyReturn: '', keyBorrowed: false, keyReturned: false,
      // Task 20: 調査の選択式
      workItems: [], workItemOther: '', causes: [], causeTenantReason: '', causeOther: '', nextAction: emptyNext(),
      roomStatus: emptyRoom()
    };
  }
  // 原因の選択 → [{ key, detail }]（知らないキー・重複は落とす。detail は「詳細」がある項目だけ）
  function normalizeCauses(v) {
    const seen = new Set(), out = [];
    arr(v).forEach(c => {
      const key = c && typeof c === 'object' ? str(c.key) : typeof c === 'string' ? c : '';
      if (!CAUSE_KEYS.includes(key) || seen.has(key)) return;
      seen.add(key);
      const def = CAUSES.find(x => x.key === key);
      out.push({ key, detail: def.input === 'detail' && c && typeof c === 'object' ? str(c.detail) : '' });
    });
    return out;
  }
  function normalizeNext(v) {
    const n = Object.assign(emptyNext(), v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    ['type', 'estimateDue', 'reason', 'detail', 'other'].forEach(k => { n[k] = str(n[k]); });
    if (!NEXT_KEYS.includes(n.type)) n.type = '';
    return { type: n.type, estimateDue: n.estimateDue, reason: n.reason, detail: n.detail, other: n.other };
  }
  // 欠けたキーを初期値で補う（古い下書きや協力業者の提出でも落ちないように）
  //   鍵（Task 21）: keyBorrowed / keyReturned が無い古い報告書は keyChecklist（旧3項目）と返却方法から読み替える
  function normalizeData(data) {
    const raw = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const d = Object.assign(emptyData(), raw);
    d.workItems = arr(d.workItems).map(str).filter(Boolean);
    d.causes = normalizeCauses(d.causes);
    d.nextAction = normalizeNext(d.nextAction);
    d.roomStatus = normalizeRoom(d.roomStatus);
    const oldKey = arr(raw.keyChecklist).map(str);
    if (typeof raw.keyBorrowed !== 'boolean') d.keyBorrowed = oldKey.some(x => KEY_CHECKLIST.includes(x)) || !!trim(raw.keyReturn);
    if (typeof raw.keyReturned !== 'boolean') d.keyReturned = oldKey.includes(KEY_CHECKLIST[1]);
    d.keyChecklist = oldKey;
    return d;
  }
  // 鍵の取り扱い（PDF・入力画面）→ { borrowed, returned, comment }。借りていなければ返却・コメントは出さない
  function keyInfo(data) {
    const d = normalizeData(data);
    return { borrowed: !!d.keyBorrowed, returned: !!d.keyBorrowed && !!d.keyReturned, comment: d.keyBorrowed ? trim(d.keyReturn) : '' };
  }
  // PDF のチェックリストの行 → [{ on, text, key? }]（作業チェックリスト → 鍵を借りたときだけ 借りた・返却）
  function checklistLines(data) {
    const d = normalizeData(data);
    const out = arr(d.workChecklist).map(trim).filter(Boolean).map(text => ({ on: true, text }));
    const k = keyInfo(d);
    if (k.borrowed) {
      out.push({ on: true, text: KEY_TEXT.borrowedPdf, key: true });
      out.push({ on: k.returned, text: KEY_TEXT.returned, key: true });
    }
    return out;
  }

  /* ---- 写真の区分（Task 21） ---- */
  // 保存値（キー・旧キー・旧ラベル）→ 今の区分のキー。空は ''。どれでもない文字は自由記載扱い
  function photoPhaseKey(v) {
    const x = trim(v);
    if (!x) return '';
    if (Object.prototype.hasOwnProperty.call(PHASES, x)) return x;
    if (LEGACY_PHASES[x]) return LEGACY_PHASES[x];
    if (LEGACY_PHASE_LABELS[x]) return LEGACY_PHASE_LABELS[x];
    const k = Object.keys(PHASES).find(y => y && PHASES[y] === x);
    return k || PHOTO_FREE;
  }
  // 写真 { phase, phaseNote } → { key, label, color } | null（自由記載は phaseNote。定義外の古い文字はその文字）
  function photoPhase(photo) {
    const p = photo || {};
    const key = photoPhaseKey(p.phase);
    if (!key) return null;
    let label = PHASES[key];
    if (key === PHOTO_FREE) {
      const raw = trim(p.phase);
      label = trim(p.phaseNote) || (raw && raw !== PHOTO_FREE && raw !== PHASES.free ? raw : PHASES.free);
    }
    return { key, label, color: PHASE_COLORS[key] || '#64748b' };
  }
  // 提出・保存する写真の区分を今の5つ（＋空）にそろえる（協力業者の提出。古い下書きの旧区分も読み替える）
  function photoPhaseOut(photo) {
    const p = photo || {};
    const key = photoPhaseKey(p.phase);
    const raw = trim(p.phase);
    const note = key === PHOTO_FREE ? (trim(p.phaseNote) || (raw && raw !== PHOTO_FREE && raw !== PHASES.free ? raw : '')).slice(0, PHASE_NOTE_MAX) : '';
    return { phase: key, phaseNote: note };
  }
  const keyPhotoCount = photos => arr(photos).filter(p => photoPhaseKey(p && p.phase) === PHOTO_KEY).length;

  /* ---- Task 20: 原因・次の対応方針の文章化（PDF・メール） ---- */
  const isYmd = v => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trim(v));
    if (!m) return false;
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return dt.getUTCFullYear() === +m[1] && dt.getUTCMonth() === +m[2] - 1 && dt.getUTCDate() === +m[3];
  };
  const mdOf = ymd => { const p = parseYmd(ymd); return p ? `${p.m}/${p.d}` : ''; };
  const hasCause = (d, key) => normalizeCauses(d.causes).some(c => c.key === key);
  // 選んだ原因を定義順に「洗濯機（排水ホースの外れ）、浴室（…）」の形で連結。古い自由記載（f2）は改行して後ろに
  function causeText(data) {
    const d = normalizeData(data);
    const parts = [];
    CAUSES.forEach(def => {
      const c = d.causes.find(x => x.key === def.key);
      if (!c) return;
      if (def.input === 'other') { parts.push(trim(d.causeOther) || def.label); return; }
      const extra = def.input === 'tenant' ? trim(d.causeTenantReason) : def.input === 'detail' ? trim(c.detail) : '';
      parts.push(extra ? `${def.label}（${extra}）` : def.label);
    });
    return [parts.join('、'), trim(d.f2)].filter(Boolean).join('\n');
  }
  // 次の対応方針を文に: 「原因元工事（見積書 10/25 までにご提案）」「再調査: 内容（理由: …）」「その他の自由記載」。古い自由記載（f4）は改行して後ろに
  function nextActionText(data) {
    const d = normalizeData(data);
    const n = d.nextAction;
    let t = '';
    if (n.type === 'cause') t = isYmd(n.estimateDue) ? `原因元工事（見積書 ${mdOf(n.estimateDue)} までにご提案）` : '原因元工事';
    else if (n.type === 'resurvey') {
      // Task 21: 再調査にも見積書提案期日 → 「再調査（見積書 M/D までにご提案）: 内容（理由: …）」
      const head = isYmd(n.estimateDue) ? `再調査（見積書 ${mdOf(n.estimateDue)} までにご提案）` : '再調査';
      const body = [trim(n.detail), trim(n.reason) ? `（理由: ${trim(n.reason)}）` : ''].join('');
      t = body ? `${head}: ${body}` : head;
    } else if (n.type === 'other') t = trim(n.other) || 'その他';
    return [t, trim(d.f4)].filter(Boolean).join('\n');
  }
  // 調査カードの調査結果（Task 5b）→ 報告書の初期値（原因 = その他の自由記載・原因と判断した理由・次の対応方針 = その他の自由記載）
  //   init: { f2, reason, f4 }（旧の形）も { causes, causeOther, causeTenantReason, reason, nextAction }（新しい形）も受ける
  function applyInit(data, init) {
    const d = normalizeData(data);
    const i = init && typeof init === 'object' ? init : {};
    const s = k => (typeof i[k] === 'string' ? i[k] : '');
    if (s('reason')) d.reason = s('reason');
    if (Array.isArray(i.causes)) d.causes = normalizeCauses(i.causes);
    if (s('causeOther')) d.causeOther = s('causeOther');
    if (s('causeTenantReason')) d.causeTenantReason = s('causeTenantReason');
    if (s('f2') && !d.causes.length) { d.causes = [{ key: 'other', detail: '' }]; d.causeOther = s('f2'); }
    if (i.nextAction && typeof i.nextAction === 'object') d.nextAction = normalizeNext(i.nextAction);
    if (s('f4') && !d.nextAction.type) d.nextAction = Object.assign(emptyNext(), { type: 'other', other: s('f4') });
    return d;
  }

  // Task 25: 調査結果を直したとき、自動で作った報告書の下書きの初期値（原因・原因と判断した理由・次の対応方針）を入れ直す。
  //   その4項目（causes / causeOther / reason / nextAction）が前の初期値（prevInit）のまま＝まだ誰も触っていないときだけ。
  //   → 入れ直した data（変わらなければ null）
  const INIT_KEYS = ['causes', 'causeOther', 'reason', 'nextAction'];
  function reapplyInit(data, prevInit, nextInit) {
    const d = normalizeData(data);
    const blank = emptyData();
    const base = Object.assign({}, d);
    INIT_KEYS.forEach(k => { base[k] = JSON.parse(JSON.stringify(blank[k])); });
    const pick = x => JSON.stringify(INIT_KEYS.map(k => x[k]));
    if (pick(d) !== pick(applyInit(base, prevInit))) return null;
    const next = applyInit(base, nextInit);
    return pick(next) === pick(d) ? null : next;
  }

  // 旧 getLeakAction（629–633行）。「漏れている〜」以外では対応は出さない（旧 onLeakChange 620–622行で空にしていた）
  function leakActionText(d) {
    if (!str(d.leak).startsWith('漏れている')) return '';
    let v = trim(d.leakAction);
    if (v === LEAK_ACTION_MAIN_VALVE) {
      const rm = trim(d.leakRoom).replace(/号室$/, '');
      v = (rm ? rm + '号室' : '') + LEAK_ACTION_MAIN_VALVE;
    }
    if (v === LEAK_ACTION_OTHER) v = trim(d.leakActionOther) || LEAK_ACTION_OTHER; // Task 21
    return v;
  }
  // 旧 getAfterStatus（803–807行）
  //   Task 26: 「正常に復旧」以外は「要追加工事（理由: …）」。正常に復旧・未選択は今までどおり 選択値＋全角スペース＋補足
  const afterStatusText = d => (afterNeedsReason(d) && trim(d.afterNote)
    ? `${trim(d.afterSel)}（理由: ${trim(d.afterNote)}）`
    : [trim(d.afterSel), trim(d.afterNote)].filter(Boolean).join('　'));

  // 旧 getCheckedItems（667–677行）: グループ順・定義順、自由記載は最後に `接頭辞: 本文`（本文なしは接頭辞だけ）
  //   freeChip: 自由記載の欄を出すチップの文字（既定「自由記載」。調査の7項目は「その他」）
  //   legacyGroups（調査の旧12項目）は値があるときだけ後ろに足す（古い報告書を壊さない）
  function groupChips(d, g) {
    const out = [];
    const fc = g.freeChip || FREE_CHIP;
    const sel = arr(d[g.field]);
    g.items.forEach(it => { if (sel.includes(it)) out.push(it); });
    sel.forEach(v => { if (v !== fc && !g.items.includes(v) && trim(v)) out.push(v); }); // 定義外の値も落とさない
    if (g.free) {
      const t = trim(d[g.freeField]);
      if (t) out.push(`${g.freePrefix}: ${t}`);
      else if (sel.includes(fc)) out.push(g.freePrefix);
    }
    return out;
  }
  function chipsForPdf(report) {
    const cfg = modeOf(report.work_type);
    const d = normalizeData(report.data);
    const out = [];
    cfg.checkGroups.concat(cfg.legacyGroups || []).forEach(g => {
      groupChips(d, g).forEach(x => { if (!out.includes(x)) out.push(x); });
    });
    return out;
  }
  // 古い報告書の項目（入力画面に「以前の項目」として出す）
  function legacyChips(report) {
    const cfg = modeOf(report.work_type);
    const d = normalizeData(report.data);
    const out = [];
    (cfg.legacyGroups || []).forEach(g => out.push(...groupChips(d, g)));
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
    // Task 26: 対応後の状況が「正常に復旧」以外なら理由が必須
    if (cfg.showAfter && afterNeedsReason(d) && !trim(d.afterNote)) errors.push(`「対応後の状況」が「${trim(d.afterSel)}」のときは理由を入れてください`);
    // Task 20: 次の対応方針（原因元工事は見積書提案期日が必須・再調査は理由と内容が必須）
    if (cfg.pickNext) {
      const n = d.nextAction;
      if (n.type === 'cause' && !isYmd(n.estimateDue)) errors.push('「原因元工事」の見積書提案期日を入れてください');
      if (n.type === 'resurvey' && !isYmd(n.estimateDue)) errors.push('「再調査」の見積書提案期日を入れてください'); // Task 21
      if (n.type === 'resurvey' && !trim(n.reason)) errors.push('「再調査」の理由を入れてください');
      if (n.type === 'resurvey' && !trim(n.detail)) errors.push('「再調査」の内容を入れてください');
    }
    if (arr(report.photos).length === 0) warnings.push('写真が1枚もアップロードされていません');
    // Task 21: 鍵を借りたときだけ、返却のチェックと返却時の写真
    if (d.keyBorrowed && !d.keyReturned) warnings.push('「鍵を返却した」にチェックがありません');
    if (d.keyBorrowed && keyPhotoCount(report.photos) === 0) warnings.push('鍵返却の写真がありません（写真の区分「鍵返却」）');
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
      f1: trim(d.f1), f2: cfg.pickCause ? causeText(d) : trim(d.f2), f4: cfg.pickNext ? nextActionText(d) : trim(d.f4), reason: trim(d.reason),
      leak: trim(d.leak), leakAction: leakActionText(d), afterStatus: afterStatusText(d), roomStatus: roomStatusText(d)
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
    const f2 = cfg.pickCause ? causeText(d) : d.f2, f4 = cfg.pickNext ? nextActionText(d) : d.f4;
    if (cfg.showF2 && oneLine(f2)) facts.push(`■ 原因　　${oneLine(f2)}`);
    if (cfg.showF4 && oneLine(f4)) facts.push(`■ 次の対応　${oneLine(f4)}`);

    const sign = [orgName, [t(org.address), t(org.tel)].filter(Boolean).join(' ／ '), t(org.email)].filter(Boolean);

    const lines = [
      t(caseRow.client_name) ? `${t(caseRow.client_name)} ご担当者様` : 'ご担当者様',
      '',
      `お世話になっております。${orgName ? orgName + 'でございます。' : ''}`, // Task 23: 書き出しは連絡メールと同じ（「いつも」は使わない）
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

  // via（submitted_via）: 社内（member）が提出したものは確認待ちにしない＝「提出済み（未送付）」（Task 23。協力業者URL＝share だけ確認待ち）
  //   Task 25: 別の人が社内で提出したもの（other = true）は確認待ち（「報告書を確認する」）
  const statusLabel = (s, via, other) => (s === 'submitted' && via && via !== 'share' && !other ? '提出済み（未送付）' : STATUS_LABEL[s] || str(s));
  // 確認が要る提出か（Task 25）: 担当者URLから提出した、または別の人（me 以外）が社内で提出した。PhaseLogic の段階と同じ
  const needsCheck = (r, me) => !!r && r.status === 'submitted' && (r.submitted_via === 'share' || (!!me && !!r.submitted_by && r.submitted_by !== me));
  const submittedByOther = (r, me) => !!r && !!me && !!r.submitted_by && r.submitted_by !== me;

  // 写真の欄の注意書き（Task 25）: 作業担当者への指示で「被害箇所の写真撮影」を選んだ号室。rooms = [{ room, role }]（PhaseLogic.photoRooms /
  //   share_open の photo_rooms）→ '📷 402号室（加害部屋）・302号室: 被害箇所のアップの写真と、…撮ってください'。無ければ ''
  const PHOTO_NOTE = '被害箇所のアップの写真と、お部屋のどの位置かが分かるように引いた写真を撮ってください';
  const ROOM_ROLE_LABEL = { cause: '加害部屋', damage: '被害部屋', other: 'その他' };
  function photoNote(rooms) {
    const list = (Array.isArray(rooms) ? rooms : []).filter(r => r && typeof r === 'object');
    if (!list.length) return '';
    const label = r => {
      const room = str(r.room);
      const no = !room ? '' : /[0-9０-９A-Za-zＡ-Ｚａ-ｚ]$/.test(room) ? room + '号室' : room;
      return (no || '号室未設定') + (ROOM_ROLE_LABEL[r.role] ? '（' + ROOM_ROLE_LABEL[r.role] + '）' : '');
    };
    return '📷 ' + list.map(label).filter((t, i, a) => a.indexOf(t) === i).join('・') + ': ' + PHOTO_NOTE;
  }

  const api = {
    INV_WORK_ITEMS, WORK_ITEM_OTHER, CAUSES, NEXT_ACTIONS, WORK_TYPE_OF_PHASE,
    normalizeCauses, normalizeNext, causeText, nextActionText, applyInit, reapplyInit, legacyChips, isYmd, hasCause,
    MODES, WORK_TYPE_LABEL, STATUS_LABEL, INV_ITEMS, RESTORE_PLACES, RESTORE_PARTS, AFTER_STATUS, AFTER_OK, afterNeedsReason,
    LEAK_STATUS, LEAK_ACTIONS, LEAK_ACTION_MAIN_VALVE, LEAK_ACTION_OTHER, WORK_CHECKLISTS, KEY_CHECKLIST, KEY_TEXT, PHASES, PHASE_COLORS, FREE_CHIP, TEXT, PDF_LINK,
    ROOM_LUGGAGE, ROOM_PET, RESIDENTS_MAX, normalizeRoom, roomStatusText,
    LEGACY_PHASES, PHOTO_FREE, PHOTO_KEY, PHASE_NOTE_MAX, photoPhaseKey, photoPhase, photoPhaseOut, keyPhotoCount, keyInfo, checklistLines,
    emptyData, normalizeData, validate, resultRows, chipsForPdf, fmtDateJa, timeRange, fileName,
    buildMail, mailtoUrl, buildMailto, statusLabel, needsCheck, submittedByOther, PHOTO_NOTE, photoNote
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReportLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
