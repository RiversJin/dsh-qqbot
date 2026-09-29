import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Logger, ReplyTarget } from '../types.js';

export interface DeliveryReceipt {
  sessionId: string;
  seq: number;
  at: string;
  status: 'accepted' | 'failed';
  chunksAccepted: number;
  error?: string;
}

/** Exact-session QQ destinations survive Agent eviction. Never retain msgId:
 * scheduled output is a proactive send, not a reply to an old inbound message. */
export class DeliveryRoutes {
  private readonly routes = new Map<string, ReplyTarget>();
  private receipts: DeliveryReceipt[] = [];
  private readonly path: string;
  private writable = true;

  constructor(
    appId: string,
    private readonly logger: Logger,
    private readonly directory = join(homedir(), '.dsh-qqbot'),
  ) {
    this.path = join(directory, `delivery-routes-${encodeURIComponent(appId)}.json`);
    try {
      if (existsSync(this.path)) {
        const data = JSON.parse(readFileSync(this.path, 'utf8'));
        if (data.version !== 1 || !data.routes || typeof data.routes !== 'object') throw new Error('invalid delivery route file');
        for (const [id, value] of Object.entries(data.routes)) {
          const target = value as Partial<ReplyTarget> | null;
          if (target && (target.scope === 'c2c' || target.scope === 'group') && typeof target.targetId === 'string' && target.targetId) {
            this.routes.set(id, { scope: target.scope, targetId: target.targetId });
          }
        }
        if (Array.isArray(data.receipts)) this.receipts = data.receipts.slice(-100);
      }
    } catch (error) {
      // Keep a damaged file intact for recovery rather than replacing it.
      this.writable = false;
      logger.error(`QQ delivery routes could not be loaded: ${String(error)}`);
    }

    // Upgrade existing installations without waiting for another QQ message.
    // Only the explicitly selected session is migrated, never its ancestors,
    // arbitrary Web forks, or the whole session history.
    const prefsPath = join(directory, 'model-prefs.json');
    if (!existsSync(prefsPath)) return;
    try {
      const prefs = JSON.parse(readFileSync(prefsPath, 'utf8'));
      const prefix = `qqbot:${appId}:`;
      for (const [key, id] of Object.entries(prefs.sessionIds ?? {})) {
        if (!key.startsWith(prefix) || typeof id !== 'string' || !id || this.routes.has(id)) continue;
        const rest = key.slice(prefix.length), separator = rest.indexOf(':');
        const scope = rest.slice(0, separator), targetId = rest.slice(separator + 1);
        if ((scope === 'c2c' || scope === 'group') && targetId) this.remember(id, { scope, targetId });
      }
    } catch (error) {
      logger.error(`QQ delivery route migration failed: ${String(error)}`);
    }
  }

  get(sessionId: string): ReplyTarget | undefined {
    const target = this.routes.get(sessionId);
    return target ? { ...target } : undefined;
  }

  remember(sessionId: string, target: ReplyTarget): void {
    const previous = this.routes.get(sessionId);
    if (previous?.scope === target.scope && previous.targetId === target.targetId) return;
    this.routes.set(sessionId, { scope: target.scope, targetId: target.targetId });
    this.save();
  }

  record(receipt: DeliveryReceipt): void {
    this.receipts = [...this.receipts, receipt].slice(-100);
    this.save();
  }

  private save(): void {
    if (!this.writable) return;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, routes: Object.fromEntries(this.routes), receipts: this.receipts }, null, 2) + '\n', { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch (error) {
      this.logger.error(`QQ delivery routes could not be saved: ${String(error)}`);
    }
  }
}
