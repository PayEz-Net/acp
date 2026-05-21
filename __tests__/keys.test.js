import { jest } from '@jest/globals';
import { createApp } from '../api/server.js';
import { generateKey, normalizeKey, hashKey, looksLikeKey, ALPHABET } from '../api/keys/keyCodec.js';
import { RateLimiter } from '../api/keys/rateLimit.js';

let request;
let app;

const ADMIN_TOKEN = 'admin-test-token';
const LOCAL_SECRET = 'test-local-secret';
const PEPPER = 'test-pepper-must-be-long-and-random-in-prod';

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
    licenseKeyPepper: PEPPER,
    adminApiToken: ADMIN_TOKEN,
    acpLocalSecret: LOCAL_SECRET,
  });
});

beforeEach(() => {
  jest.restoreAllMocks();
});

// ── keyCodec unit tests ───────────────────────────────────────────────────

describe('keyCodec', () => {
  test('ALPHABET has 31 chars (not 30)', () => {
    expect(ALPHABET).toHaveLength(31);
    expect(new Set(ALPHABET).size).toBe(31);
  });

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

  test('hashKey is deterministic HMAC-SHA256', () => {
    const a = hashKey('ACPSLABCDEFGHJKMN', PEPPER);
    const b = hashKey('ACPSLABCDEFGHJKMN', PEPPER);
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  test('hashKey changes with different pepper', () => {
    const a = hashKey('ACPSLABCDEFGHJKMN', 'pepper-a');
    const b = hashKey('ACPSLABCDEFGHJKMN', 'pepper-b');
    expect(a).not.toBe(b);
  });

  test('looksLikeKey rejects bad formats', () => {
    expect(looksLikeKey('ACP-SL-ABCD-EFGH-JKMN')).toBe(true);
    expect(looksLikeKey('ACP-SL-ABCD-EFGH-JKZ0')).toBe(false); // contains 0
    expect(looksLikeKey('hello-world')).toBe(false);
    expect(looksLikeKey('')).toBe(false);
  });

  test('canonical pre-image: generator and validator agree', () => {
    const key = generateKey();
    const normalized = normalizeKey(key);
    expect(looksLikeKey(key)).toBe(true);
    expect(hashKey(normalized, PEPPER)).toBeTruthy();
  });
});

// ── RateLimiter unit tests ────────────────────────────────────────────────

describe('RateLimiter', () => {
  test('allows requests up to max', () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.check('1.2.3.4')).toBe(true);
    expect(limiter.check('1.2.3.4')).toBe(true);
    expect(limiter.check('1.2.3.4')).toBe(true);
    expect(limiter.check('1.2.3.4')).toBe(false);
  });

  test('resets after window', async () => {
    const limiter = new RateLimiter(1, 1);
    expect(limiter.check('1.2.3.4')).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(limiter.check('1.2.3.4')).toBe(true); // window expired
  });

  test('tracks per-ip', () => {
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.check('1.2.3.4')).toBe(true);
    expect(limiter.check('5.6.7.8')).toBe(true);
    expect(limiter.check('1.2.3.4')).toBe(false);
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

  test('active key → valid:true + cache contract', async () => {
    const key = 'ACP-SL-T7K9-M2VQ-8HJM';
    const normalized = normalizeKey(key);
    const keyHash = hashKey(normalized, PEPPER);
    const row = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      key_hash: keyHash,
      key_prefix: 'T7K9',
      hash_version: 'v1',
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
      if (callCount === 1) return mockVibeSqlResponse([row]);
      if (callCount === 2) return mockVibeSqlResponse([{ id: row.id }]);
      return mockVibeSqlResponse([]);
    });

    const res = await request(app).post('/v1/keys/validate').send({ key });
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(true);
    expect(res.body.data.keyId).toBe(row.id);
    expect(res.body.data.tier).toBe('free_year');
    expect(res.body.data.expiresAt).toBe(row.expires_at);
    expect(res.body.data.offlineJwt).toBeUndefined();
  });

  test('redeemed key → refresh allowed', async () => {
    const key = 'ACP-SL-T7K9-M2VQ-8HJM';
    const normalized = normalizeKey(key);
    const keyHash = hashKey(normalized, PEPPER);
    const row = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      key_hash: keyHash,
      key_prefix: 'T7K9',
      hash_version: 'v1',
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
  });

  test('expired redeemed key does NOT refresh (B8)', async () => {
    const key = 'ACP-SL-T7K9-M2VQ-8HJM';
    const normalized = normalizeKey(key);
    const keyHash = hashKey(normalized, PEPPER);
    const row = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      key_hash: keyHash,
      key_prefix: 'T7K9',
      hash_version: 'v1',
      tier: 'free_year',
      status: 'redeemed',
      redeemed_by: null,
      redeemed_at: '2026-05-21T10:00:00Z',
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

  test('revoked key → valid:false revoked', async () => {
    const key = 'ACP-SL-T7K9-M2VQ-8HJM';
    const normalized = normalizeKey(key);
    const keyHash = hashKey(normalized, PEPPER);
    const row = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      key_hash: keyHash,
      key_prefix: 'T7K9',
      hash_version: 'v1',
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

  test('expired active key → valid:false expired', async () => {
    const key = 'ACP-SL-T7K9-M2VQ-8HJM';
    const normalized = normalizeKey(key);
    const keyHash = hashKey(normalized, PEPPER);
    const row = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      key_hash: keyHash,
      key_prefix: 'T7K9',
      hash_version: 'v1',
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
  test('missing admin token → 401', async () => {
    const res = await request(app)
      .post('/v1/keys/550e8400-e29b-41d4-a716-446655440000/revoke')
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  test('wrong admin token → 401', async () => {
    const res = await request(app)
      .post('/v1/keys/550e8400-e29b-41d4-a716-446655440000/revoke')
      .set('Authorization', 'Bearer wrong')
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  test('invalid UUID → 400', async () => {
    const res = await request(app)
      .post('/v1/keys/not-a-uuid/revoke')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ reason: 'test' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('valid admin token + existing key → 200 revoked', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(mockVibeSqlResponse([{ id: '550e8400-e29b-41d4-a716-446655440000' }]));

    const res = await request(app)
      .post('/v1/keys/550e8400-e29b-41d4-a716-446655440000/revoke')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ reason: 'test' });

    expect(res.status).toBe(200);
    expect(res.body.data.revoked).toBe(true);
  });

  test('valid admin token + missing key → 404', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(mockVibeSqlResponse([]));

    const res = await request(app)
      .post('/v1/keys/550e8400-e29b-41d4-a716-446655440000/revoke')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ reason: 'test' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
