import { describe, expect, it } from 'vitest';
import {
  collectLineageSessionIds,
  findLastRetryableTurn,
  resolveSessionSelector,
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
});
