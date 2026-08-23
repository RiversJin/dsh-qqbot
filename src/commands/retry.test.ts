import { describe, expect, it, vi } from 'vitest';
import { retryCommand } from './retry.js';
import type { SessionManager } from '../session/index.js';

function commandContext(raw = '') {
  return {
    command: { name: 'bot-retry', args: raw ? [raw] : [], raw },
    message: { kind: 'c2c', senderId: 'user-1' },
    replyTarget: { scope: 'c2c', targetId: 'user-1', msgId: 'msg-1' },
  } as never;
}

describe('/bot-retry', () => {
  it('restores an idle-evicted session before regeneration', async () => {
    let active = false;
    const getOrCreate = vi.fn(async () => { active = true; });
    const regenerateLast = vi.fn(async () => ({ ok: true }));
    const manager = {
      getSessionRecord: vi.fn(() => active ? {} : undefined),
      getOrCreate,
      regenerateLast,
    } as unknown as SessionManager;

    const result = await retryCommand({ manager, config: {} as never }).handler(commandContext());

    expect(result).toBe('已从上一轮之前创建干净分支并重新生成 ✓');
    expect(getOrCreate).toHaveBeenCalledTimes(1);
    expect(regenerateLast).toHaveBeenCalledWith('c2c', 'user-1', false);
    expect(getOrCreate.mock.invocationCallOrder[0]).toBeLessThan(regenerateLast.mock.invocationCallOrder[0]!);
  });

  it('does not restore an already-active session and preserves force', async () => {
    const getOrCreate = vi.fn();
    const regenerateLast = vi.fn(async () => ({ ok: true }));
    const manager = {
      getSessionRecord: vi.fn(() => ({})),
      getOrCreate,
      regenerateLast,
    } as unknown as SessionManager;

    await retryCommand({ manager, config: {} as never }).handler(commandContext('--force'));

    expect(getOrCreate).not.toHaveBeenCalled();
    expect(regenerateLast).toHaveBeenCalledWith('c2c', 'user-1', true);
  });

  it('requires explicit force when the last turn used tools', async () => {
    const manager = {
      getSessionRecord: vi.fn(() => ({})),
      regenerateLast: vi.fn(async () => ({ ok: false, reason: 'tool-risk', toolCount: 2 })),
    } as unknown as SessionManager;

    const result = await retryCommand({ manager, config: {} as never }).handler(commandContext());

    expect(result).toContain('/bot-retry force');
    expect(result).toContain('2');
  });
});
