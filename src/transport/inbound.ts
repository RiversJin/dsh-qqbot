/**
 * 入站处理器 — 经 SDK 中间件链处理后的消息 → dsh Agent followup
 *
 * 对齐 openclaw-qqbot body-assembler 的内容组装逻辑：
 * - Layer 1: userContent（文本 + 语音转录）
 * - Layer 2: quotePart（引用消息块）
 * - Layer 3: userMessage（带发送者标签）
 * - Layer 4: dynamicCtx（媒体元数据）
 * - Layer 5: agentBody（history + base 拼合）
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionManager } from '../session/index.js';
import type { ImQQBotConfig } from '../config.js';
import type { ChatScope, Logger, QuotedAttachment, RawAttachment, ReplyTarget } from '../types.js';
import {
  classifyContentType,
  isImageAttachment,
  isVoiceContentType,
  type DownloadedFile,
  type DownloadedImage,
  type MediaKind,
} from './attachment.js';
import { clearGroupHistory } from '../features/history-store.js';

interface TimestampState {
  epochMs: number;
  dayKey: string;
}

interface TimestampPolicy {
  key: string;
  timeZone: string;
  intervalMs: number;
}

const lastTimestampByConversation = new Map<string, TimestampState>();

// ── 类型定义 ──

interface ProcessedMessage {
  rawEventType: string;
  kind: 'c2c' | 'group';
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string | number;
  groupOpenid?: string;
  msgType?: number;
  attachments?: RawAttachment[];
  [key: string]: unknown;
}

interface ResolvedQuote {
  text?: string;
  entry?: { senderId?: string; content?: string; timestamp?: string | number };
  attachments?: QuotedAttachment[];
}

interface HistoryEntry {
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: number;
  messageId: string;
}

interface MentionState {
  wasMentioned?: boolean;
}

interface MiddlewareState {
  quote?: ResolvedQuote;
  history?: HistoryEntry[];
  envelope?: string;
  mention?: MentionState;
  processedAttachments?: ProcessedAttachment[];
  downloadedFiles?: DownloadedFile[];
  downloadedImages?: DownloadedImage[];
  downloadedQuoteFiles?: DownloadedFile[];
  [key: string]: unknown;
}

interface ProcessedAttachment {
  type: 'voice' | 'image' | 'video' | 'file' | 'unknown';
  filename?: string;
  url?: string;
  localPath?: string;
  voiceText?: string;
  voiceSource?: 'stt' | 'asr' | 'fallback';
  duration?: number;
  width?: number;
  height?: number;
  size?: number;
}

// ── 主处理函数 ──

/**
 * 处理 QQ 入站消息（已经过 SDK 中间件链）
 */
export async function handleInbound(
  rawMsg: unknown,
  manager: SessionManager,
  config: ImQQBotConfig,
  logger: Logger,
  state?: Record<string, unknown>,
): Promise<void> {
  const msg = rawMsg as ProcessedMessage;
  const mwState = (state ?? {}) as MiddlewareState;

  const scope: ChatScope = msg.kind === 'group' ? 'group' : 'c2c';
  const peerId = scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId;

  const replyTarget: ReplyTarget = {
    scope,
    targetId: peerId,
    msgId: msg.messageId,
  };

  const timestampPolicy: TimestampPolicy = {
    key: `${config.appId}:${manager.getConversationSessionId(scope, peerId)}`,
    timeZone: config.timestampTimeZone || 'Asia/Singapore',
    intervalMs: Math.max(1, Number(config.timestampIntervalMinutes) || 30) * 60 * 1000,
  };

  const wasMentioned = mwState.mention?.wasMentioned ?? false;
  if (
    !(msg.content ?? '').trim()
    && (!msg.attachments || msg.attachments.length === 0)
    && !(scope === 'group' && wasMentioned)
  ) return;

  // Enforce permission and Workspace policy before persisting attachments.
  let record;
  try {
    record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);
  } catch (err) {
    logger.error(`ERROR creating session: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // ── 组装 agentBody（下载结果经 mwState.downloadedFiles 提供） ──
  const downloadedImages = mwState.downloadedImages ?? [];
  let imageRefs: readonly unknown[] = [];
  let nativeImageIndexes = new Set<number>();

  if (downloadedImages.length > 0) {
    try {
      imageRefs = await manager.persistImages(
        scope,
        peerId,
        downloadedImages.map(image => image.input),
      );
      nativeImageIndexes = new Set(downloadedImages.map(image => image.sourceIndex));
      logger.info(`im-qqbot: persisted ${imageRefs.length} native image(s): scope=${scope}`);
    } catch (err) {
      logger.warn(`im-qqbot: native image admission failed; falling back to text metadata: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const agentBody = assembleAgentBody(
    msg,
    mwState,
    scope,
    logger,
    timestampPolicy,
    nativeImageIndexes,
  );

  if (!agentBody && imageRefs.length === 0) return;

  logger.info(`Processing: scope=${scope} peerId=${peerId} body="${(agentBody ?? '').slice(0, 200)}" nativeImages=${imageRefs.length}`);

  // ── 构建 UserMessage → followup ──
  const content: ContentBlock[] = [
    ...(agentBody ? [{ type: 'text' as const, text: agentBody }] : []),
    ...imageRefs.map(attachment => ({ type: 'image', attachment }) as ContentBlock),
  ];

  const message = createUserMessage({
    content,
    source: { kind: 'user' as const },
  });

  record.agent.followup(message);
  logger.info(`→ followup sent: key=${scope}:${peerId}`);

  // 群消息回复后清空历史缓存（避免下次 @ 时重复组包，对齐 openclaw-qqbot dispatch）
  if (scope === 'group') {
    clearGroupHistory(config.appId, msg.groupOpenid ?? msg.senderId);
  }
}

// ══════════════════════════════════════════════════════════════
// Body Assembly（对齐 openclaw-qqbot 5 层组装）
// ══════════════════════════════════════════════════════════════

/**
 * 组装 agentBody — AI 实际看到的完整上下文
 */
function assembleAgentBody(
  msg: ProcessedMessage,
  state: MiddlewareState,
  scope: ChatScope,
  logger: Logger,
  timestampPolicy: TimestampPolicy,
  nativeImageIndexes: ReadonlySet<number> = new Set(),
): string | null {
  const isGroup = scope === 'group';
  const wasMentioned = state.mention?.wasMentioned ?? false;

  const userContent = buildUserContent(msg, state, logger);

  if (isEmptyMessage(userContent, msg.attachments, isGroup, wasMentioned)) return null;

  const quotePart = buildQuotePart(state.quote, timestampPolicy.timeZone);
  const currentTimestamp = selectCurrentTimestamp(msg.timestamp, timestampPolicy);
  const userMessage = buildUserMessage(
    userContent,
    quotePart,
    msg.senderId,
    msg.senderName,
    isGroup,
    wasMentioned,
    currentTimestamp,
  );

  const dynamicCtx = buildDynamicCtx(msg, state, nativeImageIndexes);

  const base = dynamicCtx ? `${dynamicCtx}${userMessage}` : userMessage;
  const agentBody = buildAgentBody(base, state.history, isGroup, wasMentioned, timestampPolicy);

  return agentBody;
}

/**
 * 判断消息是否为空：无文本/语音/附件，且非群聊 @。
 * 群聊被 @ 视为有效触发信号，即使内容为空也保留给 agent。
 */
function isEmptyMessage(
  userContent: string,
  attachments: RawAttachment[] | undefined,
  isGroup: boolean,
  wasMentioned: boolean,
): boolean {
  if (userContent) return false;
  if (attachments && attachments.length > 0) return false;
  if (isGroup && wasMentioned) return false;
  return true;
}

/**
 * Layer 1: 用户文本内容 + 语音转录 + 附件类型标签（媒体路径由 buildDynamicCtx 提供）
 */
function buildUserContent(msg: ProcessedMessage, state: MiddlewareState, logger: Logger): string {
  const parts: string[] = [];

  const text = (msg.content ?? '').trim();
  if (text) {
    parts.push(text);
  }

  const voiceTexts = extractVoiceTexts(msg.attachments, state.processedAttachments, logger);
  if (voiceTexts.length > 0) {
    for (const vt of voiceTexts) {
      const durationTag = vt.duration ? ` (${vt.duration}s)` : '';
      parts.push(`[Voice message${durationTag}] ${vt.text}`);
    }
  }

  // 附件类型标签（媒体路径由 buildDynamicCtx 提供，这里只提示「带了什么」）
  const attachmentTags = buildAttachmentTags(msg.attachments);
  if (attachmentTags) {
    parts.push(attachmentTags);
  }

  return parts.join('\n');
}

/**
 * Layer 2: 引用消息块
 */
function buildQuotePart(quote: ResolvedQuote | undefined, timeZone: string): string {
  if (!quote?.text && !quote?.entry?.content) return '';

  const quoteText = quote.text || quote.entry?.content || 'Original content unavailable';
  const timestamp = formatMessageTimestamp(quote.entry?.timestamp, timeZone, true);
  const prefix = timestamp ? `${timestamp} ` : '';

  return `[Quoted message begins]\n${prefix}${quoteText}\n[Quoted message ends]\n[Current message]\n`;
}

/**
 * Layer 3: 带发送者标签的用户消息
 */
function buildUserMessage(
  userContent: string,
  quotePart: string,
  senderId: string,
  senderName: string | undefined,
  isGroup: boolean,
  wasMentioned: boolean,
  timestamp: string,
): string {
  const timeTag = timestamp ? `${timestamp} ` : '';
  if (!isGroup) {
    return `${quotePart}${timeTag}${userContent}`;
  }

  const mentionTag = wasMentioned ? ' (@you)' : '';
  const displayName = senderName ?? shortSenderId(senderId);
  const senderTag = `[${displayName} (${senderId})]`;
  return `${quotePart}${timeTag}${senderTag} ${userContent}${mentionTag}`;
}

/**
 * Layer 4: 媒体元数据上下文（图片/视频/文件本地路径 + 语音 ASR + 引用附件）
 */
function buildDynamicCtx(
  msg: ProcessedMessage,
  state: MiddlewareState,
  nativeImageIndexes: ReadonlySet<number>,
): string {
  const lines: string[] = [];

  if (msg.attachments && msg.attachments.length > 0) {
    const downloadedBySourceIndex = new Map((state.downloadedFiles ?? []).map(d => [d.sourceIndex, d]));
    const voices: RawAttachment[] = [];

    // 一次遍历归类 + 生成媒体行
    for (const [sourceIndex, att] of msg.attachments.entries()) {
      const kind = isImageAttachment(att) ? 'image' : classifyContentType(att.content_type);
      if (kind === 'voice') {
        voices.push(att);
        continue;
      }
      const d = downloadedBySourceIndex.get(sourceIndex);
      lines.push(`- ${renderMediaLine(
        kind,
        att.filename,
        d?.localPath,
        att.url,
        att.size,
        nativeImageIndexes.has(sourceIndex),
      )}`);
    }

    // 语音：有 ASR 文本才带文本，否则只带链接（纯文本模型无法消费音频）
    if (voices.length > 0) {
      const asrTexts = voices.map(a => a.asr_refer_text).filter(Boolean);
      if (asrTexts.length > 0) {
        lines.push(`- ASR: ${asrTexts.join(' | ')}`);
      } else {
        const urls = voices.map(a => a.url).filter(Boolean);
        if (urls.length > 0) lines.push(`- Voice: ${urls.join(', ')}`);
      }
    }
  }

  // 引用消息的附件（独立于当前消息媒体，不受上一步为空影响）
  const quoteAttachments = state.quote?.attachments;
  if (quoteAttachments && quoteAttachments.length > 0) {
    const downloadedQuote = new Map((state.downloadedQuoteFiles ?? []).map(d => [d.filename, d]));
    lines.push('[Reference attachments]');
    for (const qa of quoteAttachments) {
      const kind = classifyContentType(qa.contentType);
      const d = downloadedQuote.get(qa.filename ?? '');
      if (kind === 'voice') {
        if (qa.asrText) lines.push(`  - Voice: ${qa.asrText}`);
        continue;
      }
      lines.push(`  - ${renderMediaLine(kind, qa.filename, d?.localPath, qa.url, undefined)}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
}

/**
 * 渲染单个媒体附件（image/video/file）的上下文行内容，不含列表前缀。
 * 当前消息与引用消息共用，保证附件格式统一。语音不在此处理（见 buildDynamicCtx）。
 */
function renderMediaLine(
  kind: Exclude<MediaKind, 'voice'>,
  filename: string | undefined,
  localPath: string | undefined,
  url: string | undefined,
  size: number | undefined,
  native = false,
): string {
  switch (kind) {
    case 'image':
      if (native) {
        return localPath
          ? `Image: attached as native visual input (local copy: ${localPath})`
          : 'Image: attached as native visual input';
      }
      return localPath
        ? `Image: ${localPath}`
        : `Image: ${url ?? filename ?? 'image'}`;
    case 'video':
      return localPath
        ? `Video: ${localPath}`
        : `Video: ${filename ?? 'video'} (download failed)`;
    case 'file':
      return localPath
        ? `File: ${localPath}`
        : `File: ${filename ?? 'file'} (${formatFileSize(size ?? 0)})`;
  }
}

/**
 * Layer 5: 最终 agentBody 拼合
 */
function buildAgentBody(
  base: string,
  history: HistoryEntry[] | undefined,
  isGroup: boolean,
  wasMentioned: boolean,
  timestampPolicy: TimestampPolicy,
): string {
  if (!isGroup || !wasMentioned || !history || history.length === 0) {
    return base;
  }

  let previousTimestamp: TimestampState | undefined;
  const historyLines = history.map(h => {
    const name = h.senderName ?? shortSenderId(h.senderId);
    const epochMs = parseMessageTimestamp(h.timestamp);
    const dayKey = epochMs === undefined ? '' : formatDayKey(epochMs, timestampPolicy.timeZone);
    const crossedDay = previousTimestamp !== undefined && previousTimestamp.dayKey !== dayKey;
    const due = previousTimestamp === undefined
      || crossedDay
      || (epochMs !== undefined && epochMs - previousTimestamp.epochMs >= timestampPolicy.intervalMs);
    const timestamp = due && epochMs !== undefined
      ? formatMessageTimestamp(epochMs, timestampPolicy.timeZone, previousTimestamp === undefined || crossedDay)
      : '';
    if (due && epochMs !== undefined) previousTimestamp = { epochMs, dayKey };
    const prefix = timestamp ? `${timestamp} ` : '';
    return `${prefix}[${name} (${h.senderId})] ${h.content}`;
  });

  return [
    '[Chat history begins]',
    ...historyLines,
    '',
    '[Chat history ends]',
    '[Current message]',
    base,
  ].join('\n');
}

/** Emit timestamps sparsely: first message, interval elapsed, or day change. */
export function selectCurrentTimestamp(value: unknown, policy: TimestampPolicy): string {
  const epochMs = parseMessageTimestamp(value);
  if (epochMs === undefined) return '';
  const dayKey = formatDayKey(epochMs, policy.timeZone);
  const previous = lastTimestampByConversation.get(policy.key);
  const crossedDay = previous !== undefined && previous.dayKey !== dayKey;
  const due = previous === undefined || crossedDay || epochMs - previous.epochMs >= policy.intervalMs;
  if (!due) return '';
  lastTimestampByConversation.set(policy.key, { epochMs, dayKey });
  return formatMessageTimestamp(epochMs, policy.timeZone, previous === undefined || crossedDay);
}

export function parseMessageTimestamp(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  let epochMs: number;
  if (typeof value === 'number') {
    epochMs = value < 1_000_000_000_000 ? value * 1000 : value;
  } else if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) {
    const numeric = Number(value);
    epochMs = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  } else if (typeof value === 'string') {
    epochMs = Date.parse(value);
  } else {
    return undefined;
  }
  return Number.isFinite(epochMs) ? epochMs : undefined;
}

function formatDayKey(epochMs: number, timeZone: string): string {
  return formatDateParts(epochMs, timeZone).dayKey;
}

export function formatMessageTimestamp(value: unknown, timeZone: string, includeDate: boolean): string {
  const epochMs = parseMessageTimestamp(value);
  if (epochMs === undefined) return '';
  try {
    const values = formatDateParts(epochMs, timeZone);
    return includeDate
      ? `[${values.month}-${values.day} ${values.hour}:${values.minute}]`
      : `[${values.hour}:${values.minute}]`;
  } catch {
    return '';
  }
}

function formatDateParts(epochMs: number, timeZone: string): Record<string, string> & { dayKey: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value])) as Record<string, string>;
  return { ...values, dayKey: `${values.year}-${values.month}-${values.day}` };
}

// ══════════════════════════════════════════════════════════════
// 辅助函数
// ══════════════════════════════════════════════════════════════

interface VoiceText {
  text: string;
  duration?: number;
  source: 'stt' | 'asr' | 'fallback';
}

function extractVoiceTexts(
  attachments?: RawAttachment[],
  processed?: ProcessedAttachment[],
  _logger?: Logger,
): VoiceText[] {
  const results: VoiceText[] = [];

  if (processed) {
    for (const pa of processed) {
      if (pa.type === 'voice' && pa.voiceText) {
        results.push({
          text: pa.voiceText,
          duration: pa.duration,
          source: pa.voiceSource ?? 'stt',
        });
      }
    }
  }

  if (results.length === 0 && attachments) {
    for (const att of attachments) {
      if (isVoiceContentType(att.content_type) && att.asr_refer_text) {
        results.push({
          text: att.asr_refer_text.trim(),
          source: 'asr',
        });
      }
    }
  }

  return results;
}

/**
 * 附件类型标签（Layer 1 用户消息主体里的轻量提示）。
 * 只标注「带了什么类型的附件」，去重；媒体本地路径在 buildDynamicCtx 提供。
 */
function buildAttachmentTags(attachments?: RawAttachment[]): string {
  if (!attachments || attachments.length === 0) return '';

  const labels: Record<string, string> = {
    image: '[图片]',
    video: '[视频]',
    file: '[文件]',
  };

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const att of attachments) {
    const kind = isImageAttachment(att) ? 'image' : classifyContentType(att.content_type);
    if (kind === 'voice' || seen.has(kind)) continue;
    seen.add(kind);
    const label = labels[kind];
    if (label) tags.push(label);
  }

  return tags.join(' ');
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 发送者短标识长度（openid 前 N 位，无昵称时兜底） */
const SENDER_SHORT_ID_LEN = 8;

/** 无昵称时用 openid 前 N 位作为匿名标识 */
function shortSenderId(senderId: string): string {
  return senderId.slice(0, SENDER_SHORT_ID_LEN);
}
