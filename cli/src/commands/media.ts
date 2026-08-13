/**
 * `moda media` — raw metered media operations (cli.md §11, Option A grammar). Always labeled
 * `metered: true`; model is an explicit parameter (frontend selector choices, `media models`).
 *
 * Server contracts: backend/app/api/public/routers/media.py — inputs are `file_` ids or
 * http(s) URLs (`img_*` agent refs are rejected); image verbs return `results[]`, single-artifact
 * verbs return `result`; every response carries the metered usage receipt.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import type { ApiClient } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { asObject, num, str, strArray, type JsonObject } from '../api/types.ts';
import { CliError, rethrowRoutePredates } from '../cliError.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import type { CommandOutcome } from '../output/emit.ts';
import { PREVIEW_ITEMS, writeResultFile } from '../output/resultFile.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction, type Invocation } from './runtime.ts';
import { parseSize } from './canvasShared.ts';

const MEDIA_TIMEOUT_MS = 600_000;

export function registerMedia(program: Command): void {
  const media = program.command('media').description('metered media generation — burns Moda credits, receipts on every response');

  addGlobalFlags(
    media
      .command('generate-image')
      .description('generate an image (metered)')
      .requiredOption('--prompt <prompt>', 'generation prompt (sent to the model verbatim)')
      .requiredOption('--model <model>', 'model id (see: moda media models)')
      .option('--size <WxH>', 'output size, e.g. 1024x1024')
      .option('--aspect-ratio <ratio>', 'aspect ratio, e.g. 16:9')
      .option('--resolution <res>', "per-model resolution tier (see the model's capability line)")
      .option('--num-images <n>', 'images per call, 1-4', parseNumImages)
      .option('--model-params <json>', 'per-model extra params as a JSON object', parseModelParams)
      .option('--source <refs...>', 'images the prompt modifies/preserves: file_ refs, URLs, or local paths')
      .option('--reference <refs...>', 'style/subject references: file_ refs, URLs, or local paths')
      .option('-o, --output <path>', 'download the artifact to a local file'),
  )
    .addHelpText('after', '\nExample:\n  moda media generate-image --prompt "isometric city at dusk, warm light" --model MODEL -o city.png\n\nGenerated imagery is a default quality lever — covers, heroes, section\nbreaks. Reuse brand-kit assets/uploads when they ARE the subject (moda file\nsearch, moda brand show); markup <image icon="query"/> covers UI icons.\n')
    .action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MEDIA_TIMEOUT_MS);
      const size = typeof opts.size === 'string' ? parseSize(opts.size) : undefined;
      const payload = {
        prompt: opts.prompt as string,
        model: opts.model as string,
        ...(size !== undefined ? { width: size.width, height: size.height } : {}),
        ...(typeof opts.aspectRatio === 'string' ? { aspect_ratio: opts.aspectRatio } : {}),
        ...(typeof opts.resolution === 'string' ? { resolution: opts.resolution } : {}),
        ...(typeof opts.numImages === 'number' ? { num_images: opts.numImages } : {}),
        ...(opts.modelParams !== undefined ? { model_params: opts.modelParams } : {}),
        ...(Array.isArray(opts.source) ? { source_images: await mediaInputs(opts.source as string[], client) } : {}),
        ...(Array.isArray(opts.reference)
          ? { reference_images: await mediaInputs(opts.reference as string[], client) }
          : {}),
      };
      return mediaCall(client, inv, 'media.generate_image', endpoints.mediaGenerateImage(), payload, opts.output as string | undefined);
    }),
  );

  addGlobalFlags(
    media
      .command('edit-image')
      .description('generative image edit (metered) — the same primitive with required source images')
      .requiredOption('--prompt <prompt>', 'edit instruction (sent to the model verbatim)')
      .requiredOption('--model <model>', 'model id (see: moda media models)')
      .requiredOption('--source <refs...>', 'the image(s) to edit: file_ refs, URLs, or local paths')
      .option('--resolution <res>', "per-model resolution tier (see the model's capability line)")
      .option('--num-images <n>', 'images per call, 1-4', parseNumImages)
      .option('--model-params <json>', 'per-model extra params as a JSON object', parseModelParams)
      .option('--reference <refs...>', 'style/subject references: file_ refs, URLs, or local paths')
      .option('-o, --output <path>', 'download the artifact to a local file'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MEDIA_TIMEOUT_MS);
      const payload = {
        prompt: opts.prompt as string,
        model: opts.model as string,
        source_images: await mediaInputs(opts.source as string[], client),
        ...(typeof opts.resolution === 'string' ? { resolution: opts.resolution } : {}),
        ...(typeof opts.numImages === 'number' ? { num_images: opts.numImages } : {}),
        ...(opts.modelParams !== undefined ? { model_params: opts.modelParams } : {}),
        ...(Array.isArray(opts.reference)
          ? { reference_images: await mediaInputs(opts.reference as string[], client) }
          : {}),
      };
      return mediaCall(client, inv, 'media.edit_image', endpoints.mediaEditImage(), payload, opts.output as string | undefined);
    }),
  );

  addGlobalFlags(
    media
      .command('generate-video')
      .description('generate a video (metered; the provider render runs within this call)')
      .requiredOption('--prompt <prompt>', 'generation prompt')
      .requiredOption('--model <model>', 'model id (see: moda media models)')
      .option('--image <ref>', 'first-frame image: file_ ref, URL, or local path')
      .option('--end-image <ref>', 'last-frame image: file_ ref, URL, or local path')
      .option('--reference <refs...>', 'reference images (reference-to-video models): file_ refs, URLs, or local paths')
      .option('--duration <seconds>', 'clip duration — ALWAYS pass one; it is the dominant cost driver')
      .option('--aspect-ratio <ratio>', 'aspect ratio, e.g. 16:9')
      .option('--resolution <res>', "per-model resolution tier (see the model's capability line)")
      .option('--generate-audio', 'generate native audio (models that support it)')
      .option('--seed <n>', 'deterministic seed', (v: string) => Number.parseInt(v, 10))
      .option('--model-params <json>', 'per-model extra params as a JSON object', parseModelParams)
      .option('-o, --output <path>', 'download the artifact to a local file'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MEDIA_TIMEOUT_MS);
      const payload = {
        prompt: opts.prompt as string,
        model: opts.model as string,
        ...(typeof opts.image === 'string' ? { start_image: await mediaInput(opts.image, client) } : {}),
        ...(typeof opts.endImage === 'string' ? { end_image: await mediaInput(opts.endImage, client) } : {}),
        ...(Array.isArray(opts.reference)
          ? { reference_images: await mediaInputs(opts.reference as string[], client) }
          : {}),
        // Schema: duration_seconds is float|str — numeric strings travel as numbers, model
        // enums like "8s" pass through verbatim for the server to resolve.
        ...(typeof opts.duration === 'string'
          ? { duration_seconds: Number.isFinite(Number(opts.duration)) ? Number(opts.duration) : opts.duration }
          : {}),
        ...(typeof opts.aspectRatio === 'string' ? { aspect_ratio: opts.aspectRatio } : {}),
        ...(typeof opts.resolution === 'string' ? { resolution: opts.resolution } : {}),
        ...(opts.generateAudio === true ? { generate_audio: true } : {}),
        ...(typeof opts.seed === 'number' && Number.isFinite(opts.seed) ? { seed: opts.seed } : {}),
        ...(opts.modelParams !== undefined ? { model_params: opts.modelParams } : {}),
      };
      return mediaCall(client, inv, 'media.generate_video', endpoints.mediaGenerateVideo(), payload, opts.output as string | undefined);
    }),
  );

  addGlobalFlags(
    media
      .command('upscale <ref_or_path>')
      .description('upscale an image 2x or 4x (metered); accepts a file_ ref, URL, or local path')
      .option('--scale <n>', 'upscale factor: 2 or 4', (v: string) => Number.parseInt(v, 10))
      .option('-o, --output <path>', 'download the artifact to a local file'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MEDIA_TIMEOUT_MS);
      const image = await mediaInput(args[0] as string, client);
      const payload = { image, ...(typeof opts.scale === 'number' ? { scale: opts.scale } : {}) };
      return mediaCall(client, inv, 'media.upscale', endpoints.mediaUpscale(), payload, opts.output as string | undefined);
    }),
  );

  addGlobalFlags(
    media
      .command('upscale-video <ref_or_path>')
      .description('upscale a video (metered); accepts a file_ ref, URL, or local path')
      .option('--resolution <res>', 'target resolution: 720p | 1080p | 1440p | 2160p')
      .option('-o, --output <path>', 'download the artifact to a local file'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MEDIA_TIMEOUT_MS);
      const video = await mediaInput(args[0] as string, client);
      // Wire field is target_resolution (extra=forbid server-side); the flag stays --resolution.
      const payload = { video, ...(typeof opts.resolution === 'string' ? { target_resolution: opts.resolution } : {}) };
      try {
        return await mediaCall(client, inv, 'media.upscale_video', endpoints.mediaUpscaleVideo(), payload, opts.output as string | undefined);
      } catch (err) {
        rethrowRoutePredates(
          err,
          'This server predates the video-upscale endpoint.',
          'It ships with the next backend deploy; image upscaling works today: moda media upscale.',
        );
      }
    }),
  );

  addGlobalFlags(
    media
      .command('remove-background <ref_or_path>')
      .description('remove an image background (metered); result is a new transparent PNG')
      .option('--high-quality', 'use the high-quality matting model')
      .option('-o, --output <path>', 'download the artifact to a local file'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MEDIA_TIMEOUT_MS);
      const image = await mediaInput(args[0] as string, client);
      const payload = { image, ...(opts.highQuality === true ? { high_quality: true } : {}) };
      return mediaCall(client, inv, 'media.remove_background', endpoints.mediaRemoveBackground(), payload, opts.output as string | undefined);
    }),
  );

  addGlobalFlags(
    media
      .command('models')
      .description('available media models and their capabilities (the required --model values)')
      .option('--output <file>', 'write the full payload to a file; stdout gets a small summary + preview'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, 30_000);
      return performMediaModels(client, typeof opts.output === 'string' ? opts.output : undefined);
    }),
  );
}

/**
 * `media models` — the capability source the skills defer to. This is NOT a list lane: the
 * server returns the complete registry in one document — `{image_models: [descriptor…],
 * video_models: [descriptor…], video_model_ids: [id…]}` (backend media router) — so there is
 * no pagination and no page note. The human lane must render the SAME model set the JSON lane
 * carries (the "no models reported" regression steered real runs into skipping imagery
 * entirely). A server that predates `video_models` still sends `video_model_ids`; render
 * exactly the bare id line for it — never invent capability fields the server did not state.
 */
export async function performMediaModels(client: ApiClient, output?: string): Promise<CommandOutcome> {
  const response = await client.request({ method: 'GET', path: endpoints.mediaModels(), timeoutMs: 30_000 });
  const root = asObject(response.body);
  const imageModels = (Array.isArray(root.image_models) ? root.image_models : []).map(asObject);
  const videoModels = (Array.isArray(root.video_models) ? root.video_models : []).map(asObject);
  const videoModelIds = strArray(root, 'video_model_ids');
  const videoModelCount = videoModels.length > 0 ? videoModels.length : videoModelIds.length;
  const meta = { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) };
  const videoLines =
    videoModels.length > 0
      ? videoModels.flatMap(videoModelCard)
      : videoModelIds.length > 0
        ? [`video models: ${videoModelIds.join(', ')}`]
        : [];
  const lines = [...imageModels.map(imageModelLine), ...videoLines];
  if (output !== undefined) {
    const written = writeResultFile(output, { ok: true, operation: 'media.models', ...root });
    const preview = lines.slice(0, PREVIEW_ITEMS);
    return {
      body: {
        ok: true,
        operation: 'media.models',
        image_model_count: imageModels.length,
        video_model_count: videoModelCount,
        ...written,
        preview,
        meta,
      },
      human: (write) => {
        write(`${imageModels.length + videoModelCount} models → ${written.output} (inspect with jq/grep)`);
        for (const line of preview) write(line);
      },
      exitCode: EXIT_OK,
    };
  }
  return {
    body: { ok: true, operation: 'media.models', ...root, meta },
    human: (write) => {
      if (lines.length === 0) {
        write('no models reported');
        return;
      }
      for (const line of lines) write(line);
    },
    exitCode: EXIT_OK,
  };
}

/**
 * One capability line per image model — id, label, aspect ratios, resolution tiers, refs,
 * images-per-request cap, extra params (the axes the skills tell agents to read from here).
 */
function imageModelLine(model: JsonObject): string {
  const id = str(model, 'id') ?? str(model, 'name') ?? '?';
  const label = str(model, 'label') ?? str(model, 'name') ?? '';
  const caps: string[] = [];
  const aspectRatios = strArray(model, 'aspect_ratios');
  if (aspectRatios.length > 0) caps.push(`ar ${aspectRatios.join(',')}`);
  const resolutions = idList(model.resolutions);
  if (resolutions.length > 0) caps.push(`res ${resolutions.join(',')}`);
  if (model.accepts_reference_images === true) {
    const maxRefs = num(model, 'max_reference_images');
    caps.push(`refs${maxRefs !== undefined ? ` max ${maxRefs}` : ''}`);
  }
  const maxImages = num(model, 'max_num_images');
  if (maxImages !== undefined) caps.push(`imgs max ${maxImages}`);
  const controls = idList(model.controls);
  if (controls.length > 0) caps.push(`params ${controls.join(',')}`);
  const description = str(model, 'description') ?? '';
  return (
    `${id}${label.length > 0 && label !== id ? ` — ${label}` : ''}` +
    `${caps.length > 0 ? `  [${caps.join('; ')}]` : ''}${description.length > 0 ? `  ${description}` : ''}`
  );
}

/**
 * One capability card per video model — header line mirroring imageModelLine (id, label,
 * audio/seed, description) plus one indented line per supported generation mode and one for
 * the --model-params controls. Renders ONLY what the payload states (PublicVideoModelDescriptor,
 * backend video_registry.py): an absent mode is unsupported, an empty aspect/resolution list is
 * a control the mode does not have, and a null billing basis renders nothing.
 */
function videoModelCard(model: JsonObject): string[] {
  const id = str(model, 'id') ?? '?';
  const label = str(model, 'label') ?? '';
  const caps: string[] = [];
  if (model.supports_generate_audio === true) {
    caps.push(`audio yes (${model.generate_audio_default === true ? 'on' : 'off'} by default)`);
  } else if (model.supports_generate_audio === false) {
    caps.push('audio no');
  }
  if (model.supports_seed === true) caps.push('seed');
  const description = str(model, 'description') ?? '';
  const lines = [
    `${id}${label.length > 0 && label !== id ? ` — ${label}` : ''}` +
      `${caps.length > 0 ? `  [${caps.join('; ')}]` : ''}${description.length > 0 ? `  ${description}` : ''}`,
  ];
  const modes = asObject(model.modes);
  for (const [name, key] of [
    ['text→video', 'text_to_video'],
    ['image→video', 'image_to_video'],
    ['reference→video', 'reference_to_video'],
  ] as const) {
    const capability = modes[key];
    if (capability === null || capability === undefined) continue;
    const segments = videoModeSegments(asObject(capability));
    lines.push(`  ${name}${segments.length > 0 ? `: ${segments.join('; ')}` : ''}`);
  }
  const params = (Array.isArray(model.model_params) ? model.model_params : [])
    .map((param) => str(asObject(param), 'id'))
    .filter((paramId): paramId is string => paramId !== undefined && paramId.length > 0);
  if (params.length > 0) lines.push(`  params (--model-params): ${params.join(', ')}`);
  return lines;
}

/** One mode's envelope: duration, aspect, resolution, input caps, billing — in plain words. */
function videoModeSegments(capability: JsonObject): string[] {
  const segments: string[] = [];
  const duration = videoDurationText(asObject(capability.duration_seconds));
  if (duration !== undefined) segments.push(duration);
  const aspectRatios = strArray(capability, 'aspect_ratios');
  if (aspectRatios.length > 0) {
    const defaultAspect = str(capability, 'default_aspect_ratio');
    segments.push(`ar ${aspectRatios.join(',')}${defaultAspect !== undefined ? ` (default ${defaultAspect})` : ''}`);
  }
  const resolutions = strArray(capability, 'resolutions');
  if (resolutions.length > 0) {
    const defaultResolution = str(capability, 'default_resolution');
    segments.push(`res ${resolutions.join(',')}${defaultResolution !== undefined ? ` (default ${defaultResolution})` : ''}`);
  }
  if (capability.supports_end_image === true) segments.push('end image ok');
  const maxReferenceImages = num(capability, 'max_reference_images');
  if (maxReferenceImages !== undefined && maxReferenceImages > 0) segments.push(`ref images max ${maxReferenceImages}`);
  if (capability.reference_videos !== null && capability.reference_videos !== undefined) {
    segments.push(referenceVideosText(asObject(capability.reference_videos)));
  }
  segments.push(...videoBillingSegments(asObject(capability.billing)));
  return segments;
}

/** Clip-length envelope: exact legal lengths where enumerated, a range otherwise. */
function videoDurationText(duration: JsonObject): string | undefined {
  const allowed = (Array.isArray(duration.allowed_seconds) ? duration.allowed_seconds : []).filter(
    (value): value is number => typeof value === 'number',
  );
  const min = num(duration, 'min_seconds');
  const max = num(duration, 'max_seconds');
  let envelope: string | undefined;
  if (allowed.length > 0) envelope = `${allowed.join('/')}s`;
  else if (min !== undefined && max !== undefined) envelope = min === max ? `${min}s` : `${min}–${max}s`;
  if (envelope === undefined) return undefined;
  const notes: string[] = [];
  if (typeof duration.default === 'number') notes.push(`default ${duration.default}s`);
  else if (duration.default === 'auto') notes.push('default auto');
  if (duration.supports_auto === true && duration.default !== 'auto') notes.push('auto ok');
  return notes.length > 0 ? `${envelope} (${notes.join(', ')})` : envelope;
}

/** The reference-VIDEO (video-to-video) envelope, where a mode has one. */
function referenceVideosText(referenceVideos: JsonObject): string {
  const maxCount = num(referenceVideos, 'max_count');
  const minEach = num(referenceVideos, 'min_seconds_each');
  const maxEach = num(referenceVideos, 'max_seconds_each');
  const maxTotal = num(referenceVideos, 'max_total_seconds');
  const notes: string[] = [];
  if (minEach !== undefined && maxEach !== undefined) notes.push(`${minEach}–${maxEach}s each`);
  if (maxTotal !== undefined) notes.push(`≤${maxTotal}s total`);
  if (referenceVideos.input_duration_billed === true) notes.push('input time billed');
  const multiplier = num(referenceVideos, 'price_multiplier');
  if (multiplier !== undefined && multiplier !== 1) notes.push(`×${multiplier} price`);
  const head = `ref videos${maxCount !== undefined ? ` max ${maxCount}` : ''}`;
  return notes.length > 0 ? `${head} (${notes.join(', ')})` : head;
}

/** Billing basis in plain words; a null basis states nothing rather than guessing. */
function videoBillingSegments(billing: JsonObject): string[] {
  const segments: string[] = [];
  const basis = str(billing, 'basis');
  if (basis === 'second') segments.push('priced per second');
  else if (basis === 'megapixel_second') segments.push('priced by resolution × duration');
  else if (basis !== undefined) segments.push(`priced per ${basis}`);
  if (billing.audio_priced_separately === true) segments.push('audio billed separately');
  const higherRateResolutions = strArray(billing, 'higher_rate_resolutions');
  if (higherRateResolutions.length > 0) segments.push(`higher rate at ${higherRateResolutions.join(',')}`);
  return segments;
}

/** Ids from an array tolerant of BOTH entry shapes: bare string ids or `{id}` descriptor objects. */
function idList(value: unknown): string[] {
  return (Array.isArray(value) ? value : [])
    .map((entry) => (typeof entry === 'string' ? entry : str(asObject(entry), 'id')))
    .filter((id): id is string => id !== undefined && id.length > 0);
}

function parseNumImages(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value.trim()) || parsed < 1 || parsed > 4) {
    throw CliError.usage(`Invalid --num-images value '${value}' — expected an integer between 1 and 4.`);
  }
  return parsed;
}

function parseModelParams(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw CliError.usage(`Invalid --model-params '${value}' — expected a JSON object, e.g. '{"style":"photo"}'.`);
  }
}

/**
 * Resolve one media input to what the server accepts: a `file_` ref or an http(s) URL
 * pass through; a local path is uploaded first so the media lane sees a durable ref.
 */
async function mediaInput(input: string, client: ApiClient): Promise<string> {
  if (/^file_[0-9A-Za-z]+$/.test(input)) return input;
  if (input.startsWith('http://') || input.startsWith('https://')) return input;
  if (!existsSync(input)) {
    throw CliError.usage(`'${input}' is not a file_ ref, an http(s) URL, or an existing local path.`);
  }
  const form = new FormData();
  form.append('file', Bun.file(input), input.split('/').at(-1) ?? 'upload');
  const response = await client.request({ method: 'POST', path: endpoints.uploads(), formData: form, timeoutMs: 300_000 });
  const body = asObject(response.body);
  const fileId = str(body, 'id') ?? str(body, 'file_id') ?? str(asObject(body.file), 'id');
  if (fileId === undefined) {
    throw new CliError({ type: 'upstream_error', code: 'upload_failed', message: 'Upload returned no file id.', source: 'api' });
  }
  return fileId;
}

async function mediaInputs(inputs: string[], client: ApiClient): Promise<string[]> {
  const resolved: string[] = [];
  for (const input of inputs) resolved.push(await mediaInput(input, client));
  return resolved;
}

async function mediaCall(
  client: ApiClient,
  inv: Invocation,
  operation: string,
  path: string,
  payload: Record<string, unknown>,
  output: string | undefined,
): Promise<CommandOutcome> {
  const response = await client.request({
    method: 'POST',
    path,
    body: payload,
    idempotency: { command: operation, canvas: '', expectedRevision: undefined, payload: JSON.stringify(payload) },
  });
  const root = asObject(response.body);
  // Image verbs return `results[]`; video/upscale/remove-background return `result`.
  const results = Array.isArray(root.results) ? root.results.map(asObject) : [];
  const single = asObject(root.result);
  const first = results[0] ?? single;
  const artifactUrl = str(first, 'url');
  let downloaded: string | undefined;
  if (output !== undefined && artifactUrl !== undefined) {
    const bare = await fetch(artifactUrl, { signal: AbortSignal.timeout(120_000) });
    if (bare.ok) {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, new Uint8Array(await bare.arrayBuffer()));
      downloaded = output;
    } else {
      inv.note(`artifact download failed (HTTP ${bare.status}) — the file ref remains usable.`);
    }
  }
  return {
    body: {
      ok: true,
      operation,
      metered: true,
      ...root,
      ...(downloaded !== undefined ? { output: downloaded } : {}),
      meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
    },
    human: (write) => {
      const usage = asObject(root.usage);
      const ids = (results.length > 0 ? results : [single])
        .map((r) => str(r, 'id'))
        .filter((id): id is string => id !== undefined);
      write(
        `${operation}: done${ids.length > 0 ? ` — ${ids.join(', ')}` : ''}` +
          ` (metered${typeof usage.model === 'string' ? `, model: ${usage.model}` : ''})`,
      );
      // Read-before-describe surface: snapping adjustments, warnings, and checkpoint resumes.
      // adjustments is an object on some verbs and a LIST of entries on others (upscale-video).
      if (Array.isArray(root.adjustments)) {
        for (const entry of root.adjustments) {
          write(`adjusted: ${typeof entry === 'string' ? entry : JSON.stringify(entry)}`);
        }
      } else {
        for (const [key, value] of Object.entries(asObject(root.adjustments))) {
          write(`adjusted ${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
        }
      }
      const warnings = Array.isArray(root.warnings) ? root.warnings : [];
      for (const warning of warnings) {
        const obj = asObject(warning);
        write(`warning: ${str(obj, 'message') ?? (typeof warning === 'string' ? warning : JSON.stringify(warning))}`);
      }
      if (root.resumed_provider_job === true) {
        write('(resumed the existing provider render for this idempotency key — no duplicate charge)');
      }
      if (downloaded !== undefined) write(`artifact → ${downloaded}`);
    },
    exitCode: EXIT_OK,
  };
}
