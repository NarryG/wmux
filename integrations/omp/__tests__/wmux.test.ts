import { describe, expect, it, vi } from 'vitest';
import { isAgentSignal } from '../../../src/shared/hooks/signal-types';
import {
  buildOmpSignal,
  createOmpLifecycleExtension,
  detectOmpAgent,
  type OmpContext,
  type OmpExtensionApi,
  type OmpSignal,
} from '../wmux';

const context = (id: string | null = 'omp-session'): OmpContext => ({
  cwd: 'C:\\repo',
  sessionManager: { getSessionId: () => id },
});

const env = {
  WMUX_PTY_ID: 'pty-omp',
  WMUX_SURFACE_ID: 'surface-omp',
  WMUX_WORKSPACE_ID: 'workspace-omp',
} as NodeJS.ProcessEnv;

describe('OMP identity and envelope', () => {
  it('recognizes the native executable and package entrypoint only', () => {
    expect(detectOmpAgent([], 'C:\\Users\\Daniel\\AppData\\Local\\omp\\omp.exe')).toBe(true);
    expect(detectOmpAgent(['node', '/x/@oh-my-pi/pi-coding-agent/dist/index.js'], 'node')).toBe(true);
    expect(detectOmpAgent([], 'opencode.exe')).toBe(false);
  });

  it('builds a daemon-accepted agent signal with exact pane routing', () => {
    const signal = buildOmpSignal('agent.stop', context(), { reason: 'turn complete' }, env, 123);
    expect(signal).toEqual({
      kind: 'agent.stop',
      agent: 'omp',
      agentSessionId: 'omp-session',
      workspaceId: 'workspace-omp',
      surfaceId: 'surface-omp',
      ptyId: 'pty-omp',
      cwd: 'C:\\repo',
      payload: { reason: 'turn complete' },
      ts: 123,
    });
    expect(isAgentSignal(signal)).toBe(true);
  });

  it('omits empty session and routing fields', () => {
    const signal = buildOmpSignal('agent.activity', context(null), {}, {} as NodeJS.ProcessEnv, 456);
    expect(signal.agentSessionId).toBeUndefined();
    expect(signal.ptyId).toBeUndefined();
    expect(signal.workspaceId).toBeUndefined();
    expect(signal.surfaceId).toBeUndefined();
  });
});

describe('OMP lifecycle extension', () => {
  function install(dispatch: (signal: OmpSignal) => Promise<void>) {
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: OmpContext) => unknown>();
    const api: OmpExtensionApi = {
      on: (event, handler) => handlers.set(event, handler),
    };
    createOmpLifecycleExtension(true, dispatch, { sessionId: null })(api);
    return handlers;
  }

  it('emits session start, activity, and stop for the root session', async () => {
    const dispatch = vi.fn(async (_signal: OmpSignal) => undefined);
    const handlers = install(dispatch);
    const root = context();

    await handlers.get('session_start')?.({}, root);
    await handlers.get('agent_start')?.({}, root);
    await handlers.get('agent_end')?.({ willContinue: false }, root);

    expect(dispatch.mock.calls.map(([signal]) => signal.kind)).toEqual([
      'agent.session_start',
      'agent.activity',
      'agent.stop',
    ]);
    expect(dispatch.mock.calls.every(([signal]) => signal.agent === 'omp')).toBe(true);
  });

  it('uses official agent events and does not await bridge delivery', async () => {
    let release: (() => void) | undefined;
    const dispatch = vi.fn((signal: OmpSignal): Promise<void> => {
      if (signal.kind !== 'agent.activity') return Promise.resolve();
      return new Promise<void>((resolve) => { release = resolve; });
    });
    const handlers = install(dispatch);
    const root = context();

    await handlers.get('session_start')?.({}, root);
    const result = handlers.get('agent_start')?.({}, root);

    expect(result).toBeUndefined();
    expect(dispatch.mock.calls.map(([signal]) => signal.kind)).toEqual([
      'agent.session_start',
      'agent.activity',
    ]);
    expect(handlers.has('before_agent_start')).toBe(false);
    expect(handlers.has('agent_settled')).toBe(false);

    release?.();
  });

  it('does not emit a stop for an agent_end that will continue', async () => {
    const dispatch = vi.fn(async (_signal: OmpSignal) => undefined);
    const handlers = install(dispatch);
    const root = context();

    await handlers.get('session_start')?.({}, root);
    await handlers.get('agent_end')?.({ willContinue: true }, root);

    expect(dispatch.mock.calls.map(([signal]) => signal.kind)).toEqual(['agent.session_start']);
  });
});
