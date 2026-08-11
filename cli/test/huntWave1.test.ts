/**
 * Defect-hunt wave 1: crdt-corrupt retryability (status-agnostic terminal codes), export
 * delivered-format truth (multi-page raster = zip), terminal export failures, and per-page
 * default filenames.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from '../src/api/client.ts';
import { apiErrorFromResponse } from '../src/api/errors.ts';
import { CliError } from '../src/cliError.ts';
import { performExport } from '../src/commands/export.ts';
import type { Invocation } from '../src/commands/runtime.ts';

let server: ReturnType<typeof Bun.serve> | undefined;

function serve(handler: (req: Request, hits: number) => Response | Promise<Response>): { base: string } {
  let hits = 0;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => {
      hits += 1;
      return handler(req, hits);
    },
  });
  return { base: `http://127.0.0.1:${server.port}` };
}

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function client(base: string): ApiClient {
  return new ApiClient({
    apiBase: base,
    apiKey: 'moda_live_testkey000000',
    busyBackoffMs: [5, 10, 15],
    sleeper: async () => {},
    env: { MODA_STATE_DIR: '/tmp/moda-hunt-test-state' },
  });
}

function fakeInv(base: string, outDir: string): Invocation {
  return {
    flags: { json: true, pretty: false, quiet: true, noInput: true, noRetry: false },
    context: { apiBase: { value: base }, org: { value: undefined }, outputDir: { value: outDir } },
    env: {},
    emitOpts: { json: true, quiet: true },
    note: () => {},
  } as unknown as Invocation;
}

const CVS = 'cvs_01HZX9K2ABCDEFGHJKMNPQRSTV';

describe('canvas_crdt_state_corrupt is terminal (golden)', () => {
  test('409 conflict carrying the code maps to retryable:false with the recovery hint', () => {
    const err = apiErrorFromResponse(
      409,
      { error: { type: 'conflict', code: 'canvas_crdt_state_corrupt', message: 'Document state is corrupt.' } },
      'req_9',
    );
    expect(err.fields.retryable).toBe(false);
    expect(err.fields.hint).toBe('canvas needs recovery — retrying cannot succeed');
    // Ordinary conflicts stay retryable — the set is code-scoped, not type-scoped.
    const busy = apiErrorFromResponse(409, { error: { type: 'conflict', code: 'canvas_busy', message: 'busy' } }, 'r');
    expect(busy.fields.retryable).toBe(true);
  });

  test('the client surfaces it immediately — no busy-retry burn', async () => {
    let hits = 0;
    const { base } = serve(() => {
      hits += 1;
      return new Response(
        JSON.stringify({ error: { type: 'conflict', code: 'canvas_crdt_state_corrupt', message: 'corrupt' } }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      );
    });
    await expect(client(base).request({ method: 'POST', path: '/v1/x', body: {} })).rejects.toThrow(CliError);
    expect(hits).toBe(1);
  });
});

describe('export delivered-format truth (zip-as-png defect)', () => {
  test('multi-page png delivers zip: .zip filename, delivered_format in JSON, human mismatch line', async () => {
    const { base } = serve((req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/export')) {
        return Response.json({ task_id: 'exp_1', status: 'completed', format: 'zip', download_url: '/dl/exp_1' });
      }
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 200 });
    });
    const outDir = mkdtempSync(join(tmpdir(), 'moda-export-zip-'));
    const outcome = await performExport(client(base), fakeInv(base, outDir), CVS, { format: 'png', wait: true });
    const body = outcome.body as Record<string, unknown>;
    expect(body.requested_format).toBe('png');
    expect(body.delivered_format).toBe('zip');
    expect(String(body.output)).toEndWith('.zip');
    expect(readdirSync(outDir)).toEqual([`${CVS}.zip`]);
    const lines: string[] = [];
    outcome.human?.((line) => lines.push(line));
    expect(lines[0]).toContain('requested png, delivered zip');
  });

  test('single-format export keeps the requested extension and formats agree', async () => {
    const { base } = serve((req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/export')) {
        return Response.json({ task_id: 'exp_2', status: 'completed', format: 'pdf', download_url: '/dl/exp_2' });
      }
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 });
    });
    const outDir = mkdtempSync(join(tmpdir(), 'moda-export-pdf-'));
    const outcome = await performExport(client(base), fakeInv(base, outDir), CVS, { format: 'pdf', wait: true });
    const body = outcome.body as Record<string, unknown>;
    expect(body.delivered_format).toBe('pdf');
    expect(String(body.output)).toEndWith('.pdf');
  });

  test('--page default filename carries the page number (no per-page clobber)', async () => {
    const { base } = serve((req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/export')) {
        expect(url.searchParams.get('page_number')).toBe('3');
        return Response.json({ task_id: 'exp_3', status: 'completed', format: 'png', download_url: '/dl/exp_3' });
      }
      return new Response(new Uint8Array([0x89, 0x50]), { status: 200 });
    });
    const outDir = mkdtempSync(join(tmpdir(), 'moda-export-page-'));
    const outcome = await performExport(client(base), fakeInv(base, outDir), CVS, {
      format: 'png',
      pageNumber: 3,
      wait: true,
    });
    expect(String((outcome.body as Record<string, unknown>).output)).toEndWith(`${CVS}.p3.png`);
  });

  test('a failed poll status is terminal: retryable false + the deliver-instead hint', async () => {
    const { base } = serve((req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/export')) {
        return Response.json({ task_id: 'exp_4', status: 'in_progress' });
      }
      return Response.json({ task_id: 'exp_4', status: 'failed', error: 'render blew up' });
    });
    const outDir = mkdtempSync(join(tmpdir(), 'moda-export-fail-'));
    try {
      await performExport(client(base), fakeInv(base, outDir), CVS, { format: 'pdf', wait: true });
      expect.unreachable();
    } catch (err) {
      const fields = (err as CliError).fields;
      expect(fields.code).toBe('export_failed');
      expect(fields.retryable).toBe(false);
      expect(fields.hint).toContain('do not retry');
      expect(fields.hint).toContain('share link');
    }
  });
});
