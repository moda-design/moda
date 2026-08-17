/**
 * The closed-loop video lane (studio PR #9603): `moda media video-frames`, background renders
 * (`moda media generate-video --no-wait`), and the poll that collects them
 * (`moda task status --wait`).
 *
 * What these pin is the seam, not the decoder: the frame read is a FREE read whose bytes come
 * back inline, and the background lane's whole safety story is that the CLI never sends `wait`
 * unless it was asked for (`extra="forbid"` on GenerateVideoRequest — an unconditional
 * `wait: true` would 422 every generate call against a server predating the field), and never
 * lets a remote URL into a render whose collection re-resolves its inputs minutes later.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const MAIN = resolve(import.meta.dir, '../src/main.ts');

let server: ReturnType<typeof Bun.serve> | undefined;

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

/** Route by path so one server can serve a start, a poll, and a frame read in the same run. */
function route(handler: (call: Call, index: number) => { status?: number; body: unknown }): {
  base: string;
  calls: Call[];
} {
  const calls: Call[] = [];
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const call: Call = {
        method: req.method,
        path: url.pathname,
        body: (await req.json().catch(() => ({}))) as Record<string, unknown>,
      };
      calls.push(call);
      const answer = handler(call, calls.length - 1);
      return Response.json(answer.body, { status: answer.status ?? 200 });
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, calls };
}

async function runCli(args: string[], base: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const scratch = mkdtempSync(join(tmpdir(), 'moda-video-verify-'));
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      MODA_NO_UPDATE_CHECK: '1',
      MODA_CONFIG_DIR: join(scratch, 'config'),
      MODA_STATE_DIR: join(scratch, 'state'),
      MODA_API_KEY: 'moda_live_testkey000000',
      MODA_API_BASE: base,
    },
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

const FILE_REF = 'file_01HZX9K2ABCDEFGHJKMNPQRSTV';
const TASK_REF = 'task_01HT9WK8N3M2J4A5Z6P7Q8R9TV';

/** A 1x1 JPEG — real magic bytes, so the writer's format sniffing is exercised for real. */
const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

function frame(timestampMs: number): Record<string, unknown> {
  return {
    timestamp_ms: timestampMs,
    mime_type: 'image/jpeg',
    size_bytes: 631,
    data_url: `data:image/jpeg;base64,${JPEG_BASE64}`,
  };
}

/** The /v1/media/video-frames 200 shape, verbatim from the #9603 router. */
function framesEnvelope(frames: Record<string, unknown>[], warnings: unknown[] = []): Record<string, unknown> {
  return {
    operation: 'media.video_frames',
    video: {
      id: FILE_REF,
      uuid: '0189a7b2-0000-7000-8000-000000000000',
      name: 'stinger.mp4',
      mime_type: 'video/mp4',
      duration_ms: 6000,
      width: 1280,
      height: 720,
      has_audio: true,
    },
    frames,
    warnings,
    usage: { class: 'deterministic', metered_credits: 0, managed_inference_tokens: 0 },
  };
}

describe('moda media video-frames — the verify lane', () => {
  test('reads a team video and reports duration, dimensions, audio, and the sampled moments', async () => {
    const { base, calls } = route(() => ({ body: framesEnvelope([frame(0), frame(2500), frame(5900)]) }));
    const { code, stdout } = await runCli(['media', 'video-frames', FILE_REF], base);

    expect(code).toBe(0);
    expect(calls[0]?.path).toBe('/v1/media/video-frames');
    // The wire field is `video` (the connector tool's argument name, and `upscale-video`'s) and
    // it takes the ref verbatim — no count when none was asked for.
    expect(calls[0]?.body).toEqual({ video: FILE_REF });
    expect(stdout).toContain('3 frame(s)');
    expect(stdout).toContain('6.0s');
    expect(stdout).toContain('1280x720');
    expect(stdout).toContain('audio: yes');
    // Free by contract (usage.class deterministic) — never announce a charge for a read.
    expect(stdout).toContain('(free)');
    // The moments are what a follow-up --timestamps ask is written off.
    expect(stdout).toContain('frames at: 0.0s, 2.5s, 5.9s');
  });

  test('-o writes the frames to disk, timestamp-named so they sort in clip order', async () => {
    const { base } = route(() => ({ body: framesEnvelope([frame(0), frame(2500), frame(11250)]) }));
    const dir = join(mkdtempSync(join(tmpdir(), 'moda-frames-')), 'frames');
    const { code, stdout } = await runCli(['media', 'video-frames', FILE_REF, '-o', dir], base);

    expect(code).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(['000000ms.jpg', '002500ms.jpg', '011250ms.jpg']);
    // Real decoded bytes, not the data-URL text.
    expect(readFileSync(join(dir, '000000ms.jpg')).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(stdout).toContain(join(dir, '002500ms.jpg'));
  });

  test('without -o it says where to send the bytes — a summary line is not a look', async () => {
    const { base } = route(() => ({ body: framesEnvelope([frame(0)]) }));
    const { code, stdout } = await runCli(['media', 'video-frames', FILE_REF], base);
    expect(code).toBe(0);
    expect(stdout).toContain('-o DIR');
  });

  test('a single frame with -o honors the path as a FILE (the screenshot lane rule)', async () => {
    const { base } = route(() => ({ body: framesEnvelope([frame(1500)]) }));
    const out = join(mkdtempSync(join(tmpdir(), 'moda-frames-')), 'one.jpg');
    const { code } = await runCli(['media', 'video-frames', FILE_REF, '-o', out], base);
    expect(code).toBe(0);
    expect(readFileSync(out).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  test('--count travels as count; --timestamps travels as timestamps_ms', async () => {
    const { base, calls } = route(() => ({ body: framesEnvelope([frame(0)]) }));
    expect((await runCli(['media', 'video-frames', FILE_REF, '--count', '6'], base)).code).toBe(0);
    expect(calls[0]?.body).toEqual({ video: FILE_REF, count: 6 });

    const second = route(() => ({ body: framesEnvelope([frame(0)]) }));
    expect((await runCli(['media', 'video-frames', FILE_REF, '--timestamps', '0', '2500'], second.base)).code).toBe(0);
    expect(second.calls[0]?.body).toEqual({ video: FILE_REF, timestamps_ms: [0, 2500] });
  });

  test('--count with --timestamps is refused locally — the server rejects the pair, so never spend the trip', async () => {
    const { base, calls } = route(() => ({ body: framesEnvelope([frame(0)]) }));
    const { code, stderr } = await runCli(
      ['media', 'video-frames', FILE_REF, '--count', '4', '--timestamps', '0'],
      base,
    );
    expect(code).toBe(2);
    expect(stderr).toContain('not both');
    expect(calls).toHaveLength(0);
  });

  test('a remote URL is refused locally with the upload-first fix (the read lane takes team files only)', async () => {
    const { base, calls } = route(() => ({ body: framesEnvelope([frame(0)]) }));
    const { code, stderr } = await runCli(['media', 'video-frames', 'https://example.test/clip.mp4'], base);
    expect(code).toBe(2);
    expect(stderr).toContain('team files only');
    expect(stderr).toContain('moda file upload');
    expect(calls).toHaveLength(0);
  });

  test('an empty strip is a WARNING, not a failure — "we could not look", never "the video is bad"', async () => {
    const { base } = route(() => ({
      body: framesEnvelope(
        [],
        [{ code: 'no_frames_decoded', message: 'No frames could be decoded from this video.' }],
      ),
    }));
    const { code, stdout } = await runCli(['media', 'video-frames', FILE_REF], base);
    // Exit 0: a caller that treats this as a failed render regenerates a perfectly good clip.
    expect(code).toBe(0);
    expect(stdout).toContain('0 frame(s)');
    expect(stdout).toContain('warning: No frames could be decoded');
  });

  test('a PARTIAL strip carries the server warning verbatim rather than reading as a clean look', async () => {
    const { base } = route(() => ({
      body: framesEnvelope(
        [frame(0), frame(5900)],
        [{ code: 'frames_partial', message: 'Only 2 of 4 frames could be decoded, so this is a PARTIAL view.' }],
      ),
    }));
    const { stdout } = await runCli(['media', 'video-frames', FILE_REF], base);
    expect(stdout).toContain('warning: Only 2 of 4 frames could be decoded');
  });

  test('a server predating the route says so instead of leaking a bare 404', async () => {
    const { base } = route(() => ({ status: 404, body: { detail: 'Not Found' } }));
    const { code, stderr } = await runCli(['media', 'video-frames', FILE_REF], base);
    expect(code).toBe(4);
    expect(stderr).toContain('predates the video-frames endpoint');
  });
});

const VIDEO_RESULT = {
  operation: 'media.generate-video',
  result: { id: FILE_REF, url: 'https://example.test/clip.mp4' },
  usage: { class: 'metered' },
};

const QUEUED = {
  operation: 'media.generate-video',
  task_id: TASK_REF,
  status: 'queued',
  poll_url: `/v1/media/generate-video/${TASK_REF}`,
  committed: true,
  retry_after_ms: 5000,
  applied: { duration_seconds: 4 },
  adjustments: [],
  usage: { class: 'metered' },
};

describe('moda media generate-video --no-wait — the background lane', () => {
  test('a normal (waiting) call never sends `wait` at all — the request model forbids extras', async () => {
    const { base, calls } = route(() => ({ body: VIDEO_RESULT }));
    const { code } = await runCli(
      ['media', 'generate-video', '--prompt', 'a slow orbit', '--model', 'veo-3.1-lite', '--duration', '4'],
      base,
    );
    expect(code).toBe(0);
    // Sending `wait: true` would 422 against every server that predates #9603, for no gain:
    // true is already the default.
    expect(calls[0]?.body).not.toHaveProperty('wait');
  });

  test('--no-wait sends wait:false and hands back the task handle plus how to collect it', async () => {
    const { base, calls } = route(() => ({ body: QUEUED }));
    const { code, stdout } = await runCli(
      ['media', 'generate-video', '--prompt', 'a slow orbit', '--model', 'veo-3.1-lite', '--duration', '4', '--no-wait'],
      base,
    );
    expect(code).toBe(0);
    expect(calls[0]?.body.wait).toBe(false);
    expect(stdout).toContain(TASK_REF);
    expect(stdout).toContain('nothing charged yet');
    expect(stdout).toContain(`moda task status ${TASK_REF} --wait`);
  });

  test('--no-wait refuses remote-URL inputs locally — a collection re-resolves them minutes later', async () => {
    const { base, calls } = route(() => ({ body: QUEUED }));
    const { code, stderr } = await runCli(
      [
        'media', 'generate-video', '--prompt', 'a slow orbit', '--model', 'veo-3.1-lite',
        '--image', 'https://example.test/frame.png', '--no-wait',
      ],
      base,
    );
    expect(code).toBe(2);
    expect(stderr).toContain('durable inputs only');
    // Nothing was submitted: a provider job with no collectible inputs must never be started.
    expect(calls).toHaveLength(0);
  });

  test('--no-wait allows file_ refs (the durable form the server requires)', async () => {
    const { base, calls } = route(() => ({ body: QUEUED }));
    const { code } = await runCli(
      [
        'media', 'generate-video', '--prompt', 'a slow orbit', '--model', 'veo-3.1-lite',
        '--image', FILE_REF, '--no-wait',
      ],
      base,
    );
    expect(code).toBe(0);
    expect(calls[0]?.body.start_image).toBe(FILE_REF);
  });

  test('a server predating the background lane is named as such, not left as a raw 422', async () => {
    const { base } = route(() => ({
      status: 422,
      body: { error: { type: 'unprocessable', code: 'invalid_request', message: "Extra inputs are not permitted: wait" } },
    }));
    const { code, stderr } = await runCli(
      ['media', 'generate-video', '--prompt', 'a slow orbit', '--model', 'veo-3.1-lite', '--no-wait'],
      base,
    );
    expect(code).toBe(2);
    expect(stderr).toContain('predates background video renders');
  });

  test('an unrelated 422 keeps its own message — the hint is not sprayed on every rejection', async () => {
    const { base } = route(() => ({
      status: 422,
      body: { error: { type: 'unprocessable', code: 'invalid_media_request', message: 'duration_seconds 99 is out of range.' } },
    }));
    const { stderr } = await runCli(
      ['media', 'generate-video', '--prompt', 'a slow orbit', '--model', 'veo-3.1-lite', '--duration', '99', '--no-wait'],
      base,
    );
    expect(stderr).toContain('out of range');
    expect(stderr).not.toContain('predates background video renders');
  });
});

describe('moda task status — one handle, both lanes', () => {
  test('a task_ id the design lane does not know is polled on the media lane instead', async () => {
    const { base, calls } = route((call, index) => {
      if (call.path.startsWith('/v1/tasks/')) {
        return { status: 404, body: { error: { type: 'not_found', code: 'not_found', message: 'No such task.' } } };
      }
      // Server-paced backoff: the loop sleeps for the envelope's own retry_after_ms hint.
      if (index === 1) return { body: { ...QUEUED, status: 'running', retry_after_ms: 25 } };
      return {
        body: {
          ...QUEUED,
          status: 'succeeded',
          retry_after_ms: null,
          result: { id: FILE_REF, url: 'https://example.test/clip.mp4', width: 1280, height: 720 },
          resumed_provider_job: false,
        },
      };
    });
    const { code, stdout } = await runCli(['task', 'status', TASK_REF, '--wait', '--timeout', '30'], base);

    expect(code).toBe(0);
    // Design lane first (its 404 is the router), then the media lane's own poll endpoint.
    expect(calls[0]?.path).toBe(`/v1/tasks/${TASK_REF}`);
    expect(calls[1]?.path).toBe(`/v1/media/generate-video/${TASK_REF}`);
    expect(calls.at(-1)?.path).toBe(`/v1/media/generate-video/${TASK_REF}`);
    expect(stdout).toContain('succeeded');
    expect(stdout).toContain(FILE_REF);
  });

  test('a terminal FAILED render stops the poll and names the provider error', async () => {
    const { base } = route((call) => {
      if (call.path.startsWith('/v1/tasks/')) {
        return { status: 404, body: { error: { type: 'not_found', code: 'not_found', message: 'No such task.' } } };
      }
      return {
        body: {
          ...QUEUED,
          status: 'failed',
          retry_after_ms: null,
          error: { message: 'The provider reported this render as failed.', retryable: true },
        },
      };
    });
    const { code, stdout } = await runCli(['task', 'status', TASK_REF, '--wait', '--timeout', '30'], base);
    // Exit 0: this verb reports a status, it does not adjudicate one (the flag help says so).
    expect(code).toBe(0);
    expect(stdout).toContain('failed');
    expect(stdout).toContain('The provider reported this render as failed.');
  });

  test('an id neither lane knows keeps the design lane’s typed not-found', async () => {
    const { base } = route(() => ({
      status: 404,
      body: { error: { type: 'not_found', code: 'not_found', message: 'No such task.' } },
    }));
    const { code, stderr } = await runCli(['task', 'status', TASK_REF], base);
    expect(code).toBe(4);
    expect(stderr).toContain('No such task.');
  });

  test('a design task still answers on the design lane, with no extra media call', async () => {
    const { base, calls } = route(() => ({ body: { id: TASK_REF, status: 'succeeded', usage: { class: 'metered' } } }));
    const { code } = await runCli(['task', 'status', TASK_REF], base);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(`/v1/tasks/${TASK_REF}`);
  });
});
