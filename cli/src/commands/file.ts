/** `moda file` — uploads (existing REST) and the read-only files/folders facade. */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Command } from 'commander';
import { parseRef } from '../refs.ts';
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

export function registerFileFacade(program: Command): void {
  const file = program.commands.find((c) => c.name() === 'file') ?? program.command('file');

  addGlobalFlags(
    file
      .command('list')
      .description('list drive files')
      .option('--folder <folder_id>', 'limit to a folder'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, 30_000);
      const response = await client.request({
        method: 'GET',
        path: endpoints.fileList(),
        query: { folder_id: opts.folder as string | undefined },
      });
      return facadeOutcome('file.list', response);
    }),
  );

  addGlobalFlags(file.command('search <query>').description('search drive files')).action(
    wrapAction(async (args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, 30_000);
      const response = await client.request({
        method: 'GET',
        path: endpoints.fileSearch(),
        query: { q: args[0] as string },
      });
      return facadeOutcome('file.search', response);
    }),
  );

  addGlobalFlags(file.command('show <file_id>').description('file metadata')).action(
    wrapAction(async (args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, 30_000);
      const ref = parseRef(args[0] as string, 'file').ref;
      const response = await client.request({ method: 'GET', path: endpoints.fileShow(ref) });
      return facadeOutcome('file.show', response);
    }),
  );

  addGlobalFlags(
    file
      .command('download <file_id>')
      .description('download file bytes')
      .requiredOption('-o, --output <path>', "output path ('-' streams to stdout, JSON summary moves to stderr)"),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, UPLOAD_TIMEOUT_MS);
      const ref = parseRef(args[0] as string, 'file').ref;
      const response = await client.request({ method: 'GET', path: endpoints.fileDownload(ref), raw: true });
      const bytes = response.bytes ?? new Uint8Array();
      const outPath = opts.output as string;
      const toStdout = outPath === '-';
      if (toStdout) {
        process.stdout.write(bytes);
      } else {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, bytes);
      }
      return {
        body: {
          ok: true,
          operation: 'file.download',
          file_id: ref,
          output: toStdout ? '-' : outPath,
          bytes: bytes.byteLength,
          meta: metaBlock({ requestId: response.requestId, durationMs: response.durationMs }),
        },
        human: (write) => write(`${ref} → ${toStdout ? '(stdout)' : outPath} (${bytes.byteLength} bytes)`),
        exitCode: EXIT_OK,
        summaryToStderr: toStdout,
      };
    }),
  );

  const folder = program.command('folder').description('drive folders');

  addGlobalFlags(folder.command('list').description('list folders')).action(
    wrapAction(async (_args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, 30_000);
      const response = await client.request({ method: 'GET', path: endpoints.folderList() });
      return facadeOutcome('folder.list', response);
    }),
  );

  addGlobalFlags(folder.command('create <name>').description('create a folder')).action(
    wrapAction(async (args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, 30_000);
      const response = await client.request({
        method: 'POST',
        path: endpoints.folderCreate(),
        body: { name: args[0] as string },
      });
      return facadeOutcome('folder.create', response);
    }),
  );
}

function facadeOutcome(
  operation: string,
  response: { body: unknown; requestId?: string; durationMs: number },
): { body: Record<string, unknown>; exitCode: number } {
  const root = asObject(response.body);
  return {
    body: {
      ok: true,
      operation,
      ...(Array.isArray(response.body) ? { items: response.body } : root),
      meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
    },
    exitCode: EXIT_OK,
  };
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
