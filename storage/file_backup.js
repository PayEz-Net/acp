import { readFile, writeFile, mkdir, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config as defaultConfig } from '../config.js';

let _config = defaultConfig;

export function setConfig(cfg) {
  _config = cfg;
}

function sessionPath(agentName) {
  return join(_config.acpDataDir, agentName, 'session.json');
}

function agentDir(agentName) {
  return join(_config.acpDataDir, agentName);
}

export async function readSession(agentName) {
  try {
    const data = await readFile(sessionPath(agentName), 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeSession(session) {
  const dir = agentDir(session.agentName);
  await mkdir(dir, { recursive: true });
  await writeFile(sessionPath(session.agentName), JSON.stringify(session, null, 2), 'utf8');
}

export async function deleteSession(agentName) {
  try {
    await unlink(sessionPath(agentName));
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
}

export async function listSessions() {
  try {
    const entries = await readdir(_config.acpDataDir, { withFileTypes: true });
    const sessions = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const session = await readSession(entry.name);
        if (session) sessions.push(session);
      }
    }
    return sessions;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}
