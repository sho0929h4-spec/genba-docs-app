// js/travel-api.js — Task 70: 移動の目安（Google Routes API の computeRoutes をブラウザから）と会社のキーの保存（orgs.routes_api_key・migration 086）
//   duration(origin, dest, depart) → 車の秒数か null（キー無し・住所なし・失敗）。同じ組み合わせ（住所2つ・出発時刻）はこの画面の間は覚える
//   キーは ctx.org.routes_api_key（ログインのとき orgs(*) で読む。同じ会社の人だけ読める）。キーはログにも画面にも出さない（表示は TravelLogic.maskKey）
//   E2E は tests/e2e/fake-sb.js が routes.googleapis.com への fetch を横取りする（本物の Google にはつながない）
const TravelApi = (() => {
  const URL_ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';
  const cache = new Map();
  const key = () => (typeof ctx !== 'undefined' && ctx && ctx.org && ctx.org.routes_api_key) || '';
  async function call(origin, dest, depart) {
    const res = await fetch(URL_ROUTES, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key(), 'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters' },
      body: JSON.stringify(TravelLogic.routeBody(origin, dest, depart, new Date().toISOString()))
    });
    if (!res.ok) throw new Error('Routes API ' + res.status); // 本文にキーが入ることは無いが、念のため状態の番号だけ
    return TravelLogic.routeSeconds(await res.json());
  }
  function duration(origin, dest, depart) {
    if (!key() || !String(origin || '').trim() || !String(dest || '').trim()) return Promise.resolve(null);
    const k = [origin, dest, depart].join('|');
    if (!cache.has(k)) {
      cache.set(k, call(origin, dest, depart).catch(e => {
        cache.delete(k); // 失敗は覚えない（次に開いたときにもう一度）
        console.warn('移動の目安を出せませんでした', e && e.message);
        return null;
      }));
    }
    return cache.get(k);
  }
  // 管理者: キーを保存（空 = 消す）→ ctx.org を同じ値に
  async function saveKey(value) {
    const v = String(value || '').trim() || null;
    const { data, error } = await sb.from('orgs').update({ routes_api_key: v }).eq('id', ctx.org.id).select('routes_api_key');
    if (error) throw error;
    if (!data || !data.length) throw new Error('保存できませんでした（管理者だけが入れられます）');
    ctx.org.routes_api_key = data[0].routes_api_key || null;
    cache.clear();
    return ctx.org.routes_api_key;
  }
  return { duration, saveKey, hasKey: () => !!key() };
})();
