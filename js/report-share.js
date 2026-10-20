// js/report-share.js — ⑦ 協力業者に報告書の作成を依頼（#case/{id}/share）… openShareScreen(caseId)  （Task 6）
// 協力業者名・対応フェーズ・作業区分・期限 → 下書きの報告書を作る（worker_name = 協力業者名・phase_id = 選んだフェーズ）→ URL を発行して表示。
// Task 16: 対応フェーズを選べる（既定は まだ報告書の無いフェーズのうち最初の調査、無ければ完了報告が要る工事）。
//   選んだフェーズの段階は 🟡 調査報告待ち（工事は 完了報告必要（作業員の入力待ち））になり、提出されると done_at が自動で入る（migration 034）
// URL（token）は DB に保存されない（ハッシュだけ）。表示できるのは発行直後のこの画面だけ。
//   画面を離れたら表示中の URL を DOM から消す。一覧は状態だけで、URL は出せない。
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）
// mk() は case-list.js、dBtn / dField / dSelect / errText は case-detail.js、withBusy / setMsg / showScreen / renderHeaders / $ は app.js
// openShareScreen が定義されていると ⑤（js/report-ui.js）に「🔗 協力業者に作成を依頼」ボタンが出る

let shrCaseId = null;
let shrSeq = 0;          // 読み込みのたびに増やす。古い応答を捨てる
let shrSummary = null;
let shrReports = [];
let shrShares = [];
let shrBusy = false;     // 無効化の実行中

// 値 'none' = 期限なし（提出・無効化まで有効）。既定
const SHR_DAYS = [['none', '期限なし（提出まで有効）'], ['7', '7日間'], ['14', '14日間'], ['30', '30日間']];
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

function openShareScreen(caseId) {
  if (!caseId) return;
  const h = shrHash(caseId);
  if (location.hash !== h) { location.hash = h; return; } // → hashchange → routeFromHash → もう一度ここへ
  showScreen('share');
  renderHeaders();
  return loadShare(caseId);
}

// 画面を離れたら、表示していた URL を消す（戻る操作で見えないように）
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
  shrSummary = null; shrReports = []; shrShares = []; shrBusy = false;
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
  card.appendChild(mk('h3', null, '🔗 協力業者に報告書の作成を依頼'));
  card.appendChild(mk('div', 'rep-sub', shrSummary.name + (shrSummary.address ? ' ・ ' + shrSummary.address : '')));

  const vendor = document.createElement('input');
  vendor.type = 'text';
  vendor.id = 'shr-vendor';
  vendor.maxLength = 60;
  vendor.autocomplete = 'off';
  vendor.placeholder = '例：山本設備';
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
  const days = edSelect('shr-days', SHR_DAYS, 'none', () => {});
  const form = mk('div');
  form.style.marginTop = '10px';
  form.appendChild(edField('協力業者名 *', vendor));
  form.appendChild(edField('対応フェーズ', phaseSel));
  const g2 = mk('div', 'rep-g2');
  g2.append(edField('作業区分', type), edField('有効期限', days));
  form.appendChild(g2);
  card.appendChild(form);

  const issue = dBtn('URLを発行する', 'btn', b => onShareIssue(b, caseId, vendor, type, days, phaseSel, phOpts));
  issue.id = 'shr-issue';
  card.appendChild(issue);
  const err = mk('div', 'err');
  err.id = 'shr-err';
  card.appendChild(err);
  const result = mk('div');
  result.id = 'shr-result';
  card.appendChild(result);
  card.appendChild(mk('div', 'rep-note',
    'このURLを開いた人ができること: この報告書の入力と写真の追加、提出だけ。ログイン不要。' +
    '他の案件・金額・タイムライン・依頼者の連絡先は見えません。提出したら編集できなくなり、URLは自動で無効になります。'));

  const listCard = mk('div', 'rep-card');
  listCard.appendChild(mk('h3', null, '発行済みのURL'));
  const cnt = mk('div', 'rep-sub');
  cnt.id = 'shr-active-count';
  cnt.setAttribute('role', 'status');
  listCard.appendChild(cnt);
  listCard.appendChild(mk('div', 'rep-sub', 'URLそのものは発行した直後にしか表示できません。分からなくなったら、無効にして発行し直してください。'));
  const listErr = mk('div', 'err');
  listErr.id = 'shr-list-err';
  const list = mk('div');
  list.id = 'shr-list';
  listCard.append(listErr, list);

  $('share-root').replaceChildren(shrBack(caseId), card, listCard);
  renderShareList();
}

/* ---- 発行 ---- */
function onShareIssue(btn, caseId, vendorEl, typeEl, daysEl, phaseEl, phOpts) {
  const name = vendorEl.value.trim();
  setMsg('shr-err', '');
  if (!name) { setMsg('shr-err', '協力業者名を入力してください'); vendorEl.focus(); return; }
  return withBusy(btn, async () => {
    $('shr-result').replaceChildren();
    let report;
    try {
      const f = { work_type: typeEl.value, worker_name: name };
      if (phaseEl && phaseEl.value) {
        f.phase_id = phaseEl.value;
        f.phaseTitle = (phOpts.find(o => o[0] === phaseEl.value) || [])[1] || '';
      }
      report = await ReportsApi.create(caseId, f);
    } catch (e) {
      setMsg('shr-err', '報告書を作成できませんでした: ' + errText(e));
      return;
    }
    let res;
    try {
      res = await ReportsApi.createShare(report, name, daysEl.value === 'none' ? null : Number(daysEl.value));
    } catch (e) {
      try { await ReportsApi.remove(report); } catch (_) { /* 下書きが残るだけ */ }
      setMsg('shr-err', 'URLを発行できませんでした: ' + errText(e));
      return;
    }
    if (caseId !== shrCaseId) return; // 発行中に別の画面へ移った（URLは表示しない）
    vendorEl.value = '';
    renderShareResult(res, name);
    try { await refreshShares(); }
    catch (e) { setMsg('shr-list-err', '一覧を更新できませんでした: ' + errText(e)); }
  });
}

function renderShareResult(res, vendorName) {
  const box = $('shr-result');
  const url = res.url;
  const due = res.share.expires_at ? shrMD(res.share.expires_at) : ''; // 期限なしは ''
  const wrap = mk('div', 'rep-card');
  wrap.style.margin = '12px 0 0';
  wrap.style.borderColor = 'var(--navy)';
  const head = mk('div', 'rep-between');
  head.append(mk('b', null, vendorName + ' 様あてのURL'), mk('span', 'rep-pill p-wait', due ? '有効・' + due + 'まで' : '有効（提出まで）'));
  wrap.appendChild(head);

  const line = mk('div', 'shr-link');
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.readOnly = true;
  inp.id = 'shr-url';
  inp.value = url;
  inp.setAttribute('aria-label', '発行したURL');
  inp.addEventListener('focus', () => inp.select());
  const status = mk('div', 'shr-ok');
  status.id = 'shr-copy-msg';
  status.setAttribute('role', 'status');
  const copy = dBtn('コピー', 'btn sm inline', async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard');
      await navigator.clipboard.writeText(url);
      status.textContent = 'コピーしました';
    } catch (e) {
      inp.focus();
      inp.select();
      status.textContent = 'コピーできませんでした。URLを選択したので、長押し（またはCtrl+C）でコピーしてください';
    }
  });
  copy.id = 'shr-copy';
  line.append(inp, copy);
  wrap.append(line, status);

  const acts = mk('div', 'rep-acts');
  acts.style.marginTop = '8px';
  const orgName = (ctx && ctx.org && ctx.org.name) || '';
  const msg = orgName + 'です。' + (shrSummary ? shrSummary.name : '') + 'の作業報告書の入力をお願いします' + (due ? '（' + due + 'まで）' : '') + '\n' + url;
  const a = mk('a', 'shr-line', 'LINEで送る');
  a.id = 'shr-line';
  a.href = 'https://line.me/R/msg/text/?' + encodeURIComponent(msg);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  acts.appendChild(a);
  wrap.appendChild(acts);
  wrap.appendChild(mk('div', 'shr-warn', 'このURLは今だけ表示されます。閉じる前にコピーしてください'));
  box.replaceChildren(wrap);
}

/* ---- 発行済み一覧 ---- */
// [表示, pill の class, 有効か]
function shareState(sh, rep) {
  if (sh.submitted_at) return ['提出済み', 'p-ok', false];
  if (sh.revoked_at) return ['無効', 'p-red', false];
  if (sh.expires_at && !(Date.parse(sh.expires_at) > Date.now())) return ['期限切れ', 'p-draft', false];
  if (rep && rep.status !== 'draft') return ['使用不可（報告書は提出済み）', 'p-draft', false];
  return [sh.expires_at ? '有効・' + shrMD(sh.expires_at) + 'まで' : '有効（提出まで）', 'p-wait', true];
}

function renderShareList() {
  const box = $('shr-list');
  if (!box) return;
  // 期限なしのURLは出しっぱなしになりやすいので、今も使えるURLの件数を見せる
  const cnt = $('shr-active-count');
  if (cnt) {
    const n = shrShares.filter(sh => shareState(sh, shrReports.find(r => r.id === sh.report_id))[2]).length;
    cnt.textContent = '今も使えるURL: ' + n + '件';
  }
  if (shrShares.length === 0) { box.replaceChildren(mk('div', 'rep-sub', 'まだ発行していません')); return; }
  box.replaceChildren(...shrShares.map(sh => {
    const rep = shrReports.find(r => r.id === sh.report_id);
    const [label, pill, active] = shareState(sh, rep);
    const row = mk('div', 'rep-row');
    row.dataset.id = sh.id;
    const top = mk('div', 'rep-between');
    top.append(mk('b', null, sh.vendor_name + ' 様'), mk('span', 'rep-pill ' + pill, label));
    row.appendChild(top);
    const wt = rep ? (ReportLogic.WORK_TYPE_LABEL[rep.work_type] || rep.work_type) : '（報告書なし）';
    const php = rep && rep.phase_id && shrSummary ? (shrSummary.phases || []).find(p => p.id === rep.phase_id) : null;
    row.appendChild(mk('div', 'rep-sub', (php ? PhaseLogic.phaseTitle(php) + ' ・ ' : '') + wt + ' ・ 発行 ' + repStamp(sh.created_at) +
      (sh.submitted_at ? ' ・ 提出 ' + repStamp(sh.submitted_at) : '')));
    if (active) {
      const acts = mk('div', 'rep-acts');
      acts.style.marginTop = '6px';
      acts.appendChild(dBtn('無効にする', 'btn sm ghost inline danger', () => onShareRevoke(sh)));
      row.appendChild(acts);
    }
    return row;
  }));
  box.querySelectorAll('button').forEach(b => { b.disabled = shrBusy; });
}

async function onShareRevoke(sh) {
  if (shrBusy) return;
  if (!confirm('「' + sh.vendor_name + '」様あてのURLを無効にしますか？\n無効にすると、このURLでは入力・提出できなくなります（元に戻せません）。')) return;
  shrBusy = true;
  renderShareList();
  setMsg('shr-list-err', '');
  let msg = '';
  try { await ReportsApi.revokeShare(sh.id); }
  catch (e) { msg = '無効にできませんでした: ' + errText(e); }
  try { await refreshShares(); }
  catch (e) { msg = msg || '一覧を更新できませんでした: ' + errText(e); }
  shrBusy = false;
  renderShareList();
  if (msg) setMsg('shr-list-err', msg);
}
