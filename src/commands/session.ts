/**
 * 会话相关命令
 *
 * - /new（别名 /reset /clear）：开始新会话（换新 sessionId）
 * - /compact：原地压缩会话历史（保留 sessionId，压缩结果替换旧历史）
 *
 * 两者都对应底层 dsh agent 能力，分类为 agent（通用能力）。
 */
import type { CommandDeps, CategorizedCommand } from './types.js';
import { getScopePeer } from '../shared/index.js';

/** /new（别名 /reset /clear）— 开始新会话 */
export function newCommand({ manager }: CommandDeps): CategorizedCommand {
  return {
    name: ['new', 'reset', 'clear'],
    category: 'agent',
    description: '开始新会话（清空上下文）',
    handler: (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      void manager.remove(scope, peerId);
      return '已开启新会话 ✓';
    },
  };
}

/** /compact — 原地压缩会话历史 */
export function compactCommand({ manager }: CommandDeps): CategorizedCommand {
  return {
    name: 'compact',
    category: 'agent',
    description: '原地压缩当前会话，使用已配置的压缩引擎',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      if (cmdCtx.command.raw.trim()) return '用法: /compact';
      // Slash commands bypass inbound admission, so restore the current peer
      // session and enforce the same workspace/permission policy first.
      await manager.getOrCreate(scope, peerId, cmdCtx.message.senderId, cmdCtx.replyTarget);
      const outcome = await manager.compact(scope, peerId);

      if (outcome.ok) {
        if (outcome.message === 'No compactable history yet.') return '没有可压缩的历史';
        const count = outcome.message?.match(/^Compacted (\d+) history items \(~(\d+) tokens\)\.$/);
        if (count) return `✅ 已压缩 ${count[1]} 条历史记录（原内容约 ${count[2]} tokens）`;
        return outcome.message ?? '已完成当前会话压缩 ✓';
      }

      switch (outcome.reason) {
        case 'no-session':
          return '当前无活跃会话';
        case 'busy':
          return '正在生成中，无法压缩';
        case 'unavailable':
          return '当前会话未启用压缩命令';
        default:
          return `压缩失败: ${outcome.message ?? '未知错误'}`;
      }
    },
  };
}
