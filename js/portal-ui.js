// js/portal-ui.js — 案件詳細の「👥 お客様ページ」欄（URLの発行・コピー・送る文面・開いてみる・取り消し）
// お客様ページ = ログインなし・期限なし・取り消し可の読み取り専用ページ（p.html#token。Task 3）。
// 見せる範囲はサーバー側（portal_open）で相手の種類ごとに絞る。ここでは発行と管理だけ。
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。alert / confirm は使わない（画面内で確認）
// mk() は case-list.js、dBtn / errText / currentCase は case-detail.js、ctx は app.js のものを使う
//
// case-detail.js から呼ばれる:
//   renderPortals(rootEl) … 案件を読み込むたびに1回（currentCase は設定済み）
//
// 古い応答の捨て方: ptInst … いま画面にある欄1つ分の状態。renderPortals のたびに作り直す。
//   inst.seq … 一覧取得ごとの番号。後から始まった取得があれば前の応答は捨てる
let ptInst = null;

// 相手の種類ごとに「このURLで見られるもの」（portal_open の絞り込みと同じ内容）
const PT_SEES = {
  gc: '進み具合・お知らせ・工事のお知らせ・現場住所・お送りした報告書と見積書',
  pm: '進み具合・お知らせ・工事のお知らせ・現場住所・お送りした報告書（見積書は出ません）',
  owner: '進み具合・お知らせ・工事のお知らせ・現場住所・お送りした報告書（見積書は出ません）',
  resident: '進み具合・お知らせ・工事のお知らせ（現場住所と書類は出ません）'
};

const ptLive = inst => inst === ptInst && inst.root.isConnected;
const ptCaseRow = inst => (currentCase && currentCase.id === inst.caseId ? currentCase : inst.caseRow);

function ptShareText(inst, row) {
  const c = ptCaseRow(inst);
  return PortalLogic.shareText({
    audience: row.audience, label: row.label, caseName: c ? c.name : '',
    orgName: (ctx && ctx.org && ctx.org.name) || '', url: PortalsApi.urlOf(row)
  });
}

// クリップボードへ。使えない端末では文字を選んだ状態の欄を出す（長押しでコピーしてもらう）
async function ptCopy(text, statusEl, fallbackBox, okText) {
  statusEl.textContent = '';
  fallbackBox.replaceChildren();
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard');
    await navigator.clipboard.writeText(text);
    statusEl.textContent = okText || 'コピーしました';
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.className = 'pt-fallback';
    ta.readOnly = true;
    ta.value = text;
    ta.rows = Math.min(6, String(text).split('\n').length);
    ta.setAttribute('aria-label', 'コピーする内容');
    fallbackBox.appendChild(ta);
    ta.focus();
    ta.select();
    statusEl.textContent = 'コピーできませんでした。下の文字を選んだので、長押し（またはCtrl+C）でコピーしてください';
  }
}

// 「URLをコピー」「送る文面をコピー」「開いてみる」の3つ（一覧の行と発行直後の欄で共通）
function ptCopyActs(inst, row, statusEl, fallbackBox) {
  const url = PortalsApi.urlOf(row);
  const b1 = dBtn('URLをコピー', 'btn sm inline', () => ptCopy(url, statusEl, fallbackBox, 'URLをコピーしました'));
  b1.classList.add('pt-copy-url');
  const b2 = dBtn('送る文面をコピー', 'btn sm ghost inline', () =>
    ptCopy(ptShareText(inst, row), statusEl, fallbackBox, '送る文面をコピーしました。LINEやメールに貼り付けて送ってください'));
  b2.classList.add('pt-copy-text');
  const a = mk('a', 'pt-open', '開いてみる');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  return [b1, b2, a];
}

// ---- 入口 ----
function renderPortals(root) {
  const c = currentCase;
  if (!c) return;
  const inst = {
    root, caseId: c.id, caseRow: c, seq: 0, rows: null, busy: false,
    form: null,        // 発行フォーム { audience, label, edited }（null=閉）
    confirmId: null,   // 取り消しの確認を出している行の id
    issued: null,      // 発行した直後の行（結果欄に出す）
    revokedOpen: false // 「取り消したURL」を開いているか
  };
  ptInst = inst;

  const head = mk('div', 'taio-head');
  head.appendChild(mk('b', null, '👥 お客様ページ'));
  const sum = mk('span', 'taio-sum');
  sum.id = 'pt-sum';
  head.appendChild(sum);
  const lead = mk('div', 'rep-sub pt-lead',
    'ログインなしで見られる、相手ごとのページです。進み具合・お客様へのお知らせ・お送りした書類が自動で反映されます。');
  const err = mk('div', 'err');
  err.id = 'pt-err';
  const list = mk('div', 'pt-list');
  list.id = 'pt-list';
  const result = mk('div');
  result.id = 'pt-result';
  const form = mk('div');
  form.id = 'pt-form';
  const revoked = mk('div');
  revoked.id = 'pt-revoked';
  root.replaceChildren(head, lead, list, result, form, revoked, err);
  Object.assign(inst, { sumEl: sum, errEl: err, listEl: list, resultEl: result, formEl: form, revokedEl: revoked });

  ptRenderForm(inst);
  list.replaceChildren(mk('div', 'nx-empty', '読み込み中…'));
  ptLoad(inst);
}

async function ptLoad(inst) {
  const seq = ++inst.seq;
  let rows;
  try {
    rows = await PortalsApi.list(inst.caseId);
  } catch (e) {
    if (!ptLive(inst) || seq !== inst.seq) return;
    if (inst.rows) {
      inst.errEl.textContent = '最新の状態に更新できませんでした: ' + errText(e);
    } else {
      inst.listEl.replaceChildren(mk('div', 'err', 'お客様ページの読み込みに失敗しました: ' + errText(e)),
        dBtn('再読み込み', 'btn sm ghost inline', () => {
          inst.listEl.replaceChildren(mk('div', 'nx-empty', '読み込み中…'));
          ptLoad(inst);
        }));
    }
    return;
  }
  if (!ptLive(inst) || seq !== inst.seq) return;
  inst.rows = rows || [];
  ptRenderList(inst);
}

// ---- 一覧（有効なURL・取り消したURL） ----
function ptRenderList(inst) {
  if (!ptLive(inst) || !inst.rows) return;
  const { active, revoked } = PortalLogic.splitPortals(inst.rows);
  inst.sumEl.textContent = active.length > 0 ? '公開中 ' + active.length + '件' : '';
  if (active.length === 0) {
    inst.listEl.replaceChildren(mk('div', 'nx-empty', 'まだURLを発行していません'));
  } else {
    inst.listEl.replaceChildren(...active.map(r => ptRowEl(inst, r)));
  }

  if (revoked.length === 0) {
    inst.revokedEl.replaceChildren();
  } else {
    const det = document.createElement('details');
    det.className = 'pt-revoked';
    det.open = inst.revokedOpen;
    det.addEventListener('toggle', () => { inst.revokedOpen = det.open; });
    det.appendChild(mk('summary', null, '取り消したURL（' + revoked.length + '）'));
    revoked.forEach(r => {
      const line = mk('div', 'pt-rv-row');
      line.append(mk('span', 'pt-rv-label', r.label),
        mk('span', 'rep-sub', PortalLogic.audienceLabel(r.audience) + ' ・ ' + PortalLogic.mdText(r.revoked_at) + ' に取り消し'));
      det.appendChild(line);
    });
    inst.revokedEl.replaceChildren(det);
  }
  inst.listEl.querySelectorAll('button').forEach(b => { b.disabled = inst.busy; });
}

function ptRowEl(inst, r) {
  const row = mk('div', 'pt-row');
  row.dataset.id = r.id;
  const top = mk('div', 'rep-between');
  top.append(mk('b', 'pt-label', r.label), mk('span', 'rep-pill p-draft', PortalLogic.audienceLabel(r.audience)));
  row.appendChild(top);

  const sub = mk('div', 'pt-sub');
  sub.append(mk('span', r.last_opened_at ? 'pt-opened' : 'pt-unopened', PortalLogic.openedText(r.last_opened_at)),
    mk('span', 'rep-sub', '発行 ' + PortalLogic.mdText(r.created_at)));
  row.appendChild(sub);

  const status = mk('div', 'shr-ok pt-status');
  status.setAttribute('role', 'status');
  const fallback = mk('div', 'pt-fb');
  const acts = mk('div', 'pt-acts');
  acts.append(...ptCopyActs(inst, r, status, fallback));
  const rv = dBtn('取り消し', 'linkbtn danger pt-revoke', () => {
    if (inst.busy) return;
    inst.confirmId = r.id;
    inst.errEl.textContent = '';
    ptRenderList(inst);
  });
  acts.appendChild(rv);
  row.appendChild(acts);

  if (inst.confirmId === r.id) {
    const cf = mk('div', 'pt-confirm');
    cf.appendChild(mk('div', null,
      '「' + r.label + '」あてのURLを取り消しますか？ 取り消すと、このURLではページを見られなくなります（元に戻せません。必要なら新しく発行してください）。'));
    const ca = mk('div', 'pt-acts');
    const yes = dBtn('取り消す', 'btn sm inline pt-danger', () => ptRevoke(inst, r));
    yes.classList.add('pt-revoke-yes');
    ca.append(yes, dBtn('やめる', 'btn sm ghost inline', () => {
      inst.confirmId = null;
      ptRenderList(inst);
    }));
    cf.appendChild(ca);
    row.appendChild(cf);
  }
  row.append(status, fallback);
  return row;
}

async function ptRevoke(inst, r) {
  if (inst.busy) return;
  inst.busy = true;
  inst.errEl.textContent = '';
  ptRenderList(inst);
  let msg = '';
  try { await PortalsApi.revoke(r.id); }
  catch (e) { msg = '取り消しに失敗しました: ' + errText(e); }
  inst.busy = false;
  if (!ptLive(inst)) return;
  inst.confirmId = null;
  if (!msg && inst.issued && inst.issued.id === r.id) {
    inst.issued = null;
    inst.resultEl.replaceChildren();
  }
  ptRenderList(inst);
  await ptLoad(inst);
  if (msg && ptLive(inst)) inst.errEl.textContent = msg;
}

// ---- 発行フォーム ----
function ptRenderForm(inst) {
  const box = inst.formEl;
  if (!inst.form) {
    const open = dBtn('＋ URL を発行', 'btn sm ghost inline pt-new', () => {
      const aud = 'gc';
      inst.form = { audience: aud, label: PortalLogic.defaultLabel(aud, ptCaseRow(inst)), edited: false };
      inst.errEl.textContent = '';
      ptRenderForm(inst);
    });
    const wrap = mk('div', 'taio-add pt-new-wrap');
    wrap.appendChild(open);
    box.replaceChildren(wrap);
    return;
  }
  const f = inst.form;
  const form = mk('div', 'addform pt-form');
  form.appendChild(mk('div', 'af-ttl', '＋ お客様ページのURLを発行'));
  form.appendChild(mk('div', 'pt-q', 'だれに送りますか'));
  const chips = mk('div', 'taio-add pt-chips');
  PortalLogic.AUDIENCES.forEach(a => {
    const c = dBtn(a.label, 'chip' + (f.audience === a.key ? ' on' : ''), () => {
      if (f.sending || f.audience === a.key) return;
      f.audience = a.key;
      if (!f.edited) f.label = PortalLogic.defaultLabel(a.key, ptCaseRow(inst));
      ptRenderForm(inst);
    });
    c.dataset.aud = a.key;
    c.setAttribute('aria-pressed', f.audience === a.key ? 'true' : 'false');
    chips.appendChild(c);
  });
  form.appendChild(chips);
  form.appendChild(mk('div', 'pt-sees', 'このURLで見られるもの: ' + PT_SEES[f.audience]));

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'pt-label';
  input.autocomplete = 'off';
  input.maxLength = PortalLogic.LABEL_MAX;
  input.value = f.label;
  input.addEventListener('input', () => { f.label = input.value; f.edited = true; });
  const lab = mk('label', 'pt-field', '宛名（ページの上と送る文面に出ます）');
  lab.appendChild(input);
  form.appendChild(lab);

  const ferr = mk('div', 'err');
  ferr.id = 'pt-form-err';
  const acts = mk('div', 'af-act');
  const cancel = dBtn('キャンセル', 'btn sm ghost inline', () => {
    if (f.sending) return;
    inst.form = null;
    ptRenderForm(inst);
  });
  cancel.id = 'pt-cancel';
  acts.appendChild(cancel);
  const go = dBtn('発行する', 'btn sm inline', () => ptIssue(inst, ferr));
  go.id = 'pt-issue';
  acts.appendChild(go);
  form.append(acts, ferr);
  box.replaceChildren(form);
  ptLockForm(inst, !!f.sending);
}

// 送信中は 発行する・相手の種類・キャンセル・宛名 を押せなくする
// （通信中に種類を押すとフォームが作り直され、新しい「発行する」が押せて URL が2件発行されるため）
function ptLockForm(inst, on) {
  inst.formEl.querySelectorAll('button, input').forEach(el => { el.disabled = on; });
}

async function ptIssue(inst, ferr) {
  const f = inst.form;
  if (!f || f.sending) return;
  ferr.textContent = '';
  const m = PortalLogic.labelError(f.label);
  if (m) { ferr.textContent = m; const i = document.getElementById('pt-label'); if (i) i.focus(); return; }
  f.sending = true;
  ptLockForm(inst, true);
  let row;
  try {
    row = await PortalsApi.issue(inst.caseId, f.audience, f.label);
  } catch (e) {
    f.sending = false;
    if (ptLive(inst) && inst.form === f) {
      ptLockForm(inst, false);
      ferr.textContent = 'URLを発行できませんでした: ' + errText(e);
    }
    return;
  }
  f.sending = false;
  if (!ptLive(inst)) return;
  inst.form = null;
  inst.issued = row;
  ptRenderForm(inst);
  ptRenderResult(inst);
  await ptLoad(inst);
}

// 発行した直後: URL とコピー2種を目立つ形で出す（一覧にも同じ行が出る。後からもコピーし直せる）
function ptRenderResult(inst) {
  const r = inst.issued;
  if (!r) { inst.resultEl.replaceChildren(); return; }
  const url = PortalsApi.urlOf(r);
  const wrap = mk('div', 'pt-issued');
  wrap.appendChild(mk('b', null, '「' + r.label + '」あてのURLを発行しました'));
  wrap.appendChild(mk('div', 'rep-sub', PortalLogic.audienceLabel(r.audience) + '向け ・ ' + PT_SEES[r.audience]));
  const line = mk('div', 'shr-link');
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.readOnly = true;
  inp.id = 'pt-url';
  inp.value = url;
  inp.setAttribute('aria-label', '発行したURL');
  inp.addEventListener('focus', () => inp.select());
  line.appendChild(inp);
  wrap.appendChild(line);
  const status = mk('div', 'shr-ok pt-status');
  status.setAttribute('role', 'status');
  const fallback = mk('div', 'pt-fb');
  const acts = mk('div', 'pt-acts');
  acts.append(...ptCopyActs(inst, r, status, fallback));
  wrap.append(acts, status, fallback);
  wrap.appendChild(mk('div', 'rep-sub', 'このURLは上の一覧からいつでもコピーし直せます。'));
  const close = dBtn('閉じる', 'linkbtn', () => { inst.issued = null; ptRenderResult(inst); });
  wrap.appendChild(close);
  inst.resultEl.replaceChildren(wrap);
}
