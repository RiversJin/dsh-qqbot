import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryRoutes } from './delivery-routes.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const logger = () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'qq-delivery-'));
  directories.push(directory);
  return { directory, log: logger(), path: join(directory, 'delivery-routes-app.json') };
}

describe('durable QQ schedule destinations', () => {
  it('survives restart without retaining passive reply ids; does not bind forks', () => {
    const { directory, log, path } = fixture();
    const first = new DeliveryRoutes('app', log, directory);
    first.remember('parent', { scope: 'c2c', targetId: 'peer', msgId: 'expired-reply' });
    const restored = new DeliveryRoutes('app', log, directory);
    expect(restored.get('parent')).toEqual({ scope: 'c2c', targetId: 'peer' });
    expect(restored.get('web-fork')).toBeUndefined();
    expect(readFileSync(path, 'utf8')).not.toContain('expired-reply');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('migrates only this bot current selections without changing legacy preferences', () => {
    const { directory, log } = fixture();
    const prefsPath = join(directory, 'model-prefs.json');
    const prefs = JSON.stringify({ sessionIds: { 'qqbot:app:c2c:peer': 'current', 'qqbot:app:group:group1': 'group-current',
      'qqbot:other:c2c:peer2': 'other-bot', 'qqbot:app:invalid:peer': 'invalid' }, sessionHistories: { 'qqbot:app:c2c:peer': ['old', 'current'] } });
    writeFileSync(prefsPath, prefs);
    const routes = new DeliveryRoutes('app', log, directory);
    expect(routes.get('current')).toEqual({ scope: 'c2c', targetId: 'peer' });
    expect(routes.get('group-current')).toEqual({ scope: 'group', targetId: 'group1' });
    for (const id of ['old', 'other-bot', 'invalid']) expect(routes.get(id)).toBeUndefined();
    expect(readFileSync(prefsPath, 'utf8')).toBe(prefs);
  });

  it('retains exact-session destinations when the peer moves to another session', () => {
    const { directory, log } = fixture();
    const routes = new DeliveryRoutes('app', log, directory);
    routes.remember('old', { scope: 'c2c', targetId: 'peer' });
    routes.remember('new', { scope: 'c2c', targetId: 'peer' });
    const restored = new DeliveryRoutes('app', log, directory);
    expect(restored.get('old')).toEqual(restored.get('new'));
  });

  it('preserves a damaged file and reports the load failure', () => {
    const { directory, log, path } = fixture();
    writeFileSync(path, 'damaged');
    const routes = new DeliveryRoutes('app', log, directory);
    routes.remember('test', { scope: 'c2c', targetId: 'peer' });
    expect(readFileSync(path, 'utf8')).toBe('damaged');
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('keeps bounded transport receipts separately from native scheduler delivery', () => {
    const { directory, log, path } = fixture();
    const routes = new DeliveryRoutes('app', log, directory);
    for (let seq = 0; seq < 103; seq++) routes.record({ sessionId: 'test', seq, at: new Date().toISOString(), status: 'accepted', chunksAccepted: 1 });
    const receipts = JSON.parse(readFileSync(path, 'utf8')).receipts;
    expect(receipts).toHaveLength(100);
    expect(receipts[0].seq).toBe(3);
  });
});
