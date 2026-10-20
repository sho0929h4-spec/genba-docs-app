// js/reports-api.js — 報告書・写真・提出/確認・協力業者URL・送付メール下書きのDBアクセス（Supabase呼び出しはここに集約）
const ReportsApi = (() => {
  const RL = () => window.ReportLogic;
  const must = ({ data, error }) => { if (error) throw error; return data; };
  const now = () => new Date().toISOString();

  // DBの列権限（migration 009）で更新できる列のうち、画面から直接変えてよいものだけ。
  // status / submitted_* / confirmed_* / sent_at は submit・confirm・markSent だけが触る
  const REPORT_COLS = ['work_type', 'room', 'work_date', 'time_start', 'time_end', 'worker_id', 'worker_name', 'data', 'photos'];
  const MAIL_COLS = ['to_email', 'cc', 'subject', 'body', 'recipients']; // recipients: 宛先の種類（元請・物件オーナー・入居者。020）
  const SHARE_COLS = 'id, report_id, vendor_name, expires_at, revoked_at, submitted_at, created_by, created_at'; // token_hash は返さない
  const SHARE_DAYS = [null, 7, 14, 30]; // null = 期限なし（提出・無効化まで有効。migration 012）
  const VENDOR_MAX = 60; // DB: report_shares_vendor_len（migration 011）
  // 送付PDFは公開バケット public-pdfs の {org}/{乱数uuid}/report.pdf（期限のない公開URL。migration 012）。
  // 以前の送付（files バケットの {org}/cases/... の署名URL）と区別する
  const PUBLIC_PDF_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\/report\.pdf$/;
  const isPublicPdfPath = p => PUBLIC_PDF_RE.test(String(p || ''));
  // 公開PDFのファイルを削除して使用量を戻す（実際に消えた1件のときだけ）。消えなかった（まだ残っている）ときはエラー
  async function removePublicPdf(path) {
    const bucket = AppStorage.PUBLIC_PDF_BUCKET;
    const size = await AppStorage.sizeOf(path, bucket);
    if (size <= 0) return 0; // すでに無い
    const removed = await AppStorage.remove(path, bucket);
    if (removed === 1) { await bumpUsage(-size); return size; }
    // 消えた件数が1でない: まだ残っていれば失敗。もう無ければ誰かが先に消したので使用量は触らない
    if (await AppStorage.sizeOf(path, bucket) > 0) throw new Error('PDFを削除できませんでした。もう一度お試しください');
    return 0;
  }

  const pick = (obj, cols) => {
    const out = {};
    for (const k of cols) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    return out;
  };
  // Storage のファイル名は英数._- のみ（日本語は落とす）。写真は ImageUtil で JPEG になるので .jpg 固定
  const safeJpg = n => {
    const base = String(n || '').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]+/g, '').replace(/^[._-]+/, '').slice(0, 60);
    return (base || 'photo') + '.jpg';
  };
  const reportDir = (caseId, reportId) => `${ctx.org.id}/cases/${caseId}/reports/${reportId}`;

  // body は文字列または関数。関数なら try の内側で評価する（文言生成の失敗で本処理を壊さない）
  async function logSystem(caseId, body) {
    try {
      const text = typeof body === 'function' ? body() : body;
      must(await sb.from('timeline_entries').insert({ case_id: caseId, type: 'system', body: text }));
    } catch (e) { console.warn('自動記録に失敗', e); }
  }
  async function bumpUsage(bytes) {
    if (!bytes) return;
    try { await addUsage(bytes, 0); }
    catch (e) { console.warn('使用量の更新に失敗', e); }
  }

  /* ---- 協力業者URLのトークン ---- */
  // 32バイト乱数 → base64url（パディングなし・43文字）
  function newToken() {
    const b = crypto.getRandomValues(new Uint8Array(32));
    let s = '';
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  // DB の _share_hash（sha256(UTF-8) の小文字hex）と同じ値
  async function hashToken(token) {
    return CryptoUtil.sha256Hex(String(token));
  }

  const api = {
    /* ===== 報告書 ===== */
    async listByCase(caseId) {
      return must(await sb.from('reports').select('*').eq('case_id', caseId).order('created_at', { ascending: false }));
    },
    async get(id) {
      return must(await sb.from('reports').select('*').eq('id', id).maybeSingle());
    },
    // f: { work_type, worker_id, worker_name, phase_id, init }（協力業者用は worker_name だけ入れる。phase_id は対応フェーズのカードから作るとき）
    //   init: 作成時の初期値（調査カードの調査結果 → 原因 / 原因と判断した理由 / 次の対応方針。ReportLogic.applyInit）
    async create(caseId, f = {}) {
      // Task 20: 調査結果の初期値は選択式の形へ（原因 → 原因「その他」の自由記載・次の対応方針 → 「その他」の自由記載）
      const data = RL().applyInit(RL().emptyData(), f.init);
      const row = {
        case_id: caseId, status: 'draft', work_type: f.work_type || 'investigate',
        worker_id: f.worker_id || null, worker_name: f.worker_name || null, data
      };
      if (f.phase_id) row.phase_id = f.phase_id;
      // Task 23: 号室・作業日の初期値（PhaseLogic.reportFields。案件の号室・フェーズの日）
      if (f.room) row.room = String(f.room).slice(0, 40);
      if (f.work_date && /^\d{4}-\d{2}-\d{2}$/.test(f.work_date)) row.work_date = f.work_date;
      const made = must(await sb.from('reports').insert(row).select().single());
      await logSystem(caseId, () => `${f.phaseTitle ? f.phaseTitle + 'の' : ''}報告書（${RL().WORK_TYPE_LABEL[made.work_type] || made.work_type}）を作った`);
      return made;
    },
    // 下書きの間だけ保存できる（status=draft の行だけを更新し、0行なら提出済みとみなす）
    async save(id, fields) {
      const patch = pick(fields, REPORT_COLS);
      if (Object.keys(patch).length === 0) throw new Error('保存する項目がありません');
      const rows = must(await sb.from('reports').update(patch).eq('id', id).eq('status', 'draft').select());
      if (!rows || rows.length === 0) throw new Error('提出済みの報告書は編集できません');
      return rows[0];
    },
    // 下書きのみ削除可（RLS）。写真ファイルも片付けて使用量を戻す
    async remove(report) {
      const rows = must(await sb.from('reports').delete().eq('id', report.id).select('id'));
      if (!rows || rows.length === 0) throw new Error('削除できませんでした（下書きの報告書のみ削除できます）');
      let freed = 0;
      for (const p of report.photos || []) {
        try { await AppStorage.remove(p.path); freed += p.size || 0; }
        catch (e) { console.warn('写真の削除に失敗', e); }
      }
      await bumpUsage(-freed);
    },

    /* ===== 写真（report.photos も最新に書き換える） ===== */
    // opts.phase: 写真の区分（「鍵返却の写真を追加」から追加したときは key。Task 21）
    async addPhoto(report, file, opts) {
      const p = await ImageUtil.prepareFile(file);
      if (p.type !== 'image/jpeg') throw new Error(`「${file.name}」は写真ではありません`);
      const q = await checkQuota(p.size, 0);
      if (!q.ok) throw new Error(q.reason);
      const path = `${reportDir(report.case_id, report.id)}/${CryptoUtil.uuid()}-${safeJpg(p.name)}`;
      await AppStorage.upload(path, p.blob, { contentType: p.type });
      const photos = [...(report.photos || []), { path, name: p.name, size: p.size, type: p.type, caption: '', phase: (opts && opts.phase) || '' }];
      let row;
      try { row = await api.save(report.id, { photos }); }
      catch (e) {
        try { await AppStorage.remove(path); } catch (_) {}
        throw e;
      }
      report.photos = row.photos;
      if (row.updated_at) report.updated_at = row.updated_at; // 画面側の退避の基準時刻（base）を最新にする
      await bumpUsage(p.size);
      return row.photos;
    },
    async removePhoto(report, index) {
      const cur = report.photos || [];
      const target = cur[index];
      if (!target) throw new Error('写真が見つかりません');
      const row = await api.save(report.id, { photos: cur.filter((_, i) => i !== index) });
      report.photos = row.photos;
      if (row.updated_at) report.updated_at = row.updated_at; // 画面側の退避の基準時刻（base）を最新にする
      try {
        await AppStorage.remove(target.path);
        await bumpUsage(-(target.size || 0));
      } catch (e) { console.warn('写真ファイルの削除に失敗', e); }
      return row.photos;
    },
    // dir: -1（上へ）/ +1（下へ）。端なら何もしない
    async movePhoto(report, index, dir) {
      const cur = [...(report.photos || [])];
      const j = index + (dir < 0 ? -1 : 1);
      if (!cur[index] || j < 0 || j >= cur.length) return cur;
      [cur[index], cur[j]] = [cur[j], cur[index]];
      const row = await api.save(report.id, { photos: cur });
      report.photos = row.photos;
      if (row.updated_at) report.updated_at = row.updated_at; // 画面側の退避の基準時刻（base）を最新にする
      return row.photos;
    },
    photoUrl(path) { return AppStorage.getUrl(path); },

    /* ===== 提出・確認 ===== */
    // DB上の最新の内容で検証してから提出する（画面側は未保存の入力を先に save しておく）
    async submit(report) {
      const cur = await api.get(report.id);
      if (!cur) throw new Error('報告書が見つかりません');
      if (cur.status !== 'draft') throw new Error('この報告書はすでに提出されています');
      const { errors } = RL().validate(cur);
      if (errors.length) throw new Error(errors.join('\n'));
      const rows = must(await sb.from('reports')
        .update({ status: 'submitted', submitted_at: now(), submitted_by: ctx.user.id, submitted_via: 'member' })
        .eq('id', cur.id).eq('status', 'draft').select());
      if (!rows || rows.length === 0) throw new Error('この報告書はすでに提出されています');
      const row = rows[0];
      await logSystem(row.case_id, () => `報告書（${RL().WORK_TYPE_LABEL[row.work_type] || row.work_type}）を提出した`);
      await api.syncSurveyResult(row);
      // Task 20: 調査の「次の対応方針」が原因元工事（＋見積書提案期日）なら、原因元工事フェーズの作成・estimate_due・タイムラインの記録は
      // DB のトリガー（migration 037 reports_next_action）が同じ更新の中で行う（share_submit と同じ処理。期日が無ければ DB も提出を拒否する）
      // 次やること（case_actions）への「報告書を確認する」の追加はやめた（対応フェーズ。確認待ちは報告書の状態 submitted で分かる）
      return row;
    },
    // Task 23 I10（原因の二重入力）: 調査の報告書の 原因・原因と判断した理由・次の対応方針 の文で、その調査フェーズの「調査結果」の
    //   空の項目だけ埋め、「調査結果のご報告」の未送信の下書きも作り直す（PhasesApi.saveResult）。失敗しても提出・確認は止めない
    async syncSurveyResult(report) {
      try {
        if (!report || report.work_type !== 'investigate' || !report.phase_id || typeof PhasesApi === 'undefined') return null;
        const ph = must(await sb.from('case_phases').select('id, case_id, kind, result, scheduled_at, done_at').eq('id', report.phase_id).maybeSingle());
        if (!ph || ph.kind !== 'survey') return null;
        const d = RL().normalizeData(report.data);
        const next = window.PhaseLogic.resultFromReport(ph.result, { cause: RL().causeText(d), reason: d.reason, next: RL().nextActionText(d) });
        if (!next) return null;
        const caseRow = (typeof CasesApi !== 'undefined' && await CasesApi.getSummary(report.case_id)) || { id: report.case_id };
        const seq = Array.isArray(caseRow.phases) ? ((caseRow.phases.find(p => p.id === ph.id) || {}).seq) : null;
        return await PhasesApi.saveResult(ph, next, caseRow, window.PhaseLogic.phaseTitle(ph, seq));
      } catch (e) { console.warn('調査結果への反映に失敗', e); return null; }
    },
    // 確認済みにして、依頼者への送付メール下書きを作って返す
    async confirm(report, caseRow) {
      const rows = must(await sb.from('reports')
        .update({ status: 'confirmed', confirmed_at: now(), confirmed_by: ctx.user.id })
        .eq('id', report.id).eq('status', 'submitted').select());
      if (!rows || rows.length === 0) throw new Error('確認待ちの報告書ではありません');
      const row = rows[0];
      await api.syncSurveyResult(row); // 協力業者URLから提出された報告書は、確認したときに調査結果へ写す（Task 23 I10）
      let draft, draftErr;
      try { draft = await api.createDraft(row, caseRow); }
      catch (e) { draftErr = e; }
      await logSystem(row.case_id, '報告書を確認した');
      if (draftErr) {
        const err = new Error('確認済みにしましたが、送付メールの下書きを作れませんでした。もう一度お試しください');
        err.cause = draftErr;
        err.report = row;
        throw err;
      }
      return draft;
    },
    // 送付メールの下書きを作る（confirm から呼ぶ。下書き作成だけ失敗したときの再実行にも使う）
    async createDraft(report, caseRow) {
      let c = caseRow;
      if (!c) c = must(await sb.from('cases').select('*').eq('id', report.case_id).maybeSingle());
      const m = RL().buildMail({ caseRow: c, org: ctx.org, report });
      const ins = { case_id: report.case_id, report_id: report.id, purpose: 'report', to_email: m.to || null, subject: m.subject, body: m.body };
      if (report.phase_id) ins.phase_id = report.phase_id; // 対応フェーズの報告書なら、送付メールも同じフェーズ（共有記録 docTrack）
      return must(await sb.from('mail_drafts').insert(ins).select().single());
    },

    /* ===== 協力業者URL ===== */
    // token はDBに保存しない。戻り値の url / token は発行直後にだけ表示する
    async createShare(report, vendorName, days) {
      const name = String(vendorName == null ? '' : vendorName).trim();
      if (!name) throw new Error('協力業者名を入力してください');
      if (Array.from(name).length > VENDOR_MAX) throw new Error(`協力業者名は${VENDOR_MAX}文字以内で入力してください`);
      if (days === undefined || !SHARE_DAYS.includes(days)) throw new Error('有効期限は「期限なし」・7日・14日・30日から選んでください');
      if (report.status && report.status !== 'draft') throw new Error('提出済みの報告書にはURLを発行できません');
      const token = newToken();
      const token_hash = await hashToken(token);
      const expires_at = days === null ? null : new Date(Date.now() + days * 86400000).toISOString();
      const share = must(await sb.from('report_shares')
        .insert({ report_id: report.id, token_hash, vendor_name: name, expires_at }).select(SHARE_COLS).single());
      // index.html と同じ場所の r.html（サブパス配信でも動くように、今のページ基準で組み立てる）
      return { share, token, url: new URL('r.html', location.origin + location.pathname).href + '#' + token };
    },
    async listShares(reportId) {
      return must(await sb.from('report_shares').select(SHARE_COLS).eq('report_id', reportId).order('created_at', { ascending: false }));
    },
    // 案件内の報告書のURLをまとめて取る（⑦ の発行済み一覧）
    async listSharesByReports(reportIds) {
      if (!reportIds || reportIds.length === 0) return [];
      return must(await sb.from('report_shares').select(SHARE_COLS).in('report_id', reportIds).order('created_at', { ascending: false }));
    },
    async revokeShare(id) {
      const rows = must(await sb.from('report_shares').update({ revoked_at: now() })
        .eq('id', id).is('revoked_at', null).select('id'));
      if (!rows || rows.length === 0) throw new Error('無効にできませんでした（すでに無効の可能性があります）');
    },
    hashToken,
    // 協力業者が入力中（無効化・提出・期限切れのどれでもない）か。入力中の報告書は社内から更新できない（migration 011 のトリガー）
    shareActive: sh => !!sh && !sh.revoked_at && !sh.submitted_at && (!sh.expires_at || Date.parse(sh.expires_at) > Date.now()),

    /* ===== 送付メール ===== */
    async listDrafts(caseId) {
      return must(await sb.from('mail_drafts').select('*').eq('case_id', caseId).order('created_at', { ascending: false }));
    },
    async getDraft(id) {
      return must(await sb.from('mail_drafts').select('*').eq('id', id).maybeSingle());
    },
    async saveDraft(id, fields) {
      const patch = pick(fields, MAIL_COLS);
      if (Object.keys(patch).length === 0) throw new Error('保存する項目がありません');
      const rows = must(await sb.from('mail_drafts').update(patch).eq('id', id).eq('status', 'draft').select());
      if (!rows || rows.length === 0) throw new Error('送信済みのメールは編集できません');
      return rows[0];
    },
    async deleteDraft(id) {
      const cur = must(await sb.from('mail_drafts').select('id, status, pdf_path').eq('id', id).maybeSingle());
      if (!cur || cur.status !== 'draft') throw new Error('削除できませんでした（未送信の下書きのみ削除できます）');
      // 送信待ちで作った公開PDFを先に消す（失敗したら行は消さずにエラー → リンクだけ残って管理できなくなるのを防ぐ）
      if (isPublicPdfPath(cur.pdf_path)) await removePublicPdf(cur.pdf_path);
      const rows = must(await sb.from('mail_drafts').delete().eq('id', id).select('id'));
      if (!rows || rows.length === 0) throw new Error('削除できませんでした（未送信の下書きのみ削除できます）');
    },
    // 報告書PDFを公開バケット public-pdfs に保存し、期限のない公開URLを返す。使用量は旧ファイルとの差分だけ動かす。
    // 保存先は {org}/{乱数uuid}/report.pdf（推測できない）。同じ下書きを再送するときは同じ場所に上書きして、URLを変えない
    // （送信待ちで「PDFリンクを無効にする」を押した後は pdf_path が空なので、再送は新しい乱数フォルダ＝新しいURL）
    // fileName: 受け取った人の保存名（公開URLの ?download=）
    async preparePdfLink(draft, pdfBlob, fileName) {
      if (!draft.report_id && !draft.estimate_id) throw new Error('元の書類が見つかりません');
      if (!pdfBlob || !pdfBlob.size) throw new Error('PDFを作成できませんでした');
      // アップロードの前に、DBの今の状態を確認する（古いタブから再送して、無効化したPDFのURLが復活しないように）。
      // 保存先は画面の draft ではなく、DBの pdf_path を正とする
      const cur = must(await sb.from('mail_drafts').select('id, status, pdf_path').eq('id', draft.id).maybeSingle());
      if (!cur || cur.status !== 'draft') throw new Error('この下書きは送信済みです');
      const own = isPublicPdfPath(cur.pdf_path) && cur.pdf_path.split('/')[0] === ctx.org.id;
      const path = own ? cur.pdf_path : `${ctx.org.id}/${CryptoUtil.uuid()}/report.pdf`;
      const bucket = AppStorage.PUBLIC_PDF_BUCKET;
      const oldSize = own ? await AppStorage.sizeOf(path, bucket) : 0;
      const diff = pdfBlob.size - oldSize;
      if (diff > 0) {
        const q = await checkQuota(diff, 0);
        if (!q.ok) throw new Error(q.reason);
      }
      // 今回アップロードしたファイルを消して使用量を戻す。
      //   force（下書きの状態が変わっていて紐づけられなかった）: 場所に関係なく必ず消す（無効化済み・送信済みのURLを生かさない）
      //   それ以外（通信エラー）: 新しい場所か、元々ファイルが無かった場所だけ消す。既に中身があった場所への上書きは残す
      const dropNew = async (force, err) => {
        if (force || !own || oldSize === 0) {
          try {
            const removed = await AppStorage.remove(path, bucket);
            if (removed === 1) await bumpUsage(-pdfBlob.size);
          } catch (e2) { console.warn('孤立したPDFの削除に失敗', e2); }
        }
        if (err) throw err;
      };
      // cacheControl 60秒: 無効化（ファイル削除）後に公開CDNへ残る時間を短くする
      await AppStorage.upload(path, pdfBlob, { contentType: 'application/pdf', upsert: true, bucket, cacheControl: '60' });
      await bumpUsage(diff);
      let rows;
      try {
        // 確認したときの pdf_path のままのときだけ紐づける（別のタブが無効化・再送していたら 0 件）
        const q = sb.from('mail_drafts').update({ pdf_path: path }).eq('id', cur.id).eq('status', 'draft');
        rows = must(await (cur.pdf_path == null ? q.is('pdf_path', null) : q.eq('pdf_path', cur.pdf_path)).select('id, pdf_path'));
      } catch (e) { rows = null; await dropNew(false, e); }
      if (!rows || rows.length === 0 || rows[0].pdf_path !== path) {
        await dropNew(true);
        throw new Error('この下書きは送信済みか、別の画面で更新されました。開き直してからやり直してください');
      }
      draft.pdf_path = path;
      return AppStorage.getPublicUrl(path, bucket, fileName);
    },
    isPublicPdfPath,
    // 送付済みメールのPDFリンクの状態: { kind: 'none' | 'alive' | 'gone', url? }
    //   none = このメールにPDFリンクはない／以前の方式（期限つきの署名URL）。gone = ファイルを削除して無効にした後
    async pdfLinkState(draft, fileName) {
      if (!draft || !isPublicPdfPath(draft.pdf_path)) return { kind: 'none' };
      const bucket = AppStorage.PUBLIC_PDF_BUCKET;
      const size = await AppStorage.sizeOf(draft.pdf_path, bucket);
      return size > 0 ? { kind: 'alive', url: AppStorage.getPublicUrl(draft.pdf_path, bucket, fileName), size } : { kind: 'gone' };
    },
    // PDFリンクを止める: 公開バケットのファイルを削除して使用量を戻す。
    // まだ送信前の下書き（送信待ち）なら pdf_path も空にする（再送で同じURLが復活しない）。送付済みは pdf_path を残す（「無効化済み」の表示に使う）
    async revokePdfLink(draft) {
      if (!isPublicPdfPath(draft.pdf_path)) throw new Error('このメールのPDFリンクは無効にできません');
      const size = await removePublicPdf(draft.pdf_path);
      if (draft.id) {
        const rows = must(await sb.from('mail_drafts').update({ pdf_path: null })
          .eq('id', draft.id).eq('status', 'draft').eq('pdf_path', draft.pdf_path).select('id'));
        if (rows && rows.length) draft.pdf_path = null;
      }
      return size;
    },
    // opts.skipLog: 呼び出し側（見積の送付＝EstimatesApi.onMailSent）が宛先・件名を含めて1件だけ記録するとき
    // opts.logText: 記録の文（日程連絡・リマインド: 「調査 1回目: 調査日のご連絡を送った（元請・入居者）」。mail-ui が作る）
    async markSent(draft, opts = {}) {
      // 連絡メール（日程・リマインド・調査結果・担当者へのメール）: 「今回は送らない」にできる＝ skipped_at を戻してから送信済みにする
      const NOTE_PURPOSES = ['schedule', 'reminder', 'survey_result', 'staff_notice'];
      const isNote = NOTE_PURPOSES.includes(draft.purpose);
      const patch = { status: 'sent', sent_at: now(), sent_by: ctx.user.id };
      if (isNote) patch.skipped_at = null; // 「今回は送らない」にした後で送った（送信済みは送らないにできない: 020 の check）
      const rows = must(await sb.from('mail_drafts')
        .update(patch)
        .eq('id', draft.id).eq('status', 'draft').select());
      if (!rows || rows.length === 0) throw new Error('すでに送信済みです');
      const row = rows[0];
      if (row.report_id) {
        try {
          const rs = must(await sb.from('reports').update({ status: 'sent', sent_at: row.sent_at })
            .eq('id', row.report_id).eq('status', 'confirmed').select('id'));
          if (!rs || rs.length === 0) console.warn('報告書が確認済みでないため送付済みにしませんでした', row.report_id);
        } catch (e) { console.warn('報告書の状態更新に失敗', e); }
      }
      const note = NOTE_PURPOSES.includes(row.purpose);
      if (!opts.skipLog) await logSystem(row.case_id, () => (note && opts.logText) ? opts.logText
        : `${note ? '連絡メールを送った' : '依頼元へ送付した'}（宛先: ${row.to_email || '未入力'}／件名: ${row.subject || '（なし）'}）`);
      return row;
    }
  };
  return api;
})();
