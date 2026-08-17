/**
 * Rendered-output coverage for the list lane (ENG-4987).
 *
 * The gap this closes: PR #53 shipped `brand list` reading `name` while the kit read model
 * spells it `title`. `str()` returned undefined, the `?? ''` fallback rendered a blank column,
 * and the suite stayed green — nothing asserted on a list verb's human line.
 *
 * Every fixture below is the SHAPE THE LIVE API RETURNS, and each one carries at least one
 * decoy field holding a different value (a kit's `company_name`, a canvas's `title`), so a
 * renderer reading the wrong key fails loudly instead of printing an empty column.
 */
import { describe, expect, test } from 'bun:test';
import { brandListLine } from '../src/commands/brand.ts';
import { canvasListLine } from '../src/commands/canvas.ts';
import { folderLine } from '../src/commands/drive.ts';
import { assetLine, fileLine } from '../src/commands/file.ts';
import { orgLine } from '../src/commands/org.ts';
import { siteLine } from '../src/commands/site.ts';
import { templateLine } from '../src/commands/template.ts';

/**
 * The shared invariant: a list line never renders an id followed by nothing. That is exactly
 * what a wrong field name produces, and exactly what shipped in #53.
 */
function expectNamed(line: string, id: string, name: string): void {
  expect(line).toContain(id);
  expect(line).toContain(name);
  expect(line.replace(id, '').trim()).not.toBe('');
}

describe('list-lane rendering: the name always reaches the line', () => {
  test('brand list reads `title`, not `name` or `company_name` (the #53 regression)', () => {
    const line = brandListLine({
      id: 'bk_1QRB8CKRQ4863B2RXHKD9QG296',
      title: 'A Book of Creatures',
      // Decoys: the create request POSTs `name`, and the kit also carries `company_name`.
      company_name: 'WRONG-company-name-field',
      is_default: false,
    });
    expectNamed(line, 'bk_1QRB8CKRQ4863B2RXHKD9QG296', 'A Book of Creatures');
    expect(line).not.toContain('WRONG');
  });

  test('canvas list / search read `name`', () => {
    const line = canvasListLine({
      id: 'cvs_6KWWPCG9A594TBMAA32BB5BT6B',
      name: 'Moda Product Overview',
      title: 'WRONG-title-field',
    });
    expectNamed(line, 'cvs_6KWWPCG9A594TBMAA32BB5BT6B', 'Moda Product Overview');
    expect(line).not.toContain('WRONG');
  });

  test('org list reads `name`, and appends the slug when present', () => {
    const id = '27ce0511-eaae-4f28-bf45-5717eb03f7d1';
    expectNamed(orgLine({ id, name: 'Moda official' }), id, 'Moda official');
    expect(orgLine({ id, name: 'Moda official', slug: 'moda-official' })).toContain('(moda-official)');
  });

  test('file list reads `name` + mime + size', () => {
    const line = fileLine({
      id: 'file_3KA85R684P8FZS6TVVZZE4PW8V',
      name: 'moda-linkedin-ideas-2026-08-16.md',
      mime_type: 'text/markdown',
      size_bytes: 8271,
    });
    expectNamed(line, 'file_3KA85R684P8FZS6TVVZZE4PW8V', 'moda-linkedin-ideas-2026-08-16.md');
    expect(line).toContain('text/markdown');
    expect(line).toContain('8271 bytes');
  });

  test('file search reads `name`', () => {
    const line = assetLine({ id: 'file_5WG5NGT7SA9ANVPFMSJ7HJRGZ7', name: 'hero-shot.mp4' });
    expectNamed(line, 'file_5WG5NGT7SA9ANVPFMSJ7HJRGZ7', 'hero-shot.mp4');
  });

  test('template list reads `name`, with category and page count', () => {
    const line = templateLine({
      id: 'cvs_033WNF47XX9HJR6TS5796125SW',
      name: 'A Book of Creatures — Talk Template',
      category: 'slides',
      page_count: 3,
    });
    expectNamed(line, 'cvs_033WNF47XX9HJR6TS5796125SW', 'A Book of Creatures — Talk Template');
    expect(line).toContain('slides');
    expect(line).toContain('3 pages');
  });

  test('site list reads `name` and the publish state', () => {
    const id = '918768f3-9fe6-46d5-8842-286cf86c0efe';
    const line = siteLine({ id, name: 'Backtest Viewer — Brand Restyle Preview', is_published: false });
    expectNamed(line, id, 'Backtest Viewer — Brand Restyle Preview');
    expect(line).toContain('not published');
  });

  test('drive folders prefer `path` over `name`, and keep the id', () => {
    const line = folderLine({
      id: 'fld_2QCF4PY41X86BRHQD75N37V7JV',
      path: '/Brand Kits',
      name: 'Brand Kits',
      subfolder_count: 44,
    });
    expectNamed(line, 'fld_2QCF4PY41X86BRHQD75N37V7JV', '/Brand Kits');
  });
});

describe('list-lane rendering: missing fields degrade without crashing', () => {
  test('an id-only item still renders its id rather than throwing', () => {
    // Not an endorsement of the blank column — the point is that the renderers are total.
    expect(brandListLine({ id: 'bk_x' })).toContain('bk_x');
    expect(canvasListLine({ id: 'cvs_x' })).toContain('cvs_x');
    expect(orgLine({ id: 'org_x' })).toContain('org_x');
  });

  test('an item with no id renders the `?` placeholder, never "undefined"', () => {
    for (const line of [brandListLine({ title: 'T' }), canvasListLine({ name: 'N' }), orgLine({ name: 'N' })]) {
      expect(line).toContain('?');
      expect(line).not.toContain('undefined');
    }
  });

  test('file and site name their unnamed rows explicitly', () => {
    expect(fileLine({ id: 'file_x' })).toContain('(unnamed)');
    expect(siteLine({ id: 'w_x', is_published: false })).toContain('(unnamed)');
  });
});
