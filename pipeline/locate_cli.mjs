#!/usr/bin/env node
/**
 * Thin CLI over Path 2's own source localization, so the Python patch generator reuses it.
 *   node pipeline/locate_cli.mjs <appRoot>  < violation.json  ->  locate() result JSON on stdout
 * The violation on stdin is in locate.mjs's shape: {id, rule_id, selector, html, repro, source:{file}}.
 */
import { locate } from '../remediation/src/lib/locate.mjs';
import { AppFs } from '../remediation/src/lib/app.mjs';

const appRoot = process.argv[2];
if (!appRoot) { console.error('usage: node pipeline/locate_cli.mjs <appRoot> < violation.json'); process.exit(2); }

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

const app = new AppFs({ appRoot, execBackend: 'local' });
const result = await locate(app, JSON.parse(input));
process.stdout.write(JSON.stringify(result));
