// js/supabase.js — ログインする社内アプリ（index.html）用の既定クライアント。接続先は js/supabase-config.js
// Task 61: ページが閉じるとき（pagehide）の保存は keepalive で送る（iPhone はページを閉じると普通の通信を切る。本文 64KB まで）
let sbLeaving = false;
addEventListener('pagehide', () => { sbLeaving = true; });
addEventListener('pageshow', () => { sbLeaving = false; });
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY,
  { global: { fetch: (u, o) => fetch(u, sbLeaving ? Object.assign({}, o, { keepalive: true }) : o) } });
