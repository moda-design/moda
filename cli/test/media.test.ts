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
import { controlSpec, sizeSpec } from '../src/commands/media.ts';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ApiClient } from '../src/api/client.ts';
import { performMediaModels } from '../src/commands/media.ts';
import { parseTimestampMs } from '../src/commands/media.ts';
import { CliError } from '../src/cliError.ts';
import { deriveIdempotencyKey } from '../src/api/idempotency.ts';

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
  operation: 'media.generate-video',
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

  test('generate-video: --reference-audio values ride the wire in order', async () => {
    const { base, calls } = captureBody(VIDEO_RESULT);
    const code = await runCli(
      [
        'media', 'generate-video', '--prompt', 'a singer on stage', '--model', 'minimax-h3',
        '--reference-audio', 'file_01HZX9K2ABCDEFGHJKMNPQRSTV', 'https://example.test/voice.wav', '--json',
      ],
      base,
    );
    expect(code).toBe(0);
    expect(calls[0]?.reference_audios).toEqual([
      'file_01HZX9K2ABCDEFGHJKMNPQRSTV',
      'https://example.test/voice.wav',
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
    expect(calls[0]).not.toHaveProperty('reference_audios');
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

describe('model controls render their legal values (ENG-5026)', () => {
  // Live payloads, captured from `moda media models --json`.
  const QUALITY = {
    id: 'quality',
    label: 'Quality',
    type: 'select',
    options: [{ value: 'auto' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }],
    default: 'high',
    max_items: null,
  };
  const COLORS = { id: 'colors', label: 'Brand colors', type: 'color_list', options: null, default: [], max_items: 5 };

  test('a select renders its options and default — the whole point of the ticket', () => {
    expect(controlSpec(QUALITY)).toBe('quality=auto|low|medium|high (default high)');
    // The old render was the bare id, which told a caller nothing they could pass.
    expect(controlSpec(QUALITY)).not.toBe('quality');
  });

  test('an open-valued control reports type and cap instead of an option list', () => {
    // `colors` cannot be enumerated (options: null); type + max_items is the most a caller can be told.
    expect(controlSpec(COLORS)).toBe('colors:color_list (max 5)');
  });

  test('a non-string default is omitted rather than rendered as [object Object]', () => {
    const spec = controlSpec({ id: 'x', type: 'select', options: [{ value: 'a' }], default: [] });
    expect(spec).toBe('x=a');
    expect(spec).not.toContain('object');
  });

  test('plain-string options are accepted alongside the {value} shape', () => {
    expect(controlSpec({ id: 'x', type: 'select', options: ['a', 'b'], default: 'a' })).toBe('x=a|b (default a)');
  });

  test('size envelope renders as a range, showing step only when it constrains', () => {
    expect(sizeSpec({ min_width: 512, max_width: 3840, min_height: 512, max_height: 3840, step: 16 })).toBe(
      'size 512-3840x512-3840 step 16',
    );
    expect(sizeSpec({ min_width: 512, max_width: 1536, min_height: 512, max_height: 1536, step: 1 })).toBe(
      'size 512-1536x512-1536',
    );
  });

  test('an incomplete or absent size envelope renders nothing', () => {
    expect(sizeSpec(undefined)).toBeUndefined();
    expect(sizeSpec({})).toBeUndefined();
    expect(sizeSpec({ min_width: 512, max_width: 3840 })).toBeUndefined();
  });
});

describe('bare-string controls stay verbatim (regression guard for ENG-5026)', () => {
  test('an older server sending ["quality"] still renders "quality"', () => {
    expect(controlSpec('quality')).toBe('quality');
    expect(controlSpec('quality')).not.toContain(':value');
  });
});

describe('--timestamps accepts both list forms (ENG-5027)', () => {
  test('space-separated values accumulate, as commander variadics always did', () => {
    expect(parseTimestampMs('2500', parseTimestampMs('0', undefined))).toEqual([0, 2500]);
  });

  test('a comma-separated list is accepted — the obvious first attempt', () => {
    expect(parseTimestampMs('0,2500,4999', undefined)).toEqual([0, 2500, 4999]);
  });

  test('the two forms mix, and surrounding whitespace is tolerated', () => {
    expect(parseTimestampMs('2500, 4999', parseTimestampMs('0', undefined))).toEqual([0, 2500, 4999]);
  });

  test('a genuinely non-numeric value still fails, now naming both working forms', () => {
    try {
      parseTimestampMs('0,abc', undefined);
      throw new Error('expected a usage error');
    } catch (err) {
      const fields = (err as CliError).fields;
      expect(fields.code).toBe('usage');
      expect(fields.hint).toContain('--timestamps 0 2500 4999');
      expect(fields.hint).toContain('--timestamps 0,2500,4999');
    }
  });

  test('the max-8 refusal counts across both forms and points at --count', () => {
    try {
      parseTimestampMs('1,2,3,4,5,6,7,8,9', undefined);
      throw new Error('expected a usage error');
    } catch (err) {
      const fields = (err as CliError).fields;
      expect(fields.message).toContain('at most 8');
      expect(fields.hint).toContain('--count 8');
    }
  });

  test('an empty or comma-only value is a usage error, not a silent empty list', () => {
    expect(() => parseTimestampMs('', undefined)).toThrow(CliError);
    expect(() => parseTimestampMs(',,', undefined)).toThrow(CliError);
  });
});

/**
 * Artifact download: multi-image output and the paid-work-orphaning guard (ENG-5033 / ENG-5034).
 * The fake server answers the media POST with N results whose `url` points back at itself, so
 * the real download path runs end to end.
 */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function serveArtifacts(count: number): { base: string } {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/artifact/')) return new Response(PNG_BYTES);
      const origin = `http://127.0.0.1:${server?.port}`;
      return Response.json({
        operation: 'media.generate-image',
        results: Array.from({ length: count }, (_, i) => ({
          id: `file_TEST${i + 1}`,
          url: `${origin}/artifact/${i + 1}`,
          mime_type: 'image/png',
        })),
        usage: { class: 'metered', metered: true, model: 'nano-banana' },
      });
    },
  });
  return { base: `http://127.0.0.1:${server.port}` };
}

const GEN_ARGS = ['media', 'generate-image', '--model', 'nano-banana', '--prompt', 'x'];

describe('media artifact download (ENG-5033: every paid image reaches disk)', () => {
  test('one artifact keeps the exact --output path', async () => {
    const { base } = serveArtifacts(1);
    const dir = mkdtempSync(join(tmpdir(), 'moda-art-'));
    const out = join(dir, 'one.png');
    expect(await runCli([...GEN_ARGS, '-o', out], base)).toBe(0);
    expect(readFileSync(out)).toHaveLength(PNG_BYTES.length);
  });

  test('N artifacts into a DIRECTORY land as <file_id>.<ext> — not one overwritten file', async () => {
    const { base } = serveArtifacts(3);
    const dir = mkdtempSync(join(tmpdir(), 'moda-art-'));
    expect(await runCli([...GEN_ARGS, '--num-images', '3', '-o', dir], base)).toBe(0);
    for (const id of ['file_TEST1', 'file_TEST2', 'file_TEST3']) {
      expect(readFileSync(join(dir, `${id}.png`))).toHaveLength(PNG_BYTES.length);
    }
  });

  test('N artifacts with a FILE --output are numbered off its stem', async () => {
    const { base } = serveArtifacts(2);
    const dir = mkdtempSync(join(tmpdir(), 'moda-art-'));
    expect(await runCli([...GEN_ARGS, '--num-images', '2', '-o', join(dir, 'city.png')], base)).toBe(0);
    // Never a directory called `city.png`.
    expect(readFileSync(join(dir, 'city-1.png'))).toHaveLength(PNG_BYTES.length);
    expect(readFileSync(join(dir, 'city-2.png'))).toHaveLength(PNG_BYTES.length);
  });

  test('a trailing-separator --output is a directory, not an ENOENT crash', async () => {
    const { base } = serveArtifacts(1);
    const dir = mkdtempSync(join(tmpdir(), 'moda-art-'));
    expect(await runCli([...GEN_ARGS, '-o', `${join(dir, 'shots')}/`], base)).toBe(0);
    expect(readFileSync(join(dir, 'shots', 'file_TEST1.png'))).toHaveLength(PNG_BYTES.length);
  });
});

describe('media output pre-flight (ENG-5034: never bill for a write that cannot land)', () => {
  test('an unwritable --output fails BEFORE the metered call is made', async () => {
    // chmod(0o500) cannot make a directory unwritable on Windows (POSIX modes
    // are a near-no-op there — the #46 port's documented platform fact), so the
    // simulation method, not the pre-flight itself, is POSIX-only. Same skip
    // idiom as keychain.test.ts.
    if (process.platform === 'win32') return;
    const calls: Record<string, unknown>[] = [];
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        calls.push((await req.json().catch(() => ({}))) as Record<string, unknown>);
        return Response.json({ results: [], usage: {} });
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const dir = mkdtempSync(join(tmpdir(), 'moda-art-'));
    chmodSync(dir, 0o500);
    // exit 2 (invalid_request/io_error), not 1 (cli_internal) — a bad path is caller input.
    expect(await runCli([...GEN_ARGS, '-o', join(dir, 'sub', 'out.png')], base)).toBe(2);
    // The decisive assertion: the provider was never called, so nothing was billed.
    expect(calls).toHaveLength(0);
    chmodSync(dir, 0o700);
  });
});

async function runCliCapture(args: string[], base: string): Promise<{ code: number; stdout: string }> {
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
  const [code, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout };
}

describe('media write failure after billing (ENG-5034: failure-with-results)', () => {
  test('exits nonzero but keeps results + usage so the paid refs are recoverable', async () => {
    const { base } = serveArtifacts(1);
    const dir = mkdtempSync(join(tmpdir(), 'moda-art-'));
    const target = join(dir, 'readonly.png');
    writeFileSync(target, '');
    chmodSync(target, 0o400); // passes the dir pre-flight, fails at write

    const { code, stdout } = await runCliCapture([...GEN_ARGS, '-o', target, '--json'], base);
    const doc = JSON.parse(stdout) as Record<string, unknown>;

    // Nonzero: the caller asked for a local file and there is none, so `… && next` must halt.
    expect(code).not.toBe(0);
    expect(doc.ok).toBe(false);
    expect((doc.error as Record<string, unknown>).code).toBe('io_error');
    // The decision: the refs ride along as recovery data, never discarded with the error.
    expect(doc.results).toHaveLength(1);
    expect((doc.results as Record<string, unknown>[])[0]!.id).toBe('file_TEST1');
    expect(doc.usage).toBeDefined();

    chmodSync(target, 0o700);
  });
});

/**
 * ENG-5011 renamed the PRINTED media operation labels (`media.generate_image` →
 * `media.generate-image`). Those same strings were also feeding the idempotency-key hash, where a
 * change is not cosmetic: an identical re-run would derive a fresh key, so the server would bill a
 * second render instead of replaying the first. The key spelling is therefore frozen at the
 * pre-rename value. This test fails if anyone "tidies" it to match the label.
 */
describe('media idempotency command is frozen across the ENG-5011 label rename', () => {
  function captureHeaders(response: unknown): { base: string; keys: (string | null)[]; bodies: unknown[] } {
    const keys: (string | null)[] = [];
    const bodies: unknown[] = [];
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        keys.push(req.headers.get('idempotency-key'));
        bodies.push(await req.json().catch(() => ({})));
        return Response.json(response);
      },
    });
    return { base: `http://127.0.0.1:${server.port}`, keys, bodies };
  }

  test('generate-image sends the key derived from the pre-rename command string', async () => {
    const { base, keys, bodies } = captureHeaders({ results: [], usage: { metered_credits: 1 } });
    expect(await runCli(GEN_ARGS, base)).toBe(0);
    // The client stamps `idempotency_key` INTO the body after deriving it, so the hashed payload
    // is the body without that field.
    const { idempotency_key: _stamped, ...hashedPayload } = bodies[0] as Record<string, unknown>;
    expect(keys[0]).toBe(
      deriveIdempotencyKey({
        command: 'media.generate_image',
        canvas: '',
        expectedRevision: undefined,
        payload: JSON.stringify(hashedPayload),
      }),
    );
    // …and specifically NOT the key the new printed label would derive.
    expect(keys[0]).not.toBe(
      deriveIdempotencyKey({
        command: 'media.generate-image',
        canvas: '',
        expectedRevision: undefined,
        payload: JSON.stringify(hashedPayload),
      }),
    );
  });
});

describe('media single-input verbs accept --source as well as the positional (ENG-4997)', () => {
  const UPSCALE_RESULT = {
    operation: 'media.upscale',
    result: { file_id: 'file_01HZX9K2ABCDEFGHJKMNPQRSTV', url: 'https://example.test/up.png' },
    usage: { credits: 1 },
  };
  const REF = 'file_01HZX9K2ABCDEFGHJKMNPQRSTV';

  test('upscale: --source rides the wire as `image`, exactly as the positional does', async () => {
    const flag = captureBody(UPSCALE_RESULT);
    expect(await runCli(['media', 'upscale', '--source', REF, '--json'], flag.base)).toBe(0);
    expect(flag.calls[0]?.image).toBe(REF);
    server?.stop(true);

    const positional = captureBody(UPSCALE_RESULT);
    expect(await runCli(['media', 'upscale', REF, '--json'], positional.base)).toBe(0);
    // Same field, same value — the alias is a spelling, not a second code path.
    expect(positional.calls[0]?.image).toEqual(flag.calls[0]?.image as string);
  });

  test('remove-background: --source rides the wire as `image`', async () => {
    const { base, calls } = captureBody({ operation: 'media.remove_background', result: { file_id: REF }, usage: {} });
    expect(await runCli(['media', 'remove-background', '--source', REF, '--json'], base)).toBe(0);
    expect(calls[0]?.image).toBe(REF);
  });

  test('upscale-video: --source rides the wire as `video` (not `image`)', async () => {
    const { base, calls } = captureBody({ operation: 'media.upscale_video', result: { file_id: REF }, usage: {} });
    expect(await runCli(['media', 'upscale-video', '--source', REF, '--resolution', '1080p', '--json'], base)).toBe(0);
    expect(calls[0]?.video).toBe(REF);
    expect(calls[0]?.image).toBeUndefined();
  });

  test('both spellings at once is a usage error, not a silent precedence rule', async () => {
    const { base, calls } = captureBody(UPSCALE_RESULT);
    expect(await runCli(['media', 'upscale', REF, '--source', 'https://example.test/other.png', '--json'], base)).toBe(2);
    // Refused before spending anything — these verbs are metered.
    expect(calls.length).toBe(0);
  });

  test('neither spelling names the verb and both ways to supply the input', async () => {
    const { base, calls } = captureBody(UPSCALE_RESULT);
    expect(await runCli(['media', 'upscale', '--json'], base)).toBe(2);
    expect(calls.length).toBe(0);
  });

  test('video-frames takes the alias too — the free read verb is in the same group', async () => {
    const { base, calls } = captureBody(UPSCALE_RESULT);
    // Both spellings at once: the shared guard fires before any request goes out.
    expect(await runCli(['media', 'video-frames', REF, '--source', REF, '--json'], base)).toBe(2);
    expect(calls.length).toBe(0);
  });
});
