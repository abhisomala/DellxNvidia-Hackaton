import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const REMEDIATION_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fx = (p) => join(REMEDIATION_DIR, 'fixtures', p);
import { pickViolation } from './normalize.mjs';

export const DEFAULTS = {
  appRoot: fx('demo-app'),
  url: 'http://127.0.0.1:5174/',
  scanCmd: `node "${fx('scanner/scan.mjs')}" --url {url}`,
  funcCmd: `node "${fx('scanner/functional.mjs')}" --url {url}`,
  buildCmd: 'npm --prefix "{appRoot}" run build --silent',
  serveCmd: '',
  agentBackend: process.env.A11Y_AGENT_BACKEND || 'openclaw',   // openclaw (installed agent + its own model config; default) | nemoclaw (host -> sandbox) | local (dev: embedded agent, needs --model)
  execBackend: 'local',        // local | nemoclaw   (where git/build run; the sandbox when the app lives there)
  sandbox: '',                 // nemoclaw sandbox name
  remoteAppRoot: '',           // app path inside the sandbox (exec/agent backend = nemoclaw)
  agentBin: process.env.A11Y_OPENCLAW_BIN || 'openclaw',       // the installed openclaw; the local dev backend falls back to bin/openclaw (pinned build under node 24)
  agentConfig: join(REMEDIATION_DIR, 'config', 'openclaw.local.json'),
  agentStateDir: join(REMEDIATION_DIR, '.state'),
  model: process.env.A11Y_LOCAL_MODEL || '',   // never set by default: the agent's configured model is used. Required for the local dev backend.
  thinking: '',                // optional --thinking level
  maxAttempts: 3,
  turnTimeout: 420,
  outDir: join(REMEDIATION_DIR, 'out'),
  keepFailed: false,
  verbose: false,
  maxAddedLines: 80,       // diff-size guard: a one-rule fix should be small
  maxRemovedLines: 40,     // and must not drop existing code (whole-file rewrites are allowed but checked)
  maxFiles: 2,
  judgeUrl: process.env.A11Y_JUDGE_URL || process.env.OPENAI_BASE_URL || '',   // reviewer endpoint (OpenAI-compatible); '' = reviewer off
  judgeModel: process.env.A11Y_JUDGE_MODEL || process.env.OPENAI_MODEL || '',
  judgeReasoningEffort: process.env.A11Y_JUDGE_REASONING_EFFORT || '',   // e.g. 'none' for gemma4 on Ollama; '' = field not sent
  judgeKey: process.env.A11Y_JUDGE_KEY || process.env.OPENAI_API_KEY || '',
};

export const AGENT_BACKENDS = ['openclaw', 'nemoclaw', 'local'];
export const EXEC_BACKENDS = ['local', 'nemoclaw'];

/**
 * Options are parsed strictly and every bad value throws. A silently-NaN limit is worse than a
 * crash: `x > NaN` is always false, so a malformed --max-files disables the diff-size guard, and
 * `attempt <= NaN` skips the retry loop entirely while still reporting an ordinary "failed" run.
 */
export function parseCommon(argv, extra = {}) {
  const o = { ...DEFAULTS, ...extra, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    const num = (opts = {}) => {
      const { min = 0, integer = true } = opts;
      const raw = val();
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${a} expects a number, got ${JSON.stringify(raw)}`);
      if (integer && !Number.isInteger(n)) throw new Error(`${a} expects a whole number, got ${JSON.stringify(raw)}`);
      if (n < min) throw new Error(`${a} must be >= ${min}, got ${n}`);
      return n;
    };
    const oneOf = (allowed) => {
      const v = val();
      if (!allowed.includes(v)) throw new Error(`${a} must be one of ${allowed.join(' | ')}, got ${JSON.stringify(v)}`);
      return v;
    };
    switch (a) {
      case '--app-root': o.appRoot = val(); break;
      case '--url': o.url = val(); break;
      case '--scan-cmd': o.scanCmd = val(); break;
      case '--func-cmd': o.funcCmd = val(); break;
      case '--build-cmd': o.buildCmd = val(); break;
      case '--serve-cmd': o.serveCmd = val(); break;
      case '--agent-backend': o.agentBackend = oneOf(AGENT_BACKENDS); break;
      case '--exec-backend': o.execBackend = oneOf(EXEC_BACKENDS); break;
      case '--sandbox': o.sandbox = val(); break;
      case '--remote-app-root': o.remoteAppRoot = val(); break;
      case '--agent-bin': o.agentBin = val(); break;
      case '--agent-config': o.agentConfig = val(); break;
      case '--agent-state-dir': o.agentStateDir = val(); break;
      case '--model': o.model = val(); break;
      case '--thinking': o.thinking = val(); break;
      case '--max-attempts': o.maxAttempts = num({ min: 1 }); break;
      case '--turn-timeout': o.turnTimeout = num({ min: 1 }); break;
      case '--out-dir': o.outDir = val(); break;
      case '--keep-failed': o.keepFailed = true; break;
      case '--restore': o.restore = true; break;
      case '--max-added-lines': o.maxAddedLines = num({ min: 0 }); break;
      case '--max-removed-lines': o.maxRemovedLines = num({ min: 0 }); break;
      case '--max-files': o.maxFiles = num({ min: 1 }); break;
      case '--judge-url': o.judgeUrl = val(); break;
      case '--judge-model': o.judgeModel = val(); break;
      case '--judge-key': o.judgeKey = val(); break;
      case '--no-judge': o.judgeUrl = ''; break;
      case '--verbose': case '-v': o.verbose = true; break;
      case '--violation': o.violationFile = val(); break;
      case '--scan': o.scanFile = val(); break;
      case '--id': o.id = val(); break;
      case '--runs': o.runs = num({ min: 1 }); break;
      case '--ids': o.ids = val().split(',').map((s) => s.trim()).filter(Boolean); break;   // val() throws when the value is missing
      case '-h': case '--help': o.help = true; break;
      default: o._.push(a);
    }
  }
  return o;
}

/** Load one violation from --violation / --scan / stdin. Accepts raw axe-core output (AxeResults, Result[], or one Result),
 *  our schema-1.0 document, or our single violation object. Use --id to choose when the input holds several. */
export function loadViolation(o) {
  let raw;
  if (o.violationFile && o.violationFile !== '-') raw = readFileSync(o.violationFile, 'utf8');
  else if (o.scanFile) raw = readFileSync(o.scanFile, 'utf8');
  else raw = readFileSync(0, 'utf8');
  return pickViolation(JSON.parse(raw), o.id, { appUrl: o.url });
}
