/**
 * Independent verification of the two CRITICAL claims raised during review.
 * These are the highest-stakes findings, so they are proven here rather than argued.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, chmodSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { lib, SRC, opts, gitRepo, put, scratchDir, cleanupAll } from './helpers.mjs';

const { fixOne } = await import(`${SRC}/src/fix.mjs`);
const P = await import(lib('proc.mjs'));
after(cleanupAll);

// ── CRITICAL #1: whose diff is it anyway? ─────────────────────────────────────

describe('CRITICAL: the agent is credited with pre-existing uncommitted work', () => {
  test('a no-op agent gets a stranger\'s uncommitted edit reported as its verified patch', async () => {
    const COMPONENT = 'export default function C() {\n  return <button id="upload-submit" onClick={go} />;\n}\n';
    const { root } = gitRepo({ files: { 'src/C.jsx': COMPONENT } });
    const bin = scratchDir('bin-');
    const outDir = scratchDir('out-');

    // An agent that does absolutely nothing to the filesystem.
    const agentPath = join(bin, 'openclaw');
    writeFileSync(agentPath, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:true,final:"I could not find anything to change."})+"\\n");\n`);
    chmodSync(agentPath, 0o755);

    // The operator's OWN uncommitted work, present before the harness starts.
    appendFileSync(join(root, 'src/C.jsx'), '// operator work in progress\n');

    // A scanner that reports the violation as gone (e.g. it was fixed elsewhere, or the
    // page simply no longer exhibits it) — so build/rescan/functional all come up green.
    const scanPath = join(bin, 'scan.mjs');
    writeFileSync(scanPath, `process.stdout.write(JSON.stringify({schema_version:'1.0',scan:{},violations:[]}));`);

    const baseline = { schema_version: '1.0', scan: {}, violations: [{ id: 'button-name#0', rule_id: 'button-name', selector: '#upload-submit' }] };
    const o = opts({
      appRoot: root, outDir, agentBackend: 'openclaw', agentBin: agentPath,
      scanCmd: `node ${JSON.stringify(scanPath)}`, buildCmd: '', funcCmd: '', turnTimeout: 20,
    });

    const r = await fixOne(o, { id: 'button-name#0', rule_id: 'button-name', selector: '#upload-submit', html: '<button id="upload-submit"></button>', description: 'd', route: '/' }, baseline);

    assert.notEqual(r.status, 'fixed',
      'the agent changed nothing; the operator\'s own uncommitted edit must not be captured, verified and reported as the agent\'s patch');
  });

  test('the harness does not verify a clean baseline before the first agent turn', () => {
    const src = readFileSync(`${SRC}/src/fix.mjs`, 'utf8');
    const loopStart = src.indexOf('for (let attempt = 1');
    const preamble = src.slice(0, loopStart);
    assert.match(preamble, /gitDiff|status --porcelain|restore\(\)/,
      'fixOne never checks that --app-root is clean before attributing the worktree diff to the agent');
  });
});

// ── CRITICAL #2: does the run() timeout actually kill the work? ───────────────

describe('CRITICAL: run() timeout against a shell command', () => {
  test('a timed-out shell command is actually killed, not just its shell', async () => {
    const dir = scratchDir('kill-');
    const marker = join(dir, 'still-alive');
    // `sleep 8 && touch marker` is a COMPOUND command: /bin/sh cannot exec-optimise it,
    // so sh stays alive as a parent. Killing sh may orphan the sleep.
    const r = await P.run(`sleep 8 && touch ${JSON.stringify(marker)}`, { shell: true, timeoutMs: 700 });
    assert.notEqual(r.code, 0, 'the run must report a non-zero/aborted result');
    await new Promise((res) => setTimeout(res, 9000));
    assert.equal(existsSync(marker), false,
      'the underlying command survived the timeout and completed its work afterwards (orphaned process)');
  });

  test('run() resolves promptly on timeout even for a compound shell command', async () => {
    const t0 = Date.now();
    await P.run('sleep 30 && echo done', { shell: true, timeoutMs: 600 });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5000, `run() should resolve near the timeout, took ${elapsed}ms`);
  });

  test('even a SIMPLE shell command outlives its timeout (dash does not exec-optimise here)', async () => {
    // Mechanism: spawn(cmd, {shell:true}) runs `/bin/sh -c sleep 6`; dash forks rather than
    // execs, so kill() reaps only the shell. The orphaned command keeps the inherited
    // stdout/stderr pipes open, and Node's 'close' event waits on those pipes.
    const t0 = Date.now();
    const r = await P.run('sleep 6', { shell: true, timeoutMs: 500 });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3000,
      `a 500ms timeout should not take ${elapsed}ms; the shell was killed but the command ran to completion holding the pipes`);
  });

  test('CONTRAST: the argv (non-shell) form used for agent turns DOES time out correctly', async () => {
    const t0 = Date.now();
    const r = await P.run(['sleep', '6'], { timeoutMs: 500 });
    assert.ok(Date.now() - t0 < 3000, 'array form spawns the binary directly, so kill() hits the real process');
    assert.notEqual(r.code, 0);
  });

  test('consequence: NO verification gate can time out, because all three use shell:true', () => {
    const verifySrc = readFileSync(`${SRC}/src/lib/verify.mjs`, 'utf8');
    const appSrc = readFileSync(`${SRC}/src/lib/app.mjs`, 'utf8');
    // runScan, runFunctional and build all pass a string command with shell:true.
    assert.match(verifySrc, /run\(cmd, \{ shell: true, timeoutMs: 180000 \}\)/);
    assert.match(appSrc, /run\(cmd, \{ cwd: process\.cwd\(\), shell: true, timeoutMs: 180000 \}\)/);
  });
});
