import { describe, expect, test } from 'bun:test';
import { CliError } from '../src/cliError.ts';
import { extractShortIds, parseRef, refUuid, toWireId, wireIdToUuid } from '../src/refs.ts';

const CVS = 'cvs_01HZX9K2ABCDEFGHJKMNPQRSTV';
const UUID = '018f3c6e-1234-4abc-9def-00112233aabb';
const BK = 'bk_01HZX9K2ABCDEFGHJKMNPQRSTV';

describe('parseRef', () => {
  test('prefixed wire id passes through', () => {
    expect(parseRef(CVS, 'canvas')).toEqual({ kind: 'canvas', ref: CVS });
  });

  test('bare UUID passes through', () => {
    expect(parseRef(UUID, 'canvas')).toEqual({ kind: 'canvas', ref: UUID });
  });

  test('canvas editor URL extracts the path ref', () => {
    expect(parseRef(`https://moda.app/c/${CVS}`, 'canvas').ref).toBe(CVS);
    expect(parseRef(`https://moda.app/c/${UUID}`, 'canvas').ref).toBe(UUID);
  });

  test('/canvas/<ref> editor URLs parse on any host (cvs_ id and UUID)', () => {
    expect(parseRef(`https://moda.app/canvas/${CVS}`, 'canvas').ref).toBe(CVS);
    expect(parseRef(`https://app.moda.app/canvas/${UUID}`, 'canvas').ref).toBe(UUID);
  });

  test('unparseable canvas URLs hint the raw-id escape', () => {
    try {
      parseRef('https://moda.app/files/whatever', 'canvas');
      expect.unreachable();
    } catch (err) {
      expect((err as CliError).fields.hint).toContain('pass the raw canvas id');
    }
  });

  test('share URL yields a share token for server-side resolution', () => {
    const parsed = parseRef('https://moda.app/s/abc123token', 'canvas');
    expect(parsed.shareToken).toBe('abc123token');
  });

  test('cross-kind prefix is a loud usage error (bk_ where cvs_ expected)', () => {
    expect(() => parseRef('bk_01HZX9K2ABCDEFGHJKMNPQRSTV', 'canvas')).toThrow(CliError);
    try {
      parseRef('bk_01HZX9K2ABCDEFGHJKMNPQRSTV', 'canvas');
    } catch (err) {
      expect((err as CliError).fields.message).toContain('brand kit');
    }
  });

  test('garbage is a usage error', () => {
    for (const bad of ['', '  ', 'hello world', 'cvs_', 'https://example.com/nope', 'ftp://x/c/y']) {
      expect(() => parseRef(bad, 'canvas')).toThrow(CliError);
    }
  });

  test('brand refs accept bk_ and reject cvs_', () => {
    expect(parseRef(BK, 'brand_kit').ref).toBe(BK);
    expect(() => parseRef(CVS, 'brand_kit')).toThrow(CliError);
  });

  test('brand-kit app URLs parse on any host (/brand-kit/<uuid>, bk_ id too)', () => {
    expect(parseRef(`https://moda.app/brand-kit/${UUID}`, 'brand_kit')).toEqual({ kind: 'brand_kit', ref: UUID });
    expect(parseRef(`http://localhost:3000/brand-kit/${BK}`, 'brand_kit').ref).toBe(BK);
  });

  test('website app URLs parse on any host (/website/<uuid>)', () => {
    expect(parseRef(`https://moda.app/website/${UUID}`, 'website')).toEqual({ kind: 'website', ref: UUID });
    expect(parseRef(UUID, 'website').ref).toBe(UUID);
  });

  test('URL kinds do not cross: a canvas URL is not a brand-kit or website ref', () => {
    expect(() => parseRef(`https://moda.app/canvas/${UUID}`, 'brand_kit')).toThrow(CliError);
    expect(() => parseRef(`https://moda.app/brand-kit/${UUID}`, 'website')).toThrow(CliError);
    // Share URLs stay canvas-only — they resolve to canvases server-side.
    expect(() => parseRef('https://moda.app/s/abc123token', 'brand_kit')).toThrow(CliError);
  });

  test('a wire id where the kind has none (website) is a usage error', () => {
    expect(() => parseRef(CVS, 'website')).toThrow(CliError);
  });

  test('folder app URLs round-trip: /files/folder/<uuid> parses as a folder ref', () => {
    expect(parseRef(`https://moda.app/files/folder/${UUID}`, 'folder')).toEqual({ kind: 'folder', ref: UUID });
    // /files without the folder segment is not a folder permalink.
    expect(() => parseRef(`https://moda.app/files/${UUID}`, 'folder')).toThrow(CliError);
  });
});

describe('wire id codec', () => {
  test('toWireId encodes a UUID per kind prefix and passes wire ids through', () => {
    expect(toWireId('canvas', UUID).startsWith('cvs_')).toBe(true);
    expect(toWireId('folder', UUID).startsWith('fld_')).toBe(true);
    expect(toWireId('canvas', CVS)).toBe(CVS);
    expect(toWireId('website', UUID)).toBe(UUID); // websites have no wire prefix
  });

  test('wireIdToUuid is the inverse of toWireId', () => {
    expect(wireIdToUuid(toWireId('canvas', UUID))).toBe(UUID);
    expect(wireIdToUuid(toWireId('folder', UUID))).toBe(UUID);
    expect(wireIdToUuid('not-a-wire-id')).toBeUndefined();
    expect(wireIdToUuid(UUID)).toBeUndefined();
  });

  test('refUuid: UUIDs pass through, wire ids decode', () => {
    expect(refUuid(UUID)).toBe(UUID);
    expect(refUuid(toWireId('canvas', UUID))).toBe(UUID);
  });
});

describe('extractShortIds', () => {
  test('collects node/page/image/animation short ids from DSL text', () => {
    const ids = extractShortIds('# Page p_a\n n7 rect 10x10\n n12 text "hi" img1\n anim2 fade-in n7');
    expect(ids).toEqual(['anim2', 'img1', 'n12', 'n7', 'p_a']);
  });
});
