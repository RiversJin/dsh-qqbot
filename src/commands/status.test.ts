import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionManager } from '../session/index.js';
import { statusCommand } from './status.js';

function commandContext() {
  return {
    command: { name: 'bot-status', args: [], raw: '' },
    message: { kind: 'c2c', senderId: 'user-1' },
    replyTarget: { scope: 'c2c', targetId: 'user-1', msgId: 'msg-1' },
  } as never;
}

afterEach(() => vi.useRealTimers());

describe('/bot-status', () => {
  it('renders useful short ids and separates message time from connector activity', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T01:00:00Z'));
    const manager = {
      getStatus: vi.fn(() => ({
        active: true,
        sessionId: 'session-252de13c-0d5b-4188-a3c7-d400c4d0655b',
        provider: 'kimi-coding',
        model: 'k3',
        preset: 'qiyue',
        messageCount: 12,
        lastMessageAt: Date.now() - 3_600_000,
        lastActivity: Date.now() - 10_000,
      })),
    } as unknown as SessionManager;

    const result = statusCommand({ manager, config: {} as never }).handler(commandContext());

    expect(result).toContain('会话: 252de13c');
    expect(result).toContain('最后消息: 1h 前');
    expect(result).toContain('连接活动: 10s 前');
  });
});
