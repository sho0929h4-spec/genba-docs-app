// js/cal-feed.js — 確定した予定を作業担当者の Google カレンダーに出す（Task 55。片道・購読 URL。設計 docs/design/google-calendar-sync.md の案C）
// 1人に1つのファイル public-pdfs/{org}/{token}/calendar.ics（token は migration 077 の calendar_feeds。読む・作り直すのは本人と管理者だけ = DB の関数）。
// 予定が変わる操作（日時・担当者・失注・完了・案件の削除と戻す）の後に、操作した人の画面がその人（担当が変わったら前の人も）のファイルを作り直す。
// 作り直しは待たない・失敗しても操作は止めない（画面の下に小さく「カレンダーの更新に失敗しました」）。まだ使い始めていない人（token なし）は何もしない。
// 本人でも管理者でもない人の操作（例: 現場用で登録した人が、ほかの人が担当の対応を直した）は作り直さない → 担当の人がアプリを開いたときに作り直す（app.js）
// 中身は js/ics-logic.js（入居者名・電話・金額は入れない・場所は市区町村まで）
const CalFeed = (() => {
  const must = ({ data, error }) => { if (error) throw error; return data; };
  const BUCKET = () => AppStorage.PUBLIC_PDF_BUCKET;
  const pathOf = (org, token) => org + '/' + token + '/calendar.ics';
  const me = () => (typeof ctx !== 'undefined' && ctx && ctx.user ? ctx.user.id : null);
  const owner = () => !!(typeof ctx !== 'undefined' && ctx && ctx.membership && ctx.membership.role === 'owner');
  const can = uid => !!uid && !!me() && (uid === me() || owner());
  const q = {}; // 人ごとの作り直し（同じ人は順番に）

  const token = async (uid, mode) => must(await sb.rpc('cal_feed_token', { p_user: uid, p_mode: mode || 'get' }));
  const urlOf = t => (t && t.token ? AppStorage.getPublicUrl(pathOf(t.org_id, t.token), BUCKET()) : null);
  async function write(uid) {
    const r = must(await sb.rpc('cal_feed_events', { p_user: uid }));
    if (!r || !r.token) return false;
    const ics = IcsLogic.build(r.events || []);
    // cacheControl 300秒: 作り直し・URL の作り直しの後に CDN に古い中身が残る時間を短く
    await AppStorage.upload(pathOf(r.org_id, r.token), new Blob([ics], { type: 'text/calendar' }),
      { bucket: BUCKET(), contentType: 'text/calendar', cacheControl: 300 });
    return true;
  }
  // → true（作り直した）/ false（まだ使い始めていない）。失敗は投げる
  function rebuild(uid) {
    const p = (q[uid] || Promise.resolve()).catch(() => {}).then(() => write(uid));
    q[uid] = p;
    return p;
  }

  let noteTimer = null;
  function notice(text) {
    let el = document.getElementById('gcal-note');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gcal-note';
      el.className = 'gcal-note';
      el.setAttribute('role', 'status');
      const t = document.createElement('span');
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'gcal-note-x';
      x.textContent = '×';
      x.setAttribute('aria-label', '閉じる');
      x.addEventListener('click', () => { el.hidden = true; });
      el.append(t, x);
      document.body.appendChild(el);
    }
    el.firstChild.textContent = text || 'カレンダーの更新に失敗しました（設定の「今すぐ作り直す」でやり直せます）';
    el.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { el.hidden = true; }, 8000);
  }
  const fail = e => { console.warn('カレンダーの更新に失敗しました', e); notice(); };

  // 予定が変わった人たち（null・重なり・作り直せない人は飛ばす）。待たない・投げない
  function touch(ids) {
    for (const uid of new Set((ids || []).filter(can))) rebuild(uid).catch(fail);
  }
  // フェーズ（id）の今の担当者＋ extra（前の担当者など）
  function touchPhase(phaseId, extra) {
    (async () => {
      const rows = phaseId ? must(await sb.from('case_phases').select('worker_id').eq('id', phaseId)) || [] : [];
      touch(rows.map(r => r.worker_id).concat(extra || []));
    })().catch(fail);
  }
  // 案件のすべての対応の担当者（削除・戻す・名前や住所の変更）
  function touchCase(caseId) {
    (async () => {
      const rows = caseId ? must(await sb.from('case_phases').select('worker_id').eq('case_id', caseId)) || [] : [];
      touch(rows.map(r => r.worker_id));
    })().catch(fail);
  }

  // 今の担当者（変える前に読む。読めなければ空）
  async function workersOf(phaseId) {
    try { return (must(await sb.from('case_phases').select('worker_id').eq('id', phaseId)) || []).map(r => r.worker_id); }
    catch (e) { return []; }
  }

  /* ===== 画面（現場用の設定のカード・管理者の設定のメンバー一覧）。文字は textContent・確認は askPopup（× でだけ閉じる） ===== */
  const el = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; };
  const btn = (t, cls, fn) => { const b = el('button', cls, t); b.type = 'button'; b.addEventListener('click', () => fn(b)); return b; };
  const msgOf = e => (e && e.message ? e.message : String(e));
  // 押している間はカードのボタンを止める → 結果の文を st に
  async function busy(box, st, fn) {
    const bs = Array.from(box.querySelectorAll('button')).filter(b => !b.disabled && !b.classList.contains('gcal-note-x'));
    bs.forEach(b => { b.disabled = true; });
    st.textContent = '作っています…';
    st.classList.remove('err');
    try { st.textContent = await fn(); }
    catch (e) { st.textContent = 'できませんでした: ' + msgOf(e); st.classList.add('err'); }
    finally { bs.forEach(b => { if (b.isConnected) b.disabled = false; }); }
  }
  const askRotate = who => askPopup('URL を作り直すと、前の URL は使えなくなります。' + (who ? who + 'さんは' : '') + 'Google カレンダーに新しい URL を入れ直す必要があります（前の URL のカレンダーは、Google カレンダーの設定から消してください）。',
    { title: 'URL を作り直す', okLabel: '作り直す', danger: true, id: 'ask-gcal-rotate' });

  // 現場用の設定「Google カレンダーに予定を出す」（本人）
  function selfCard() {
    const uid = me();
    const card = el('div', 'fd-card fd-set gcal-card');
    card.id = 'fd-set-gcal';
    card.appendChild(el('b', null, 'Google カレンダーに予定を出す'));
    card.appendChild(el('span', 'fd-tiny', '日時と担当が決まった予定が、あなたの Google カレンダーに出ます。出るのは「物件名・号室・種類（現地確認など）・時間・市区町村」だけです（入居者の名前・電話・金額は出ません）。Google カレンダーに出るまで数時間かかることがあります。'));
    const body = el('div', 'gcal-body');
    const st = el('div', 'gcal-st');
    st.id = 'gcal-st';
    st.setAttribute('role', 'status');
    card.append(body, st);
    const show = url => {
      body.replaceChildren();
      if (!url) {
        body.appendChild(btn('使い始める（URL を作る）', 'btn gcal-start', () => busy(card, st, async () => { show(await api.start(uid)); return 'URL を作りました。下の手順で Google カレンダーに入れてください'; })));
        return;
      }
      const lb = el('label', 'fd-set-f', 'あなたの購読 URL（ほかの人には教えないでください）');
      const row = el('div', 'gcal-url-row');
      const inp = el('input');
      inp.id = 'gcal-url';
      inp.type = 'text';
      inp.readOnly = true;
      inp.value = url;
      inp.addEventListener('focus', () => inp.select());
      row.append(inp, btn('コピー', 'btn ghost sm gcal-copy', async () => {
        try { await navigator.clipboard.writeText(url); st.textContent = 'コピーしました'; }
        catch (e) { inp.focus(); inp.select(); st.textContent = 'コピーできませんでした。URL を長押しして「コピー」を選んでください'; }
      }));
      lb.htmlFor = 'gcal-url';
      const steps = el('ol', 'gcal-steps');
      steps.id = 'gcal-steps';
      ['パソコンで Google カレンダー（calendar.google.com）を開く', '左の「他のカレンダー」の右にある「＋」を押す', '「URL で追加」を押す',
        '「カレンダーの URL」に、この URL を貼る', '「カレンダーを追加」を押す'].forEach(t => steps.appendChild(el('li', null, t)));
      const act = el('div', 'gcal-act');
      act.append(btn('今すぐ作り直す', 'btn ghost sm gcal-rebuild', () => busy(card, st, async () => { await rebuild(uid); return 'カレンダーを作り直しました'; })),
        btn('URL を作り直す（前の URL は使えなくする）', 'btn ghost sm danger gcal-rotate', async () => {
          if (!await askRotate('')) return;
          await busy(card, st, async () => { show(await api.rotate(uid)); return '新しい URL にしました。Google カレンダーに新しい URL を入れ直してください'; });
        }));
      body.append(lb, row, el('b', 'gcal-k', 'Google カレンダーに入れる手順'), steps,
        el('span', 'fd-tiny', 'スマホの Google カレンダーのアプリでは URL で追加できません。パソコンで追加すると、同じ Google アカウントのスマホにも出ます。くわしくは管理者に「Google カレンダーの手順書」をもらってください。'),
        act);
    };
    st.textContent = '読み込んでいます…';
    api.url(uid).then(u => { st.textContent = ''; show(u); }, e => { st.textContent = '読み込めませんでした: ' + msgOf(e); st.classList.add('err'); });
    return card;
  }

  // 管理者の設定「作業担当者の Google カレンダー」: メンバーごとに 今すぐ作り直す・URL を作り直す
  async function renderMembers(host) {
    if (!host) return;
    host.replaceChildren(el('div', 'gcal-st', '読み込んでいます…'));
    let list;
    try { list = must(await sb.from('memberships').select('user_id, display_name, role').order('display_name')) || []; }
    catch (e) { host.replaceChildren(el('div', 'gcal-st err', '読み込めませんでした: ' + msgOf(e))); return; }
    host.replaceChildren(...list.map(m => {
      const name = m.display_name || '（名前なし）';
      const row = el('div', 'gcal-mrow');
      row.dataset.user = m.user_id;
      const st = el('div', 'gcal-st');
      st.setAttribute('role', 'status');
      const act = el('div', 'gcal-act');
      act.append(btn('今すぐ作り直す', 'btn ghost sm gcal-rebuild', () => busy(row, st, async () => (await rebuild(m.user_id))
          ? 'カレンダーを作り直しました' : 'まだ使い始めていません（本人が現場用の設定で始めます）')),
        btn('URL を作り直す', 'btn ghost sm danger gcal-rotate', async () => {
          if (!await askRotate(name)) return;
          await busy(row, st, async () => { await api.rotate(m.user_id); return '新しい URL にしました。' + name + 'さんに、現場用の設定の新しい URL を Google カレンダーに入れ直してもらってください'; });
        }));
      row.append(el('b', 'gcal-mname', name + (m.user_id === me() ? '（自分）' : '')), act, st);
      return row;
    }));
  }

  const api = {
    pathOf, rebuild, touch, touchPhase, touchCase, workersOf, notice, selfCard, renderMembers,
    // 設定の画面: 今の URL（まだなら null）
    async url(uid) { return urlOf(await token(uid, 'get')); },
    // 使い始める（無ければ URL を作る）→ ファイルを作る → URL
    async start(uid) { const t = await token(uid, 'create'); await rebuild(uid); return urlOf(t); },
    // URL を作り直す: 新しいトークン → 前のファイルを消す（前の URL は使えなくなる）→ 新しいファイル → 新しい URL
    async rotate(uid) {
      const t = await token(uid, 'rotate');
      let err = null;
      if (t.old_token) {
        try { await AppStorage.remove(pathOf(t.org_id, t.old_token), BUCKET()); }
        catch (e) { err = new Error('前の URL のファイルを消せませんでした。もう一度「URL を作り直す」を押してください'); }
      }
      try { await rebuild(uid); } catch (e) { err = err || e; }
      if (err) throw err;
      return urlOf(t);
    }
  };
  return api;
})();
