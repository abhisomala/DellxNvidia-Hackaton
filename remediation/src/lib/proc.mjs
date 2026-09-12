import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/**
 * Children are spawned DETACHED so each becomes its own process-group leader, which lets us
 * kill the whole group. `spawn(cmd, {shell:true})` runs `/bin/sh -c cmd` and the shell forks
 * rather than execs, so signalling only the direct child reaps the shell while the real command
 * survives holding the inherited stdout/stderr pipes — and Node's 'close' then never fires.
 * Detached + a negative-pid kill takes down the shell and everything it started.
 */
const live = new Set();
let cleanupInstalled = false;

function killGroup(child, signal) {
  try { process.kill(-child.pid, signal); return; } catch { /* group gone, or no group */ }
  try { child.kill(signal); } catch { /* already dead */ }
}

/** Detached children survive the terminal's Ctrl-C, so tear them down with the parent. */
function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const killAll = () => { for (const c of live) killGroup(c, 'SIGKILL'); live.clear(); };
  process.on('exit', killAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { killAll(); process.exit(sig === 'SIGINT' ? 130 : 143); });
  }
}

/** Run a command (array or shell string). Resolves { code, stdout, stderr, ms, timedOut }. Never throws on non-zero exit. */
export function run(cmd, { cwd, env, input, timeoutMs = 0, shell = false, onLine } = {}) {
  return new Promise((resolve) => {
    installCleanup();
    const started = Date.now();
    const child = Array.isArray(cmd)
      ? spawn(cmd[0], cmd.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
      : spawn(cmd, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], shell: true, detached: true });
    live.add(child);
    // Decode incrementally: a multi-byte character split across two chunks would otherwise
    // become U+FFFD (the agent's reply and the scanner's JSON both flow through here).
    const outDec = new StringDecoder('utf8'), errDec = new StringDecoder('utf8');
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { const s = outDec.write(d); stdout += s; if (onLine && s) onLine(s, 'stdout'); });
    child.stderr.on('data', (d) => { const s = errDec.write(d); stderr += s; if (onLine && s) onLine(s, 'stderr'); });
    let timer, killTimer, timedOut = false;
    const done = (result) => {
      clearTimeout(timer); clearTimeout(killTimer);
      live.delete(child);
      stdout += outDec.end(); stderr += errDec.end();
      resolve({ ...result, stdout, stderr, ms: Date.now() - started, timedOut });
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child, 'SIGTERM');
        killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), 5000);
      }, timeoutMs);
    }
    child.on('error', (err) => { stderr += String(err); done({ code: -1 }); });
    child.on('close', (code) => done({ code }));
    // A child that exits without reading stdin makes this write emit EPIPE; it is not fatal.
    child.stdin.on('error', () => {});
    if (input != null) { try { child.stdin.write(input); } catch {} }
    try { child.stdin.end(); } catch {}
  });
}

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Substitute {placeholders} into a SHELL command template, quoting each value.
 *
 * Every caller (scanCmd, funcCmd, buildCmd) passes the result to a shell, so raw substitution
 * would let a value carrying `;`, backticks or $( ) run a second command. Surrounding quotes
 * already present in the template are consumed, so both `--url {url}` and `--prefix "{appRoot}"`
 * produce exactly one correctly-quoted argument.
 */
export function fill(template, vars) {
  return template.replace(/(["']?)\{(\w+)\}\1/g, (m, _q, k) => (k in vars ? shellQuote(vars[k]) : m));
}

/** Raw substitution, for building non-shell strings (no quoting applied). */
export function fillRaw(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}
