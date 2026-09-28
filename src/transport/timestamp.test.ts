import { describe, expect, it } from 'vitest';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionManager } from '../session/index.js';
import type { ImQQBotConfig } from '../config.js';
import { handleInbound } from './inbound.js';

async function body(kind: 'c2c' | 'group', content: string, state = {}) {
  const messages: UserMessage[] = [];
  const manager = { async getOrCreate() { return { agent: { followup(message: UserMessage) { messages.push(message); } } }; } } as unknown as SessionManager;
  await handleInbound({ kind, content, senderId: 'alice-id', senderName: 'Alice', messageId: 'test', timestamp: '2026-09-28T00:00:00Z' },
    manager, { appId: 'test' } as ImQQBotConfig, { info() {}, warn() {}, error() {}, debug() {} }, state);
  return messages.map(m => m.content.map(b => b.type === 'text' ? b.text : '').join('')).join('');
}

describe('QQ time context belongs to the native time-context plugin', () => {
  it('preserves direct user text exactly, including human-authored dates', async () => {
    expect(await body('c2c', '[09-28 08:00] meet at 09:00')).toBe('[09-28 08:00] meet at 09:00');
  });
  it('keeps quotes and sender context without injecting timestamps', async () => {
    const result = await body('group', 'hello', { mention: { wasMentioned: true },
      quote: { entry: { content: 'quoted text', timestamp: '2026-09-27T00:00:00Z' } },
      history: [{ senderId: 'bob-id', senderName: 'Bob', content: 'history text', timestamp: Date.UTC(2026, 8, 27) }],
    });
    expect(result).toContain('[Bob (bob-id)] history text');
    expect(result).toContain('[Quoted message begins]\nquoted text\n[Quoted message ends]');
    expect(result).toContain('[Alice (alice-id)] hello (@you)');
    expect(result).not.toMatch(/\[\d{2}-\d{2} \d{2}:\d{2}\]/);
  });
});
