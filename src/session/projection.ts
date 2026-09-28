/** QQ 状态只保留汇总，不在每次命令中读取整份会话日志。 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
import { z } from 'zod';

const summarySchema = z.object({
  messageCount: z.number().int().nonnegative(),
  lastMessageAt: z.number().nullable(),
  title: z.string().nullable(),
  hasContent: z.boolean(),
  lastAssistantSeq: z.number().int().nullable(),
  usage: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() }),
});
export type QqSessionSummary = z.infer<typeof summarySchema>;

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { qqSessionSummary: QqSessionSummary }
}

export const emptySummary = (): QqSessionSummary => ({
  messageCount: 0, lastMessageAt: null, title: null, hasContent: false, lastAssistantSeq: null,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

export function foldQqSummary(state: QqSessionSummary, event: SessionEvent): QqSessionSummary {
  if (event.type === 'session/title') return { ...state, title: event.data.title.trim() || state.title, hasContent: true };
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return state;
  const realMessage = event.type === 'assistant/message' || event.data.source.kind === 'user';
  const usage = event.type === 'assistant/message' ? event.data.usage : undefined;
  return {
    ...state,
    messageCount: state.messageCount + 1,
    hasContent: true,
    lastMessageAt: realMessage ? event.time : state.lastMessageAt,
    lastAssistantSeq: event.type === 'assistant/message' ? event.seq : state.lastAssistantSeq,
    usage: usage === undefined ? state.usage : {
      input: state.usage.input + usage.inputTokens,
      output: state.usage.output + usage.outputTokens,
      cacheRead: state.usage.cacheRead + (usage.cacheReadTokens ?? 0),
      cacheWrite: state.usage.cacheWrite + (usage.cacheWriteTokens ?? 0),
    },
  };
}

export const qqSessionSummary: ProjectionDefinition<'qqSessionSummary'> = {
  key: 'qqSessionSummary', stateVersion: 1, stateSchema: summarySchema,
  init: emptySummary, apply: foldQqSummary,
};

export function registerQqSessionSummary(ctx: Context): void {
  ctx.sessionProjections.register(qqSessionSummary);
}
