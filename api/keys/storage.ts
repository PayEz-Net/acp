import { config } from '../../config.js';

const VIBESQL_URL = config.vibesqlUrl || process.env.VIBESQL_URL || 'http://10.0.0.93:52411';
const VIBESQL_SECRET = config.vibesqlContainerSecret || process.env.VIBESQL_SECRET || 'ContainersSuperDevSecret';

function escapeSql(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'NULL';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return "'" + String(value).replace(/'/g, "''") + "'";
}

async function queryVibeSql(sql: string): Promise<any> {
  const res = await fetch(`${VIBESQL_URL}/v1/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Secret ${VIBESQL_SECRET}`,
    },
    body: JSON.stringify({ sql }),
  });
  return res.json().catch(() => ({ success: false }));
}

export interface LicenseKeyRow {
  id: string;
  key_hash: string;
  key_prefix: string;
  tier: string;
  status: 'active' | 'redeemed' | 'revoked' | 'expired';
  redeemed_by: string | null;
  redeemed_at: string | null;
  expires_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  created_at: string;
}

export async function findKeyByHash(keyHash: string): Promise<LicenseKeyRow | null> {
  const sql = `SELECT * FROM vibe.license_keys WHERE key_hash = ${escapeSql(keyHash)} LIMIT 1`;
  const result = await queryVibeSql(sql);
  if (!result.success || !Array.isArray(result.data) || result.data.length === 0) return null;
  return result.data[0] as LicenseKeyRow;
}

export async function redeemKey(id: string): Promise<boolean> {
  const sql = `UPDATE vibe.license_keys SET status = 'redeemed', redeemed_at = NOW() WHERE id = ${escapeSql(id)} AND status = 'active' RETURNING id`;
  const result = await queryVibeSql(sql);
  return result.success && Array.isArray(result.data) && result.data.length > 0;
}

export async function revokeKey(id: string, reason: string): Promise<boolean> {
  const sql = `UPDATE vibe.license_keys SET status = 'revoked', revoked_at = NOW(), revoke_reason = ${escapeSql(reason)} WHERE id = ${escapeSql(id)} AND status != 'revoked' RETURNING id`;
  const result = await queryVibeSql(sql);
  return result.success && Array.isArray(result.data) && result.data.length > 0;
}

export async function insertKeys(rows: Array<{ key_hash: string; key_prefix: string; expires_at: string }>): Promise<number> {
  if (rows.length === 0) return 0;
  const values = rows
    .map((r) => `(${escapeSql(r.key_hash)}, ${escapeSql(r.key_prefix)}, ${escapeSql(r.expires_at)})`)
    .join(', ');
  const sql = `INSERT INTO vibe.license_keys (key_hash, key_prefix, expires_at) VALUES ${values} ON CONFLICT (key_hash) DO NOTHING RETURNING id`;
  const result = await queryVibeSql(sql);
  if (!result.success) {
    throw new Error(result.error?.message || 'VibeSQL insert failed');
  }
  return Array.isArray(result.data) ? result.data.length : 0;
}
