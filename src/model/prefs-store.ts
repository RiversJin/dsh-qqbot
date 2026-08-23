/**
 * PrefsStore — per-peer 模型偏好持久化
 *
 * 隔离文件 I/O 操作，便于单元测试时 mock。
 * 存储路径：~/.dsh-qqbot/model-prefs.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { ModelRoute } from './types.js';

/** 日志回调（可选） */
type DebugFn = (msg: string) => void;

/** 隔离偏好文件结构 */
interface PrefsFile {
  overrides: Record<string, ModelRoute>;
  /** sessionKey → 最新 sessionId（fork 后更新，用于重启后恢复到 fork 后的会话） */
  sessionIds: Record<string, string>;
  /** sessionKey → connector 创建的会话分支（oldest → newest） */
  sessionHistories?: Record<string, string[]>;
}

export class PrefsStore {
  /** per-peer 模型偏好（内存态） */
  private overrides = new Map<string, ModelRoute>();
  /** per-peer 最新 sessionId（fork 后更新，内存态） */
  private sessionIds = new Map<string, string>();
  /** per-peer connector session history（oldest → newest） */
  private sessionHistories = new Map<string, string[]>();
  /** 隔离偏好文件路径 */
  private readonly prefsPath: string;
  private readonly debugLog?: DebugFn;

  constructor(debugLog?: DebugFn) {
    this.prefsPath = resolve(homedir(), '.dsh-qqbot', 'model-prefs.json');
    this.debugLog = debugLog;
    this.load();
  }

  // ── Override 操作 ──

  getOverride(sessionKey: string): ModelRoute | undefined {
    return this.overrides.get(sessionKey);
  }

  setOverride(sessionKey: string, route: ModelRoute): void {
    this.overrides.set(sessionKey, route);
    this.write();
  }

  clearOverride(sessionKey: string): boolean {
    const deleted = this.overrides.delete(sessionKey);
    if (deleted) this.write();
    return deleted;
  }

  hasOverride(sessionKey: string): boolean {
    return this.overrides.has(sessionKey);
  }

  // ── SessionId 操作 ──

  getSessionId(sessionKey: string): string | undefined {
    return this.sessionIds.get(sessionKey);
  }

  setSessionId(sessionKey: string, sessionId: string): void {
    this.sessionIds.set(sessionKey, sessionId);
    this.write();
  }

  clearSessionId(sessionKey: string): boolean {
    const deleted = this.sessionIds.delete(sessionKey);
    if (deleted) this.write();
    return deleted;
  }

  getSessionHistory(sessionKey: string): string[] {
    return [...(this.sessionHistories.get(sessionKey) ?? [])];
  }

  setSessionHistory(sessionKey: string, sessionIds: readonly string[]): void {
    this.sessionHistories.set(sessionKey, [...sessionIds]);
    this.write();
  }

  // ── 私有方法 ──

  private load(): void {
    try {
      if (!existsSync(this.prefsPath)) return;
      const content = readFileSync(this.prefsPath, 'utf8');
      const data = JSON.parse(content) as PrefsFile;
      if (data.overrides && typeof data.overrides === 'object') {
        for (const [key, route] of Object.entries(data.overrides)) {
          if (route.provider && route.model) {
            this.overrides.set(key, { provider: route.provider, model: route.model });
          }
        }
      }
      if (data.sessionIds && typeof data.sessionIds === 'object') {
        for (const [key, sessionId] of Object.entries(data.sessionIds)) {
          if (typeof sessionId === 'string' && sessionId) {
            this.sessionIds.set(key, sessionId);
          }
        }
      }
      if (data.sessionHistories && typeof data.sessionHistories === 'object') {
        for (const [key, sessionIds] of Object.entries(data.sessionHistories)) {
          if (!Array.isArray(sessionIds)) continue;
          const valid = sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
          if (valid.length > 0) {
            this.sessionHistories.set(key, [...new Set(valid)]);
          }
        }
      }
    } catch (err) {
      this.debugLog?.(`loadPrefs failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.prefsPath), { recursive: true });
      const data: PrefsFile = {
        overrides: Object.fromEntries(this.overrides.entries()),
        sessionIds: Object.fromEntries(this.sessionIds.entries()),
        sessionHistories: Object.fromEntries(this.sessionHistories.entries()),
      };
      writeFileSync(this.prefsPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      this.debugLog?.(`writePrefs failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
