import { describe, expect, it, vi } from 'vitest';
import type { SessionManager } from '../session/index.js';
import { sessionsCommand, switchCommand } from './sessions.js';

function commandContext(name: string, raw = '') {
  return {
    command: { name, args: raw ? [raw] : [], raw },
    message: { kind: 'c2c', senderId: 'user-1' },
    replyTarget: { scope: 'c2c', targetId: 'user-1', msgId: 'msg-1' },
  } as never;
}

const config = { timestampTimeZone: 'Asia/Singapore' } as never;

describe('/sessions', () => {
  it('shows creation time, title, short id, fork marker, and current marker', async () => {
    const manager = {
      listSessions: vi.fn(async () => ({
        ok: true,
        sessions: [{
          sessionId: 'session-252de13c-0d5b-4188-a3c7-d400c4d0655b',
          createdAt: Date.UTC(2026, 7, 23, 17, 27),
          title: '16% 压缩保留测试（完整分支）',
          parentSession: 'parent',
          current: true,
        }],
      })),
    } as unknown as SessionManager;

    const result = await sessionsCommand({ manager, config }).handler(commandContext('sessions'));

    expect(result).toContain('08-24 01:27');
    expect(result).toContain('16% 压缩保留测试（完整分支）');
    expect(result).toContain('(252de13c fork)');
    expect(result).toContain('●');
  });
});

describe('/switch', () => {
  it('passes the selector and QQ routing identity to SessionManager', async () => {
    const manager = {
      switchSession: vi.fn(async () => ({
        ok: true,
        session: {
          sessionId: 'session-252de13c-0d5b-4188-a3c7-d400c4d0655b',
          createdAt: Date.UTC(2026, 7, 23, 17, 27),
          title: '完整分支',
          current: true,
        },
      })),
    } as unknown as SessionManager;

    const result = await switchCommand({ manager, config }).handler(commandContext('switch', '252de13c'));

    expect(result).toContain('✅ 已切换会话');
    expect(manager.switchSession).toHaveBeenCalledWith(
      'c2c',
      'user-1',
      '252de13c',
      'user-1',
      expect.objectContaining({ targetId: 'user-1' }),
    );
  });
});
