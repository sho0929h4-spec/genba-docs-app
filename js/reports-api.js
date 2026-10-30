// js/reports-api.js — 報告書・写真・提出/確認・協力業者URL・送付メール下書きのDBアクセス（Supabase呼び出しはここに集約）
const ReportsApi = (() => {
  const RL = () => window.ReportLogic;
  const must = ({ data, error }) => { if (error) throw error; return data; };
  const now = () => new Date().toISOString();

  // DBの列権限（migration 009）で更新できる列のうち、画面から直接変えてよいものだけ。
  // status / submitted_* / confirmed_* / sent_at は submit・confirm・markSent だけが触る
  const REPORT_COLS = ['work_type', 'room', 'work_date', 'time_start', 'time_end', 'worker_id', 'worker_name', 'data', 'photos'];
  const MAIL_COLS = ['to_email', 'cc', 'subject', 'body', 'recipients']; // recipients: 宛先の種類（元請・物件オーナー・入居者。020）
  // token（平文）は自社だけ読める（migration 044。044 より前に発行した行は空）。token_hash は返さない
  const SHARE_COLS = 'id, report_id, token, vendor_name, expires_at, revoked_at, submitted_at, created_by, created_at';
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

  const sharedSynced = new Set(); // Task 27: 担当者URLの提出で「調査結果のご報告」を確かめた報告書（id@提出日時。この画面の間）
  const api = {
    /* ===== 報告書 ===== */
    async listByCase(caseId) {
      return must(await sb.from('reports').select('*').eq('case_id', caseId).order('created_at', { ascending: false }));
    },
    // 日報（Task 32）: 対応ごとの報告書の作業開始・終了時間（case_summaries には time_start が無いので別に読む）
    async timesForPhases(phaseIds) {
      const ids = Array.from(new Set((phaseIds || []).filter(Boolean)));
      if (!ids.length) return [];
      return must(await sb.from('reports').select('id, phase_id, work_date, time_start, time_end').in('phase_id', ids)) || [];
    },
    async get(id) {
      return must(await sb.from('reports').select('*').eq('id', id).maybeSingle());
    },
    // f: { work_type, worker_id, worker_name, phase_id, init }（協力業者用は worker_name だけ入れる。phase_id は対応フェーズのカードから作るとき）
    //   init: 作成時の初期値（調査カードの調査結果 → 原因 / 原因と判断した理由 / 次の対応方針。ReportLogic.applyInit）
    async create(caseId, f = {}) {
      // Task 20: 調査結果の初期値は選択式の形へ（原因 → 原因「その他」の自由記載・次の対応方針 → 「その他」の自由記載）
      const data = RL().applyInit(RL().emptyData(), f.init);
      // Task 66: 作業実施項目の初期値 = 調査依頼項目（PhaseLogic.reportFields の work。作成時だけ）
      if (f.work && (f.work_type || 'investigate') === 'investigate') Object.assign(data, RL().workInit(f.work));
      const row = {
        case_id: caseId, status: 'draft', work_type: f.work_type || 'investigate',
        worker_id: f.worker_id || null, worker_name: f.worker_name || null, data
      };
      if (f.phase_id) row.phase_id = f.phase_id;
      // Task 23: 号室・作業日の初期値（PhaseLogic.reportFields。案件の号室・フェーズの日）
      if (f.room) row.room = String(f.room).slice(0, 40);
      if (f.work_date && /^\d{4}-\d{2}-\d{2}$/.test(f.work_date)) row.work_date = f.work_date;
      const made = must(await sb.from('reports').insert(row).select().single());
      await logSystem(caseId, () => f.logText || (RL().isRecord(made.work_type) ? `${f.phaseTitle || '現地確認'}の記録を作った` // Task 65
        : `${f.phaseTitle ? f.phaseTitle + 'の' : ''}報告書（${RL().WORK_TYPE_LABEL[made.work_type] || made.work_type}）を作った`));
      return made;
    },
    // Task 25: フェーズの報告書（下書き・作業区分はフェーズで固定）と担当者URL（期限なし・1本）を用意する（無ければ作る）。
    //   フェーズを作ったとき（PhasesApi.create）と、画面（フェーズ詳細・現場用のツール・⑦）を開いたときに呼ぶ（既存のフェーズは遅延作成）。
    //   報告書が1件も無ければ作る（済んだフェーズ＝調査済み・完了・請求・入金の記録があるものは作らない。o.force で作る）。
    //   いちばん新しい下書きに使える URL が無ければ URL を作る。提出済みの報告書しか無ければ何もしない。
    //   o: { reports（このフェーズの報告書。省略すると読む）, shares（その URL。省略すると読む）, title（フェーズ名）, force }
    //   → { report, share, made: 作ったか } か null（作らなかった）
    async ensurePhaseReport(phase, caseRow, o = {}) {
      const p = phase || {};
      if (!p.id) return null;
      const caseId = p.case_id || (caseRow && caseRow.id);
      let reports = Array.isArray(o.reports) ? o.reports.filter(r => r.phase_id === p.id)
        : must(await sb.from('reports').select('*').eq('phase_id', p.id).order('created_at'));
      const finished = !!(p.done_at || p.billed_at || p.paid_at);
      let report = null, made = false;
      const drafts = (reports || []).filter(r => r.status === 'draft')
        .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
      if (!(reports || []).length) {
        if (finished && !o.force) return null;
        // 作業担当者の初期値はフェーズの作業担当者（無ければ空。開いた人にはしない）
        const f = window.PhaseLogic.reportFields(p, caseRow || {}, { title: o.title || '' });
        f.logText = `${o.title ? o.title + 'の' : ''}${RL().isRecord(f.work_type) ? '記録' : '報告書'}と担当者URLを用意した`;
        report = await api.create(caseId, f);
        made = true;
      } else if (drafts.length) report = drafts[drafts.length - 1];
      else return null;
      const shares = made ? [] : Array.isArray(o.shares) ? o.shares : await api.listShares(report.id);
      let share = api.latestShare(shares, report.id);
      if (!share || !api.shareActive(share)) {
        // 提出済みの URL（submitted_at）が残っている下書きは、社内が差し戻した等。新しい URL を作る
        share = (await api.createShare(report, '')).share;
        made = true;
      }
      return { report, share, made };
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
      // Task 75: 調査は次の対応方針を空にして「まだ決めていない」印を付けて提出（決めるのは提出したあとの画面 = decideNext）
      const patch = { status: 'submitted', submitted_at: now(), submitted_by: ctx.user.id, submitted_via: 'member' };
      if (cur.work_type === 'investigate') patch.data = RL().submitData(cur.work_type, cur.data);
      const rows = must(await sb.from('reports')
        .update(patch)
        .eq('id', cur.id).eq('status', 'draft').select());
      if (!rows || rows.length === 0) throw new Error('この報告書はすでに提出されています');
      const row = rows[0];
      await logSystem(row.case_id, () => (RL().isRecord(row.work_type) ? `現地確認の記録を${row.reedit_count ? '再' : ''}送信した` // Task 65（管理者への連絡は DB の reports_site_check_sent）
        : `報告書（${RL().WORK_TYPE_LABEL[row.work_type] || row.work_type}）を${row.reedit_count ? "再" : ""}提出した`)); // Task 35: 再編集のあとは「再提出した」
      await api.syncSurveyResult(row);
      // Task 20: 調査の「次の対応方針」が原因元工事（＋見積書提案期日）なら、原因元工事フェーズの作成・estimate_due・タイムラインの記録は
      // DB のトリガー（migration 037 reports_next_action）が同じ更新の中で行う（share_submit と同じ処理。期日が無ければ DB も提出を拒否する）
      // 次やること（case_actions）への「報告書を確認する」の追加はやめた（対応フェーズ。確認待ちは報告書の状態 submitted で分かる）
      return row;
    },
    // Task 75: 提出済みの調査の報告書の次の対応を決める（DB 関数 report_decide_next。1回だけ）→ { ok, type, phase_id }
    async decideNext(id, next) {
      return must(await sb.rpc('report_decide_next', { p_id: id, p_next: next }));
    },
    // Task 76: 報告書の PDF に会社名とロゴを出すか（DB 関数 report_set_pdf_company。共有できる人だけ・提出済みでも可）→ { ok, pdf_company }
    async setPdfCompany(id, show) {
      return must(await sb.rpc('report_set_pdf_company', { p_id: id, p_show: !!show }));
    },
    // Task 23 I10（原因の二重入力）: 調査の報告書の 原因・原因と判断した理由・次の対応方針 の文で、その調査フェーズの「調査結果」の
    //   空の項目だけ埋め、「調査結果のご報告」の未送信の下書きも作り直す（PhasesApi.saveResult）。失敗しても提出・確認は止めない
    //   Task 27: 次の対応方針が原因元工事／再調査（期日あり）なら、調査結果が変わらなくても下書きを作り直す（末尾の「お見積書は … までに」）
    async syncSurveyResult(report) {
      try {
        if (!report || report.work_type !== 'investigate' || !report.phase_id || typeof PhasesApi === 'undefined') return null;
        const ph = must(await sb.from('case_phases').select('id, case_id, kind, result, scheduled_at, done_at').eq('id', report.phase_id).maybeSingle());
        if (!ph || ph.kind !== 'survey') return null;
        const d = RL().normalizeData(report.data);
        const caseRow = (typeof CasesApi !== 'undefined' && await CasesApi.getSummary(report.case_id)) || { id: report.case_id };
        // Task 25: 原因は報告書の号室の区画へ（調査結果は号室ごと）
        const next = window.PhaseLogic.resultFromReport(ph.result, { cause: RL().causeText(d), reason: d.reason, next: RL().nextActionText(d) },
          { room: report.room, caseRow });
        const promise = window.PhaseLogic.estimatePromise(d.nextAction);
        if (!next && !promise) return null;
        const seq = Array.isArray(caseRow.phases) ? ((caseRow.phases.find(p => p.id === ph.id) || {}).seq) : null;
        return await PhasesApi.saveResult(ph, next || ph.result, caseRow, window.PhaseLogic.phaseTitle(ph, seq), { next: d.nextAction });
      } catch (e) { console.warn('調査結果への反映に失敗', e); return null; }
    },
    // Task 27: 担当者URLから提出された調査の報告書（ログインなしの提出は下書きを作れない）→ 管理画面を開いたときに「調査結果のご報告」を作り直す。
    //   rows: case_summaries の行。提出から30日以内・このフェーズの「調査結果のご報告」が提出の後に作られた／更新されたものが無いときだけ
    //   （作り直し・送信・手直しのどれかが済んでいれば何もしない＝二重に作らない）。同じ画面の間は同じ報告書を2回見ない。戻り値: 作り直した件数
    async syncSharedSurveyResults(rows) {
      if (typeof PhasesApi === 'undefined') return 0;
      const since = Date.now() - 30 * 86400000;
      const cands = [];
      (rows || []).forEach(c => (Array.isArray(c.phases) ? c.phases : []).forEach(p => {
        if (p.kind !== 'survey') return;
        (p.reports || []).forEach(r => {
          if (r.work_type !== 'investigate' || r.submitted_via !== 'share' || !r.submitted_at || r.status === 'draft') return;
          if (Date.parse(r.submitted_at) < since || sharedSynced.has(r.id + '@' + r.submitted_at)) return;
          cands.push({ report: r, phaseId: p.id });
        });
      }));
      if (!cands.length) return 0;
      const mails = must(await sb.from('mail_drafts').select('id, phase_id, status, created_at, updated_at, sent_at')
        .in('phase_id', [...new Set(cands.map(x => x.phaseId))]).eq('purpose', 'survey_result')) || [];
      let n = 0;
      for (const { report, phaseId } of cands) {
        sharedSynced.add(report.id + '@' + report.submitted_at);
        const t = Date.parse(report.submitted_at);
        const done = mails.some(m => m.phase_id === phaseId && Math.max(Date.parse(m.updated_at || '') || 0, Date.parse(m.created_at || '') || 0,
          Date.parse(m.sent_at || '') || 0) >= t);
        if (done) continue;
        try {
          const full = await api.get(report.id);
          if (full && full.status !== 'draft' && await api.syncSurveyResult(full)) n += 1;
        } catch (e) { console.warn('調査結果のご報告の作り直しに失敗', e); }
      }
      return n;
    },
    // Task 35: 提出済み・確認済みの報告書を下書きに戻す（依頼元へ送付の前まで。DB 関数 report_reedit が権限・状態・管理者への連絡・
    //   タイムライン・未送信の送付メールの下書きの削除・担当者URLの使い直しを1回で行う）。戻した行を返す。
    //   送付メールの下書きに PDF リンクを用意していたら、先にそのファイルを消す（下書きの行は DB が消すので、ファイルが残らないように。失敗しても続ける）
    async reedit(report) {
      if (!report || !report.id) throw new Error('報告書が見つかりません');
      try {
        const ds = must(await sb.from('mail_drafts').select('id, status, pdf_path').eq('report_id', report.id).eq('status', 'draft')) || [];
        for (const d of ds) if (d.pdf_path && isPublicPdfPath(d.pdf_path)) await api.revokePdfLink(d).catch(e => console.warn('PDFリンクの片付けに失敗', e));
      } catch (e) { console.warn('送付メールの下書きの確認に失敗', e); }
      must(await sb.rpc('report_reedit', { p_id: report.id }));
      const row = await api.get(report.id);
      if (!row) throw new Error('報告書が見つかりません');
      return row;
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

    /* ===== 担当者URL（報告書1件につき1本。Task 24 / migration 044） ===== */
    // 名前は任意（URLの宛名）。期限なし。同じ報告書に発行し直すと、DB のトリガーが古い URL を自動で無効にする。
    // token は平文で保存し、あとからいつでも同じ URL を表示できる（shareUrl）。token_hash は DB が token から作る
    async createShare(report, vendorName) {
      const name = String(vendorName == null ? '' : vendorName).trim();
      if (Array.from(name).length > VENDOR_MAX) throw new Error(`担当者名は${VENDOR_MAX}文字以内で入力してください`);
      if (report.status && report.status !== 'draft') throw new Error('提出済みの報告書にはURLを発行できません');
      const token = newToken();
      const share = must(await sb.from('report_shares')
        .insert({ report_id: report.id, token, vendor_name: name }).select(SHARE_COLS).single());
      return { share, token, url: api.shareUrl(share) };
    },
    // index.html と同じ場所の r.html（サブパス配信でも動くように、今のページ基準で組み立てる）。token の無い旧い行は ''
    shareUrl(share) {
      if (!share || !share.token) return '';
      return new URL('r.html', location.origin + location.pathname).href + '#' + share.token;
    },
    async listShares(reportId) {
      return must(await sb.from('report_shares').select(SHARE_COLS).eq('report_id', reportId).order('created_at', { ascending: false }));
    },
    // 案件内の報告書のURLをまとめて取る（新しい順）
    async listSharesByReports(reportIds) {
      if (!reportIds || reportIds.length === 0) return [];
      return must(await sb.from('report_shares').select(SHARE_COLS).in('report_id', reportIds).order('created_at', { ascending: false }));
    },
    // その報告書の URL: 使える URL（DB のトリガーで1本だけ）があればそれ、無ければいちばん新しいもの（shares は新しい順）
    latestShare(shares, reportId) {
      const list = (shares || []).filter(sh => sh.report_id === reportId);
      return list.find(api.shareActive) || list[0] || null;
    },
    hashToken,
    // URL が使える（無効化・提出・期限切れのどれでもない）か。社内も編集できる（044 でロックは廃止）
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
    /* ===== 共有（Task 68 / migration 085） ===== */
    // doc: 'report' | 'estimate'。その書類の未送信の送付メールの下書きを使う（無ければ作る）。件名・本文は共有の文面にする（送った中身の記録）
    async shareDraft(doc, row, m) {
      const col = doc === 'estimate' ? 'estimate_id' : 'report_id';
      const ds = must(await sb.from('mail_drafts').select('*').eq(col, row.id).eq('status', 'draft').order('created_at', { ascending: false })) || [];
      if (ds[0]) {
        const rows = must(await sb.from('mail_drafts').update({ subject: m.subject, body: m.body }).eq('id', ds[0].id).eq('status', 'draft').select());
        return (rows && rows[0]) || ds[0];
      }
      const ins = { case_id: row.case_id, [col]: row.id, purpose: doc, subject: m.subject, body: m.body };
      if (row.phase_id) ins.phase_id = row.phase_id;
      return must(await sb.from('mail_drafts').insert(ins).select().single());
    },
    // 共有した（送付済みにする・タイムライン）。via: share（スマホの共有）／mail／line。管理者・その対応の作業担当者・現場用で自分が登録した案件の本人だけ（DB が断る。087）
    async shareSent(draft, via) { return must(await sb.rpc('doc_share_sent', { p_draft: draft.id, p_via: via })); },
    // 「送っていない」に戻す（管理者だけ）。draft = 送信済みのメール
    async shareUndo(draft) { return must(await sb.rpc('doc_share_undo', { p_draft: draft.id })); },
    // いちばん新しい送信済みのメール（無ければ null）
    async lastSent(doc, id) {
      const rows = must(await sb.from('mail_drafts').select('id, sent_at, status').eq(doc === 'estimate' ? 'estimate_id' : 'report_id', id).eq('status', 'sent')
        .order('sent_at', { ascending: false }).limit(1)) || [];
      return rows[0] || null;
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
