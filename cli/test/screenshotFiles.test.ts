import { describe, expect, test } from 'bun:test';
import {
  detectImageFormat,
  normalizeImageFormat,
  pathExtension,
  resolveScreenshotPath,
  sniffImageFormat,
} from '../src/commands/screenshotFiles.ts';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe('sniffImageFormat', () => {
  test('recognizes png, jpeg, gif, webp magic bytes', () => {
    expect(sniffImageFormat(PNG)).toBe('png');
    expect(sniffImageFormat(JPEG)).toBe('jpg');
    expect(sniffImageFormat(GIF)).toBe('gif');
    expect(sniffImageFormat(WEBP)).toBe('webp');
  });

  test('unknown or truncated bytes are undefined', () => {
    expect(sniffImageFormat(Uint8Array.from([0x00, 0x01, 0x02, 0x03]))).toBeUndefined();
    expect(sniffImageFormat(Uint8Array.from([0xff, 0xd8]))).toBeUndefined();
    expect(sniffImageFormat(Uint8Array.from([]))).toBeUndefined();
    // RIFF container that is not WEBP (e.g. WAVE) must not match.
    expect(sniffImageFormat(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeUndefined();
  });
});

describe('normalizeImageFormat', () => {
  test('accepts bare names, jpeg alias, mime types, dotted extensions, and mixed case', () => {
    expect(normalizeImageFormat('png')).toBe('png');
    expect(normalizeImageFormat('jpeg')).toBe('jpg');
    expect(normalizeImageFormat('jpg')).toBe('jpg');
    expect(normalizeImageFormat('image/jpeg')).toBe('jpg');
    expect(normalizeImageFormat('image/png')).toBe('png');
    expect(normalizeImageFormat('.webp')).toBe('webp');
    expect(normalizeImageFormat(' PNG ')).toBe('png');
  });

  test('rejects non-strings and unknown formats', () => {
    expect(normalizeImageFormat(undefined)).toBeUndefined();
    expect(normalizeImageFormat(7)).toBeUndefined();
    expect(normalizeImageFormat('image/svg+xml')).toBeUndefined();
    expect(normalizeImageFormat('tiff')).toBeUndefined();
  });
});

describe('detectImageFormat', () => {
  test('a declared format field wins over the bytes (the future server contract)', () => {
    expect(detectImageFormat({ bytes: JPEG, declaredFormat: 'png' })).toBe('png');
    expect(detectImageFormat({ bytes: PNG, declaredFormat: 'jpeg' })).toBe('jpg');
  });

  test('sniffed bytes win over the data-URL mime (the mime is what lied historically)', () => {
    expect(detectImageFormat({ bytes: JPEG, dataUrlMime: 'image/png' })).toBe('jpg');
  });

  test('falls back to the data-URL mime when bytes are unrecognizable, then to png', () => {
    const junk = Uint8Array.from([1, 2, 3, 4]);
    expect(detectImageFormat({ bytes: junk, dataUrlMime: 'image/webp' })).toBe('webp');
    expect(detectImageFormat({ bytes: junk })).toBe('png');
    expect(detectImageFormat({ bytes: junk, declaredFormat: 'bmp', dataUrlMime: 'application/json' })).toBe('png');
  });
});

describe('pathExtension', () => {
  test('extracts the final extension; dotfiles and extensionless paths have none', () => {
    expect(pathExtension('shots/foo.JPG')).toBe('jpg');
    expect(pathExtension('a.b/c')).toBeUndefined();
    expect(pathExtension('.hidden')).toBeUndefined();
    expect(pathExtension('archive.tar.gz')).toBe('gz');
    expect(pathExtension('plain')).toBeUndefined();
  });
});

describe('resolveScreenshotPath', () => {
  test('explicit -o with a matching extension is kept verbatim, no warning', () => {
    expect(resolveScreenshotPath({ format: 'jpg', explicitPath: 'out/shot.jpg', stem: 'x' })).toEqual({
      path: 'out/shot.jpg',
    });
    // jpeg spelling of the same format also matches
    expect(resolveScreenshotPath({ format: 'jpg', explicitPath: 'shot.jpeg', stem: 'x' })).toEqual({
      path: 'shot.jpeg',
    });
  });

  test('explicit -o with a mismatched extension is kept but warned about', () => {
    const named = resolveScreenshotPath({ format: 'jpg', explicitPath: 'shot.png', stem: 'x' });
    expect(named.path).toBe('shot.png');
    expect(named.warning).toContain('jpg bytes');
    expect(named.warning).toContain('.png');
  });

  test('explicit -o with an unknown extension is kept but warned about', () => {
    const named = resolveScreenshotPath({ format: 'jpg', explicitPath: 'shot.bin', stem: 'x' });
    expect(named.path).toBe('shot.bin');
    expect(named.warning).toContain('.bin');
  });

  test('explicit -o without an extension gets the detected one appended', () => {
    expect(resolveScreenshotPath({ format: 'jpg', explicitPath: 'shots/cover', stem: 'x' })).toEqual({
      path: 'shots/cover.jpg',
    });
  });

  test('stem naming (directory and default shots dir) uses the detected format extension', () => {
    expect(resolveScreenshotPath({ format: 'jpg', stem: 'shots/p_1' })).toEqual({ path: 'shots/p_1.jpg' });
    expect(resolveScreenshotPath({ format: 'png', stem: 'shots/p_1' })).toEqual({ path: 'shots/p_1.png' });
  });
});
