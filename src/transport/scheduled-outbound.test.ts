import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryRoutes } from '../session/delivery-routes.js';
import { IdleEvictor } from '../session/idle-evictor.js';
import { createOutboundHandler } from './outbound.js';
import type { SessionManager, SessionRecord } from '../session/index.js';
import type { ImQQBotConfig } from '../config.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture(restart = false) {
  const directory = mkdtempSync(join(tmpdir(), 'qq-schedule-outbound-'));
  directories.push(directory);
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let routes = new DeliveryRoutes('app', logger, directory);
  routes.remember('session', { scope: 'c2c', targetId: 'peer', msgId: 'old-id' });
  if (restart) routes = new DeliveryRoutes('app', logger, directory);
  const record = { sessionId: 'session', lastActivity: 0, agent: { status: 'idle' }, replyTarget: { scope: 'c2c', targetId: 'peer', msgId: 'old-id' } } as SessionRecord;
  const records = new Map([['peer', record]]);
  const manager = { findBySessionId: (id: string) => [...records.values()].find(r => r.sessionId === id),
    getScheduledReplyTarget: (id: string) => routes.get(id), recordScheduledDelivery: routes.record.bind(routes) } as unknown as SessionManager;
  const bot = { sendMarkdown: vi.fn().mockResolvedValue({ id: 'accepted' }), openStream: vi.fn() };
  const handler = createOutboundHandler(manager, bot, { streaming: true, textChunkLimit: 4500 } as ImQQBotConfig, logger);
  const session = { header: { id: 'session' } };
  const emit = (type: string, data = {}, seq = 10, surfaceOp: unknown = 'append') => handler(session, { type, data, seq, surfaceOp });
  const schedule = () => { emit('turn/start'); emit('user/message', { source: { kind: 'schedule' } }); };
  const answer = () => { emit('assistant/chunk', { chunk: { type: 'text-delta', text: '早上好' } });
    emit('assistant/message', { message: { content: [{ type: 'text', text: '早上好' }] } }); emit('turn/end'); };
  const receipts = () => JSON.parse(readFileSync(join(directory, 'delivery-routes-app.json'), 'utf8')).receipts;
  return { records, record, bot, emit, handler, schedule, answer, receipts, logger };
}

describe('scheduled QQ outbound', () => {
  it.each([false, true])('delivers after idle eviction, including restored routes=%s', async restart => {
    const f = fixture(restart);
    const evictor = new IdleEvictor(f.records, 1800000, key => f.records.delete(key));
    evictor.check(); evictor.dispose();
    expect(f.records.size).toBe(0);
    f.schedule(); f.answer();
    await vi.waitFor(() => expect(f.bot.sendMarkdown).toHaveBeenCalledOnce());
    expect(f.bot.sendMarkdown).toHaveBeenCalledWith({ scope: 'c2c', targetId: 'peer' }, '早上好');
    expect(f.bot.openStream).not.toHaveBeenCalled();
    expect(f.receipts()[0]).toMatchObject({ status: 'accepted', chunksAccepted: 1, seq: 10 });
  });

  it('does not duplicate an active QQ delivery or reuse the old passive msgId', async () => {
    const f = fixture(); f.schedule(); f.answer();
    await vi.waitFor(() => expect(f.bot.sendMarkdown).toHaveBeenCalledOnce());
    expect(f.bot.sendMarkdown.mock.calls[0]?.[0]).not.toHaveProperty('msgId');
    f.emit('turn/start');
    f.emit('assistant/message', { message: { content: [{ type: 'text', text: 'ordinary' }] } });
    await vi.waitFor(() => expect(f.bot.sendMarkdown).toHaveBeenCalledTimes(2));
    expect(f.bot.sendMarkdown.mock.calls[1]?.[0]).toHaveProperty('msgId', 'old-id');
  });

  it('does not route an unrelated fork or replayed replacement to QQ', async () => {
    const f = fixture();
    const child = { header: { id: 'web-fork' } };
    f.handler(child, { type: 'user/message', data: { source: { kind: 'schedule' } } });
    f.handler(child, { type: 'assistant/message', seq: 10, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'private' }] } } });
    f.schedule();
    f.emit('assistant/message', { message: { content: [{ type: 'text', text: 'replacement' }] } }, 11, { op: 'replace' });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('records QQ rejection as failed rather than accepted', async () => {
    const f = fixture(); f.bot.sendMarkdown.mockRejectedValue(new Error('QQ rejected: test quota'));
    f.schedule(); f.answer();
    await vi.waitFor(() => expect(f.logger.error).toHaveBeenCalledOnce());
    expect(f.receipts()[0]).toMatchObject({ status: 'failed', chunksAccepted: 0, error: 'QQ rejected: test quota' });
  });

  it('does not evict an Agent currently generating a scheduled reply', () => {
    const f = fixture(); Object.assign(f.record.agent, { status: 'running' });
    const evictor = new IdleEvictor(f.records, 1800000, key => f.records.delete(key));
    evictor.check(); evictor.dispose();
    expect(f.records.size).toBe(1);
  });
});
