/**
 * Where the app's files live decides how we run git/build and read files:
 *   execBackend=local    -> run directly in appRoot on this machine
 *   execBackend=nemoclaw -> run inside the NemoClaw sandbox via `nemoclaw <sandbox> exec --workdir <remoteAppRoot> -- sh -lc <cmd>`
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { run, shellQuote, fill } from './proc.mjs';

export class AppFs {
  constructor(o) {
    this.o = o;
    this.local = o.execBackend !== 'nemoclaw';
    this.root = resolve(o.appRoot);
    this.remoteRoot = o.remoteAppRoot || o.appRoot;
  }

  /** Run a shell command with the app root as cwd, locally or in the sandbox. */
  async sh(cmd, { timeoutMs = 120000 } = {}) {
    if (this.local) return run(cmd, { cwd: this.root, shell: true, timeoutMs });
    const argv = ['nemoclaw', this.o.sandbox, 'exec', '--workdir', this.remoteRoot, '--no-stdin', '--timeout', String(Math.ceil(timeoutMs / 1000)), '--', 'sh', '-lc', cmd];
    return run(argv, { timeoutMs: timeoutMs + 30000 });
  }

  async readFile(rel) {
    if (this.local) return readFileSync(join(this.root, rel), 'utf8');
    const r = await this.sh(`cat ${shellQuote(rel)}`);
    if (r.code !== 0) throw new Error(`cannot read ${rel} in sandbox: ${r.stderr}`);
    return r.stdout;
  }

  /** List source files (relative paths) for localization. Local: walk; remote: git ls-files. */
  async listSourceFiles() {
    const exts = /\.(jsx?|tsx?|mjs|cjs|html|vue|svelte|css|scss)$/;
    if (this.local) {
      const out = [];
      const skip = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.next', '.vite']);
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          if (skip.has(name)) continue;
          const p = join(dir, name);
          const st = statSync(p);
          if (st.isDirectory()) walk(p);
          else if (exts.test(name) && st.size < 400000) out.push(relative(this.root, p));
        }
      };
      walk(this.root);
      return out;
    }
    const r = await this.sh('git ls-files');
    return r.stdout.split('\n').filter((f) => exts.test(f));
  }

  /** Diff of tracked changes plus new untracked files, WITHOUT touching the index (no intent-to-add). */
  async gitDiff() {
    const tracked = await this.sh('git diff -- . ":(exclude)package-lock.json"');
    const untracked = await this.sh('git ls-files --others --exclude-standard -- .');
    let out = tracked.stdout;
    for (const f of untracked.stdout.split('\n').filter(Boolean)) {
      const d = await this.sh(`git diff --no-index -- /dev/null ${shellQuote(f)} || true`);
      out += d.stdout;
    }
    return out;
  }

  async changedFiles() {
    const r = await this.sh('git status --porcelain --untracked-files=all -- .');
    return r.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).trim());
  }

  /** Discard the agent's edits (tracked + new files under the app root). */
  async restore() {
    const head = await this.sh('git rev-parse --verify -q HEAD');
    if (head.code !== 0) throw new Error('cannot restore: the app checkout has no commit to restore to (commit the baseline first)');
    // never `git reset` here: it would unstage work the user has staged but not committed
    const r = await this.sh('git checkout -- . && git clean -fdq -- . -e node_modules -e dist');
    if (r.code !== 0) throw new Error(`restore failed: ${r.stderr}`);
  }

  async build(buildCmd) {
    if (!buildCmd) return { code: 0, stdout: '', stderr: '', skipped: true };
    const cmd = fill(buildCmd, { appRoot: this.local ? this.root : this.remoteRoot });
    // build commands are written relative to the repo root; run there locally
    if (this.local) return run(cmd, { cwd: process.cwd(), shell: true, timeoutMs: 180000 });
    return this.sh(cmd, { timeoutMs: 180000 });
  }
}

/** Make sure the app is being served at url; optionally start it with serveCmd. Returns a stop() fn. */
export async function ensureServer(url, serveCmd, { timeoutMs = 60000, log = () => {} } = {}) {
  const up = async () => { try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; } };
  if (await up()) return { started: false, stop: () => {} };
  if (!serveCmd) throw new Error(`app is not reachable at ${url} and no --serve-cmd given`);
  log(`starting app: ${serveCmd}`);
  const { spawn } = await import('node:child_process');
  const child = spawn(serveCmd, { shell: true, stdio: 'ignore', detached: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await up()) return { started: true, stop: () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} } };
    await new Promise((r) => setTimeout(r, 500));
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  throw new Error(`app did not come up at ${url} within ${timeoutMs / 1000}s`);
}
