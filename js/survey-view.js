// js/survey-view.js — 「調査の内容」の表示（読むだけ。Task 36）
//   現場用（作業担当者）で見積書の入力画面を開いたとき、上に折りたたみ欄（panel）を出し、その中の
//   「調査の内容ページを見る ›」で読み取り専用の調査の内容ページ（#f/case/{id}/phase/{調査}/survey/{見積}。js/field-ui.js）へ。
//   どの調査を出すか・要約の中身は PhaseLogic.estimateSurvey / surveySummary（純粋関数・テストあり）。
//   写真は署名URL（ReportsApi.photoUrl = AppStorage.getUrl）。印（赤丸・矢印・コメント）があれば重ねて描く（できなければ元の写真）。
//   拡大は RequestView.thumbs / openViewer（入力の無い拡大なので Esc・外側でも閉じる）。
//   ユーザー入力は createElement + textContent で描画する（innerHTML は使わない）。再編集・提出などの操作ボタンは出さない
const SurveyView = (() => {
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const btn = (text, cls, onClick) => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', () => onClick(b));
    return b;
  };
  const PANEL_THUMBS = 4; // 折りたたみ欄に出すサムネイルの数（ページでは全部）
  const EMPTY = 'まだ調査の報告書がありません';

  // 写真の URL（印があれば重ねた画像）。同じ写真は1回だけ作る
  const urlCache = new Map();
  function photoUrl(p) {
    const key = p.path + '|' + JSON.stringify(p.marks || null);
    if (!urlCache.has(key)) {
      const pr = Promise.resolve().then(() => ReportsApi.photoUrl(p.path)).then(u => {
        const marks = typeof PhotoMarks !== 'undefined' ? PhotoMarks.normalize(p.marks) : [];
        if (!u || !marks.length) return u;
        return PhotoMarks.compose(u, marks, { maxEdge: 1600, quality: 0.85 }).catch(() => u);
      });
      pr.catch(() => urlCache.delete(key)); // 失敗は覚えない
      urlCache.set(key, pr);
    }
    return urlCache.get(key);
  }
  function thumbs(photos) {
    // RequestView.thumbs は path で URL を引くので、印の違いも含めて写真ごとに URL を返す
    const byPath = new Map(photos.map(p => [p.path, p]));
    return RequestView.thumbs(photos, path => photoUrl(byPath.get(path) || { path }));
  }

  // 3行で折りたたむ文（「もっと見る」）
  function foldText(text) {
    const wrap = el('div', 'rq-fold');
    const t = el('div', 'rq-t', text);
    wrap.appendChild(t);
    if (text.split('\n').length > 3 || text.length > 90) {
      t.classList.add('clamp');
      const more = btn('もっと見る', 'rq-more', b => {
        const open = t.classList.toggle('clamp') === false;
        b.textContent = open ? '閉じる' : 'もっと見る';
        b.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      more.setAttribute('aria-expanded', 'false');
      wrap.appendChild(more);
    }
    return wrap;
  }
  const row = (key, label, child) => {
    const r = el('div', 'sv-row');
    r.dataset.key = key;
    r.appendChild(el('div', 'rq-k', label));
    r.appendChild(child);
    return r;
  };

  // 要約の中身（欄とページで共通）。full = ページ（写真すべて・漏水の状況など）
  function body(sum, full) {
    const out = [];
    const head = el('div', 'sv-head');
    head.appendChild(el('b', null, sum.title));
    if (sum.date) head.appendChild(el('span', 'sv-date', sum.date));
    out.push(head);
    // 号室ごとの結果（原因・被害箇所）
    if (sum.rooms.length) {
      const box = el('div', 'sv-rooms');
      sum.rooms.forEach(r => {
        const it = el('div', 'sv-room');
        const h = el('div', 'sv-room-h');
        h.appendChild(el('b', null, r.name));
        if (r.roleText) {
          h.appendChild(document.createTextNode(' '));
          h.appendChild(el('span', 'rm-tag ' + (r.role || 'other'), r.roleText));
        }
        it.appendChild(h);
        if (r.cause) it.appendChild(el('div', 'sv-room-t', '原因: ' + r.cause));
        if (r.damage) it.appendChild(el('div', 'sv-room-t', '被害箇所: ' + r.damage));
        box.appendChild(it);
      });
      out.push(row('rooms', '号室ごとの結果', box));
    }
    if (sum.reason) out.push(row('reason', '原因と判断した理由', full ? el('div', 'rq-t', sum.reason) : foldText(sum.reason)));
    if (sum.workItems.length || sum.workText) {
      const w = el('div', 'sv-work');
      if (sum.workItems.length) {
        const chips = el('div', 'rq-chips');
        sum.workItems.forEach(x => chips.appendChild(el('span', 'sv-chip', x)));
        w.appendChild(chips);
      }
      if (sum.workText) w.appendChild(full ? el('div', 'rq-t', sum.workText) : foldText(sum.workText));
      out.push(row('work', '作業内容', w));
    }
    if (full) sum.extras.forEach(x => out.push(row('extra', x.label, el('div', 'rq-t', x.value))));
    if (sum.next || sum.due) {
      const n = el('div', 'sv-next');
      if (sum.next) n.appendChild(el('div', 'rq-t', sum.next));
      if (sum.due) n.appendChild(el('div', 'sv-due', sum.due));
      out.push(row('next', '次の対応方針', n));
    }
    if (sum.photos.length) {
      const list = full ? sum.photos : sum.photos.slice(0, PANEL_THUMBS);
      const p = el('div', 'sv-photos');
      p.appendChild(thumbs(list));
      if (!full && sum.photos.length > list.length) p.appendChild(el('div', 'sv-more', 'ほか ' + (sum.photos.length - list.length) + '枚は調査の内容ページで見られます'));
      out.push(row('photos', '写真（' + sum.photos.length + '枚・押すと拡大）', p));
    }
    if (out.length === 1) out.push(el('div', 'sv-none', '報告書に調査の結果の記入がありません'));
    return out;
  }

  // 見積書の入力画面の折りたたみ欄
  //   o: { src（PhaseLogic.estimateSurvey）, estPhase, err（読み込みの失敗）, open, onToggle(open), onPage() }
  function panel(o) {
    const box = el('section', 'sv-panel' + (o.open ? ' open' : ''));
    box.id = 'eu-survey';
    const tg = btn('', 'sv-toggle', () => {
      const open = !box.classList.contains('open');
      box.classList.toggle('open', open);
      tg.setAttribute('aria-expanded', open ? 'true' : 'false');
      st.textContent = open ? '閉じる ▲' : '開く ▼';
      bd.hidden = !open;
      if (o.onToggle) o.onToggle(open);
    });
    tg.id = 'eu-survey-toggle';
    tg.setAttribute('aria-controls', 'eu-survey-body');
    tg.setAttribute('aria-expanded', o.open ? 'true' : 'false');
    tg.appendChild(el('b', null, '🔎 調査の内容'));
    const st = el('span', 'sv-state', o.open ? '閉じる ▲' : '開く ▼');
    tg.appendChild(st);
    const bd = el('div', 'sv-body');
    bd.id = 'eu-survey-body';
    bd.hidden = !o.open;
    if (o.err) {
      const e = el('div', 'err', '調査の内容を読み込めませんでした: ' + o.err);
      e.id = 'eu-survey-err';
      bd.appendChild(e);
    } else if (!o.src || !o.src.report) {
      const e = el('div', 'sv-none', EMPTY);
      e.id = 'eu-survey-empty';
      bd.appendChild(e);
    } else {
      bd.append(...body(PhaseLogic.surveySummary(o.src, o.estPhase), false));
      const go = btn('調査の内容ページを見る ›', 'btn ghost sv-go', () => o.onPage());
      go.id = 'eu-survey-page';
      bd.appendChild(go);
    }
    box.append(tg, bd);
    return box;
  }

  // 調査の内容ページの中身（依頼内容 → 調査の結果）。o: { caseRow, src, estPhase }
  function page(o) {
    const c = o.caseRow, src = o.src;
    const nodes = [];
    const req = el('div', 'fd-req');
    req.id = 'sv-request';
    req.appendChild(el('b', 'rq-title', '📋 依頼内容'));
    if (src.phase) req.appendChild(RequestView.visitRows(src.phase.plan, c, 'survey', { id: 'sv-visit-rows' }));
    const rv = RequestView.build(c.request, { photoUrl: x => CasesApi.requestPhotoUrl(x) });
    if (rv) req.appendChild(rv);
    else req.appendChild(el('div', 'fd-req-empty', '依頼内容の文・写真はまだ登録されていません'));
    nodes.push(req);
    const res = el('div', 'fd-req sv-page');
    res.id = 'sv-result';
    res.appendChild(el('b', 'rq-title', '🔎 調査の内容'));
    if (!src.report) {
      const e = el('div', 'sv-none', EMPTY);
      e.id = 'sv-empty';
      res.appendChild(e);
    } else res.append(...body(PhaseLogic.surveySummary(src, o.estPhase), true));
    nodes.push(res);
    return nodes;
  }

  return { panel, page, EMPTY, PANEL_THUMBS };
})();
