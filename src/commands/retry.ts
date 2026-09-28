/** In-place regeneration of the latest user turn. */
import type { CommandDeps, CategorizedCommand } from './types.js';
import { getScopePeer } from '../shared/index.js';

export function retryCommand({ manager }: CommandDeps): CategorizedCommand {
  return {
    name: ['retry', 'bot-retry', 'bot-regenerate'],
    category: 'agent',
    description: '从原问题原地重试本轮回答，工具重新执行',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const args = cmdCtx.command.raw.trim();
      // Compatibility aliases only; tools no longer require confirmation.
      if (args && args !== 'force' && args !== '--force') return '用法: /retry';

      // Slash commands bypass inbound: restore cold sessions and refresh the
      // reply target to this command's message, including for already-live peers.
      await manager.getOrCreate(scope, peerId, cmdCtx.message.senderId, cmdCtx.replyTarget);
      const result = await manager.regenerateLast(scope, peerId);
      if (result.ok) return '已在当前会话从原问题重新生成 ✓';
      if (result.reason === 'no-session') return '当前无活跃会话';
      return result.message ?? '无法开始重试';
    },
  };
}
