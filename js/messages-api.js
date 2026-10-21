// js/messages-api.js — 現場からの連絡（staff_messages。migration 041・Task 23）のDBアクセス（Supabase呼び出しはここに集約）
// 現場用の「管理者に連絡」と管理者の「📨 現場からの連絡」（返事も同じ表。reply_to = もとの連絡）。アプリ内だけ（メールは送らない＝Ruling）
// 写真は files バケットの {org}/cases/{case}/messages/{uuid}-name.jpg（ImageUtil で JPEG に縮める・容量に数える）
const StaffMessagesApi = (() => {
  const must = ({ data, error }) => { if (error) throw error; return data; };
  // source（047）: staff = 現場からの連絡／report_submit = 調査報告の提出で自動／late = 到着が遅れそうの報告で自動（052）／
  //   nudge = 催促（052）／overdue = 報告書の期限超過で自動（053）／daily = 日報（053。rpc staff_daily_send だけ。case_id は空）。画面からは作れない
  const COLS = 'id, org_id, case_id, phase_id, from_user, to_user, subject, body, attachments, read_at, reply_to, created_at, source, daily_date';
  const SUBJECT_MAX = 100;
  const BODY_MAX = 4000;
  const FILES_MAX = 10;
  const safeJpg = n => {
    const base = String(n || '').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]+/g, '').replace(/^[._-]+/, '').slice(0, 60);
    return (base || 'photo') + '.jpg';
  };
  const dirOf = caseId => `${ctx.org.id}/cases/${caseId}/messages`;
  const dailyDir = () => `${ctx.org.id}/daily/${ctx.user.id}`; // 053: 日報の写真
  // 写真を縮めてアップロード（失敗したら片付けて投げる）→ [{ path, name, size, type }]
  async function uploadAll(files, dir) {
    const done = [];
    let bytes = 0;
    try {
      for (const file of files) {
        const p = await ImageUtil.prepareFile(file);
        if (p.type !== 'image/jpeg') throw new Error(`「${file.name}」は写真ではありません`);
        const q = await checkQuota(bytes + p.size, 0);
        if (!q.ok) throw new Error(q.reason);
        const path = `${dir}/${CryptoUtil.uuid()}-${safeJpg(p.name)}`;
        await AppStorage.upload(path, p.blob, { contentType: p.type });
        done.push({ path, name: p.name, size: p.size, type: p.type });
        bytes += p.size;
      }
    } catch (e) {
      for (const a of done) { try { await AppStorage.remove(a.path); } catch (_) {} }
      throw e;
    }
    return { done, bytes };
  }

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
      return must(await q.order('created_at', { ascending: false }).limit(opts.limit || 300)) || [];
    },
    // 送る。files（File の配列）は先にアップロードして、失敗したら片付ける
    //   { caseId, phaseId, toUser（null = 管理者全員）, subject, body, files, replyTo }
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
          case_id: f.caseId, phase_id: f.phaseId || null, to_user: f.toUser || null,
          subject, body, attachments: done, reply_to: f.replyTo || null
        }).select(COLS).single());
        if (bytes) { try { await addUsage(bytes, 0); } catch (e) { console.warn('使用量の更新に失敗', e); } }
        return row;
      } catch (e) {
        for (const a of done) { try { await AppStorage.remove(a.path); } catch (_) {} }
        throw e;
      }
    },
    // 日報を送る（Task 29 / migration 053）。その日（日本時間）の自分の日報があれば中身を差し替えて未読に戻す（rpc が判定）
    //   { body, keep: 残す写真（前に送った attachments）, files: 足す写真（File） } → 送った行（resent: 送り直しか）
    async sendDaily(f) {
      const body = String(f.body || '');
      if (!body.trim()) throw new Error('日報の中身がありません');
      if (body.length > BODY_MAX) throw new Error('日報は' + BODY_MAX + '文字までです');
      const keep = Array.from(f.keep || []);
      const files = Array.from(f.files || []);
      if (keep.length + files.length > FILES_MAX) throw new Error('写真は' + FILES_MAX + '枚までです');
      const { done, bytes } = await uploadAll(files, dailyDir());
      try {
        const row = must(await sb.rpc('staff_daily_send', { p_body: body, p_attachments: keep.concat(done) }));
        if (bytes) { try { await addUsage(bytes, 0); } catch (e) { console.warn('使用量の更新に失敗', e); } }
        return row;
      } catch (e) {
        for (const a of done) { try { await AppStorage.remove(a.path); } catch (_) {} }
        throw e;
      }
    },
    // 既読にする（宛先の人だけ。RLS で 0 行なら false）
    async markRead(id) {
      const rows = must(await sb.from('staff_messages').update({ read_at: new Date().toISOString() }).eq('id', id).is('read_at', null).select('id'));
      return !!(rows && rows.length);
    },
    photoUrl(path) { return AppStorage.getUrl(path); }
  };
  return api;
})();
