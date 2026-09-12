/**
 * src/lib/proc.mjs  — subprocess execution, shell quoting, template filling
 * src/lib/app.mjs   — git diff/restore/build against a real git checkout
 *
 * These are the code paths that touch the filesystem and the shell with
 * model-influenced input, so they get adversarial coverage.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lib, opts, gitRepo, put, scratchDir, cleanupAll } from './helpers.mjs';

const P = await import(lib('proc.mjs'));
const A = await import(lib('app.mjs'));
after(cleanupAll);

// ── proc.run ───────────────────────────────────────────────────────────────────

describe('MAIN: proc.run', () => {
  test('captures stdout, stderr and exit code without throwing', async () => {
    const r = await P.run(['node', '-e', 'process.stdout.write("out");process.stderr.write("err");process.exit(3)']);
    assert.equal(r.code, 3);
    assert.equal(r.stdout, 'out');
    assert.equal(r.stderr, 'err');
    assert.ok(r.ms >= 0);
  });
  test('array argv does not go through a shell (metacharacters are literal)', async () => {
    const r = await P.run(['node', '-e', 'process.stdout.write(process.argv[1])', '$(echo pwned); rm -rf /']);
    assert.equal(r.stdout, '$(echo pwned); rm -rf /', 'argv form must never interpret shell syntax');
  });
  test('string form DOES go through a shell (by design)', async () => {
    const r = await P.run('echo hello && echo world', { shell: true });
    assert.equal(r.stdout.trim().split('\n').length, 2);
  });
  test('a missing binary resolves code -1 rather than throwing', async () => {
    const r = await P.run(['definitely-not-a-binary-xyz']);
    assert.equal(r.code, -1);
    assert.match(r.stderr, /ENOENT/);
  });
  test('stdin input is delivered', async () => {
    const r = await P.run(['node', '-e', 'process.stdin.on("data",d=>process.stdout.write(d))'], { input: 'piped' });
    assert.equal(r.stdout, 'piped');
  });
  test('env overrides are merged over process.env', async () => {
    const r = await P.run(['node', '-e', 'process.stdout.write(process.env.MY_VAR + "|" + (process.env.PATH ? "haspath" : "nopath"))'], { env: { MY_VAR: 'v' } });
    assert.equal(r.stdout, 'v|haspath');
  });
});

describe('EDGE/HARD: proc.run robustness', () => {
  test('a timeout kills the child and still resolves', async () => {
    const t0 = Date.now();
    const r = await P.run(['node', '-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 600 });
    assert.ok(Date.now() - t0 < 10000, 'must return promptly after the timeout');
    assert.notEqual(r.code, 0);
  });

  test('a timed-out run does not leave a dangling timer holding the event loop open', async () => {
    // run() schedules `setTimeout(() => child.kill('SIGKILL'), 5000)` inside the timeout
    // handler and never clears it. If it leaks, a short script outlives its work.
    const script = `
      import { run } from ${JSON.stringify(lib('proc.mjs'))};
      const t0 = Date.now();
      await run(['node','-e','setTimeout(()=>{},60000)'], { timeoutMs: 300 });
      process.on('exit', () => process.stdout.write(String(Date.now() - t0)));
    `;
    const r = await P.run(['node', '--input-type=module', '-e', script], { timeoutMs: 30000 });
    const heldMs = Number(r.stdout.trim());
    assert.ok(heldMs < 3000,
      `after a timeout the process should exit promptly, but the event loop stayed alive ${heldMs}ms (dangling SIGKILL timer)`);
  });

  test('multi-byte UTF-8 split across chunk boundaries is not corrupted', async () => {
    // `stdout += d` stringifies each Buffer independently; a character split across
    // two chunks becomes U+FFFD. The agent's reply and the scanner's JSON both flow through here.
    const script = `
      const buf = Buffer.from('café — naïve ✅ 日本語');
      let i = 0;
      (function next(){ if (i >= buf.length) return process.stdout.end();
        process.stdout.write(buf.subarray(i, i + 1)); i += 1; setTimeout(next, 1); })();
    `;
    const r = await P.run(['node', '-e', script]);
    assert.equal(r.stdout, 'café — naïve ✅ 日本語',
      'byte-wise chunking must not corrupt multi-byte characters (use a StringDecoder or collect Buffers)');
  });

  test('a large stdout is captured without truncation or crash', async () => {
    const r = await P.run(['node', '-e', 'process.stdout.write("x".repeat(2_000_000))']);
    assert.equal(r.stdout.length, 2_000_000);
  });

  test('a child that closes stdin early does not crash the parent with EPIPE', async () => {
    const r = await P.run(['node', '-e', 'process.stdin.destroy(); setTimeout(()=>process.exit(0), 50)'], { input: 'x'.repeat(200000) });
    assert.equal(r.code, 0);
  });
});

// ── shellQuote / fill ──────────────────────────────────────────────────────────

describe('HARD: shellQuote must neutralise adversarial filenames', () => {
  // The agent under test is explicitly treated as untrusted and CAN create files
  // with arbitrary names; app.gitDiff() interpolates those names into a shell string.
  const nasty = [
    ["single quote", `it's.jsx`],
    ["command substitution", `$(touch /tmp/pwned).jsx`],
    ["backticks", '`touch /tmp/pwned`.jsx'],
    ["semicolon", 'a.jsx; touch /tmp/pwned'],
    ["quote break-out", `a'; touch /tmp/pwned; '.jsx`],
    ["newline", 'a.jsx\ntouch /tmp/pwned'],
    ["backslash", 'a\\b.jsx'],
    ["dollar var", '$HOME.jsx'],
    ["pipe", 'a.jsx | tee /tmp/pwned'],
  ];
  for (const [label, s] of nasty) {
    test(`${label}: round-trips through sh as a literal string`, async () => {
      const quoted = P.shellQuote(s);
      const r = await P.run(`printf %s ${quoted}`, { shell: true });
      assert.equal(r.stdout, s, `shellQuote(${JSON.stringify(s)}) must survive the shell unchanged`);
    });
  }
});

describe('fill() template substitution', () => {
  test('substitutes known keys', () => {
    assert.equal(P.fill('scan --url {url} --root {appRoot}', { url: 'U', appRoot: 'R' }), 'scan --url U --root R');
  });
  test('leaves unknown placeholders alone', () => {
    assert.equal(P.fill('a {nope} b', { url: 'U' }), 'a {nope} b');
  });
  test('does NOT shell-quote the substituted value (documents the injection surface)', () => {
    const out = P.fill('scan --url {url}', { url: 'http://h/; touch /tmp/pwned' });
    assert.doesNotMatch(out, /'/, 'fill performs raw substitution — callers must quote');
  });
  test('a filled command is run with shell:true — an injected --url executes', async () => {
    const marker = join(scratchDir('fill-'), 'pwned');
    const cmd = P.fill('echo {url}', { url: `ok; touch ${marker}` });
    await P.run(cmd, { shell: true });
    assert.equal(existsSync(marker), false,
      'a URL value must not be able to execute a second command; {url} needs quoting before it reaches a shell');
  });
});

// ── AppFs against a real git checkout ─────────────────────────────────────────

describe('MAIN: AppFs git operations on a real repo', () => {
  test('gitDiff reports a tracked modification', async () => {
    const { root } = gitRepo({ files: { 'src/App.jsx': 'const a = 1;\n' } });
    writeFileSync(join(root, 'src/App.jsx'), 'const a = 2;\n');
    const app = new A.AppFs(opts({ appRoot: root }));
    const d = await app.gitDiff();
    assert.match(d, /-const a = 1;/);
    assert.match(d, /\+const a = 2;/);
  });

  test('gitDiff includes new untracked files', async () => {
    const { root } = gitRepo({ files: { 'a.jsx': 'x\n' } });
    put(root, 'src/New.jsx', 'const n = 1;\n');
    const app = new A.AppFs(opts({ appRoot: root }));
    const d = await app.gitDiff();
    assert.match(d, /New\.jsx/);
    assert.match(d, /\+const n = 1;/);
  });

  test('changedFiles lists both modified and untracked paths', async () => {
    const { root } = gitRepo({ files: { 'a.jsx': 'x\n' } });
    writeFileSync(join(root, 'a.jsx'), 'y\n');
    put(root, 'b.jsx', 'z\n');
    const app = new A.AppFs(opts({ appRoot: root }));
    const f = await app.changedFiles();
    assert.deepEqual(f.sort(), ['a.jsx', 'b.jsx']);
  });

  test('restore() reverts modifications and deletes new files', async () => {
    const { root } = gitRepo({ files: { 'a.jsx': 'original\n' } });
    writeFileSync(join(root, 'a.jsx'), 'agent edit\n');
    put(root, 'junk.jsx', 'junk\n');
    const app = new A.AppFs(opts({ appRoot: root }));
    await app.restore();
    assert.equal(readFileSync(join(root, 'a.jsx'), 'utf8'), 'original\n');
    assert.equal(existsSync(join(root, 'junk.jsx')), false);
  });

  test('build() with an empty command is reported as skipped', async () => {
    const app = new A.AppFs(opts({ appRoot: scratchDir('nb-') }));
    const b = await app.build('');
    assert.equal(b.skipped, true);
    assert.equal(b.code, 0);
  });
});

describe('HARD: AppFs failure modes', () => {
  test('restore() in a repo with NO commits refuses rather than wiping the tree', async () => {
    const { root } = gitRepo({ files: {}, commit: false });
    put(root, 'uncommitted.jsx', 'precious\n');
    const app = new A.AppFs(opts({ appRoot: root }));
    await assert.rejects(() => app.restore(), /no commit to restore to/);
    assert.equal(existsSync(join(root, 'uncommitted.jsx')), true, 'nothing may be destroyed when there is no baseline');
  });

  test('restore() PRESERVES node_modules (the -e exclude must actually apply)', async () => {
    const { root } = gitRepo({ files: { 'a.jsx': 'x\n' } });
    put(root, 'node_modules/left-pad/index.js', 'module.exports=1\n');
    put(root, 'dist/bundle.js', 'built\n');
    const app = new A.AppFs(opts({ appRoot: root }));
    await app.restore();
    assert.equal(existsSync(join(root, 'node_modules/left-pad/index.js')), true,
      'node_modules must survive restore(); re-installing deps between bench runs would be ruinous');
    assert.equal(existsSync(join(root, 'dist/bundle.js')), true, 'dist must survive restore()');
  });

  test('gitDiff on a NON-git directory does not silently look like "the agent changed nothing"', async () => {
    const root = scratchDir('nogit-');
    writeFileSync(join(root, 'a.jsx'), 'x\n');
    const app = new A.AppFs(opts({ appRoot: root }));
    const d = await app.gitDiff();
    assert.notEqual(d.trim(), '',
      'in a non-git app root gitDiff returns "" — indistinguishable from a well-behaved agent that made no edit; it must surface an error instead');
  });

  test('restore() is destructive to uncommitted work in the app root (documents the blast radius)', async () => {
    const { root } = gitRepo({ files: { 'tracked.jsx': 'committed\n' } });
    // A developer's own in-progress work, unrelated to the agent:
    writeFileSync(join(root, 'tracked.jsx'), "my half-finished feature\n");
    put(root, 'my-notes.md', 'hours of work\n');
    const app = new A.AppFs(opts({ appRoot: root }));
    await app.restore();
    assert.equal(readFileSync(join(root, 'tracked.jsx'), 'utf8'), "my half-finished feature\n",
      'restore() must not discard uncommitted work it did not create');
    assert.equal(existsSync(join(root, 'my-notes.md')), true,
      'restore() must not delete untracked files it did not create');
  });

  test('a file the agent created with a shell-hostile name is diffed safely', async () => {
    const { root } = gitRepo({ files: { 'a.jsx': 'x\n' } });
    const marker = join(scratchDir('inj-'), 'pwned');
    put(root, `evil$(touch ${marker}).jsx`, 'payload\n');
    const app = new A.AppFs(opts({ appRoot: root }));
    await app.gitDiff();
    assert.equal(existsSync(marker), false, 'an agent-chosen filename must never execute during gitDiff');
  });

  test('listSourceFiles skips vendor dirs and honours the size cap', async () => {
    const { root } = gitRepo({ files: { 'src/a.jsx': 'x\n' } });
    put(root, 'node_modules/pkg/b.jsx', 'y\n');
    put(root, 'dist/c.jsx', 'z\n');
    put(root, 'src/huge.jsx', 'x'.repeat(400001));
    put(root, 'src/notes.txt', 'ignored ext\n');
    const app = new A.AppFs(opts({ appRoot: root }));
    const files = await app.listSourceFiles();
    assert.ok(files.includes('src/a.jsx'));
    assert.ok(!files.some((f) => f.includes('node_modules')), 'node_modules must be skipped');
    assert.ok(!files.some((f) => f.includes('dist')), 'dist must be skipped');
    assert.ok(!files.includes('src/huge.jsx'), 'oversized files are skipped');
    assert.ok(!files.includes('src/notes.txt'), 'non-source extensions are skipped');
  });

  test('listSourceFiles survives a broken symlink instead of aborting the run', async () => {
    const { root } = gitRepo({ files: { 'src/a.jsx': 'x\n' } });
    const { symlinkSync } = await import('node:fs');
    symlinkSync(join(root, 'does-not-exist'), join(root, 'src', 'dangling.jsx'));
    const app = new A.AppFs(opts({ appRoot: root }));
    await assert.doesNotReject(() => app.listSourceFiles(),
      'a dangling symlink in the app checkout must not abort localization (statSync throws)');
  });
});

describe('ensureServer', () => {
  test('returns started:false when the app is already up, and stop() is a no-op', async () => {
    const { createServer } = await import('node:http');
    const srv = createServer((req, res) => { res.writeHead(200); res.end('ok'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/`;
    try {
      const s = await A.ensureServer(url, '');
      assert.equal(s.started, false);
      s.stop();
    } finally { srv.close(); }
  });

  test('throws a clear error when the app is down and no --serve-cmd was given', async () => {
    await assert.rejects(() => A.ensureServer('http://127.0.0.1:1/', ''), /not reachable.*no --serve-cmd/);
  });

  test('a non-2xx response counts as "not up" rather than a false ready signal', async () => {
    const { createServer } = await import('node:http');
    const srv = createServer((req, res) => { res.writeHead(503); res.end('starting'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/`;
    try {
      await assert.rejects(() => A.ensureServer(url, ''), /not reachable/);
    } finally { srv.close(); }
  });
});
