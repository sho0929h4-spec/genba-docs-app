// js/messages-api.js — 現場からの連絡（staff_messages。migration 041・Task 23）のDBアクセス（Supabase呼び出しはここに集約）
// 現場用の「管理者に連絡」と管理者の「📨 現場からの連絡」（返事も同じ表。reply_to = もとの連絡）。アプリ内だけ（メールは送らない＝Ruling）
// 写真は files バケットの {org}/cases/{case}/messages/{uuid}-name.jpg（ImageUtil で JPEG に縮める・容量に数える）。
// 日報（Task 32）は {org}/daily/{自分}/ に PDF（{uuid}-nippo.pdf）と写真（3枚まで）
const StaffMessagesApi = (() => {
  const must = ({ data, error }) => { if (error) throw error; return data; };
  // source（047）: staff = 現場からの連絡／report_submit = 調査報告の提出で自動／late = 到着が遅れそうの報告で自動（052）／
  //   nudge = 催促（052）／overdue = 報告書の期限超過で自動（053）／daily = 日報（053。rpc staff_daily_send だけ。case_id は空）／
  //   reedit = 報告書・見積書の再編集と再提出で自動（057。Task 35）／case_create = 現場用の案件登録で自動（058。Task 37・rpc field_create_case）／
  //   case_delete = 現場用で登録した案件の削除で自動（062。Task 42・rpc field_trash_case）／task_delete = タスクの削除で自動・
  //   sendback = タスクの差し戻し（063。Task 43・rpc field_task_dismiss / field_task_sendback。返事をすると差し戻しは済みになる）。画面からは作れない
  const COLS = 'id, org_id, case_id, phase_id, from_user, to_user, subject, body, attachments, read_at, reply_to, created_at, source, daily_date, as_client, meta'; // 065: as_client（元請から）・069: meta（日程調整のカード）
  const SUBJECT_MAX = 100;
  const BODY_MAX = 4000;
  const FILES_MAX = 10;
  const safeJpg = n => {
    const base = String(n || '').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]+/g, '').replace(/^[._-]+/, '').slice(0, 60);
    return (base || 'photo') + '.jpg';
  };
  // 065: 案件の無い書き込み（全体のトーク）の写真は日報と同じ {org}/daily/{自分}/（DB の staff_messages_check と同じ）
  const dirOf = caseId => (caseId ? `${ctx.org.id}/cases/${caseId}/messages` : `${ctx.org.id}/daily/${ctx.user.id}`);
  const dailyDir = () => `${ctx.org.id}/daily/${ctx.user.id}`; // 053: 日報の写真
  const api = {
    SUBJECT_MAX, BODY_MAX, FILES_MAX,
    // 連絡の一覧（新しい順）。opts.caseId で案件を絞る・opts.unreadToMe（宛先が自分で未読）
    async list(opts = {}) {
      let q = sb.from('staff_messages').select(COLS);
      if (opts.caseId) q = q.eq('case_id', opts.caseId);
      if (opts.toUser) q = q.eq('to_user', opts.toUser);
      if (opts.unread) q = q.is('read_at', null);
      if (opts.noCase) q = q.is('case_id', null);   // 053: 日報とその返事
      if (opts.fromUser) q = q.eq('from_user', opts.fromUser);
      if (opts.source) q = q.eq('source', opts.source);
      const rows = must(await q.order('created_at', { ascending: false }).limit(opts.limit || 300)) || [];
      // Task 58: スイッチ false は日程調整のカード・知らせ（source schedule）を出さない（トーク・現場からの連絡・お知らせのどれにも）
      return PhaseLogic.schedOn() ? rows : rows.filter(m => m.source !== 'schedule');
    },
    // 送る。files（File の配列）は先にアップロードして、失敗したら片付ける
    //   { caseId（Task 46: null = 全体のトーク）, phaseId, toUser（null = 管理者全員）, subject, body, files, replyTo, asClient（065: 元請から。管理者だけ） }
    async send(f) {
      const subject = String(f.subject || '').trim();
      if (!subject) throw new Error('件名を入れてください');
      if (subject.length > SUBJECT_MAX) throw new Error('件名は' + SUBJECT_MAX + '文字までです');
      const body = String(f.body || '');
      if (body.length > BODY_MAX) throw new Error('本文は' + BODY_MAX + '文字までです');
      const files = Array.from(f.files || []);
      if (files.length > FILES_MAX) throw new Error('写真は' + FILES_MAX + '枚までです');
      const done = [];
      let bytes = 0;
      try {
        for (const file of files) {
          const p = await ImageUtil.prepareFile(file);
          if (p.type !== 'image/jpeg') throw new Error(`「${file.name}」は写真ではありません`);
          const q = await checkQuota(bytes + p.size, 0);
          if (!q.ok) throw new Error(q.reason);
          const path = `${dirOf(f.caseId)}/${CryptoUtil.uuid()}-${safeJpg(p.name)}`;
          await AppStorage.upload(path, p.blob, { contentType: p.type });
          done.push({ path, name: p.name, size: p.size, type: p.type });
          bytes += p.size;
        }
        const row = must(await sb.from('staff_messages').insert({
          case_id: f.caseId || null, phase_id: f.phaseId || null, to_user: f.toUser || null,
          subject, body, attachments: done, reply_to: f.replyTo || null, ...(f.asClient ? { as_client: true } : {})
        }).select(COLS).single());
        if (bytes) { try { await addUsage(bytes, 0); } catch (e) { console.warn('使用量の更新に失敗', e); } }
        return row;
      } catch (e) {
        for (const a of done) { try { await AppStorage.remove(a.path); } catch (_) {} }
        throw e;
      }
    },
    // 日報を送る（Task 29 / migration 053 → Task 32 で PDF を添付）。その日（日本時間）の自分の日報があれば中身を差し替えて未読に戻す（rpc が判定）
    //   { body: テキスト版, pdf: Blob, pdfName: 保存名, keep: 残す写真（前に送った attachments）, photos: 足す写真（ImageUtil.prepareFile の値）,
    //     drop: 送り直しで使わなくなった前の添付（前の PDF・外した写真。送れたら消す） } → 送った行（resent: 送り直しか）
    //   添付は [PDF, 写真…]（写真は DailyLogic.PHOTOS_MAX 枚まで）。保存先は {org}/daily/{自分}/
    async sendDaily(f) {
      const body = String(f.body || '');
      if (!body.trim()) throw new Error('日報の中身がありません');
      if (body.length > BODY_MAX) throw new Error('日報は' + BODY_MAX + '文字までです');
      if (!(f.pdf instanceof Blob)) throw new Error('日報のPDFを作れませんでした');
      const keep = Array.from(f.keep || []);
      const photos = Array.from(f.photos || []);
      const max = (window.DailyLogic && DailyLogic.PHOTOS_MAX) || 3;
      if (keep.length + photos.length > max) throw new Error('写真は' + max + '枚までです');
      const done = [];
      let bytes = 0;
      try {
        const q = await checkQuota(f.pdf.size + photos.reduce((a, p) => a + (p.size || 0), 0), 0);
        if (!q.ok) throw new Error(q.reason);
        const pdfPath = `${dailyDir()}/${CryptoUtil.uuid()}-nippo.pdf`;
        await AppStorage.upload(pdfPath, f.pdf, { contentType: 'application/pdf' });
        done.push({ path: pdfPath, name: String(f.pdfName || 'nippo.pdf').slice(0, 120), size: f.pdf.size, type: 'application/pdf' });
        bytes += f.pdf.size;
        for (const p of photos) {
          const path = `${dailyDir()}/${CryptoUtil.uuid()}-${safeJpg(p.name)}`;
          await AppStorage.upload(path, p.blob, { contentType: p.type || 'image/jpeg' });
          done.push({ path, name: p.name, size: p.size, type: p.type || 'image/jpeg' });
          bytes += p.size;
        }
        const row = must(await sb.rpc('staff_daily_send', { p_body: body, p_attachments: [done[0]].concat(keep, done.slice(1)) }));
        let freed = 0;
        for (const a of Array.from(f.drop || [])) {
          try { if (await AppStorage.remove(a.path)) freed += Number(a.size) || 0; } catch (e) { console.warn('前の添付を消せませんでした', e); }
        }
        if (bytes - freed) { try { await addUsage(bytes - freed, 0); } catch (e) { console.warn('使用量の更新に失敗', e); } }
        return row;
      } catch (e) {
        for (const a of done) { try { await AppStorage.remove(a.path); } catch (_) {} }
        throw e;
      }
    },
    // 添付が PDF か（日報の PDF。Task 32）
    isPdf(a) { return !!a && (a.type === 'application/pdf' || /\.pdf$/i.test(String(a.path || ''))); },
    // PDF を開く・保存する URL（署名URL。1時間）
    pdfUrl(a, download) { return AppStorage.getUrl(a.path, 3600, download ? { download: a.name || 'nippo.pdf' } : undefined); },
    // 既読にする（宛先の人だけ。RLS で 0 行なら false）
    async markRead(id) {
      const rows = must(await sb.from('staff_messages').update({ read_at: new Date().toISOString() }).eq('id', id).is('read_at', null).select('id'));
      return !!(rows && rows.length);
    },
    photoUrl(path) { return AppStorage.getUrl(path); },
    // Task 46（migration 065）: トークを最後に読んだ時刻（自分の分だけ見える）と、開いたときの既読（そのトークの自分あての未読も既読になる）
    async talkReads() { return must(await sb.from('talk_reads').select('case_id, read_at')) || []; },
    async markTalkRead(caseId) { return must(await sb.rpc('talk_mark_read', { p_case: caseId || null })); }
  };
  return api;
})();
