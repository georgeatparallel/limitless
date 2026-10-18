import fs from 'fs';
import os from 'os';
import path from 'path';
import type { McpHttpServerConfig } from '@anthropic-ai/claude-agent-sdk';

export type SearchProvider = 'auto' | 'parallel' | 'claude' | 'off';

const SERVER_NAME = 'parallel-search';
export const SEARCH_URL = 'https://search.parallel.ai/mcp';
export const SEARCH_USER_AGENT =
  'limitless-nanoclaw (+https://github.com/LIMITLESS-LONGEVITY/limitless)';

interface SearchOptions {
  mcpServers: Record<string, McpHttpServerConfig>;
  allowedTools: string[];
  disallowedTools: string[];
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Expected a JSON object');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    // Do not turn broken saved configuration into an anonymous connection.
    throw new Error(`Cannot read saved Claude configuration: ${file}`, {
      cause: error,
    });
  }
}

function nonempty(value: unknown): boolean {
  return !!value && typeof value === 'object' && Object.keys(value).length > 0;
}

/** Conservatively leave existing SDK configuration in charge of web access. */
function hasSavedChoice(cwd: string, configDir: string): boolean {
  const settings = [
    path.join(configDir, 'settings.json'),
    '/etc/claude-code/managed-settings.json',
  ];
  const mcpFiles: string[] = ['/etc/claude-code/managed-mcp.json'];
  let directory = path.resolve(cwd);
  for (;;) {
    settings.push(path.join(directory, '.claude', 'settings.json'));
    settings.push(path.join(directory, '.claude', 'settings.local.json'));
    mcpFiles.push(path.join(directory, '.mcp.json'));
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const file of settings) {
    const saved = readJson(file);
    if (!saved) continue;
    // Even an unrelated custom MCP server or permission policy is an explicit
    // setup. Never grant this skill additional web tools on top of that policy.
    if (Object.keys(saved).some((key) => key !== 'env')) return true;
    const env = saved.env;
    if (
      env &&
      typeof env === 'object' &&
      Object.keys(env).some((key) =>
        /SEARCH|PARALLEL|BRAVE|TAVILY|EXA|SERPER/i.test(key),
      )
    )
      return true;
  }
  for (const file of mcpFiles) {
    if (nonempty(readJson(file)?.mcpServers)) return true;
  }
  // Claude's user/local MCP registrations are stored separately from settings.
  for (const file of [
    path.join(configDir, '.config.json'),
    path.join(configDir, '.claude.json'),
    path.join(path.dirname(configDir), '.claude.json'),
  ]) {
    const user = readJson(file);
    const projects = user?.projects as
      Record<string, Record<string, unknown>> | undefined;
    if (nonempty(user?.mcpServers) || nonempty(user?.disabledMcpServers))
      return true;
    if (
      projects &&
      Object.values(projects).some(
        (project) =>
          nonempty(project?.mcpServers) ||
          nonempty(project?.disabledMcpServers) ||
          nonempty(project?.allowedTools),
      )
    )
      return true;
  }
  return false;
}

/** Same resolver for every group; selections come from the host-wide setting. */
export function resolveSearch(
  provider: SearchProvider = 'auto',
  hasSearchCredentials = false,
  cwd = '/workspace/group',
  configDir = process.env.CLAUDE_CONFIG_DIR ||
    path.join(os.homedir(), '.claude'),
): SearchOptions {
  if (!['auto', 'parallel', 'claude', 'off'].includes(provider)) {
    throw new Error(
      'NANOCLAW_WEB_SEARCH must be auto, parallel, claude, or off',
    );
  }
  if (provider === 'off') {
    return {
      mcpServers: {},
      allowedTools: [],
      disallowedTools: ['WebSearch', 'WebFetch', `mcp__${SERVER_NAME}__*`],
    };
  }
  if (
    provider === 'claude' ||
    (provider === 'auto' &&
      (hasSearchCredentials || !!process.env.PARALLEL_API_KEY)) ||
    hasSavedChoice(cwd, configDir)
  ) {
    return { mcpServers: {}, allowedTools: [], disallowedTools: [] };
  }
  return {
    mcpServers: {
      [SERVER_NAME]: {
        type: 'http',
        url: SEARCH_URL,
        headers: { 'User-Agent': SEARCH_USER_AGENT },
      },
    },
    allowedTools: [
      `mcp__${SERVER_NAME}__web_search`,
      `mcp__${SERVER_NAME}__web_fetch`,
    ],
    // No silent fallback to an account-backed provider after an MCP error.
    disallowedTools: ['WebSearch', 'WebFetch'],
  };
}
