/** `moda file` — uploads (existing REST) and, from slice 3, the read-only files facade. */
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Command } from 'commander';
import { endpoints } from '../api/endpoints.ts';
import { asObject, str } from '../api/types.ts';
import { CliError } from '../cliError.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction } from './runtime.ts';

const UPLOAD_TIMEOUT_MS = 300_000;

export function registerFileUpload(program: Command): void {
  const file = program.command('file').description('Moda files: upload local files, browse the drive');

  addGlobalFlags(
    file
      .command('upload [paths...]')
      .description('upload files; returns durable file_ refs usable in markup image(...) fills')
      .option('--folder <folder_id>', 'destination folder')
      .option('--from-url <url>', 'ingest from a URL instead of a local path'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, UPLOAD_TIMEOUT_MS);
      const fromUrl = opts.fromUrl as string | undefined;
      if (fromUrl === undefined && args.length === 0) {
        throw CliError.usage('Pass at least one PATH or --from-url URL.');
      }
      const uploads: Record<string, unknown>[] = [];

      if (fromUrl !== undefined) {
        const response = await client.request({
          method: 'POST',
          path: endpoints.uploadFromUrl(),
          body: { url: fromUrl, ...(typeof opts.folder === 'string' ? { folder_id: opts.folder } : {}) },
        });
        uploads.push(shapeUpload(asObject(response.body), fromUrl));
      }

      for (const path of args) {
        // Only explicitly named paths are read; the CLI never scans directories on its own.
        let size: number;
        try {
          size = statSync(path).size;
        } catch {
          throw CliError.io(`Cannot read ${path}.`);
        }
        const form = new FormData();
        // Bun.file streams from disk — files are never buffered wholesale in memory.
        form.append('file', Bun.file(path), basename(path));
        if (typeof opts.folder === 'string') form.append('folder_id', opts.folder);
        const response = await client.request({ method: 'POST', path: endpoints.uploads(), formData: form });
        uploads.push({ ...shapeUpload(asObject(response.body), path), bytes: size });
        inv.note(`uploaded ${path} (${size} bytes)`);
      }

      return {
        body: { ok: true, operation: 'file.upload', uploads, meta: metaBlock() },
        human: (write) => {
          for (const upload of uploads) {
            write(`${String(upload.source)} → ${String(upload.file_id ?? upload.id ?? '?')}` +
              (upload.markup_ref !== undefined ? ` (markup ref: ${String(upload.markup_ref)})` : ''));
          }
        },
        exitCode: EXIT_OK,
      };
    }),
  );
}

function shapeUpload(body: Record<string, unknown>, source: string): Record<string, unknown> {
  const fileObj = asObject(body.file);
  return {
    source,
    file_id: str(body, 'file_id') ?? str(fileObj, 'id') ?? str(body, 'id'),
    markup_ref: str(body, 'markup_ref') ?? str(body, 'short_ref') ?? str(fileObj, 'short_ref'),
    ...body,
  };
}
