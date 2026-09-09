// wmux-managed: omp-lifecycle-bridge
// Native Oh My Pi lifecycle bridge for wmux.
// Installed by `wmux setup-hooks`; safe to load in OMP's extension runtime.

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { basename, join } from 'node:path';

type SignalKind = 'agent.session_start' | 'agent.activity' | 'agent.stop';
type UnknownRecord = Record<string, unknown>;

export interface OmpContext {
  cwd?: string;
  isIdle?: () => boolean;
  sessionManager: {
    getSessionId: () => string | null | undefined;
  };
}

export interface OmpExtensionApi {
  on: (event: string, handler: (event: UnknownRecord, context: OmpContext) => unknown) => void;
}

export interface OmpSignal {
  kind: SignalKind;
  agent: 'omp';
  agentSessionId?: string;
  workspaceId?: string;
  surfaceId?: string;
  ptyId?: string;
  cwd: string;
  payload: UnknownRecord;
  ts: number;
}

interface OwnerState {
  sessionId: string | null;
}

interface Target {
  pipe: string;
  token: string;
  method: 'daemon.hooks.signal' | 'hooks.signal';
}

const HOOK_TIMEOUT_MS = 2_000;
const TRANSIENT_CONNECT_CODES: Readonly<Record<string, true>> = {
  EPERM: true,
  ECONNREFUSED: true,
  ECONNRESET: true,
  EPIPE: true,
  ETIMEDOUT: true,
  EBUSY: true,
  EAGAIN: true,
};

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** OMP is shipped as `omp`/`omp.exe` or the @oh-my-pi package entrypoint. */
export function detectOmpAgent(
  argv: readonly string[] = process.argv,
  executable = process.execPath,
): boolean {
  for (const raw of [executable, ...argv.slice(0, 3)]) {
    const value = String(raw).replaceAll('\\', '/').toLowerCase();
    if (basename(value) === 'omp' || basename(value) === 'omp.exe') return true;
    if (value.includes('/@oh-my-pi/pi-coding-agent/')) return true;
  }
  return false;
}

/** Build wmux's canonical hook envelope without performing I/O. */
export function buildOmpSignal(
  kind: SignalKind,
  context: OmpContext,
  payload: UnknownRecord = {},
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): OmpSignal {
  const sessionId = nonEmpty(context.sessionManager.getSessionId());
  const workspaceId = nonEmpty(env.WMUX_WORKSPACE_ID);
  const surfaceId = nonEmpty(env.WMUX_SURFACE_ID);
  const ptyId = nonEmpty(env.WMUX_PTY_ID);
  return {
    kind,
    agent: 'omp',
    ...(sessionId ? { agentSessionId: sessionId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(surfaceId ? { surfaceId } : {}),
    ...(ptyId ? { ptyId } : {}),
    cwd: nonEmpty(context.cwd) ?? process.cwd(),
    payload,
    ts: now,
  };
}

function suffix(env: NodeJS.ProcessEnv): string {
  return env.WMUX_DATA_SUFFIX ?? '';
}

function home(env: NodeJS.ProcessEnv): string {
  return env.USERPROFILE ?? env.HOME ?? homedir();
}

function wmuxHome(env: NodeJS.ProcessEnv): string {
  return join(home(env), `.wmux${suffix(env)}`);
}

function mainPipe(env: NodeJS.ProcessEnv): string {
  if (nonEmpty(env.WMUX_PIPE_NAME)) return env.WMUX_PIPE_NAME as string;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wmux${suffix(env)}-${userInfo().username || 'default'}`;
  }
  return join(homedir() || '/tmp', `.wmux${suffix(env)}.sock`);
}

function daemonPipe(env: NodeJS.ProcessEnv): string {
  try {
    const hinted = readFileSync(join(wmuxHome(env), 'daemon-pipe'), 'utf8').trim();
    if (hinted) return hinted;
  } catch {
    // Fall through to the deterministic namespace-local path.
  }
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wmux-daemon${suffix(env)}-${userInfo().username || 'default'}`;
  }
  return join(wmuxHome(env), 'daemon.sock');
}

function tokenAt(filePath: string): string | undefined {
  try {
    return nonEmpty(readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function targets(env: NodeJS.ProcessEnv): Target[] {
  const mainToken = tokenAt(join(home(env), `.wmux${suffix(env)}-auth-token`));
  if (nonEmpty(env.WMUX_PIPE_NAME)) {
    return mainToken ? [{ pipe: mainPipe(env), token: mainToken, method: 'hooks.signal' }] : [];
  }

  const result: Target[] = [];
  if (env.WMUX_HOOKS_TO_MAIN !== '1') {
    const daemonToken = tokenAt(join(wmuxHome(env), 'daemon-auth-token'));
    if (daemonToken) {
      result.push({ pipe: daemonPipe(env), token: daemonToken, method: 'daemon.hooks.signal' });
    }
  }
  if (mainToken) result.push({ pipe: mainPipe(env), token: mainToken, method: 'hooks.signal' });
  return result;
}

interface RpcResult extends UnknownRecord {
  ok?: boolean;
  retryable?: boolean;
  error?: string;
  detail?: string;
}

function sendRpc(pipe: string, request: UnknownRecord, timeoutMs: number): Promise<RpcResult> {
  return new Promise((resolve) => {
    const socket = createConnection(pipe);
    let buffer = '';
    let settled = false;
    let wrote = false;
    const finish = (result: RpcResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: 'timeout', retryable: !wrote }),
      timeoutMs,
    );

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
      wrote = true;
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const response = JSON.parse(line) as UnknownRecord;
          if (response.id === request.id) {
            finish(response as RpcResult);
            return;
          }
        } catch {
          // Ignore unrelated broadcasts and malformed lines.
        }
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        error: 'connect-error',
        detail: error.code ?? error.message,
        retryable: !wrote,
      });
    });
    socket.on('close', () => {
      finish({ ok: false, error: 'closed-without-response', retryable: !wrote });
    });
  });
}

function spoolResumeBinding(signal: OmpSignal, env: NodeJS.ProcessEnv): void {
  if (!signal.ptyId || !signal.agentSessionId) return;
  try {
    const safePty = signal.ptyId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    if (!safePty) return;
    const directory = join(wmuxHome(env), 'resume-spool');
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = join(directory, `${safePty}.json`);
    const temporary = join(directory, `${safePty}.${process.pid}.${randomUUID()}.json.tmp`);
    const record = {
      ptyId: signal.ptyId,
      agent: signal.agent,
      sessionId: signal.agentSessionId,
      cwd: signal.cwd,
      ts: signal.ts,
    };
    writeFileSync(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    try {
      const existing = JSON.parse(readFileSync(destination, 'utf8')) as { ts?: unknown };
      if (typeof existing.ts === 'number' && existing.ts > signal.ts) {
        unlinkSync(temporary);
        return;
      }
    } catch {
      // Missing/corrupt older records are replaced atomically.
    }
    renameSync(temporary, destination);
  } catch {
    // Lifecycle delivery must never fail the agent turn.
  }
}

/** Deliver daemon-first, falling back to main only when the first endpoint did not accept. */
export async function dispatchOmpSignal(
  signal: OmpSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const available = targets(env);
  const deadline = Date.now() + HOOK_TIMEOUT_MS;
  let accepted = false;
  for (const target of available) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const request = {
      id: `omp-${randomUUID()}`,
      method: target.method,
      params: signal,
      token: target.token,
    };
    const result = await sendRpc(target.pipe, request, remaining);
    if (result.ok === true) {
      accepted = true;
      break;
    }
    if (result.retryable === false) break;
    if (result.error === 'connect-error' && result.detail && !TRANSIENT_CONNECT_CODES[result.detail]) {
      break;
    }
  }
  if (!accepted && (signal.kind === 'agent.session_start' || signal.kind === 'agent.stop')) {
    spoolResumeBinding(signal, env);
  }
}

function sessionId(context: OmpContext): string | undefined {
  return nonEmpty(context.sessionManager.getSessionId());
}

function snapshot(context: OmpContext): OmpContext {
  const id = sessionId(context);
  const cwd = nonEmpty(context.cwd) ?? process.cwd();
  return {
    cwd,
    isIdle: context.isIdle ? () => context.isIdle?.() ?? true : undefined,
    sessionManager: { getSessionId: () => id },
  };
}

function globalOwner(): OwnerState {
  const root = globalThis as typeof globalThis & { __wmuxOmpOwner?: OwnerState };
  return (root.__wmuxOmpOwner ??= { sessionId: null });
}

/** Create the extension registration function with injectable dispatch for tests. */
export function createOmpLifecycleExtension(
  enabled: boolean,
  dispatch: (signal: OmpSignal) => Promise<void> = dispatchOmpSignal,
  owner: OwnerState = globalOwner(),
): (api: OmpExtensionApi) => void {
  return (api) => {
    if (!enabled) return;

    let activeContext: OmpContext | null = null;
    const owns = (context: OmpContext): boolean => {
      const id = sessionId(context);
      return !!id && id === owner.sessionId;
    };
    const emit = (
      kind: SignalKind,
      context: OmpContext,
      payload: UnknownRecord = {},
    ): void => {
      try {
        const signal = buildOmpSignal(kind, context, payload);
        // Lifecycle delivery is best-effort. Never make OMP wait for a wmux
        // pipe timeout from any agent lifecycle event.
        void Promise.resolve(dispatch(signal)).catch(() => undefined);
      } catch {
        // A wmux integration failure must never fail the agent turn.
      }
    };

    api.on('session_start', (_event, rawContext) => {
      const context = snapshot(rawContext);
      const id = sessionId(context);
      if (!id) return;
      if (owner.sessionId === null) owner.sessionId = id;
      if (!owns(context)) return;
      activeContext = null;
      emit('agent.session_start', context);
    });

    const adoptSession = (_event: UnknownRecord, rawContext: OmpContext): void => {
      const context = snapshot(rawContext);
      const id = sessionId(context);
      if (!id || id === owner.sessionId) return;
      owner.sessionId = id;
      activeContext = null;
      emit('agent.session_start', context);
    };
    api.on('session_switch', adoptSession);
    api.on('session_branch', adoptSession);

    // OMP's documented agent_start event is the turn-activity boundary.
    api.on('agent_start', (_event, rawContext) => {
      const context = snapshot(rawContext);
      if (!owns(context)) return;
      activeContext = context;
      emit('agent.activity', context);
    });

    // agent_end is OMP's authoritative loop-end event. A scheduled retry is
    // still the same user turn, so leave the activity latch open for the next
    // agent_start instead of reporting a false stop.
    api.on('agent_end', (event, rawContext) => {
      const context = snapshot(rawContext);
      if (!owns(context) || event.willContinue === true) return;
      activeContext = null;
      emit('agent.stop', context);
    });

    api.on('session_shutdown', (_event, rawContext) => {
      const context = snapshot(rawContext);
      if (!owns(context)) return;
      if (activeContext) emit('agent.stop', activeContext);
      activeContext = null;
      owner.sessionId = null;
    });
  };
}

export default createOmpLifecycleExtension(detectOmpAgent());
