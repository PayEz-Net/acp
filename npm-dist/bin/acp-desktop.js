#!/usr/bin/env node
const path = require('path');
const { spawn } = require('child_process');

const installerPath = path.join(__dirname, '..', 'installer.exe');

const child = spawn(installerPath, process.argv.slice(2), {
  detached: false,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('error', (err) => {
  console.error('Failed to start ACP installer:', err.message);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
