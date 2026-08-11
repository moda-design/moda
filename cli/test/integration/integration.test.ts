/**
 * Integration scenarios against a real studio stack (cli-repo-plan §5.2). NOT part of the unit
 * lane: every test no-ops unless MODA_API_BASE and MODA_API_KEY are set. Run:
 *
 *   MODA_API_BASE=http://localhost:8000 MODA_API_KEY=moda_live_… \
 *     MODA_BIN=../dist/moda-host bun test cli/test/integration/
 *
 * Spawns the COMPILED binary (channel realism), never ts-node. Scenarios 1–7 cover the
 * deterministic core; scenario 8 (metered media receipt) lands with slice 3 verbs.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const API_BASE = process.env.MODA_API_BASE;
const API_KEY = process.env.MODA_API_KEY;
const BIN = process.env.MODA_BIN ?? resolve(import.meta.dir, '../../../dist/moda-host');
const ENABLED = API_BASE !== undefined && API_KEY !== undefined && existsSync(BIN);

const scratch = mkdtempSync(join(tmpdir(), 'moda-integration-'));

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

async function moda(args: string[], opts: { stdin?: string; expectJson?: boolean } = {}): Promise<RunResult> {
  const proc = Bun.spawn([BIN, ...args, '--json'], {
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      MODA_API_BASE: API_BASE,
      MODA_API_KEY: API_KEY,
      MODA_CONFIG_DIR: join(scratch, 'config'),
      MODA_STATE_DIR: join(scratch, 'state'),
      MODA_NO_UPDATE_CHECK: '1',
    },
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  let json: Record<string, unknown> = {};
  if (opts.expectJson !== false) {
    // stdout purity: exactly one JSON document per invocation.
    json = JSON.parse(stdout) as Record<string, unknown>;
  }
  return { code, stdout, stderr, json };
}

function itg(name: string, fn: () => Promise<void>, timeoutMs = 120_000): void {
  if (!ENABLED) {
    test.skip(`${name} (needs MODA_API_BASE + MODA_API_KEY + compiled binary)`, () => {});
    return;
  }
  test(name, fn, timeoutMs);
}

describe('@integration deterministic core', () => {
  let canvasRef: string | undefined;
  let pageId: string | undefined;

  itg('scenario 1: create → markup append → read (rev A) → edit vs A → read (rev B ≠ A)', async () => {
    const created = await moda(['canvas', 'create', '--name', `cli-itg-${Date.now()}`]);
    expect(created.code).toBe(0);
    const canvas = created.json.canvas as Record<string, unknown> | undefined;
    canvasRef = (canvas?.id as string | undefined) ?? (created.json.canvas_id as string | undefined);
    expect(canvasRef).toBeDefined();
    pageId = (created.json.current_page_id as string | undefined) ?? 'p_a';

    const markup = await moda(['canvas', 'markup', canvasRef as string, '--file', '-', '--page', pageId as string], {
      stdin: '<content><text>Integration hello</text></content>',
    });
    expect(markup.code).toBe(0);
    expect(markup.json.committed).toBe(true);

    const readA = await moda(['canvas', 'read', canvasRef as string]);
    expect(readA.code).toBe(0);
    const revisionA = readA.json.revision as string;
    expect(revisionA).toBeDefined();

    const edit = await moda(['canvas', 'edit', canvasRef as string, '--file', '-'], {
      stdin: 'const t = nodes.find((n) => n.type === "richtext"); if (t) update(t.id, { x: 20 });',
    });
    expect(edit.code).toBe(0);

    const readB = await moda(['canvas', 'read', canvasRef as string]);
    expect(readB.json.revision).not.toBe(revisionA);
  });

  itg('scenario 2: STALE_REVISION interleave — losing writer exits 5 with the current revision', async () => {
    expect(canvasRef).toBeDefined();
    const read = await moda(['canvas', 'read', canvasRef as string]);
    const staleRevision = read.json.revision as string;
    // Winner writes (bumps the revision server-side).
    const winner = await moda(['canvas', 'markup', canvasRef as string, '--file', '-', '--page', pageId as string], {
      stdin: '<content><text>winner</text></content>',
    });
    expect(winner.code).toBe(0);
    // Loser pins the now-stale revision.
    const loser = await moda(
      ['canvas', 'edit', canvasRef as string, '--file', '-', '--revision', staleRevision],
      { stdin: 'print(nodes.length);' },
    );
    expect(loser.code).toBe(5);
    const error = loser.json.error as Record<string, unknown>;
    expect(error.code).toBe('stale_revision');
    // Recovery: re-read then re-apply succeeds.
    await moda(['canvas', 'read', canvasRef as string]);
    const retry = await moda(['canvas', 'edit', canvasRef as string, '--file', '-'], {
      stdin: 'print(nodes.length);',
    });
    expect(retry.code).toBe(0);
  });

  itg('scenario 3: idempotent replay — identical re-run does not double-apply', async () => {
    expect(canvasRef).toBeDefined();
    const read0 = await moda(['canvas', 'read', canvasRef as string]);
    const pinned = read0.json.revision as string;
    const stdin = '<content><text>idempotent-once</text></content>';
    // Pin the revision explicitly so both runs share one idempotency key regardless of cache state.
    // (Mutations never update the CLI's revision cache — only reads do — so the pin is the fence.)
    // The replay contract is per-key: identical (command, canvas, expected_revision, body) → replay.
    const first = await moda(
      ['canvas', 'markup', canvasRef as string, '--file', '-', '--page', pageId as string, '--revision', pinned],
      { stdin },
    );
    expect(first.code).toBe(0);
    expect(first.json.replayed).toBeUndefined();
    const replay = await moda(
      ['canvas', 'markup', canvasRef as string, '--file', '-', '--page', pageId as string, '--revision', pinned],
      { stdin },
    );
    expect(replay.code).toBe(0);
    // Idempotency check runs BEFORE the expected_revision check — the retry replays the stored
    // result instead of failing stale, and nothing is applied twice.
    expect(replay.json.replayed).toBe(true);
    const read = await moda(['canvas', 'read', canvasRef as string]);
    const occurrences = (read.json.state as string | undefined ?? read.stdout).split('idempotent-once').length - 1;
    expect(occurrences).toBe(1);
  });

  itg('scenario 5: requires_repair — markup with a bad image ref exits 0 with the flag set', async () => {
    expect(canvasRef).toBeDefined();
    const result = await moda(['canvas', 'markup', canvasRef as string, '--file', '-', '--page', pageId as string], {
      stdin: '<content><rectangle fill="image(img999)" width="100" height="100"/></content>',
    });
    expect(result.code).toBe(0);
    expect(result.json.requires_repair).toBe(true);
  });

  itg('scenario 6: upload → file_ ref in markup image fill → screenshot has no failed assets', async () => {
    expect(canvasRef).toBeDefined();
    const png = join(scratch, 'pixel.png');
    // 1x1 transparent PNG.
    await Bun.write(
      png,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const uploaded = await moda(['file', 'upload', png]);
    expect(uploaded.code).toBe(0);
    const uploads = uploaded.json.uploads as Array<Record<string, unknown>>;
    const fileRef = (uploads[0]?.markup_ref ?? uploads[0]?.file_id) as string | undefined;
    expect(fileRef).toBeDefined();
    const markup = await moda(['canvas', 'markup', canvasRef as string, '--file', '-', '--page', pageId as string], {
      stdin: `<content><rectangle fill="image(${fileRef})" width="200" height="200"/></content>`,
    });
    expect(markup.code).toBe(0);
    const shot = await moda(['canvas', 'screenshot', canvasRef as string, '-o', join(scratch, 'shot.png')]);
    expect(shot.code).toBe(0);
    expect(JSON.stringify(shot.json)).not.toContain('failedAssets');
  });

  itg(
    'scenario 7: export pdf + pptx with metered_credits 0',
    async () => {
      expect(canvasRef).toBeDefined();
      for (const format of ['pdf', 'pptx'] as const) {
        const out = join(scratch, `out.${format}`);
        const result = await moda(['export', canvasRef as string, '--format', format, '-o', out]);
        expect(result.code).toBe(0);
        const usage = result.json.usage as Record<string, unknown>;
        expect(usage.metered_credits).toBe(0);
        expect(existsSync(out)).toBe(true);
      }
    },
    600_000,
  );

  // Scenario 4 (busy-canvas 5/15/30 backoff) needs a long-held lock — run manually alongside a
  // long screenshot; asserted in the unit lane against the mock server (client.test.ts).
});
