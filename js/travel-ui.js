// js/travel-ui.js — Task 70 の画面の部品（判定と文は js/travel-logic.js、Routes API は js/travel-api.js）
//   surveyEnd(st, en, kind, o) … 調査の終了予定の自動入力（DtInput 2つ）。開始の時刻が入って終了予定が空なら 開始＋N分（本人の設定）。
//                               自動で入れた値だけ開始に追従・手で直した値は触らない。種類が変わったら refresh()
//   workTimes(p, st, en)         … 原因元工事・復旧工事の日程を入れる欄: 最新の見積書の工事時間を、時刻の欄が空のときだけ入れる → 案内の文か ''
//   check(o) → Promise<boolean> … 引き受け・指名の前の「間に合うか」の確認（同じ日の直前・直後に予定が無ければ出さずに true）。
//                               シートは × と「やめる」でだけ閉じる（外側・Esc では閉じない）
//   surveyCard(o) / keyCard()    … 設定の「調査の終了予定（開始から）」（本人）・「移動時間の目安（Google のキー）」（管理者）
// ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。alert/confirm は使わない
const TravelUi = (() => {
  const el = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; };
  const btn = (t, cls, fn) => { const b = el('button', cls, t); b.type = 'button'; b.addEventListener('click', () => fn(b)); return b; };
  const msgOf = e => (e && e.message ? e.message : String(e));
  const myMins = () => TravelLogic.surveyMins(typeof ctx !== 'undefined' && ctx && ctx.membership ? ctx.membership.survey_end_mins : null);

  /* ---------- B. 調査の終了予定 ---------- */
  // o: { auto（前に自動で入れた値。画面を離れても残す下書き用）, onAuto(auto) }
  function surveyEnd(st, en, kind, o) {
    const x = o || {};
    let auto = x.auto || TravelLogic.initialAuto(kind(), st.get(), en.get(st.date.value), myMins());
    const run = () => {
      const cur = en.get(st.date.value);
      if (!cur && (en.date.value || en.time.value)) return; // 途中まで手で入れている
      const r = TravelLogic.autoEnd({ kind: kind(), start: st.get(), end: cur, auto, mins: myMins() });
      auto = r.auto;
      if (x.onAuto) x.onAuto(auto);
      if (r.end === cur) return;
      en.set(r.end);
      en.el.dispatchEvent(new Event('input', { bubbles: true })); // 下書き・重なりの確認をそろえる
    };
    st.el.addEventListener('input', run);
    return { refresh: run };
  }

  /* ---------- C. 見積書の工事時間 ---------- */
  function workTimes(p, st, en) {
    const t = TravelLogic.workTimes(p && p.kind, PhaseLogic.workConditions(p), { start: st.time.value, end: en.time.value });
    if (!t) return '';
    st.setHm(t.start);
    en.setHm(t.end);
    return t.note;
  }

  /* ---------- D. 間に合うかの確認 ---------- */
  // o: { workerId, phaseId, start, end, caseRow（この現場。一覧に無いとき）, who: 'worker'（引き受け）| 'admin'（指名・日時を決める） }
  async function check(o) {
    if (!o || !o.workerId || !o.start) return true;
    const rows = await (typeof schBusyRows === 'function' ? schBusyRows() : CasesApi.listSummaries().catch(() => []));
    const n = TravelLogic.neighbors(rows, o);
    const legs = TravelLogic.legs(n);
    if (!legs.length) return true; // 前後に予定が無い → 今までどおり
    return new Promise(resolve => sheet(n, legs, o, resolve));
  }
  function sheet(n, legs, o, resolve) {
    const prev = document.getElementById('tv-sheet');
    if (prev) prev.remove();
    const bg = el('div', 'lt-bg');
    bg.id = 'tv-sheet';
    const dlg = el('div', 'lt-sheet tv-sheet');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'tv-title');
    let open = true;
    const done = v => {
      if (!open) return;
      open = false;
      bg.remove();
      window.removeEventListener('hashchange', off);
      resolve(v);
    };
    const off = () => done(false);
    const hd = el('div', 'lt-hd');
    const h = Icon.prepend(el('h3', null, '移動の時間の確認'), 'clock', 18);
    h.id = 'tv-title';
    const x = btn('×', 'lt-x', () => done(false));
    x.id = 'tv-x';
    x.setAttribute('aria-label', '閉じる');
    hd.append(h, x);
    dlg.appendChild(hd);
    dlg.appendChild(el('div', 'lt-sub tv-here', 'この予定: ' + n.here.place + ' ' + PhaseLogic.slotText({ start: n.start, end: n.end })
      + (n.endGuessed ? '（終了予定が無いので1時間とみなします）' : '')));
    dlg.appendChild(el('div', 'lt-sub', '同じ日の前後に予定があります。移動の時間を確かめてから決めてください（車・渋滞を考えた Google の目安です）'));
    legs.forEach(leg => {
      const box = el('div', 'tv-leg');
      box.dataset.side = leg.side;
      box.appendChild(el('b', 'tv-k', leg.side === 'prev' ? '前の現場から' : '次の現場へ'));
      const text = el('div', 'tv-text');
      const late = el('div', 'tv-late');
      late.setAttribute('role', 'status');
      late.hidden = true;
      box.append(text, late);
      const paint = (r, state) => {
        const t = TravelLogic.legText(leg, r, state);
        text.textContent = t.text;
        late.replaceChildren();
        late.hidden = !t.note;
        if (t.note) late.appendChild(Icon.prepend(el('span', null, t.note), 'alert', 14));
        box.dataset.state = !TravelLogic.hasAddr(leg) ? 'noaddr' : t.late ? 'late' : r ? 'ok' : state;
      };
      if (!TravelLogic.hasAddr(leg)) paint(null, 'ok');
      else {
        const a = Icon.prepend(el('a', 'tv-map', 'Googleマップで経路を見る'), 'pin', 14);
        a.href = TravelLogic.mapUrl(leg.from.address, leg.to.address);
        a.target = '_blank';
        a.rel = 'noopener';
        box.appendChild(a);
        if (!TravelApi.hasKey()) paint(null, 'failed');
        else {
          paint(null, 'loading');
          TravelApi.duration(leg.from.address, leg.to.address, leg.depart).then(sec => {
            const r = TravelLogic.judge(leg, sec);
            paint(r, r ? 'ok' : 'failed');
          });
        }
      }
      dlg.appendChild(box);
    });
    const acts = el('div', 'lt-acts');
    const cancel = btn('やめる', 'lt-cancel', () => done(false));
    cancel.id = 'tv-cancel';
    const ok = btn(o.who === 'worker' ? '間に合うので行きます' : 'この日時で決める', 'lt-send', () => done(true));
    ok.id = 'tv-ok';
    acts.append(cancel, ok);
    dlg.appendChild(acts);
    bg.appendChild(dlg);
    document.body.appendChild(bg);
    window.addEventListener('hashchange', off);
    x.focus();
  }

  /* ---------- 設定 ---------- */
  // 調査の終了予定（開始から）: 本人の設定（memberships.survey_end_mins）。o.field = 現場用の設定のカード
  function surveyCard(o) {
    const field = !!(o && o.field);
    const card = el('div', field ? 'fd-card fd-set tv-card' : 'card tv-card');
    card.id = field ? 'fd-set-survey' : 'card-survey-end';
    card.appendChild(el(field ? 'b' : 'div', field ? null : 'card-ttl', '調査の終了予定（開始から）'));
    const box = el('div', field ? 'fd-set-f' : 'ff');
    const sel = document.createElement('select');
    sel.id = field ? 'fd-set-survey-mins' : 'set-survey-mins';
    TravelLogic.SURVEY_END_CHOICES.forEach(m => sel.appendChild(new Option(TravelLogic.minsText(m), String(m))));
    sel.value = String(myMins());
    const lb = el('label', null, '調査の開始を入れたとき、終了予定に入れる時間');
    lb.htmlFor = sel.id;
    box.append(lb, sel);
    card.appendChild(box);
    card.appendChild(el('span', field ? 'fd-tiny' : 'set-hint', 'あなただけの設定です（ほかの端末でも同じ）。入った終了予定は消したり直したりできます。現地確認・原因元工事・復旧工事・その他には入れません'));
    const st = el('div', 'gcal-st tv-st');
    st.setAttribute('role', 'status');
    card.appendChild(st);
    sel.addEventListener('change', async () => {
      const v = Number(sel.value);
      st.classList.remove('err');
      st.textContent = '保存しています…';
      sel.disabled = true;
      try {
        const row = await CasesApi.updateMe({ survey_end_mins: v });
        ctx.membership.survey_end_mins = row.survey_end_mins;
        st.textContent = '保存しました（' + TravelLogic.minsText(TravelLogic.surveyMins(row.survey_end_mins)) + '）';
      } catch (e) {
        sel.value = String(myMins());
        st.textContent = '保存できませんでした: ' + msgOf(e);
        st.classList.add('err');
      }
      sel.disabled = false;
    });
    return card;
  }

  // 移動時間の目安（Google Routes API のキー）: 会社共通（orgs.routes_api_key）。管理者だけに出す
  function keyCard() {
    const card = el('div', 'card tv-card');
    card.id = 'card-routes';
    card.appendChild(el('div', 'card-ttl', '移動時間の目安（Google）'));
    card.appendChild(el('p', 'set-hint', '一斉配信の引き受けや、担当者に日時を決めるときに、同じ日の前後の現場との移動の時間（車・Google の目安）を出します。会社で1つのキーです。キーが無いときは「Googleマップで経路を見る」のリンクだけ出します。'));
    const steps = el('ol', 'gcal-steps');
    ['Google Cloud（console.cloud.google.com）でプロジェクトを作り、「Routes API」を有効にする', '「認証情報」→「認証情報を作成」→「API キー」',
      'キーの制限: 「ウェブサイト（HTTP リファラー）」に https://sho0929h4-spec.github.io/* 、「API の制限」は Routes API だけ', 'できたキーを下に貼り付けて「保存する」'].forEach(t => steps.appendChild(el('li', null, t)));
    card.appendChild(steps);
    const now = el('div', 'tv-key-now');
    now.id = 'tv-key-now';
    card.appendChild(now);
    const lb = el('div', 'ff');
    const lab = el('label', null, 'API キー（貼り付け）');
    lab.htmlFor = 'tv-key';
    lb.appendChild(lab);
    const inp = document.createElement('input');
    inp.id = 'tv-key';
    inp.type = 'password';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.maxLength = 100;
    inp.placeholder = 'AIza…';
    lb.appendChild(inp);
    card.appendChild(lb);
    const st = el('div', 'gcal-st tv-st');
    st.id = 'tv-key-st';
    st.setAttribute('role', 'status');
    const act = el('div', 'gcal-act');
    const run = async (value, okText) => {
      st.classList.remove('err');
      if (value && !TravelLogic.keyOk(value)) { st.textContent = 'キーの形が違います（英数字と - _ だけ・20〜100文字）'; st.classList.add('err'); return; }
      const bs = Array.from(act.querySelectorAll('button'));
      bs.forEach(b => { b.disabled = true; });
      st.textContent = '保存しています…';
      try { await TravelApi.saveKey(value); inp.value = ''; st.textContent = okText; paint(); }
      catch (e) { st.textContent = '保存できませんでした: ' + msgOf(e); st.classList.add('err'); }
      bs.forEach(b => { b.disabled = false; });
    };
    const save = btn('保存する', 'btn sm inline tv-key-save', () => run(inp.value.trim(), '保存しました'));
    const clear = btn('キーを消す', 'btn sm ghost inline tv-key-clear', () => run('', 'キーを消しました（地図のリンクだけ出します）'));
    act.append(save, clear);
    card.append(act, st);
    const paint = () => {
      const k = ctx && ctx.org ? ctx.org.routes_api_key : '';
      now.textContent = k ? '設定済み（' + TravelLogic.maskKey(k) + '）' : '未設定（地図のリンクだけ出します）';
      clear.hidden = !k;
    };
    paint();
    return card;
  }

  return { surveyEnd, workTimes, check, surveyCard, keyCard };
})();
