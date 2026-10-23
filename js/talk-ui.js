// js/talk-ui.js — LINE 風の案件ごとのメッセージ（Task 46。中身の組み立ては js/talk-logic.js、DB は migration 065）
//   現場用: 下のタブ「メッセージ」#f/msg（トークの一覧）→ #f/msg/{案件ID}・#f/msg/all（全体）。トークの中は下のタブを隠す（LINE と同じ）
//   管理者: #talk（全案件のトーク一覧。案件一覧のヘッダーのアイコン）→ #talk/{案件ID}・#talk/all。案件ページの「メッセージ」からも開ける。
//           案件のトークでは「元請から」として書ける（as_client）
//   一覧: 丸に頭文字・物件名 号室・最後の1行・時刻・未読の数（新しい順）。トーク: 上の帯（物件名 号室・右上は Task 47 のフェーズ管理の場所）・
//   日付の区切り・自分は右の紺の吹き出し・相手は左の白（名前）・時刻・中央の灰色のログ・報告書／見積書のカード（押すと開く）・
//   下に入力欄（sticky・safe-area）と写真・送信
//   見える範囲は DB（staff_messages の select = talk_visible）。開いたら talk_mark_read（既読の印・自分あての未読も既読）
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。alert/confirm は使わない
// mk() は case-list.js、dBtn / errText は case-detail.js、smPdfLinks は staff-messages.js、fieldRows / fieldRowsInvalidate は field-ui.js

const TALK_HASH_RE = /^#talk(?:\/(all|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/i;
const TALK_MSG_MAX = 1000; // shortcut: 一覧は新しい連絡 1000件から作る。会社の連絡がこれより多くなったら案件ごとの集計の rpc にする
let talk = null; // { seq, field, key（null = 一覧・'all'・案件ID）, root, rows, msgs, reads, members, timeline, loading, err, busy, draft, files, asClient, sendErr }
let talkSeq = 0;

const talkMe = () => (ctx && ctx.user ? ctx.user.id : null);
const talkOwner = s => !!(ctx && ctx.membership && ctx.membership.role === 'owner') && !s.field; // 現場用で開いている管理者は作業担当者と同じ見え方
const talkHash = (s, key) => (s.field ? '#f/msg' : '#talk') + (key ? '/' + key : '');

/* ---------- 画面を開く ---------- */
function openTalkScreen(key) {
  renderHeaders();
  showScreen('talk');
  return openTalk({ field: false, key: key ? String(key).toLowerCase() : null, root: $('talk-root') });
}
async function openTalk(o) {
  const seq = ++talkSeq;
  talk = { seq, field: !!o.field, key: o.key || null, root: o.root, rows: [], msgs: [], reads: [], members: [], timeline: [],
    loading: true, err: '', busy: false, draft: '', files: [], asClient: false, sendErr: '' };
  document.body.classList.toggle('talk-open', !!talk.key && talk.field);
  talkRender();
  await talkLoad(talk);
}
const talkAlive = s => talk === s && s.root && s.root.isConnected;

async function talkLoad(s) {
  let err = '';
  const key = s.key;
  const caseId = key && key !== TalkLogic.ALL ? key : null;
  try {
    // トークの中はその案件だけを読み直す（提出・送付の直後でもログとカードが出るように）。一覧は現場用なら集計を使い回す（60秒）
    const rowsP = caseId ? CasesApi.getSummary(caseId).then(r => (r ? [r] : []))
      : s.field && typeof fieldRows === 'function' ? fieldRows() : CasesApi.listSummaries();
    const msgsP = !key ? StaffMessagesApi.list({ limit: TALK_MSG_MAX }) : caseId ? StaffMessagesApi.list({ caseId }) : StaffMessagesApi.list({ noCase: true });
    const [rows, msgs, reads, members, timeline] = await Promise.all([rowsP, msgsP, StaffMessagesApi.talkReads(), CasesApi.listMembers(),
      caseId ? CasesApi.listEntries(caseId) : Promise.resolve([])]);
    Object.assign(s, { rows: rows || [], msgs: msgs || [], reads: reads || [], members: members || [], timeline: (timeline || []).filter(t => t.type === 'system') });
  } catch (e) { err = 'メッセージを読み込めませんでした: ' + errText(e); }
  if (!talkAlive(s)) return;
  s.loading = false;
  s.err = err;
  talkRender();
  if (err || !key) { if (!err && !key) talkBadgeSet(s); return; }
  if (caseId && !talkCase(s)) return;
  talkScrollEnd();
  try { await StaffMessagesApi.markTalkRead(caseId); } catch (e) { console.warn('既読にできませんでした', e); }
  if (typeof fieldRowsInvalidate === 'function' && s.field) fieldRowsInvalidate();
  talkBadgeRefresh(s.field);
}

const talkNames = s => Object.fromEntries((s.members || []).map(m => [m.user_id, m.display_name || '(名前なし)']));
function talkCase(s) {
  const c = (s.rows || []).find(r => r.id === s.key) || null;
  if (!c) return null;
  if (!talkOwner(s) && !PhaseLogic.fieldMine(c, talkMe())) return null; // 作業担当者は担当の案件だけ（DB も同じ）
  return c;
}
function talkThreads(s) {
  return TalkLogic.threads({ caseRows: s.rows, messages: s.msgs, reads: s.reads, me: talkMe(), isOwner: talkOwner(s), names: talkNames(s) });
}
function talkScrollEnd() { requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight)); }

/* ---------- 未読の数（現場用の下のタブ・管理者のヘッダー） ---------- */
function talkBadgeSet(s) {
  const n = TalkLogic.unreadTotal(talkThreads(s));
  document.querySelectorAll(s.field ? '#fd-msg-badge' : '.js-talk-badge').forEach(b => {
    b.hidden = !n;
    b.textContent = n > 99 ? '99+' : String(n);
    const tab = b.closest('.fd-tab, .iconbtn');
    if (tab) tab.setAttribute('aria-label', 'メッセージ' + (n ? ' 未読 ' + n + '件' : ''));
  });
  return n;
}
async function talkBadgeRefresh(field) {
  try {
    const s = { field: !!field };
    const [rows, msgs, reads] = await Promise.all([field && typeof fieldRows === 'function' ? fieldRows() : CasesApi.listSummaries(),
      StaffMessagesApi.list({ limit: TALK_MSG_MAX }), StaffMessagesApi.talkReads()]);
    Object.assign(s, { rows: rows || [], msgs: msgs || [], reads: reads || [], members: [] });
    return talkBadgeSet(s);
  } catch (e) { console.warn('メッセージの未読を数えられませんでした', e); return 0; }
}

/* ---------- 描画 ---------- */
function talkRender() {
  const s = talk;
  if (!s || !s.root) return;
  s.root.classList.toggle('talk-in', !!s.key);
  if (s.loading) { s.root.replaceChildren(mk('div', 'empty', '読み込み中…')); return; }
  if (s.err) {
    s.root.replaceChildren(mk('div', 'err', s.err), dBtn('再読み込み', 'btn sm ghost inline', () => openTalk({ field: s.field, key: s.key, root: s.root })));
    return;
  }
  if (!s.key) return talkRenderList(s);
  return talkRenderThread(s);
}

// 時刻の短い表示: 今日なら 9:05、それ以外は 10/25
function talkWhen(at) {
  if (!at) return '';
  const hm = PhaseLogic.fmtMDHM(at);
  return PhaseLogic.jstYmd(at) === PhaseLogic.jstYmd(new Date()) ? hm.split(' ')[1] : hm.split(' ')[0];
}

function talkRenderList(s) {
  const nodes = [];
  if (!s.field) {
    nodes.push(dBtn('← 案件一覧', 'back', () => openCases()));
    nodes.push(mk('h2', 'ob-h', 'メッセージ'));
    nodes.push(mk('div', 'rep-sub ob-lead', '案件ごとの作業担当者とのやり取りと、報告書・見積書などの記録です。案件の無い連絡は「全体」です'));
  }
  const list = mk('div', 'talk-list');
  list.id = 'talk-list';
  const threads = talkThreads(s);
  threads.forEach(t => {
    const row = dBtn('', 'talk-row' + (t.unread ? ' unread' : ''), () => { location.hash = talkHash(s, t.key); });
    row.dataset.key = t.key;
    row.appendChild(mk('span', 'talk-av' + (t.key === TalkLogic.ALL ? ' all' : ''), t.initial));
    const main = mk('span', 'talk-main');
    const top = mk('span', 'talk-top');
    top.append(mk('b', 'talk-name', t.title), mk('span', 'talk-time', t.last ? talkWhen(t.last.at) : ''));
    const bot = mk('span', 'talk-bot');
    bot.appendChild(mk('span', 'talk-last', t.last ? t.last.text : 'まだやり取りはありません'));
    if (t.unread) {
      const b = mk('span', 'talk-badge', t.unread > 99 ? '99+' : String(t.unread));
      b.setAttribute('aria-label', '未読 ' + t.unread + '件');
      bot.appendChild(b);
    }
    main.append(top, bot);
    row.appendChild(main);
    list.appendChild(row);
  });
  nodes.push(list);
  s.root.replaceChildren(...nodes);
}

function talkRenderThread(s) {
  const all = s.key === TalkLogic.ALL;
  const c = all ? null : talkCase(s);
  const nodes = [];
  // 上の帯（物件名 号室）。右上は Task 47 のフェーズ管理の場所（今は空）
  const head = mk('div', 'talk-head');
  head.id = 'talk-head';
  if (!s.field) head.appendChild(dBtn('‹ 一覧', 'talk-back', () => { location.hash = '#talk'; }));
  head.appendChild(mk('span', 'talk-av' + (all ? ' all' : ''), all ? '全' : Array.from(String((c && c.name) || '？').trim() || '？')[0]));
  const ht = mk('div', 'talk-head-t');
  const title = mk('b', 'talk-head-name', all ? '全体' : c ? PhaseLogic.placeName(c) || '（物件名なし）' : 'トーク');
  title.id = 'talk-title';
  ht.appendChild(title);
  if (c) {
    const go = dBtn(s.field ? 'ツールを開く ›' : '案件ページ ›', 'linkbtn talk-open-case', () => {
      location.hash = s.field ? '#f/case/' + c.id : '#case/' + c.id;
    });
    ht.appendChild(go);
  } else if (all) ht.appendChild(mk('span', 'talk-head-sub', s.field ? '管理者からのお知らせと、案件の無い連絡（日報など）' : '会社の全員へのお知らせと、案件の無い連絡（日報など）'));
  head.appendChild(ht);
  const slot = mk('div', 'talk-head-slot'); // Task 47: フェーズ管理
  slot.id = 'talk-head-slot';
  head.appendChild(slot);
  nodes.push(head);
  if (!all && !c) {
    nodes.push(mk('div', 'empty talk-none', 'このトークは見られません（担当の案件だけ見られます）'));
    s.root.replaceChildren(...nodes);
    return;
  }
  const items = TalkLogic.items({ caseRow: c, messages: s.msgs, timeline: s.timeline, me: talkMe(), isOwner: talkOwner(s),
    readAt: null, names: talkNames(s) });
  const body = mk('div', 'talk-body');
  body.id = 'talk-body';
  if (!items.length) body.appendChild(mk('div', 'talk-log talk-empty', 'まだやり取りはありません。下の欄から送れます'));
  TalkLogic.withDays(items).forEach(x => body.appendChild(talkItemEl(s, x)));
  nodes.push(body);
  nodes.push(talkBar(s, c));
  s.root.replaceChildren(...nodes);
}

function talkItemEl(s, x) {
  if (x.day) { const d = mk('div', 'talk-day'); d.appendChild(mk('span', null, x.day)); return d; }
  if (x.kind === 'log') { const l = mk('div', 'talk-log'); l.appendChild(mk('span', null, x.text)); return l; }
  const row = mk('div', 'talk-m ' + (x.mine ? 'mine' : 'theirs') + (x.asClient ? ' client' : ''));
  row.dataset.kind = x.kind;
  if (x.id) row.dataset.id = x.id;
  if (!x.mine) row.appendChild(mk('span', 'talk-av sm' + (x.asClient ? ' client' : ''), x.asClient ? '元' : Array.from(x.fromName || '？')[0]));
  const col = mk('div', 'talk-col');
  if (!x.mine) col.appendChild(mk('span', 'talk-from', x.asClient && x.msg && x.from ? '元請から（' + ((talkNames(s)[x.from]) || '管理者') + 'が入力）' : x.fromName));
  if (x.kind === 'card') {
    const card = dBtn('', 'talk-card', () => { location.hash = (x.doc === 'report' ? '#report/' : '#estimate/') + x.id; });
    card.dataset.doc = x.doc;
    card.appendChild(mk('span', 'talk-card-ic')).appendChild(Icon.el(x.doc === 'report' ? 'report' : 'receipt', { size: 22 }));
    const t = mk('span', 'talk-card-t');
    t.appendChild(mk('b', null, x.text));
    t.appendChild(mk('span', 'talk-card-sub', x.doc === 'report' ? '提出されました' + (x.sub ? ' ' + x.sub : '') : '提出されました' + (x.sub ? '（' + x.sub + '）' : '')));
    card.append(t, mk('span', 'talk-card-go', '開く ›'));
    col.appendChild(card);
  } else {
    const bub = mk('div', 'talk-bub', x.text);
    const atts = Array.isArray(x.msg && x.msg.attachments) ? x.msg.attachments : [];
    atts.filter(a => StaffMessagesApi.isPdf(a)).forEach(a => bub.appendChild(smPdfLinks(a)));
    const photos = atts.filter(a => !StaffMessagesApi.isPdf(a));
    if (photos.length) {
      const g = mk('div', 'talk-photos');
      photos.forEach(a => {
        const im = document.createElement('img');
        im.alt = a.name || '写真';
        im.className = 'talk-photo';
        im.loading = 'lazy';
        StaffMessagesApi.photoUrl(a.path).then(u => { im.src = u; }, () => { im.alt = '写真を開けませんでした'; });
        g.appendChild(im);
      });
      bub.appendChild(g);
    }
    col.appendChild(bub);
  }
  col.appendChild(mk('span', 'talk-at', PhaseLogic.fmtMDHM(x.at).split(' ')[1] || ''));
  row.appendChild(col);
  return row;
}

/* ---------- 入力欄（下に固定。safe-area） ---------- */
function talkBar(s, c) {
  const bar = mk('div', 'talk-bar');
  bar.id = 'talk-bar';
  if (talkOwner(s) && c) { // 管理者: 案件のトークでは「元請から」として書ける
    const cl = dBtn('元請からとして書く', 'talk-client', () => { s.asClient = !s.asClient; syncClient(); ta.focus(); });
    cl.id = 'talk-client';
    const syncClient = () => {
      cl.setAttribute('aria-pressed', s.asClient ? 'true' : 'false');
      cl.classList.toggle('on', s.asClient);
      cl.textContent = s.asClient ? '元請からとして書く: オン' : '元請からとして書く';
    };
    syncClient();
    bar.appendChild(cl);
  }
  const files = mk('div', 'talk-files');
  files.id = 'talk-files';
  const row = mk('div', 'talk-bar-row');
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/*';
  file.multiple = true;
  file.id = 'talk-file';
  file.className = 'sr-only';
  const pick = dBtn('', 'talk-pick', () => file.click());
  pick.id = 'talk-pick';
  pick.setAttribute('aria-label', '写真を添付');
  pick.appendChild(Icon.el('camera', { size: 22 }));
  const ta = document.createElement('textarea');
  ta.id = 'talk-input';
  ta.rows = 1;
  ta.maxLength = StaffMessagesApi.BODY_MAX;
  ta.placeholder = 'メッセージを入力';
  ta.setAttribute('aria-label', 'メッセージ');
  ta.value = s.draft || '';
  const send = dBtn('', 'talk-send', () => talkSend(s, c));
  send.id = 'talk-send';
  send.setAttribute('aria-label', '送信');
  send.appendChild(Icon.el('send', { size: 20 }));
  const sync = () => {
    send.disabled = s.busy || (!ta.value.trim() && !s.files.length);
    [ta, pick, file].forEach(el => { el.disabled = s.busy; });
    files.replaceChildren();
    files.hidden = !s.files.length;
    if (s.files.length) {
      files.appendChild(mk('span', 'rep-sub', '写真 ' + s.files.length + '枚'));
      const x = dBtn('外す', 'linkbtn talk-files-x', () => { s.files = []; sync(); });
      x.disabled = s.busy;
      files.appendChild(x);
    }
    // 入力欄の高さは中身に合わせる（4行まで）
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  };
  ta.addEventListener('input', () => { s.draft = ta.value; s.sendErr = ''; err.textContent = ''; sync(); });
  file.addEventListener('change', () => {
    s.files = s.files.concat(Array.from(file.files || [])).slice(0, StaffMessagesApi.FILES_MAX);
    file.value = '';
    sync();
  });
  row.append(pick, ta, send, file);
  const err = mk('div', 'err talk-err', s.sendErr || '');
  err.id = 'talk-err';
  err.setAttribute('role', 'alert');
  bar.append(files, row, err);
  requestAnimationFrame(sync);
  return bar;
}

async function talkSend(s, c) {
  if (!s || s.busy) return;
  const body = String(s.draft || '').trim();
  if (!body && !s.files.length) return;
  const caseId = c ? c.id : null;
  const owner = talkOwner(s);
  // 宛先: 作業担当者からは管理者（宛先なし）。管理者からは案件の作業担当者（1人のとき。全体は会社の全員＝宛先なし）
  const toUser = owner && c ? TalkLogic.recipient(c, talkMe()) : null;
  s.busy = true;
  s.sendErr = '';
  talkRender();
  let err = '';
  try {
    await StaffMessagesApi.send({ caseId, toUser, subject: TalkLogic.subjectOf(body, s.files.length), body, files: s.files, asClient: owner && c && s.asClient });
  } catch (e) { err = '送れませんでした: ' + errText(e); }
  s.busy = false;
  if (!talkAlive(s)) return;
  if (err) { s.sendErr = err; talkRender(); return; }
  s.draft = '';
  s.files = [];
  s.asClient = false;
  if (typeof fieldRowsInvalidate === 'function') fieldRowsInvalidate();
  await talkLoad(s);
  const ta = document.getElementById('talk-input');
  if (ta) ta.focus({ preventScroll: true });
}

(() => {
  document.querySelectorAll('.js-open-talk').forEach(b => b.addEventListener('click', () => { location.hash = '#talk'; }));
})();
