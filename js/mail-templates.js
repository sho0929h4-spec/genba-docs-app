// js/mail-templates.js — 連絡メールの定型文（ブラウザ: window.MailTemplates / node: module.exports）
// 対応フェーズ Task 9: 入居者あての調査日の連絡メール（purpose schedule・調査）の本文。宛名の下に入る（宛名・署名は PhaseLogic が付ける）。
// 元請・物件オーナーあてには入れない（今の短い形）。工事日の入居者あては当面今の形（定型文なし）。
// 将来 ②工事前（原因元工事・復旧工事の入居者あて）などを足すときは RESIDENT_SCHEDULE に kind のキーで足す（repair: [...] など）。
// 差し込み: {名乗り}（「{会社名}の{担当者名}と申します。」）・{日時}（「2026年10月20日（火） 9:00〜」）。行の配列で持つ（'' は空行）
(function (root) {
  const RESIDENT_SCHEDULE = {
    // ① 調査前（入居者様あて）
    survey: [
      'お世話になっております。',
      '{名乗り}',
      '',
      '現地確認日時',
      '{日時}',
      '',
      '現地確認の内容については、水回りを調べさせていただきますので、キッチン、トイレ、浴室、洗面所、洗濯機、給湯器のあたりを確認する予定です。',
      '見た目は問題なくとも床下などの隠蔽部分で漏水が発生している可能性がございますので、設備に異常がないかを確認させていただきます。',
      '該当箇所の荷物を整理していただけますとスムーズに現地確認が対応可能です。',
      '',
      '所要時間はすぐに見つかれば1時間程度で終わりますが、原因がなかなか見つからない場合は、順番に水回りを確認させていただきますので2~3時間かかる可能性もございます。',
      '',
      '当日はよろしくお願いいたします。'
    ]
  };

  // kind（survey / cause / repair）の入居者あて定型文（行の配列）。無ければ null（今の短い形を使う）
  function residentSchedule(kind) {
    const t = RESIDENT_SCHEDULE[kind];
    return Array.isArray(t) ? t.slice() : null;
  }
  // 差し込み（{キー} を vars の値に）。値が空の差し込みだけの行は消す
  function fill(lines, vars) {
    const v = vars || {};
    const out = [];
    for (const l of lines || []) {
      const only = /^\{[^}]+\}$/.test(l);
      const s = String(l).replace(/\{([^}]+)\}/g, (_, k) => (v[k] == null ? '' : String(v[k])));
      if (only && !s) continue;
      out.push(s);
    }
    return out;
  }

  const api = { RESIDENT_SCHEDULE, residentSchedule, fill };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MailTemplates = api;
})(typeof window !== 'undefined' ? window : globalThis);
