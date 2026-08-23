import { describe, expect, it } from 'vitest';
import { formatMessageTimestamp, parseMessageTimestamp, selectCurrentTimestamp } from './inbound.js';

describe('sparse timestamps', () => {
  it('accepts seconds, milliseconds, and ISO timestamps', () => {
    expect(parseMessageTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
    expect(parseMessageTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(parseMessageTimestamp('2026-08-23T00:00:00Z')).toBe(Date.UTC(2026, 7, 23));
  });

  it('emits on first message, interval, and date transition', () => {
    const base = Date.UTC(2026, 7, 23, 0, 0);
    const policy = { key: `test-${crypto.randomUUID()}`, timeZone: 'Asia/Singapore', intervalMs: 30 * 60 * 1000 };

    expect(selectCurrentTimestamp(base, policy)).toBe('[08-23 08:00]');
    expect(selectCurrentTimestamp(base + 10 * 60 * 1000, policy)).toBe('');
    expect(selectCurrentTimestamp(base + 31 * 60 * 1000, policy)).toBe('[08:31]');
    expect(selectCurrentTimestamp(base + 24 * 60 * 60 * 1000, policy)).toBe('[08-24 08:00]');
  });

  it('returns a short timestamp when the date is omitted', () => {
    expect(formatMessageTimestamp(Date.UTC(2026, 7, 23, 0, 5), 'Asia/Singapore', false)).toBe('[08:05]');
  });
});
