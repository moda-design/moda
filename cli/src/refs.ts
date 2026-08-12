/**
 * CANVAS_REF / BRAND_REF / … parsing (cli.md §2.2, canvas-actions-api.md "CANVAS_REF resolution").
 * The API takes prefixed wire IDs (`cvs_…`, Crockford base32) or bare UUIDs; URL parsing is
 * client-side sugar; share URLs resolve via POST /v1/share_links/resolve before the target call.
 * Pasted app URLs are accepted for the kinds with an app page: /c|/canvas/<canvas>,
 * /brand-kit/<uuid>, /website/<uuid>.
 */
import { CliError } from './cliError.ts';

export type RefKind =
  | 'canvas'
  | 'brand_kit'
  | 'brand_kit_image'
  | 'task'
  | 'file'
  | 'org'
  | 'folder'
  | 'export'
  | 'website';

/** Wire-id prefix per kind. Websites have none — their wire ids are bare UUIDs. */
const PREFIX_BY_KIND: Record<RefKind, string | undefined> = {
  canvas: 'cvs',
  brand_kit: 'bk',
  brand_kit_image: 'bki',
  task: 'task',
  file: 'file',
  org: 'org',
  folder: 'fld',
  export: 'exp',
  website: undefined,
};

const KIND_BY_PREFIX: Record<string, RefKind> = Object.fromEntries(
  Object.entries(PREFIX_BY_KIND)
    .filter(([, prefix]) => prefix !== undefined)
    .map(([kind, prefix]) => [prefix as string, kind as RefKind]),
) as Record<string, RefKind>;

// Known non-target prefixes we can name in cross-kind errors (IdKind, backend/app/api/public/ids.py:48).
const KNOWN_PREFIXES = new Set([
  ...Object.values(PREFIX_BY_KIND).filter((p): p is string => p !== undefined),
  'ak',
  'team',
  'conv',
  'upl',
  'evt',
  'whd',
]);

/**
 * App URL path segments accepted as pasted refs, per kind. The app serves /canvas/<id> (and
 * historically linked /c/<id>, still accepted as INPUT sugar — never emitted), /brand-kit/<uuid>,
 * and /website/<uuid>. Canvas additionally accepts /s/<token> share URLs (resolved server-side).
 */
const URL_SEGMENTS_BY_KIND: Partial<Record<RefKind, string[]>> = {
  canvas: ['c', 'canvas'],
  brand_kit: ['brand-kit'],
  website: ['website'],
};

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
  return kind.replaceAll('_', ' ');
}

/**
 * Parse a resource ref: prefixed wire ID, bare UUID, or — for kinds with an app page — a
 * pasted moda.app URL (canvas also takes share URLs).
 */
export function parseRef(input: string, expected: RefKind): ParsedRef {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw CliError.usage(`Empty ${kindLabel(expected)} reference.`);

  if (UUID_RE.test(trimmed)) return { kind: expected, ref: trimmed };

  const expectedPrefix = PREFIX_BY_KIND[expected];
  const wire = WIRE_ID_RE.exec(trimmed);
  if (wire) {
    const prefix = wire[1] as string;
    if (expectedPrefix !== undefined && prefix === expectedPrefix) return { kind: expected, ref: trimmed };
    if (KNOWN_PREFIXES.has(prefix)) {
      const actual = KIND_BY_PREFIX[prefix];
      throw CliError.usage(
        `Expected a ${kindLabel(expected)} reference (${expectedPrefix !== undefined ? `${expectedPrefix}_…` : 'a UUID'}) but got ` +
          `${actual ? `a ${kindLabel(actual)} id` : `'${prefix}_…'`}.`,
      );
    }
  }

  if (
    URL_SEGMENTS_BY_KIND[expected] !== undefined &&
    (trimmed.startsWith('http://') || trimmed.startsWith('https://'))
  ) {
    return parseAppUrl(trimmed, expected);
  }

  throw CliError.usage(
    `Cannot parse ${kindLabel(expected)} reference '${trimmed}'.`,
    `Pass a ${expectedPrefix !== undefined ? `${expectedPrefix}_… id or a ` : ''}UUID${urlHint(expected)}.`,
  );
}

function urlHint(expected: RefKind): string {
  if (expected === 'canvas') return ', or a moda.app canvas/share URL';
  const segments = URL_SEGMENTS_BY_KIND[expected];
  return segments !== undefined ? `, or a moda.app /${segments[0]}/<uuid> URL` : '';
}

function parseAppUrl(input: string, expected: RefKind): ParsedRef {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw CliError.usage(`Cannot parse ${kindLabel(expected)} URL '${input}'.`);
  }
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  const accepted = URL_SEGMENTS_BY_KIND[expected] ?? [];
  // /<segment>/<ref> — app editor URLs (any host); ref may be the kind's wire id or a UUID.
  if (segments.length >= 2 && accepted.includes(segments[0] as string)) {
    const candidate = segments[1] as string;
    const prefix = PREFIX_BY_KIND[expected];
    if (UUID_RE.test(candidate) || (prefix !== undefined && WIRE_ID_RE.exec(candidate)?.[1] === prefix)) {
      return { kind: expected, ref: candidate };
    }
    throw CliError.usage(
      `${kindLabel(expected)} URL path '/${segments[0]}/${candidate}' does not contain ` +
        `${prefix !== undefined ? `a ${prefix}_ id or ` : ''}a UUID.`,
      `Pass the raw ${kindLabel(expected)} id instead.`,
    );
  }
  // /s/<token> — share URL (canvas only); resolved via POST /v1/share_links/resolve.
  if (expected === 'canvas' && segments.length >= 2 && segments[0] === 's') {
    return { kind: 'canvas', ref: '', shareToken: segments[1] as string };
  }
  throw CliError.usage(
    `Cannot extract a ${kindLabel(expected)} from URL '${input}'.`,
    expected === 'canvas'
      ? 'Expected a /c/<canvas>, /canvas/<canvas>, or /s/<share> URL — or pass the raw canvas id.'
      : `Expected a /${accepted[0]}/<uuid> URL — or pass the raw ${kindLabel(expected)} id.`,
  );
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Encode a ref to the kind's prefixed wire form. Wire ids pass through; a bare UUID is encoded
 * as the ULID-style Crockford-base32 of its 128 bits (26 chars) — the server's encode_id scheme.
 * Needed where a request TYPE takes only the wire form (POST /v1/remix's canvas_id) or where a
 * response lists only wire ids (drive folder rows).
 */
export function toWireId(kind: RefKind, ref: string): string {
  const prefix = PREFIX_BY_KIND[kind];
  if (prefix === undefined || ref.startsWith(`${prefix}_`)) return ref;
  const hex = ref.replaceAll('-', '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return ref; // not a UUID — pass through untouched
  let value = BigInt(`0x${hex}`);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return `${prefix}_${out}`;
}

/**
 * Decode a prefixed wire id back to the bare UUID (the inverse of toWireId); undefined when the
 * input is not a decodable wire id. The open lane's constructed-URL fallback depends on this:
 * app routes take the BARE UUID, never the wire form.
 */
export function wireIdToUuid(ref: string): string | undefined {
  const match = /^[a-z]{2,5}_([0-9A-Za-z]{26})$/.exec(ref);
  if (match === null) return undefined;
  let value = 0n;
  for (const ch of (match[1] as string).toUpperCase()) {
    const index = CROCKFORD.indexOf(ch);
    if (index === -1) return undefined; // I, L, O, U are not Crockford digits
    value = (value << 5n) | BigInt(index);
  }
  if (value >> 128n !== 0n) return undefined; // 26 chars carry 130 bits; the top 2 must be zero
  const hex = value.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The bare UUID for a ref: UUIDs pass through as given; prefixed wire ids decode. */
export function refUuid(ref: string): string | undefined {
  return UUID_RE.test(ref) ? ref : wireIdToUuid(ref);
}

/** Short session ids minted by canvas reads (`n7`, `p_a`, `img1`, `anim2`) — pass-through per contract. */
export const SHORT_ID_RE = /\b(?:n\d+|p_[a-z0-9]+|img\d+|anim\d+)\b/g;

export function extractShortIds(dslText: string): string[] {
  const found = new Set<string>();
  for (const match of dslText.matchAll(SHORT_ID_RE)) found.add(match[0]);
  return [...found].sort();
}
