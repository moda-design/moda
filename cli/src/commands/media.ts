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
      .option('--source <refs...>', 'images the prompt modifies/preserves: file_ refs, URLs, or local paths')
      .option('--reference <refs...>', 'style/subject references: file_ refs, URLs, or local paths')
      .option('-o, --output <path>', 'download the artifact to a local file'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MEDIA_TIMEOUT_MS);
      const size = typeof opts.size === 'string' ? parseSize(opts.size) : undefined;
      const payload = {
        prompt: opts.prompt as string,
        model: opts.model as string,
        ...(size !== undefined ? { width: size.width, height: size.height } : {}),
        ...(typeof opts.aspectRatio === 'string' ? { aspect_ratio: opts.aspectRatio } : {}),
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
      .option('-o, --output <path>', 'download the artifact to a local file'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MEDIA_TIMEOUT_MS);
      const payload = {
        prompt: opts.prompt as string,
        model: opts.model as string,
        ...(typeof opts.image === 'string' ? { start_image: await mediaInput(opts.image, client) } : {}),
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

  addGlobalFlags(media.command('models').description('available media models (the required --model values)')).action(
    wrapAction(async (_args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, 30_000);
      const response = await client.request({ method: 'GET', path: endpoints.mediaModels() });
      const root = asObject(response.body);
      return {
        body: {
          ok: true,
          operation: 'media.models',
          ...(Array.isArray(response.body) ? { models: response.body } : root),
          meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
        },
        exitCode: EXIT_OK,
      };
    }),
  );
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
      if (downloaded !== undefined) write(`artifact → ${downloaded}`);
    },
    exitCode: EXIT_OK,
  };
}
