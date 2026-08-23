/** Clean regeneration of the latest completed user turn. */
import type { CommandDeps, CategorizedCommand } from './types.js';
import { getScopePeer } from '../shared/index.js';

export function retryCommand({ manager }: CommandDeps): CategorizedCommand {
  return {
    name: ['bot-retry', 'bot-regenerate'],
    category: 'agent',
    description: '干净重生成上一轮（执行过工具时需加 force）',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const args = cmdCtx.command.raw.trim();
      const force = args === 'force' || args === '--force';
      if (args && !force) return '用法: /bot-retry [force]';

      // Slash commands bypass the normal inbound handler. Rehydrate an idle-
      // evicted session before looking for its most recent completed turn.
      if (!manager.getSessionRecord(scope, peerId)) {
        await manager.getOrCreate(
          scope,
          peerId,
          cmdCtx.message.senderId,
          cmdCtx.replyTarget,
        );
      }

      const result = await manager.regenerateLast(scope, peerId, force);
      if (result.ok) return '已从上一轮之前创建干净分支并重新生成 ✓';
      if (result.reason === 'no-session') return '当前无活跃会话';
      if (result.reason === 'tool-risk') {
        return `⚠️ 上一轮执行过工具（${result.toolCount ?? 0} 个事件），重试可能重复产生外部操作。\n确认后请使用 /bot-retry force`;
      }
      return '找不到可重生成的上一轮用户消息';
    },
  };
}
