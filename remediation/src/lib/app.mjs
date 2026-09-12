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
          // A dangling symlink, a permission error or a race makes statSync throw; one such
          // entry must not abort localization for the whole checkout.
          let st;
          try { st = statSync(p); } catch { continue; }
          if (st.isDirectory()) { try { walk(p); } catch { /* unreadable dir */ } }
          else if (exts.test(name) && st.size < 400000) out.push(relative(this.root, p));
        }
      };
      walk(this.root);
      return out;
    }
    const r = await this.git('git ls-files -z');
    return r.stdout.split('\0').filter((f) => exts.test(f));
  }

  /**
   * A git command that fails (not a git checkout, dead sandbox, missing binary) returns empty
   * stdout, which upstream would read as "the agent changed nothing". Fail loudly instead so a
   * broken environment can never be mistaken for a well-behaved agent that made no edit.
   */
  async git(cmd, { allowCodes = [0] } = {}) {
    const r = await this.sh(cmd);
    if (!allowCodes.includes(r.code)) {
      const where = this.local ? this.root : `${this.o.sandbox}:${this.remoteRoot}`;
      throw new Error(`git command failed in ${where} (exit ${r.code}): ${cmd}\n${(r.stderr || r.stdout).slice(-500).trim()}`);
    }
    return r;
  }

  /** Diff of tracked changes plus new untracked files, WITHOUT touching the index (no intent-to-add). */
  async gitDiff() {
    const tracked = await this.git('git diff -- . ":(exclude)package-lock.json"');
    // -z: NUL-separated, so git does NOT C-quote paths. Without it a file the agent names with a
    // non-ASCII character, a quote, a backslash or a newline comes back as "src/Caf\303\251.jsx",
    // which then fails to match on disk and is silently dropped from the diff — bypassing both the
    // size guard and the reviewer.
    const untracked = await this.git('git ls-files --others --exclude-standard -z -- .');
    let out = tracked.stdout;
    for (const f of untracked.stdout.split('\0').filter(Boolean)) {
      // --no-index exits 1 when the files differ, which is the normal case here; anything
      // above that is a real failure.
      const d = await this.git(`git diff --no-index -- /dev/null ${shellQuote(f)}`, { allowCodes: [0, 1] });
      out += d.stdout;
    }
    return out;
  }

  async changedFiles() {
    // -z for the same reason as gitDiff: unquoted, NUL-separated paths.
    // Porcelain v1 with -z emits "XY <path>\0", and for a rename a second bare "<origin>\0" entry.
    const r = await this.git('git status --porcelain -z --untracked-files=all -- .');
    const out = [];
    const entries = r.stdout.split('\0').filter(Boolean);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!/^[ MADRCU?!]{2} /.test(e)) continue;   // a rename's origin path: already counted
      const status = e.slice(0, 2);
      out.push(e.slice(3));
      if (status[0] === 'R' || status[0] === 'C') i++;  // skip the origin entry that follows
    }
    return out;
  }

  /** Discard the agent's edits (tracked + new files under the app root). */
  async restore() {
    const head = await this.sh('git rev-parse --verify -q HEAD');
    if (head.code !== 0) throw new Error('cannot restore: the app checkout has no commit to restore to (commit the baseline first)');
    // never `git reset` here: it would unstage work the user has staged but not committed.
    // -e/--exclude MUST precede the `--` separator: everything after `--` is a pathspec, so
    // `clean -fdq -- . -e node_modules` treats the excludes as targets and DELETES them.
    const r = await this.sh('git checkout -- . && git clean -fdq -e node_modules -e dist -- .');
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
