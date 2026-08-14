/**
 * `moda media models` — the human lane must render the SAME model set the JSON lane carries.
 * Regression for the cold-gate F4 defect: the server envelope is
 * `{image_models: [descriptor…], video_models: [descriptor…], video_model_ids: [id…]}`
 * (backend media router), but the plain formatter printed "no models reported" while --json
 * listed everything — which steered real runs into declaring imagery unavailable and skipping
 * the workflow step. The verb is a complete one-document capability registry, NOT a paginated
 * list: no page note, ever. `video_models` capability cards arrive with studio PR #9438; a
 * server that predates them sends only `video_model_ids`, which must render exactly the bare
 * id line (a bare-id render once steered a model choice onto unverifiable world knowledge —
 * the cards exist so the choice reads from the registry).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ApiClient } from '../src/api/client.ts';
import { performMediaModels } from '../src/commands/media.ts';

const MAIN = resolve(import.meta.dir, '../src/main.ts');

let server: ReturnType<typeof Bun.serve> | undefined;

function serve(body: unknown): { base: string } {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json(body),
  });
  return { base: `http://127.0.0.1:${server.port}` };
}

/** Capture the outbound JSON body of a one-shot media call driven through the real program. */
function captureBody(response: unknown): { base: string; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      calls.push((await req.json().catch(() => ({}))) as Record<string, unknown>);
      return Response.json(response);
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, calls };
}

async function runCli(args: string[], base: string): Promise<number> {
  const scratch = mkdtempSync(join(tmpdir(), 'moda-media-cli-'));
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
  const [code] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return code;
}

/** Minimal generate-video success envelope — enough for the CLI to render an outcome. */
const VIDEO_RESULT = {
  operation: 'media.generate_video',
  result: { file_id: 'file_01HZX9K2ABCDEFGHJKMNPQRSTV', url: 'https://example.test/clip.mp4' },
  usage: { credits: 1 },
};

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function client(base: string): ApiClient {
  return new ApiClient({
    apiBase: base,
    apiKey: 'moda_live_testkey000000',
    sleeper: async () => {},
    env: { MODA_STATE_DIR: '/tmp/moda-media-test' },
  });
}

function humanLines(outcome: { human?: (write: (line: string) => void) => void }): string[] {
  const lines: string[] = [];
  outcome.human?.((line) => lines.push(line));
  return lines;
}

/** Trimmed copy of the real /v1/media/models envelope observed in the 2026-08-12 gate runs. */
const MODELS_ENVELOPE = {
  image_models: [
    {
      id: 'nano-banana',
      label: 'NanoBanana 2',
      description: 'Fast, low-cost baseline (Gemini 3.1 Flash Lite Image).',
      provider: 'gemini',
      aspect_ratios: ['auto', '1:1', '16:9', '9:16'],
      default_aspect_ratio: 'auto',
      resolutions: [],
      default_resolution: null,
      accepts_reference_images: true,
      max_reference_images: 3,
      max_num_images: 4,
      controls: [],
    },
    {
      id: 'nano-banana-pro',
      label: 'NanoBanana 2 Pro',
      description: 'Hi-res Gemini path for higher-fidelity output.',
      provider: 'gemini',
      aspect_ratios: ['auto', '1:1', '16:9'],
      resolutions: [
        { id: '1K', label: '1K' },
        { id: '2K', label: '2K' },
        { id: '4K', label: '4K' },
      ],
      default_resolution: '1K',
      accepts_reference_images: true,
      max_reference_images: 3,
      controls: [],
    },
    {
      id: 'gpt-image-2',
      label: 'GPT Image 2.0',
      provider: 'fal',
      aspect_ratios: ['auto', '1:1'],
      resolutions: [],
      accepts_reference_images: true,
      controls: [{ id: 'quality', label: 'Quality', type: 'select' }],
    },
  ],
  video_model_ids: ['gemini-omni-flash', 'seedance-2.5', 'veo-3.1', 'veo-3.1-fast'],
};

/**
 * The studio PR #9438 `video_models[]` shape (PublicVideoModelDescriptor,
 * backend/app/services/agents/omni_agent/tools/media/video_registry.py) — every field the
 * projection serializes, with the registry's real envelopes: Veo's enumerated durations and
 * tiered 4k/audio billing, Seedance's auto duration, aspect-control-free image mode, and
 * billed reference videos.
 */
const VEO_CARD = {
    id: 'veo-3.1',
    label: 'Veo 3.1',
    description: 'Cinematic realism and camera language; fixed clip lengths.',
    supports_generate_audio: true,
    generate_audio_default: true,
    supports_seed: true,
    modes: {
      text_to_video: {
        aspect_ratios: ['16:9', '9:16'],
        default_aspect_ratio: '16:9',
        resolutions: ['720p', '1080p', '4k'],
        default_resolution: '720p',
        duration_seconds: { min_seconds: 4, max_seconds: 8, allowed_seconds: [4, 6, 8], default: 8, supports_auto: false },
        supports_end_image: false,
        max_reference_images: 0,
        reference_videos: null,
        billing: { basis: 'second', audio_priced_separately: true, higher_rate_resolutions: ['4k'] },
      },
      image_to_video: {
        aspect_ratios: ['auto', '16:9', '9:16'],
        default_aspect_ratio: 'auto',
        resolutions: ['720p', '1080p'],
        default_resolution: '720p',
        duration_seconds: { min_seconds: 4, max_seconds: 8, allowed_seconds: [4, 6, 8], default: 8, supports_auto: false },
        supports_end_image: true,
        max_reference_images: 0,
        reference_videos: null,
        billing: { basis: 'second', audio_priced_separately: true, higher_rate_resolutions: [] },
      },
      reference_to_video: null,
    },
    model_params: [
      { id: 'negative_prompt', description: 'What to avoid.', type: 'string', allowed_values: null, minimum: null, maximum: null, modes: null },
      { id: 'safety_tolerance', description: 'Filter strictness.', type: 'integer', allowed_values: null, minimum: 1, maximum: 6, modes: null },
    ],
};

const SEEDANCE_CARD = {
    id: 'seedance-2.5',
    label: 'Seedance 2.5',
    description: 'Long-form single-shot clips and large reference boards.',
    supports_generate_audio: true,
    generate_audio_default: true,
    supports_seed: false,
    modes: {
      text_to_video: {
        aspect_ratios: ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
        default_aspect_ratio: 'auto',
        resolutions: ['480p', '720p'],
        default_resolution: '720p',
        duration_seconds: { min_seconds: 4, max_seconds: 30, allowed_seconds: null, default: 'auto', supports_auto: true },
        supports_end_image: false,
        max_reference_images: 0,
        reference_videos: null,
        billing: { basis: 'megapixel_second', audio_priced_separately: false, higher_rate_resolutions: [] },
      },
      image_to_video: {
        // No aspect control at all in this mode — the framing follows the input image.
        aspect_ratios: [],
        default_aspect_ratio: null,
        resolutions: ['480p', '720p'],
        default_resolution: '720p',
        duration_seconds: { min_seconds: 4, max_seconds: 30, allowed_seconds: null, default: 'auto', supports_auto: true },
        supports_end_image: true,
        max_reference_images: 0,
        reference_videos: null,
        billing: { basis: 'megapixel_second', audio_priced_separately: false, higher_rate_resolutions: [] },
      },
      reference_to_video: {
        aspect_ratios: ['auto', '16:9'],
        default_aspect_ratio: 'auto',
        resolutions: ['480p', '720p'],
        default_resolution: '720p',
        duration_seconds: { min_seconds: 4, max_seconds: 30, allowed_seconds: null, default: 'auto', supports_auto: true },
        supports_end_image: false,
        max_reference_images: 30,
        reference_videos: {
          max_count: 1,
          min_seconds_each: 2,
          max_seconds_each: 30,
          max_total_seconds: 30,
          input_duration_billed: true,
          price_multiplier: 1.4,
        },
        billing: { basis: 'megapixel_second', audio_priced_separately: false, higher_rate_resolutions: [] },
      },
    },
    model_params: [],
};

const VIDEO_MODELS = [VEO_CARD, SEEDANCE_CARD];

const ENRICHED_ENVELOPE = {
  ...MODELS_ENVELOPE,
  video_models: VIDEO_MODELS,
  video_model_ids: ['veo-3.1', 'seedance-2.5'],
};

describe('media models — human/JSON model-set parity (gate finding F4)', () => {
  test('human lane renders every model id the JSON lane carries — and NOTHING extra (no page note)', async () => {
    const { base } = serve(MODELS_ENVELOPE);
    const outcome = await performMediaModels(client(base));

    const body = outcome.body as Record<string, unknown>;
    const jsonImageIds = (body.image_models as Array<Record<string, unknown>>).map((m) => m.id as string);
    const jsonVideoIds = body.video_model_ids as string[];
    expect(jsonImageIds).toEqual(['nano-banana', 'nano-banana-pro', 'gpt-image-2']);
    expect(jsonVideoIds).toEqual(MODELS_ENVELOPE.video_model_ids);

    const lines = humanLines(outcome);
    // Exactly one line per image model + one video-ids line: a full registry read must never
    // suggest truncation or pagination.
    expect(lines).toHaveLength(jsonImageIds.length + 1);
    expect(lines.join('\n')).not.toContain('no models reported');
    expect(lines.join('\n')).not.toContain('showing');
    for (const [i, id] of jsonImageIds.entries()) {
      expect(lines[i]).toStartWith(id);
    }
    expect(lines.at(-1)).toBe('video models: gemini-omni-flash, seedance-2.5, veo-3.1, veo-3.1-fast');
  });

  test('capability lines carry the axes the skills defer to (aspect ratios, res tiers, refs, image cap, params)', async () => {
    const { base } = serve(MODELS_ENVELOPE);
    const lines = humanLines(await performMediaModels(client(base)));

    const nano = lines.find((l) => l.startsWith('nano-banana '));
    expect(nano).toContain('NanoBanana 2');
    expect(nano).toContain('ar auto,1:1,16:9,9:16');
    expect(nano).toContain('refs max 3');
    expect(nano).toContain('imgs max 4');
    expect(nano).toContain('Fast, low-cost baseline');

    const pro = lines.find((l) => l.startsWith('nano-banana-pro'));
    expect(pro).toContain('res 1K,2K,4K');

    const gpt = lines.find((l) => l.startsWith('gpt-image-2'));
    expect(gpt).toContain('params quality');
  });

  test('resolutions/controls tolerate bare-string entries (the envelope already mixes shapes)', async () => {
    const { base } = serve({
      image_models: [
        { id: 'm1', label: 'M1', resolutions: ['1K', '2K'], controls: ['quality'] },
      ],
      video_model_ids: [],
    });
    const lines = humanLines(await performMediaModels(client(base)));
    expect(lines).toEqual(['m1 — M1  [res 1K,2K; params quality]']);
  });

  test('an empty-string description leaves no trailing junk', async () => {
    const { base } = serve({ image_models: [{ id: 'm1', label: 'M1', description: '' }], video_model_ids: [] });
    const lines = humanLines(await performMediaModels(client(base)));
    expect(lines).toEqual(['m1 — M1']);
  });

  test('a genuinely empty registry still says so', async () => {
    const { base } = serve({ image_models: [], video_model_ids: [] });
    const lines = humanLines(await performMediaModels(client(base)));
    expect(lines).toEqual(['no models reported']);
  });

  test('video-only envelope renders exactly the video line — no empty hint, no contradiction', async () => {
    const { base } = serve({ image_models: [], video_model_ids: ['veo-3.1'] });
    const lines = humanLines(await performMediaModels(client(base)));
    expect(lines).toEqual(['video models: veo-3.1']);
  });

  test('video_models renders one pinned capability card per model — and drops the bare id line', async () => {
    const { base } = serve(ENRICHED_ENVELOPE);
    const lines = humanLines(await performMediaModels(client(base)));
    const videoLines = lines.slice(MODELS_ENVELOPE.image_models.length);
    expect(videoLines).toEqual([
      'veo-3.1 — Veo 3.1  [audio yes (on by default); seed]  Cinematic realism and camera language; fixed clip lengths.',
      '  text→video: 4/6/8s (default 8s); ar 16:9,9:16 (default 16:9); res 720p,1080p,4k (default 720p); ' +
        'priced per second; audio billed separately; higher rate at 4k',
      '  image→video: 4/6/8s (default 8s); ar auto,16:9,9:16 (default auto); res 720p,1080p (default 720p); ' +
        'end image ok; priced per second; audio billed separately',
      '  params (--model-params): negative_prompt, safety_tolerance',
      'seedance-2.5 — Seedance 2.5  [audio yes (on by default)]  Long-form single-shot clips and large reference boards.',
      '  text→video: 4–30s (default auto); ar auto,21:9,16:9,4:3,1:1,3:4,9:16 (default auto); ' +
        'res 480p,720p (default 720p); priced by resolution × duration',
      '  image→video: 4–30s (default auto); res 480p,720p (default 720p); end image ok; priced by resolution × duration',
      '  reference→video: 4–30s (default auto); ar auto,16:9 (default auto); res 480p,720p (default 720p); ' +
        'ref images max 30; ref videos max 1 (2–30s each, ≤30s total, input time billed, ×1.4 price); ' +
        'priced by resolution × duration',
    ]);
    // The deprecated id line must not double-report the roster the cards already carry.
    expect(lines.join('\n')).not.toContain('video models:');
  });

  test('an intrinsic-audio model says so instead of implying a knob that cannot be turned off', async () => {
    const { base } = serve({
      image_models: [],
      video_models: [
        // Gemini Omni Flash / Grok 1.5 / Wan 2.7 shape: audio supported, on by default, NOT controllable.
        { ...VEO_CARD, id: 'intrinsic', label: 'Intrinsic', generate_audio_controllable: false },
        { ...VEO_CARD, id: 'controllable', label: 'Controllable', generate_audio_controllable: true },
        // A server that predates the field must keep the old wording, not gain "always on".
        { ...VEO_CARD, id: 'legacy', label: 'Legacy' },
      ],
      video_model_ids: ['intrinsic', 'controllable', 'legacy'],
    });
    const lines = humanLines(await performMediaModels(client(base)));
    expect(lines.find((l) => l.startsWith('intrinsic'))).toStartWith('intrinsic — Intrinsic  [audio always on; seed]');
    expect(lines.find((l) => l.startsWith('controllable'))).toStartWith(
      'controllable — Controllable  [audio yes (on by default); seed]',
    );
    expect(lines.find((l) => l.startsWith('legacy'))).toStartWith('legacy — Legacy  [audio yes (on by default); seed]');
  });

  test('audio-off and no-audio models state it on the header line', async () => {
    const { base } = serve({
      image_models: [],
      video_models: [
        { ...VEO_CARD, id: 'quiet', label: 'Quiet', generate_audio_default: false },
        { ...VEO_CARD, id: 'silent', label: 'Silent', supports_generate_audio: false, supports_seed: false },
      ],
      video_model_ids: ['quiet', 'silent'],
    });
    const lines = humanLines(await performMediaModels(client(base)));
    expect(lines[0]).toStartWith('quiet — Quiet  [audio yes (off by default); seed]');
    expect(lines.find((l) => l.startsWith('silent'))).toStartWith('silent — Silent  [audio no]');
  });

  test('a sparse video descriptor renders its id without inventing fields', async () => {
    const { base } = serve({ image_models: [], video_models: [{ id: 'mystery' }], video_model_ids: ['mystery'] });
    const lines = humanLines(await performMediaModels(client(base)));
    expect(lines).toEqual(['mystery']);
  });

  test('a server that predates video_models renders exactly the bare id line (tolerant fallback)', async () => {
    const { base } = serve({ image_models: [], video_model_ids: ['veo-3.1', 'seedance-2.5'] });
    const lines = humanLines(await performMediaModels(client(base)));
    expect(lines).toEqual(['video models: veo-3.1, seedance-2.5']);
  });

  test('--output on the enriched envelope counts video models from the cards and keeps the payload verbatim', async () => {
    const { base } = serve(ENRICHED_ENVELOPE);
    const out = join(mkdtempSync(join(tmpdir(), 'moda-media-out-')), 'models.json');
    const outcome = await performMediaModels(client(base), out);
    const body = outcome.body as Record<string, unknown>;
    expect(body.video_model_count).toBe(2);
    const onDisk = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    expect(onDisk.video_models).toEqual(VIDEO_MODELS);
    const lines = humanLines(outcome);
    expect(lines[0]).toBe(`5 models → ${out} (inspect with jq/grep)`);
  });

  test('generate-video: --reference-video rides the wire as reference_videos', async () => {
    const { base, calls } = captureBody(VIDEO_RESULT);
    const code = await runCli(
      ['media', 'generate-video', '--prompt', 'a slow orbit', '--model', 'seedance-2.0', '--reference-video', 'file_01HZX9K2ABCDEFGHJKMNPQRSTV', '--json'],
      base,
    );
    expect(code).toBe(0);
    expect(calls[0]?.reference_videos).toEqual(['file_01HZX9K2ABCDEFGHJKMNPQRSTV']);
  });

  test('generate-video: repeated --reference-video values arrive in order, uncapped by the client', async () => {
    const { base, calls } = captureBody(VIDEO_RESULT);
    const code = await runCli(
      [
        'media', 'generate-video', '--prompt', 'a slow orbit', '--model', 'seedance-2.0',
        '--reference-video', 'file_01HZX9K2ABCDEFGHJKMNPQRSTV', 'https://example.test/a.mp4', 'https://example.test/b.mp4',
        '--json',
      ],
      base,
    );
    expect(code).toBe(0);
    // Per-model count caps are the server's to enforce (and to name in its 422) — the CLI must not
    // pre-judge them, or a model added with a higher cap becomes unreachable from this lane.
    expect(calls[0]?.reference_videos).toEqual([
      'file_01HZX9K2ABCDEFGHJKMNPQRSTV',
      'https://example.test/a.mp4',
      'https://example.test/b.mp4',
    ]);
  });

  test('generate-video: the key is absent entirely when no --reference-video is passed', async () => {
    const { base, calls } = captureBody(VIDEO_RESULT);
    const code = await runCli(
      ['media', 'generate-video', '--prompt', 'a slow orbit', '--model', 'seedance-2.0', '--json'],
      base,
    );
    expect(code).toBe(0);
    // `extra="forbid"` on GenerateVideoRequest tolerates a missing key but not a null one.
    expect(calls[0]).not.toHaveProperty('reference_videos');
    expect(calls[0]?.prompt).toBe('a slow orbit');
  });

  test('generate-video: --no-generate-audio buys the silent rate (Kling 3 Std/Pro is a third cheaper)', async () => {
    const { base, calls } = captureBody(VIDEO_RESULT);
    const code = await runCli(
      ['media', 'generate-video', '--prompt', 'a slow orbit', '--model', 'kling-3-standard', '--no-generate-audio', '--json'],
      base,
    );
    expect(code).toBe(0);
    expect(calls[0]?.generate_audio).toBe(false);
  });

  test('generate-video: --generate-audio still sends true', async () => {
    const { base, calls } = captureBody(VIDEO_RESULT);
    const code = await runCli(
      ['media', 'generate-video', '--prompt', 'a slow orbit', '--model', 'kling-3-standard', '--generate-audio', '--json'],
      base,
    );
    expect(code).toBe(0);
    expect(calls[0]?.generate_audio).toBe(true);
  });

  test('generate-video: neither audio flag omits the key entirely — false is NOT the server default', async () => {
    const { base, calls } = captureBody(VIDEO_RESULT);
    const code = await runCli(
      ['media', 'generate-video', '--prompt', 'a slow orbit', '--model', 'kling-3-standard', '--json'],
      base,
    );
    expect(code).toBe(0);
    // Sending false here would silently buy the silent render on every audio-priced model.
    expect(calls[0]).not.toHaveProperty('generate_audio');
  });

  test('generate-video: both audio flags resolve last-wins rather than erroring (commander pairing)', async () => {
    const { base, calls } = captureBody(VIDEO_RESULT);
    const code = await runCli(
      [
        'media', 'generate-video', '--prompt', 'a slow orbit', '--model', 'kling-3-standard',
        '--generate-audio', '--no-generate-audio', '--json',
      ],
      base,
    );
    expect(code).toBe(0);
    expect(calls[0]?.generate_audio).toBe(false);
  });

  test('--output routes the full registry to the file; the envelope keeps counts + a bounded preview', async () => {
    const { base } = serve(MODELS_ENVELOPE);
    const out = join(mkdtempSync(join(tmpdir(), 'moda-media-out-')), 'models.json');
    const outcome = await performMediaModels(client(base), out);
    const body = outcome.body as Record<string, unknown>;
    expect(body.output).toBe(out);
    expect(body.image_model_count).toBe(3);
    expect(body.video_model_count).toBe(4);
    expect((body.preview as string[]).length).toBeLessThanOrEqual(3);
    expect(body.image_models).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    expect((onDisk.image_models as unknown[]).length).toBe(3);
    expect(onDisk.video_model_ids).toEqual(MODELS_ENVELOPE.video_model_ids);
    const lines = humanLines(outcome);
    expect(lines[0]).toBe(`7 models → ${out} (inspect with jq/grep)`);
  });
});
