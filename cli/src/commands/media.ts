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
import { asObject, str } from '../api/types.ts';
import { CliError } from '../cliError.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import type { CommandOutcome } from '../output/emit.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction, type Invocation } from './runtime.ts';
import { LIST_ALL_CAP, fetchListPages, listFlagsOf, listOutcome, parseListLimit, parseListOffset } from './listLane.ts';
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
    .addHelpText('after', '\nExample:\n  moda media generate-image --prompt "isometric city at dusk, warm light" --model MODEL -o city.png\n\nMetered. Not for: imagery the account already has (moda file search, brand\nkit assets via moda brand show) or icons (markup <image icon="query"/>) —\ngeneration is the LAST resort in the imagery routing order.\n')
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
      .description('upscale a video — not available: the public media lane has no upscale-video endpoint'),
  ).action(
    wrapAction(async () => {
      throw new CliError({
        type: 'unprocessable',
        code: 'not_available',
        message: 'Video upscaling has no public API endpoint — a recorded parity exception in the prototype.',
        hint: 'Upscale video in the Moda app; image upscaling is available: moda media upscale.',
        source: 'local',
      });
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
      .description('available media models (the required --model values)')
      .option('--limit <n>', 'page size', parseListLimit)
      .option('--offset <n>', 'pagination offset', parseListOffset)
      .option('--all', `fetch every page (bounded at ${LIST_ALL_CAP} items)`)
      .option('--output <file>', 'write the full payload to a file; stdout gets a small summary + preview'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const flags = listFlagsOf(opts);
      const { client } = await authedClient(inv, 30_000);
      const pages = await fetchListPages(client, endpoints.mediaModels(), {}, flags, 30_000);
      return listOutcome({
        operation: 'media.models',
        pages,
        flags,
        emptyHint: 'no models reported',
        itemLine: (model) => `${str(model, 'id') ?? str(model, 'name') ?? '?'}  ${str(model, 'name') ?? ''}`,
      });
    }),
  );
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
      const adjustments = asObject(root.adjustments);
      for (const [key, value] of Object.entries(adjustments)) {
        write(`adjusted ${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
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
