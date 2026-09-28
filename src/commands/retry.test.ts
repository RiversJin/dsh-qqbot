import { describe, expect, it, vi } from 'vitest';
import { retryCommand } from './retry.js';
import type { SessionManager } from '../session/index.js';

function commandContext(raw = '') {
  return {
    command: { name: 'retry', args: raw ? [raw] : [], raw },
    message: { kind: 'c2c', senderId: 'user-1' },
    replyTarget: { scope: 'c2c', targetId: 'user-1', msgId: 'current-command' },
  } as never;
}

function fixture(result = { ok: true } as { ok: boolean; message?: string }) {
  const manager = { getOrCreate: vi.fn(async () => ({})), regenerateLast: vi.fn(async () => result) };
  const command = retryCommand({ manager: manager as unknown as SessionManager, config: {} as never });
  return { manager, command };
}

describe('/retry', () => {
  it('registers the short command and retains both old names', () => {
    expect(fixture().command.name).toEqual(['retry', 'bot-retry', 'bot-regenerate']);
  });

  it('restores cold sessions and updates the reply target before native retry', async () => {
    const { manager, command } = fixture();
    expect(await command.handler(commandContext())).toBe('已在当前会话从原问题重新生成 ✓');
    expect(manager.getOrCreate).toHaveBeenCalledWith('c2c', 'user-1', 'user-1', {
      scope: 'c2c', targetId: 'user-1', msgId: 'current-command',
    });
    expect(manager.regenerateLast).toHaveBeenCalledWith('c2c', 'user-1');
    expect(manager.getOrCreate.mock.invocationCallOrder[0]).toBeLessThan(manager.regenerateLast.mock.invocationCallOrder[0]!);
  });

  it.each(['force', '--force'])('accepts %s as an equivalent compatibility spelling', async raw => {
    const { manager, command } = fixture();
    await command.handler(commandContext(raw));
    expect(manager.regenerateLast).toHaveBeenCalledWith('c2c', 'user-1');
  });

  it('returns native busy or failure details without falling back to a fork', async () => {
    const { command } = fixture({ ok: false, message: '当前会话仍在运行，暂时不能重试。' });
    expect(await command.handler(commandContext())).toBe('当前会话仍在运行，暂时不能重试。');
  });

  it('rejects unexpected arguments before touching the session', async () => {
    const { manager, command } = fixture();
    expect(await command.handler(commandContext('something'))).toBe('用法: /retry');
    expect(manager.getOrCreate).not.toHaveBeenCalled();
    expect(manager.regenerateLast).not.toHaveBeenCalled();
  });
});
