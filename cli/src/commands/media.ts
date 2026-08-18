/**
 * `moda media` — raw metered media operations (cli.md §11, Option A grammar). Always labeled
 * `metered: true`; model is an explicit parameter (frontend selector choices, `media models`).
 *
 * Server contracts: backend/app/api/public/routers/media.py — inputs are `file_` ids or
 * http(s) URLs (`img_*` agent refs are rejected); image verbs return `results[]`, single-artifact
 * verbs return `result`; every response carries the metered usage receipt.
 */
import { accessSync, constants, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import type { ApiClient } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { asObject, num, str, strArray, type JsonObject } from '../api/types.ts';
import { CliError, rethrowRoutePredates, type CliErrorFields } from '../cliError.ts';
import { EXIT_OK, exitCodeForError } from '../output/exitCodes.ts';
import { alert, type CommandOutcome } from '../output/emit.ts';
import { PREVIEW_ITEMS, writeResultFile } from '../output/resultFile.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction, type Invocation } from './runtime.ts';
import { parseSize } from './canvasShared.ts';
import { detectImageFormat, resolveScreenshotPath } from './screenshotFiles.ts';

const MEDIA_TIMEOUT_MS = 600_000;
/** A frame read decodes an existing file — it never waits on a provider render. */
const FRAMES_TIMEOUT_MS = 120_000;
/** Server bounds (backend app/core/utils/video_frames.py MIN/MAX_FRAME_COUNT). */
const MIN_FRAME_COUNT = 1;
const MAX_FRAME_COUNT = 8;

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
      .option('-o, --output <path>', 'download artifacts: a file path, or a directory (also used for --num-images > 1)'),
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
      return mediaCall(client, inv, 'media.generate-image', endpoints.mediaGenerateImage(), payload, opts.output as string | undefined);
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
      .option('-o, --output <path>', 'download artifacts: a file path, or a directory (also used for --num-images > 1)'),
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
      .description('generate a video (metered; the render runs inside this call unless --no-wait)')
      .requiredOption('--prompt <prompt>', 'generation prompt')
      .requiredOption('--model <model>', 'model id (see: moda media models)')
      .option('--image <ref>', 'first-frame image: file_ ref, URL, or local path')
      .option('--end-image <ref>', 'last-frame image: file_ ref, URL, or local path')
      .option('--reference <refs...>', 'reference images (reference-to-video models): file_ refs, URLs, or local paths')
      .option(
        '--reference-video <refs...>',
        "reference clips (models whose card shows 'ref videos'): file_ refs, URLs, or local paths — " +
          "count and length caps are per-model; the input's own running time is billed on top",
      )
      .option(
        '--reference-audio <refs...>',
        "reference audio (models whose card shows 'ref audio'): file_ refs, URLs, or local paths",
      )
      .option('--duration <seconds>', 'clip duration — ALWAYS pass one; it is the dominant cost driver')
      .option('--aspect-ratio <ratio>', 'aspect ratio, e.g. 16:9')
      .option('--resolution <res>', "per-model resolution tier (see the model's capability line)")
      .option('--generate-audio', 'generate native audio (models that support it) — already the default')
      .option(
        '--no-generate-audio',
        "render silent — on Kling 3 Standard/Pro audio is a price axis and silence is a third cheaper. " +
          "Models whose card reads 'audio always on' have intrinsic audio: they accept this, report it as " +
          'an adjustment, and produce audio anyway',
      )
      .option('--seed <n>', 'deterministic seed', (v: string) => Number.parseInt(v, 10))
      .option('--model-params <json>', 'per-model extra params as a JSON object', parseModelParams)
      .option(
        '--no-wait',
        'submit the render and return a task_id immediately instead of holding the call open for ' +
          'minutes — poll it with `moda task status TASK_REF [--wait]`. Nothing is charged until a ' +
          'poll collects the finished video, and every input must be a file_ ref or a local path ' +
          '(no http(s) URLs). This is how you run several drafts at once',
      )
      .option('-o, --output <path>', 'download artifacts: a file path, or a directory (also used for --num-images > 1)'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const background = opts.wait === false;
      if (background) rejectRemoteInputsForBackground(opts);
      const { client } = await authedClient(inv, background ? FRAMES_TIMEOUT_MS : MEDIA_TIMEOUT_MS);
      const payload = {
        prompt: opts.prompt as string,
        model: opts.model as string,
        ...(typeof opts.image === 'string' ? { start_image: await mediaInput(opts.image, client) } : {}),
        ...(typeof opts.endImage === 'string' ? { end_image: await mediaInput(opts.endImage, client) } : {}),
        ...(Array.isArray(opts.reference)
          ? { reference_images: await mediaInputs(opts.reference as string[], client) }
          : {}),
        // Per-model clip-count and length caps are enforced server-side and named back in the 422,
        // so nothing is capped here — a client-side number would drift the moment a model is added.
        ...(Array.isArray(opts.referenceVideo)
          ? { reference_videos: await mediaInputs(opts.referenceVideo as string[], client) }
          : {}),
        ...(Array.isArray(opts.referenceAudio)
          ? { reference_audios: await mediaInputs(opts.referenceAudio as string[], client) }
          : {}),
        // Schema: duration_seconds is float|str — numeric strings travel as numbers, model
        // enums like "8s" pass through verbatim for the server to resolve.
        ...(typeof opts.duration === 'string'
          ? { duration_seconds: Number.isFinite(Number(opts.duration)) ? Number(opts.duration) : opts.duration }
          : {}),
        ...(typeof opts.aspectRatio === 'string' ? { aspect_ratio: opts.aspectRatio } : {}),
        ...(typeof opts.resolution === 'string' ? { resolution: opts.resolution } : {}),
        // Commander pairs --generate-audio with --no-generate-audio: true / false / undefined when
        // neither is passed (last flag wins if both are). Only a boolean travels — omitting the key
        // leaves the server on the model's own default, which is not the same as sending false.
        ...(typeof opts.generateAudio === 'boolean' ? { generate_audio: opts.generateAudio } : {}),
        ...(typeof opts.seed === 'number' && Number.isFinite(opts.seed) ? { seed: opts.seed } : {}),
        ...(opts.modelParams !== undefined ? { model_params: opts.modelParams } : {}),
        // Sent ONLY to ask for the background lane. `wait: true` is the server default, and the
        // request model forbids unknown fields — a server predating #9603 would 422 on the key
        // even when it carries the value it already implements.
        ...(background ? { wait: false } : {}),
      };
      if (background) {
        // `-o` names a file for an artifact that does not exist yet. Silently ignoring it would
        // leave a run believing the clip is on disk; say where the file actually comes from.
        if (typeof opts.output === 'string') {
          inv.note('--no-wait has no artifact to download yet — collect it first, then: moda file download FILE_REF -o …');
        }
        return startBackgroundVideo(client, inv, payload);
      }
      return mediaCall(client, inv, 'media.generate-video', endpoints.mediaGenerateVideo(), payload, opts.output as string | undefined);
    }),
  );

  addGlobalFlags(
    media
      .command('video-frames [ref_or_path]')
      .description('sample still frames from a video and LOOK at them (free) — closes the generate loop')
      .option('--source <ref_or_path>', 'the video as a flag instead of the positional — same accepted values')
      .option('--count <n>', `frames sampled evenly across the clip, ${MIN_FRAME_COUNT}-${MAX_FRAME_COUNT} (default 4; first and last always included)`, parseFrameCount)
      .option(
        '--timestamps <ms...>',
        `exact moments to sample, in milliseconds — space-separated or comma-separated, max ` +
          `${MAX_FRAME_COUNT} (e.g. --timestamps 0 2500 4999). Read them off the duration_ms a ` +
          'previous call reported. Out-of-range values clamp to the clip. Cannot be combined with --count',
        parseTimestampMs,
      )
      .option('-o, --output <path>', 'write the frames to disk: output file (single frame) or directory'),
  )
    .addHelpText(
      'after',
      '\nExamples:\n  moda media video-frames file_123\n  moda media video-frames file_123 --count 6 -o frames/\n  moda media video-frames file_123 --timestamps 0 2500 -o frames/\n\nFree, and the only way to see what a generated clip contains — a file_ ref is\nnot an image. An empty frames list means Moda could not DECODE the file, not\nthat the video is bad: never regenerate on it. Canvas pages: moda canvas\nscreenshot.\n',
    )
    .action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, FRAMES_TIMEOUT_MS);
      return performVideoFrames(client, inv, {
        input: singleMediaRef(args, opts, 'video-frames', 'video'),
        count: opts.count as number | undefined,
        timestampsMs: opts.timestamps as number[] | undefined,
        output: opts.output as string | undefined,
      });
    }),
  );

  addGlobalFlags(
    media
      .command('upscale [ref_or_path]')
      .description('upscale an image 2x or 4x (metered); accepts a file_ ref, URL, or local path')
      .option('--source <ref_or_path>', 'the image as a flag instead of the positional — same accepted values')
      .option('--scale <n>', 'upscale factor: 2 or 4', (v: string) => Number.parseInt(v, 10))
      .option('-o, --output <path>', 'download artifacts: a file path, or a directory (also used for --num-images > 1)'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MEDIA_TIMEOUT_MS);
      const image = await mediaInput(singleMediaRef(args, opts, 'upscale', 'image'), client);
      const payload = { image, ...(typeof opts.scale === 'number' ? { scale: opts.scale } : {}) };
      return mediaCall(client, inv, 'media.upscale', endpoints.mediaUpscale(), payload, opts.output as string | undefined);
    }),
  );

  addGlobalFlags(
    media
      .command('upscale-video [ref_or_path]')
      .description('upscale a video (metered); accepts a file_ ref, URL, or local path')
      .option('--source <ref_or_path>', 'the video as a flag instead of the positional — same accepted values')
      .option('--resolution <res>', 'target resolution: 720p | 1080p | 1440p | 2160p')
      .option('-o, --output <path>', 'download artifacts: a file path, or a directory (also used for --num-images > 1)'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MEDIA_TIMEOUT_MS);
      const video = await mediaInput(singleMediaRef(args, opts, 'upscale-video', 'video'), client);
      // Wire field is target_resolution (extra=forbid server-side); the flag stays --resolution.
      const payload = { video, ...(typeof opts.resolution === 'string' ? { target_resolution: opts.resolution } : {}) };
      try {
        return await mediaCall(client, inv, 'media.upscale-video', endpoints.mediaUpscaleVideo(), payload, opts.output as string | undefined);
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
      .command('remove-background [ref_or_path]')
      .description('remove an image background (metered); result is a new transparent PNG')
      .option('--source <ref_or_path>', 'the image as a flag instead of the positional — same accepted values')
      .option('--high-quality', 'use the high-quality matting model')
      .option('-o, --output <path>', 'download artifacts: a file path, or a directory (also used for --num-images > 1)'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MEDIA_TIMEOUT_MS);
      const image = await mediaInput(singleMediaRef(args, opts, 'remove-background', 'image'), client);
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
 * One `--model-params` control, rendered with the values a caller can actually pass.
 *
 * Printing the bare control id told a reader a knob exists and nothing else — not its legal
 * values, not its default — so constructing `--model-params` meant guessing, and every guess
 * costs credits on a metered verb.
 *
 * Two live shapes: a `select` carries `options: [{value, label}]` plus a scalar `default`
 * (`quality`, `rendering_speed`), while an open-valued control has `options: null` and a cap
 * (`colors`: `color_list`, `max_items: 5`). An open control cannot be enumerated, so it reports
 * its type and cap instead — the most a caller can be told.
 */
export function controlSpec(entry: unknown): string {
  // The envelope already mixes shapes here: an older server sends bare id strings, for which the
  // id IS everything known. Keep rendering those verbatim rather than inventing a type for them.
  if (typeof entry === 'string') return entry;
  const control = asObject(entry);
  const id = str(control, 'id') ?? '?';
  const options = (Array.isArray(control.options) ? control.options : [])
    .map((option) => (typeof option === 'string' ? option : str(asObject(option), 'value')))
    .filter((value): value is string => value !== undefined && value.length > 0);
  if (options.length > 0) {
    const fallback = control.default;
    const defaultText = typeof fallback === 'string' && fallback.length > 0 ? ` (default ${fallback})` : '';
    return `${id}=${options.join('|')}${defaultText}`;
  }
  const maxItems = num(control, 'max_items');
  return `${id}:${str(control, 'type') ?? 'value'}${maxItems !== undefined ? ` (max ${maxItems})` : ''}`;
}

/**
 * The custom-dimension envelope as one compact range — what you need to size a generation to a
 * canvas. Rendered only when the payload states a full width AND height range; `step` shows only
 * when it constrains (gpt-image-2 steps by 16, so 1000px is not a legal width).
 */
export function sizeSpec(value: unknown): string | undefined {
  const dimensions = asObject(value);
  const minWidth = num(dimensions, 'min_width');
  const maxWidth = num(dimensions, 'max_width');
  const minHeight = num(dimensions, 'min_height');
  const maxHeight = num(dimensions, 'max_height');
  if (minWidth === undefined || maxWidth === undefined || minHeight === undefined || maxHeight === undefined) {
    return undefined;
  }
  const step = num(dimensions, 'step');
  return `size ${minWidth}-${maxWidth}x${minHeight}-${maxHeight}${step !== undefined && step > 1 ? ` step ${step}` : ''}`;
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
  const controls = (Array.isArray(model.controls) ? model.controls : []).map(controlSpec);
  if (controls.length > 0) caps.push(`params ${controls.join(', ')}`);
  const size = sizeSpec(model.custom_dimensions);
  if (size !== undefined) caps.push(size);
  const outputFormat = str(model, 'output_format');
  if (outputFormat !== undefined) caps.push(`out ${outputFormat}`);
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
    // `generate_audio_controllable: false` means audio is INTRINSIC — a request to disable it is
    // accepted, reported as an adjustment, and produces audio anyway. Rendering that as the same
    // "on by default" the controllable models get is what sends a run hunting for a knob that
    // cannot exist (and, where audio is a price axis, for a cheaper rate it can never reach).
    // A server that predates the field says nothing, so only an explicit false changes the text.
    caps.push(
      model.generate_audio_controllable === false
        ? 'audio always on'
        : `audio yes (${model.generate_audio_default === true ? 'on' : 'off'} by default)`,
    );
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

/**
 * `moda media video-frames` — the verify lane (server: POST /v1/media/video-frames, studio #9603).
 *
 * A READ, not a generation: uncharged (`usage.class: "deterministic"`), nothing is minted in the
 * team's library, and the frames come back inline as JPEG data URLs the way the canvas screenshot
 * lane returns page captures. It exists because every generate verb hands back a `file_` ref no
 * model can see; this is the only verb on the surface that returns pixels of a video.
 */
export async function performVideoFrames(
  client: ApiClient,
  inv: Invocation,
  options: { input: string; count?: number; timestampsMs?: number[]; output?: string },
): Promise<CommandOutcome> {
  if (options.count !== undefined && options.timestampsMs !== undefined) {
    // The server rejects the pair (422) rather than picking one; fail it locally with the reason,
    // before spending a round trip (and before a local path uploads itself).
    throw CliError.usage(
      'Pass --count OR --timestamps, not both.',
      'An explicit list of moments is its own count — drop --count.',
    );
  }
  // Team files only. The generate verbs take a remote URL because a render needs source footage;
  // a frame READ that took one would be an open decode-anything-on-the-internet endpoint, so the
  // server refuses it (422). Say that here rather than spending the round trip to hear it.
  if (options.input.startsWith('http://') || options.input.startsWith('https://')) {
    throw CliError.usage(
      `video-frames reads team files only — '${options.input}' is a URL.`,
      'Bring it into the library first: moda file upload --from-url URL (or pass a local path, which uploads itself).',
    );
  }
  const video = await mediaInput(options.input, client);
  // Wire field is `video`, matching the connector tool's argument and the `upscale-video`
  // sibling — the request model is `extra="forbid"`, so the name is not a tolerant guess.
  const payload = {
    video,
    ...(options.count !== undefined ? { count: options.count } : {}),
    ...(options.timestampsMs !== undefined ? { timestamps_ms: options.timestampsMs } : {}),
  };
  const response = await client
    .request({ method: 'POST', path: endpoints.mediaVideoFrames(), body: payload, timeoutMs: FRAMES_TIMEOUT_MS })
    .catch((err: unknown) =>
      rethrowRoutePredates(
        err,
        'This server predates the video-frames endpoint.',
        'It ships with the next backend deploy; until then read applied/adjustments/warnings and say the visual check is outstanding.',
      ),
    );
  const root = asObject(response.body);
  const videoInfo = asObject(root.video);
  const frames = (Array.isArray(root.frames) ? root.frames : []).map(asObject);
  const warnings = Array.isArray(root.warnings) ? root.warnings.map(asObject) : [];
  const written = options.output !== undefined ? writeFrames(frames, options.output, inv) : [];
  const durationMs = num(videoInfo, 'duration_ms');
  const width = num(videoInfo, 'width');
  const height = num(videoInfo, 'height');
  const hasAudio = videoInfo.has_audio;
  return {
    body: {
      ok: true,
      operation: 'media.video_frames',
      // Free by contract — the receipt says `deterministic`, and nothing here burns credits.
      metered: false,
      ...root,
      ...(written.length > 0 ? { output: written.map((frame) => frame.path) } : {}),
      meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
    },
    human: (write) => {
      const facts = [
        durationMs !== undefined ? `${(durationMs / 1000).toFixed(1)}s` : 'duration unknown',
        width !== undefined && height !== undefined ? `${width}x${height}` : 'size unknown',
        typeof hasAudio === 'boolean' ? `audio: ${hasAudio ? 'yes' : 'no'}` : 'audio unknown',
      ];
      write(`${frames.length} frame(s) — ${facts.join(' · ')} (free)`);
      // The moments themselves, so a follow-up --timestamps ask is written off real numbers.
      if (frames.length > 0 && written.length === 0) {
        write(`frames at: ${frames.map((frame) => frameSeconds(frame)).join(', ')}`);
      }
      for (const frame of written) write(`${frame.label} → ${frame.path}`);
      for (const warning of warnings) {
        write(`warning: ${str(warning, 'message') ?? str(warning, 'code') ?? JSON.stringify(warning)}`);
      }
      if (frames.length > 0 && options.output === undefined) {
        // Without -o the bytes stay in the JSON envelope, which no terminal reader can see. Say
        // where to send them rather than letting a run conclude "verified" from a summary line.
        write('(re-run with -o DIR to write the frames and LOOK at them)');
      }
    },
    exitCode: EXIT_OK,
  };
}

function frameSeconds(frame: JsonObject): string {
  const ms = num(frame, 'timestamp_ms');
  return ms !== undefined ? `${(ms / 1000).toFixed(1)}s` : '?';
}

/**
 * Write the sampled frames to disk with the screenshot lane's naming rules: `-o` is the output
 * FILE when the strip holds exactly one frame, and a directory otherwise (`0500ms.jpg`, sorted
 * by name because the timestamp is zero-padded). Format comes from the bytes, not the extension.
 */
function writeFrames(
  frames: JsonObject[],
  output: string,
  inv: Invocation,
): { label: string; path: string }[] {
  const written: { label: string; path: string }[] = [];
  frames.forEach((frame, index) => {
    const dataUrl = str(frame, 'data_url');
    if (dataUrl === undefined) return;
    const comma = dataUrl.indexOf(',');
    const bytes = new Uint8Array(Buffer.from(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, 'base64'));
    const format = detectImageFormat({
      bytes,
      declaredFormat: str(frame, 'mime_type'),
      dataUrlMime: comma >= 0 ? /^data:([^;,]+)/.exec(dataUrl)?.[1] : undefined,
    });
    const ms = num(frame, 'timestamp_ms');
    const label = ms !== undefined ? `${String(ms).padStart(6, '0')}ms` : `frame-${index + 1}`;
    const named = resolveScreenshotPath({
      format,
      explicitPath: frames.length === 1 ? output : undefined,
      stem: join(output, label),
    });
    if (named.warning !== undefined) inv.note(named.warning);
    mkdirSync(dirname(named.path), { recursive: true });
    writeFileSync(named.path, bytes);
    written.push({ label, path: named.path });
  });
  return written;
}

/**
 * `--no-wait` start: the render is submitted and the call returns a task handle instead of
 * holding the request open for the whole render. Nothing is charged here — the charge lands on
 * the poll that collects the finished video, so an abandoned task costs nothing.
 */
async function startBackgroundVideo(
  client: ApiClient,
  inv: Invocation,
  payload: Record<string, unknown>,
): Promise<CommandOutcome> {
  const response = await client
    .request({
      method: 'POST',
      path: endpoints.mediaGenerateVideo(),
      body: payload,
      idempotency: {
        // Frozen pre-rename spelling — see FROZEN_IDEMPOTENCY_COMMAND above.
        command: 'media.generate_video',
        canvas: '',
        expectedRevision: undefined,
        payload: JSON.stringify(payload),
      },
      timeoutMs: FRAMES_TIMEOUT_MS,
    })
    // A server predating #9603 rejects the unknown `wait` key with a 422 (the request model
    // forbids extras) rather than a route 404 — so rethrowRoutePredates cannot see it. Name the
    // real cause only when the rejection is actually about this field.
    .catch((err: unknown) => {
      throw backgroundUnsupported(err);
    });
  const root = asObject(response.body);
  const taskId = str(root, 'task_id');
  const retryAfterMs = num(root, 'retry_after_ms');
  return {
    body: {
      ok: true,
      operation: 'media.generate-video',
      metered: true,
      ...root,
      meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
    },
    human: (write) => {
      write(
        `render started: ${taskId ?? '(no task id)'} (${str(root, 'status') ?? 'queued'}` +
          `${retryAfterMs !== undefined ? `, poll in ~${Math.round(retryAfterMs / 1000)}s` : ''})`,
      );
      write(`nothing charged yet — collect it: moda task status ${taskId ?? 'TASK_REF'} --wait`);
      for (const entry of Array.isArray(root.adjustments) ? root.adjustments : []) {
        write(`adjusted: ${typeof entry === 'string' ? entry : JSON.stringify(entry)}`);
      }
    },
    exitCode: EXIT_OK,
  };
}

/** Re-throw a `--no-wait` rejection, naming the server-predates cause when that is what it is. */
function backgroundUnsupported(err: unknown): unknown {
  if (!(err instanceof CliError) || err.fields.status !== 422 || err.fields.hint !== undefined) return err;
  const evidence = `${err.fields.message} ${JSON.stringify(err.fields.details ?? {})}`;
  if (!/\bwait\b/.test(evidence)) return err;
  return new CliError({
    ...err.fields,
    hint: 'This server predates background video renders — drop --no-wait and let the render run inside the call.',
  });
}

/**
 * `--no-wait` takes durable inputs only. Collection re-resolves the inputs minutes later, and a
 * remote URL can expire, rotate, or serve different bytes by then — so the server refuses one
 * (422). Local paths are fine: they upload themselves to a `file_` ref before the call.
 */
function rejectRemoteInputsForBackground(opts: Record<string, unknown>): void {
  const inputs = [
    opts.image,
    opts.endImage,
    ...(Array.isArray(opts.reference) ? opts.reference : []),
    ...(Array.isArray(opts.referenceVideo) ? opts.referenceVideo : []),
    ...(Array.isArray(opts.referenceAudio) ? opts.referenceAudio : []),
  ].filter((value): value is string => typeof value === 'string');
  const remote = inputs.filter((value) => value.startsWith('http://') || value.startsWith('https://'));
  if (remote.length === 0) return;
  throw CliError.usage(
    `--no-wait takes durable inputs only, but ${remote.join(', ')} ${remote.length === 1 ? 'is' : 'are'} a remote URL.`,
    'A background render re-resolves its inputs when it is collected, and a URL can change by then. ' +
      'Upload them first (moda file upload --from-url URL) and pass the file_ refs, or drop --no-wait.',
  );
}

function parseFrameCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value.trim()) || parsed < MIN_FRAME_COUNT || parsed > MAX_FRAME_COUNT) {
    throw CliError.usage(
      `Invalid --count value '${value}' — expected an integer between ${MIN_FRAME_COUNT} and ${MAX_FRAME_COUNT}.`,
    );
  }
  return parsed;
}

/**
 * Variadic collector: commander calls this once per value with the accumulated list.
 *
 * A comma-separated list is accepted too. The flag name is plural, so `--timestamps 0,2500` is
 * the obvious first attempt, and rejecting it taught the reader nothing — milliseconds cannot
 * contain a comma, so there is no ambiguity in taking it. The refusal that remains (a genuinely
 * non-numeric value) now names both working forms instead of only restating the requirement.
 */
export function parseTimestampMs(value: string, previous: number[] | undefined): number[] {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part))) {
    throw CliError.usage(
      `Invalid --timestamps value '${value}' — expected whole numbers of milliseconds.`,
      'Pass several moments as separate values or one comma-separated list: ' +
        '--timestamps 0 2500 4999, or --timestamps 0,2500,4999',
    );
  }
  const list = [...(previous ?? []), ...parts.map((part) => Number.parseInt(part, 10))];
  if (list.length > MAX_FRAME_COUNT) {
    throw CliError.usage(
      `--timestamps takes at most ${MAX_FRAME_COUNT} moments.`,
      `Sample ${MAX_FRAME_COUNT} or fewer, or use --count ${MAX_FRAME_COUNT} to spread them evenly across the clip.`,
    );
  }
  return list;
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
 * ENG-4997: the media group carried two spellings for one concept — `--source` on the
 * multi-input verbs (generate-image, edit-image), a bare positional on the single-input ones.
 * An agent that learns the flag reaches for it on the others and gets `unknown option`. The
 * positional stays canonical; `--source` is an accepted alias. Exactly one of the two — both
 * at once is a contradiction, not a precedence puzzle to resolve silently.
 */
function singleMediaRef(args: unknown[], opts: Record<string, unknown>, verb: string, noun: string): string {
  const positional = typeof args[0] === 'string' ? args[0] : undefined;
  const flag = typeof opts.source === 'string' ? opts.source : undefined;
  if (positional !== undefined && flag !== undefined) {
    throw CliError.usage(
      `'media ${verb}' got the ${noun} twice: once positionally and once as --source.`,
      `Pass it once — moda media ${verb} <ref_or_path> (--source <ref_or_path> is the same thing).`,
    );
  }
  const ref = positional ?? flag;
  if (ref === undefined) {
    throw CliError.usage(
      `'media ${verb}' needs the ${noun} to operate on.`,
      `moda media ${verb} <ref_or_path> (or --source <ref_or_path>) — a file_ ref, an http(s) URL, or a local path.`,
    );
  }
  return ref;
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
  // Basename-reduced like `file upload` — `basename` follows the HOST separator, so a Windows
  // path never ships `C:\Users\…` as the uploaded filename (a separator forks the storage key).
  form.append('file', Bun.file(input), basename(input) || 'upload');
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

/** Extension for a returned artifact. Results declare `mime_type`; `name` is the fallback. */
const EXTENSION_FOR_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

function artifactExtension(artifact: JsonObject): string {
  const mime = str(artifact, 'mime_type');
  const known = mime !== undefined ? EXTENSION_FOR_MIME[mime.toLowerCase()] : undefined;
  if (known !== undefined) return known;
  const name = str(artifact, 'name');
  const dot = name !== undefined ? name.lastIndexOf('.') : -1;
  return dot > 0 ? name!.slice(dot + 1) : 'bin';
}

/** True when `--output` names a directory: it exists as one, or is written with a trailing separator. */
function outputIsDirectory(output: string): boolean {
  if (output.endsWith('/') || output.endsWith(sep)) return true;
  return statSync(output, { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * Prepare `--output` BEFORE the metered call. A directory passed where a file was expected, or a
 * missing parent, used to surface as a raw `EISDIR`/`ENOENT` from `writeFileSync` AFTER the
 * provider had run and the team had been billed (ENG-5034). Checking first makes the common
 * mistakes fail free.
 */
function preflightOutputPath(output: string): void {
  const dir = outputIsDirectory(output) ? output : dirname(output);
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch (err) {
    throw CliError.io(
      `--output path is not writable: ${output} (${err instanceof Error ? err.message : String(err)})`,
      'Pass a writable file path, or a directory to receive the artifacts.',
    );
  }
}

/**
 * Download every returned artifact. One artifact to a file path keeps the exact path given; several
 * artifacts (`--num-images > 1`), or an `--output` that names a directory, land inside it as
 * `<file_id>.<ext>` — the file-or-directory rule `canvas screenshot` already follows.
 *
 * Previously only `results[0]` was fetched, so `--num-images 4` billed for four images and wrote
 * one (ENG-5033).
 */
async function downloadArtifacts(artifacts: JsonObject[], output: string, inv: Invocation): Promise<string[]> {
  const intoDirectory = outputIsDirectory(output);
  const written: string[] = [];
  for (const [index, artifact] of artifacts.entries()) {
    const url = str(artifact, 'url');
    if (url === undefined) continue;
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      inv.note(`artifact download failed (HTTP ${response.status}) — the file ref remains usable.`);
      continue;
    }
    const extension = artifactExtension(artifact);
    let target: string;
    if (intoDirectory) {
      target = join(output, `${str(artifact, 'id') ?? `artifact-${index + 1}`}.${extension}`);
    } else if (artifacts.length === 1) {
      target = output;
    } else {
      // Several artifacts, but `--output` names a FILE: number off its stem rather than turning
      // `city.png` into a directory called `city.png`.
      const base = basename(output);
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? output.slice(0, output.length - (base.length - dot)) : output;
      target = `${stem}-${index + 1}.${dot > 0 ? base.slice(dot + 1) : extension}`;
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, new Uint8Array(await response.arrayBuffer()));
    } catch (err) {
      // Never a `cli_internal`: a bad path is the caller's input, not a CLI defect.
      throw CliError.io(
        `could not write ${target}: ${err instanceof Error ? err.message : String(err)}`,
        'Pass a writable file path, or a directory to receive the artifacts.',
      );
    }
    written.push(target);
  }
  return written;
}

/**
 * Idempotency keys hash the command string (`api/idempotency.ts`), so an identical re-run only
 * replays — and avoids a second charge — while that string stays byte-stable. The operation
 * labels these verbs PRINT were renamed in ENG-5011; these key strings are internal, never shown,
 * and are deliberately frozen at their pre-rename spelling so the rename cannot turn a replay
 * into a fresh paid render. Do not "tidy" them to match the labels.
 *
 * (These are also the only idempotency commands in the CLI not spelled as the CLI verb — every
 * other verb passes e.g. 'canvas markup'. Reconciling that is a separate, billing-visible change.)
 */
const FROZEN_IDEMPOTENCY_COMMAND: Record<string, string> = {
  'media.generate-image': 'media.generate_image',
  'media.generate-video': 'media.generate_video',
  'media.upscale-video': 'media.upscale_video',
};

async function mediaCall(
  client: ApiClient,
  inv: Invocation,
  operation: string,
  path: string,
  payload: Record<string, unknown>,
  output: string | undefined,
): Promise<CommandOutcome> {
  // Fail free on an unusable output path rather than after the provider has billed.
  if (output !== undefined) preflightOutputPath(output);
  const response = await client.request({
    method: 'POST',
    path,
    body: payload,
    idempotency: {
      command: FROZEN_IDEMPOTENCY_COMMAND[operation] ?? operation,
      canvas: '',
      expectedRevision: undefined,
      payload: JSON.stringify(payload),
    },
  });
  const root = asObject(response.body);
  // Image verbs return `results[]`; video/upscale/remove-background return `result`.
  const results = Array.isArray(root.results) ? root.results.map(asObject) : [];
  const single = asObject(root.result);
  const artifacts = results.length > 0 ? results : str(single, 'url') !== undefined ? [single] : [];
  let downloaded: string[] = [];
  /**
   * A write failure AFTER a metered call must not discard the response: the provider has run and
   * the team has been billed, so the `file_` refs are the only route back to work already paid for
   * (`moda file download`). Exit nonzero — the caller asked for a local file and there is none, so
   * `… && next-step` must halt — but carry `results`/`usage` in the envelope as recovery data
   * rather than a claim of success (ENG-5034).
   */
  let writeError: CliErrorFields | undefined;
  if (output !== undefined && artifacts.length > 0) {
    try {
      downloaded = await downloadArtifacts(artifacts, output, inv);
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      writeError = err.fields;
    }
  }
  return {
    body: {
      ok: writeError === undefined,
      operation,
      metered: true,
      ...root,
      ...(downloaded.length === 1 ? { output: downloaded[0] } : {}),
      ...(downloaded.length > 1 ? { outputs: downloaded } : {}),
      ...(writeError !== undefined ? { error: writeError } : {}),
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
      for (const file of downloaded) write(`artifact → ${file}`);
      if (writeError !== undefined) {
        // The refs above are the recovery route; say so plainly rather than leaving a bare fs error.
        alert(
          `⚠ the artifacts were generated and billed, but could not be saved: ${writeError.message} — ` +
            'recover them with: moda file download FILE_REF -o …',
        );
      }
    },
    exitCode: writeError === undefined ? EXIT_OK : exitCodeForError(writeError),
  };
}
