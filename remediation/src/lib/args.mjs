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
  agentBackend: 'local',       // local | nemoclaw | openclaw
  execBackend: 'local',        // local | nemoclaw   (where git/build run; the sandbox when the app lives there)
  sandbox: '',                 // nemoclaw sandbox name
  remoteAppRoot: '',           // app path inside the sandbox (exec/agent backend = nemoclaw)
  agentBin: join(REMEDIATION_DIR, 'bin', 'openclaw'),
  agentConfig: join(REMEDIATION_DIR, 'config', 'openclaw.local.json'),
  agentStateDir: join(REMEDIATION_DIR, '.state'),
  model: '',                   // optional --model override for the agent turn
  thinking: '',                // optional --thinking level
  maxAttempts: 3,
  turnTimeout: 420,
  outDir: join(REMEDIATION_DIR, 'out'),
  keepFailed: false,
  verbose: false,
  maxAddedLines: 80,       // diff-size guard: a one-rule fix should be small
  maxRemovedLines: 40,     // and must not drop existing code (whole-file rewrites are allowed but checked)
  maxFiles: 2,
  judgeUrl: '',            // OpenAI-compatible base URL for the read-only reviewer pass ('' = off)
  judgeModel: '',
  judgeKey: '',
};

export function parseCommon(argv, extra = {}) {
  const o = { ...DEFAULTS, ...extra, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    switch (a) {
      case '--app-root': o.appRoot = val(); break;
      case '--url': o.url = val(); break;
      case '--scan-cmd': o.scanCmd = val(); break;
      case '--func-cmd': o.funcCmd = val(); break;
      case '--build-cmd': o.buildCmd = val(); break;
      case '--serve-cmd': o.serveCmd = val(); break;
      case '--agent-backend': o.agentBackend = val(); break;
      case '--exec-backend': o.execBackend = val(); break;
      case '--sandbox': o.sandbox = val(); break;
      case '--remote-app-root': o.remoteAppRoot = val(); break;
      case '--agent-bin': o.agentBin = val(); break;
      case '--agent-config': o.agentConfig = val(); break;
      case '--agent-state-dir': o.agentStateDir = val(); break;
      case '--model': o.model = val(); break;
      case '--thinking': o.thinking = val(); break;
      case '--max-attempts': o.maxAttempts = Number(val()); break;
      case '--turn-timeout': o.turnTimeout = Number(val()); break;
      case '--out-dir': o.outDir = val(); break;
      case '--keep-failed': o.keepFailed = true; break;
      case '--restore': o.restore = true; break;
      case '--max-added-lines': o.maxAddedLines = Number(val()); break;
      case '--max-removed-lines': o.maxRemovedLines = Number(val()); break;
      case '--max-files': o.maxFiles = Number(val()); break;
      case '--judge-url': o.judgeUrl = val(); break;
      case '--judge-model': o.judgeModel = val(); break;
      case '--judge-key': o.judgeKey = val(); break;
      case '--no-judge': o.judgeUrl = ''; break;
      case '--verbose': case '-v': o.verbose = true; break;
      case '--violation': o.violationFile = val(); break;
      case '--scan': o.scanFile = val(); break;
      case '--id': o.id = val(); break;
      case '--runs': o.runs = Number(val()); break;
      case '--ids': o.ids = val().split(',').map((s) => s.trim()).filter(Boolean); break;
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
