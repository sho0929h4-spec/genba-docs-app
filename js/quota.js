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

async function addUsage(bytes, records = 0) {
  const { error } = await sb.rpc('add_usage', { p_bytes: bytes, p_records: records });
  if (error) throw error;
}
