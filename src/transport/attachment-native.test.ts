import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectImageMediaType, isImageAttachment, prepareNativeImages } from './attachment.js';
import type { Logger, RawAttachment } from '../types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function logger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('native QQ images', () => {
  it('recognizes MIME, category, and filename-only image attachments', () => {
    expect(isImageAttachment({ content_type: 'image/png', filename: 'a', size: 0, url: '' })).toBe(true);
    expect(isImageAttachment({ content_type: 'image', filename: 'a', size: 0, url: '' })).toBe(true);
    expect(isImageAttachment({ content_type: '', filename: 'a.JPEG', size: 0, url: '' })).toBe(true);
  });

  it('detects supported formats from magic bytes', () => {
    expect(detectImageMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(detectImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(detectImageMediaType(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
  });

  it('reuses the downloaded file and enforces DSH image limits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-qqbot-image-'));
    tempDirs.push(dir);
    const imagePath = join(dir, 'image.png');
    writeFileSync(imagePath, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const attachments: RawAttachment[] = [
      { content_type: 'image/png', filename: 'image.png', size: 8, url: 'https://example.invalid/image.png' },
    ];

    const result = prepareNativeImages(
      attachments,
      [{ sourceIndex: 0, filename: 'image.png', contentType: 'image', localPath: imagePath }],
      { maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024, mediaTypes: ['image/png'] },
      logger(),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.sourceIndex).toBe(0);
    expect(result[0]?.input.mediaType).toBe('image/png');
    expect(result[0]?.input.name).toBe('image.png');
  });
});
