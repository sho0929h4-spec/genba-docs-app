// js/estimates-api.js — 見積書のDBアクセス・版管理・送付（Supabase呼び出しはここに集約）
// DB（migration 014/015）の決まり:
//   - lines の amount は整数 Number、postTax は boolean で送る（文字列だとトリガーが拒否）
//   - lines の cost（原価）は 0 以上の整数 Number、priceOverride は boolean（migration 036）。margin_pct・source_pdf_path は下書きのときだけ
//   - subtotal/tax/total は明細から DB でも再検算され、不一致なら保存を拒否
//   - 提出（番号の採番）は rpc('issue_estimate') だけ。提出後は data・lines・合計を変更できない（次の版を作る）
//   - number は系列で共通の 'EST-0000000001'。表示の「-v2」は displayNumber で付ける
//   - linked_request_ids は同じ案件の依頼（timeline_entries.type='request'）のみ
// 依存: sb, ctx, CryptoUtil, window.EstimateLogic, window.ReportLogic（PDF_LINK）
const EstimatesApi = (() => {
  const EL = () => window.EstimateLogic;
  const must = ({ data, error }) => { if (error) throw error; return data; };
  const now = () => new Date().toISOString();
  const str = v => (v == null ? '' : String(v));
  const t = v => str(v).trim();
  const SENDABLE = ['issued', 'sent', 'accepted'];
  const isAdjust = l => EL().isAdjustLine(l); // 「税込合計を00に」の調整行は内部フラグ isAdjust で判定（摘要が「値引き」の手入力行と区別）

  async function logSystem(caseId, body) {
    try {
      const text = typeof body === 'function' ? body() : body;
      must(await sb.from('timeline_entries').insert({ case_id: caseId, type: 'system', body: text }));
    } catch (e) { console.warn('自動記録に失敗', e); }
  }
  // 版に紐付けた未対応の依頼を反映済みにする（送付・承諾のとき）。反映した件数を返す。失敗は warn のみ
  async function resolveLinked(est) {
    const ids = ((est && est.linked_request_ids) || []).filter(Boolean);
    if (!ids.length) return 0;
    try {
      const rows = must(await sb.from('timeline_entries').update({ resolved_at: now() })
        .in('id', ids).eq('type', 'request').is('resolved_at', null).select('id'));
      return (rows || []).length;
    } catch (e) { console.warn('依頼の対応済みへの更新に失敗', e); return 0; }
  }

  // ── 明細の正規化（DB に送る形）──────────────────────────────────────────────
  // amount: 整数 Number / quantity: Number / postTax: boolean（false は送らない）/ 諸経費の自動行を再計算 /
  // 「税込合計を00に」の値引き行は、ほかの明細の変更に合わせて端数を取り直す（端数0なら金額0のまま残す＝ONの状態を保つ）
  function normalizeLines(lines) {
    const toInt = v => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };
    const toNum = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    let ls = (Array.isArray(lines) ? lines : []).map(l => {
      const o = Object.assign({}, l || {});
      o.description = str(o.description);
      o.detail = str(o.detail);
      o.unit = str(o.unit);
      o.quantity = toNum(o.quantity);
      o.amount = toInt(o.amount);
      if (o.postTax === true || o.postTax === 'true') o.postTax = true; else delete o.postTax;
      if (o.isAdjust === true && o.postTax) o.isAdjust = true; else delete o.isAdjust;
      if (o.isAutoShokehi) { o.isAutoShokehi = true; o.shokehiPct = toNum(o.shokehiPct); }
      else { delete o.isAutoShokehi; delete o.shokehiPct; }
      // 原価（Task 19・migration 036）: 0 以上の整数の円。空・不正は持たない。個別の印は原価のある行だけ true で送る
      if (EL().hasCost(o) && Number(o.cost) >= 0) o.cost = toInt(o.cost); else delete o.cost;
      if (o.priceOverride === true && o.cost !== undefined) o.priceOverride = true; else delete o.priceOverride;
      return o;
    });
    ls = EL().recalcShokehi(ls).map(o => Object.assign(o, { amount: toInt(o.amount) || 0 })); // -0 → 0
    const ai = ls.findIndex(isAdjust);
    if (ai >= 0) {
      const rest = ls.filter((_, i) => i !== ai);
      const total = EL().totals(rest).total;
      const rem = ((total % 100) + 100) % 100;
      ls[ai] = Object.assign({}, ls[ai], { amount: rem ? -rem : 0, quantity: 1 });
      ls = ls.filter((_, i) => i !== ai).concat([ls[ai]]); // 値引き行は常に末尾
    }
    return ls;
  }
  function withTotals(lines) {
    const ls = normalizeLines(lines);
    const tt = EL().totals(ls);
    if (tt.subtotal < 0) throw new Error('小計がマイナスです（値引きは「税込合計を00に」か、税対象外の行で入力してください）');
    return { lines: ls, subtotal: tt.subtotal, tax: tt.tax, total: tt.total };
  }

  // DB の number に v2 以降「-vN」を付ける（未提出は空）
  function displayNumber(est) {
    const e = est || {};
    const n = t(e.number);
    if (!n) return '';
    const v = Number(e.version) || 1;
    return v >= 2 ? `${n}-v${v}` : n;
  }

  // ReportLogic.buildMail を見積用に一般化した文面（署名・PDFリンクの行・宛名の形は同じ）
  function ymdJa(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t(s));
    return m ? `${+m[1]}年${+m[2]}月${+m[3]}日` : '';
  }
  function buildMail({ caseRow, org, est }) {
    const c = caseRow || {}, o = org || {}, e = est || {};
    const d = e.data || {};
    const v = Number(e.version) || 1;
    const subj = t(d.subject) || t(c.name);
    const orgName = t(o.name);
    const client = t(d.client) || t(c.client_name);
    const subject = `【御見積書】${subj}${v >= 2 ? `（v${v}）` : ''}`;
    const facts = [];
    const no = displayNumber(e);
    if (no) facts.push(`■ 見積番号　${no}`);
    facts.push(`■ 見積金額　${EL().yen(e.total)}（税込）`);
    if (ymdJa(d.validUntil)) facts.push(`■ 有効期限　${ymdJa(d.validUntil)}`);
    const sign = [orgName, [t(o.address), t(o.tel)].filter(Boolean).join(' ／ '), t(o.email)].filter(Boolean);
    const lines = [
      client ? `${client} ご担当者様` : 'ご担当者様',
      '',
      `お世話になっております。${orgName ? orgName + 'でございます。' : ''}`, // Task 23: 書き出しは連絡メールと同じ（「いつも」は使わない）
      v >= 2 ? `${subj}につきまして、内容を見直したお見積書（第${v}版）をお送りいたします。`
             : `${subj}のお見積書をお送りいたします。`,
      '',
      ...facts,
      '',
      window.ReportLogic.PDF_LINK,
      '',
      'ご確認のほどよろしくお願いいたします。',
      '',
      '――――――――――',
      ...sign
    ];
    return { to: t(c.client_email), subject, body: lines.join('\n') };
  }

  const api = {
    normalizeLines, displayNumber, buildMail,

    // 系列ごと: [{ series_id, latest, versions: [新しい版から] }]。最新版の更新が新しい系列から
    async listByCase(caseId) {
      const rows = must(await sb.from('estimates').select('*').eq('case_id', caseId)
        .order('version', { ascending: false }));
      const map = new Map();
      for (const r of rows || []) {
        if (!map.has(r.series_id)) map.set(r.series_id, []);
        map.get(r.series_id).push(r);
      }
      const out = [];
      for (const [series_id, vs] of map) {
        vs.sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0));
        out.push({ series_id, latest: vs[0], versions: vs });
      }
      const ts = s => Date.parse(s.latest.updated_at || s.latest.created_at || 0) || 0;
      out.sort((a, b) => ts(b) - ts(a));
      return out;
    },
    async get(id) {
      return must(await sb.from('estimates').select('*').eq('id', id).maybeSingle());
    },
    // 新しい系列の v1 下書き。opts.phase_id: 対応フェーズのカードから作るとき（次の版も同じフェーズ。migration 021）
    async create(caseId, caseRow, opts = {}) {
      let c = caseRow;
      if (!c) c = must(await sb.from('case_summaries').select('*').eq('id', caseId).maybeSingle());
      const me = ctx.membership ? { display_name: ctx.membership.display_name || '' } : null;
      const e = EL().emptyEstimate(c || {}, ctx.org, me);
      // 工事カードから作るときは、調査結果の注意事項の文を備考の初期値に（opts.noteExtra。NOTE_FIRST は備考の1行目に必ず入る）
      if (opts && typeof opts.noteExtra === 'string' && opts.noteExtra.trim()) e.data.notes.extra = opts.noteExtra.trim();
      const tt = withTotals(e.lines);
      const ins = {
        case_id: caseId, series_id: CryptoUtil.uuid(), version: 1, status: 'draft',
        data: e.data, lines: tt.lines, subtotal: tt.subtotal, tax: tt.tax, total: tt.total
      };
      if (opts && opts.phase_id) ins.phase_id = opts.phase_id;
      const row = must(await sb.from('estimates').insert(ins).select().single());
      await logSystem(caseId, `${opts && opts.phaseTitle ? opts.phaseTitle + 'の' : ''}見積書（下書き）を作った`);
      return row;
    },
    // 下書きのみ。lines を渡したら正規化して合計も一緒に送る
    async save(id, fields) {
      const f = fields || {};
      const patch = {};
      if (f.data !== undefined) {
        if (!f.data || typeof f.data !== 'object' || Array.isArray(f.data)) throw new Error('見積の内容が正しくありません');
        patch.data = f.data;
      }
      if (f.lines !== undefined) Object.assign(patch, withTotals(f.lines));
      // 利益率（%。null = 未設定）・読み込んだ業者PDFの保存先（migration 036）
      if (f.margin_pct !== undefined) {
        const m = f.margin_pct === null ? null : EL().normMargin(f.margin_pct);
        if (f.margin_pct !== null && m === null) throw new Error('利益率は0〜999の数字で入力してください');
        patch.margin_pct = m;
      }
      if (f.source_pdf_path !== undefined) patch.source_pdf_path = f.source_pdf_path || null;
      if (Object.keys(patch).length === 0) throw new Error('保存する項目がありません');
      const rows = must(await sb.from('estimates').update(patch).eq('id', id).eq('status', 'draft').select());
      if (!rows || rows.length === 0) throw new Error('提出済みの見積書は編集できません。新しい版を作ってください');
      return rows[0];
    },
    // 業者の見積PDFを AI で読み取る（Edge Function parse-estimate-pdf。Task 19）。→ { items, total, totalEx, subject, notes }
    // 失敗は日本語のメッセージで throw（関数が無い・APIキー未登録は「AI読み取りの準備ができていません」）。画面は文字抽出に切り替える
    async parsePdfAi(buf) {
      if (!sb.functions || typeof sb.functions.invoke !== 'function') throw new Error('AI読み取りの準備ができていません');
      let res;
      try {
        res = await sb.functions.invoke('parse-estimate-pdf', { body: new Blob([buf], { type: 'application/pdf' }), headers: { 'Content-Type': 'application/pdf' } });
      } catch (e) { throw new Error('AI読み取りにつながりませんでした'); }
      const { data, error } = res || {};
      if (error) {
        let msg = '', status = 0;
        const ctxRes = error.context;
        if (ctxRes && typeof ctxRes.json === 'function') {
          status = Number(ctxRes.status) || 0;
          try { const j = await ctxRes.json(); msg = j && typeof j.error === 'string' ? j.error : ''; } catch (e) { /* JSON でない */ }
        }
        if (!msg && (status === 404 || !status)) msg = 'AI読み取りの準備ができていません（読み取りの関数がまだ公開されていません）';
        throw new Error(msg || 'AI読み取りに失敗しました（' + status + '）');
      }
      if (!data || !Array.isArray(data.items)) throw new Error('AI の返事を読み取れませんでした');
      return { items: data.items, total: Number(data.total) || 0, totalEx: Number(data.total_ex) || 0, subject: String(data.subject || ''), notes: String(data.notes || '') };
    },
    // 読み込んだ業者の見積PDFを非公開フォルダに保存して、保存先を返す（見積の行の source_pdf_path は呼び出し側が保存で書く）。
    // パスは {org}/cases/{case}/estimates/{見積ID}/src-{乱数}.pdf（DB の check と同じ形）。容量の上限を見て、使用量に足す
    async uploadSourcePdf(est, blob) {
      if (!est || !est.id) throw new Error('見積書が見つかりません');
      const size = blob && blob.size ? blob.size : 0;
      const q = await checkQuota(size, 0);
      if (!q.ok) throw new Error(q.reason);
      const path = `${ctx.org.id}/cases/${est.case_id}/estimates/${est.id}/src-${CryptoUtil.uuid().replace(/-/g, '')}.pdf`;
      await AppStorage.upload(path, blob, { contentType: 'application/pdf', upsert: false });
      try { await addUsage(size, 0); } catch (e) { console.warn('使用量の更新に失敗', e); }
      return path;
    },
    // 提出（採番）。DB の最新内容で検証してから rpc
    async issue(id) {
      const cur = await api.get(id);
      if (!cur) throw new Error('見積書が見つかりません');
      if (cur.status !== 'draft') throw new Error('この見積書はすでに提出されています');
      const { errors } = EL().validate(cur);
      if (errors.length) throw new Error(errors.join('\n'));
      const row = must(await sb.rpc('issue_estimate', { p_id: id }));
      const r = Array.isArray(row) ? row[0] : row;
      if (!r) throw new Error('提出できませんでした');
      await logSystem(r.case_id, () => `見積書（${displayNumber(r)}）を提出した`);
      return r;
    },
    // 提出済み/送付済みの版から次の版の下書きを作り、前の版を superseded にする。
    // DB 関数 new_estimate_version が1トランザクションで行う（系列の行をロック・最新版か検査・明細の引き継ぎ規則は
    // nextVersionFrom と同じ・合計の計算・linked の検査）。競合や状態の変化は DB が日本語の例外で返す
    async newVersion(est, linkedRequestIds) {
      if (!est || !est.id) throw new Error('見積書が見つかりません');
      if (!['issued', 'sent'].includes(est.status)) throw new Error('提出済みか送付済みの見積書から新しい版を作れます');
      const ids = Array.from(new Set((linkedRequestIds || []).filter(Boolean).map(String)));
      const res = must(await sb.rpc('new_estimate_version', { p_id: est.id, p_linked: ids }));
      const newId = Array.isArray(res) ? res[0] : res;
      if (!newId) throw new Error('新しい版を作れませんでした');
      const row = await api.get(newId);
      if (!row) throw new Error('作成した版が見つかりません。見積書一覧を開き直してください');
      await logSystem(est.case_id, () => `見積書（${t(est.number)}）の第${row.version}版を作成した${ids.length ? `（依頼${ids.length}件を紐付け）` : ''}`);
      return row;
    },
    // 系列の全版（新しい版から）
    async listVersions(seriesId) {
      const rows = must(await sb.from('estimates').select('*').eq('series_id', seriesId).order('version', { ascending: false }));
      return (rows || []).slice().sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0));
    },
    // この版より新しい版が系列にあるか
    async hasNewer(est) {
      const rows = must(await sb.from('estimates').select('id, version').eq('series_id', est.series_id));
      return (rows || []).some(r => (Number(r.version) || 0) > (Number(est.version) || 0));
    },
    // 案件の未対応の依頼（タイムラインの type=request・resolved_at なし）。新しい順
    async listOpenRequests(caseId) {
      const rows = must(await sb.from('timeline_entries').select('id, body, created_at, resolved_at')
        .eq('case_id', caseId).eq('type', 'request').is('resolved_at', null).order('created_at', { ascending: false }));
      return rows || [];
    },
    // 版に紐付けた依頼（本文と対応済みか）
    async linkedRequests(est) {
      const ids = ((est && est.linked_request_ids) || []).filter(Boolean);
      if (!ids.length) return [];
      return must(await sb.from('timeline_entries').select('id, body, created_at, resolved_at').in('id', ids)) || [];
    },
    // この版の未送信のメール下書き（あれば再利用）
    async findMailDraft(estId) {
      const rows = must(await sb.from('mail_drafts').select('*').eq('estimate_id', estId).eq('status', 'draft')
        .order('created_at', { ascending: false }));
      return (rows && rows[0]) || null;
    },
    // 承諾: accepted・accepted_at、タイムライン記録（次やること「承諾待ち」の完了はやめた。段階は対応フェーズの見積から出る）
    async accept(est) {
      if (!est || !est.id) throw new Error('見積書が見つかりません');
      if (await api.hasNewer(est)) throw new Error('この版より新しい版があります。最新の版で承諾してください');
      const rows = must(await sb.from('estimates').update({ status: 'accepted', accepted_at: now() })
        .eq('id', est.id).in('status', ['issued', 'sent']).select());
      if (!rows || rows.length === 0) throw new Error('提出済みか送付済みの見積書だけ承諾にできます');
      const row = rows[0];
      const n = await resolveLinked(row);
      await logSystem(row.case_id, () => `見積書（${displayNumber(row)}）が承諾された（${EL().yen(row.total)}）${n ? `（依頼${n}件を反映済みに）` : ''}`);
      return row;
    },
    // 下書きのみ削除可（RLS）。0行なら throw
    async remove(id) {
      const rows = must(await sb.from('estimates').delete().eq('id', id).eq('status', 'draft').select('id'));
      if (!rows || rows.length === 0) throw new Error('削除できませんでした（下書きの見積書のみ削除できます）');
    },
    // 送付メールの下書き（mail_drafts に estimate_id 付き）。提出済み（番号あり）の版だけ
    async createMailDraft(est, caseRow) {
      if (!est || !SENDABLE.includes(est.status)) throw new Error('提出してから送付してください');
      let c = caseRow;
      if (!c) c = must(await sb.from('cases').select('*').eq('id', est.case_id).maybeSingle());
      const m = buildMail({ caseRow: c, org: ctx.org, est });
      const ins = { case_id: est.case_id, estimate_id: est.id, purpose: 'estimate', to_email: m.to || null, subject: m.subject, body: m.body };
      if (est.phase_id) ins.phase_id = est.phase_id; // 対応フェーズの見積なら、送付メールも同じフェーズ（共有記録 docTrack）
      return must(await sb.from('mail_drafts').insert(ins).select().single());
    },
    // mail-ui の markSent の後に呼ぶ: status sent・sent_at、紐付けた依頼を対応済みに、タイムライン記録。
    // 依頼を対応済みにするのは系列の最新版のときだけ（古い版を送っても反映済みにしない）:
    //   - 提出済み/送付済み → sent にして依頼を反映済みに
    //   - 承諾済み（採用版）→ 状態は変えず、依頼を反映済みに（記録は「採用版を送付した」）
    // mail: markSent が返した mail_drafts の行（宛先・件名を記録に入れる。markSent 側は記録しない＝1件にまとめる）
    async onMailSent(est, mail) {
      if (!est || !est.id) return null;
      let row = null, adopted = null;
      try {
        if (!(await api.hasNewer(est))) {
          const rows = must(await sb.from('estimates').update({ status: 'sent', sent_at: now() })
            .eq('id', est.id).in('status', ['issued', 'sent']).select());
          row = rows && rows[0];
          if (!row) {
            const cur = await api.get(est.id);
            if (cur && cur.status === 'accepted') adopted = cur;
          }
        }
        if (!row && !adopted) console.warn('最新の提出済みの版でないため送付済みにしませんでした', est.id);
      } catch (e) { console.warn('見積書の状態更新に失敗', e); }
      const target = row || adopted;
      const n = target ? await resolveLinked(target) : 0;
      const cur = target || est;
      const what = adopted ? `見積書（${displayNumber(cur)}）の採用版を送付した` : `見積書（${displayNumber(cur)}）を送付した`;
      const to = mail ? `（宛先: ${mail.to_email || '未入力'}／件名: ${mail.subject || '（なし）'}）` : '';
      await logSystem(cur.case_id, () => `${what}${to}${target ? (n ? `（依頼${n}件を反映済みに）` : '') : '（旧版のため状態は変えていません）'}`);
      return row || adopted;
    }
  };
  return api;
})();
