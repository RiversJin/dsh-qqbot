/**
 * SessionManager — 管理 QQ peer → dsh Agent 的映射和生命周期
 *
 * sessionKey 格式: `qqbot:${appId}:${kind}:${peerId}`
 *   - c2c:   peerId = senderId (用户 openid)
 *   - group: peerId = groupOpenid
 *
 * SessionId 由 sessionKey 确定性派生（SHA-256），
 * 保证同一个用户/群的消息始终路由到同一个会话，
 * 重启后可根据 key 恢复 session。
 *
 * 支持 agent-presets 系统：通过 setup hook 在 create/resume 时
 * 挂载 preset（工具集、prompt sections 等），实现场景化配置。
 */
import { createHash, randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { ChatScope, Logger, ReplyTarget } from '../types.js';
import type { ImQQBotConfig } from '../config.js';
import { ModelResolver } from '../model/model-resolver.js';
import type { ModelRoute, ModelEntry } from '../model/types.js';
import { IdleEvictor } from './idle-evictor.js';
import type {
  SessionEventLike,
  DshAgent,
  DshAgentHandle,
  SessionsService,
  DshAgentRegistry,
  AgentPresetsLike,
  PresetComposition,
  SessionRecord,
  SessionStatus,
  TokenUsageStats,
  SessionHeaderLike,
  SessionPersistenceLike,
  SelectableSession,
  SessionListOutcome,
  SwitchSessionOutcome,
  CompactionServiceLike,
  CompactOutcome,
  PermissionPresetsLike,
  WorkspaceRegistryLike,
  ImageAttachmentLimitsLike,
  AttachmentsLike,
  NativeImageInput,
  LlmResolverLike,
  ApiProxyLike,
} from './types.js';

/** ManualCompactionError 各 code 的友好提示（对齐 command-compact 的 expectedFailure 语义） */
const COMPACTION_ERROR_HINTS: Record<string, string> = {
  busy: '压缩服务忙，请稍后重试',
  cancelled: '压缩已取消',
  changed: '历史在压缩过程中发生变化，请重试',
  commit: '压缩提交失败',
  persistence: '压缩完成但保存失败',
};

export class SessionManager {
  private sessions = new Map<string, SessionRecord>();
  private retentionTasks = new Map<string, Promise<void>>();
  private readonly evictor: IdleEvictor;
  private readonly modelResolver: ModelResolver;

  constructor(
    private readonly ctx: Context,
    private readonly agents: DshAgentRegistry,
    private readonly config: ImQQBotConfig,
    private readonly logger: Logger,
  ) {
    this.modelResolver = new ModelResolver(ctx, config, logger);

    this.evictor = new IdleEvictor(
      this.sessions,
      config.sessionIdleTimeout,
      (key, record) => {
        this.logger.info(`evicting idle session: key=${key}`);
        this.sessions.delete(key);
        record.agent.cancel({ kind: 'user' });
        void record.handle.dispose().catch(() => {});
      },
    );
  }

  /**
   * 动态获取 sessions 服务（fork 能力，可选）
   */
  private getSessionsService(): SessionsService | undefined {
    try {
      return this.ctx.get('sessions') as SessionsService | undefined;
    } catch {
      return undefined;
    }
  }

  private getApiProxy(): ApiProxyLike | undefined {
    try {
      return this.ctx.get('apiProxy') as ApiProxyLike | undefined;
    } catch {
      return undefined;
    }
  }

  /** Read Web's live session-local selection, then the durable route, then QQ defaults. */
  private async resolveSessionRoute(
    record: SessionRecord,
    fallback: ModelRoute | undefined,
  ): Promise<{
    route: ModelRoute | undefined;
    /** True when Web has an unlogged selection that must be copied to a new branch. */
    pendingSelection: boolean;
  }> {
    const logged = sessionRequestRoute(record.agent);
    let current: ModelRoute | undefined;
    const apiProxy = this.getApiProxy();

    if (apiProxy) {
      try {
        const response = await apiProxy.sessions.models({
          rpcId: randomUUID(),
          payload: { sessionId: record.sessionId },
        });
        if (response.result.ok) {
          current = normalizeModelRoute(response.result.value.current);
        } else {
          this.logger.debug(`session model selection unavailable: sessionId=${record.sessionId} code=${response.result.error.code}`);
        }
      } catch (error) {
        this.logger.debug(`session model selection lookup failed: sessionId=${record.sessionId} err=${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      route: selectSessionModelRoute(current, logged, fallback),
      pendingSelection: current !== undefined && !sameModelRoute(current, logged),
    };
  }

  /** Read the latest durable request route before resuming a cold session. */
  private async inspectSessionRoute(sessionId: string): Promise<ModelRoute | undefined> {
    let persistence: SessionPersistenceLike | undefined;
    try {
      persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined;
    } catch {
      return undefined;
    }
    if (!persistence) return undefined;

    try {
      const inspected = await persistence.inspect(SessionId(sessionId));
      return latestSessionModelRoute(inspected.events);
    } catch (error) {
      this.logger.debug(`session model route inspection failed: sessionId=${sessionId} err=${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** Copy a pending Web selection onto a newly-created retry branch. */
  private async applyPendingSelection(sessionId: string, route: ModelRoute): Promise<void> {
    const apiProxy = this.getApiProxy();
    if (!apiProxy) return;

    try {
      const response = await apiProxy.sessions.selectModel({
        rpcId: randomUUID(),
        payload: { sessionId, ...route },
      });
      if (!response.result.ok) {
        this.logger.warn(`failed to copy pending model selection: sessionId=${sessionId} code=${response.result.error.code} err=${response.result.error.message}`);
      }
    } catch (error) {
      this.logger.warn(`failed to copy pending model selection: sessionId=${sessionId} err=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Enforce the connector-level permission policy on every QQ-owned session. */
  private applyConfiguredPermission(agent: DshAgent): void {
    const configured = this.config.permissionPreset;
    if (!configured) return;

    let presets: PermissionPresetsLike | undefined;
    try {
      presets = this.ctx.get('permissionPresets') as PermissionPresetsLike | undefined;
    } catch {
      // Handled by the explicit failure below.
    }
    if (!presets) {
      throw new Error(`im-qqbot: permission preset ${configured} requested but permissionPresets service is unavailable`);
    }

    presets.set(agent.session, configured);
    const effective = presets.current(agent.session.events);
    if (effective !== configured) {
      throw new Error(`im-qqbot: failed to persist permission preset ${configured}; effective=${effective}`);
    }
  }

  /** Attach QQ-owned sessions to their configured DSH Workspace. */
  private async attachConfiguredWorkspace(agent: DshAgent): Promise<void> {
    const configured = this.config.workspacePath;
    if (!configured) return;

    let registry: WorkspaceRegistryLike | undefined;
    try {
      registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined;
    } catch {
      // Handled by the explicit failure below.
    }
    if (!registry) {
      throw new Error(`im-qqbot: workspace ${configured} requested but workspaceRegistry service is unavailable`);
    }

    const workspace = await registry.resolveByPath(configured);
    if (!workspace) {
      throw new Error(`im-qqbot: configured workspace does not exist: ${configured}`);
    }
    await workspace.attachSession(agent.session.id);
  }

  getImageAttachmentLimits(): ImageAttachmentLimitsLike | undefined {
    try {
      return (this.ctx.get('attachments') as AttachmentsLike | undefined)?.imageLimits;
    } catch {
      return undefined;
    }
  }

  async persistImages(
    scope: ChatScope,
    peerId: string,
    inputs: readonly NativeImageInput[],
  ): Promise<readonly unknown[]> {
    if (inputs.length === 0) return [];

    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    const fallback = this.modelResolver.getEffectiveRoute(key);
    const route = record
      ? (await this.resolveSessionRoute(record, fallback)).route
      : fallback;
    if (route) {
      let llm: LlmResolverLike | undefined;
      try {
        llm = this.ctx.get('llm') as LlmResolverLike | undefined;
      } catch {
        // The model adapter remains the final capability boundary.
      }
      if (llm?.resolveModelInfo) {
        const modelInfo = await llm.resolveModelInfo(route.provider, route.model);
        if (modelInfo.inputModalities && !modelInfo.inputModalities.includes('image')) {
          throw new Error(`model ${route.provider}/${route.model} does not support image input`);
        }
      }
    }

    let attachments: AttachmentsLike | undefined;
    try {
      attachments = this.ctx.get('attachments') as AttachmentsLike | undefined;
    } catch {
      // Handled below.
    }
    if (!attachments) throw new Error('DSH attachment service is unavailable');
    return attachments.saveImages(inputs);
  }

  /** Serialize per-peer retention updates and archive branches beyond the limit. */
  private async rememberVisibleSessions(
    sessionKey: string,
    sessionIds: readonly string[],
    prune = true,
  ): Promise<void> {
    const previous = this.retentionTasks.get(sessionKey) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(() => this.updateVisibleSessions(sessionKey, sessionIds, prune));
    this.retentionTasks.set(sessionKey, task);
    try {
      await task;
    } finally {
      if (this.retentionTasks.get(sessionKey) === task) {
        this.retentionTasks.delete(sessionKey);
      }
    }
  }

  private async updateVisibleSessions(
    sessionKey: string,
    sessionIds: readonly string[],
    prune: boolean,
  ): Promise<void> {
    const existing = this.modelResolver.getSessionHistory(sessionKey);
    const ordered = [...existing];
    for (const sessionId of sessionIds) {
      const previous = ordered.indexOf(sessionId);
      if (previous >= 0) ordered.splice(previous, 1);
      ordered.push(sessionId);
    }

    const changed = ordered.length !== existing.length
      || ordered.some((sessionId, index) => sessionId !== existing[index]);
    if (changed) this.modelResolver.setSessionHistory(sessionKey, ordered);
    if (!prune) return;

    const configuredLimit = Number(this.config.visibleSessionLimit);
    const limit = Number.isFinite(configuredLimit)
      ? Math.max(1, Math.floor(configuredLimit))
      : 16;
    if (ordered.length <= limit) return;

    let registry: WorkspaceRegistryLike | undefined;
    try {
      registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined;
    } catch {
      // Keep the full queue so pruning can be retried later.
    }
    if (!registry) {
      this.logger.warn(`session retention deferred: workspaceRegistry unavailable key=${sessionKey}`);
      return;
    }

    const overflow = ordered.slice(0, ordered.length - limit);
    const failed: string[] = [];
    for (const sessionId of overflow) {
      try {
        await registry.archiveSession(SessionId(sessionId));
        this.logger.info(`archived old connector session: key=${sessionKey} sessionId=${sessionId}`);
      } catch (err) {
        failed.push(sessionId);
        this.logger.warn(`failed to archive connector session: key=${sessionKey} sessionId=${sessionId} err=${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.modelResolver.setSessionHistory(sessionKey, [
      ...failed,
      ...ordered.slice(ordered.length - limit),
    ]);
  }

  // ── 模型相关（委托给 ModelResolver） ──

  getEffectiveModel(scope: ChatScope, peerId: string): ModelRoute | undefined {
    const key = this.sessionKey(scope, peerId);
    const fallback = this.modelResolver.getEffectiveRoute(key);
    const record = this.sessions.get(key);
    return record
      ? selectSessionModelRoute(undefined, sessionRequestRoute(record.agent), fallback)
      : fallback;
  }

  /**
   * 切换模型（fork + 重建，对齐 dsh-TUI 的 switchModel）
   */
  async setModelOverride(scope: ChatScope, peerId: string, route: ModelRoute): Promise<void> {
    const key = this.sessionKey(scope, peerId);

    this.modelResolver.setOverride(key, route);

    const record = this.sessions.get(key);
    if (!record) {
      this.logger.info(`model pref saved (no active session): key=${key} → ${route.provider}/${route.model}`);
      return;
    }

    const sessionsService = this.getSessionsService();
    if (!sessionsService) {
      this.logger.warn(`fork unavailable, fallback to dispose: key=${key}`);
      this.sessions.delete(key);
      record.agent.cancel({ kind: 'user' });
      await record.handle.dispose().catch(() => {});
      return;
    }

    let seed: readonly unknown[];
    try {
      seed = sessionsService.fork(record.agent.session).events;
    } catch (err) {
      this.logger.warn(`fork failed, fallback to dispose: key=${key} err=${err instanceof Error ? err.message : String(err)}`);
      this.sessions.delete(key);
      record.agent.cancel({ kind: 'user' });
      await record.handle.dispose().catch(() => {});
      return;
    }

    const parentId = record.sessionId;
    const childId = SessionId(randomUUID());

    const composed = await this.composePreset(this.config.preset);
    const created = await this.agents.create({
      sessionId: childId,
      seed,
      meta: {
        cwd: this.config.cwd || process.cwd(),
        parentSession: record.sessionId,
        seedLength: seed.length,
        ...(composed.agentPreset ? { agentPreset: composed.agentPreset } : {}),
      },
      agentOptions: agentOptionsFor(route),
      ...(composed.setup ? { setup: composed.setup } : {}),
    });

    this.applyConfiguredPermission(created.agent);
    await this.attachConfiguredWorkspace(created.agent);

    this.modelResolver.setSessionId(key, childId);

    const oldHandle = record.handle;
    record.sessionId = childId;
    record.agent = created.agent;
    record.handle = created;
    record.agentPreset = composed.agentPreset;
    record.lastActivity = Date.now();

    void oldHandle.dispose().catch(() => {});
    await this.rememberVisibleSessions(key, [parentId, childId]);
    this.logger.info(`model switched via fork: key=${key} → ${route.provider}/${route.model} sessionId=${childId}`);
  }

  /**
   * Re-run the latest user turn from a clean branch. The original conversation
   * is not mutated; the child is seeded before turn/start and receives the
   * original user message again.
   */
  async regenerateLast(
    scope: ChatScope,
    peerId: string,
    force = false,
  ): Promise<{
    ok: boolean;
    reason?: 'no-session' | 'no-turn' | 'tool-risk';
    toolCount?: number;
    sessionId?: string;
  }> {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    if (!record) return { ok: false, reason: 'no-session' };

    await record.agent.whenIdle();
    const sourceEvents = [...(record.agent.session.events ?? [])];
    const retryable = findLastRetryableTurn(sourceEvents);
    if (!retryable) return { ok: false, reason: 'no-turn' };
    if (retryable.toolCount > 0 && !force) {
      return { ok: false, reason: 'tool-risk', toolCount: retryable.toolCount };
    }

    const originalMessage = retryable.userEvent.data ?? retryable.userEvent.message;
    if (!originalMessage) return { ok: false, reason: 'no-turn' };

    const parentId = record.sessionId;
    const childId = SessionId(randomUUID());
    const seed = sourceEvents.slice(0, retryable.startIndex);
    const resolvedRoute = await this.resolveSessionRoute(
      record,
      this.modelResolver.getEffectiveRoute(key),
    );
    const route = resolvedRoute.route;
    const composed = await this.composePreset(this.config.preset);
    const created = await this.agents.create({
      sessionId: childId,
      seed,
      meta: {
        cwd: this.config.cwd || process.cwd(),
        parentSession: parentId,
        seedLength: seed.length,
        ...(composed.agentPreset ? { agentPreset: composed.agentPreset } : {}),
      },
      ...(route ? { agentOptions: agentOptionsFor(route) } : {}),
      ...(composed.setup ? { setup: composed.setup } : {}),
    });

    this.applyConfiguredPermission(created.agent);
    await this.attachConfiguredWorkspace(created.agent);
    if (route && resolvedRoute.pendingSelection) {
      await this.applyPendingSelection(childId, route);
    }

    // Keep the known-good parent visible until the replay produces an answer.
    await this.rememberVisibleSessions(key, [parentId], false);
    this.modelResolver.setSessionId(key, childId);

    const oldHandle = record.handle;
    record.sessionId = childId;
    record.agent = created.agent;
    record.handle = created;
    record.agentPreset = composed.agentPreset;
    record.lastActivity = Date.now();
    void oldHandle.dispose().catch(() => {});

    created.agent.followup(structuredClone(originalMessage));
    void created.agent.whenIdle().then(async () => {
      const generated = (created.agent.session.events ?? [])
        .slice(seed.length)
        .some((event) => event.type === 'assistant/message');
      if (generated) {
        await this.rememberVisibleSessions(key, [childId], true);
      } else {
        this.logger.warn(`clean retry ended without assistant message: key=${key} sessionId=${childId}`);
      }
    }).catch((err) => {
      this.logger.warn(`clean retry completion check failed: key=${key} sessionId=${childId} err=${err instanceof Error ? err.message : String(err)}`);
    });

    this.logger.info(`clean retry forked: key=${key} parent=${parentId} sessionId=${childId} seedLength=${seed.length}`);
    return { ok: true, sessionId: childId };
  }

  clearModelOverride(scope: ChatScope, peerId: string): void {
    const key = this.sessionKey(scope, peerId);
    this.modelResolver.clearOverride(key);
    this.modelResolver.clearSessionId(key);
  }

  async listAvailableModels(): Promise<ModelEntry[]> {
    return this.modelResolver.listModels();
  }

  listProviders(): string[] {
    return this.modelResolver.listProviders();
  }

  // ── 会话状态 / 统计 ──

  getSessionRecord(scope: ChatScope, peerId: string): SessionRecord | undefined {
    return this.sessions.get(this.sessionKey(scope, peerId));
  }

  getStatus(scope: ChatScope, peerId: string): SessionStatus {
    const record = this.getSessionRecord(scope, peerId);
    const route = this.getEffectiveModel(scope, peerId);

    return {
      active: !!record,
      sessionId: record?.sessionId,
      provider: route?.provider,
      model: route?.model,
      preset: record?.agentPreset,
      lastActivity: record?.lastActivity,
      lastMessageAt: lastConversationMessageAt(record?.agent.session.events),
      messageCount: this.countMessages(record),
    };
  }

  /** List recent selectable sessions, capped for the compact QQ picker. */
  async listSessions(scope: ChatScope, peerId: string): Promise<SessionListOutcome> {
    const collected = await this.collectSelectableSessions(scope, peerId);
    if (!collected.ok) return collected;
    const limit = Math.max(1, Math.floor(Number(this.config.visibleSessionLimit) || 16));
    return { ok: true, sessions: collected.sessions.slice(0, limit) };
  }

  /** Collect every eligible session before applying the picker display limit. */
  private async collectSelectableSessions(scope: ChatScope, peerId: string): Promise<SessionListOutcome> {
    const key = this.sessionKey(scope, peerId);
    const currentId = this.currentSessionId(key);
    const roots = new Set([
      ...this.modelResolver.getSessionHistory(key),
      currentId,
    ]);

    let persistence: SessionPersistenceLike | undefined;
    try {
      persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined;
    } catch {
      // Reported below. Creation/fork timestamps are a required part of this UI.
    }
    if (!persistence) {
      return { ok: false, reason: 'unavailable', sessions: [], message: '会话存储服务不可用' };
    }

    try {
      const headers = await persistence.list();
      const headerById = new Map(headers.map((header) => [String(header.id), header]));
      const ordinarySessionIds = new Set(
        headers
          .filter((header) => (header.delegationDepth ?? 0) === 0)
          .map((header) => String(header.id)),
      );
      let candidates = new Set(roots);
      let workspaceResolved = false;

      if (this.config.workspacePath) {
        try {
          const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined;
          const workspace = await registry?.resolveByPath(this.config.workspacePath);
          if (workspace) {
            workspaceResolved = true;
            const archived = new Set((registry?.archivedSessionIds ?? []).map(String));
            candidates = new Set(workspace.sessionIds
              .map(String)
              .filter((id) => !archived.has(id) && ordinarySessionIds.has(id)));
          }
        } catch (error) {
          this.logger.warn(`session list workspace lookup failed: key=${key} err=${error instanceof Error ? error.message : String(error)}`);
        }
      }
      candidates = new Set([...candidates].filter((id) => ordinarySessionIds.has(id)));

      // The safe default keeps peer lineages isolated. Personal deployments
      // can deliberately expose all ordinary, unarchived sessions in the
      // configured Workspace so Web and QQ share one conversation picker.
      const effectiveVisibility = this.config.sessionVisibility === 'workspace' && workspaceResolved
        ? 'workspace'
        : 'lineage';
      const allowed = selectSessionIdsForVisibility(
        headers,
        roots,
        candidates,
        effectiveVisibility,
      );
      const ordered = [...allowed]
        .map((sessionId) => ({ sessionId, header: headerById.get(sessionId) }));

      const inspected = await Promise.all(ordered.map(async ({ sessionId, header }): Promise<SelectableSession | undefined> => {
        let events = this.agents.get(sessionId)?.session.events;
        if (!events) {
          try {
            events = (await persistence!.inspect(SessionId(sessionId))).events;
          } catch (error) {
            this.logger.debug(`session title unavailable: sessionId=${sessionId} err=${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (
          effectiveVisibility === 'workspace'
          && sessionId !== currentId
          && events !== undefined
          && !sessionHasVisibleContent(events)
        ) {
          return undefined;
        }
        const lastMessageAt = lastConversationMessageAt(events);
        return {
          sessionId,
          ...(header?.createdAt !== undefined ? { createdAt: header.createdAt } : {}),
          ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
          ...(header?.parentSession ? { parentSession: String(header.parentSession) } : {}),
          ...(latestSessionTitle(events) ? { title: latestSessionTitle(events) } : {}),
          current: sessionId === currentId,
        };
      }));
      const sessions = sortSessionsByRecentActivity(
        inspected.filter((session): session is SelectableSession => session !== undefined),
      );

      return { ok: true, sessions };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`session list failed: key=${key} err=${message}`);
      return { ok: false, reason: 'failed', sessions: [], message };
    }
  }

  /** Switch to a picker entry, or to an exact eligible full session id. */
  async switchSession(
    scope: ChatScope,
    peerId: string,
    selector: string,
    senderId: string,
    replyTarget: ReplyTarget,
  ): Promise<SwitchSessionOutcome> {
    const key = this.sessionKey(scope, peerId);
    const collected = await this.collectSelectableSessions(scope, peerId);
    if (!collected.ok) return { ok: false, reason: 'failed', message: collected.message };
    const limit = Math.max(1, Math.floor(Number(this.config.visibleSessionLimit) || 16));
    const listed = collected.sessions.slice(0, limit);

    const resolved = resolveSwitchSessionSelector(listed, collected.sessions, selector);
    if (resolved.kind === 'not-found') return { ok: false, reason: 'not-found' };
    if (resolved.kind === 'ambiguous') {
      return { ok: false, reason: 'ambiguous', matches: resolved.matches };
    }
    const target = resolved.session;
    const previous = this.sessions.get(key);
    if (previous?.agent.status === 'running') return { ok: false, reason: 'busy' };
    if (previous?.sessionId === target.sessionId) {
      previous.replyTarget = replyTarget;
      previous.lastActivity = Date.now();
      return { ok: true, session: { ...target, current: true } };
    }

    const targetId = SessionId(target.sessionId);
    const composed = await this.composePreset(this.config.preset);
    let createdHandle: DshAgentHandle | undefined;
    try {
      const live = this.agents.get(targetId);
      const persistedRoute = live ? undefined : await this.inspectSessionRoute(targetId);
      const resumeRoute = persistedRoute ?? this.modelResolver.getResumeRoute(key);
      const agent = live ?? (createdHandle = await this.agents.resume({
        resumeSessionId: targetId,
        ...(resumeRoute ? { agentOptions: agentOptionsFor(resumeRoute) } : {}),
        ...(composed.setup ? { setup: composed.setup } : {}),
      })).agent;

      this.applyConfiguredPermission(agent);
      await this.attachConfiguredWorkspace(agent);

      const record: SessionRecord = {
        sessionKey: key,
        sessionId: targetId,
        agent,
        handle: createdHandle ?? { agent, dispose: async () => {} },
        replyTarget,
        scope,
        peerId,
        senderId,
        lastActivity: Date.now(),
        agentPreset: agent.session.header?.agentPreset ?? composed.agentPreset,
      };

      this.modelResolver.setSessionId(key, targetId);
      this.sessions.set(key, record);
      await this.rememberVisibleSessions(key, [targetId]);
      if (previous && previous.agent !== agent) {
        previous.agent.cancel({ kind: 'user' });
        await previous.handle.dispose().catch(() => {});
      }
      this.logger.info(`session switched: key=${key} sessionId=${targetId}`);
      return { ok: true, session: { ...target, current: true } };
    } catch (error) {
      await createdHandle?.dispose().catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`session switch failed: key=${key} target=${targetId} err=${message}`);
      return { ok: false, reason: 'failed', message };
    }
  }

  getTokenUsage(scope: ChatScope, peerId: string): TokenUsageStats {
    const record = this.getSessionRecord(scope, peerId);
    const stats: TokenUsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    const events = record?.agent.session.events;
    if (!events) return stats;

    for (const event of events) {
      if (event.type !== 'assistant/message' || !event.usage) continue;
      stats.input += event.usage.input ?? 0;
      stats.output += event.usage.output ?? 0;
      stats.cacheRead += event.usage.cacheRead ?? 0;
      stats.cacheWrite += event.usage.cacheWrite ?? 0;
    }

    return stats;
  }

  exportMarkdown(scope: ChatScope, peerId: string): string {
    const record = this.getSessionRecord(scope, peerId);
    if (!record) return '';

    const events = record.agent.session.events;
    if (!events || events.length === 0) return '';

    const lines: string[] = [`# QQ 会话导出\n`, `> session: ${record.sessionId}\n`];

    for (const event of events) {
      if (event.type === 'user/message') {
        const text = extractMessageText(event.message);
        if (text) lines.push(`## 用户\n\n${text}\n`);
      } else if (event.type === 'assistant/message') {
        const text = extractMessageText(event.message);
        if (text) lines.push(`## 助手\n\n${text}\n`);
      }
    }

    return lines.join('\n');
  }

  private countMessages(record: SessionRecord | undefined): number {
    const events = record?.agent.session.events;
    if (!events) return 0;

    let count = 0;
    for (const event of events) {
      if (event.type === 'user/message' || event.type === 'assistant/message') {
        count += 1;
      }
    }
    return count;
  }

  // ── Session 生命周期管理 ──

  private sessionKey(scope: ChatScope, peerId: string): string {
    return `qqbot:${this.config.appId}:${scope}:${peerId}`;
  }

  private deriveSessionId(sessionKey: string): string {
    const hash = createHash('sha256').update(sessionKey).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  }

  private currentSessionId(sessionKey: string): string {
    return this.modelResolver.getSessionId(sessionKey) ?? this.deriveSessionId(sessionKey);
  }

  /** Stable timestamp/envelope identity for the peer's currently selected branch. */
  getConversationSessionId(scope: ChatScope, peerId: string): string {
    return this.currentSessionId(this.sessionKey(scope, peerId));
  }

  private async composePreset(presetId?: string): Promise<PresetComposition> {
    let presets: AgentPresetsLike | undefined;
    try {
      presets = this.ctx.get('agentPresets') as AgentPresetsLike | undefined;
    } catch {
      // agentPresets 服务未注入，降级跳过
    }

    if (!presets) return {};

    try {
      const resolved = await presets.resolve(presetId);
      const resolvedId = resolved.id;
      return {
        agentPreset: resolvedId,
        setup: async (agentCtx: Context) => {
          await presets.mount(agentCtx, resolvedId);
        },
      };
    } catch (err) {
      this.logger.warn(
        `im-qqbot: preset ${presetId ?? '(default)'} unavailable: ${err instanceof Error ? err.message : String(err)} — using host composition`,
      );
      return {};
    }
  }

  /** 获取或恢复或创建会话（get → resume → create） */
  async getOrCreate(
    scope: ChatScope,
    peerId: string,
    senderId: string,
    replyTarget: ReplyTarget,
  ): Promise<SessionRecord> {
    const key = this.sessionKey(scope, peerId);
    const existing = this.sessions.get(key);

    if (existing) {
      this.applyConfiguredPermission(existing.agent);
      await this.attachConfiguredWorkspace(existing.agent);
      await this.rememberVisibleSessions(key, [existing.sessionId]);
      existing.replyTarget = replyTarget;
      existing.lastActivity = Date.now();
      return existing;
    }

    const route = this.modelResolver.getEffectiveRoute(key);
    const sessionId = SessionId(this.currentSessionId(key));
    this.logger.info(`getOrCreate: key=${key} route=${route ? `${route.provider}/${route.model}` : 'host-default'} sessionId=${sessionId}`);

    let agent: DshAgent;
    let handle: DshAgentHandle | undefined;
    let agentPreset: string | undefined;

    const live = this.agents.get(sessionId);
    if (live) {
      agent = live;
      this.logger.info(`reusing live agent: key=${key}`);
    } else {
      // preset 只解析一次：resume/create 共用同一组合，避免重复 resolve/mount 目录
      const composed = await this.composePreset(this.config.preset);
      agentPreset = composed.agentPreset;
      try {
        const persistedRoute = await this.inspectSessionRoute(sessionId);
        const resumeRoute = persistedRoute ?? this.modelResolver.getResumeRoute(key);
        const resumed = await this.agents.resume({
          resumeSessionId: sessionId,
          ...(resumeRoute ? { agentOptions: agentOptionsFor(resumeRoute) } : {}),
          ...(composed.setup ? { setup: composed.setup } : {}),
        });
        agent = resumed.agent;
        handle = resumed;
        this.logger.info(`resumed session: key=${key} preset=${agentPreset ?? 'none'} route=${resumeRoute ? `${resumeRoute.provider}/${resumeRoute.model}` : 'session-own'}`);
      } catch {
        const created = await this.agents.create({
          sessionId,
          meta: {
            cwd: this.config.cwd || process.cwd(),
            ...(agentPreset ? { agentPreset } : {}),
          },
          ...(route ? { agentOptions: agentOptionsFor(route) } : {}),
          ...(composed.setup ? { setup: composed.setup } : {}),
        });
        agent = created.agent;
        handle = created;
        this.logger.info(`created new session: key=${key} preset=${agentPreset ?? 'none'}`);
      }
    }

    this.applyConfiguredPermission(agent);
    await this.attachConfiguredWorkspace(agent);

    const record: SessionRecord = {
      sessionKey: key,
      sessionId,
      agent,
      handle: handle ?? { agent, dispose: async () => {} },
      replyTarget,
      scope,
      peerId,
      senderId,
      lastActivity: Date.now(),
      agentPreset,
    };

    this.sessions.set(key, record);
    await this.rememberVisibleSessions(key, [sessionId]);
    return record;
  }

  findBySessionId(sessionId: string): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.sessionId === sessionId) return record;
    }
    return undefined;
  }

  findByAgent(agent: DshAgent): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.agent === agent) return record;
    }
    return undefined;
  }

  async remove(scope: ChatScope, peerId: string): Promise<void> {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);

    // Persist a fresh id before the first await. A message arriving immediately
    // after reset can no longer resume either the active fork or deterministic base.
    const nextSessionId = SessionId(randomUUID());
    this.modelResolver.setSessionId(key, nextSessionId);

    if (!record) return;
    this.sessions.delete(key);
    await this.rememberVisibleSessions(key, [record.sessionId], false);
    record.agent.cancel({ kind: 'user' });
    await record.handle.dispose().catch(() => {});
    this.logger.info(`session reset: key=${key} nextSessionId=${nextSessionId}`);
  }

  /**
   * 原地压缩当前会话历史（保留 sessionId，用摘要替换旧历史）。
   *
   * 需通过 agentPresets.serviceFor(agent, 'compaction') 解析；未挂载时优雅降级。
   * 这是「压缩上下文」的语义，区别于 remove() 的「换新会话」。
   */
  async compact(scope: ChatScope, peerId: string): Promise<CompactOutcome> {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    if (!record) return { ok: false, reason: 'no-session' };
    if (record.agent.status !== 'idle') return { ok: false, reason: 'busy' };

    let compaction: CompactionServiceLike | undefined;
    try {
      const presets = this.ctx.get('agentPresets') as AgentPresetsLike | undefined;
      compaction = (presets?.serviceFor(record.agent, 'compaction') ?? this.ctx.get('compaction')) as CompactionServiceLike | undefined;
    } catch {
      compaction = undefined;
    }
    if (!compaction) return { ok: false, reason: 'unavailable' };

    const route = (await this.resolveSessionRoute(
      record,
      this.modelResolver.getEffectiveRoute(key),
    )).route;
    const agentCtx = {
      session: record.agent.session,
      options: { provider: route?.provider, model: route?.model },
      runMaintenance: record.agent.runMaintenance.bind(record.agent),
    };

    try {
      const result = await compaction.compactNow(agentCtx, new AbortController().signal);
      if (result === null) return { ok: true, shadowed: 0, tokens: 0 };
      return { ok: true, shadowed: result.shadowedSeqs.length, tokens: result.shadowedTokenCount };
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      // summary = 摘要没有更小 = 历史不足以压缩，属正常结果而非失败
      if (code === 'summary') {
        return { ok: true, shadowed: 0, tokens: 0 };
      }
      // 其他 ManualCompactionError 预期失败，给友好文案（debug 记录，不 warn 刷屏）
      if (code !== undefined && code in COMPACTION_ERROR_HINTS) {
        this.logger.debug(`compact declined: key=${key} code=${code}`);
        return { ok: false, reason: 'failed', message: COMPACTION_ERROR_HINTS[code] };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`compact failed: key=${key} err=${message}`);
      return { ok: false, reason: 'failed', message };
    }
  }

  async disposeAll(): Promise<void> {
    this.evictor.dispose();
    const records = [...this.sessions.values()];
    this.sessions.clear();
    for (const record of records) {
      record.agent.cancel({ kind: 'user' });
    }
    await Promise.allSettled(records.map((r) => r.handle.dispose()));
    this.logger.info(`all sessions disposed (count=${records.length})`);
  }

  get size(): number {
    return this.sessions.size;
  }
}

function normalizeModelRoute(value: unknown): ModelRoute | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const route = value as { provider?: unknown; model?: unknown; reasoningEffort?: unknown };
  if (typeof route.provider !== 'string' || !route.provider) return undefined;
  if (typeof route.model !== 'string' || !route.model) return undefined;
  return {
    provider: route.provider,
    model: route.model,
    ...(typeof route.reasoningEffort === 'string' && route.reasoningEffort
      ? { reasoningEffort: route.reasoningEffort }
      : {}),
  };
}

function sameModelRoute(left: ModelRoute | undefined, right: ModelRoute | undefined): boolean {
  return left !== undefined
    && right !== undefined
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort;
}

function agentOptionsFor(route: ModelRoute): { provider: string; model: string } {
  return { provider: route.provider, model: route.model };
}

function sessionRequestRoute(agent: DshAgent): ModelRoute | undefined {
  try {
    const direct = normalizeModelRoute(agent.session.requestHeader?.()?.config);
    if (direct) return direct;
  } catch {
    // Fall through to the durable events for lightweight/mocked session views.
  }
  return latestSessionModelRoute(agent.session.events ?? []);
}

/** Last durable request route recorded by DSH for this session. */
export function latestSessionModelRoute(
  events: readonly SessionEventLike[],
): ModelRoute | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'request/header') continue;
    const dataHeader = event.data?.header as { config?: unknown } | undefined;
    const topHeader = event.header as { config?: unknown } | undefined;
    const route = normalizeModelRoute(dataHeader?.config ?? topHeader?.config);
    if (route) return route;
  }
  return undefined;
}

/** Active Web choice wins; otherwise retain the session route before QQ defaults. */
export function selectSessionModelRoute(
  current: ModelRoute | undefined,
  logged: ModelRoute | undefined,
  fallback: ModelRoute | undefined,
): ModelRoute | undefined {
  return current ?? logged ?? fallback;
}

interface RetryableTurn {
  startIndex: number;
  endIndex: number;
  userEvent: SessionEventLike;
  toolCount: number;
}

/** Keep only workspace sessions descending from this peer's known roots. */
export function collectLineageSessionIds(
  headers: readonly SessionHeaderLike[],
  roots: ReadonlySet<string>,
  candidates: ReadonlySet<string>,
): Set<string> {
  const allowed = new Set([...roots].filter((id) => candidates.has(id)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const header of headers) {
      const id = String(header.id);
      const parent = header.parentSession ? String(header.parentSession) : undefined;
      if (!candidates.has(id) || allowed.has(id) || !parent || !allowed.has(parent)) continue;
      allowed.add(id);
      changed = true;
    }
  }
  return allowed;
}

/** Apply the configured picker scope after Workspace/archive filtering. */
export function selectSessionIdsForVisibility(
  headers: readonly SessionHeaderLike[],
  roots: ReadonlySet<string>,
  candidates: ReadonlySet<string>,
  visibility: ImQQBotConfig['sessionVisibility'],
): Set<string> {
  return visibility === 'workspace'
    ? new Set(candidates)
    : collectLineageSessionIds(headers, roots, candidates);
}

/** Hide empty Web placeholders while retaining actual conversations. */
export function sessionHasVisibleContent(events: readonly SessionEventLike[]): boolean {
  return events.some((event) => (
    event.type === 'user/message'
    || event.type === 'assistant/message'
    || event.type === 'session/title'
  ));
}

type SelectorResolution =
  | { kind: 'found'; session: SelectableSession }
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; matches: SelectableSession[] };

/** Resolve a one-based list index, full id, or unique displayed-id prefix. */
export function resolveSessionSelector(
  sessions: readonly SelectableSession[],
  rawSelector: string,
): SelectorResolution {
  const selector = rawSelector.trim();
  if (!selector) return { kind: 'not-found' };
  if (/^[1-9]\d*$/.test(selector)) {
    const selected = sessions[Number(selector) - 1];
    return selected ? { kind: 'found', session: selected } : { kind: 'not-found' };
  }

  const normalized = selector.toLowerCase();
  const matches = sessions.filter(({ sessionId }) => {
    const id = sessionId.toLowerCase();
    const displayId = id.startsWith('session-') ? id.slice('session-'.length) : id;
    return id === normalized || id.startsWith(normalized) || displayId.startsWith(normalized);
  });
  if (matches.length === 1) return { kind: 'found', session: matches[0]! };
  if (matches.length > 1) return { kind: 'ambiguous', matches };
  return { kind: 'not-found' };
}

/**
 * Keep indexes and short ids scoped to the displayed picker, while allowing an
 * exact `session-*` id to address any session that passed the same eligibility
 * checks before the display limit was applied.
 */
export function resolveSwitchSessionSelector(
  visibleSessions: readonly SelectableSession[],
  eligibleSessions: readonly SelectableSession[],
  rawSelector: string,
): SelectorResolution {
  const visible = resolveSessionSelector(visibleSessions, rawSelector);
  if (visible.kind !== 'not-found') return visible;

  const selector = rawSelector.trim().toLowerCase();
  if (!selector.startsWith('session-')) return visible;
  const exact = eligibleSessions.find(({ sessionId }) => sessionId.toLowerCase() === selector);
  return exact ? { kind: 'found', session: exact } : visible;
}

/** New activity revives an old Web session; creation time is only a fallback. */
export function sortSessionsByRecentActivity(
  sessions: readonly SelectableSession[],
): SelectableSession[] {
  return [...sessions].sort((left, right) => {
    const activityDiff = (right.lastMessageAt ?? right.createdAt ?? 0)
      - (left.lastMessageAt ?? left.createdAt ?? 0);
    if (activityDiff !== 0) return activityDiff;
    const creationDiff = (right.createdAt ?? 0) - (left.createdAt ?? 0);
    if (creationDiff !== 0) return creationDiff;
    return left.sessionId.localeCompare(right.sessionId);
  });
}

/** Last durable title wins; absent titles stay absent rather than inventing one. */
function latestSessionTitle(events: readonly SessionEventLike[] | undefined): string | undefined {
  if (!events) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'session/title') continue;
    const title = event.data?.title;
    if (typeof title === 'string' && title.trim()) return title.trim();
  }
  return undefined;
}

/** Latest real user/assistant message, excluding plugin-generated context rows. */
export function lastConversationMessageAt(
  events: readonly SessionEventLike[] | undefined,
): number | undefined {
  if (!events) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || !Number.isFinite(event.time)) continue;
    if (event.type === 'assistant/message') return event.time;
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') return event.time;
  }
  return undefined;
}

/** Locate the latest completed user turn and its clean fork boundary. */
export function findLastRetryableTurn(events: readonly SessionEventLike[]): RetryableTurn | undefined {
  let endIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/end') {
      endIndex = index;
      break;
    }
  }
  if (endIndex < 0) return undefined;

  const turnId = events[endIndex]?.data?.turn;
  let startIndex = -1;
  for (let index = endIndex; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'turn/start' && (turnId === undefined || event.data?.turn === turnId)) {
      startIndex = index;
      break;
    }
  }
  if (startIndex < 0) return undefined;

  let userEvent: SessionEventLike | undefined;
  let toolCount = 0;
  let sawToolEvent = false;
  for (let index = startIndex; index <= endIndex; index += 1) {
    const event = events[index];
    if (event?.type === 'tool/call') toolCount += 1;
    if (event?.type === 'tool/call' || event?.type === 'tool/result') sawToolEvent = true;
    if (event?.type !== 'user/message') continue;
    const message = event.data ?? event.message;
    const source = (message as { source?: { kind?: string } } | undefined)?.source;
    if (source?.kind === 'user') userEvent = event;
  }
  if (!userEvent) return undefined;

  return {
    startIndex,
    endIndex,
    userEvent,
    toolCount: Math.max(toolCount, sawToolEvent ? 1 : 0),
  };
}

/** 从消息对象中提取纯文本（用于导出/统计） */
function extractMessageText(
  message: SessionEventLike['message'],
): string {
  const blocks = message?.content;
  if (!blocks || !Array.isArray(blocks)) return '';

  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}
