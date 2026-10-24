// js/features.js — 機能スイッチ（Task 58）。index.html・r.html で一番先に読み込む。ここだけ変えれば切り替わる
//   schedule … 日程調整（候補を出す・入居者の都合・希望・確定のやり取り・カレンダーの「候補」・日程調整のタスクとトークのカード）。
//              main（公開版）は false = 日時は手で入れるだけ（開始と終わり。終わりは任意）。ブランチ schedule で true にする
//   E2E は読み込む前に window.FEATURES を入れると上書きできる（page.evaluateOnNewDocument）
var FEATURES = window.FEATURES || { schedule: false };
