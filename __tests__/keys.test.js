import { jest } from '@jest/globals';
import { createApp } from '../api/server.js';
import { generateKey, normalizeKey, hashKey, looksLikeKey } from '../api/keys/keyCodec.js';
import { mintLicenseJwt, verifyLicenseJwt } from '../api/keys/keyJwt.js';

let request;
let app;

const TEST_SECRET = 'test-secret-must-be-at-least-32-bytes-long';
const ADMIN_TOKEN = 'admin-test-token';
const LOCAL_SECRET = 'test-local-secret';

beforeAll(async () => {
  const supertest = await import('supertest');
  request = supertest.default;
  app = await createApp({
    vibesqlUrl: 'http://localhost:0',
    vibeApiUrl: 'http://localhost:0',
    vibeClientId: 1,
    vibeTokenCmd: 'echo {}',
    vibeTokenRefreshS: 300,
    vibeAuthMode: 'bearer',
    vibeSigningKey: '',
    execTimeoutMs: 5000,
    nodeEnv: 'test',
    logLevel: 'error',
    corsOrigins: '*',
    partyTickMs: 999999,
    autonomyMaxRuntimeHours: 4,
    escalationSensitivity: 2,
    port: 0,
    licenseJwtSecret: TEST_SECRET,
    adminApiToken: ADMIN_TOKEN,
    acpLocalSecret: LOCAL_SECRET,
  });
});

beforeEach(() => {
  jest.restoreAllMocks();
});

// ── keyCodec unit tests ───────────────────────────────────────────────────

describe('keyCodec', () => {
  test('generateKey produces canonical format', () => {
    const key = generateKey();
    expect(key).toMatch(/^ACP-SL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const body = key.replace(/^ACP-SL-/, '').replace(/-/g, '');
    expect(body).not.toContain('O');
    expect(body).not.toContain('0');
    expect(body).not.toContain('I');
    expect(body).not.toContain('1');
    expect(body).not.toContain('L');
  });

  test('normalizeKey strips hyphens and whitespace', () => {
    expect(normalizeKey('ACP-SL-ABCD-EFGH-JKMN')).toBe('ACPSLABCDEFGHJKMN');
    expect(normalizeKey('acp-sl-abcd-efgh-jkmn')).toBe('ACPSLABCDEFGHJKMN');
    expect(normalizeKey('ACP SL ABCD EFGH JKMN')).toBe('ACPSLABCDEFGHJKMN');
  });

  test('hashKey is deterministic SHA-256', () => {
    const a = hashKey('ACPSLABCDEFGHIJKM');
    const b = hashKey('ACPSLABCDEFGHIJKM');
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  test('looksLikeKey rejects bad formats', () => {
    expect(looksLikeKey('ACP-SL-ABCD-EFGH-JKMN')).toBe(true);
    expect(looksLikeKey('ACP-SL-ABCD-EFGH-JKZ0')).toBe(false); // contains 0
    expect(looksLikeKey('hello-world')).toBe(false);
    expect(looksLikeKey('')).toBe(false);
  });
});

// ── keyJwt unit tests ─────────────────────────────────────────────────────

describe('keyJwt', () => {
  test('mint + verify round-trip', () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = mintLicenseJwt({ sub: 'key-1', tier: 'free_year', iat: now, exp: now + 1000 }, TEST_SECRET);
    expect(typeof jwt).toBe('string');
    expect(jwt.split('.')).toHaveLength(3);

    const payload = verifyLicenseJwt(jwt, TEST_SECRET);
    expect(payload).toEqual({ sub: 'key-1', tier: 'free_year', iat: now, exp: now + 1000 });
  });

  test('verify rejects expired JWT', () => {
    const jwt = mintLicenseJwt({ sub: 'key-1', tier: 'free_year', iat: 1000, exp: 1001 }, TEST_SECRET);
    const payload = verifyLicenseJwt(jwt, TEST_SECRET);
    expect(payload).toBeNull();
  });

  test('verify rejects tampered signature', () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = mintLicenseJwt({ sub: 'key-1', tier: 'free_year', iat: now, exp: now + 1000 }, TEST_SECRET);
    const tampered = jwt.slice(0, -5) + 'XXXXX';
    expect(verifyLicenseJwt(tampered, TEST_SECRET)).toBeNull();
  });

  test('verify rejects wrong secret', () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = mintLicenseJwt({ sub: 'key-1', tier: 'free_year', iat: now, exp: now + 1000 }, TEST_SECRET);
    expect(verifyLicenseJwt(jwt, 'wrong-secret')).toBeNull();
  });
});

// ── Route integration tests ───────────────────────────────────────────────

function mockVibeSqlResponse(data, success = true) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success, data }),
    text: async () => JSON.stringify({ success, data }),
  };
}

function mockVibeSqlError(message) {
  return {
    ok: false,
    status: 500,
    json: async () => ({ success: false, error: { message } }),
    text: async () => JSON.stringify({ success: false, error: { message } }),
  };
}

describe('POST /v1/keys/validate', () => {
  test('missing key → 400', async () => {
    const res = await request(app).post('/v1/keys/validate').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('invalid key format → 400', async () => {
    const res = await request(app).post('/v1/keys/validate').send({ key: 'hello-world' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('unknown key → valid:false invalid', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(mockVibeSqlResponse([]));
    const res = await request(app).post('/v1/keys/validate').send({ key: 'ACP-SL-ABCD-EFGH-JKMN' });
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(false);
    expect(res.body.data.error).toBe('invalid');
  });

  test('active key → valid:true + JWT', async () => {
    const key = 'ACP-SL-T7K9-M2VQ-8HJM';
    const normalized = normalizeKey(key);
    const keyHash = hashKey(normalized);
    const row = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      key_hash: keyHash,
      key_prefix: 'T7K9',
      tier: 'free_year',
      status: 'active',
      redeemed_by: null,
      redeemed_at: null,
      expires_at: '2027-05-21T00:00:00Z',
      revoked_at: null,
      revoke_reason: null,
      created_at: '2026-05-21T00:00:00Z',
    };

    let callCount = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return mockVibeSqlResponse([row]); // SELECT
      if (callCount === 2) return mockVibeSqlResponse([{ id: row.id }]); // UPDATE
      return mockVibeSqlResponse([]);
    });

    const res = await request(app).post('/v1/keys/validate').send({ key });
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(true);
    expect(res.body.data.keyId).toBe(row.id);
    expect(res.body.data.tier).toBe('free_year');
    expect(res.body.data.offlineJwt).toBeTruthy();

    const payload = verifyLicenseJwt(res.body.data.offlineJwt, TEST_SECRET);
    expect(payload).not.toBeNull();
    expect(payload.sub).toBe(row.id);
  });

  test('redeemed key → refresh JWT (no already_redeemed)', async () => {
    const key = 'ACP-SL-T7K9-M2VQ-8HJM';
    const normalized = normalizeKey(key);
    const keyHash = hashKey(normalized);
    const row = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      key_hash: keyHash,
      key_prefix: 'T7K9',
      tier: 'free_year',
      status: 'redeemed',
      redeemed_by: null,
      redeemed_at: '2026-05-21T10:00:00Z',
      expires_at: '2027-05-21T00:00:00Z',
      revoked_at: null,
      revoke_reason: null,
      created_at: '2026-05-21T00:00:00Z',
    };

    jest.spyOn(global, 'fetch').mockResolvedValue(mockVibeSqlResponse([row]));

    const res = await request(app).post('/v1/keys/validate').send({ key });
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(true);
    expect(res.body.data.offlineJwt).toBeTruthy();
  });

  test('revoked key → valid:false revoked', async () => {
    const key = 'ACP-SL-T7K9-M2VQ-8HJM';
    const normalized = normalizeKey(key);
    const keyHash = hashKey(normalized);
    const row = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      key_hash: keyHash,
      key_prefix: 'T7K9',
      tier: 'free_year',
      status: 'revoked',
      redeemed_by: null,
      redeemed_at: null,
      expires_at: '2027-05-21T00:00:00Z',
      revoked_at: '2026-05-21T10:00:00Z',
      revoke_reason: 'misuse',
      created_at: '2026-05-21T00:00:00Z',
    };

    jest.spyOn(global, 'fetch').mockResolvedValue(mockVibeSqlResponse([row]));

    const res = await request(app).post('/v1/keys/validate').send({ key });
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(false);
    expect(res.body.data.error).toBe('revoked');
  });

  test('expired key → valid:false expired', async () => {
    const key = 'ACP-SL-T7K9-M2VQ-8HJM';
    const normalized = normalizeKey(key);
    const keyHash = hashKey(normalized);
    const row = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      key_hash: keyHash,
      key_prefix: 'T7K9',
      tier: 'free_year',
      status: 'active',
      redeemed_by: null,
      redeemed_at: null,
      expires_at: '2025-01-01T00:00:00Z',
      revoked_at: null,
      revoke_reason: null,
      created_at: '2024-01-01T00:00:00Z',
    };

    jest.spyOn(global, 'fetch').mockResolvedValue(mockVibeSqlResponse([row]));

    const res = await request(app).post('/v1/keys/validate').send({ key });
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(false);
    expect(res.body.data.error).toBe('expired');
  });
});

describe('POST /v1/keys/:id/revoke', () => {
  test('missing admin token → 403', async () => {
    const res = await request(app)
      .post('/v1/keys/550e8400-e29b-41d4-a716-446655440000/revoke')
      .set('Authorization', `Bearer ${LOCAL_SECRET}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('wrong admin token → 403', async () => {
    const res = await request(app)
      .post('/v1/keys/550e8400-e29b-41d4-a716-446655440000/revoke')
      .set('Authorization', `Bearer ${LOCAL_SECRET}`)
      .set('X-Admin-Token', 'wrong')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('valid admin token + existing key → 200 revoked', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(mockVibeSqlResponse([{ id: '550e8400-e29b-41d4-a716-446655440000' }]));

    const res = await request(app)
      .post('/v1/keys/550e8400-e29b-41d4-a716-446655440000/revoke')
      .set('Authorization', `Bearer ${LOCAL_SECRET}`)
      .set('X-Admin-Token', ADMIN_TOKEN)
      .send({ reason: 'test' });

    expect(res.status).toBe(200);
    expect(res.body.data.revoked).toBe(true);
  });

  test('valid admin token + missing key → 404', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(mockVibeSqlResponse([]));

    const res = await request(app)
      .post('/v1/keys/550e8400-e29b-41d4-a716-446655440000/revoke')
      .set('Authorization', `Bearer ${LOCAL_SECRET}`)
      .set('X-Admin-Token', ADMIN_TOKEN)
      .send({ reason: 'test' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
