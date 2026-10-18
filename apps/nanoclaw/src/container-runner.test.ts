import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock @octokit/auth-app
vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(),
}));

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  ONECLI_URL: 'http://localhost:10254',
  ONECLI_API_KEY: '',
  MONOREPO_PATH: '',
  WORKTREE_BASE: '/tmp/nanoclaw-worktrees',
  TIMEZONE: 'America/Los_Angeles',
  WEB_SEARCH_PROVIDER: 'auto',
  HAS_SEARCH_CREDENTIALS: false,
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

// Mock OneCLI SDK
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    createAgent = vi.fn().mockResolvedValue({ id: 'test' });
    ensureAgent = vi
      .fn()
      .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
  },
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import { createAppAuth } from '@octokit/auth-app';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });

  it('forwards the host-wide search choice without adding a per-group selector', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);
    const input = JSON.parse(fakeProc.stdin.read().toString());
    expect(input).toMatchObject({ webSearch: 'auto', hasSearchCredentials: false });
    expect(input).not.toHaveProperty('PARALLEL_API_KEY');
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});

// Helper: find a -e FLAG=VALUE arg in docker spawn args
function findEnvArg(dockerArgs: string[], name: string): string | undefined {
  for (let i = 0; i + 1 < dockerArgs.length; i++) {
    if (dockerArgs[i] === '-e' && dockerArgs[i + 1]?.startsWith(`${name}=`)) {
      return dockerArgs[i + 1].slice(name.length + 1);
    }
  }
  return undefined;
}

describe('GitHub App token injection', () => {
  let spawnMock: ReturnType<typeof vi.fn>;
  const APP_ENV_KEYS = [
    'LIMITLESS_APP_ID', 'LIMITLESS_APP_INSTALLATION_ID',
    'LIMITLESS_APP_PRIVATE_KEY', 'LIMITLESS_APP_PRIVATE_KEY_PATH',
    'LIMITLESS_BOT_USER_ID',
    'MYTHOS_APP_ID', 'MYTHOS_APP_INSTALLATION_ID',
    'MYTHOS_APP_PRIVATE_KEY', 'MYTHOS_APP_PRIVATE_KEY_PATH',
    'MYTHOS_BOT_USER_ID',
    'GH_TOKEN',
  ] as const;

  beforeAll(async () => {
    const cp = await import('child_process');
    spawnMock = cp.spawn as ReturnType<typeof vi.fn>;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    spawnMock.mockClear();
    vi.mocked(createAppAuth).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const key of APP_ENV_KEYS) delete process.env[key];
  });

  it('happy path: injects App token and bot git identity when App creds are set', async () => {
    vi.mocked(createAppAuth).mockReturnValue(
      vi.fn().mockResolvedValue({ token: 'ghs_app_token_123', type: 'installation' }) as never,
    );
    process.env.LIMITLESS_APP_ID = '12345';
    process.env.LIMITLESS_APP_INSTALLATION_ID = '67890';
    process.env.LIMITLESS_APP_PRIVATE_KEY = 'fake-pem-key';
    process.env.LIMITLESS_BOT_USER_ID = '111111';

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const dockerArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(findEnvArg(dockerArgs, 'GH_TOKEN')).toBe('ghs_app_token_123');
    expect(findEnvArg(dockerArgs, 'GITHUB_TOKEN')).toBe('ghs_app_token_123');
    expect(findEnvArg(dockerArgs, 'GIT_AUTHOR_NAME')).toBe('limitless-agent[bot]');
    expect(findEnvArg(dockerArgs, 'GIT_AUTHOR_EMAIL')).toBe(
      '111111+limitless-agent[bot]@users.noreply.github.com',
    );
    expect(findEnvArg(dockerArgs, 'GIT_COMMITTER_NAME')).toBe('limitless-agent[bot]');
    expect(findEnvArg(dockerArgs, 'GIT_COMMITTER_EMAIL')).toBe(
      '111111+limitless-agent[bot]@users.noreply.github.com',
    );
  });

  it('fallback: CEO GH_TOKEN injected when App token generation throws', async () => {
    vi.mocked(createAppAuth).mockReturnValue(
      vi.fn().mockRejectedValue(new Error('JWT sign failed')) as never,
    );
    process.env.LIMITLESS_APP_ID = '12345';
    process.env.LIMITLESS_APP_INSTALLATION_ID = '67890';
    process.env.LIMITLESS_APP_PRIVATE_KEY = 'fake-key';
    process.env.GH_TOKEN = 'ceo-personal-pat';

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const { logger } = await import('./logger.js');
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'App token generation failed — falling back to CEO GH_TOKEN',
    );

    const dockerArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(findEnvArg(dockerArgs, 'GH_TOKEN')).toBe('ceo-personal-pat');
    // No bot identity on fallback
    expect(findEnvArg(dockerArgs, 'GIT_AUTHOR_NAME')).toBeUndefined();
  });

  it('MYTHOS routing: AGENT_ROLE=mythos-architect uses MYTHOS_APP_* and mythos-agents[bot]', async () => {
    vi.mocked(createAppAuth).mockReturnValue(
      vi.fn().mockResolvedValue({ token: 'ghs_mythos_token', type: 'installation' }) as never,
    );
    process.env.MYTHOS_APP_ID = '99999';
    process.env.MYTHOS_APP_INSTALLATION_ID = '88888';
    process.env.MYTHOS_APP_PRIVATE_KEY = 'mythos-key';
    process.env.MYTHOS_BOT_USER_ID = '222222';

    const mythosGroup = {
      ...testGroup,
      containerConfig: { envVars: { AGENT_ROLE: 'mythos-architect' } },
    };

    const resultPromise = runContainerAgent(mythosGroup, testInput, () => {});
    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(createAppAuth).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 99999, installationId: 88888 }),
    );
    const dockerArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(findEnvArg(dockerArgs, 'GIT_AUTHOR_EMAIL')).toBe(
      '222222+mythos-agents[bot]@users.noreply.github.com',
    );
  });

  it('LIMITLESS routing: AGENT_ROLE=paths-architect uses LIMITLESS_APP_* and limitless-agent[bot]', async () => {
    vi.mocked(createAppAuth).mockReturnValue(
      vi.fn().mockResolvedValue({ token: 'ghs_limitless_token', type: 'installation' }) as never,
    );
    process.env.LIMITLESS_APP_ID = '12345';
    process.env.LIMITLESS_APP_INSTALLATION_ID = '67890';
    process.env.LIMITLESS_APP_PRIVATE_KEY = 'limitless-key';
    process.env.LIMITLESS_BOT_USER_ID = '111111';

    const limitlessGroup = {
      ...testGroup,
      containerConfig: { envVars: { AGENT_ROLE: 'paths-architect' } },
    };

    const resultPromise = runContainerAgent(limitlessGroup, testInput, () => {});
    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(createAppAuth).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 12345, installationId: 67890 }),
    );
    const dockerArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(findEnvArg(dockerArgs, 'GIT_AUTHOR_EMAIL')).toBe(
      '111111+limitless-agent[bot]@users.noreply.github.com',
    );
  });

  it('no AGENT_ROLE defaults to LIMITLESS App creds', async () => {
    vi.mocked(createAppAuth).mockReturnValue(
      vi.fn().mockResolvedValue({ token: 'ghs_default_token', type: 'installation' }) as never,
    );
    process.env.LIMITLESS_APP_ID = '12345';
    process.env.LIMITLESS_APP_INSTALLATION_ID = '67890';
    process.env.LIMITLESS_APP_PRIVATE_KEY = 'limitless-key';
    process.env.LIMITLESS_BOT_USER_ID = '111111';

    // testGroup has no containerConfig — AGENT_ROLE is undefined
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(createAppAuth).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 12345 }),
    );
    const dockerArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(findEnvArg(dockerArgs, 'GH_TOKEN')).toBe('ghs_default_token');
  });

  it('PATH-only: reads PEM from filesystem when _PATH is set and inline is unset', async () => {
    const fs = (await import('fs')).default;
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === '/etc/nanoclaw/limitless-app.pem',
    );
    vi.mocked(fs.readFileSync).mockImplementation(
      ((p: string) =>
        p === '/etc/nanoclaw/limitless-app.pem'
          ? 'file-backed-pem-content'
          : '') as unknown as typeof fs.readFileSync,
    );
    vi.mocked(createAppAuth).mockReturnValue(
      vi.fn().mockResolvedValue({ token: 'ghs_from_file', type: 'installation' }) as never,
    );
    process.env.LIMITLESS_APP_ID = '12345';
    process.env.LIMITLESS_APP_INSTALLATION_ID = '67890';
    process.env.LIMITLESS_APP_PRIVATE_KEY_PATH = '/etc/nanoclaw/limitless-app.pem';
    process.env.LIMITLESS_BOT_USER_ID = '111111';

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(createAppAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 12345,
        installationId: 67890,
        privateKey: 'file-backed-pem-content',
      }),
    );
    const dockerArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(findEnvArg(dockerArgs, 'GH_TOKEN')).toBe('ghs_from_file');

    // Restore default fs mock behavior for subsequent tests
    vi.mocked(fs.existsSync).mockImplementation(() => false);
    vi.mocked(fs.readFileSync).mockImplementation(
      (() => '') as unknown as typeof fs.readFileSync,
    );
  });

  it('precedence: _PATH wins when both _PATH and _PRIVATE_KEY are set', async () => {
    const fs = (await import('fs')).default;
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === '/etc/nanoclaw/limitless-app.pem',
    );
    vi.mocked(fs.readFileSync).mockImplementation(
      ((p: string) =>
        p === '/etc/nanoclaw/limitless-app.pem'
          ? 'pem-from-file-should-win'
          : '') as unknown as typeof fs.readFileSync,
    );
    vi.mocked(createAppAuth).mockReturnValue(
      vi.fn().mockResolvedValue({ token: 'ghs_path_wins', type: 'installation' }) as never,
    );
    process.env.LIMITLESS_APP_ID = '12345';
    process.env.LIMITLESS_APP_INSTALLATION_ID = '67890';
    process.env.LIMITLESS_APP_PRIVATE_KEY = 'inline-pem-should-be-ignored';
    process.env.LIMITLESS_APP_PRIVATE_KEY_PATH = '/etc/nanoclaw/limitless-app.pem';
    process.env.LIMITLESS_BOT_USER_ID = '111111';

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(createAppAuth).toHaveBeenCalledWith(
      expect.objectContaining({ privateKey: 'pem-from-file-should-win' }),
    );
    // Explicitly confirm the inline value did NOT reach createAppAuth
    expect(createAppAuth).not.toHaveBeenCalledWith(
      expect.objectContaining({ privateKey: 'inline-pem-should-be-ignored' }),
    );

    // Restore default fs mock behavior for subsequent tests
    vi.mocked(fs.existsSync).mockImplementation(() => false);
    vi.mocked(fs.readFileSync).mockImplementation(
      (() => '') as unknown as typeof fs.readFileSync,
    );
  });

  it('neither _PATH nor _PRIVATE_KEY set: no App auth, falls through to CEO GH_TOKEN', async () => {
    process.env.LIMITLESS_APP_ID = '12345';
    process.env.LIMITLESS_APP_INSTALLATION_ID = '67890';
    process.env.LIMITLESS_BOT_USER_ID = '111111';
    // Deliberately no LIMITLESS_APP_PRIVATE_KEY, no LIMITLESS_APP_PRIVATE_KEY_PATH
    process.env.GH_TOKEN = 'ceo-pat-fallback';

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    // App auth path never invoked when no private key source is available
    expect(createAppAuth).not.toHaveBeenCalled();
    const dockerArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(findEnvArg(dockerArgs, 'GH_TOKEN')).toBe('ceo-pat-fallback');
    // No bot identity injected on CEO-token fallback
    expect(findEnvArg(dockerArgs, 'GIT_AUTHOR_NAME')).toBeUndefined();
    expect(findEnvArg(dockerArgs, 'GIT_AUTHOR_EMAIL')).toBeUndefined();
  });
});

describe('OneCLI guard — ONECLI_URL empty', () => {
  // Re-import container-runner with ONECLI_URL='' to test the guard path.
  // vi.resetModules() + vi.doMock() lets us override the hoisted config mock
  // for this describe block only.
  let runContainerAgentNoOneCLI: typeof import('./container-runner.js').runContainerAgent;
  let mockApplyContainerConfig: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    mockApplyContainerConfig = vi.fn().mockResolvedValue(true);
    vi.resetModules();
    vi.doMock('./config.js', () => ({
      CONTAINER_IMAGE: 'nanoclaw-agent:latest',
      CONTAINER_MAX_OUTPUT_SIZE: 10485760,
      CONTAINER_TIMEOUT: 1800000,
      DATA_DIR: '/tmp/nanoclaw-test-data',
      GROUPS_DIR: '/tmp/nanoclaw-test-groups',
      IDLE_TIMEOUT: 1800000,
      ONECLI_URL: '', // intentionally empty — exercises the guard branch
      ONECLI_API_KEY: '',
      TIMEZONE: 'UTC',
      WEB_SEARCH_PROVIDER: 'auto',
      HAS_SEARCH_CREDENTIALS: false,
      MONOREPO_PATH: '',
      WORKTREE_BASE: '/tmp/nanoclaw-worktrees',
    }));
    vi.doMock('@onecli-sh/sdk', () => ({
      OneCLI: class {
        applyContainerConfig = mockApplyContainerConfig;
        createAgent = vi.fn();
        ensureAgent = vi.fn();
      },
    }));
    const mod = await import('./container-runner.js');
    runContainerAgentNoOneCLI = mod.runContainerAgent;
  });

  afterAll(() => {
    vi.resetModules();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    mockApplyContainerConfig.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not call OneCLI.applyContainerConfig when ONECLI_URL is empty', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token-xyz';

    const resultPromise = runContainerAgentNoOneCLI(
      testGroup,
      testInput,
      () => {},
    );

    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(mockApplyContainerConfig).not.toHaveBeenCalled();
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it('injects CLAUDE_CODE_OAUTH_TOKEN via -e when ONECLI_URL is empty', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token-xyz';

    const { spawn } = await import('child_process');
    const spawnMock = spawn as ReturnType<typeof vi.fn>;
    spawnMock.mockClear();

    const resultPromise = runContainerAgentNoOneCLI(
      testGroup,
      testInput,
      () => {},
    );

    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const dockerArgs = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    expect(dockerArgs).toBeDefined();
    const tokenArgIdx = dockerArgs!.findIndex(
      (a, i, arr) =>
        a === '-e' && arr[i + 1]?.startsWith('CLAUDE_CODE_OAUTH_TOKEN='),
    );
    expect(tokenArgIdx).not.toBe(-1);

    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });
});
