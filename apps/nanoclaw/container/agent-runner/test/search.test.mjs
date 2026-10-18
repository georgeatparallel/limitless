import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import {
  resolveSearch,
  SEARCH_URL,
  SEARCH_USER_AGENT,
} from '../dist/search.js';

let root, cwd, configDir, ambientKey;
beforeEach(() => {
  ambientKey = process.env.PARALLEL_API_KEY;
  delete process.env.PARALLEL_API_KEY;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-search-'));
  cwd = path.join(root, 'group');
  configDir = path.join(root, 'user', '.claude');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const original = fs.readFileSync;
  // Isolate machine policy while exercising actual files for saved choices.
  mock.method(fs, 'readFileSync', (file, ...args) => {
    if (String(file).startsWith('/etc/claude-code/')) {
      throw Object.assign(new Error('test machine has no managed policy'), {
        code: 'ENOENT',
      });
    }
    return original(file, ...args);
  });
});
afterEach(() => {
  mock.restoreAll();
  if (ambientKey === undefined) delete process.env.PARALLEL_API_KEY;
  else process.env.PARALLEL_API_KEY = ambientKey;
  fs.rmSync(root, { recursive: true, force: true });
});
const resolve = (provider, credentials = false) =>
  resolveSearch(provider, credentials, cwd, configDir);
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

test('fresh no-key installations use anonymous Parallel and cannot fall back to Claude', () => {
  const options = resolve();
  const server = options.mcpServers['parallel-search'];
  assert.equal(server.type, 'http');
  assert.equal(server.url, SEARCH_URL);
  assert.equal(server.headers['User-Agent'], SEARCH_USER_AGENT);
  assert.equal(server.headers.Authorization, undefined);
  assert.deepEqual(options.allowedTools, [
    'mcp__parallel-search__web_search',
    'mcp__parallel-search__web_fetch',
  ]);
  assert.deepEqual(options.disallowedTools, ['WebSearch', 'WebFetch']);
});
test('generated session environment is not mistaken for a saved search choice', () => {
  save(path.join(configDir, 'settings.json'), {
    env: { AGENT_ROLE: 'architect', GH_TOKEN: '' },
  });
  assert.ok(resolve().mcpServers['parallel-search']);
});
test('host choice and authenticated installations retain existing tools', () => {
  assert.deepEqual(resolve('claude'), {
    mcpServers: {},
    allowedTools: [],
    disallowedTools: [],
  });
  assert.deepEqual(resolve('auto', true), {
    mcpServers: {},
    allowedTools: [],
    disallowedTools: [],
  });
  assert.equal(resolve('off').mcpServers['parallel-search'], undefined);
  assert.ok(resolve('off').disallowedTools.includes('WebSearch'));
  assert.throws(() => resolve('unknown'), /NANOCLAW_WEB_SEARCH/);
});
test('ambient search credentials are preserved unless anonymously overridden', () => {
  process.env.PARALLEL_API_KEY = 'fixture-key';
  assert.deepEqual(resolve().mcpServers, {});
  assert.ok(resolve('parallel').mcpServers['parallel-search']);
});
test('custom config directories and local SDK settings preserve saved choices', () => {
  const file = path.join(configDir, '.claude.json');
  save(file, {
    mcpServers: { saved: { type: 'http', url: 'https://example.org/mcp' } },
  });
  assert.deepEqual(resolve().mcpServers, {});
  fs.unlinkSync(file);
  save(path.join(cwd, '.claude', 'settings.local.json'), {
    permissions: { deny: ['WebSearch'] },
  });
  assert.deepEqual(resolve().mcpServers, {});
});
for (const settings of [
  { permissions: { deny: ['WebSearch', 'mcp__*'] } },
  { permissions: { allow: ['WebSearch'] } },
  { permissions: { ask: ['WebFetch'] } },
  { disabledMcpjsonServers: ['parallel-search'] },
  { enableAllProjectMcpServers: false },
  { allowedMcpServers: [] },
  { env: { PARALLEL_API_KEY: 'saved-test-key' } },
]) {
  test(`saved SDK policy remains authoritative: ${Object.keys(settings).join(', ')}`, () => {
    const file = path.join(configDir, 'settings.json');
    save(file, settings);
    const original = fs.readFileSync(file, 'utf8');
    assert.deepEqual(resolve(), {
      mcpServers: {},
      allowedTools: [],
      disallowedTools: [],
    });
    assert.deepEqual(resolve('parallel'), {
      mcpServers: {},
      allowedTools: [],
      disallowedTools: [],
    });
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });
}
test('project, ancestor, user and local MCP registrations are never replaced', () => {
  for (const file of [
    path.join(cwd, '.mcp.json'),
    path.join(root, '.mcp.json'),
  ]) {
    save(file, {
      mcpServers: {
        existing: { type: 'http', url: 'https://example.org/mcp' },
      },
    });
    assert.deepEqual(resolve().mcpServers, {});
    fs.unlinkSync(file);
  }
  save(path.join(root, 'user', '.claude.json'), {
    projects: {
      [cwd]: {
        mcpServers: { 'parallel-search': { url: 'https://example.org/mcp' } },
      },
    },
  });
  assert.deepEqual(resolve().mcpServers, {});
});
test('invalid explicit settings fail without activating a different provider', () => {
  fs.writeFileSync(path.join(configDir, 'settings.json'), '{broken');
  assert.throws(() => resolve(), /Cannot read saved Claude configuration/);
});
