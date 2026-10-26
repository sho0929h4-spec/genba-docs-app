// js/report-share.js — ⑦ 担当者URL（#case/{id}/share）… openShareScreen(caseId, reportId)  （Task 6 → Task 24 で単純化 → Task 25 で自動発行）
// Task 25: 担当者URLはフェーズを作ったときに自動でできる（報告書の下書きと1本ずつ）。⑦はその URL を出す（無いフェーズはここで作る）。
//   「URLを発行」の欄（担当者名・対応フェーズ・作業区分）は廃止。
// Task 24（migration 044）: URL は報告書1件につき1本。token は自社だけ読める平文で保存するので、いつでも同じ URL を表示できる。
//   期限なし固定・無効にする／2本目の発行はない。「URLを作り直す」= 同じ報告書に発行し直す（古い URL は DB が自動で無効にする）。
//   社内も同じ報告書を編集できる（入力中ロックは廃止。あとから保存した内容が残る）。提出されたら「提出済み（M/D）」だけ出す。
// 下に URL を渡した報告書を1件ずつ出す（報告書ごとにいちばん新しい URL だけ）。
// shareUrlBox() は対応フェーズ（js/phase-ui.js）の「担当者へURLを渡す」でも使う
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。確認は画面内（askInline。confirm は使わない）
// mk() は case-list.js、dBtn / errText は case-detail.js、edField / edSelect は report-edit.js、withBusy / setMsg / showScreen / renderHeaders / askInline / $ は app.js
// openShareScreen が定義されていると ⑤（js/report-ui.js）に「🔗 担当者へURLを渡す」ボタンが出る

let shrCaseId = null;
let shrSeq = 0;          // 読み込みのたびに増やす。古い応答を捨てる
let shrSummary = null;
let shrReports = [];
let shrShares = [];
let shrFocus = null;     // 開いたときに見せる報告書（⑤ の「URLを見る」から）

const shrMD = iso => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : (d.getMonth() + 1) + '/' + d.getDate(); };
const shrHash = caseId => '#case/' + caseId + '/share';
const shrWho = name => (String(name || '').trim() ? String(name).trim() + ' 様' : '担当者 様');

// URL の欄（URL・URLをコピー・送る文面をコピー・LINEで送る・URLを作り直す）。⑦ と対応フェーズで共通
//   o: { url, name, text（送る文面）, onRemake(btn)（任意。無ければ「URLを作り直す」を出さない）, askHost（作り直しの確認を出す場所） }
function shareUrlBox(o) {
  const box = mk('div', 'shr-box');
  const head = mk('div', 'rep-between');
  head.append(mk('b', null, o.title || shrWho(o.name) + 'あてのURL'), mk('span', 'rep-pill p-wait', '有効（提出まで）'));
  box.appendChild(head);
  const line = mk('div', 'shr-link');
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.readOnly = true;
  inp.className = 'shr-url';
  inp.value = o.url;
  inp.setAttribute('aria-label', 'URL');
  inp.addEventListener('focus', () => inp.select());
  line.appendChild(inp);
  box.appendChild(line);
  const status = mk('div', 'shr-ok shr-copy-msg');
  status.setAttribute('role', 'status');
  const copy = async (text, fallback) => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard');
      await navigator.clipboard.writeText(text);
      status.textContent = 'コピーしました';
    } catch (e) {
      fallback();
      status.textContent = 'コピーできませんでした。選択したので、長押し（またはCtrl+C）でコピーしてください';
    }
  };
  const acts = mk('div', 'rep-acts shr-acts');
  acts.appendChild(dBtn('URLをコピー', 'btn sm inline shr-copy', () => copy(o.url, () => { inp.focus(); inp.select(); })));
  acts.appendChild(dBtn('送る文面をコピー', 'btn sm ghost inline shr-text', () => copy(o.text, () => {
    let ta = box.querySelector('.shr-msg');
    if (!ta) {
      ta = document.createElement('textarea');
      ta.className = 'shr-msg';
      ta.readOnly = true;
      ta.rows = 5;
      ta.value = o.text;
      ta.setAttribute('aria-label', '送る文面');
      box.insertBefore(ta, status);
    }
    ta.focus();
    ta.select();
  })));
  const a = mk('a', 'shr-line', 'LINEで送る');
  a.href = 'https://line.me/R/msg/text/?' + encodeURIComponent(o.text);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  acts.appendChild(a);
  if (o.onRemake) acts.appendChild(shrRemakeBtn(o.askHost || box, o.onRemake));
  box.append(acts, status);
  return box;
}
// 「URLを作り直す」: 画面内で確認してから。いま渡している URL は使えなくなる
function shrRemakeBtn(host, onRemake) {
  return dBtn('URLを作り直す', 'btn sm ghost inline shr-remake', async b => {
    const ok = await askInline(host, 'URLを作り直しますか？\nいま渡しているURLは使えなくなります。新しいURLを送り直してください。',
      { okLabel: '作り直す', id: 'shr-ask' });
    if (ok) return onRemake(b);
  });
}

function openShareScreen(caseId, reportId) {
  if (!caseId) return;
  if (reportId) shrFocus = reportId;
  const h = shrHash(caseId);
  if (location.hash !== h) { location.hash = h; return; } // → hashchange → routeFromHash → もう一度ここへ
  showScreen('share');
  renderHeaders();
  return loadShare(caseId);
}

window.addEventListener('hashchange', () => {
  if (shrCaseId && location.hash !== shrHash(shrCaseId)) {
    shrSeq++;
    shrCaseId = null;
    const root = $('share-root');
    if (root) root.replaceChildren();
  }
});

function shrBack(caseId) {
  return dBtn('← 報告書一覧', 'back', () => { location.hash = '#case/' + caseId + '/reports'; });
}

function shrMessage(caseId, text, isErr) {
  const nodes = [shrBack(caseId), mk('div', isErr ? 'err' : 'empty', text)];
  if (isErr) nodes.push(dBtn('再読み込み', 'btn sm ghost inline', () => loadShare(caseId)));
  $('share-root').replaceChildren(...nodes);
}

async function loadShare(caseId) {
  const seq = ++shrSeq;
  shrCaseId = caseId;
  shrSummary = null; shrReports = []; shrShares = [];
  shrMessage(caseId, '読み込み中…', false);
  let res;
  try {
    res = await Promise.all([CasesApi.getSummary(caseId), ReportsApi.listByCase(caseId)]);
    if (seq !== shrSeq) return;
    if (res[0]) res.push(await ReportsApi.listSharesByReports((res[1] || []).map(r => r.id)));
  } catch (e) {
    if (seq !== shrSeq) return;
    shrMessage(caseId, '読み込みに失敗しました: ' + errText(e), true);
    return;
  }
  if (seq !== shrSeq) return;
  if (!res[0]) { shrMessage(caseId, '案件が見つかりません', false); return; }
  [shrSummary, shrReports, shrShares] = [res[0], res[1] || [], res[2] || []];
  // Task 25: 報告書・担当者URLの無いフェーズ（済んだものを除く）は、ここで作る（自動発行の遅延作成）
  let made = false;
  for (const p of shrPhases()) {
    try {
      const own = shrReports.filter(r => r.phase_id === p.id);
      const r = await ReportsApi.ensurePhaseReport(Object.assign({ case_id: caseId }, p), shrSummary,
        { reports: own, shares: shrShares.filter(sh => own.some(x => x.id === sh.report_id)), title: shrTitle(p) });
      if (r && r.made) made = true;
    } catch (e) { console.warn('報告書と担当者URLを用意できませんでした', e); }
    if (seq !== shrSeq) return;
  }
  if (made) {
    try { await refreshShares(true); } catch (e) { console.warn(e); }
    if (seq !== shrSeq) return;
  }
  buildShare();
}

async function refreshShares(noRender) {
  const seq = shrSeq, id = shrCaseId;
  const reports = await ReportsApi.listByCase(id);
  const shares = await ReportsApi.listSharesByReports((reports || []).map(r => r.id));
  if (seq !== shrSeq) return;
  shrReports = reports || [];
  shrShares = shares || [];
  if (!noRender) renderShareList();
}
const shrPhases = () => (shrSummary && Array.isArray(shrSummary.phases) ? shrSummary.phases : []);
function shrTitle(p) {
  const same = shrPhases().filter(x => x.kind === p.kind);
  return PhaseLogic.phaseTitle(p, p.seq != null ? p.seq : same.indexOf(p) + 1);
}

/* ---- 骨組み ---- */
function buildShare() {
  const caseId = shrCaseId;
  const card = mk('div', 'rep-card');
  card.appendChild(mk('h3', null, '担当者URL'));
  card.appendChild(mk('div', 'rep-sub', shrSummary.name + (shrSummary.address ? ' ・ ' + shrSummary.address : '')));
  card.appendChild(mk('div', 'rep-note',
    '対応フェーズを作ると、そのフェーズの報告書と担当者URLが自動でできます（報告書1件につき1本・期限なし）。' +
    'このURLを開いた人ができること: この報告書の入力と写真の追加、提出だけ。ログイン不要。' +
    '他の案件・金額・タイムライン・依頼元の連絡先は見えません。提出するとURLは使えなくなります。社内でも同じ報告書を開いて編集できます。'));
  if (!shrPhases().length) card.appendChild(mk('div', 'empty', '対応フェーズがまだありません。案件ページで「＋ 調査」などを押すと、担当者URLができます'));
  const listErr = mk('div', 'err');
  listErr.id = 'shr-list-err';
  const list = mk('div');
  list.id = 'shr-list';
  $('share-root').replaceChildren(shrBack(caseId), card, listErr, list);
  renderShareList();
}

/* ---- 作り直す（同じ報告書） ---- */
async function onShareRemake(btn, rep, name) {
  setMsg('shr-list-err', '');
  return withBusy(btn, async () => {
    try { await ReportsApi.createShare(rep, name); }
    catch (e) { setMsg('shr-list-err', 'URLを作り直せませんでした: ' + errText(e)); return; }
    shrFocus = rep.id;
    try { await refreshShares(); }
    catch (e) { setMsg('shr-list-err', '表示を更新できませんでした: ' + errText(e)); }
  });
}

/* ---- URL のある報告書（フェーズの順 → フェーズに付いていない報告書。報告書ごとにいちばん新しい URL） ---- */
function renderShareList() {
  const box = $('shr-list');
  if (!box) return;
  const phases = shrPhases();
  const order = r => { const i = phases.findIndex(p => p.id === r.phase_id); return i < 0 ? phases.length : i; };
  const reps = shrReports.filter(r => ReportsApi.latestShare(shrShares, r.id))
    .sort((a, b) => order(a) - order(b) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  if (reps.length === 0) { box.replaceChildren(); return; }
  box.replaceChildren(...reps.map(rep => {
    const sh = ReportsApi.latestShare(shrShares, rep.id);
    const card = mk('div', 'rep-card shr-item');
    card.dataset.reportId = rep.id;
    const php = rep.phase_id ? phases.find(p => p.id === rep.phase_id) : null;
    if (php) card.dataset.phaseId = php.id;
    const wt = ReportLogic.WORK_TYPE_LABEL[rep.work_type] || rep.work_type;
    const top = mk('div', 'rep-between');
    top.appendChild(mk('b', null, (php ? shrTitle(php) + ' ・ ' : '') + wt + 'の報告書'));
    top.appendChild(dBtn('報告書を開く', 'btn sm ghost inline shr-open', () => { location.hash = '#report/' + rep.id; }));
    card.appendChild(top);
    const submittedAt = sh.submitted_at || (rep.status !== 'draft' ? rep.submitted_at : null);
    if (rep.status !== 'draft' || sh.submitted_at) {
      card.appendChild(mk('div', 'rep-sub', shrWho(sh.vendor_name) + 'あて ・ 発行 ' + shrMD(sh.created_at)));
      card.appendChild(mk('span', 'rep-pill p-ok shr-done', '提出済み' + (submittedAt ? '（' + shrMD(submittedAt) + '）' : '')));
      return card;
    }
    const url = ReportsApi.shareActive(sh) ? ReportsApi.shareUrl(sh) : '';
    const remake = b => onShareRemake(b, rep, sh.vendor_name);
    if (url) {
      card.appendChild(shareUrlBox({
        url, name: sh.vendor_name, title: '担当者URL', askHost: card, onRemake: remake,
        text: PhaseLogic.shareRequestText({ phase: php, caseRow: shrSummary, org: ctx && ctx.org, url })
      }));
    } else {
      // 044 より前に発行した URL（表示できない）・期限切れ・無効になった URL
      card.appendChild(mk('div', 'rep-sub', ReportsApi.shareActive(sh)
        ? shrWho(sh.vendor_name) + 'あてに ' + shrMD(sh.created_at) + ' に渡したURLは、ここに表示できません。分からなくなったら作り直してください'
        : 'このURLはもう使えません。渡し直すときは作り直してください'));
      const acts = mk('div', 'rep-acts');
      acts.appendChild(shrRemakeBtn(card, remake));
      card.appendChild(acts);
    }
    return card;
  }));
  if (shrFocus) {
    const el = box.querySelector('.shr-item[data-report-id="' + shrFocus + '"]');
    shrFocus = null;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }
}
