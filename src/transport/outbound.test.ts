import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { createOutboundHandler, registerOutboundEvents, type QQBotSender } from './outbound.js';
import type { ImQQBotConfig } from '../config.js';
import type { SessionManager, SessionRecord } from '../session/index.js';
import type { Logger, ReplyTarget } from '../types.js';

const target: ReplyTarget = { scope: 'c2c', targetId: 'user1', msgId: 'msg1' };

function setup(showToolResults = false) {
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
    showToolResults,
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

describe('V4 outbound events', () => {
  function transport() {
    const fixture = setup();
    const ctx = new Context();
    registerOutboundEvents(ctx, fixture.handler);
    const stream = (frame: unknown) => ctx.emit('agent/assistant-stream', {
      agent: { session: fixture.session }, frame,
    } as never);
    const message = (text: string) => ctx.emit('session/event', fixture.session as never, {
      type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } },
    } as never);
    return { ...fixture, stream, message };
  }

  it('delivers transient text once when the durable message commits', async () => {
    const { bot, stream, message } = transport();
    stream({ type: 'chunk', chunk: { type: 'text-delta', text: '完整' } });
    stream({ type: 'chunk', chunk: { type: 'text-delta', text: '回复' } });
    message('完整回复');
    stream({ type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 10 } });
    await vi.waitFor(() => expect(bot.sendMarkdown).toHaveBeenCalledTimes(1));
    expect(bot.sendMarkdown).toHaveBeenCalledWith(target, '完整回复');
  });

  it.each([
    { kind: 'abandoned' },
    { kind: 'committed', eventType: 'assistant/attempt', seq: 10 },
  ])('discards failed attempt text before the next stream: %j', async outcome => {
    const { bot, stream, message } = transport();
    stream({ type: 'chunk', chunk: { type: 'text-delta', text: '未完成的尝试' } });
    stream({ type: 'end', outcome });
    stream({ type: 'chunk', chunk: { type: 'text-delta', text: '成功重试' } });
    message('成功重试');
    await vi.waitFor(() => expect(bot.sendMarkdown).toHaveBeenCalledTimes(1));
    expect(bot.sendMarkdown).toHaveBeenCalledWith(target, '成功重试');
  });

  it('shows a flat V4 tool error even when successful tools are hidden', async () => {
    const { bot, handler, session } = setup();
    handler(session, { type: 'tool/call', data: { callId: 'call-1', name: 'read_file', arguments: '{}' } });
    handler(session, { type: 'tool/result', data: {
      message: { role: 'tool', toolCallId: 'call-1', isError: true, content: [{ type: 'text', text: 'file missing' }] },
    } });
    await vi.waitFor(() => expect(bot.sendMarkdown).toHaveBeenCalledTimes(1));
    expect(bot.sendMarkdown).toHaveBeenCalledWith(target, '❌ 工具 `read_file` 执行失败\nfile missing');
  });

  it('renders flat V4 tool text when tool results are enabled', async () => {
    const { bot, handler, session } = setup(true);
    handler(session, { type: 'tool/call', data: { callId: 'call-1', name: 'read_file', arguments: '{}' } });
    handler(session, { type: 'tool/result', data: {
      message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'file text' }] },
    } });
    await vi.waitFor(() => expect(bot.sendMarkdown).toHaveBeenCalledTimes(1));
    expect(bot.sendMarkdown).toHaveBeenCalledWith(target, '🔧 `read_file` 完成\nfile text');
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
