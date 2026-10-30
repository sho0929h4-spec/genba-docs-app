// js/share-ui.js — 報告書・見積書の PDF プレビュー・工事掲示の編集画面の「共有」（Task 68・Task 72・Task 79）。文面とファイル名は ShareLogic（js/share-logic.js）
// ShareUi.mount(host, { doc: 'report'|'estimate'|'notice', row, caseRow, makeBlob, onChange, data?, before? })
//   data: 工事掲示の data（件名の号室・ファイル名）。before: ボタンを押したとき、シートを開く前の確認（async → false なら開かない。工事掲示の入力チェック）
//   … 「LINEで共有」「メールで共有」の2つのボタンと「送付済み（M/D H:MM）」の行（管理者は「送っていないに戻す」）を host に描く
//   出す人（Task 72）: 管理者／その書類の対応の作業担当者（caseRow.phases の worker_id。管理者から振られた案件でも）／現場用で自分が登録した案件
//     （画面は created_by・worker_id で出し分け、最後は DB の doc_share_sent（migration 087）が断る）。見積書も同じ（PDF は販売金額だけで原価は出ない）
//   出す書類: 報告書（現地確認の記録は出さない）・見積書。下書きは「提出すると共有できます」
//   工事掲示（Task 79）: 状態が無いのでいつでも出す。出す人は報告書と同じ（掲示の phase_id の作業担当者。phase の無い掲示は管理者と登録した本人だけ。DB は 093）
// シート（× だけで閉じる）: 押したボタンの手段の文面（LINE = 短め（宛名・署名なし）／メール = 件名＋本文。直せる）→
//   ファイルを渡せる端末（navigator.canShare({ files })）: 「PDF と文面を共有する」= PDF ファイル＋文面を OS の共有へ・「文面をコピー」
//   それ以外（PC）: メール = 「メールを開く」（mailto: 件名＋本文＋PDF のリンク）／LINE = 「文面とリンクをコピー」・「LINEで開く」
//   PDF のリンクは今の送付メールの公開 PDF（mail_drafts の下書き＋ ReportsApi.preparePdfLink。推測できない URL）。
//   共有したら ReportsApi.shareSent（DB の doc_share_sent: 送付済み・タイムライン「302号室 調査報告書を共有した（LINE）」）。1回開いたシートで記録は1回
const ShareUi = (() => {
  const isOwner = () => !!(ctx && ctx.membership && ctx.membership.role === 'owner');
  const myId = () => (ctx && ctx.user && ctx.user.id) || null;
  const phaseOf = (row, caseRow) => (Array.isArray(caseRow && caseRow.phases) ? caseRow.phases : []).find(p => p && row && p.id === row.phase_id);
  const allowed = (caseRow, row) => isOwner() || (!!caseRow && !!myId()
    && (caseRow.created_by === myId() || (phaseOf(row, caseRow) || {}).worker_id === myId()));
  const isRecord = (doc, row) => doc === 'report' && row.work_type === 'site_check';
  const ready = (doc, row) => (doc === 'notice' || (doc === 'estimate' ? ['issued', 'sent', 'accepted'].includes(row.status) : row.status !== 'draft'));
  const docWord = doc => (doc === 'estimate' ? '見積書' : doc === 'notice' ? '工事掲示' : '報告書');

  async function mount(host, o) {
    const seq = host._shrSeq = (host._shrSeq || 0) + 1;
    host.replaceChildren();
    host.hidden = true;
    if (!o.row || !allowed(o.caseRow, o.row) || isRecord(o.doc, o.row)) return;
    host.hidden = false;
    if (!ready(o.doc, o.row)) { host.appendChild(mk('div', 'rep-sub', '提出すると LINE・メールで共有できます')); return; }
    const btns = mk('div', 'dsh-btns');
    [['line', 'LINEで共有', 'chat'], ['mail', 'メールで共有', 'mail']].forEach(([via, t, icon]) => {
      const b = dBtn(t, 'btn inline', async () => { if (!o.before || await o.before()) openSheet(o, via); });
      b.id = 'dsh-open-' + via;
      Icon.prepend(b, icon);
      btns.appendChild(b);
    });
    host.appendChild(btns);
    let last = null;
    try { last = await ReportsApi.lastSent(o.doc, o.row.id); } catch (e) { console.warn('送付の記録を読めませんでした', e); }
    if (seq !== host._shrSeq || !last) return;
    const line = mk('div', 'dsh-sent');
    line.id = 'dsh-sent';
    line.appendChild(mk('span', null, '送付済み（' + PhaseLogic.fmtMDHM(last.sent_at) + '）'));
    if (isOwner()) {
      const undo = dBtn('送っていないに戻す', 'btn sm ghost inline', async b => {
        const ok = await askPopup('この' + docWord(o.doc) + 'を「送っていない」に戻しますか？\n送付の記録を外し、送るメールの一覧に下書きとして戻します。PDF のリンクはそのままです。',
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

  // via: 'line'（短め・件名なし）| 'mail'（件名＋本文）
  function openSheet(o, via) {
    const line = via === 'line';
    const prev = document.getElementById('dsh-sheet');
    if (prev) prev.remove();
    const kind = ShareLogic.kindName(o.doc, o.row, o.caseRow);
    const label = ShareLogic.docLabel(o.doc, kind);
    const fname = ShareLogic.fileName(o.doc, kind, o.caseRow, o.data);
    const m0 = ctx.membership || {};
    const m1 = ShareLogic.message({ doc: o.doc, kind, caseRow: o.caseRow, data: o.data, org: ctx.org || {}, me: { name: m0.display_name, tel: m0.phone }, short: line });
    const linkLabel = docWord(o.doc) + 'PDF: ';
    const st = { file: null, mode: '', draft: null, url: '', sent: '', busy: true };

    const bg = mk('div', 'modal-bg dsh-bg');
    bg.id = 'dsh-sheet';
    const dlg = mk('div', 'modal dsh-sheet');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'dsh-title');
    const hd = mk('div', 'modal-hd');
    const h = mk('h3', null, line ? 'LINEで共有' : 'メールで共有');
    h.id = 'dsh-title';
    const x = dBtn('×', 'modal-x', () => { if (st.busy && st.mode) return; bg.remove(); if (st.sent && o.onChange) o.onChange(); });
    x.id = 'dsh-x';
    x.setAttribute('aria-label', '閉じる');
    hd.append(h, x);
    const file = mk('div', 'rep-sub', label + ' ・ ' + fname);
    file.id = 'dsh-file';
    const subj = document.createElement('input');
    subj.type = 'text';
    subj.id = 'dsh-subject';
    const body = document.createElement('textarea');
    body.id = 'dsh-body';
    body.rows = line ? 7 : 11;
    const ff = (t, c) => { const d = mk('div', 'ff'); const l = mk('label', null, t); l.htmlFor = c.id; d.append(l, c); return d; };
    const note = mk('div', 'rep-sub dsh-note');
    note.id = 'dsh-note';
    const acts = mk('div', 'dsh-acts');
    const msg = mk('div', 'err');
    msg.id = 'dsh-msg';
    const out = mk('div', 'dsh-out');
    out.id = 'dsh-out';
    subj.value = m1.subject;
    body.value = m1.body;
    dlg.append(hd, file, ...(line ? [] : [ff('件名', subj)]), ff('本文', body), note, acts, msg, out); // LINE に件名は無い
    bg.appendChild(dlg);
    document.body.appendChild(bg);

    const cur = () => ({ subject: subj.value, body: body.value });
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
      // メールは title も渡す（件名に入れるアプリがある）
      try { p = navigator.share(Object.assign({ files: [st.file], text: cur().body }, line ? {} : { title: cur().subject })); }
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

    const busyLine = mk('div', 'rep-sub', 'PDFを作成中…');
    busyLine.id = 'dsh-busy';
    acts.appendChild(busyLine);
    sync();
    (async () => {
      try {
        st.blob = await o.makeBlob(t => { busyLine.textContent = 'PDFを作成中…（' + t + '）'; });
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
      const app = line ? 'LINE' : 'メール';
      if (files) {
        note.textContent = 'PDF のファイルと本文をスマホの共有に渡します。出てきた一覧から' + app + 'のアプリを選んでください。本文が入らないときは「文面をコピー」で貼り付けてください';
        acts.replaceChildren(b('PDF と文面を共有する', 'dsh-share', share, 'btn', 'send'), b('文面をコピー', 'dsh-copy', copyText, 'btn ghost', 'clipboard'));
      } else {
        note.textContent = '送るときに PDF のリンク（URL を知っている人だけが開けます）を本文に入れます';
        acts.replaceChildren(line ? b('文面とリンクをコピー（LINE に貼り付け）', 'dsh-line', sendLine, 'btn', 'chat') : b('メールを開く', 'dsh-mail', sendMail, 'btn', 'mail'));
      }
      st.busy = false;
      sync();
    })();
  }

  return { mount, openSheet, allowed };
})();
