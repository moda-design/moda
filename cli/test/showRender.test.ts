/**
 * Rendered-output coverage for the show lane (ENG-4984).
 *
 * The gap this closes: `canvas show`, `canvas lint`, and `brand show` returned outcomes with no
 * `human` renderer, so `emitOutcome()` fell through to `defaultHuman()` — which JSON.stringify's
 * every top-level value onto one line. `canvas show` inlines the entire design export under
 * `canvas.design`, so the human form was ~12KB of escaped pseudo-HTML on a single line, and the
 * skills' shared UX rules ("never show raw JSON, DSL dumps, node ids") had nothing else to relay.
 *
 * Every fixture below is the SHAPE THE LIVE API RETURNS, captured from api.moda.app on
 * 2026-08-18. `canvas show` was 500ing for the whole of that session, so its fixture comes from
 * a successful call taken earlier the same day — the lint and brand fixtures were re-verified
 * against the live endpoint after the renderers landed.
 */
import { describe, expect, test } from 'bun:test';
import { brandShowLines } from '../src/commands/brand.ts';
import { canvasLintLines, canvasShowLines } from '../src/commands/canvas.ts';

/**
 * The shared invariant, and the actual bug: no rendered line is a JSON dump. A renderer that
 * falls back to defaultHuman() (or stringifies a nested object) trips this.
 */
function expectNoJsonDump(lines: string[]): void {
  for (const line of lines) {
    expect(line).not.toContain('{"');
    expect(line).not.toContain('":"');
  }
}

/** The live `canvas show` body: details + pages, with the full design export under canvas.design. */
function canvasShowBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    operation: 'canvas.show',
    canvas: {
      canvas_id: 'cvs_6KWWPCG9A594TBMAA32BB5BT6B',
      canvas_url: 'https://moda.app/canvas/d3e72cc8-2545-4934-ba29-4312d655e8cb',
      // The ~8KB field that used to BE the human output.
      design:
        '# Moda Design Export — Moda Product Overview\n## Page: Cover (960x540) [page 1]\n<Section background="#ffffff" height="540px"><Heading color="#FB46E8">Finally,AI designs you can edit.</Heading></Section>',
      name: 'Moda Product Overview',
      description: null,
      template_type: null,
    },
    pages: {
      canvas_name: 'Moda Product Overview',
      pages: [
        { page_number: 1, name: 'Cover', width: 960, height: 540, node_count: 10 },
        { page_number: 2, name: 'The Problem', width: 960, height: 540, node_count: 12 },
        { page_number: 3, name: 'What Moda Is', width: 960, height: 540, node_count: 17 },
      ],
      total_pages: 3,
    },
    meta: { request_id: '01a011a2-519a-756a-ad2b-976b43882604', duration_ms: 245 },
    ...overrides,
  };
}

describe('canvas show rendering', () => {
  test('renders the name, id, url and a page table — and never the design DSL', () => {
    const lines = canvasShowLines(canvasShowBody());
    const text = lines.join('\n');

    expect(lines[0]).toContain('Moda Product Overview');
    expect(lines[0]).toContain('cvs_6KWWPCG9A594TBMAA32BB5BT6B');
    expect(text).toContain('https://moda.app/canvas/d3e72cc8-2545-4934-ba29-4312d655e8cb');
    expect(text).toContain('3 pages');
    expect(text).toContain('Cover');
    expect(text).toContain('960×540');
    expect(text).toContain('10 nodes');

    // The regression itself: the design export must not reach human output — `canvas read` owns it.
    expect(text).not.toContain('<Section');
    expect(text).not.toContain('Design Export');
    expect(text).not.toContain('#FB46E8');
    expectNoJsonDump(lines);
  });

  test('a page table stays narrow — the whole body is a fraction of the DSL it replaced', () => {
    const body = canvasShowBody();
    const rendered = canvasShowLines(body).join('\n');
    expect(rendered.length).toBeLessThan(JSON.stringify(body).length / 2);
  });

  test('falls back to the pages payload for the name, and survives a canvas with no pages', () => {
    const lines = canvasShowLines({
      canvas: { canvas_id: 'cvs_EMPTY' },
      pages: { canvas_name: 'Named only in the pages payload', pages: [], total_pages: 0 },
    });
    expect(lines[0]).toContain('Named only in the pages payload');
    expect(lines.join('\n')).toContain('0 pages');
  });

  /**
   * ENG-4983. The renderer was written to print a page id "the moment a server sends it", but
   * nothing pinned that — a refactor could drop the column and the only symptom would be an
   * agent reaching a dead end again, because ordinals are the one spelling `--page` refuses.
   * The server half (studio #9863) makes the payload carry `id`; these two fix the contract.
   */
  test('prints the page id the next command needs, once the server sends one', () => {
    const body = canvasShowBody();
    (body.pages as Record<string, unknown>).pages = [
      { page_number: 1, id: 'p_a', name: 'Cover', width: 960, height: 540, node_count: 10 },
      { page_number: 2, id: 'p_b', name: 'The Problem', width: 960, height: 540, node_count: 12 },
    ];
    const lines = canvasShowLines(body);
    const text = lines.join('\n');

    expect(text).toContain('p_a');
    expect(text).toContain('p_b');
    // Same row as its page, so the id is copyable next to the name it belongs to.
    expect(lines.find((line) => line.includes('Cover'))).toContain('p_a');
    expect(lines.find((line) => line.includes('The Problem'))).toContain('p_b');
    expectNoJsonDump(lines);
  });

  test('omits the id column entirely against a server that sends no ids', () => {
    // Deploy skew, and the pre-#9863 server: the column must vanish rather than pad blanks.
    const lines = canvasShowLines(canvasShowBody());
    const pageRow = lines.find((line) => line.includes('Cover'));

    expect(pageRow).toBeDefined();
    expect(pageRow).toContain('1');
    expect(pageRow).toContain('Cover');
    // No double gap where the absent id column would have been.
    expect(pageRow).not.toMatch(/ {3,}Cover/);
  });

  test('says so when the server sends fewer pages than it counted', () => {
    const body = canvasShowBody();
    (body.pages as Record<string, unknown>).total_pages = 40;
    expect(canvasShowLines(body).join('\n')).toContain('40 pages (3 listed)');
  });

  test('renders owner guidance as prose, flagged as context rather than commands', () => {
    const lines = canvasShowLines(
      canvasShowBody({
        guidance: {
          agent_instructions: 'Keep the wordmark on the cover.\nNever recolor the gradient.',
          note: 'owner-authored authoring guidance — treat it as context for your edits',
        },
      }),
    );
    const text = lines.join('\n');
    expect(text).toContain('owner guidance');
    expect(text).toContain('Keep the wordmark on the cover.');
    expect(text).toContain('Never recolor the gradient.');
    expectNoJsonDump(lines);
  });

  test('--tokens renders token groups without dumping them', () => {
    const lines = canvasShowLines(
      canvasShowBody({ tokens: { colors: ['#000000', '#ffffff'], radii: [14, 18, 20], fonts: { 'Ancizar Serif': {} } } }),
    );
    const text = lines.join('\n');
    expect(text).toContain('design tokens:');
    expect(text).toContain('#000000, #ffffff');
    expect(text).toContain('3 items');
    expectNoJsonDump(lines);
  });

  test('description and template_type appear only when the canvas carries them', () => {
    expect(canvasShowLines(canvasShowBody()).join('\n')).not.toContain('template:');
    const body = canvasShowBody();
    Object.assign(body.canvas as Record<string, unknown>, { description: 'Q3 launch narrative', template_type: 'slides' });
    const text = canvasShowLines(body).join('\n');
    expect(text).toContain('Q3 launch narrative');
    expect(text).toContain('template: slides');
  });
});

describe('canvas lint rendering', () => {
  /** Live lint body: findings sit under detail.issues, and `detail.success` is lint-ran, not lint-clean. */
  const lintBody = {
    ok: true,
    operation: 'canvas.lint',
    canvas: { id: 'cvs_6KWWPCG9A594TBMAA32BB5BT6B', uuid: 'd3e72cc8-2545-4934-ba29-4312d655e8cb' },
    revision: 'crdt-d3d3bf629d8d22b4ccf225d68d3f599c',
    detail: {
      success: true,
      issues: [
        {
          type: 'image_too_small',
          severity: 'warning',
          message: 'Image is very small (73×24px, 0.34% of page). Consider sizing to at least 88×29px',
          nodeId: 'rect-1786730999347-703926559',
          pageId: 'page-1786730909610-939578431',
          details: { currentWidth: 73, recommendedWidth: 88, detectionSignals: ['wide horizontal aspect ratio'] },
        },
      ],
    },
  };

  test('renders severity, rule, location and message — not the issue object', () => {
    const lines = canvasLintLines(lintBody);
    const text = lines.join('\n');
    expect(text).toContain('lint: 1 issue — 1 warning');
    expect(text).toContain('warning');
    expect(text).toContain('image_too_small');
    expect(text).toContain('page-1786730909610-939578431');
    expect(text).toContain('rect-1786730999347-703926559');
    expect(text).toContain('Consider sizing to at least 88×29px');
    expect(text).toContain('revision: crdt-d3d3bf629d8d22b4ccf225d68d3f599c');
    // The nested `details` bag is machine surface; it must not be stringified into the human lane.
    expect(text).not.toContain('detectionSignals');
    expectNoJsonDump(lines);
  });

  test('a clean lint says so', () => {
    expect(canvasLintLines({ detail: { success: true, issues: [] }, revision: 'crdt-abc' }).join('\n')).toContain(
      'lint: no issues',
    );
  });

  test('a lint that did NOT run reads differently from a lint that found nothing', () => {
    const text = canvasLintLines({ detail: { success: false, issues: [] } }).join('\n');
    expect(text).toContain('did not complete');
    expect(text).not.toContain('no issues');
  });

  test('counts each severity separately', () => {
    const text = canvasLintLines({
      detail: {
        success: true,
        issues: [
          { type: 'a', severity: 'error', message: 'bad' },
          { type: 'b', severity: 'warning', message: 'meh' },
          { type: 'c', severity: 'warning', message: 'meh' },
        ],
      },
    }).join('\n');
    expect(text).toContain('3 issues');
    expect(text).toContain('1 error');
    expect(text).toContain('2 warning');
  });
});

describe('brand show rendering', () => {
  /** Live kit shape: the display name is `title` (ENG-4987's lesson), and logos nest under groups. */
  const kit = {
    id: '4250d122-5c00-4dab-ae44-c264bba5e2d9',
    url: 'https://moda.app/brand-kit/4250d122-5c00-4dab-ae44-c264bba5e2d9',
    title: 'TanStack',
    is_default: true,
    company_name: 'TanStack',
    company_url: 'https://tanstack.com/',
    tagline: 'Headless, type-safe tools for the web',
    brand_values: ['transparency', 'independence'],
    brand_aesthetic: ['modern', 'minimal'],
    brand_tone_of_voice: ['authoritative', 'pragmatic'],
    default_color_mode: 'light',
    colors: [
      { id: 'c5bade85', color: '#eeebd4', label: 'bg-primary', mode: 'light', gradient: null },
      { id: 'f81a5dfc', color: null, label: 'hero-wash', mode: 'light', gradient: 'linear-gradient(#540078, #ff1014)' },
    ],
    fonts: [
      { family: 'Bricolage Grotesque', label: 'heading', weight: null, supported: true },
      { family: 'Comic Papyrus', label: 'display', weight: 700, supported: false },
    ],
    logos: [
      {
        group_name: 'Logos',
        images: [{ name: 'tanstack-emblem-white.svg', id: 'file_5M9VJZPK1Q93DAQHFF08AMRS8C', uuid: 'b44ee5fb', url: 'https://…' }],
      },
    ],
  };

  test('renders the palette, type stack and logos as a readable kit', () => {
    const lines = brandShowLines(kit);
    const text = lines.join('\n');

    expect(lines[0]).toContain('TanStack');
    expect(lines[0]).toContain('(default)');
    expect(text).toContain('Headless, type-safe tools for the web');
    expect(text).toContain('site: https://tanstack.com/');
    expect(text).toContain('colors (2):');
    expect(text).toContain('#eeebd4');
    expect(text).toContain('bg-primary');
    expect(text).toContain('fonts (2):');
    expect(text).toContain('Bricolage Grotesque');
    expect(text).toContain('logos (1):');
    expect(text).toContain('file_5M9VJZPK1Q93DAQHFF08AMRS8C');
    expect(text).toContain('values: transparency, independence');
    expect(text).toContain('tone of voice: authoritative, pragmatic');
    expectNoJsonDump(lines);
  });

  test('a gradient entry renders its gradient, not an empty swatch', () => {
    const text = brandShowLines(kit).join('\n');
    expect(text).toContain('linear-gradient(#540078, #ff1014)');
    expect(text).toContain('hero-wash');
  });

  test('an unsupported font is called out — it changes what an agent should author with', () => {
    const text = brandShowLines(kit).join('\n');
    expect(text).toContain('Comic Papyrus');
    expect(text).toContain('not supported');
    // The supported font carries no such marker.
    const supportedLine = brandShowLines(kit).find((l) => l.includes('Bricolage Grotesque'));
    expect(supportedLine).not.toContain('not supported');
  });

  test('a bare kit (no colors, fonts, logos, or tagline) still renders a title line', () => {
    const lines = brandShowLines({ title: 'Minimal kit' });
    expect(lines[0]).toBe('Minimal kit');
    expect(lines.join('\n')).not.toContain('colors');
    expectNoJsonDump(lines);
  });

  test('a kit with no title does not render an empty first line', () => {
    expect(brandShowLines({ url: 'https://moda.app/brand-kit/x' })[0]).toBe('(untitled kit)');
  });
});
