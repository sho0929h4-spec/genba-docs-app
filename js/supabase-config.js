// js/supabase-config.js — Supabase の接続先（公開してよい値だけ: プロジェクトURL と anon キー）
// index.html は supabase-config.js → supabase.js（ログイン用の既定クライアント sb を作る）の順に読む。
// 協力業者ページ r.html はこのファイルだけを読み、既定の sb は作らない（js/vendor.js がセッションなしのクライアントを作る）。
const SUPABASE_URL = 'https://kkglrmogktnhedkcgyid.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtrZ2xybW9na3RuaGVka2NneWlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwOTI3NTQsImV4cCI6MjEwNzY2ODc1NH0.j9L7f848-e-NCbI9p7hvOMa8H76uV7OaC7IvC644yjs';
