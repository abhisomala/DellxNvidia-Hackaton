/**
 * Shared helpers for the a11y-fix harness review test suite.
 *
 * Paths are derived from this file's own location, so the suite runs from any
 * working directory and from any checkout. Scratch files go to the OS temp dir;
 * nothing is ever written inside the repository.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

/** remediation/ — the package under test (tests/ lives directly inside it). */
export const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const lib = (name) => join(SRC, 'src', 'lib', name);

const SCRATCH_BASE = join(tmpdir(), 'a11y-fix-tests');
mkdirSync(SCRATCH_BASE, { recursive: true });

const created = [];
export function scratchDir(prefix = 'case-') {
  const d = mkdtempSync(join(SCRATCH_BASE, prefix));
  created.push(d);
  return d;
}
export function cleanupAll() {
  for (const d of created.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

/** Write a file, creating parent dirs. */
export function put(root, rel, content) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

/** A throwaway git repo with one commit, for exercising AppFs against real git. */
export function gitRepo({ files = {}, commit = true } = {}) {
  const root = scratchDir('repo-');
  const git = (...args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@e.st',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@e.st',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  git('init', '-q', '-b', 'main');
  for (const [rel, content] of Object.entries(files)) put(root, rel, content);
  if (commit && Object.keys(files).length) { git('add', '-A'); git('commit', '-qm', 'base'); }
  return { root, git };
}

/**
 * Minimal stand-in for AppFs, sufficient for locate(): locate() only uses
 * .local, .root, listSourceFiles() and readFile().
 */
export function fakeApp(files, { local = true, root = '/fake/app' } = {}) {
  return {
    local,
    root,
    async listSourceFiles() { return Object.keys(files); },
    async readFile(rel) {
      if (!(rel in files)) throw new Error(`ENOENT: ${rel}`);
      return files[rel];
    },
  };
}

/** Baseline option object matching lib/args.mjs DEFAULTS closely enough for unit tests. */
export function opts(over = {}) {
  return {
    appRoot: '/fake/app', url: 'http://127.0.0.1:5174/',
    scanCmd: 'true', funcCmd: '', buildCmd: '', serveCmd: '',
    agentBackend: 'openclaw', execBackend: 'local', sandbox: '', remoteAppRoot: '',
    agentBin: 'openclaw', model: '', thinking: '',
    maxAttempts: 3, turnTimeout: 420, outDir: join(tmpdir(), 'a11y-fix-tests-out'),
    keepFailed: false, verbose: false,
    maxAddedLines: 80, maxRemovedLines: 40, maxFiles: 2,
    judgeUrl: '', judgeModel: '', judgeKey: '',
    ...over,
  };
}

/** A real unified diff, as `git diff` would emit it. */
export const REAL_DIFF = `diff --git a/src/App.jsx b/src/App.jsx
index 1111111..2222222 100644
--- a/src/App.jsx
+++ b/src/App.jsx
@@ -12,7 +12,7 @@ export default function App() {
   return (
     <main>
-      <button id="go" onClick={go}></button>
+      <button id="go" aria-label="Go" onClick={go}></button>
     </main>
   );
 }
`;

/** Spin up a one-shot local HTTP server; returns { url, close, calls }. */
export async function stubServer(handler) {
  const { createServer } = await import('node:http');
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls.push({ url: req.url, method: req.method, body, headers: req.headers });
      handler(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}
