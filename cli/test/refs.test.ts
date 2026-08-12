import { describe, expect, test } from 'bun:test';
import { CliError } from '../src/cliError.ts';
import { extractShortIds, parseRef } from '../src/refs.ts';

const CVS = 'cvs_01HZX9K2ABCDEFGHJKMNPQRSTV';
const UUID = '018f3c6e-1234-4abc-9def-00112233aabb';

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
    expect(parseRef('bk_01HZX9K2ABCDEFGHJKMNPQRSTV', 'brand_kit').ref).toBe('bk_01HZX9K2ABCDEFGHJKMNPQRSTV');
    expect(() => parseRef(CVS, 'brand_kit')).toThrow(CliError);
  });
});

describe('extractShortIds', () => {
  test('collects node/page/image/animation short ids from DSL text', () => {
    const ids = extractShortIds('# Page p_a\n n7 rect 10x10\n n12 text "hi" img1\n anim2 fade-in n7');
    expect(ids).toEqual(['anim2', 'img1', 'n12', 'n7', 'p_a']);
  });
});
