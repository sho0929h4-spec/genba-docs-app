// js/report-share.js — ⑦ 担当者へURLを渡す（#case/{id}/share）… openShareScreen(caseId, reportId)  （Task 6 → Task 24 で単純化）
// 担当者名（任意）・対応フェーズ・作業区分 →「URLを発行」で下書きの報告書を作り、その報告書の URL を発行する。
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
const SHR_WORK_TYPE = { survey: 'investigate', cause: 'repair', repair: 'restore' }; // phase-ui.js の PH_WORK_TYPE と同じ
// 既定のフェーズ: 報告書の無いフェーズのうち、段階が 調査日を決める／調査に行く の調査 → 完了報告必要の工事 → 無し
function shrDefaultPhase(phases) {
  const list = (phases || []).filter(p => !(p.reports || []).length);
  const st = p => PhaseLogic.stage(p, null, new Date()).key;
  const a = list.find(p => p.kind === 'survey' && (st(p) === 'schedule' || st(p) === 'visit'));
  if (a) return a.id;
  const b = list.find(p => p.kind !== 'survey' && st(p) === 'report');
  return b ? b.id : '';
}
const shrWho = name => (String(name || '').trim() ? String(name).trim() + ' 様' : '担当者 様');

// URL の欄（URL・URLをコピー・送る文面をコピー・LINEで送る・URLを作り直す）。⑦ と対応フェーズで共通
//   o: { url, name, text（送る文面）, onRemake(btn)（任意。無ければ「URLを作り直す」を出さない）, askHost（作り直しの確認を出す場所） }
function shareUrlBox(o) {
  const box = mk('div', 'shr-box');
  const head = mk('div', 'rep-between');
  head.append(mk('b', null, shrWho(o.name) + 'あてのURL'), mk('span', 'rep-pill p-wait', '有効（提出まで）'));
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
  buildShare();
}

async function refreshShares() {
  const seq = shrSeq, id = shrCaseId;
  const reports = await ReportsApi.listByCase(id);
  const shares = await ReportsApi.listSharesByReports((reports || []).map(r => r.id));
  if (seq !== shrSeq) return;
  shrReports = reports || [];
  shrShares = shares || [];
  renderShareList();
}

/* ---- 骨組み ---- */
function buildShare() {
  const caseId = shrCaseId;
  const card = mk('div', 'rep-card');
  card.appendChild(mk('h3', null, '🔗 担当者へURLを渡す'));
  card.appendChild(mk('div', 'rep-sub', shrSummary.name + (shrSummary.address ? ' ・ ' + shrSummary.address : '')));

  const vendor = document.createElement('input');
  vendor.type = 'text';
  vendor.id = 'shr-vendor';
  vendor.maxLength = 60;
  vendor.autocomplete = 'off';
  vendor.placeholder = '例：山本設備（空でもよい）';
  const phases = (shrSummary.phases || []);
  const count = {};
  const phOpts = [['', '（フェーズに付けない）']].concat(phases.map(p => {
    count[p.kind] = (count[p.kind] || 0) + 1;
    return [p.id, PhaseLogic.phaseTitle(p, p.seq != null ? p.seq : count[p.kind])];
  }));
  const ph0 = shrDefaultPhase(phases);
  const p0 = phases.find(p => p.id === ph0);
  const type = edSelect('shr-type', Object.entries(ReportLogic.WORK_TYPE_LABEL), p0 ? SHR_WORK_TYPE[p0.kind] : 'investigate', () => {});
  const phaseSel = edSelect('shr-phase', phOpts, ph0, v => {
    const p = phases.find(x => x.id === v);
    if (p) type.value = SHR_WORK_TYPE[p.kind];
  });
  const form = mk('div');
  form.style.marginTop = '10px';
  form.appendChild(edField('担当者名（任意）', vendor));
  const g2 = mk('div', 'rep-g2');
  g2.append(edField('対応フェーズ', phaseSel), edField('作業区分', type));
  form.appendChild(g2);
  card.appendChild(form);

  const issue = dBtn('URLを発行', 'btn', b => onShareIssue(b, caseId, vendor, type, phaseSel, phOpts));
  issue.id = 'shr-issue';
  card.appendChild(issue);
  const err = mk('div', 'err');
  err.id = 'shr-err';
  card.appendChild(err);
  card.appendChild(mk('div', 'rep-note',
    'このURLを開いた人ができること: この報告書の入力と写真の追加、提出だけ。ログイン不要・期限なし。' +
    '他の案件・金額・タイムライン・依頼元の連絡先は見えません。提出するとURLは使えなくなります。社内でも同じ報告書を開いて編集できます。'));

  const listErr = mk('div', 'err');
  listErr.id = 'shr-list-err';
  const list = mk('div');
  list.id = 'shr-list';

  $('share-root').replaceChildren(shrBack(caseId), card, listErr, list);
  renderShareList();
}

/* ---- 発行（新しい報告書） ---- */
function onShareIssue(btn, caseId, vendorEl, typeEl, phaseEl, phOpts) {
  const name = vendorEl.value.trim();
  setMsg('shr-err', '');
  return withBusy(btn, async () => {
    let report;
    try {
      const f = { work_type: typeEl.value, worker_name: name };
      if (phaseEl && phaseEl.value) {
        f.phase_id = phaseEl.value;
        f.phaseTitle = (phOpts.find(o => o[0] === phaseEl.value) || [])[1] || '';
      }
      // Task 23 I11: 号室・作業日の初期値（案件の号室・フェーズの日）
      const cs = shrSummary;
      const ph0 = cs && f.phase_id ? (cs.phases || []).find(x => x.id === f.phase_id) : null;
      if (cs) {
        const pf = PhaseLogic.reportFields(ph0 || {}, cs, { workerName: name });
        if (pf.room) f.room = pf.room;
        f.work_date = pf.work_date;
        if (ph0 && ph0.kind === 'survey' && pf.init) f.init = pf.init;
      }
      report = await ReportsApi.create(caseId, f);
    } catch (e) {
      setMsg('shr-err', '報告書を作成できませんでした: ' + errText(e));
      return;
    }
    try {
      await ReportsApi.createShare(report, name);
    } catch (e) {
      try { await ReportsApi.remove(report); } catch (_) { /* 下書きが残るだけ */ }
      setMsg('shr-err', 'URLを発行できませんでした: ' + errText(e));
      return;
    }
    if (caseId !== shrCaseId) return;
    vendorEl.value = '';
    shrFocus = report.id;
    try { await refreshShares(); }
    catch (e) { setMsg('shr-list-err', '表示を更新できませんでした: ' + errText(e)); }
  });
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

/* ---- URL を渡した報告書（報告書ごとにいちばん新しい URL） ---- */
function renderShareList() {
  const box = $('shr-list');
  if (!box) return;
  const reps = shrReports.filter(r => ReportsApi.latestShare(shrShares, r.id));
  if (reps.length === 0) { box.replaceChildren(); return; }
  box.replaceChildren(...reps.map(rep => {
    const sh = ReportsApi.latestShare(shrShares, rep.id);
    const card = mk('div', 'rep-card shr-item');
    card.dataset.reportId = rep.id;
    const php = rep.phase_id ? (shrSummary.phases || []).find(p => p.id === rep.phase_id) : null;
    const wt = ReportLogic.WORK_TYPE_LABEL[rep.work_type] || rep.work_type;
    const top = mk('div', 'rep-between');
    top.appendChild(mk('b', null, (php ? PhaseLogic.phaseTitle(php) + ' ・ ' : '') + wt + 'の報告書'));
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
        url, name: sh.vendor_name, askHost: card, onRemake: remake,
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
