/**
 * `moda file` — uploads (existing REST) and asset search.
 *
 * Parity exception (recorded): the prototype backend has NO /v1/files drive endpoints. What
 * exists: POST /v1/uploads, POST /v1/uploads/from-url, and GET /v1/assets/search (Canvas Actions
 * resource verb returning durable `file_` ids + proxy URLs). `file search` rides assets/search;
 * `file list|show|download` fail with a typed `not_available` error instead of dialing 404-bound
 * paths. Folders, placement, and visibility are NOT part of that exception — they live on
 * /v1/drive, behind `moda drive` (commands/drive.ts).
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

/** The typed file-facade refusal: name the parity exception and the working alternatives. */
function driveNotAvailable(verb: string): CliError {
  return new CliError({
    type: 'unprocessable',
    code: 'not_available',
    message: `'moda ${verb}' has no public API endpoint — the file list/show/download facade is a recorded parity exception in the prototype.`,
    hint: 'Available today: moda file upload, moda file search (team/stock asset search), and moda drive folders | tree | move for folders and placement.',
    source: 'local',
  });
}

export function registerFileUpload(program: Command): void {
  const file = program.command('file').description('Moda files: upload local files, search team and stock assets');

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
      .description('search team assets or the stock photo library (durable ids usable in markup and media inputs)')
      .option('--kind <kind>', 'icon | photo (default photo)', 'photo')
      .option(
        '--source <source>',
        'team | stock (default team). stock = the stock photo library (photo only; the shared icon packs already ARE the stock icons)',
        'team',
      )
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
      const source = opts.source as string;
      if (source !== 'team' && source !== 'stock') {
        throw CliError.usage(`Invalid --source '${source}' — expected team or stock.`);
      }
      const flags = listFlagsOf(opts);
      const { client } = await authedClient(inv, 30_000);
      // Server contract: GET /v1/assets/search?q=&kind=&source=&limit=&offset= → {query, kind,
      // source, assets, has_good_matches, …}. source=stock (photo only) returns
      // `stock_unsplash_<id>` refs — directly placeable in markup/edit code (the write pre-pass
      // imports the photo into team storage on use) — plus per-result `attribution` that must be
      // shown wherever the photo appears; its url/thumb_url are PREVIEW-only provider links.
      // For kind=icon the server ignores source: the shared packs are the stock icon library.
      const pages = await fetchListPages(
        client,
        endpoints.assetsSearch(),
        { q: args[0] as string, kind, source },
        flags,
        30_000,
      );
      const outcome = listOutcome({
        operation: 'file.search',
        pages,
        flags,
        emptyHint:
          `no results for '${args[0] as string}' — broaden the query or switch --kind (icon | photo)` +
          (kind === 'photo' && source === 'team' ? ' or try --source stock (stock photo library)' : ''),
        itemLine: (asset) => `${str(asset, 'id') ?? '?'}  ${str(asset, 'name') ?? ''}`,
      });
      const inner = outcome.human;
      // Degraded stock lane: provider_status 'unavailable' means "could not search", NOT "no
      // matches" — surface the server's note so an empty page is not read as a zero-hit query.
      if (source === 'stock' && str(pages.root, 'provider_status') === 'unavailable') {
        outcome.human = (write) => {
          write(str(pages.root, 'note') ?? 'stock photo search is unavailable on this deployment — use --source team, or upload the image');
          inner?.(write);
        };
      } else if (source === 'stock' && str(pages.root, 'source') !== 'stock') {
        // A server predating the source param ignores it and silently serves TEAM results —
        // the response echo is the truth signal. Say so rather than mislabeling the hits.
        outcome.human = (write) => {
          write('note: this server predates stock sourcing — these are team-asset results');
          inner?.(write);
        };
        inv.note('server did not echo source=stock — team-asset results returned');
      } else if (pages.root.has_good_matches === false && pages.items.length > 0) {
        // The server scores relevance: has_good_matches false means every hit is below its
        // confidence bar. Surface it in the human lane too — a silent low-confidence page reads
        // as a match and gets placed as-is (the JSON body already carries the flag via root).
        outcome.human = (write) => {
          write('low-confidence matches — verify visually before placing (or generate instead)');
          inner?.(write);
        };
      }
      return outcome;
    }),
  );

  addGlobalFlags(file.command('list').description('list drive files — not available (no public file endpoint; folders live under moda drive)')).action(
    wrapAction(async () => {
      throw driveNotAvailable('file list');
    }),
  );

  addGlobalFlags(file.command('show <file_id>').description('file metadata — not available (no public file endpoint)')).action(
    wrapAction(async () => {
      throw driveNotAvailable('file show');
    }),
  );

  addGlobalFlags(
    file
      .command('download <file_id>')
      .description('download file bytes — not available (no public file endpoint)')
      .option('-o, --output <path>', 'output path'),
  ).action(
    wrapAction(async () => {
      throw driveNotAvailable('file download');
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
