// js/quota.js
const GB = 1024 ** 3;
const PLAN_LIMITS = {
  free:       { bytes: 1 * GB,   records: 3,        accounts: 1,        label: '無料' },
  entry:      { bytes: 100 * GB, records: Infinity, accounts: 10,       label: 'エントリー' },
  standard:   { bytes: 500 * GB, records: Infinity, accounts: 20,       label: 'スタンダード' },
  enterprise: { bytes: Infinity, records: Infinity, accounts: Infinity, label: 'エンタープライズ' }
};

async function checkQuota(addBytes, addRecords = 0) {
  const { data: u, error } = await sb.from('org_usage').select('*').eq('org_id', ctx.org.id).single();
  if (error) throw error;
  const lim = PLAN_LIMITS[ctx.org.plan] || PLAN_LIMITS.free;
  if (u.storage_bytes + addBytes > lim.bytes)
    return { ok: false, reason: `容量の上限（${lim.bytes / GB}GB）に達しています` };
  if (u.record_count + addRecords > lim.records)
    return { ok: false, reason: `保存件数の上限（${lim.records}件）に達しています` };
  return { ok: true };
}

// add_usage は 1回 ±100MB まで（migration 015）。超える分は同じ符号で分割して呼ぶ（大量の添付をまとめて追加・削除したとき）
const USAGE_STEP = 100 * 1024 * 1024;
async function addUsage(bytes, records = 0) {
  let rest = Math.round(Number(bytes) || 0);
  do {
    const step = Math.sign(rest) * Math.min(Math.abs(rest), USAGE_STEP);
    const { error } = await sb.rpc('add_usage', { p_bytes: step, p_records: records });
    if (error) throw error;
    rest -= step;
  } while (rest !== 0);
}
