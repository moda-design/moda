/**
 * Screenshot file naming: the server historically returned PNG data URLs but now returns JPEG
 * bytes, so output names come from what the bytes actually are — a declared `format` field in the
 * response JSON wins, then magic-byte sniffing, then the data-URL mime. An explicit user-chosen
 * extension on `-o` is honored as written, with a stderr warning when it disagrees with the bytes.
 */

export type ImageFormat = 'png' | 'jpg' | 'webp' | 'gif';

const EXTENSION_FOR_FORMAT: Record<ImageFormat, string> = { png: 'png', jpg: 'jpg', webp: 'webp', gif: 'gif' };

const FORMAT_ALIASES: Record<string, ImageFormat> = {
  png: 'png',
  jpg: 'jpg',
  jpeg: 'jpg',
  webp: 'webp',
  gif: 'gif',
};

/** Normalize a declared format ('jpeg', 'image/png', 'PNG', ...) to a canonical format, if recognized. */
export function normalizeImageFormat(value: unknown): ImageFormat | undefined {
  if (typeof value !== 'string') return undefined;
  const bare = value.trim().toLowerCase().replace(/^image\//, '').replace(/^\./, '');
  return FORMAT_ALIASES[bare];
}

/** Magic-byte sniff of the actual payload. */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }
  return undefined;
}

/**
 * Decide what the image actually is. Precedence: a declared `format` field in the response JSON
 * (the future contract) > sniffed magic bytes > the data-URL mime > png (the legacy assumption).
 */
export function detectImageFormat(input: {
  bytes: Uint8Array;
  declaredFormat?: unknown;
  dataUrlMime?: string;
}): ImageFormat {
  return (
    normalizeImageFormat(input.declaredFormat) ??
    sniffImageFormat(input.bytes) ??
    normalizeImageFormat(input.dataUrlMime) ??
    'png'
  );
}

/** The extension of the final path segment, or undefined when there is none (dotfiles do not count). */
export function pathExtension(path: string): string | undefined {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return base.slice(dot + 1).toLowerCase();
}

export interface NamedScreenshot {
  path: string;
  /** stderr note when the kept user extension disagrees with the actual bytes. */
  warning?: string;
}

/**
 * Resolve the output path for one screenshot.
 * - `explicitPath` (single-page `-o`): kept verbatim when it carries an extension — with a warning
 *   when that extension names a different image format than the bytes; extended with the detected
 *   format when it has no extension.
 * - otherwise `${stem}.${format}` (directory and default shots-dir naming).
 */
export function resolveScreenshotPath(input: {
  format: ImageFormat;
  explicitPath?: string;
  stem: string;
}): NamedScreenshot {
  const extension = EXTENSION_FOR_FORMAT[input.format];
  if (input.explicitPath !== undefined) {
    const userExtension = pathExtension(input.explicitPath);
    if (userExtension === undefined) {
      return { path: `${input.explicitPath}.${extension}` };
    }
    const userFormat = normalizeImageFormat(userExtension);
    if (userFormat !== input.format) {
      return {
        path: input.explicitPath,
        warning: `${input.explicitPath}: server returned ${input.format} bytes but the extension says .${userExtension} — file written as-is`,
      };
    }
    return { path: input.explicitPath };
  }
  return { path: `${input.stem}.${extension}` };
}
