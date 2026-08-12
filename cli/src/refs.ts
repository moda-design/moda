/**
 * CANVAS_REF / BRAND_REF / … parsing (cli.md §2.2, canvas-actions-api.md "CANVAS_REF resolution").
 * The API takes prefixed wire IDs (`cvs_…`, Crockford base32) or bare UUIDs; URL parsing is
 * client-side sugar; share URLs resolve via POST /v1/share_links/resolve before the target call.
 */
import { CliError } from './cliError.ts';

export type RefKind = 'canvas' | 'brand_kit' | 'task' | 'file' | 'org' | 'folder' | 'export';

const PREFIX_BY_KIND: Record<RefKind, string> = {
  canvas: 'cvs',
  brand_kit: 'bk',
  task: 'task',
  file: 'file',
  org: 'org',
  folder: 'fld',
  export: 'exp',
};

const KIND_BY_PREFIX: Record<string, RefKind> = Object.fromEntries(
  Object.entries(PREFIX_BY_KIND).map(([kind, prefix]) => [prefix, kind as RefKind]),
) as Record<string, RefKind>;

// Known non-target prefixes we can name in cross-kind errors (IdKind, backend/app/api/public/ids.py:48).
const KNOWN_PREFIXES = new Set([...Object.values(PREFIX_BY_KIND), 'ak', 'team', 'conv', 'upl', 'evt', 'whd', 'bki']);

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const WIRE_ID_RE = /^([a-z]{2,5})_([0-9A-Za-z]{10,40})$/;

export interface ParsedRef {
  kind: RefKind;
  /** The value to place in the URL path: prefixed wire ID or bare UUID, as given. */
  ref: string;
  /** Set when the input was a share URL: resolve the token server-side first. */
  shareToken?: string;
}

function kindLabel(kind: RefKind): string {
  return kind.replace('_', ' ');
}

/**
 * Parse a resource ref: prefixed wire ID, bare UUID, or (canvas only) a moda.app canvas/share URL.
 */
export function parseRef(input: string, expected: RefKind): ParsedRef {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw CliError.usage(`Empty ${kindLabel(expected)} reference.`);

  if (UUID_RE.test(trimmed)) return { kind: expected, ref: trimmed };

  const wire = WIRE_ID_RE.exec(trimmed);
  if (wire) {
    const prefix = wire[1] as string;
    if (prefix === PREFIX_BY_KIND[expected]) return { kind: expected, ref: trimmed };
    if (KNOWN_PREFIXES.has(prefix)) {
      const actual = KIND_BY_PREFIX[prefix];
      throw CliError.usage(
        `Expected a ${kindLabel(expected)} reference (${PREFIX_BY_KIND[expected]}_…) but got ` +
          `${actual ? `a ${kindLabel(actual)} id` : `'${prefix}_…'`}.`,
      );
    }
  }

  if (expected === 'canvas' && (trimmed.startsWith('http://') || trimmed.startsWith('https://'))) {
    return parseCanvasUrl(trimmed);
  }

  throw CliError.usage(
    `Cannot parse ${kindLabel(expected)} reference '${trimmed}'.`,
    `Pass a ${PREFIX_BY_KIND[expected]}_… id or a UUID${expected === 'canvas' ? ', or a moda.app canvas/share URL' : ''}.`,
  );
}

function parseCanvasUrl(input: string): ParsedRef {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw CliError.usage(`Cannot parse canvas URL '${input}'.`);
  }
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  // /c/<ref> and /canvas/<ref> — canvas editor URLs (any host); ref may be a cvs_ id or a UUID.
  if (segments.length >= 2 && (segments[0] === 'c' || segments[0] === 'canvas')) {
    const candidate = segments[1] as string;
    if (UUID_RE.test(candidate) || WIRE_ID_RE.exec(candidate)?.[1] === 'cvs') return { kind: 'canvas', ref: candidate };
    throw CliError.usage(
      `Canvas URL path '/${segments[0]}/${candidate}' does not contain a cvs_ id or UUID.`,
      'Pass the raw canvas id instead.',
    );
  }
  // /s/<token> — share URL; resolved via POST /v1/share_links/resolve.
  if (segments.length >= 2 && segments[0] === 's') {
    return { kind: 'canvas', ref: '', shareToken: segments[1] as string };
  }
  throw CliError.usage(
    `Cannot extract a canvas from URL '${input}'.`,
    'Expected a /c/<canvas>, /canvas/<canvas>, or /s/<share> URL — or pass the raw canvas id.',
  );
}

/** Short session ids minted by canvas reads (`n7`, `p_a`, `img1`, `anim2`) — pass-through per contract. */
export const SHORT_ID_RE = /\b(?:n\d+|p_[a-z0-9]+|img\d+|anim\d+)\b/g;

export function extractShortIds(dslText: string): string[] {
  const found = new Set<string>();
  for (const match of dslText.matchAll(SHORT_ID_RE)) found.add(match[0]);
  return [...found].sort();
}
