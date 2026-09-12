#!/usr/bin/env node
/**
 * Misbehaving OpenAI-compatible reviewer, for proving the reviewer gate fails closed.
 *
 *   node pipeline/tests/judge_stub_server.mjs <port> <mode>
 *
 * Serves POST /v1/chat/completions on 127.0.0.1:<port> (0 = any free port). Once bound it prints
 * one line "listening <port>" on stdout; each request is logged on stderr. It exits by itself after
 * STUB_LIFETIME_MS so a crashed test script never leaves it running.
 */
import http from 'node:http';

const STUB_LIFETIME_MS = 120000;

const completion = (content) => ({
  id: 'chatcmpl-stub', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'stub',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
});

const MODES = {
  badjson: () => [200, completion('Looks good to me, ship it!')],
  brokenjson: () => [200, completion('{"verdict": "pass", reasons: [}')],
  badverdict: () => [200, completion('{"verdict":"approved","reasons":[]}')],
  http500: () => [500, { error: { message: 'stub internal server error', type: 'server_error' } }],
  nocontent: () => [200, { choices: [] }],
  pass: () => [200, completion('{"verdict":"pass","reasons":[]}')],
  fail: () => [200, completion('{"verdict":"fail","reasons":["removes a handler"]}')],
};

const [portArg, mode] = process.argv.slice(2);
const port = Number(portArg);
if (!Number.isInteger(port) || port < 0 || port > 65535 || !Object.hasOwn(MODES, mode)) {
  console.error(`usage: node pipeline/tests/judge_stub_server.mjs <port> <${Object.keys(MODES).join('|')}>`);
  process.exit(2);
}

const server = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `no route ${req.method} ${req.url}` } }));
      return;
    }
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* logged below as unparseable */ }
    console.error(`stub[${mode}]: POST ${req.url} model=${JSON.stringify(parsed.model ?? null)} reasoning_effort=${JSON.stringify(parsed.reasoning_effort ?? null)} bytes=${body.length}`);
    const [status, payload] = MODES[mode]();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

server.on('error', (e) => { console.error(`stub[${mode}]: ${e.message}`); process.exit(1); });
server.listen(port, '127.0.0.1', () => { process.stdout.write(`listening ${server.address().port}\n`); });
setTimeout(() => { console.error(`stub[${mode}]: lifetime of ${STUB_LIFETIME_MS / 1000}s reached, exiting`); process.exit(0); }, STUB_LIFETIME_MS).unref();
