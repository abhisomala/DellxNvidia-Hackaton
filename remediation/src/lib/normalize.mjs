/**
 * Accept violations in any of these shapes and normalize to the schema-1.0 document the harness uses internally:
 *   1. raw axe-core `AxeResults`   { violations: Result[], passes, incomplete, url, timestamp, testEngine, ... }
 *   2. raw axe-core `Result[]`     [ { id, impact, tags, description, help, helpUrl, nodes: NodeResult[] } ]
 *   3. a single raw axe `Result`   { id, tags, nodes: [...] }
 *   4. our scan document           { schema_version: "1.0", scan, violations: [...] }
 *   5. our single violation        { rule_id, selector, ... }
 * axe's Result x NodeResult pairs become one violation each: id = `${rule}#${nodeIndex}`.
 */

function flattenTarget(target) {
  // UnlabelledFrameSelector = CrossTreeSelector[]; each is a string or (shadow DOM) string[]
  if (!Array.isArray(target)) return String(target ?? '');
  return target.map((t) => (Array.isArray(t) ? t.join(' >>> ') : String(t))).join(' ');
}

function routeOf(url) {
  try { return new URL(url).pathname || '/'; } catch { return '/'; }
}

export function isAxeResults(doc) { return !!doc && Array.isArray(doc.violations) && doc.violations.every(isAxeResult) && (doc.testEngine || doc.passes || doc.url || doc.violations.some((v) => v.nodes)); }
export function isAxeResult(v) { return !!v && typeof v.id === 'string' && Array.isArray(v.nodes) && !('rule_id' in v); }
/** Teammate's MongoDB `scans` document: { _id?, timestamp, target_app, violations: [{ rule_id, selector, severity, description, source_file, ... }] } */
export function isMongoScan(doc) { return !!doc && Array.isArray(doc.violations) && ('target_app' in doc || doc.violations.some(isMongoViolation)) && !doc.schema_version; }
export function isMongoViolation(v) { return !!v && typeof v.rule_id === 'string' && ('severity' in v || 'source_file' in v) && !('impact' in v && 'html' in v); }
const SEVERITY_TO_IMPACT = { low: 'minor', minor: 'minor', medium: 'moderate', moderate: 'moderate', high: 'serious', serious: 'serious', critical: 'critical' };
export function mongoViolationToOurs(v, i = 0, route = '/') {
  const impact = SEVERITY_TO_IMPACT[String(v.severity || v.impact || '').toLowerCase()] || (v.impact || 'unknown');
  return {
    id: v.id || `${v.rule_id}#${i}`,
    rule_id: v.rule_id,
    source_tool: v.source_tool || 'axe',
    impact,
    wcag: v.wcag || [],
    description: v.description || '',
    help: v.help || v.failure_summary || v.description || '',
    help_url: v.help_url || '',
    route: v.route || route,
    selector: v.selector,
    html: v.html || '',
    source: v.source || (v.source_file ? { file: v.source_file, line: v.source_line } : undefined),
    repro: v.repro,
    mongo: { severity: v.severity, source_file: v.source_file },
  };
}

export function isOurDoc(doc) { return !!doc && Array.isArray(doc.violations) && doc.violations.every((v) => v && typeof v.rule_id === 'string'); }
export function isOurViolation(v) { return !!v && typeof v.rule_id === 'string' && typeof v.selector === 'string'; }

export function axeResultToViolations(v, { route = '/', startIndex = 0 } = {}) {
  return (v.nodes || []).map((node, i) => ({
    id: `${v.id}#${startIndex + i}`,
    rule_id: v.id,
    source_tool: 'axe',
    impact: node.impact || v.impact || 'unknown',
    wcag: (v.tags || []).filter((t) => /^wcag/.test(t)),
    description: v.help || v.description || '',
    help: (node.failureSummary || v.description || '').replace(/\s+/g, ' ').trim(),
    help_url: v.helpUrl || '',
    route,
    selector: flattenTarget(node.target),
    html: node.html || '',
    axe: {
      description: v.description,
      xpath: node.xpath,
      checks: ['any', 'all', 'none'].flatMap((k) => (node[k] || []).map((c) => ({ kind: k, id: c.id, message: c.message }))),
    },
  }));
}

/** Normalize any accepted shape into { schema_version, scan, violations } (never mutates the input). */
export function normalizeScan(doc, { appUrl = '' } = {}) {
  if (isOurDoc(doc) && doc.schema_version) return doc;
  if (isMongoScan(doc)) {
    const route = routeOf(appUrl);
    return {
      schema_version: '1.0',
      scan: { tool: 'mongo-scan', app_url: appUrl, timestamp: doc.timestamp ? String(doc.timestamp) : new Date().toISOString(), target_app: doc.target_app, mongo_scan_id: doc._id ? String(doc._id.$oid || doc._id) : undefined },
      violations: doc.violations.map((v, i) => (isMongoViolation(v) ? mongoViolationToOurs(v, i, route) : v)),
    };
  }
  if (isAxeResults(doc)) {
    const route = routeOf(doc.url || appUrl);
    const violations = doc.violations.flatMap((v) => axeResultToViolations(v, { route }));
    return {
      schema_version: '1.0',
      scan: { tool: doc.testEngine ? `${doc.testEngine.name}@${doc.testEngine.version}` : 'axe-core', app_url: doc.url || appUrl, timestamp: doc.timestamp || new Date().toISOString() },
      violations,
    };
  }
  if (Array.isArray(doc) && doc.every(isAxeResult)) {
    return { schema_version: '1.0', scan: { tool: 'axe-core', app_url: appUrl, timestamp: new Date().toISOString() }, violations: doc.flatMap((v) => axeResultToViolations(v, { route: routeOf(appUrl) })) };
  }
  if (isOurDoc(doc)) return { schema_version: '1.0', scan: doc.scan || { tool: 'unknown', app_url: appUrl, timestamp: new Date().toISOString() }, violations: doc.violations };
  throw new Error('unrecognized scan document: expected axe-core AxeResults, an axe Result[] array, a MongoDB scans document ({target_app, violations:[{rule_id, selector, severity, description, source_file}]}), or a schema-1.0 document');
}

/** Pick one violation out of any accepted shape. `id` may be "rule#index", a bare rule id (first node), or a CSS selector. */
export function pickViolation(doc, id, { appUrl = '' } = {}) {
  if (isOurViolation(doc) && !isMongoViolation(doc)) return { violation: doc, scan: null };
  if (isMongoViolation(doc) && !Array.isArray(doc.violations)) return { violation: mongoViolationToOurs(doc, 0, routeOf(appUrl)), scan: null };
  if (isAxeResult(doc)) {
    const vs = axeResultToViolations(doc, { route: routeOf(appUrl) });
    if (!vs.length) throw new Error(`axe result ${doc.id} has no nodes`);
    const v = id ? vs.find((x) => x.id === id || x.selector === id) : vs[0];
    if (!v) throw new Error(`no node matches "${id}" in axe result ${doc.id}`);
    return { violation: v, scan: null };
  }
  const scan = normalizeScan(doc, { appUrl });
  if (!id) throw new Error(`input holds ${scan.violations.length} violation(s); pass --id <rule#index | rule | selector> (available: ${scan.violations.map((v) => v.id).join(', ')})`);
  const v = scan.violations.find((x) => x.id === id) || scan.violations.find((x) => x.rule_id === id) || scan.violations.find((x) => x.selector === id);
  if (!v) throw new Error(`violation "${id}" not found (available: ${scan.violations.map((v) => v.id).join(', ')})`);
  return { violation: v, scan };
}
