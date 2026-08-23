/**
 * 富媒体下载 — 将 QQ 图片/视频/file 附件安全下载到本地
 *
 * 下载后仅通过本地绝对路径提示模型，由模型通过 qqbot_describe_image / ffmpeg / tool-fs 等工具自行分析，
 *
 * 下载目录固定为 ~/.dsh-qqbot/media（对齐 dsh-qqbot 的 prefs 目录约定），
 * 文件名用时间戳+随机数防重名，不依赖 agent cwd，便于 qqbot_describe_image / tool-fs 等工具稳定访问。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as dns from 'node:dns';
import type { Logger, RawAttachment } from '../types.js';
import type { MediaConfig } from '../config.js';
import { MEDIA_ROOT } from '../media/media-cleaner.js';
import type { ImageAttachmentLimitsLike, NativeImageInput } from '../session/types.js';

/** 默认富媒体下载大小上限（MB），可被 media.maxMB 覆盖 */
const DEFAULT_MAX_MB = 200;
/** 下载超时（毫秒） */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** 下载结果 */
export interface DownloadedFile {
  /** 原始附件在消息 attachments 数组中的位置 */
  sourceIndex: number;
  /** 原始文件名（用于与消息附件关联） */
  filename: string;
  /** 附件类型 */
  contentType: 'image' | 'video' | 'file';
  /** 本地绝对路径 */
  localPath: string;
}

export interface DownloadedImage {
  sourceIndex: number;
  input: NativeImageInput;
}

const IMAGE_MEDIA_TYPES = new Set<NativeImageInput['mediaType']>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

/** 附件归类（QQ 网关的 content_type 是 MIME 类型，如 image/png、video/mp4、audio/silk） */
export type MediaKind = 'image' | 'video' | 'voice' | 'file';

/** 是否为图片（兼容裸值 'image' 与 MIME 'image/png'） */
export function isImageContentType(contentType?: string): boolean {
  return contentType === 'image' || contentType?.startsWith('image/') === true;
}

/** QQ has emitted both category values, MIME values, and empty MIME fields. */
export function isImageAttachment(attachment: RawAttachment | undefined): boolean {
  if (!attachment) return false;
  if (isImageContentType(String(attachment.content_type ?? '').trim().toLowerCase())) return true;
  return /\.(?:png|jpe?g|webp|gif)$/iu.test(String(attachment.filename ?? ''));
}

/** 是否为视频（兼容裸值 'video' 与 MIME 'video/mp4'） */
export function isVideoContentType(contentType?: string): boolean {
  return contentType === 'video' || contentType?.startsWith('video/') === true;
}

/** 是否为语音（兼容裸值 'voice' 与 MIME 'audio/silk'） */
export function isVoiceContentType(contentType?: string): boolean {
  return contentType === 'voice' || contentType?.startsWith('audio/') === true;
}

/** 归类附件 content_type 为统一类型 */
export function classifyContentType(contentType?: string): MediaKind {
  if (isImageContentType(contentType)) return 'image';
  if (isVideoContentType(contentType)) return 'video';
  if (isVoiceContentType(contentType)) return 'voice';
  return 'file';
}

/** 处理 `//` 开头的协议相对 URL（补 https:） */
function normalizeUrl(url: string): string {
  return url.startsWith('//') ? `https:${url}` : url;
}

/** 文件名净化：去路径、移除非法字符（保留中文等 Unicode 字符），防止路径穿越 */
function sanitizeFilename(name: string): string {
  const base = basename(name.replace(/\\/g, '/'));
  // 仅替换文件系统非法字符（Windows 保留字符 + 控制字符），保留中文/空格等
  // normalize NFC：统一 Unicode 规范化，避免 macOS(NFD) 与 Linux/Windows(NFC) 存储差异导致路径对不上
  const safe = base
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .trim()
    .normalize('NFC');
  return safe || 'attachment';
}

/** 统一路径分隔符为 `/`（POSIX），Node fs 在 Windows 也接受正斜杠，保证注入路径跨平台一致 */
function toPosixPath(p: string): string {
  return p.split(sep).join('/');
}

/** 防重名：文件名 + 时间戳 + 随机数 */
function uniqueFilename(name: string): string {
  const base = sanitizeFilename(name);
  const ext = extname(base);
  const stem = basename(base, ext);
  const rand = randomBytes(4).toString('hex');
  return `${stem}_${Date.now()}_${rand}${ext}`;
}

/** 字节数格式化 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

// ── SSRF 防护：阻断解析到私有/保留地址的下载 ──

const PRIVATE_RANGES: Array<[netmask: bigint, prefix: number]> = [
  [0x0A000000n, 8], // 10.0.0.0/8
  [0xAC100000n, 12], // 172.16.0.0/12
  [0xC0A80000n, 16], // 192.168.0.0/16
  [0x7F000000n, 8], // 127.0.0.0/8
  [0xA9FE0000n, 16], // 169.254.0.0/16
  [0xE0000000n, 4], // 224.0.0.0/4 (multicast)
];

function ipToBigInt(ip: string): bigint {
  return ip.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
}

function isPrivateIP(ip: string): boolean {
  const val = ipToBigInt(ip);
  return PRIVATE_RANGES.some(
    ([mask, prefix]) => (val >> (32n - BigInt(prefix))) === (mask >> (32n - BigInt(prefix))),
  );
}

/** 解析 hostname 并阻断指向私有/内网地址的 URL（SSRF 防护） */
async function assertSafeHostname(hostname: string): Promise<void> {
  const addresses = await dns.promises.resolve4(hostname).catch(() => []);
  if (addresses.length === 0) throw new Error(`DNS resolution failed: ${hostname}`);
  for (const addr of addresses) {
    if (isPrivateIP(addr)) throw new Error(`SSRF blocked: ${hostname} resolves to private IP ${addr}`);
  }
}

/** 安全下载：仅 HTTPS + SSRF 防护 + 大小上限 + 超时，返回下载字节数 */
async function download(url: string, destPath: string, maxBytes: number): Promise<number> {
  const parsed = new URL(normalizeUrl(url));
  if (parsed.protocol !== 'https:') {
    throw new Error(`Only HTTPS allowed: ${parsed.protocol}`);
  }
  await assertSafeHostname(parsed.hostname);

  const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error(`Download exceeds ${Math.floor(maxBytes / 1024 / 1024)}MB`);
  }
  writeFileSync(destPath, buf);
  return buf.length;
}

/**
 * 下载消息中的富媒体附件（image/video/file）到本地
 *
 * 下载目录固定为 ~/.dsh-qqbot/media，文件名用时间戳+随机数防重名。
 * 下载失败不阻断（由调用方回退描述）。
 */
export async function downloadMediaAttachments(
  attachments: RawAttachment[] | undefined,
  media: MediaConfig,
  logger: Logger,
): Promise<DownloadedFile[]> {
  if (!media.enabled) return [];

  const targets = (attachments ?? [])
    .map((attachment, sourceIndex) => ({ attachment, sourceIndex }))
    .filter(({ attachment }) => classifyContentType(attachment.content_type) !== 'voice' && attachment.url);
  if (targets.length === 0) return [];

  mkdirSync(MEDIA_ROOT, { recursive: true });

  const maxBytes = (media.maxMB ?? DEFAULT_MAX_MB) * 1024 * 1024;

  const results: DownloadedFile[] = [];
  for (const { attachment: att, sourceIndex } of targets) {
    const contentType = isImageAttachment(att)
      ? 'image'
      : classifyContentType(att.content_type) as 'video' | 'file';
    const localPath = toPosixPath(join(MEDIA_ROOT, uniqueFilename(att.filename)));

    if (att.size > maxBytes) {
      logger.debug(`im-qqbot: skip download (${att.size}B too large): ${att.filename}`);
      continue; // 超限不下载，由 buildDynamicCtx 回退为描述
    }

    let bytes: number;
    try {
      bytes = await download(att.url, localPath, maxBytes);
    } catch (err) {
      logger.warn(`im-qqbot: download failed: ${att.filename} — ${err instanceof Error ? err.message : String(err)}`);
      continue; // 下载失败不加入结果，由 buildDynamicCtx 回退为描述
    }
    logger.debug(`im-qqbot: attachment downloaded: ${att.filename} (${formatSize(bytes)}) → ${localPath}`);

    results.push({ sourceIndex, filename: att.filename, contentType, localPath });
  }

  return results;
}

/** Determine the DSH image media type from magic bytes, not QQ metadata. */
export function detectImageMediaType(data: Uint8Array): NativeImageInput['mediaType'] | undefined {
  if (
    data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  ) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.length >= 6) {
    const signature = String.fromCharCode(...data.subarray(0, 6));
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }
  if (
    data.length >= 12
    && String.fromCharCode(...data.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP'
  ) return 'image/webp';
  return undefined;
}

function safeDisplayName(name: string | undefined, index: number, mediaType: NativeImageInput['mediaType']): string {
  const extension = mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice('image/'.length);
  if (!name) return `qq-image-${index + 1}.${extension}`;
  const base = basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base || `qq-image-${index + 1}.${extension}`;
}

/**
 * Reuse already-downloaded image files as bounded native DSH image inputs.
 * This avoids fetching the same QQ attachment twice while retaining local
 * copies for media tools and quoted-message workflows.
 */
export function prepareNativeImages(
  attachments: RawAttachment[] | undefined,
  downloadedFiles: readonly DownloadedFile[],
  limits: ImageAttachmentLimitsLike,
  logger: Logger,
): DownloadedImage[] {
  const candidates = (attachments ?? [])
    .map((attachment, sourceIndex) => ({ attachment, sourceIndex }))
    .filter(({ attachment }) => isImageAttachment(attachment));
  if (candidates.length === 0) return [];

  const accepted = candidates.slice(0, limits.maxImagesPerMessage);
  if (accepted.length < candidates.length) {
    logger.warn(`im-qqbot: ignored ${candidates.length - accepted.length} image(s) above the ${limits.maxImagesPerMessage}-image limit`);
  }

  const bySourceIndex = new Map(downloadedFiles.map(file => [file.sourceIndex, file]));
  const results: DownloadedImage[] = [];
  let aggregateBytes = 0;
  const perImageLimit = Math.min(limits.maxImageBytes, limits.maxMessageImageBytes);

  for (const { attachment, sourceIndex } of accepted) {
    const downloaded = bySourceIndex.get(sourceIndex);
    if (!downloaded || downloaded.contentType !== 'image') continue;

    let data: Uint8Array;
    try {
      data = readFileSync(downloaded.localPath);
    } catch (err) {
      logger.warn(`im-qqbot: image read failed: ${attachment.filename ?? '(unnamed)'} — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (data.byteLength > perImageLimit) {
      logger.warn(`im-qqbot: image exceeds ${formatSize(perImageLimit)} and was skipped: ${attachment.filename ?? '(unnamed)'}`);
      continue;
    }

    const mediaType = detectImageMediaType(data);
    if (!mediaType || !IMAGE_MEDIA_TYPES.has(mediaType) || !limits.mediaTypes.includes(mediaType)) {
      logger.warn(`im-qqbot: unsupported or malformed image skipped: ${attachment.filename ?? '(unnamed)'}`);
      continue;
    }
    if (aggregateBytes + data.byteLength > limits.maxMessageImageBytes) {
      logger.warn(`im-qqbot: image batch exceeds ${formatSize(limits.maxMessageImageBytes)}; remaining images skipped`);
      break;
    }

    aggregateBytes += data.byteLength;
    results.push({
      sourceIndex,
      input: {
        data,
        mediaType,
        name: safeDisplayName(attachment.filename, sourceIndex, mediaType),
      },
    });
  }

  return results;
}
