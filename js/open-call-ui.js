// js/open-call-ui.js — 作業担当者の「一斉配信（早い者順）」（Task 51。DB は migration 070、判定は PhaseLogic.isOpenCall / callText・TalkLogic.callState）
//   ocModeEl … 作業担当者の決め方「特定の担当者を選ぶ」「一斉配信（早い者順）」の切り替え（管理者の対応の表・新規案件・現場用の案件登録で共通）
//   ocCardEl … 全体のトークの募集のカード。候補のある募集は候補ごとに「… で行けます」、それ以外は「行けます」。
//              一番早く押した人が担当（DB の phase_open_call_accept が担当者が空のときだけ入れる）。ほかの人は「決まりました（○○が担当）」
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

// 「行けます」を押した結果の文（トークの入力欄の上に出す）
async function ocAccept(phase, start) {
  const r = await PhasesApi.acceptOpenCall(phase.id, start || null);
  if (r && r.ok) {
    if (r.state === 'wish') return 'あなたが担当になりました。選んだ日時は希望として管理者に届きました（管理者が確定します）';
    if (r.state === 'conditions') return 'あなたが担当になりました。タスクの「日程候補を出す」から候補を出してください';
    if (r.state === 'confirmed') return 'あなたが担当になりました（日程も確定しました）';
    return 'あなたが担当になりました' + (phase.scheduled_at ? '（' + PhaseLogic.fmtMDWHM(phase.scheduled_at) + '〜）' : '');
  }
  if (r && r.reason === 'taken') return '決まりました（' + (r.worker_name || 'ほかの人') + 'が担当）。間に合いませんでした';
  return 'この募集は終わりました（取り消されました）';
}

// 全体のトークの募集のカード。x = TalkLogic の kind 'call'（phase, caseRow, state, takerName, takerId, mine）。o: { me, onDone(text) }
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
  const err = schErr();
  if (x.state === 'open' && x.mine) {
    box.appendChild(mk('span', 'talk-cond-note', 'あなたが出した募集です。まだ決まっていません'));
  } else if (x.state === 'open') {
    const s = PhaseLogic.schedOpen(p);
    const go = (label, cls, start) => {
      const b = schBusyBtn(label, 'sch-btn oc-go ' + cls, err, async () => { o.onDone(await ocAccept(p, start)); });
      b.setAttribute('aria-describedby', t.id);
      if (start) b.dataset.start = start;
      return b;
    };
    // Task 53: 自分の確定した予定と重なる始まりは灰色（DB の phase_open_call_accept も同じ確認で止める）
    const busy = schBusyFor(o.me, p.id);
    if (s && s.state === 'candidates') {
      box.appendChild(mk('span', 'talk-cond-note', '行ける始まりを選んで押してください。押した人が担当になり、その日時は希望として管理者に届きます'));
      (s.cands || []).forEach(c => box.appendChild(schPickEl({ slot: c, dur: PhaseLogic.schedDur(p), busy, cls: 'oc-go oc-pick', can: true, err, fullText: '空きなし',
        label: opt => PhaseLogic.slotText(opt) + ' で行けます', onPick: async opt => { o.onDone(await ocAccept(p, opt.start)); } })));
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
  } else {
    const me = !!o.me && x.takerId === o.me;
    box.appendChild(mk('div', 'oc-done', x.state === 'taken' ? (me ? 'あなたが担当になりました' : '決まりました（' + x.takerName + 'が担当）') : 'この募集は終わりました'));
  }
  box.appendChild(err);
  return box;
}
