/** QQ session listing and persisted branch switching. */
import type { CommandDeps, CategorizedCommand } from './types.js';
import type { SelectableSession } from '../session/index.js';
import { getScopePeer } from '../shared/index.js';

function shortSessionId(sessionId: string): string {
  const normalized = sessionId.startsWith('session-')
    ? sessionId.slice('session-'.length)
    : sessionId;
  return normalized.slice(0, 8);
}

function sessionTime(createdAt: number | undefined, timeZone: string): string {
  if (createdAt === undefined || !Number.isFinite(createdAt)) return '时间未知';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(createdAt));
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '??';
  return `${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`;
}

function safeTitle(title: string | undefined): string {
  if (!title) return '未命名会话';
  const singleLine = title.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  return singleLine.length > 36 ? `${singleLine.slice(0, 35)}…` : singleLine;
}

function renderSession(session: SelectableSession, index: number, timeZone: string): string {
  const marker = session.current ? '●' : '○';
  const fork = session.parentSession ? ' fork' : '';
  return `${index + 1}. ${marker} ${sessionTime(session.createdAt, timeZone)}  ${safeTitle(session.title)}  (${shortSessionId(session.sessionId)}${fork})`;
}

/** /sessions — list recent branches selectable by this QQ peer. */
export function sessionsCommand({ manager, config }: CommandDeps): CategorizedCommand {
  return {
    name: ['sessions', 'session-list'],
    category: 'agent',
    description: '列出最近会话（含创建/fork 时间）',
    handler: async (cmdCtx) => {
      if (cmdCtx.command.raw.trim()) return '用法: /sessions';
      const { scope, peerId } = getScopePeer(cmdCtx);
      const result = await manager.listSessions(scope, peerId);
      if (!result.ok) return `会话列表读取失败: ${result.message ?? '未知错误'}`;
      if (result.sessions.length === 0) return '暂无可选择的会话';
      return [
        '🗂 最近会话',
        ...result.sessions.map((session, index) => renderSession(session, index, config.timestampTimeZone)),
        '',
        '● 为当前会话；使用 /switch 序号 或 /switch 短ID',
      ].join('\n');
    },
  };
}

/** /switch (alias /resume) — switch to one persisted branch from /sessions. */
export function switchCommand({ manager, config }: CommandDeps): CategorizedCommand {
  return {
    name: ['switch', 'resume'],
    category: 'agent',
    description: '切换到已有会话（序号或短ID）',
    handler: async (cmdCtx) => {
      const selector = cmdCtx.command.raw.trim();
      if (!selector) return '用法: /switch <序号或短ID>\n先用 /sessions 查看可选会话';
      const { scope, peerId } = getScopePeer(cmdCtx);
      const result = await manager.switchSession(
        scope,
        peerId,
        selector,
        cmdCtx.message.senderId,
        cmdCtx.replyTarget,
      );
      if (result.ok && result.session) {
        return [
          '✅ 已切换会话',
          `时间: ${sessionTime(result.session.createdAt, config.timestampTimeZone)}`,
          `标题: ${safeTitle(result.session.title)}`,
          `会话: ${shortSessionId(result.session.sessionId)}`,
        ].join('\n');
      }
      if (result.reason === 'busy') return '当前正在生成，请等待完成或先使用 /stop';
      if (result.reason === 'ambiguous') {
        const ids = (result.matches ?? []).map((session) => shortSessionId(session.sessionId)).join('、');
        return `短ID不唯一（${ids}），请使用更多字符或 /sessions 中的序号`;
      }
      if (result.reason === 'not-found') return '找不到该会话，请先使用 /sessions 查看可选会话';
      return `切换失败: ${result.message ?? '未知错误'}`;
    },
  };
}
