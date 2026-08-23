import { describe, expect, it, vi } from 'vitest';
import { createOutboundHandler, type QQBotSender } from './outbound.js';
import type { ImQQBotConfig } from '../config.js';
import type { SessionManager, SessionRecord } from '../session/index.js';
import type { Logger, ReplyTarget } from '../types.js';

const target: ReplyTarget = { scope: 'c2c', targetId: 'user1', msgId: 'msg1' };

function setup() {
  const record = {
    sessionId: 'session-1',
    replyTarget: target,
    agent: {},
  } as unknown as SessionRecord;
  const manager = {
    findBySessionId: vi.fn(() => record),
  } as unknown as SessionManager;
  const bot: QQBotSender = {
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    openStream: vi.fn(),
  };
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const config = {
    streaming: false,
    textChunkLimit: 4500,
    showToolResults: false,
  } as ImQQBotConfig;
  return {
    bot,
    handler: createOutboundHandler(manager, bot, config, logger),
    session: { header: { id: 'session-1' } },
  };
}

describe('compaction prune notice', () => {
  it('sends one aggregated notice after the assistant reply', async () => {
    const { bot, handler, session } = setup();
    handler(session, { type: 'compaction/prune', data: { shadowedTokenCount: 100 } });
    handler(session, { type: 'compaction/prune', data: { shadowedTokenCount: 200 } });
    handler(session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '正常回复' }] } },
    });
    handler(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });

    await vi.waitFor(() => expect(bot.sendMarkdown).toHaveBeenCalledTimes(2));
    expect(bot.sendMarkdown).toHaveBeenNthCalledWith(1, target, '正常回复');
    expect(bot.sendMarkdown).toHaveBeenNthCalledWith(
      2,
      target,
      '🧹 已整理较早的 2 条工具输出，以减少上下文占用。',
    );
  });

  it('does not add a notice when no prune event occurred', async () => {
    const { bot, handler, session } = setup();
    handler(session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '普通回复' }] } },
    });
    handler(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });

    await vi.waitFor(() => expect(bot.sendMarkdown).toHaveBeenCalledTimes(1));
    expect(bot.sendMarkdown).toHaveBeenCalledWith(target, '普通回复');
  });
});

describe('browser agent notice', () => {
  it('announces the Luna browser worker before the assistant reply', async () => {
    const { bot, handler, session } = setup();
    handler(session, {
      type: 'tool/call',
      data: { callId: 'browser-1', name: 'browser_agent', arguments: '{"task":"检查网页"}' },
    });
    handler(session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '网页检查完成' }] } },
    });
    handler(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });

    await vi.waitFor(() => expect(bot.sendMarkdown).toHaveBeenCalledTimes(2));
    expect(bot.sendMarkdown).toHaveBeenNthCalledWith(1, target, '🌐 Luna 正在浏览网页…');
    expect(bot.sendMarkdown).toHaveBeenNthCalledWith(2, target, '网页检查完成');
  });

  it('keeps ordinary tool calls silent', async () => {
    const { bot, handler, session } = setup();
    handler(session, {
      type: 'tool/call',
      data: { callId: 'tool-1', name: 'read_file', arguments: '{}' },
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });
});
