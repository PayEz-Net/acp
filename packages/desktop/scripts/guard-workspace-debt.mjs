#!/usr/bin/env node
/**
 * Workspace-debt guard — additive CI ratchet that makes the <repo> /
 * scattered-resolver class UN-regrowable. Asserts TWO clauses:
 *   A.  No drive-letter / absolute-path string literal anywhere in src.
 *   B.  Exactly ONE resolver:
 *     B1. No 2nd resolution chain outside the single authority
 *         src/main/pty.ts (alias/destructured resolve, ?? cwd chains,
 *         template `${process.cwd()}`, ..·repo_path·workDir co-occur;
 *         excludes benign path.join(process.cwd(),'<file>')).
 *     B2. The renderer composes NO path (repo_path fused with a workDir
 *         term, repo_path ternary→path, repo_path→path-named var; plain
 *         `repo_path ?? null` display stays clean).
 *     B3. No 2nd workspace env var (only ACP_WORKSPACE_ROOT).
 *
 * Scans COMMITTED HEAD via git (not the parallel-dirty WT) — the commit
 * is the gate. `--scan-dir DIR` switches to a filesystem walk (self-test).
 * KNOWN regex limit (documented, not papered over): cross-line dataflow
 * (`const wd=a.repo_path;` … later `wd||b.workDir`) → follow-up eslint-AST
 * rule (tracked). Exit 1 on any non-allowlisted violation; 0 when clean.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const ONLY_RESOLVER = 'src/main/pty.ts';

// Tracked, scheduled-for-removal debt — visible (WARN) but not failing CI
// until its owning WO lands. Clause A on App.tsx is NOT tracked (enforced).
// COL-6 AC5: EMPTY. The App.tsx debt is cleared in acp-desktop
// (DEFAULT_AGENTS <repo> literal removed, f9e39f9; no :167 composition
// ever existed here). The B2 KNOWN_PENDING exemption is deleted so the
// guard now ENFORCES A+B2 on App.tsx permanently — no tracked debt.
const KNOWN_PENDING = [];

const scanDirIdx = process.argv.indexOf('--scan-dir');
const SCAN_DIR = scanDirIdx >= 0 ? process.argv[scanDirIdx + 1] : null;

function srcFiles() {
  if (SCAN_DIR) {
    const out = [];
    (function walk(d) {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
      }
    })(SCAN_DIR);
    return out.map((p) => ({ rel: relative(SCAN_DIR, p).split('\\').join('/'), read: () => readFileSync(p, 'utf8') }));
  }
  const list = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'src'], { cwd: REPO })
    .toString().split('\n').filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
  return list.map((rel) => ({
    rel,
    read: () => execFileSync('git', ['show', `HEAD:${rel}`], { cwd: REPO, maxBuffer: 16 * 1024 * 1024 }).toString(),
  }));
}

const violations = [];
const warnings = [];
function record(clause, rel, lineNo, text) {
  const pend = KNOWN_PENDING.find((k) => rel === k.file && k.clause === clause && (k.contains ? text.includes(k.contains) : true));
  (pend ? warnings : violations).push({ clause, file: rel, line: lineNo, text: text.trim(), reason: pend?.reason });
}

const DRIVE_LITERAL = /['"`]\s{0,3}[A-Za-z]:[\\/]/;
const WS_ENV = /process\.env\.([A-Za-z_]*WORKSPACE[A-Za-z_]*)|import\.meta\.env[^;\n]*?([A-Za-z_]*WORKSPACE[A-Za-z_]*)|(VITE_[A-Za-z_]*WORKSPACE)/;

/** String/URL-aware code extraction: tracks ' " ` strings (\\ escape) +
 *  multi-line block comments (state across lines); cuts // only outside
 *  strings (so `http://` no longer masks a trailing `?? process.cwd()`). */
function makeStripper() {
  let inBlock = false;
  return (raw) => {
    let out = '';
    let q = null;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i], n = raw[i + 1];
      if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
      if (q) {
        out += c;
        if (c === '\\') { out += n ?? ''; i++; continue; }
        if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { q = c; out += c; continue; }
      if (c === '/' && n === '/') break;
      if (c === '/' && n === '*') { inBlock = true; i++; continue; }
      out += c;
    }
    return out.replace(/^\s*\*.*$/, '');
  };
}

function isSecondResolver(code) {
  if (/\.join\(\s*process\.cwd\(\)\s*,\s*['"`]\.?[\w.-]+['"`]\s*\)/.test(code)
      && !/\.\.|resolve|repo_path|work[Dd]ir|WORKSPACE/.test(code)) return false;
  if (/\.resolve\b[^;\n]*process\.cwd\(\)/.test(code)) return true;
  if (/\?\?\s*process\.cwd\(\)|process\.cwd\(\)\s*\?\?/.test(code)) return true;
  if (/process\.cwd\(\)/.test(code)
      && (/`/.test(code) || /\.\./.test(code) || /repo_path|work[Dd]ir|WORKSPACE/.test(code))) return true;
  return false;
}

function rendererComposes(code) {
  if (/(repo_path[^;\n]*(\|\||\?\?)[^;\n]*work[Dd]ir)|(work[Dd]ir[^;\n]*(\|\||\?\?)[^;\n]*repo_path)/.test(code)) return true;
  if (/repo_path[^;\n]*\?[^;\n:]*:[^;\n]*(work[Dd]ir|cwd|path|root)|(\?[^;\n:]*repo_path[^;\n]*:)/.test(code)) return true;
  if (/repo_path[^;\n]*(\|\||\?\?|\?)[^;\n]*(work[Dd]ir|process\.cwd|[`])/.test(code)) return true;
  if (/(const|let|var)\s+\w*(work[Dd]ir|root|[Dd]ir|cwd|path)\w*\s*=\s*[^;\n]*repo_path/.test(code)) return true;
  return false;
}

for (const f of srcFiles()) {
  const isResolver = f.rel === ONLY_RESOLVER;
  const isRenderer = f.rel.startsWith('src/renderer/');
  let content;
  try { content = f.read(); } catch { continue; }
  const strip = makeStripper();
  content.split(/\r?\n/).forEach((raw, i) => {
    const lineNo = i + 1;
    const code = strip(raw);
    if (DRIVE_LITERAL.test(code)) record('A', f.rel, lineNo, raw);
    if (!isResolver && isSecondResolver(code)) record('B1', f.rel, lineNo, raw);
    const m = code.match(WS_ENV);
    if (m) {
      const name = m[1] || m[2] || m[3] || '';
      if (name && !/^ACP_WORKSPACE_ROOT$/.test(name)) record('B3', f.rel, lineNo, raw);
    }
    if (isRenderer && (rendererComposes(code) || DRIVE_LITERAL.test(code) || /process\.cwd\(\)/.test(code))) {
      record('B2', f.rel, lineNo, raw);
    }
  });
}

const tag = { A: 'A:drive-literal', B1: 'B1:2nd-resolver', B2: 'B2:renderer-composes-path', B3: 'B3:2nd-workspace-env' };
if (warnings.length) {
  console.warn(`\n[workspace-debt-guard] ${warnings.length} KNOWN-PENDING (tracked, not failing):`);
  for (const w of warnings) console.warn(`  ~ ${tag[w.clause]}  ${w.file}:${w.line}  ${w.text}\n      → ${w.reason}`);
}
if (violations.length) {
  console.error(`\n[workspace-debt-guard] FAIL — ${violations.length} workspace-debt violation(s):`);
  for (const v of violations) console.error(`  x ${tag[v.clause]}  ${v.file}:${v.line}  ${v.text}`);
  console.error('\nThe absolute-path/scattered-resolver class is banned. One resolver: src/main/pty.ts resolveWorkDir.\n');
  process.exit(1);
}
console.log(`[workspace-debt-guard] OK (HEAD${SCAN_DIR ? ' override' : ''}) — single resolver intact, no drive literals, no 2nd workspace env (${warnings.length} known-pending tracked).`);
process.exit(0);
