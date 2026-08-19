/**
 * The hand-off signal (ENG-5160): `moda canvas open` and a completed
 * `moda export` tell the server the agent is done with the canvas, so the
 * reader stops being told "your agent is working" minutes after it stopped.
 *
 * The properties worth pinning are the failure ones. This rides verbs that have
 * already delivered something — a browser launch, a file on disk — so it must
 * never be able to fail them, and it must not fire where the caller is not the
 * agent (a share link) or where the work is not finished (`--no-wait`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ApiClient } from '../src/api/client.ts';
import { performCanvasOpen } from '../src/commands/canvas.ts';
import type { OpenLaneContext } from '../src/commands/open.ts';
import { toWireId } from '../src/refs.ts';

const UUID = '018f3c6e-1234-4abc-9def-00112233aabb';
const CVS = toWireId('canvas', UUID);
const APP_BASE = 'https://moda.app';
const DONE_PATH = `/v1/canvases/${CVS}/agent-activity/done`;

let server: ReturnType<typeof Bun.serve> | undefined;

function serve(respond: (req: Request, url: URL) => Response): { base: string; paths: string[] } {
  const paths: string[] = [];
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      paths.push(`${req.method} ${url.pathname}`);
      return respond(req, url);
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, paths };
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
    env: { MODA_STATE_DIR: '/tmp/moda-handoff-test-state' },
  });
}

function ctx(): OpenLaneContext {
  return { appBase: APP_BASE, env: {}, note: () => {}, launch: async () => true };
}

function json(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('canvas open signals the hand-off', () => {
  test('posts the done signal for the canvas it opened', async () => {
    const { base, paths } = serve(() => json({ canvas_id: CVS, canvas_url: `${APP_BASE}/canvas/${UUID}` }));
    const outcome = await performCanvasOpen(client(base), ctx(), CVS);
    expect(outcome.exitCode).toBe(0);
    expect(paths).toContain(`POST ${DONE_PATH}`);
  });

  test('a failing signal never fails the open — the user still gets their canvas', async () => {
    // Older servers 404 this route; a broken one 500s. Both are non-events: the
    // cost is a working-state indicator that lingers until its own deadline.
    const { base } = serve((req, url) =>
      url.pathname.endsWith('/agent-activity/done')
        ? new Response('nope', { status: 500 })
        : json({ canvas_id: CVS, canvas_url: `${APP_BASE}/canvas/${UUID}` }),
    );
    const outcome = await performCanvasOpen(client(base), ctx(), CVS);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.body.url).toBe(`${APP_BASE}/canvas/${UUID}`);
  });

  test('a share link signals nothing — no read, and the opener is usually not the agent', async () => {
    const { base, paths } = serve(() => json({}));
    const outcome = await performCanvasOpen(client(base), ctx(), `${APP_BASE}/s/tok123`);
    expect(outcome.exitCode).toBe(0);
    expect(paths).toEqual([]);
  });
});
