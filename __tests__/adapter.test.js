import { createStorageAdapter } from '../storage/adapter.js';
import { VibeSqlClient } from '../storage/vibesql_client.js';
import { VibeApiClient } from '../storage/vibe_api_client.js';

describe('createStorageAdapter', () => {
  test('returns VibeSqlClient for physical mode', () => {
    const adapter = createStorageAdapter({ storageMode: 'physical', vibesqlUrl: 'http://localhost:5173' });
    expect(adapter).toBeInstanceOf(VibeSqlClient);
  });

  test('returns VibeApiClient for virtual mode', () => {
    const adapter = createStorageAdapter({
      storageMode: 'virtual',
      vibeApiUrl: 'http://localhost:32786',
      vibeAuthMode: 'hmac',
      vibeSigningKey: Buffer.from('test').toString('base64'),
      vibeClientId: 1,
    });
    expect(adapter).toBeInstanceOf(VibeApiClient);
  });

  test('defaults to physical mode', () => {
    const adapter = createStorageAdapter({ vibesqlUrl: 'http://localhost:5173' });
    expect(adapter).toBeInstanceOf(VibeSqlClient);
  });
});
