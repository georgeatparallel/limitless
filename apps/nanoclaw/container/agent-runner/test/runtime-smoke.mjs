// Run in a disposable agent image with --add-host search.parallel.ai:127.0.0.1
// and NANOCLAW_RUNTIME_SMOKE=1. Model responses are scripted; the SDK, MCP
// transport, production runner and output protocol are real.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { SEARCH_USER_AGENT } from '../dist/search.js';

assert.equal(
  process.env.NANOCLAW_RUNTIME_SMOKE,
  '1',
  'Use a disposable agent image',
);
assert.equal(
  (await lookup('search.parallel.ai')).address,
  '127.0.0.1',
  'Redirect MCP to the local fixture',
);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runtime-'));
const key = path.join(temporary, 'key.pem');
const cert = path.join(temporary, 'cert.pem');
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-subj',
    '/CN=search.parallel.ai',
    '-addext',
    'subjectAltName=DNS:search.parallel.ai',
  ],
  { stdio: 'ignore' },
);
fs.mkdirSync('/workspace/group', { recursive: true });
fs.mkdirSync('/workspace/ipc/input', { recursive: true });

const searchName = 'mcp__parallel-search__web_search';
const fetchName = 'mcp__parallel-search__web_fetch';
const sourceUrl = 'https://example.org/reference';
let scenario, requests, modelTurns, processUnderTest, cancellationObserved;
const summaries = [];
const toolSchema = {
  type: 'object',
  properties: {
    objective: { type: 'string' },
    search_queries: { type: 'array', items: { type: 'string' } },
    urls: { type: 'array', items: { type: 'string' } },
  },
};
const mcp = https.createServer(
  { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
  async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const body = JSON.parse(raw);
    requests.push({
      method: body.method,
      url: req.url,
      userAgent: req.headers['user-agent'],
      authorization: req.headers.authorization,
      params: body.params,
    });
    if (!('id' in body)) {
      res.writeHead(202).end();
      return;
    }
    let result;
    if (body.method === 'initialize')
      result = {
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0' },
      };
    else if (body.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'web_search',
            description: 'Search the web for sources',
            inputSchema: toolSchema,
          },
          {
            name: 'web_fetch',
            description: 'Fetch source pages',
            inputSchema: toolSchema,
          },
        ],
      };
    else if (body.method === 'tools/call') {
      if (scenario === 'cancel') {
        res.on('close', () => {
          cancellationObserved = true;
        });
        process.kill(-processUnderTest.pid, 'SIGTERM');
        return;
      }
      if (scenario === 'timeout') return;
      result =
        scenario === 'error'
          ? {
              isError: true,
              content: [{ type: 'text', text: 'fixture search failure' }],
            }
          : {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    url: sourceUrl,
                    excerpts: ['Verified fixture source about the release.'],
                  }),
                },
              ],
            };
    } else result = {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  },
);
await new Promise((resolve) => mcp.listen(443, '0.0.0.0', resolve));

function respond(res, request, content, stopReason) {
  const message = {
    id: `msg_fixture_${modelTurns}`,
    type: 'message',
    role: 'assistant',
    model: request.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 20 },
  };
  if (!request.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(message));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', {
    message: { ...message, content: [], stop_reason: null },
  });
  content.forEach((block, index) => {
    event('content_block_start', {
      index,
      content_block:
        block.type === 'text'
          ? { type: 'text', text: '' }
          : { ...block, input: {} },
    });
    event('content_block_delta', {
      index,
      delta:
        block.type === 'text'
          ? { type: 'text_delta', text: block.text }
          : {
              type: 'input_json_delta',
              partial_json: JSON.stringify(block.input),
            },
    });
    event('content_block_stop', { index });
  });
  event('message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 20 },
  });
  event('message_stop', {});
  res.end();
}
const model = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (req.url.includes('count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"input_tokens":20}');
    return;
  }
  if (!req.url.startsWith('/v1/messages')) {
    res.writeHead(200).end('{}');
    return;
  }
  const body = JSON.parse(raw);
  const names = body.tools?.map((tool) => tool.name) || [];
  modelTurns++;
  const useSearch = [
    'success',
    'error',
    'timeout',
    'cancel',
    'saved-mcp',
  ].includes(scenario);
  const selectedSearch =
    scenario === 'saved-mcp' ? 'mcp__saved-search__web_search' : searchName;
  if (useSearch && modelTurns === 1) {
    assert.ok(
      names.includes(selectedSearch),
      `Missing search tool in ${scenario}: ${names.join(', ')}`,
    );
    if (scenario !== 'saved-mcp') {
      assert.ok(
        !names.includes('WebSearch') && !names.includes('WebFetch'),
        'No implicit Claude fallback',
      );
    }
    respond(
      res,
      body,
      [
        {
          type: 'tool_use',
          id: 'toolu_search',
          name: selectedSearch,
          input: {
            objective: 'Find a documented release',
            search_queries: ['example reference release'],
          },
        },
      ],
      'tool_use',
    );
  } else if (scenario === 'success' && modelTurns === 2) {
    assert.ok(
      JSON.stringify(body.messages).includes(sourceUrl),
      'Search result must reach the model',
    );
    respond(
      res,
      body,
      [
        {
          type: 'tool_use',
          id: 'toolu_fetch',
          name: fetchName,
          input: { urls: [sourceUrl] },
        },
      ],
      'tool_use',
    );
  } else {
    if (scenario === 'success' || scenario === 'saved-mcp')
      assert.ok(JSON.stringify(body.messages).includes(sourceUrl));
    if (scenario === 'error')
      assert.ok(
        JSON.stringify(body.messages).includes('fixture search failure'),
      );
    if (scenario === 'timeout')
      assert.match(JSON.stringify(body.messages), /timed? ?out|timeout/i);
    if (['claude', 'credentials', 'saved-policy', 'off'].includes(scenario))
      assert.ok(!names.includes(searchName));
    if (scenario === 'off')
      assert.ok(!names.includes('WebSearch') && !names.includes('WebFetch'));
    respond(
      res,
      body,
      [{ type: 'text', text: `fixture ${scenario} complete ${sourceUrl}` }],
      'end_turn',
    );
  }
});
await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));

try {
  for (scenario of [
    'success',
    'error',
    'timeout',
    'cancel',
    'claude',
    'credentials',
    'saved-policy',
    'off',
    'saved-mcp',
  ]) {
    requests = [];
    modelTurns = 0;
    cancellationObserved = false;
    const home = path.join(temporary, scenario);
    const configDir = path.join(home, '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    const projectMcp = '/workspace/group/.mcp.json';
    const projectSettings = '/workspace/group/.claude/settings.json';
    fs.rmSync(projectMcp, { force: true });
    fs.rmSync(projectSettings, { force: true });
    fs.rmSync('/workspace/ipc/input/_close', { force: true });
    if (scenario === 'saved-policy')
      fs.writeFileSync(
        path.join(configDir, 'settings.json'),
        JSON.stringify({ permissions: { deny: ['mcp__parallel-search__*'] } }),
      );
    if (scenario === 'saved-mcp') {
      fs.mkdirSync(path.dirname(projectSettings), { recursive: true });
      fs.writeFileSync(
        projectSettings,
        JSON.stringify({ enableAllProjectMcpServers: true }),
      );
      fs.writeFileSync(
        projectMcp,
        JSON.stringify({
          mcpServers: {
            'saved-search': {
              type: 'http',
              url: 'https://search.parallel.ai/saved-mcp',
              headers: { 'User-Agent': 'saved-provider' },
            },
          },
        }),
      );
    }
    const env = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.address().port}`,
      ANTHROPIC_API_KEY: 'scripted-model-fixture',
      ANTHROPIC_AUTH_TOKEN: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      PARALLEL_API_KEY: '',
      NODE_EXTRA_CA_CERTS: cert,
      ENABLE_TOOL_SEARCH: 'false',
      MCP_TOOL_TIMEOUT: '1000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      HTTPS_PROXY: '',
      HTTP_PROXY: '',
      ALL_PROXY: '',
      https_proxy: '',
      http_proxy: '',
      all_proxy: '',
    };
    processUnderTest = spawn(
      process.execPath,
      [new URL('../dist/index.js', import.meta.url).pathname],
      {
        env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let output = '',
      errors = '';
    processUnderTest.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('fixture ') && output.includes('complete'))
        fs.writeFileSync('/workspace/ipc/input/_close', '');
    });
    processUnderTest.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    processUnderTest.stdin.end(
      JSON.stringify({
        prompt: 'Search and fetch a reference, then cite the URL.',
        groupFolder: 'smoke',
        chatJid: 'smoke@test',
        isMain: true,
        webSearch: ['claude', 'off'].includes(scenario) ? scenario : 'auto',
        hasSearchCredentials: scenario === 'credentials',
      }),
    );
    const deadline = setTimeout(() => {
      process.kill(-processUnderTest.pid, 'SIGKILL');
    }, 30000);
    const [code, signal] = await once(processUnderTest, 'exit');
    clearTimeout(deadline);
    if (scenario === 'cancel') {
      assert.equal(signal, 'SIGTERM', errors);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(
        cancellationObserved,
        'Cancellation must close the live MCP request',
      );
    } else {
      assert.equal(code, 0, `${scenario}: ${errors}\n${output}`);
      assert.ok(
        output.includes(`fixture ${scenario} complete ${sourceUrl}`),
        output,
      );
      assert.ok(
        output.includes('---NANOCLAW_OUTPUT_START---'),
        'Use the production output consumer',
      );
    }
    const calls = requests.filter((request) => request.method === 'tools/call');
    if (scenario === 'success')
      assert.deepEqual(
        calls.map((call) => call.params.name),
        ['web_search', 'web_fetch'],
      );
    if (['claude', 'credentials', 'saved-policy', 'off'].includes(scenario))
      assert.equal(requests.length, 0);
    for (const request of requests) {
      assert.equal(request.authorization, undefined);
      assert.equal(
        request.url,
        scenario === 'saved-mcp' ? '/saved-mcp' : '/mcp',
      );
      assert.equal(
        request.userAgent,
        scenario === 'saved-mcp' ? 'saved-provider' : SEARCH_USER_AGENT,
      );
    }
    summaries.push({
      scenario,
      model: 'scripted',
      caller: 'production runner and real Claude SDK',
      modelTurns,
      mcpMethods: requests.map((request) => request.method),
      calls: calls.map((call) => call.params.name),
    });
  }
  console.log(
    JSON.stringify({ status: 'passed', scenarios: summaries }, null, 2),
  );
} finally {
  model.closeAllConnections();
  mcp.closeAllConnections();
  model.close();
  mcp.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
