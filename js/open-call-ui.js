// js/open-call-ui.js — 作業担当者の「一斉配信（早い者順）」（Task 51。DB は migration 070、判定は PhaseLogic.isOpenCall / callText・TalkLogic.callState）
//   ocModeEl … 作業担当者の決め方「特定の担当者を選ぶ」「一斉配信（早い者順）」の切り替え（管理者の対応の表・新規案件・現場用の案件登録で共通）
//   ocCardEl … 全体のトークの募集のカード。候補のある募集は候補ごとに「… で行けます」、それ以外は「行けます」。
//              一番早く押した人が担当（DB の phase_open_call_accept が担当者が空のときだけ入れる）。ほかの人は「決まりました（○○が担当）」
//   Task 60（migration 076）: ocWhenEl … 「いつ来てほしいか」（今日中・今日 ○時以降・明日・明日 ○時以降・日時を決める・日時未定）。
//              範囲のある募集のカードは所要時間と到着の時刻（30分きざみ・今より前は出さない・自分の予定と重なる時刻は灰色）→「この時刻で行きます」
//              = 担当＋日時が決まる。募集した本人にも同じカード（見た人・決まったか）。期限切れは「出し直す」
// Task 70: 日時のある募集の「この時刻で行きます」「行けます」は、すぐ決めずに移動の時間の確認（TravelUi.check。同じ日の前後に予定があるときだけ）
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。alert/confirm は使わない
// mk() は case-list.js、dBtn / errText は case-detail.js、schBusyBtn / schErr は schedule-ui.js

const OC_MODES = [{ key: 'pick', label: '特定の担当者を選ぶ' }, { key: 'call', label: '一斉配信（早い者順）' }];
const OC_HINT = '会社の全員のタスクに「募集: … — 行けますか？」が出て、一番早く「行けます」を押した人が担当になります';

// 決め方の切り替え（2つのボタン・aria-pressed）。onChange(key)
function ocModeEl(mode, onChange, idPrefix) {
  const box = mk('div', 'oc-mode');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', '作業担当者の決め方');
  OC_MODES.forEach(m => {
    const b = dBtn(m.label, 'oc-mode-btn' + (m.key === mode ? ' on' : ''), () => { if (m.key !== mode) onChange(m.key); });
    b.dataset.mode = m.key;
    if (idPrefix) b.id = idPrefix + '-' + m.key;
    b.setAttribute('aria-pressed', m.key === mode ? 'true' : 'false');
    box.appendChild(b);
  });
  return box;
}

// Task 60: 「いつ来てほしいか」の選び方。v = { when, hour }（この関数が書き換える）。o: { idPrefix, fixedText, clearText, onChange(v) }
//   範囲のある選び方は「到着 10/24（土）13:30〜22:00 の間」を出す（今日がもう無いなどは赤い字）
function ocWhenEl(v, o) {
  const box = mk('div', 'oc-when-box');
  const draw = () => {
    const hours = v.when === 'today_after' || v.when === 'tomorrow_after' ? PhaseLogic.callHours(v.when) : [];
    if (hours.length && !hours.includes(Number(v.hour))) v.hour = hours[0];
    const btns = mk('div', 'oc-mode oc-when');
    btns.setAttribute('role', 'group');
    btns.setAttribute('aria-label', 'いつ来てほしいか');
    PhaseLogic.CALL_WHENS.forEach(w => {
      const b = dBtn(w.label, 'oc-mode-btn' + (w.key === v.when ? ' on' : ''), () => { if (w.key === v.when) return; v.when = w.key; draw(); if (o.onChange) o.onChange(v); });
      b.dataset.when = w.key;
      b.id = o.idPrefix + '-' + w.key;
      b.setAttribute('aria-pressed', w.key === v.when ? 'true' : 'false');
      btns.appendChild(b);
    });
    const nodes = [btns];
    if (v.when === 'today_after' || v.when === 'tomorrow_after') {
      const sel = document.createElement('select');
      sel.id = o.idPrefix + '-hour';
      sel.setAttribute('aria-label', '何時以降');
      hours.forEach(h => sel.appendChild(new Option(h + ':00 以降', String(h))));
      if (!hours.length) sel.appendChild(new Option('今日はもう選べる時がありません', ''));
      sel.value = hours.length ? String(v.hour) : '';
      sel.addEventListener('change', () => { v.hour = sel.value === '' ? null : Number(sel.value); draw(); if (o.onChange) o.onChange(v); });
      nodes.push(sel);
    }
    let hint = '';
    let bad = false;
    if (PhaseLogic.isCallWindow(v.when)) {
      const w = PhaseLogic.callWindow(v.when, v.hour);
      bad = !!w.error;
      hint = w.error || '到着 ' + PhaseLogic.callRangeText({ open_call_from: w.from, open_call_to: w.to }) + ' の間。押した人が到着の時刻を選び、担当と日時が決まります（22:00 までに終わる時刻）';
    } else if (v.when === 'fixed') hint = o.fixedText || '';
    else hint = '日時は担当が決まった後に決めます';
    if (v.when !== 'fixed' && o.clearText) hint += '。' + o.clearText;
    const h = mk('div', bad ? 'err oc-when-hint' : 'oc-hint oc-when-hint', hint);
    h.id = o.idPrefix + '-hint';
    nodes.push(h);
    box.replaceChildren(...nodes);
  };
  draw();
  return box;
}
// 初めの選び方: 日時が入っていれば「日時を決める」、日程調整のスイッチ true（schedule ブランチ）なら「日時未定」（候補・入居者の都合のまま募集）、
//   なければ「今日中」（今日がもう無ければ「明日」）
const ocWhenDefault = p => ({ when: p && p.scheduled_at ? 'fixed' : PhaseLogic.schedOn() ? 'none'
  : PhaseLogic.callWindow('today', null).error ? 'tomorrow' : 'today', hour: null });

// 「行けます」を押した結果の文（トークの入力欄の上に出す）。範囲のある募集は start = 到着の時刻・mins = 所要時間
async function ocAccept(phase, start, mins) {
  const r = await PhasesApi.acceptOpenCall(phase.id, start || null, mins || null);
  if (r && r.ok) {
    if (r.scheduled_at) return 'あなたが担当になりました（' + PhaseLogic.slotText({ start: r.scheduled_at, end: r.scheduled_end }) + '）'; // Task 60
    if (r.state === 'wish') return 'あなたが担当になりました。選んだ日時は希望として管理者に届きました（管理者が確定します）';
    if (r.state === 'conditions') return 'あなたが担当になりました。タスクの「日程候補を出す」から候補を出してください';
    if (r.state === 'confirmed') return 'あなたが担当になりました（日程も確定しました）';
    return 'あなたが担当になりました' + (phase.scheduled_at ? '（' + PhaseLogic.fmtMDWHM(phase.scheduled_at) + '〜）' : '');
  }
  if (r && r.reason === 'taken') return '決まりました（' + (r.worker_name || 'ほかの人') + 'が担当）。間に合いませんでした';
  if (r && r.reason === 'expired') return 'この募集は期限切れになりました（時間を過ぎました）'; // Task 60
  return 'この募集は終わりました（取り消されました）';
}

// Task 60: 募集の一覧（見た人・決まったか。DB の open_call_list）を少しの間使い回す
let ocListCache = null;
function ocList() {
  if (!ocListCache || Date.now() - ocListCache.at > 15000) {
    ocListCache = { at: Date.now(), promise: PhasesApi.openCallList().catch(e => { ocListCache = null; throw e; }) };
  }
  return ocListCache.promise;
}
const ocListInvalidate = () => { ocListCache = null; };

// Task 63: 募集の「いつ・どこ・詳細」（全体のトークのカードとタスクの詳細で共通）。p = 対応、c = 案件（case_summaries の行か open_call_cases の行）
//   いつ = 募集の日時の文（範囲があれば到着の範囲）／どこ = 物件名 号室・住所・「地図を開く」（Google マップ。CaseLogic.mapUrls）／
//   詳細 = 号室ごとの1行（RequestView.visitRows）＋依頼内容（RequestView.build の plain: 写真なし）。4行ほどで折りたたみ「続きを見る」
//   住所・依頼内容は DB（081）が募集中の間だけ返す
function ocInfoEl(p, c, idp) {
  const box = mk('div', 'oc-info');
  box.id = idp + '-info';
  const row = (k, label) => {
    const r = mk('div', 'oc-i-row');
    r.dataset.k = k;
    r.appendChild(mk('span', 'oc-i-k', label));
    const v = mk('div', 'oc-i-v');
    r.appendChild(v);
    box.appendChild(r);
    return v;
  };
  const range = PhaseLogic.callRangeText(p);
  row('when', 'いつ').textContent = PhaseLogic.callWhen(p) + (range ? '（' + range + ' に到着）' : '');
  const where = row('where', 'どこ');
  where.appendChild(mk('div', 'oc-i-place', PhaseLogic.placeName(c) || '（物件名なし）'));
  const map = CaseLogic.mapUrls(c.address);
  if (map) {
    where.appendChild(mk('div', 'oc-i-addr', c.address));
    const a = Icon.prepend(mk('a', 'oc-i-map', '地図を開く'), 'pin', 14);
    a.href = map.google;
    a.target = '_blank';
    a.rel = 'noopener';
    where.appendChild(a);
  } else where.appendChild(mk('div', 'oc-i-addr none', '住所の登録はありません'));
  const det = row('detail', '詳細');
  const body = mk('div', 'oc-i-body clamp');
  body.id = idp + '-detail';
  body.appendChild(RequestView.visitRows(p.plan, c, p.kind));
  const req = RequestView.build(c.request, { plain: true });
  if (req) body.appendChild(req);
  det.appendChild(body);
  const more = dBtn('続きを見る', 'rq-more oc-i-more', b => {
    const open = body.classList.toggle('clamp') === false;
    b.textContent = open ? '閉じる' : '続きを見る';
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  more.setAttribute('aria-expanded', 'false');
  more.setAttribute('aria-controls', body.id);
  more.hidden = true;
  det.appendChild(more);
  // 折りたたむのは収まらないときだけ（画面に出た後に高さを測る。測れない＝隠れているときは全部出す）
  requestAnimationFrame(() => {
    if (body.isConnected && body.scrollHeight > body.clientHeight + 1) more.hidden = false;
    else body.classList.remove('clamp');
  });
  return box;
}

// 全体のトークの募集のカード。x = TalkLogic の kind 'call'（phase, caseRow, state, takerName, takerId, mine）。o: { me, isOwner, onDone(text) }
function ocCardEl(x, o) {
  const p = x.phase || {};
  const box = mk('div', 'talk-cond oc-card' + (x.state === 'open' ? ' active' : ' done'));
  box.dataset.kind = 'call';
  box.dataset.id = x.id;
  box.dataset.phaseId = x.phaseId || '';
  box.dataset.state = x.state;
  box.appendChild(Icon.prepend(mk('b', 'talk-cond-h', '募集（早い者順）'), 'megaphone', 16));
  box.appendChild(mk('span', 'talk-at', (x.mine ? '' : x.fromName + '・') + PhaseLogic.fmtMDWHM(x.at)));
  const t = mk('div', 'oc-text', x.text);
  t.id = 'oc-text-' + x.id;
  box.appendChild(t);
  if (x.state === 'open' && x.caseRow) box.appendChild(ocInfoEl(p, x.caseRow, 'oc-' + x.id)); // Task 63: いつ・どこ・詳細
  const err = schErr();
  const done = async text => { ocListInvalidate(); o.onDone(text); };
  if (x.state === 'open' && x.mine) {
    // Task 60: 募集した本人にも同じボタン。様子（見た人）は DB の一覧から
    box.appendChild(mk('span', 'talk-cond-note oc-mine', 'あなたが出した募集です。まだ決まっていません（自分で行くときも下から押せます）'));
    const seen = mk('div', 'oc-seen', '見た人を確かめています…');
    box.appendChild(seen);
    ocList().then(list => {
      const hit = (list || []).find(y => y.phase_id === x.phaseId);
      const names = hit ? hit.seen || [] : [];
      seen.textContent = names.length ? '見た人: ' + names.join('・') : 'まだ誰も見ていません';
    }, () => { seen.textContent = ''; });
  }
  if (x.state === 'open') {
    const s = PhaseLogic.schedOpen(p);
    // Task 70: 日時のある募集を引き受ける前に、自分の同じ日の前後の予定との移動の時間を確かめる（前後に無ければ出さない）
    const travelOk = (start, end) => TravelUi.check({ workerId: o.me, phaseId: p.id, start, end, caseRow: x.caseRow, who: 'worker' });
    const go = (label, cls, start) => {
      const b = schBusyBtn(label, 'sch-btn oc-go ' + cls, err, async () => {
        if (p.scheduled_at && !(await travelOk(p.scheduled_at, p.scheduled_end))) return;
        await done(await ocAccept(p, start));
      });
      b.setAttribute('aria-describedby', t.id);
      if (start) b.dataset.start = start;
      return b;
    };
    // Task 53: 自分の確定した予定と重なる始まりは灰色（DB の phase_open_call_accept も同じ確認で止める）
    const busy = schBusyFor(o.me, p.id);
    if (p.open_call_from) {
      // Task 60: 範囲のある募集 = 所要時間と到着の時刻
      box.appendChild(mk('span', 'talk-cond-note', '到着の時刻を選んで「この時刻で行きます」を押してください。押した人が担当になり、日時も決まります'));
      let mins = PhaseLogic.callDur(p);
      const durSel = document.createElement('select');
      durSel.className = 'oc-dur';
      durSel.id = 'oc-dur-' + x.id;
      PhaseLogic.callDurChoices(mins).forEach(m => durSel.appendChild(new Option(PhaseLogic.durText({ mins: m }), String(m))));
      durSel.value = String(mins);
      const dl = mk('label', 'oc-dur-l', '所要時間');
      dl.htmlFor = durSel.id;
      const dr = mk('div', 'oc-dur-row');
      dr.append(dl, durSel);
      box.appendChild(dr);
      const holder = mk('div', 'oc-arrive-box');
      const draw = () => {
        const slot = PhaseLogic.callSlot(p);
        if (!slot) { holder.replaceChildren(mk('div', 'sch-full', '行ける時刻がありません（募集の時間を過ぎました）')); return; }
        holder.replaceChildren(schPickEl({ slot, dur: { mins }, busy, cls: 'oc-go oc-arrive', can: true, err,
          fullText: '行ける時刻がありません（' + PhaseLogic.fmtMDHM(p.open_call_to).split(' ')[1] + ' までに終わる時刻・空いている時刻がありません）',
          label: opt => 'この時刻で行きます（' + PhaseLogic.slotText(opt) + '）', onPick: async opt => {
            if (!(await travelOk(opt.start, opt.end))) return; // Task 70
            await done(await ocAccept(p, opt.start, mins));
          } }));
      };
      durSel.addEventListener('change', () => { mins = Number(durSel.value); draw(); });
      draw();
      box.appendChild(holder);
    } else if (s && s.state === 'candidates') {
      box.appendChild(mk('span', 'talk-cond-note', '行ける始まりを選んで押してください。押した人が担当になり、その日時は希望として管理者に届きます'));
      (s.cands || []).forEach(c => box.appendChild(schPickEl({ slot: c, dur: PhaseLogic.schedDur(p), busy, cls: 'oc-go oc-pick', can: true, err, fullText: '空きなし',
        label: opt => PhaseLogic.slotText(opt) + ' で行けます', onPick: async opt => { await done(await ocAccept(p, opt.start)); } })));
    } else {
      box.appendChild(mk('span', 'talk-cond-note', p.scheduled_at ? '押した人が担当になります（日時はこのまま決まりです）'
        : s && s.state === 'conditions' ? '押した人が担当になり、入居者の都合を見て日程の候補を出すタスクが付きます'
          : '押した人が担当になります（日時は管理者と決めます）'));
      const yes = go('行けます', 'oc-yes', null);
      box.appendChild(yes);
      if (p.scheduled_at) {
        busy.then(b => {
          const cl = PhaseLogic.clashOf(p.scheduled_at, p.scheduled_end, b);
          if (!cl || !yes.isConnected) return;
          yes.disabled = true;
          yes.after(mk('div', 'sch-full', '空きなし（' + PhaseLogic.clashText(cl) + '）'));
        }, () => {});
      }
    }
  } else if (x.state === 'expired') {
    // Task 60: 期限切れ → 募集した人・管理者は出し直せる（いつ来てほしいかを選び直す）
    const end = PhaseLogic.callEnd(p);
    box.appendChild(mk('div', 'oc-done oc-expired', 'この募集は期限切れになりました' + (end ? '（' + PhaseLogic.fmtMDWHM(end) + ' までに誰も行けませんでした）' : '')));
    if (x.mine || o.isOwner) {
      const v = ocWhenDefault(p);
      const area = mk('div', 'oc-repost');
      const open = dBtn('出し直す', 'btn sm ghost inline oc-repost-open', () => {
        area.replaceChildren(ocWhenEl(v, { idPrefix: 'oc-re-' + x.id, fixedText: p.scheduled_at ? '今の日時（' + PhaseLogic.schedText(p) + '）で募集します' : '日時は案件ページの対応の表「日時」で入れてから選んでください' }),
          schBusyBtn('もう一度募集する', 'sch-btn oc-repost-go', err, async () => { await PhasesApi.openCall(p.id, v.when, v.hour); await done('もう一度募集しました'); }));
      });
      area.appendChild(open);
      box.appendChild(area);
    }
  } else {
    const me = !!o.me && x.takerId === o.me;
    const when = x.state === 'taken' && p.scheduled_at ? ' ' + PhaseLogic.schedText(p) : ''; // Task 60: 決まった日時
    box.appendChild(mk('div', 'oc-done', x.state === 'taken' ? (me ? 'あなたが担当になりました' : '決まりました（' + x.takerName + 'が担当）') + when : 'この募集は終わりました'));
  }
  box.appendChild(err);
  return box;
}
