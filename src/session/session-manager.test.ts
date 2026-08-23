import { describe, expect, it } from 'vitest';
import { findLastRetryableTurn } from './session-manager.js';
import type { SessionEventLike } from './types.js';

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
