/**
 * `moda media models` — the human lane must render the SAME model set the JSON lane carries.
 * Regression for the cold-gate F4 defect: the server envelope is
 * `{image_models: [descriptor…], video_model_ids: [id…]}` (backend media router), but the
 * plain formatter printed "no models reported" while --json listed everything — which steered
 * real runs into declaring imagery unavailable and skipping the workflow step.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ApiClient } from '../src/api/client.ts';
import { performMediaModels } from '../src/commands/media.ts';

let server: ReturnType<typeof Bun.serve> | undefined;

function serve(body: unknown): { base: string } {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json(body),
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

describe('media models — human/JSON model-set parity (gate finding F4)', () => {
  test('human lane renders every model id the JSON lane carries', async () => {
    const { base } = serve(MODELS_ENVELOPE);
    const outcome = await performMediaModels(client(base), {});

    const body = outcome.body as Record<string, unknown>;
    const jsonImageIds = (body.image_models as Array<Record<string, unknown>>).map((m) => m.id as string);
    const jsonVideoIds = body.video_model_ids as string[];
    expect(jsonImageIds).toEqual(['nano-banana', 'nano-banana-pro', 'gpt-image-2']);
    expect(jsonVideoIds).toEqual(MODELS_ENVELOPE.video_model_ids);

    const human = humanLines(outcome).join('\n');
    expect(human).not.toContain('no models reported');
    for (const id of [...jsonImageIds, ...jsonVideoIds]) {
      expect(human).toContain(id);
    }
  });

  test('capability lines carry the axes the skills defer to (aspect ratios, res tiers, refs, params)', async () => {
    const { base } = serve(MODELS_ENVELOPE);
    const lines = humanLines(await performMediaModels(client(base), {}));

    const nano = lines.find((l) => l.startsWith('nano-banana '));
    expect(nano).toContain('NanoBanana 2');
    expect(nano).toContain('ar auto,1:1,16:9,9:16');
    expect(nano).toContain('refs max 3');
    expect(nano).toContain('Fast, low-cost baseline');

    const pro = lines.find((l) => l.startsWith('nano-banana-pro'));
    expect(pro).toContain('res 1K,2K,4K');

    const gpt = lines.find((l) => l.startsWith('gpt-image-2'));
    expect(gpt).toContain('params quality');

    expect(lines.at(-1)).toBe('video models: gemini-omni-flash, seedance-2.5, veo-3.1, veo-3.1-fast');
  });

  test('a genuinely empty registry still says so', async () => {
    const { base } = serve({ image_models: [], video_model_ids: [] });
    const lines = humanLines(await performMediaModels(client(base), {}));
    expect(lines).toEqual(['no models reported']);
  });

  test('video-only envelope never contradicts itself with the empty hint', async () => {
    const { base } = serve({ image_models: [], video_model_ids: ['veo-3.1'] });
    const lines = humanLines(await performMediaModels(client(base), {}));
    expect(lines.join('\n')).not.toContain('no models reported');
    expect(lines.at(-1)).toBe('video models: veo-3.1');
  });
});
