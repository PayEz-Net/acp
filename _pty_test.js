
const fs = require('fs');
try {
  const pty = require('./node_modules/node-pty');
  const p = pty.spawn('cmd.exe', [], { cols: 80, rows: 30, cwd: '.' });
  p.kill();
  fs.writeFileSync('_pty_result.txt', 'SUCCESS');
} catch(e) {
  fs.writeFileSync('_pty_result.txt', 'FAIL: ' + e.message);
}
process.exit(0);
