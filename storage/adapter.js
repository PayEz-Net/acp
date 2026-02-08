import { VibeSqlClient } from './vibesql_client.js';
import { VibeApiClient } from './vibe_api_client.js';

export function createStorageAdapter(cfg) {
  if (cfg.storageMode === 'virtual') {
    return new VibeApiClient(cfg);
  }
  return new VibeSqlClient(cfg);
}
