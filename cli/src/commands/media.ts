/**
 * `moda media` — raw metered media operations (cli.md §11, Option A grammar). Always labeled
 * `metered: true`; model is an explicit parameter (frontend selector choices, `media models`).
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

const MEDIA_TIMEOUT_MS = 600_000;

export function registerMedia(program: Command): void {
  const media = program.command('media').description('metered media generation — burns Moda credits, receipts on every response');

  addGlobalFlags(
    media
      .command('generate-image')
      .description('generate an image (metered)')
      .requiredOption('--prompt <prompt>', 'generation prompt')
      .requiredOption('--model <model>', 'model id (see: moda media models)')
      .option('--size <WxH>', 'output size hint')
      .option('-o, --output <path>', 'download the artifact to a local file'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MEDIA_TIMEOUT_MS);
      const payload = {
        prompt: opts.prompt as string,
        model: opts.model as string,
        ...(typeof opts.size === 'string' ? { size: opts.size } : {}),
      };
      return mediaCall(client, inv, 'media.generate_image', endpoints.mediaGenerateImage(), payload, opts.output as string | undefined);
    }),
  );

  addGlobalFlags(
    media
      .command('generate-video')
      .description('generate a video (metered)')
      .requiredOption('--prompt <prompt>', 'generation prompt')
      .requiredOption('--model <model>', 'model id (see: moda media models)')
      .option('--image <file_id>', 'first-frame image ref')
      .option('-o, --output <path>', 'download the artifact to a local file'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MEDIA_TIMEOUT_MS);
      const payload = {
        prompt: opts.prompt as string,
        model: opts.model as string,
        ...(typeof opts.image === 'string' ? { image_file_id: opts.image } : {}),
      };
      return mediaCall(client, inv, 'media.generate_video', endpoints.mediaGenerateVideo(), payload, opts.output as string | undefined);
    }),
  );

  addGlobalFlags(
    media
      .command('upscale <ref_or_path>')
      .description('upscale an image (metered); accepts a file_ ref or a local path (auto-uploads)')
      .option('--model <model>', 'model id')
      .option('-o, --output <path>', 'download the artifact to a local file'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MEDIA_TIMEOUT_MS);
      const fileId = await refOrUpload(args[0] as string, client);
      const payload = { file_id: fileId, ...(typeof opts.model === 'string' ? { model: opts.model } : {}) };
      return mediaCall(client, inv, 'media.upscale', endpoints.mediaUpscale(), payload, opts.output as string | undefined);
    }),
  );

  addGlobalFlags(
    media
      .command('upscale-video <ref_or_path>')
      .description('upscale a video (metered)')
      .option('--model <model>', 'model id')
      .option('-o, --output <path>', 'download the artifact to a local file'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MEDIA_TIMEOUT_MS);
      const fileId = await refOrUpload(args[0] as string, client);
      const payload = { file_id: fileId, ...(typeof opts.model === 'string' ? { model: opts.model } : {}) };
      return mediaCall(client, inv, 'media.upscale_video', endpoints.mediaUpscaleVideo(), payload, opts.output as string | undefined);
    }),
  );

  addGlobalFlags(
    media
      .command('remove-background <ref_or_path>')
      .description('remove an image background (metered)')
      .option('-o, --output <path>', 'download the artifact to a local file'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MEDIA_TIMEOUT_MS);
      const fileId = await refOrUpload(args[0] as string, client);
      return mediaCall(client, inv, 'media.remove_background', endpoints.mediaRemoveBackground(), { file_id: fileId }, opts.output as string | undefined);
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

/** Accept a `file_` ref directly, or a local path (uploaded first so the media lane sees a ref). */
async function refOrUpload(input: string, client: ApiClient): Promise<string> {
  if (/^file_[0-9A-Za-z]+$/.test(input)) return input;
  if (!existsSync(input)) {
    throw CliError.usage(`'${input}' is neither a file_ ref nor an existing local path.`);
  }
  const form = new FormData();
  form.append('file', Bun.file(input), input.split('/').at(-1) ?? 'upload');
  const response = await client.request({ method: 'POST', path: endpoints.uploads(), formData: form, timeoutMs: 300_000 });
  const body = asObject(response.body);
  const fileId = str(body, 'file_id') ?? str(asObject(body.file), 'id') ?? str(body, 'id');
  if (fileId === undefined) {
    throw new CliError({ type: 'upstream_error', code: 'upload_failed', message: 'Upload returned no file id.', source: 'api' });
  }
  return fileId;
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
  let downloaded: string | undefined;
  const artifactUrl = str(root, 'download_url') ?? str(root, 'artifact_url') ?? str(asObject(root.artifact), 'url');
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
      const fileId = str(root, 'file_id') ?? str(asObject(root.file), 'id');
      write(`${operation}: done${fileId !== undefined ? ` — ${fileId}` : ''} (metered_credits: ${usage.metered_credits ?? '?'})`);
      if (downloaded !== undefined) write(`artifact → ${downloaded}`);
    },
    exitCode: EXIT_OK,
  };
}
