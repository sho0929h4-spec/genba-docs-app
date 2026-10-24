// js/ask.js — 確認のポップアップ（confirm() の代わり。Task 54）。index.html と r.html で共有する。
//   askPopup(text, { title, okLabel, cancelLabel, danger, id }) → Promise<boolean>（OK = true、× と「キャンセル」= false）
//   見た目はアプリのシート（.modal-bg / .modal / .modal-x）。外側のクリックや Esc では閉じない（アプリ全体の決まり）。
//   前のポップアップが出ていれば false で閉じてから出す。文字は textContent（innerHTML は使わない）
function askPopup(text, opts) {
  const o = opts || {};
  const prev = document.getElementById('ask-pop');
  if (prev && prev._done) prev._done(false);
  return new Promise(resolve => {
    const el = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; };
    const btn = (cls, t) => { const b = el('button', cls, t); b.type = 'button'; return b; };
    const bg = el('div', 'modal-bg ask-pop-bg');
    bg.id = 'ask-pop';
    const dlg = el('div', 'modal ask-pop');
    if (o.id) dlg.id = o.id;
    dlg.setAttribute('role', 'alertdialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'ask-pop-title');
    dlg.setAttribute('aria-describedby', 'ask-pop-t');
    const hd = el('div', 'modal-hd');
    const h = el('h3', null, o.title || '確認');
    h.id = 'ask-pop-title';
    const x = btn('modal-x', '×');
    x.id = 'ask-pop-x';
    x.setAttribute('aria-label', '閉じる');
    hd.append(h, x);
    const t = el('p', 'ask-pop-t', text);
    t.id = 'ask-pop-t';
    const act = el('div', 'modal-act');
    const no = btn('btn ghost ask-pop-no', o.cancelLabel || 'キャンセル');
    const ok = btn('btn ask-pop-ok' + (o.danger ? ' red' : ''), o.okLabel || 'OK');
    act.append(no, ok);
    dlg.append(hd, t, act);
    bg.appendChild(dlg);
    const back = document.activeElement;
    const done = v => {
      bg._done = null;
      bg.remove();
      if (back && back.focus && back.isConnected) back.focus({ preventScroll: true });
      resolve(v);
    };
    bg._done = done;
    x.addEventListener('click', () => done(false));
    no.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    document.body.appendChild(bg);
    ok.focus({ preventScroll: true });
  });
}

// Task 61: 端末に残った「保存できていない入力」と、そのあと変わったサーバーの内容のどちらを使うか（見積書・報告書・工事掲示）。
//   true = 端末の入力を使う（サーバーの内容を置き換える）、false = 今の内容を使う（端末の入力は捨てる）。勝手には上書きしない
function askLocalDraft(what, t) {
  let when = '';
  try { if (Number(t)) when = '（' + new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(Number(t))) + ' の入力）'; }
  catch (e) { /* 時刻が出せなくても聞く */ }
  return askPopup('この端末に、まだ保存できていない' + what + 'の入力があります' + when + '。\nそのあと別の画面か別の端末で、この' + what + 'が更新されています。どちらを使いますか？\n「この端末の入力を使う」を選ぶと、今の内容をこの端末の入力で置き換えます。',
    { title: '保存できていない入力があります', okLabel: 'この端末の入力を使う', cancelLabel: '今の内容を使う', id: 'ask-draft' });
}
