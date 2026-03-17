import { VibeSqlClient } from './vibesql_client.js';

export function createStorageAdapter(cfg) {
  return new VibeSqlClient(cfg);
}
