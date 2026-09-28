import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import { SessionManager } from './session-manager.js';
import { emptySummary, foldQqSummary } from './projection.js';
import type { DshAgent, DshAgentRegistry } from './types.js';
import type { ImQQBotConfig } from '../config.js';

// A real connector's preference store is outside DSH_HOME. Keep this test
// entirely in memory so it cannot read or modify the deployed QQ mapping.
vi.mock('../model/model-resolver.js', () => ({ ModelResolver: class {
  ids = new Map(); history = new Map(); overrides = new Map();
  getSessionId(key: string) { return this.ids.get(key); }
  setSessionId(key: string, id: string) { this.ids.set(key, id); }
  getSessionHistory(key: string) { return this.history.get(key) ?? []; }
  setSessionHistory(key: string, ids: string[]) { this.history.set(key, [...ids]); }
  getEffectiveRoute(key: string) { return this.overrides.get(key) ?? { provider: 'test', model: 'default' }; }
  getResumeRoute(key: string) { return this.getEffectiveRoute(key); }
  setOverride(key: string, route: unknown) { this.overrides.set(key, route); }
} }));

const managers: SessionManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.disposeAll())); });

function fixture() {
  const logs = new Map<string, SessionEvent[]>();
  const live = new Map<string, DshAgent>();
  const route = { provider: 'test', model: 'web-choice', reasoningEffort: 'high' };
  function make(id: string, seed?: readonly SessionEvent[], meta: object = {}, inherited?: number) {
    const replay = inherited === 0 && seed?.length === 0
      ? [{ seq: 0, time: Date.now(), type: 'session/end-seed', data: { inherited: true } } as SessionEvent]
      : seed;
    const session = Session.create(SessionId(id), replay, {
      ...Session.create(SessionId(id)).header, ...meta,
    } as never, inherited as never);
    const events = [...(replay ?? [])];
    logs.set(id, events);
    const append = session.append.bind(session);
    session.append = ((...args: Parameters<typeof append>) => {
      const event = append(...args); events.push(event); return event;
    }) as typeof append;
    const agent = {
      session, status: 'idle', options: {}, whenIdle: vi.fn(async () => {}),
      cancel: vi.fn(), followup: vi.fn(),
    } as unknown as DshAgent;
    live.set(id, agent);
    return { agent, dispose: vi.fn(async () => { live.delete(id); }) };
  }
  const agents = {
    get: vi.fn((id: string) => live.get(id)),
    resume: vi.fn(async () => { throw new Error('no stored session'); }),
    create: vi.fn(async (options: any) => make(options.sessionId, options.seed, options.meta, options.inheritedEventCount)),
  };
  const sessionController = { selectModel: vi.fn(async (request: any) => {
    live.get(request.sessionId)!.session.append('model/selection', route);
    return { selected: route };
  }) };
  const services = { sessions: { fork: vi.fn(() => { throw new Error('must not create an extra live fork'); }) } };
  const ctx = {
    get: (name: keyof typeof services) => services[name],
    sessionController,
    sessionQuery: {
      readSession: vi.fn(async (id: string) => ({ events: logs.get(id) ?? [] })),
      observeSession: vi.fn(async () => { throw new Error('no stored session'); }),
    },
    sessionProjections: { stateOf: (session: Session, key: string) => key === 'modelSelection'
      ? { pending: route, lastUsed: null }
      : (logs.get(session.id) ?? []).reduce(foldQqSummary, emptySummary()) },
  };
  const manager = new SessionManager(ctx as unknown as Context, agents as unknown as DshAgentRegistry, {
    appId: 'isolated-test', sessionIdleTimeout: 0, visibleSessionLimit: 16,
    cwd: '/tmp/dsh-qq-test',
  } as ImQQBotConfig, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  managers.push(manager);
  return { manager, agents, ctx, logs, route, services };
}

function turn(session: Session, id: number, text: string) {
  session.append('turn/start', { turn: id });
  session.append('step/start', { turn: id, step: 1 });
  const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
  session.append('user/message', user, { surfaceOp: 'append' });
  session.append('assistant/message', { turn: id, step: 1, stream: [], message: createAssistantMessage({
    source: { provider: 'test', model: 'old' }, content: [{ type: 'text', text: 'answer' }],
  }) }, { surfaceOp: 'append' });
  session.append('step/end', { turn: id, step: 1 });
  session.append('turn/end', { turn: id, reason: { kind: 'completed' } });
  return user;
}

describe('QQ session management against V4 sessions', () => {
  it('retries into one child, preserves the parent and copies the pending Web choice', async () => {
    const f = fixture();
    const record = await f.manager.getOrCreate('c2c', 'test-peer', 'sender', { scope: 'c2c', targetId: 'test-peer' });
    const parentId = record.sessionId;
    const parent = record.agent.session;
    turn(parent, 1, 'keep');
    const cut = f.logs.get(parentId)!.length;
    const user = turn(parent, 2, 'retry me');
    const original = structuredClone(f.logs.get(parentId));

    const result = await f.manager.regenerateLast('c2c', 'test-peer');
    expect(result.ok).toBe(true);
    expect(f.logs.get(parentId)).toEqual(original);
    expect(f.agents.create).toHaveBeenCalledTimes(2);
    expect(f.services.sessions.fork).not.toHaveBeenCalled();
    expect(record.agent.session.inheritedEventCount).toBe(cut);
    expect(record.agent.session.header).toMatchObject({ isSeeded: true, parentSession: parentId });
    expect(record.agent.session.deriveMessages().map(message => message.content)).toHaveLength(2);
    expect(record.agent.followup).toHaveBeenCalledWith(user);
    expect(f.ctx.sessionController.selectModel).toHaveBeenCalledWith({ sessionId: result.sessionId, ...f.route });
    expect(f.agents.create.mock.calls[1]![0].agentOptions).toEqual(f.route);
  });

  it('allows an empty inherited prefix when retrying the first turn', async () => {
    const f = fixture();
    const record = await f.manager.getOrCreate('c2c', 'test-peer', 'sender', { scope: 'c2c', targetId: 'test-peer' });
    turn(record.agent.session, 1, 'first');
    await f.manager.regenerateLast('c2c', 'test-peer');
    expect(record.agent.session.inheritedEventCount).toBe(0);
    expect(record.agent.session.header.isSeeded).toBe(true);
    expect(record.agent.session.deriveMessages()).toHaveLength(0);
  });

  it('model switching creates only the intended child with the full inherited prefix', async () => {
    const f = fixture();
    const record = await f.manager.getOrCreate('c2c', 'test-peer', 'sender', { scope: 'c2c', targetId: 'test-peer' });
    turn(record.agent.session, 1, 'preserve this');
    const count = f.logs.get(record.sessionId)!.length;
    const route = { provider: 'test', model: 'new' };
    await f.manager.setModelOverride('c2c', 'test-peer', route);
    expect(f.services.sessions.fork).not.toHaveBeenCalled();
    expect(f.agents.create).toHaveBeenCalledTimes(2);
    expect(record.agent.session.inheritedEventCount).toBe(count);
    expect(record.agent.session.deriveMessages()).toHaveLength(2);
    expect(f.agents.create.mock.calls[1]![0].agentOptions).toEqual(route);
  });
});
