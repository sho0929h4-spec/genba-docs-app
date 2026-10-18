// js/portal.js — お客様ページ（p.html#{token}。ログイン不要・読み取り専用）
// 見せる範囲はサーバー側の portal_open（migration 018/019/021）が相手の種類ごとに絞る。ここは表示だけ。
// 進み具合（stages）は 021 からフェーズで作る: 受付 → 調査 → 原因元工事 → 復旧工事 → 完了（フェーズの無い段は来ない）。
// セキュリティ・作りの決まり:
//   ・token は URL の # 以降にだけある（# 以降はサーバーへ送られない）。DB へは RPC の引数としてだけ渡す。画面・console には出さない。
//   ・Supabase は js/supabase.js の既定クライアント sb（ログイン中ならそのセッション）で呼ぶ。
//     社員が案件詳細の「開いてみる」で開いたときは DB 側で自社の社員と分かり「見られました」にならない。
//     お客様（ログインしていない）は anon として呼ばれる。別のクライアントは作らない。
//   ・ユーザー入力（お知らせの本文・宛名など）は createElement + textContent で描画する（innerHTML は使わない）。alert / confirm は使わない。
//   ・PDF は公開バケット public-pdfs の期限なしURL（AppStorage.getPublicUrl）。社内で無効化したものは portal_open が返さない。
(() => {
  'use strict';
  const token = location.hash.slice(1);
  const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;
  const PDF_PATH_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\/report\.pdf$/;
  const $ = id => document.getElementById(id);
  let loading = false;

  // # を書き換えたら別のURLとして開き直す
  window.addEventListener('hashchange', () => location.reload());

  /* ---------- 補助 ---------- */
  function mk(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  const str = v => (v == null ? '' : String(v));
  const pad = n => String(n).padStart(2, '0');
  // 頭文字: 「株式会社」「(株)」などは飛ばす
  const initial = name => {
    const t = str(name).replace(/^(株式会社|有限会社|合同会社|合資会社|合名会社|[(（][株有][)）])\s*/, '').trim();
    return Array.from(t || str(name) || '？')[0];
  };
  const nowText = () => { const d = new Date(); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };

  /* ---------- 全画面メッセージ ---------- */
  function full(icon, title, text, retry, retryText) {
    $('p-hdr').hidden = true;
    const box = mk('div', 'p-full');
    box.id = 'p-full';
    box.append(mk('div', 'p-icon', icon), mk('h1', null, title));
    if (text) box.appendChild(mk('p', null, text));
    if (retry) {
      const b = mk('button', 'btn ghost', retryText || 'もう一度読み込む');
      b.type = 'button';
      b.id = 'p-retry';
      b.addEventListener('click', retry);
      box.appendChild(b);
    }
    $('p-root').replaceChildren(box);
  }
  // 無効・取り消し・存在しない・形式不正は区別せず同じ表示（計画の決定事項）
  const showInvalid = () => {
    document.title = 'ページを表示できません';
    full('🔒', 'このページは表示できません', 'お送りした会社にお問い合わせください。');
  };

  /* ---------- 読み込み ---------- */
  async function fetchPortal() {
    const res = await sb.rpc('portal_open', { p_token: token });
    if (res.error) throw res.error;
    const d = res.data;
    return d && typeof d === 'object' && d.case && typeof d.case === 'object' ? d : null;
  }

  async function boot() {
    if (!TOKEN_RE.test(token)) { showInvalid(); return; }
    full('⏳', '読み込み中…');
    let data;
    try { data = await fetchPortal(); }
    catch (e) {
      full('⚠️', '読み込めませんでした', '電波の良いところで、もう一度お試しください。', () => boot());
      return;
    }
    if (!data) { showInvalid(); return; }
    try { await render(data); }
    catch (e) {
      // 「読み込み中…」のまま止めない。押せる「最新の情報にする」を出す（token を含み得るので console には出さない）
      full('⚠️', '表示できませんでした', RENDER_FAIL, () => boot(), '最新の情報にする');
    }
  }
  const RENDER_FAIL = '表示中に問題が起きました。「最新の情報にする」を押してください。';

  async function refresh(btn, errEl) {
    if (loading) return;
    loading = true;
    btn.disabled = true;
    btn.textContent = '読み込み中…';
    errEl.textContent = '';
    let data = null, failed = false;
    try { data = await fetchPortal(); } catch (e) { failed = true; }
    loading = false;
    if (failed) {
      btn.disabled = false;
      btn.textContent = '最新の情報にする';
      errEl.textContent = '最新の情報を読み込めませんでした。電波の良いところで、もう一度お試しください。';
      return;
    }
    if (!data) { showInvalid(); return; }
    try { await render(data); }
    catch (e) {
      // render は最後にまとめて差し替えるので、失敗しても今の画面とこのボタンは残っている。押せる状態に戻す
      btn.disabled = false;
      btn.textContent = '最新の情報にする';
      errEl.textContent = RENDER_FAIL;
    }
  }

  /* ---------- 画面 ---------- */
  async function render(d) {
    const org = d.org || {}, c = d.case || {};
    document.title = (str(c.name) ? str(c.name) + ' | ' : '') + '工事の進み具合';
    $('p-logo').textContent = initial(org.name);
    $('p-org').textContent = str(org.name);
    $('p-hdr').hidden = false;

    const parts = [];
    const staff = await staffBanner();
    if (staff) parts.push(staff);
    parts.push(heroCard(d), stagesCard(d.stages));
    const upd = updatesCard(d.updates);
    if (upd) parts.push(upd);
    const ntc = noticesCard(d.notices);
    if (ntc) parts.push(ntc);
    const docs = docsCard(d.docs);
    if (docs) parts.push(docs);
    parts.push(contactCard(org), footer());
    $('p-root').replaceChildren(...parts);
  }

  // ログイン中の端末（社内の人が確認で開いた）だけに出す
  async function staffBanner() {
    let session = null;
    try { session = (await sb.auth.getSession()).data.session; } catch (e) { /* 出さない */ }
    if (!session) return null;
    const b = mk('div', 'p-staff', '社内のアカウントでログインしている端末です。自社の方が開いても「見られました」の記録は付きません。お客様には、この帯は出ません。');
    b.id = 'p-staff';
    return b;
  }

  function heroCard(d) {
    const c = d.case || {};
    const card = mk('section', 'p-card p-hero');
    card.id = 'p-hero';
    card.appendChild(mk('h1', null, str(c.name) || '工事のご案内'));
    if (str(d.label).trim()) card.appendChild(mk('div', 'p-to', str(d.label).trim()));
    if (str(c.address).trim()) card.appendChild(mk('div', 'p-addr', '📍 ' + str(c.address).trim()));
    if (c.status === 'done') card.appendChild(mk('span', 'p-done-pill', '工事は完了しました'));
    return card;
  }

  function stagesCard(stages) {
    const card = mk('section', 'p-card');
    card.id = 'p-stages';
    card.appendChild(mk('h2', null, '進み具合'));
    const ol = mk('ol', 'p-steps');
    const view = PortalLogic.stageView(stages);
    // 完了済みの案件で、調査・工事が「済」にならず「予定日」だけ残っているときは予定・日程未定を出さない
    const finished = view.some(s => s.key === 'done' && s.state === 'done');
    view.forEach(s => {
      if (finished && s.state === 'planned') Object.assign(s, { state: 'todo', mark: '○', dateText: '' });
      if (finished && s.state === 'todo' && s.dateText === '日程未定') s.dateText = '';
      const li = mk('li', 'p-step ' + s.state);
      li.dataset.key = str(s.key);
      li.dataset.state = s.state;
      const mark = mk('span', 'p-mark', s.mark);
      mark.setAttribute('aria-hidden', 'true');
      const stateText = { done: '済み', planned: '予定', todo: 'まだ' }[s.state];
      const lab = mk('span', 'p-step-l', s.label);
      lab.setAttribute('aria-label', s.label + '（' + stateText + '）');
      li.append(mark, lab, mk('span', 'p-step-d', s.dateText || (s.state === 'done' ? '済み' : '')));
      ol.appendChild(li);
    });
    card.append(ol, mk('div', 'p-legend', '✓ 済み　● 予定　○ まだ'));
    return card;
  }

  function updatesCard(updates) {
    const list = Array.isArray(updates) ? updates.filter(u => u && str(u.body).trim()) : [];
    if (list.length === 0) return null;
    const card = mk('section', 'p-card');
    card.id = 'p-updates';
    card.appendChild(mk('h2', null, 'お知らせ'));
    list.forEach(u => {
      const row = mk('article', 'p-upd');
      const date = PortalLogic.mdText(u.created_at);
      if (date) row.appendChild(mk('div', 'p-date', date));
      row.appendChild(mk('div', 'p-body', str(u.body).trim()));
      card.appendChild(row);
    });
    return card;
  }

  // 工事のお知らせ（掲示）。文言は NoticeLogic（掲示PDFと同じ整形）。data に無い項目は一覧用の列で補う
  function noticeData(n) {
    const d = Object.assign({}, n.data && typeof n.data === 'object' ? n.data : {});
    if (!str(d.roomNo).trim() && n.room) d.roomNo = n.room;
    if (!str(d.workName).trim() && n.work_name) d.workName = n.work_name;
    if (!d.workDate && n.work_date) d.workDate = n.work_date;
    if (!d.workDateEnd && n.work_date_end) d.workDateEnd = n.work_date_end;
    if (typeof d.workDateTbd !== 'boolean') d.workDateTbd = !!n.work_date_tbd;
    return d;
  }
  function noticesCard(notices) {
    const list = Array.isArray(notices) ? notices.filter(n => n && typeof n === 'object') : [];
    if (list.length === 0) return null;
    const card = mk('section', 'p-card');
    card.id = 'p-notices';
    card.appendChild(mk('h2', null, '工事のお知らせ'));
    list.forEach(n => {
      const d = noticeData(n);
      const box = mk('article', 'p-ntc');
      const room = NoticeLogic.normalizeRoom(d.roomNo);
      const name = str(d.workName).trim() || '工事';
      box.appendChild(mk('div', 'p-ntc-t', (room ? room + '　' : '') + name + 'のお知らせ'));
      const dl = mk('dl');
      const row = (k, v) => { if (v) dl.append(mk('dt', null, k), mk('dd', null, v)); };
      row('工事日', NoticeLogic.formatWorkDate(d));
      row('作業時間', NoticeLogic.formatWorkTime(d));
      if (d.workTypes && d.workTypes.drain) row('排水制限', NoticeLogic.normalizeRooms(d.drainRooms));
      box.appendChild(dl);
      const sentences = NoticeLogic.bodySentences(d);
      if (sentences.length) {
        const ul = mk('ul');
        sentences.forEach(t => ul.appendChild(mk('li', null, '※' + t)));
        box.appendChild(ul);
      }
      const other = str(d.otherNotice).split(/\r?\n/).map(t => t.trim()).filter(Boolean).join('\n');
      if (other) box.appendChild(mk('div', 'p-other', other));
      card.appendChild(box);
    });
    return card;
  }

  // 送付済みの書類（PDF）。見積は版ごと（最新版を上・前の版は小さく）、報告書は送付日の新しい順
  const pdfUrl = path => (PDF_PATH_RE.test(str(path)) ? AppStorage.getPublicUrl(path, AppStorage.PUBLIC_PDF_BUCKET) : '');
  function openLink(url, text, cls, label) {
    const a = mk('a', cls, text);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    if (label) a.setAttribute('aria-label', label);
    return a;
  }
  const versionText = v => (Number(v) > 0 ? '第' + Number(v) + '版' : '');
  const sentText = v => { const t = PortalLogic.mdText(v); return t ? t + ' にお送りしました' : 'お送りしました'; };
  function docRow(doc, icon, kindText) {
    const url = pdfUrl(doc.pdf_path);
    if (!url) return null;
    const row = mk('div', 'p-doc');
    const left = mk('div');
    const ver = doc.kind === 'estimate' ? versionText(doc.version) : '';
    const title = icon + ' ' + str(doc.title) + (ver ? '（' + ver + '）' : '');
    left.append(mk('span', 'p-doc-t', title), mk('span', 'p-sub', kindText + ' ・ ' + sentText(doc.sent_at)));
    const older = (doc.older || []).map(o => ({ o, url: pdfUrl(o.pdf_path) })).filter(x => x.url);
    if (older.length) {
      const box = mk('div', 'p-older');
      box.appendChild(document.createTextNode('前の版: '));
      older.forEach(({ o, url: u }, i) => {
        if (i) box.appendChild(document.createTextNode('、'));
        const t = (versionText(o.version) || '前の版') + (PortalLogic.mdText(o.sent_at) ? '（' + PortalLogic.mdText(o.sent_at) + '）' : '');
        box.appendChild(openLink(u, t, null, str(o.title) + ' ' + t + ' を開く'));
      });
      left.appendChild(box);
    }
    row.append(left, openLink(url, '開く', 'p-open', title + ' を開く'));
    return row;
  }
  function docsCard(docs) {
    const g = PortalLogic.groupDocs(docs);
    const rows = g.estimates.map(e => docRow(e, '🧾', '見積書'))
      .concat(g.reports.map(r => docRow(r, '📋', '報告書'))).filter(Boolean);
    if (rows.length === 0) return null;
    const card = mk('section', 'p-card');
    card.id = 'p-docs';
    card.appendChild(mk('h2', null, 'お送りした書類'));
    card.append(...rows);
    card.appendChild(mk('div', 'p-note', '「開く」を押すと PDF が開きます。'));
    return card;
  }

  function contactCard(org) {
    const card = mk('section', 'p-card p-contact');
    card.id = 'p-contact';
    card.appendChild(mk('h2', null, 'お問い合わせ'));
    if (str(org.name).trim()) card.appendChild(mk('b', null, str(org.name).trim()));
    const tel = str(org.tel).trim();
    const telDigits = tel.replace(/[^0-9+]/g, '');
    if (tel) {
      const line = mk('div');
      line.appendChild(mk('span', 'p-sub', '電話 '));
      if (telDigits.length >= 5) {
        const a = mk('a', null, tel);
        a.href = 'tel:' + telDigits;
        line.appendChild(a);
      } else line.appendChild(mk('span', null, tel));
      card.appendChild(line);
    }
    const email = str(org.email).trim();
    if (email) {
      const line = mk('div');
      line.appendChild(mk('span', 'p-sub', 'メール '));
      if (/^[^\s@<>"?&#]+@[^\s@<>"?&#]+$/.test(email)) {
        const a = mk('a', null, email);
        a.href = 'mailto:' + email;
        line.appendChild(a);
      } else line.appendChild(mk('span', null, email));
      card.appendChild(line);
    }
    if (!tel && !email) card.appendChild(mk('div', 'p-sub', 'このページをお送りした担当者にご連絡ください。'));
    return card;
  }

  function footer() {
    const box = mk('div', 'p-foot');
    const err = mk('div', 'p-err');
    err.id = 'p-refresh-err';
    err.setAttribute('role', 'status');
    const btn = mk('button', 'btn ghost', '最新の情報にする');
    btn.type = 'button';
    btn.id = 'p-refresh';
    btn.addEventListener('click', () => refresh(btn, err));
    const time = mk('div', 'p-time', nowText() + ' 時点の情報です');
    time.id = 'p-time';
    box.append(btn, time, err,
      mk('div', 'p-warn', 'このページはログインなしで見られます。URLを知っている人は誰でも見られるので、ほかの方には転送しないでください。'));
    return box;
  }

  boot();
})();
