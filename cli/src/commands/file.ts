/**
 * `moda file` — uploads (existing REST) and asset search.
 *
 * Parity exception (recorded): the prototype backend has NO /v1/files or /v1/folders drive
 * endpoints. What exists: POST /v1/uploads, POST /v1/uploads/from-url, and GET /v1/assets/search
 * (Canvas Actions resource verb returning durable `file_` ids + proxy URLs). `file search` rides
 * assets/search; `file list|show|download` and the `folder` verbs fail with a typed
 * `not_available` error instead of dialing 404-bound paths.
 */
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Command } from 'commander';
import { endpoints } from '../api/endpoints.ts';
import { asObject, str } from '../api/types.ts';
import { CliError } from '../cliError.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction } from './runtime.ts';
import { LIST_ALL_CAP, fetchListPages, listFlagsOf, listOutcome, parseListLimit, parseListOffset } from './listLane.ts';

const UPLOAD_TIMEOUT_MS = 300_000;

/** The typed drive-facade refusal: name the parity exception and the working alternatives. */
function driveNotAvailable(verb: string): CliError {
  return new CliError({
    type: 'unprocessable',
    code: 'not_available',
    message: `'moda ${verb}' has no public API endpoint — the files/folders drive facade is a recorded parity exception in the prototype.`,
    hint: 'Available today: moda file upload, moda file upload --from-url, moda file search (team asset search).',
    source: 'local',
  });
}

export function registerFileUpload(program: Command): void {
  const file = program.command('file').description('Moda files: upload local files, search team assets');

  addGlobalFlags(
    file
      .command('upload [paths...]')
      .description('upload files; returns durable file_ refs usable in markup image fills and media inputs')
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
        // Server contract: UploadFromUrlRequest {source_url, filename?}.
        const response = await client.request({
          method: 'POST',
          path: endpoints.uploadFromUrl(),
          body: { source_url: fromUrl },
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
        const response = await client.request({ method: 'POST', path: endpoints.uploads(), formData: form });
        uploads.push({ ...shapeUpload(asObject(response.body), path), bytes: size });
        inv.note(`uploaded ${path} (${size} bytes)`);
      }

      return {
        body: { ok: true, operation: 'file.upload', uploads, meta: metaBlock() },
        human: (write) => {
          for (const upload of uploads) {
            write(`${String(upload.source)} → ${String(upload.file_id ?? upload.id ?? '?')}`);
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
      .command('search <query>')
      .description('search team assets (durable file_ ids + URLs, usable in markup and media inputs)')
      .option('--kind <kind>', 'icon | photo (default photo)', 'photo')
      .option('--limit <n>', 'max results', parseListLimit)
      .option('--offset <n>', 'pagination offset', parseListOffset)
      .option('--all', `fetch every page (bounded at ${LIST_ALL_CAP} items)`)
      .option('--output <file>', 'write the full payload to a file; stdout gets a small summary + preview'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const kind = opts.kind as string;
      if (kind !== 'icon' && kind !== 'photo') {
        throw CliError.usage(`Invalid --kind '${kind}' — expected icon or photo.`);
      }
      const flags = listFlagsOf(opts);
      const { client } = await authedClient(inv, 30_000);
      // Server contract: GET /v1/assets/search?q=&kind=&limit= → {query, kind, assets, has_good_matches}.
      const pages = await fetchListPages(
        client,
        endpoints.assetsSearch(),
        { q: args[0] as string, kind },
        flags,
        30_000,
      );
      return listOutcome({
        operation: 'file.search',
        pages,
        flags,
        emptyHint: `no results for '${args[0] as string}' — broaden the query or switch --kind (icon | photo)`,
        itemLine: (asset) => `${str(asset, 'id') ?? '?'}  ${str(asset, 'name') ?? ''}`,
      });
    }),
  );

  addGlobalFlags(file.command('list').description('list drive files — not available (no public drive endpoint)')).action(
    wrapAction(async () => {
      throw driveNotAvailable('file list');
    }),
  );

  addGlobalFlags(file.command('show <file_id>').description('file metadata — not available (no public drive endpoint)')).action(
    wrapAction(async () => {
      throw driveNotAvailable('file show');
    }),
  );

  addGlobalFlags(
    file
      .command('download <file_id>')
      .description('download file bytes — not available (no public drive endpoint)')
      .option('-o, --output <path>', 'output path'),
  ).action(
    wrapAction(async () => {
      throw driveNotAvailable('file download');
    }),
  );

  const folder = program.command('folder').description('drive folders — not available (no public drive endpoints)');

  addGlobalFlags(folder.command('list').description('list folders — not available')).action(
    wrapAction(async () => {
      throw driveNotAvailable('folder list');
    }),
  );

  addGlobalFlags(folder.command('create <name>').description('create a folder — not available')).action(
    wrapAction(async () => {
      throw driveNotAvailable('folder create');
    }),
  );
}

/** Server contract: FileUploadResponse {id (file_...), url, filename, mime_type, size_bytes, was_duplicate}. */
function shapeUpload(body: Record<string, unknown>, source: string): Record<string, unknown> {
  return {
    source,
    file_id: str(body, 'id') ?? str(body, 'file_id'),
    ...body,
  };
}
