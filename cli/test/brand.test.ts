/**
 * G22 brand-kit manual creation + update/image verbs: flag parsing, wire contracts
 * against the shipped /v1/brand-kits surface (manual create body, PATCH replace-all
 * fields, images add/list/remove), and the kit-file lane.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from '../src/api/client.ts';
import { CliError } from '../src/cliError.ts';
import {
  parseColorFlag,
  parseFontFlag,
  performBrandAddImage,
  performBrandCreate,
  performBrandImages,
  performBrandRemoveImage,
  performBrandUpdate,
  readManualKitFile,
} from '../src/commands/brand.ts';

const KIT_ID = 'a2b4c6d8-1234-4e8f-b1a2-5d6e7f809012';

let server: ReturnType<typeof Bun.serve> | undefined;

interface Captured {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

function serve(respond: (req: Request, url: URL) => Response | Promise<Response>): { base: string; calls: Captured[] } {
  const calls: Captured[] = [];
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      calls.push({ method: req.method, path: url.pathname, body });
      return respond(req, url);
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, calls };
}

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function client(base: string): ApiClient {
  return new ApiClient({
    apiBase: base,
    apiKey: 'moda_live_testkey000000',
    sleeper: async () => {},
    env: { MODA_STATE_DIR: '/tmp/moda-brand-test' },
  });
}

function humanLines(outcome: { human?: (write: (line: string) => void) => void }): string[] {
  const lines: string[] = [];
  outcome.human?.((line) => lines.push(line));
  return lines;
}

describe('flag parsing', () => {
  test('parseColorFlag: bare hex, labeled, label keeps embedded colons', () => {
    expect(parseColorFlag('#0F172A')).toEqual({ color: '#0F172A' });
    expect(parseColorFlag('#0F172A:Primary')).toEqual({ color: '#0F172A', label: 'Primary' });
    expect(parseColorFlag('#0F172A:Primary: dark')).toEqual({ color: '#0F172A', label: 'Primary: dark' });
  });

  test('parseColorFlag: empty color is a usage error', () => {
    expect(() => parseColorFlag(':Primary')).toThrow(CliError);
  });

  test('parseFontFlag: family, family:label, family::weight, full triple', () => {
    expect(parseFontFlag('Inter')).toEqual({ family: 'Inter' });
    expect(parseFontFlag('Inter:title')).toEqual({ family: 'Inter', label: 'title' });
    expect(parseFontFlag('Inter::600')).toEqual({ family: 'Inter', weight: 600 });
    expect(parseFontFlag('Source Serif 4:body:400')).toEqual({ family: 'Source Serif 4', label: 'body', weight: 400 });
  });

  test('parseFontFlag: non-integer weight is a usage error', () => {
    expect(() => parseFontFlag('Inter:title:bold')).toThrow(CliError);
  });
});

describe('brand create — manual lane (shipped POST /v1/brand-kits direct-fields contract)', () => {
  test('posts name + colors + fonts + logo_file_ids and injects the derived idempotency key', async () => {
    const { base, calls } = serve(() => Response.json({ id: KIT_ID, title: 'Acme', usage: { class: 'deterministic' } }));
    const body = {
      name: 'Acme',
      colors: [{ color: '#0F172A', label: 'Primary' }],
      fonts: [{ family: 'Inter', weight: 600 }],
      logo_file_ids: ['file_2AbCdEfGhJkMnPqRsTuVwX'],
    };
    const outcome = await performBrandCreate(client(base), body);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/v1/brand-kits');
    expect(calls[0]?.body.name).toBe('Acme');
    expect(calls[0]?.body.colors).toEqual([{ color: '#0F172A', label: 'Primary' }]);
    expect(calls[0]?.body.fonts).toEqual([{ family: 'Inter', weight: 600 }]);
    expect(calls[0]?.body.logo_file_ids).toEqual(['file_2AbCdEfGhJkMnPqRsTuVwX']);
    expect(typeof calls[0]?.body.idempotency_key).toBe('string');
    expect((outcome.body as Record<string, unknown>).operation).toBe('brand.create');
    expect((outcome.body as Record<string, unknown>).id).toBe(KIT_ID);
  });
});

describe('brand update (shipped PATCH /v1/brand-kits/{id} contract)', () => {
  test('PATCHes exactly the provided fields', async () => {
    const { base, calls } = serve(() => Response.json({ id: KIT_ID, title: 'Acme', tagline: 'Build fast' }));
    const outcome = await performBrandUpdate(client(base), KIT_ID, {
      tagline: 'Build fast',
      colors: [{ color: '#F97316', label: 'Accent' }],
    });
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.path).toBe(`/v1/brand-kits/${KIT_ID}`);
    expect(calls[0]?.body).toEqual({ tagline: 'Build fast', colors: [{ color: '#F97316', label: 'Accent' }] });
    expect((outcome.body as Record<string, unknown>).operation).toBe('brand.update');
    expect(humanLines(outcome)[0]).toContain(KIT_ID);
  });
});

describe('brand images / add-image / remove-image (shipped images endpoints)', () => {
  test('images: GET list renders bki id, role, name, group', async () => {
    const { base, calls } = serve(() =>
      Response.json({
        data: [
          { id: 'bki_2AbCdEfGhJkMnPqRsTuVwX', role: 'logo', name: 'Dark logo', group_name: 'Logos', file_id: 'file_x', url: 'http://x' },
        ],
        returned: 1,
        total: 1,
      }),
    );
    const outcome = await performBrandImages(client(base), KIT_ID);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toBe(`/v1/brand-kits/${KIT_ID}/images`);
    const lines = humanLines(outcome);
    expect(lines[0]).toContain('bki_2AbCdEfGhJkMnPqRsTuVwX');
    expect(lines[0]).toContain('logo');
    expect(lines[0]).toContain('Dark logo');
  });

  test('images: empty list steers to add-image', async () => {
    const { base } = serve(() => Response.json({ data: [], returned: 0, total: 0 }));
    const outcome = await performBrandImages(client(base), KIT_ID);
    expect(humanLines(outcome)[0]).toContain('moda brand add-image');
  });

  test('add-image: POSTs file_id + role, omits absent label', async () => {
    const { base, calls } = serve(() => Response.json({ id: KIT_ID, title: 'Acme' }));
    await performBrandAddImage(client(base), KIT_ID, { file_id: 'file_2AbCdEfGhJkMnPqRsTuVwX', role: 'logo' });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe(`/v1/brand-kits/${KIT_ID}/images`);
    expect(calls[0]?.body).toEqual({ file_id: 'file_2AbCdEfGhJkMnPqRsTuVwX', role: 'logo' });
  });

  test('remove-image: DELETE on the image path, ok envelope on 204', async () => {
    const { base, calls } = serve(() => new Response(null, { status: 204 }));
    const outcome = await performBrandRemoveImage(client(base), KIT_ID, 'bki_2AbCdEfGhJkMnPqRsTuVwX');
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.path).toBe(`/v1/brand-kits/${KIT_ID}/images/bki_2AbCdEfGhJkMnPqRsTuVwX`);
    expect((outcome.body as Record<string, unknown>).ok).toBe(true);
    expect(humanLines(outcome)[0]).toContain('removed');
  });
});

describe('--from-file kit JSON lane', () => {
  test('reads name/colors/fonts/logo_file_ids from the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moda-brand-'));
    const path = join(dir, 'kit.json');
    writeFileSync(
      path,
      JSON.stringify({
        name: 'Acme',
        colors: [{ color: '#0F172A' }],
        fonts: [{ family: 'Inter' }],
        logo_file_ids: ['file_2AbCdEfGhJkMnPqRsTuVwX'],
      }),
    );
    expect(readManualKitFile(path)).toEqual({
      name: 'Acme',
      colors: [{ color: '#0F172A' }],
      fonts: [{ family: 'Inter' }],
      logo_file_ids: ['file_2AbCdEfGhJkMnPqRsTuVwX'],
    });
  });

  test('a kit file without a name is a usage error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moda-brand-'));
    const path = join(dir, 'kit.json');
    writeFileSync(path, JSON.stringify({ colors: [{ color: '#fff' }] }));
    expect(() => readManualKitFile(path)).toThrow(CliError);
  });

  test('unreadable / non-JSON file is a usage error, not a crash', () => {
    expect(() => readManualKitFile('/nonexistent/kit.json')).toThrow(CliError);
  });
});
