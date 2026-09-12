import { spawn } from 'node:child_process';

/** Run a command (array or shell string). Resolves { code, stdout, stderr, ms }. Never throws on non-zero exit. */
export function run(cmd, { cwd, env, input, timeoutMs = 0, shell = false, onLine } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = Array.isArray(cmd)
      ? spawn(cmd[0], cmd.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(cmd, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], shell: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; if (onLine) onLine(String(d), 'stdout'); });
    child.stderr.on('data', (d) => { stderr += d; if (onLine) onLine(String(d), 'stderr'); });
    let timer;
    if (timeoutMs > 0) timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000); }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(err), ms: Date.now() - started }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: Date.now() - started }); });
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}
