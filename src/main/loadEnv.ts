/**
 * Runtime .env loader for the main process (side-effect import).
 *
 * The renderer never reads env files; it consumes env values through the
 * main-process IPC authority. This module loads a sibling `.env` file so the
 * installed app can configure secrets without relying on shell env vars.
 *
 * For unpackaged dev runs the file is read from the project root. For packaged
 * installs it is read from the directory containing the executable, matching
 * the natural place a user or installer would drop configuration.
 *
 * Import this module FIRST in main/index.ts, before any module that reads
 * process.env at top level (e.g. ./vsql-cache-client).
 */
import { app } from 'electron';
import path from 'path';
import dotenv from 'dotenv';

const envPath = app.isPackaged
  ? path.join(path.dirname(app.getPath('exe')), '.env')
  : path.join(app.getAppPath(), '.env');

const result = dotenv.config({ path: envPath });
if (result.error) {
  // A missing .env is normal for packaged installs that set env vars another
  // way (e.g. installer registry / system env). Log once and continue.
  console.log(`[loadEnv] No .env loaded from ${envPath}: ${result.error.message}`);
} else {
  console.log(`[loadEnv] Loaded env from ${envPath}`);
}
