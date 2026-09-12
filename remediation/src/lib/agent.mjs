/**
 * One agent turn through an OpenClaw agent, via one of three backends:
 *   local     : `openclaw agent exec` (embedded, no gateway) with our own config/state dir - used for development on a laptop
 *   nemoclaw  : `nemoclaw <sandbox> agent --agent main ...` - the OpenClaw agent running inside the NemoClaw/OpenShell sandbox on the GB10
 *   openclaw  : `openclaw agent --agent main ...` against a running gateway on this host
 * All three return OpenClaw's JSON envelope { ok, status, final, ... } when --json is honored.
 */
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { run } from './proc.mjs';

/** Materialize the local agent's config into its private state dir (workspace kept OUT of the app checkout). */
function prepareLocalConfig(o) {
  const stateDir = resolve(o.agentStateDir);
  const workspace = join(stateDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const cfg = JSON.parse(readFileSync(resolve(o.agentConfig), 'utf8'));
  delete cfg._comment;
  cfg.agents ??= {}; cfg.agents.defaults ??= {};
  cfg.agents.defaults.workspace = workspace;
  if (!o.model) throw new Error('the local dev backend needs an explicit model: pass --model <provider/model> (e.g. ollama/qwen3:8b) or set A11Y_LOCAL_MODEL');
  cfg.agents.defaults.model = { primary: o.model };
  const cfgPath = join(stateDir, 'openclaw.json');
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return { stateDir, cfgPath, workspace };
}

function extractEnvelope(stdout) {
  const s = stdout.trim();
  try { return JSON.parse(s); } catch {}
  // last JSON object in the stream
  const idx = s.lastIndexOf('\n{');
  if (idx >= 0) { try { return JSON.parse(s.slice(idx + 1)); } catch {} }
  const m = s.match(/\{[\s\S]*\}\s*$/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

export function describeBackend(o) {
  if (o.agentBackend === 'nemoclaw') return `nemoclaw sandbox "${o.sandbox}" (openclaw agent --agent main inside the sandbox)`;
  if (o.agentBackend === 'openclaw') return `${o.agentBin} agent --agent main (gateway on this host)`;
  return `local embedded openclaw agent (model ${o.model || 'unset'}) config=${o.agentConfig}`;
}

export async function runTurn(o, message, { log = () => {}, sessionKey = '' } = {}) {
  // one fresh session per turn: no carry-over from earlier attempts or other violations
  const session = sessionKey || `a11yfix-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let argv;
  let input = null;
  let env = {};
  const timeout = String(o.turnTimeout);
  if (o.agentBackend === 'nemoclaw') {
    if (!o.sandbox) throw new Error('--sandbox <name> is required for --agent-backend nemoclaw');
    argv = ['nemoclaw', o.sandbox, 'agent', '--agent', 'main', '--session-key', session, '--json', '--timeout', timeout, '-m', message];
  } else if (o.agentBackend === 'openclaw') {
    argv = [o.agentBin, 'agent', '--agent', 'main', '--session-key', session, '--json', '--timeout', timeout, '-m', message];
  } else {
    // local embedded agent (OpenClaw 2026.7.x): no gateway; isolated via OPENCLAW_STATE_DIR / OPENCLAW_CONFIG_PATH
    const { stateDir, cfgPath } = prepareLocalConfig(o);
    const localBin = process.env.A11Y_OPENCLAW_BIN || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'openclaw'); // pinned build under node 24
    argv = [localBin, 'agent', '--local', '--agent', 'main', '--session-key', session, '--json', '--timeout', timeout, '-m', message];
    env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: cfgPath, OPENCLAW_BROWSER_HEADLESS: '1' };
    if (o.model.startsWith('ollama/') && !process.env.OLLAMA_API_KEY) env.OLLAMA_API_KEY = 'ollama-local'; // OpenClaw enables its Ollama provider via this variable
  }
  if (o.model && o.agentBackend !== 'local') argv.push('--model', o.model); // local: model is in the generated config
  if (o.thinking) argv.push('--thinking', o.thinking);
  log(`agent turn: ${argv.slice(0, 6).join(' ')} ... (${message.length} chars)`);
  const r = await run(argv, { input, env, timeoutMs: (o.turnTimeout + 90) * 1000, onLine: o.verbose ? (d, s) => process.stderr.write(`[agent:${s}] ${d}`) : undefined });
  const envelope = extractEnvelope(r.stdout);
  const final = envelope?.final ?? envelope?.payloads?.map((p) => p.text).join('\n') ?? r.stdout.trim();
  return { ok: r.code === 0 && (envelope ? envelope.ok !== false : true), code: r.code, final, envelope, stderr: r.stderr, stdout: r.stdout, ms: r.ms, argv: argv.map((a) => (a === message ? '<message>' : a)) };
}
