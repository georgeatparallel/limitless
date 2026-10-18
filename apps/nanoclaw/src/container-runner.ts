/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_URL,
  ONECLI_API_KEY,
  TIMEZONE,
  MONOREPO_PATH,
  WORKTREE_BASE,
  WEB_SEARCH_PROVIDER,
  HAS_SEARCH_CREDENTIALS,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { OneCLI } from '@onecli-sh/sdk';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import { createAppAuth } from '@octokit/auth-app';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

interface GhCredentials {
  token: string | undefined;
  botLogin: string | undefined;
  botUserId: string | undefined;
}

async function generateInstallationToken(
  appId: string,
  installationId: string,
  privateKey: string,
): Promise<string> {
  const auth = createAppAuth({
    appId: parseInt(appId, 10),
    privateKey,
    installationId: parseInt(installationId, 10),
  });
  const result = await auth({ type: 'installation' });
  return result.token;
}

/**
 * Resolve a GitHub App private key, preferring a file path over an inline value.
 *
 * Inline PEM (`*_APP_PRIVATE_KEY`) is fragile in environment-variable form —
 * multi-line PEMs break systemd `EnvironmentFile=` parsing and leak into
 * process listings. File-based delivery (`*_APP_PRIVATE_KEY_PATH`) is the
 * preferred transport for DR-001 Phase 3; inline remains as a fallback for
 * legacy setups.
 *
 * Precedence: `_PATH` (when set AND the file exists) wins; otherwise fall
 * back to the inline `_PRIVATE_KEY` value.
 */
function loadPrivateKey(
  inline: string | undefined,
  pathVar: string | undefined,
): string | undefined {
  if (pathVar && fs.existsSync(pathVar)) {
    return fs.readFileSync(pathVar, 'utf-8');
  }
  return inline;
}

async function resolveGhCredentials(
  agentRole: string | undefined,
  containerName: string,
): Promise<GhCredentials> {
  const isMythos = agentRole?.startsWith('mythos-') ?? false;
  const appId = isMythos ? process.env.MYTHOS_APP_ID : process.env.LIMITLESS_APP_ID;
  const installationId = isMythos
    ? process.env.MYTHOS_APP_INSTALLATION_ID
    : process.env.LIMITLESS_APP_INSTALLATION_ID;
  const privateKey = isMythos
    ? loadPrivateKey(process.env.MYTHOS_APP_PRIVATE_KEY, process.env.MYTHOS_APP_PRIVATE_KEY_PATH)
    : loadPrivateKey(
        process.env.LIMITLESS_APP_PRIVATE_KEY,
        process.env.LIMITLESS_APP_PRIVATE_KEY_PATH,
      );
  const botUserId = isMythos
    ? process.env.MYTHOS_BOT_USER_ID
    : process.env.LIMITLESS_BOT_USER_ID;
  const botLogin = isMythos ? 'mythos-agents[bot]' : 'limitless-agent[bot]';

  if (appId && installationId && privateKey) {
    try {
      const token = await generateInstallationToken(appId, installationId, privateKey);
      logger.info({ containerName, isMythos }, 'GitHub App installation token generated');
      return { token, botLogin, botUserId };
    } catch (err) {
      logger.warn({ err }, 'App token generation failed — falling back to CEO GH_TOKEN');
    }
  }

  // No App credentials configured (or generation failed) — fall back to CEO token.
  // Bot identity is not injected on fallback; commits land as CEO identity.
  return { token: process.env.GH_TOKEN, botLogin: undefined, botUserId: undefined };
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  ghCredentials: GhCredentials,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by OneCLI (when configured) or passed via -e flags.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Mount the monorepo read-only for codebase investigation
    // The Architect needs to read app code, CLAUDE.md files, and docs
    // to independently analyze issues and produce implementation plans.
    if (MONOREPO_PATH && fs.existsSync(MONOREPO_PATH)) {
      mounts.push({
        hostPath: MONOREPO_PATH,
        containerPath: '/workspace/monorepo',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const defaultEnv: Record<string, string> = {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    GH_TOKEN: ghCredentials.token || '',
    GITHUB_TOKEN: ghCredentials.token || '',
    ...(ghCredentials.botLogin && ghCredentials.botUserId
      ? {
          GIT_AUTHOR_NAME: ghCredentials.botLogin,
          GIT_AUTHOR_EMAIL: `${ghCredentials.botUserId}+${ghCredentials.botLogin}@users.noreply.github.com`,
          GIT_COMMITTER_NAME: ghCredentials.botLogin,
          GIT_COMMITTER_EMAIL: `${ghCredentials.botUserId}+${ghCredentials.botLogin}@users.noreply.github.com`,
        }
      : {}),
  };
  // Merge containerConfig.envVars (e.g., AGENT_ROLE, AGENT_SCOPE)
  const groupEnvVars = group.containerConfig?.envVars || {};
  const mergedEnv = { ...defaultEnv, ...groupEnvVars };
  // Always write settings.json so env vars reflect current containerConfig
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ env: mergedEnv }, null, 2) + '\n',
  );

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    const srcIndex = path.join(agentRunnerSrc, 'index.ts');
    const cachedIndex = path.join(groupAgentRunnerDir, 'index.ts');
    const needsCopy =
      !fs.existsSync(groupAgentRunnerDir) ||
      !fs.existsSync(cachedIndex) ||
      (fs.existsSync(srcIndex) &&
        fs.statSync(srcIndex).mtimeMs > fs.statSync(cachedIndex).mtimeMs);
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  // Mount git worktree for worker groups (created by register_group IPC handler)
  if (!isMain && WORKTREE_BASE && group.containerConfig?.envVars?.AGENT_SCOPE) {
    const worktreeDir = path.join(WORKTREE_BASE, group.folder);
    if (fs.existsSync(worktreeDir)) {
      mounts.push({
        hostPath: worktreeDir,
        containerPath: '/workspace/extra/monorepo',
        readonly: false,
      });

      // Mount parent repo's .git directory at its HOST PATH so worktree references
      // resolve without modification. The worktree's .git file contains an absolute
      // host path (e.g., gitdir: /home/.../worktrees/name). By mounting .git at the
      // same path inside the container, all git operations work transparently.
      if (MONOREPO_PATH) {
        const gitDir = path.join(MONOREPO_PATH, '.git');
        if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
          mounts.push({
            hostPath: gitDir,
            containerPath: gitDir,
            readonly: false,
          });
        }
      }
    }
  }

  // Mount shared team workspace for peer communication between workers
  const teamId = group.containerConfig?.teamId;
  if (!isMain && teamId) {
    const teamDir = path.join(DATA_DIR, 'teams', teamId);
    fs.mkdirSync(path.join(teamDir, 'coordination', 'locks'), { recursive: true });
    fs.mkdirSync(path.join(teamDir, 'messages'), { recursive: true });
    mounts.push({
      hostPath: teamDir,
      containerPath: '/workspace/team',
      readonly: false,
    });
  }

  return mounts;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentIdentifier: string | undefined,
  ghCredentials: GhCredentials,
): Promise<string[]> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Inject GitHub credentials: App installation token (preferred) or CEO token (fallback).
  // Bot git identity env vars are only set when an App token was successfully generated.
  if (ghCredentials.token) {
    args.push('-e', `GH_TOKEN=${ghCredentials.token}`);
    args.push('-e', `GITHUB_TOKEN=${ghCredentials.token}`);
    if (ghCredentials.botLogin && ghCredentials.botUserId) {
      const botEmail = `${ghCredentials.botUserId}+${ghCredentials.botLogin}@users.noreply.github.com`;
      args.push('-e', `GIT_AUTHOR_NAME=${ghCredentials.botLogin}`);
      args.push('-e', `GIT_AUTHOR_EMAIL=${botEmail}`);
      args.push('-e', `GIT_COMMITTER_NAME=${ghCredentials.botLogin}`);
      args.push('-e', `GIT_COMMITTER_EMAIL=${botEmail}`);
    }
  }

  if (ONECLI_URL) {
    // OneCLI gateway handles credential injection — the gateway intercepts
    // HTTPS traffic and injects API keys or OAuth tokens so containers never
    // see the raw secrets.
    const onecliApplied = await onecli.applyContainerConfig(args, {
      addHostMapping: false, // Nanoclaw already handles host gateway
      agent: agentIdentifier,
    });
    if (onecliApplied) {
      logger.info({ containerName }, 'OneCLI gateway config applied');
    } else {
      logger.warn(
        { containerName },
        'OneCLI gateway not reachable — container will have no credentials',
      );
    }
  } else {
    // No OneCLI gateway configured — pass CLAUDE_CODE_OAUTH_TOKEN directly
    // via -e. The token is visible in `docker inspect` on the host; acceptable
    // for a single-operator VPS where no untrusted users have access.
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN}`);
      logger.info(
        { containerName },
        'OneCLI not configured — CLAUDE_CODE_OAUTH_TOKEN injected directly',
      );
    } else {
      logger.warn(
        { containerName },
        'OneCLI not configured and CLAUDE_CODE_OAUTH_TOKEN unset — container will have no Anthropic credentials',
      );
    }
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;

  // Resolve GitHub credentials before building container config.
  // Generates a short-lived App installation token (1h TTL) keyed to the
  // agent's division, or falls back to the CEO GH_TOKEN if App creds are absent.
  const agentRole = group.containerConfig?.envVars?.AGENT_ROLE;
  const ghCredentials = await resolveGhCredentials(agentRole, containerName);

  const mounts = buildVolumeMounts(group, input.isMain, ghCredentials);
  // Main group uses the default OneCLI agent; others use their own agent.
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');
  const containerArgs = await buildContainerArgs(
    mounts,
    containerName,
    agentIdentifier,
    ghCredentials,
  );

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(
      JSON.stringify({
        ...input,
        webSearch: WEB_SEARCH_PROVIDER,
        hasSearchCredentials: HAS_SEARCH_CREDENTIALS,
      }),
    );
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
