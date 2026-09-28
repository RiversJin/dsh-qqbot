/**
 * 会话管理层类型定义
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ChatScope, ReplyTarget } from '../types.js';
import type { Agent, AgentHandle, AgentRegistry, AgentSetup as NativeAgentSetup } from '@deepseek-ai/dsh-agent';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import type { SessionPersistence, SessionInspection } from '@deepseek-ai/dsh-session-persistence';
import type PermissionPresetService from '@deepseek-ai/dsh-permission-presets';

/** AgentSetup hook 类型 */
export type AgentSetup = NativeAgentSetup;

/** dsh SessionEvent 简化类型（用于统计 token 用量 / 导出） */
export interface SessionEventLike {
  type: string;
  seq?: number;
  time?: number;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  message?: {
    content?: Array<{ type: string; text?: string }>;
    [key: string]: unknown;
  };
  data?: unknown;
  [key: string]: unknown;
}

/** 使用宿主公开类型，让接口变更在编译期暴露。 */
export type DshAgent = Agent;

/** compactNow 返回结果的精简视图（只取展示所需字段） */
export interface CompactionResultLike {
  shadowedSeqs: readonly number[];
  shadowedTokenCount: number;
}

/** ctx.compaction 服务的最小接口（compactNow 依赖，可选注入） */
export interface CompactionServiceLike {
  compactNow(
    agent: unknown,
    signal: AbortSignal,
    sourceCommandId?: string,
  ): Promise<CompactionResultLike | null>;
}

/** compact 操作结果 */
export interface CompactOutcome {
  ok: boolean;
  reason?: 'no-session' | 'busy' | 'unavailable' | 'failed';
  shadowed?: number;
  tokens?: number;
  message?: string;
}

export type DshAgentHandle = AgentHandle;
export type SessionsService = SessionStore;

/** Lightweight persisted session metadata used by QQ session selection. */
export interface SessionHeaderLike {
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  agentPreset?: string;
  delegationDepth?: number;
}

export type SessionInspectionLike = SessionInspection;
export type SessionPersistenceLike = SessionPersistence;

export interface SelectableSession {
  sessionId: string;
  createdAt?: number;
  /** Latest real user/assistant message, used for recent-activity ordering. */
  lastMessageAt?: number;
  title?: string;
  parentSession?: string;
  current: boolean;
}

export interface SessionListOutcome {
  ok: boolean;
  reason?: 'unavailable' | 'failed';
  sessions: SelectableSession[];
  message?: string;
}

export interface SwitchSessionOutcome {
  ok: boolean;
  reason?: 'not-found' | 'ambiguous' | 'busy' | 'failed';
  session?: SelectableSession;
  matches?: SelectableSession[];
  message?: string;
}

export type DshAgentRegistry = AgentRegistry;
export type PermissionPresetsLike = PermissionPresetService;

export interface WorkspaceRegistryLike {
  readonly archivedSessionIds?: readonly string[];
  resolveByPath(path: string): Promise<{
    readonly sessionIds: readonly string[];
    attachSession(sessionId: string): Promise<void>;
  } | undefined>;
  archiveSession(sessionId: string): Promise<void>;
}

export interface ImageAttachmentLimitsLike {
  maxImageBytes: number;
  maxImagesPerMessage: number;
  maxMessageImageBytes: number;
  mediaTypes: readonly string[];
}

export interface AttachmentsLike {
  readonly imageLimits: ImageAttachmentLimitsLike;
  saveImages(inputs: readonly NativeImageInput[]): Promise<readonly unknown[]>;
}

export interface NativeImageInput {
  data: Uint8Array;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  name?: string;
}

export interface LlmModelInfoLike {
  inputModalities?: readonly string[];
}

export interface LlmResolverLike {
  resolveModelInfo(provider: string, model: string): Promise<LlmModelInfoLike>;
}

/** agent-presets 服务接口（可选，部署中可能没有） */
export interface AgentPresetsLike {
  readonly defaultId: string;
  resolve(id?: string): Promise<{ id: string }>;
  mount(agentCtx: Context, id?: string): Promise<unknown>;
  /** 从 agent 的 preset scope 解析隔离服务（如 compaction），未挂载返回 undefined */
  serviceFor(agent: { ctx: Context }, name: string): unknown | undefined;
}

/** preset 组合结果 */
export interface PresetComposition {
  agentPreset?: string;
  setup?: AgentSetup;
}

/** 单个会话记录 */
export interface SessionRecord {
  sessionKey: string;
  sessionId: string;
  agent: DshAgent;
  handle: DshAgentHandle;
  replyTarget: ReplyTarget;
  scope: ChatScope;
  peerId: string;
  senderId: string;
  lastActivity: number;
  agentPreset?: string;
}

/** 会话状态信息（/status 用） */
export interface SessionStatus {
  active: boolean;
  sessionId?: string;
  provider?: string;
  model?: string;
  preset?: string;
  lastActivity?: number;
  lastMessageAt?: number;
  messageCount?: number;
}

/** token 用量统计（/cost 用） */
export interface TokenUsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
