// js/supabase.js — ログインする社内アプリ（index.html）用の既定クライアント。接続先は js/supabase-config.js
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
