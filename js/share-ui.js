// js/share-ui.js — 報告書・見積書の PDF プレビューの「共有」（Task 68）。文面とファイル名は ShareLogic（js/share-logic.js）
// ShareUi.mount(host, { doc: 'report'|'estimate', row, caseRow, makeBlob, onChange })
//   … 共有のボタンと「送付済み（M/D H:MM）」の行（管理者は「送っていないに戻す」）を host に描く
//   出す人: 管理者／作業担当者は現場用で自分が登録した案件（画面は created_by で出し分け、最後は DB の doc_share_sent が断る。Task 42 と同じ）
//   出す書類: 報告書（現地確認の記録は出さない）・見積書。下書きは「提出すると共有できます」
// シート（× だけで閉じる）: 文面（メール用／LINE用（短め）。直せる）→
//   ファイルを渡せる端末（navigator.canShare({ files })）: 「共有する（LINE・メールなど）」= PDF ファイル＋文面を OS の共有へ・「文面をコピー」
//   それ以外（PC）: 「メールで送る」= mailto（件名＋本文＋PDF のリンク）／「LINEで送る」= 文面＋リンクをコピー・「LINEで開く」
//   PDF のリンクは今の送付メールの公開 PDF（mail_drafts の下書き＋ ReportsApi.preparePdfLink。推測できない URL）。
//   共有したら ReportsApi.shareSent（DB の doc_share_sent: 送付済み・タイムライン「302号室 調査報告書を共有した（LINE）」）。1回開いたシートで記録は1回
const ShareUi = (() => {
  const isOwner = () => !!(ctx && ctx.membership && ctx.membership.role === 'owner');
  const myId = () => (ctx && ctx.user && ctx.user.id) || null;
  const allowed = caseRow => isOwner() || (!!caseRow && !!myId() && caseRow.created_by === myId());
  const isRecord = (doc, row) => doc === 'report' && row.work_type === 'site_check';
  const ready = (doc, row) => (doc === 'estimate' ? ['issued', 'sent', 'accepted'].includes(row.status) : row.status !== 'draft');

  async function mount(host, o) {
    const seq = host._shrSeq = (host._shrSeq || 0) + 1;
    host.replaceChildren();
    host.hidden = true;
    if (!o.row || !allowed(o.caseRow) || isRecord(o.doc, o.row)) return;
    host.hidden = false;
    if (!ready(o.doc, o.row)) { host.appendChild(mk('div', 'rep-sub', '提出すると共有（メール・LINE）できます')); return; }
    const btn = dBtn('共有（メール・LINE）', 'btn inline', () => openSheet(o));
    btn.id = 'dsh-open';
    Icon.prepend(btn, 'send');
    host.appendChild(btn);
    let last = null;
    try { last = await ReportsApi.lastSent(o.doc, o.row.id); } catch (e) { console.warn('送付の記録を読めませんでした', e); }
    if (seq !== host._shrSeq || !last) return;
    const line = mk('div', 'dsh-sent');
    line.id = 'dsh-sent';
    line.appendChild(mk('span', null, '送付済み（' + PhaseLogic.fmtMDHM(last.sent_at) + '）'));
    if (isOwner()) {
      const undo = dBtn('送っていないに戻す', 'btn sm ghost inline', async b => {
        const ok = await askPopup('この' + (o.doc === 'estimate' ? '見積書' : '報告書') + 'を「送っていない」に戻しますか？\n送付の記録を外し、送るメールの一覧に下書きとして戻します。PDF のリンクはそのままです。',
          { title: '送っていないに戻す', okLabel: '戻す', id: 'dsh-undo-ask' });
        if (!ok) return;
        b.disabled = true;
        try { await ReportsApi.shareUndo(last); }
        catch (e) { b.disabled = false; line.appendChild(mk('div', 'err', '戻せませんでした: ' + errText(e))); return; }
        if (o.onChange) o.onChange(); else mount(host, o);
      });
      undo.id = 'dsh-undo';
      line.appendChild(undo);
    }
    host.appendChild(line);
  }

  function openSheet(o) {
    const prev = document.getElementById('dsh-sheet');
    if (prev) prev.remove();
    const kind = ShareLogic.kindName(o.doc, o.row, o.caseRow);
    const label = ShareLogic.docLabel(o.doc, kind);
    const fname = ShareLogic.fileName(o.doc, kind, o.caseRow);
    const m0 = ctx.membership || {};
    const build = short => ShareLogic.message({ doc: o.doc, kind, caseRow: o.caseRow, org: ctx.org || {}, me: { name: m0.display_name, tel: m0.phone }, short });
    const linkLabel = (o.doc === 'estimate' ? '見積書' : '報告書') + 'PDF: ';
    const st = { short: false, file: null, mode: '', draft: null, url: '', sent: '', busy: true };

    const bg = mk('div', 'modal-bg dsh-bg');
    bg.id = 'dsh-sheet';
    const dlg = mk('div', 'modal dsh-sheet');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'dsh-title');
    const hd = mk('div', 'modal-hd');
    const h = mk('h3', null, '共有（メール・LINE）');
    h.id = 'dsh-title';
    const x = dBtn('×', 'modal-x', () => { if (st.busy && st.mode) return; bg.remove(); if (st.sent && o.onChange) o.onChange(); });
    x.id = 'dsh-x';
    x.setAttribute('aria-label', '閉じる');
    hd.append(h, x);
    const file = mk('div', 'rep-sub', label + ' ・ ' + fname);
    file.id = 'dsh-file';
    const seg = mk('div', 'dsh-seg');
    const segBtn = (t, short) => { const b = dBtn(t, 'dsh-seg-b', () => setShort(short)); b.dataset.short = short ? '1' : '0'; return b; };
    seg.append(segBtn('メール用', false), segBtn('LINE用（短め）', true));
    const subj = document.createElement('input');
    subj.type = 'text';
    subj.id = 'dsh-subject';
    const body = document.createElement('textarea');
    body.id = 'dsh-body';
    body.rows = 11;
    const ff = (t, c) => { const d = mk('div', 'ff'); const l = mk('label', null, t); l.htmlFor = c.id; d.append(l, c); return d; };
    const note = mk('div', 'rep-sub dsh-note');
    note.id = 'dsh-note';
    const acts = mk('div', 'dsh-acts');
    const msg = mk('div', 'err');
    msg.id = 'dsh-msg';
    const out = mk('div', 'dsh-out');
    out.id = 'dsh-out';
    dlg.append(hd, file, seg, ff('件名', subj), ff('本文', body), note, acts, msg, out);
    bg.appendChild(dlg);
    document.body.appendChild(bg);

    const cur = () => ({ subject: subj.value, body: body.value });
    function setShort(short) {
      st.short = short;
      const m = build(short);
      subj.value = m.subject;
      body.value = m.body;
      seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.short === (short ? '1' : '0'))));
    }
    setShort(false);
    const sync = () => acts.querySelectorAll('button').forEach(b => { b.disabled = st.busy; });

    // 1回のシートで記録は1回（同じリンクでメールと LINE の両方に送っても送付の記録は1件）
    async function record(via) {
      if (st.sent) return;
      if (!st.draft) st.draft = await ReportsApi.shareDraft(o.doc, o.row, cur());
      await ReportsApi.shareSent(st.draft, via);
      st.sent = via;
      // 確認待ちから共有したときは「確認した」と同じく調査結果へ写す（ReportsApi.confirm と同じ。失敗しても共有は止めない）
      if (o.doc === 'report' && o.row.status === 'submitted') await ReportsApi.syncSurveyResult(o.row);
      out.appendChild(mk('div', 'dsh-ok', '送付済みにしました（' + ShareLogic.viaLabel(via) + '）。案件のタイムラインに記録しました'));
    }
    async function ensureLink() {
      if (st.url) return st.url;
      st.draft = await ReportsApi.shareDraft(o.doc, o.row, cur());
      st.url = await ReportsApi.preparePdfLink(st.draft, st.blob, fname);
      return st.url;
    }
    const run = async (fn, what) => {
      if (st.busy) return;
      st.busy = true;
      sync();
      msg.textContent = '';
      try { await fn(); } catch (e) { msg.textContent = what + ': ' + errText(e); }
      st.busy = false;
      sync();
    };
    // スマホ: OS の共有（押したその場で呼ぶ。待ってから呼ぶと端末が断る）
    function share() {
      if (st.busy) return;
      let p;
      try { p = navigator.share({ files: [st.file], text: cur().body }); }
      catch (e) { msg.textContent = '共有できませんでした: ' + errText(e); return; }
      run(async () => {
        try { await p; } catch (e) { if (e && e.name === 'AbortError') return; throw e; }
        out.replaceChildren();
        await record('share');
      }, '共有できませんでした');
    }
    const copyText = () => run(async () => {
      const ok = typeof mlCopy === 'function' && await mlCopy(cur().body);
      out.replaceChildren(mk('div', ok ? 'dsh-ok' : 'err', ok ? '文面をコピーしました。送り先のアプリに貼り付けてください' : 'コピーできませんでした。本文を選んでコピーしてください'));
    }, 'コピーできませんでした');
    const sendMail = () => run(async () => {
      const url = await ensureLink();
      const m = cur();
      const to = String(o.caseRow.client_master_email || o.caseRow.client_email || '').trim();
      const built = ReportLogic.buildMailto({ to, cc: '', subject: m.subject, body: ShareLogic.withLink(m.body, ReportLogic.PDF_LINK), link: linkLabel + url });
      out.replaceChildren(mk('div', 'dsh-ok', 'メールアプリを開きました。送信してください' + (built.shortened ? '（本文が長いため短くしています）' : '')));
      mlOpenMailto(built.url);
      await record('mail');
    }, 'メールを開けませんでした');
    const sendLine = () => run(async () => {
      const url = await ensureLink();
      const text = ShareLogic.withLink(cur().body, linkLabel + url);
      const ok = typeof mlCopy === 'function' && await mlCopy(text);
      const kids = [mk('div', ok ? 'dsh-ok' : 'err', ok ? '文面と PDF のリンクをコピーしました。LINE に貼り付けてください'
        : 'コピーできませんでした。下の文面を選んでコピーし、LINE に貼り付けてください')];
      if (!ok) { const t = document.createElement('textarea'); t.readOnly = true; t.value = text; t.className = 'dsh-copybox'; t.id = 'dsh-copybox'; kids.push(t); }
      const a = mk('a', 'btn ghost inline', 'LINEで開く');
      a.id = 'dsh-line-open';
      a.href = ShareLogic.lineUrl(text); // ユーザーが押したときだけ LINE に渡る
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      kids.push(a);
      out.replaceChildren(...kids);
      await record('line');
    }, 'LINE 用の文面を用意できませんでした');

    acts.appendChild(mk('div', 'rep-sub', 'PDFを作成中…'));
    sync();
    (async () => {
      try {
        st.blob = await o.makeBlob();
        st.file = new File([st.blob], fname, { type: 'application/pdf' });
      } catch (e) {
        acts.replaceChildren();
        msg.textContent = 'PDFを作成できませんでした: ' + errText(e);
        st.busy = false;
        return;
      }
      if (!bg.isConnected) return;
      let files = false;
      try { files = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [st.file] })); } catch (e) { files = false; }
      st.mode = files ? 'files' : 'link';
      const b = (t, id, fn, cls, icon) => { const x2 = dBtn(t, cls, fn); x2.id = id; if (icon) Icon.prepend(x2, icon); return x2; };
      if (files) {
        note.textContent = 'PDF のファイルと本文を、LINE・メールなどのアプリに渡します。本文が入らないアプリは「文面をコピー」で貼り付けてください';
        acts.replaceChildren(b('共有する（LINE・メールなど）', 'dsh-share', share, 'btn', 'send'), b('文面をコピー', 'dsh-copy', copyText, 'btn ghost', 'clipboard'));
      } else {
        note.textContent = '送るときに PDF のリンク（URL を知っている人だけが開けます）を本文に入れます';
        acts.replaceChildren(b('メールで送る', 'dsh-mail', sendMail, 'btn', 'mail'), b('LINEで送る（文面とリンクをコピー）', 'dsh-line', sendLine, 'btn ghost', 'chat'));
      }
      st.busy = false;
      sync();
    })();
  }

  return { mount, openSheet, allowed };
})();
