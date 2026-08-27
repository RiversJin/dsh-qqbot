import { describe, expect, it } from 'vitest';
import {
  collectLineageSessionIds,
  findLastRetryableTurn,
  latestSessionModelRoute,
  lastConversationMessageAt,
  resolveSessionSelector,
  resolveSwitchSessionSelector,
  selectSessionIdsForVisibility,
  selectSessionModelRoute,
  sessionHasVisibleContent,
  sortSessionsByRecentActivity,
} from './session-manager.js';
import type { SelectableSession, SessionEventLike, SessionHeaderLike } from './types.js';

describe('findLastRetryableTurn', () => {
  it('returns the latest completed user turn and counts tool calls', () => {
    const events: SessionEventLike[] = [
      { type: 'turn/start', data: { turn: 'older' } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: 'older' } },
      { type: 'turn/end', data: { turn: 'older' } },
      { type: 'turn/start', data: { turn: 'latest' } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: 'latest' } },
      { type: 'tool/call' },
      { type: 'tool/result' },
      { type: 'assistant/message' },
      { type: 'turn/end', data: { turn: 'latest' } },
    ];

    const result = findLastRetryableTurn(events);

    expect(result?.startIndex).toBe(3);
    expect(result?.endIndex).toBe(8);
    expect(result?.userEvent.data?.content).toBe('latest');
    expect(result?.toolCount).toBe(1);
  });

  it('ignores an unfinished trailing turn', () => {
    const events: SessionEventLike[] = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: 'completed' } },
      { type: 'assistant/message' },
      { type: 'turn/end', data: { turn: 1 } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: 'unfinished' } },
    ];

    expect(findLastRetryableTurn(events)?.userEvent.data?.content).toBe('completed');
  });
});

describe('lastConversationMessageAt', () => {
  it('ignores plugin context messages after the latest real conversation message', () => {
    const events: SessionEventLike[] = [
      { type: 'user/message', time: 100, data: { source: { kind: 'user' } } },
      { type: 'assistant/message', time: 200 },
      { type: 'user/message', time: 300, data: { source: { kind: 'plugin' } } },
      { type: 'command/run', time: 400 },
    ];
    expect(lastConversationMessageAt(events)).toBe(200);
  });
});

describe('QQ session selection', () => {
  const sessions: SelectableSession[] = [
    { sessionId: 'session-252de13c-0d5b-4188-a3c7-d400c4d0655b', createdAt: 200, current: false },
    { sessionId: 'de570bfb-59d0-4686-8317-b29038ae71f3', createdAt: 100, current: true },
  ];

  it('resolves one-based indexes and display-id prefixes', () => {
    expect(resolveSessionSelector(sessions, '1')).toEqual({ kind: 'found', session: sessions[0] });
    expect(resolveSessionSelector(sessions, '252de13c')).toEqual({ kind: 'found', session: sessions[0] });
    expect(resolveSessionSelector(sessions, 'de570bfb')).toEqual({ kind: 'found', session: sessions[1] });
    expect(resolveSessionSelector(sessions, '3')).toEqual({ kind: 'not-found' });
  });

  it('reports ambiguous short prefixes instead of guessing', () => {
    const ambiguous = [
      ...sessions,
      { sessionId: 'de570bfb-aaaa-bbbb-cccc-000000000000', current: false },
    ];
    expect(resolveSessionSelector(ambiguous, 'de570')).toMatchObject({ kind: 'ambiguous' });
  });

  it('sorts old Web sessions by their latest real conversation activity', () => {
    const oldButActive: SelectableSession = {
      sessionId: 'session-old',
      createdAt: 100,
      lastMessageAt: 500,
      current: false,
    };
    const newButIdle: SelectableSession = {
      sessionId: 'session-new',
      createdAt: 400,
      current: false,
    };

    expect(sortSessionsByRecentActivity([newButIdle, oldButActive]))
      .toEqual([oldButActive, newButIdle]);
  });

  it('allows only an exact full id to bypass the displayed session limit', () => {
    const hidden: SelectableSession = {
      sessionId: 'session-dcb0216d-74c6-4493-82c0-67751590c1c7',
      createdAt: 100,
      current: false,
    };
    const eligible = [...sessions, hidden];

    expect(resolveSwitchSessionSelector(sessions, eligible, hidden.sessionId))
      .toEqual({ kind: 'found', session: hidden });
    expect(resolveSwitchSessionSelector(sessions, eligible, 'dcb0216d'))
      .toEqual({ kind: 'not-found' });
    expect(resolveSwitchSessionSelector(sessions, eligible, '3'))
      .toEqual({ kind: 'not-found' });
  });

  it('includes transitive Web forks but excludes unrelated workspace sessions', () => {
    const headers: SessionHeaderLike[] = [
      { id: 'root', createdAt: 1 },
      { id: 'child', createdAt: 2, parentSession: 'root' },
      { id: 'grandchild', createdAt: 3, parentSession: 'child' },
      { id: 'other', createdAt: 4 },
      { id: 'other-child', createdAt: 5, parentSession: 'other' },
      { id: 'subagent', createdAt: 6, parentSession: 'root', delegationDepth: 1 },
    ];
    const ordinary = headers.filter((header) => (header.delegationDepth ?? 0) === 0);
    const allowed = collectLineageSessionIds(
      ordinary,
      new Set(['root']),
      new Set(ordinary.map((header) => header.id)),
    );
    expect([...allowed]).toEqual(['root', 'child', 'grandchild']);
  });

  it('can expose every ordinary Workspace session for a personal deployment', () => {
    const headers: SessionHeaderLike[] = [
      { id: 'qq-root', createdAt: 1 },
      { id: 'qq-child', createdAt: 2, parentSession: 'qq-root' },
      { id: 'web-root', createdAt: 3 },
    ];
    const candidates = new Set(headers.map((header) => header.id));

    expect([...selectSessionIdsForVisibility(
      headers,
      new Set(['qq-root']),
      candidates,
      'workspace',
    )]).toEqual(['qq-root', 'qq-child', 'web-root']);
  });

  it('recognizes and hides empty Workspace placeholders', () => {
    expect(sessionHasVisibleContent([
      { type: 'session' },
      { type: 'permission/preset' },
    ])).toBe(false);
    expect(sessionHasVisibleContent([
      { type: 'session' },
      { type: 'user/message', data: { content: 'hello' } },
    ])).toBe(true);
  });
});

describe('QQ session model routing', () => {
  const kimi = { provider: 'kimi-coding', model: 'k3' };
  const qwen = {
    provider: 'qwen38-local',
    model: 'Qwen3.8-27B/Qwen3.8-27B-UD-Q4_K_XL.gguf',
    reasoningEffort: 'xhigh',
  };

  it('prefers an unlogged Web selection over the durable and QQ routes', () => {
    expect(selectSessionModelRoute(qwen, kimi, kimi)).toEqual(qwen);
  });

  it('retains the durable session route before falling back to QQ preferences', () => {
    expect(selectSessionModelRoute(undefined, qwen, kimi)).toEqual(qwen);
    expect(selectSessionModelRoute(undefined, undefined, kimi)).toEqual(kimi);
  });

  it('reads the latest request header including reasoning effort', () => {
    const events: SessionEventLike[] = [
      { type: 'request/header', data: { header: { config: kimi } } },
      { type: 'assistant/message' },
      { type: 'request/header', data: { header: { config: qwen } } },
    ];
    expect(latestSessionModelRoute(events)).toEqual(qwen);
  });
});
