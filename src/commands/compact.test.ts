import { describe, expect, it, vi } from 'vitest';
import { buildCommandList } from './index.js';
import { compactCommand } from './session.js';
import type { SessionManager } from '../session/index.js';
import type { CompactOutcome } from '../session/types.js';

const commandContext = (kind = 'c2c', raw = '') => ({
  command: { name: 'compact', raw, args: raw ? [raw] : [] },
  message: { kind, senderId: 'sender', groupOpenid: 'group-id' },
  replyTarget: { scope: kind, targetId: kind === 'group' ? 'group-id' : 'sender', msgId: 'compact-command' },
}) as never;
function fixture(outcome: CompactOutcome = { ok: true, message: 'Compacted 12 history items (~7000 tokens).' }) {
  const manager = { getOrCreate: vi.fn(async () => ({})), compact: vi.fn(async () => outcome) };
  const deps = { manager: manager as unknown as SessionManager, config: { textChunkLimit: 4500 } as never };
  return { manager, deps, command: compactCommand(deps) };
}

describe('/compact', () => {
  it('is registered in the standard command and help list', async () => {
    const { deps } = fixture(); const list = buildCommandList(deps);
    expect(list.filter(c => c.name === 'compact')).toHaveLength(1);
    const chunks: string[] = [];
    await list.find(c => c.name === 'bot-help')!.handler({ bot: { sendMarkdown: async (_target: unknown, text: string) => { chunks.push(text); } } } as never);
    expect(chunks.join('')).toContain('/compact');
  });
  it.each(['c2c', 'group'])('restores the current %s session before dispatching the native command', async kind => {
    const f = fixture();
    expect(await f.command.handler(commandContext(kind))).toBe('✅ 已压缩 12 条历史记录（原内容约 7000 tokens）');
    const peer = kind === 'group' ? 'group-id' : 'sender';
    expect(f.manager.getOrCreate).toHaveBeenCalledWith(kind, peer, 'sender', expect.objectContaining({ msgId: 'compact-command' }));
    expect(f.manager.compact).toHaveBeenCalledWith(kind, peer);
    expect(f.manager.getOrCreate.mock.invocationCallOrder[0]).toBeLessThan(f.manager.compact.mock.invocationCallOrder[0]!);
  });
  it.each([
    [{ ok: true, message: 'No compactable history yet.' }, '没有可压缩的历史'],
    [{ ok: false, reason: 'busy' }, '正在生成中，无法压缩'],
    [{ ok: false, reason: 'unavailable' }, '当前会话未启用压缩命令'],
    [{ ok: false, reason: 'failed', message: 'Compaction could not produce a useful summary.' }, '压缩失败: Compaction could not produce a useful summary.'],
  ] as const)('reports the actual result without hiding failures', async (result, expected) => {
    expect(await fixture(result).command.handler(commandContext())).toBe(expected);
  });
  it('rejects arguments before touching a session', async () => {
    const f = fixture(); expect(await f.command.handler(commandContext('c2c', 'now'))).toBe('用法: /compact');
    expect(f.manager.getOrCreate).not.toHaveBeenCalled(); expect(f.manager.compact).not.toHaveBeenCalled();
  });
});
