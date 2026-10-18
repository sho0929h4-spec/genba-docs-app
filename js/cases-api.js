// js/cases-api.js — 案件まわりのDBアクセス（Supabase呼び出しはここに集約）
const CasesApi = (() => {
  const L = () => window.CaseLogic;
  const must = ({ data, error }) => { if (error) throw error; return data; };
  const safeName = n => (n || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);

  // DBの列権限（migration 007 / 008 / 020）で更新できる列だけ。許可外の列が1つでもあるとPATCH全体が403になるため入口で絞る。
  // 020: 元請マスタの client_id と、物件オーナー・入居者の連絡先。client_name / client_email は互換のため残し、
  //      案件の保存時に選んだ元請マスタの値を入れる（画面側 js/case-list.js）
  const CASE_COLS = ['name', 'address', 'client_name', 'client_email', 'assignee_id', 'due_date', 'status',
    'client_id', 'owner_name', 'owner_email', 'owner_tel', 'resident_name', 'resident_email', 'resident_tel'];
  const WORK_COLS = ['kind', 'label', 'worked_at', 'worker_id', 'settle_due', 'settled_at'];
  const ACTION_COLS = ['kind', 'ball', 'title', 'due_date', 'started_on', 'assignee_id', 'done_at'];
  const pick = (obj, cols) => {
    const out = {};
    for (const k of cols) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    return out;
  };

  // body は文字列または関数。関数なら try の内側で評価する（文言生成の失敗で本処理を壊さない）
  async function logSystem(caseId, body) {
    try {
      const text = typeof body === 'function' ? body() : body;
      must(await sb.from('timeline_entries').insert({ case_id: caseId, type: 'system', body: text }));
    } catch (e) { console.warn('自動記録に失敗', e); }
  }

  return {
    async listSummaries() { return must(await sb.from('case_summaries').select('*')); },
    async getSummary(id) { return must(await sb.from('case_summaries').select('*').eq('id', id).maybeSingle()); },
    async listMembers() {
      return must(await sb.from('memberships').select('user_id, display_name').order('display_name'));
    },
    async createCase(fields) {
      const q = await checkQuota(0, 1);
      if (!q.ok) throw new Error(q.reason);
      // cases の insert は表単位で付与済みだが、送る列は更新と同じ許可列に揃える（created_by 等は DB の既定値）
      return must(await sb.from('cases').insert(pick(fields, CASE_COLS)).select().single());
    },
    // before: 変更前の行（渡すと、依頼元が変わったときタイムラインに記録する）
    async updateCase(id, fields, before) {
      const row = must(await sb.from('cases').update(pick(fields, CASE_COLS)).eq('id', id).select().single());
      if (before) {
        const norm = v => (v == null ? '' : String(v).trim());
        const groups = [['元請', ['client_id', 'client_name', 'client_email']],
          ['物件オーナー', ['owner_name', 'owner_email', 'owner_tel']],
          ['入居者', ['resident_name', 'resident_email', 'resident_tel']]];
        const changed = groups.filter(([, cols]) => cols.some(c =>
          Object.prototype.hasOwnProperty.call(fields, c) && norm(fields[c]) !== norm(before[c]))).map(([l]) => l);
        if (changed.length) await logSystem(id, `依頼元を変更した（${changed.join('・')}）`);
      }
      return row;
    },
    async setStatus(id, status) {
      const row = must(await sb.from('cases').update({ status }).eq('id', id).select().single());
      await logSystem(id, () => L().sys.status(status));
      return row;
    },

    async listActions(caseId) {
      return must(await sb.from('case_actions').select('*').eq('case_id', caseId).is('done_at', null)
        .order('due_date', { ascending: true, nullsFirst: false }).order('created_at'));
    },
    // チーム状況用: 進行中の案件の未完了の次やること全部（案件名つき）
    async listOpenActionsAll() {
      return must(await sb.from('case_actions').select('*, cases!inner(name,status)')
        .is('done_at', null).eq('cases.status', 'open'));
    },
    async addAction(caseId, a) {
      return must(await sb.from('case_actions').insert({ case_id: caseId, ...a }).select().single());
    },
    // 次やることの更新。許可列のみ（assignee_id で担当者を振る）
    async updateAction(id, fields) {
      return must(await sb.from('case_actions').update(pick(fields, ACTION_COLS)).eq('id', id).select().single());
    },
    async completeAction(action) {
      must(await sb.from('case_actions').update({ done_at: new Date().toISOString() }).eq('id', action.id));
      await logSystem(action.case_id, () => L().sys.actionDone(action.title));
    },
    async deleteAction(id) {
      const rows = must(await sb.from('case_actions').delete().eq('id', id).select('id'));
      if (!rows || rows.length === 0) throw new Error('削除できませんでした');
    },

    async listWorks(caseId) {
      return must(await sb.from('case_works').select('*').eq('case_id', caseId).order('worked_at', { ascending: false }));
    },
    async addWork(caseId, w) {
      const row = must(await sb.from('case_works').insert({ case_id: caseId, ...w }).select().single());
      await logSystem(caseId, () => L().sys.workAdded(row.kind, row.label, row.worked_at));
      return row;
    },
    async updateWork(id, fields) {
      return must(await sb.from('case_works').update(pick(fields, WORK_COLS)).eq('id', id).select().single());
    },
    async setSettled(work, settled) {
      const row = must(await sb.from('case_works')
        .update({ settled_at: settled ? new Date().toISOString() : null }).eq('id', work.id).select().single());
      if (settled) await logSystem(work.case_id, () => L().sys.settled(work.kind));
      return row;
    },
    async deleteWork(id) {
      const rows = must(await sb.from('case_works').delete().eq('id', id).select('id'));
      if (!rows || rows.length === 0) throw new Error('削除できませんでした');
    },

    async listEntries(caseId) {
      return must(await sb.from('timeline_entries').select('*').eq('case_id', caseId).order('created_at', { ascending: false }));
    },
    // files: File[]（未圧縮）。写真は圧縮してからアップロードする
    async addEntry(caseId, type, body, files) {
      const prepared = [];
      for (const f of files || []) prepared.push(await ImageUtil.prepareFile(f));
      const total = prepared.reduce((s, p) => s + p.size, 0);
      if (total > 0) {
        const q = await checkQuota(total, 0);
        if (!q.ok) throw new Error(q.reason);
      }
      const entryId = CryptoUtil.uuid();
      const attachments = [];
      let row;
      try {
        for (let i = 0; i < prepared.length; i++) {
          const p = prepared[i];
          const path = `${ctx.org.id}/cases/${caseId}/timeline/${entryId}/${i + 1}-${safeName(p.name)}`;
          await AppStorage.upload(path, p.blob, { contentType: p.type });
          attachments.push({ path, name: p.name, size: p.size, type: p.type });
        }
        row = must(await sb.from('timeline_entries')
          .insert({ id: entryId, case_id: caseId, type, body, attachments }).select().single());
      } catch (e) {
        // insert より前（または insert 自体）の失敗のときだけ添付を片付ける
        for (const a of attachments) { try { await AppStorage.remove(a.path); } catch (_) {} }
        throw e;
      }
      // 行は作成済み。使用量の加算に失敗しても成功扱い（添付を消して壊れた行を作らない）
      if (total > 0) {
        try { await addUsage(total, 0); }
        catch (e) { console.warn('使用量の加算に失敗', e); }
      }
      return row;
    },
    async setResolved(id, resolved) {
      return must(await sb.from('timeline_entries')
        .update({ resolved_at: resolved ? new Date().toISOString() : null }).eq('id', id).select().single());
    },
    async deleteEntry(entry) {
      const rows = must(await sb.from('timeline_entries').delete().eq('id', entry.id).select('id'));
      if (!rows || rows.length === 0) throw new Error('この記録は削除できません（自分の投稿かオーナーのみ）');
      const atts = entry.attachments || [];
      let freed = 0;
      for (const a of atts) {
        try { await AppStorage.remove(a.path); freed += a.size || 0; }
        catch (e) { console.warn('添付の削除に失敗', e); }
      }
      if (freed > 0) {
        try { await addUsage(-freed, 0); }
        catch (e) { console.warn('使用量の減算に失敗', e); }
      }
    },
    attachmentUrl(path) { return AppStorage.getUrl(path); }
  };
})();
