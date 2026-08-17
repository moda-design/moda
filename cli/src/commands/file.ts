/**
 * `moda file` — the file lane: upload (with drive-folder placement), search, list, show, download.
 *
 * Server contract (studio #9354, the G9 file-content lanes):
 * - GET /v1/drive/files — offset lane, true `total`; `folder_id` = `fld_…` | the literal `root`
 *   (unfiled). The app file browser's exact view: library-visible files, private files of other
 *   users invisible, newest-modified first.
 * - GET /v1/drive/files/{file_id} → {file: {id, name, folder_id, visibility,
 *   visibility_inherited, mime_type, size_bytes, show_in_library, url, created_at, updated_at,
 *   created_by: {id, name, email}}}. A library-hidden file IS readable by id.
 * - GET /v1/drive/files/{file_id}/download → {download_url, filename, mime_type, size_bytes} —
 *   a time-limited presigned URL (bytes never traverse the API). Rides the `files:read` scope;
 *   keys minted before that scope existed need a re-mint (`moda auth login`).
 * - POST /v1/uploads (multipart; `folder_id` form field) and POST /v1/uploads/from-url
 *   ({source_url, filename?, folder_id?}) → FileUploadResponse {id, url, filename, mime_type,
 *   size_bytes, was_duplicate, folder_id} — `folder_id` echoes where the file actually landed.
 * - GET /v1/assets/search (team/stock asset search; unchanged).
 *
 * Tolerant posture: the file lanes deploy after this CLI ships — a BARE route 404 (code
 * `http_404`, no server envelope) means the server predates the endpoint and fails typed with
 * that truth (#9292 class); an envelope'd `not_found` is a real missing file/folder. The upload
 * lanes degrade by ECHO: a server that predates `folder_id` ignores the form field (multipart)
 * or rejects it (`extra=forbid`, from-url) — the response echo is the placement truth signal.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Command } from 'commander';
import type { ApiClient } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { asObject, num, str, type JsonObject } from '../api/types.ts';
import { CliError, rethrowRoutePredates } from '../cliError.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import { writeBytesToStdout, type CommandOutcome } from '../output/emit.ts';
import { parseRef } from '../refs.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction, type Invocation } from './runtime.ts';
import { LIST_ALL_CAP, fetchListPages, listFlagsOf, listOutcome, parseListLimit, parseListOffset, type ListFlags } from './listLane.ts';
import { parseDestination, parseFolderRef, validateName } from './drive.ts';
import { downloadArtifact } from './export.ts';

const UPLOAD_TIMEOUT_MS = 300_000;
const FILE_TIMEOUT_MS = 60_000;

/**
 * The shared error posture of the three /v1/drive/files lanes: a BARE route 404 means this
 * server predates the endpoints (studio #9354 deploys after this CLI; envelope'd not_found
 * codes pass through untouched), and a missing-scope 403 (the server's bare `permission` code)
 * names the re-mint instead of dead-ending — `files:read` is NEWER than most minted keys.
 */
function rethrowFileLane(err: unknown): never {
  if (err instanceof CliError && err.fields.code === 'http_404') {
    rethrowRoutePredates(
      err,
      'This server predates the drive file endpoints.',
      'They ship with the next backend deploy. Meanwhile: moda file search finds team assets, ' +
        'and moda drive folders | tree show the workspace organization.',
    );
  }
  if (
    err instanceof CliError &&
    err.fields.type === 'permission' &&
    err.fields.hint === undefined &&
    err.fields.message.includes('scope')
  ) {
    throw new CliError({
      ...err.fields,
      hint:
        'This API key lacks a scope the verb needs — newer scopes (files:read guards file ' +
        'downloads) are missing from keys minted before them. Re-mint the key: moda auth login.',
    });
  }
  throw err;
}

export function registerFileUpload(program: Command): void {
  const file = program
    .command('file')
    .description('Moda files: upload into the drive, list/inspect/download files, search team and stock assets');

  addGlobalFlags(
    file
      .command('upload [paths...]')
      .description('upload files; returns durable file_ refs usable in markup image fills and media inputs')
      .option('--from-url <url>', 'ingest from a URL instead of a local path')
      .option(
        '--folder <folder_ref|root>',
        "destination drive folder (fld_…) — the file adopts the folder's visibility; 'root' or omitted = unfiled (library root)",
      )
      .option('--name <filename>', 'store under this filename (one upload only)'),
  )
    .addHelpText(
      'after',
      '\nExamples:\n  moda file upload photo.png\n  moda file upload report.pdf --folder fld_01HZX9K2ABCDEFGHJKMNPQRSTV\n' +
        '  moda file upload --from-url https://example.com/logo.png --name logo.png\n\n' +
        'Not for: generating new imagery (moda media generate-image) or placing an already\n' +
        'uploaded file into a folder (moda drive move).\n',
    )
    .action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const fromUrl = opts.fromUrl as string | undefined;
      if (fromUrl === undefined && args.length === 0) {
        throw CliError.usage('Pass at least one PATH or --from-url URL.');
      }
      // `root` means unfiled — the server default; nothing is sent.
      const folderId = typeof opts.folder === 'string' ? (parseDestination(opts.folder) ?? undefined) : undefined;
      // Basename-reduced (a separator would fork the storage key) and server-bounded (1..255).
      const name = typeof opts.name === 'string' ? validateName(basename(opts.name)) : undefined;
      if (name !== undefined && args.length + (fromUrl !== undefined ? 1 : 0) !== 1) {
        throw CliError.usage('--name names ONE upload — pass a single PATH or --from-url URL.');
      }
      const { client } = await authedClient(inv, UPLOAD_TIMEOUT_MS);
      const uploads: Record<string, unknown>[] = [];

      if (fromUrl !== undefined) {
        // Server contract: UploadFromUrlRequest {source_url, filename?, folder_id?} (extra=forbid).
        const response = await client
          .request({
            method: 'POST',
            path: endpoints.uploadFromUrl(),
            body: {
              source_url: fromUrl,
              ...(name !== undefined ? { filename: name } : {}),
              ...(folderId !== undefined ? { folder_id: folderId } : {}),
            },
          })
          .catch((err: unknown) => {
            // extra=forbid on an old server rejects the UNKNOWN folder_id field with a 422 whose
            // field entry is pydantic's `extra_forbidden` — translate exactly that shape into
            // the placement truth (#9292 class). A 422 about a folder_id VALUE on a new server
            // is a real validation error and passes through untouched.
            const fields = JSON.stringify(err instanceof CliError ? (err.fields.details ?? {}) : {});
            if (
              folderId !== undefined &&
              err instanceof CliError &&
              err.fields.status === 422 &&
              fields.includes('folder_id') &&
              fields.includes('extra_forbidden')
            ) {
              throw new CliError({
                ...err.fields,
                message: 'This server predates upload folder placement (--folder).',
                hint: `Re-run without --folder, then place the file: moda drive move <file_id> ${folderId}`,
              });
            }
            throw err;
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
        form.append('file', Bun.file(path), name ?? basename(path));
        // Old servers ignore unknown form fields — the response echo below is the truth signal.
        if (folderId !== undefined) form.append('folder_id', folderId);
        const response = await client.request({ method: 'POST', path: endpoints.uploads(), formData: form });
        uploads.push({ ...shapeUpload(asObject(response.body), path), bytes: size });
        inv.note(`uploaded ${path} (${size} bytes)`);
      }

      // Placement truth is the response ECHO, checked for EQUALITY: no echo means an old server
      // ignored the field and the file landed unfiled; a different echo means it sits somewhere
      // other than what was asked. Either way the fix is named — and carried in the --json body
      // too (`warnings`), because a silent misplacement must never read as success-in-the-folder.
      const warnings: string[] = [];
      if (folderId !== undefined) {
        for (const upload of uploads) {
          const fileId = String(upload.file_id ?? upload.id ?? '<file_…>');
          const landed = str(upload, 'folder_id');
          if (landed === undefined) {
            warnings.push(
              `this server predates upload folder placement — ${fileId} landed unfiled; ` +
                `place it: moda drive move ${fileId} ${folderId}`,
            );
          } else if (landed !== folderId) {
            warnings.push(
              `requested ${folderId} but ${fileId} is in ${landed} — place it: moda drive move ${fileId} ${folderId}`,
            );
          }
        }
      }

      return {
        body: {
          ok: true,
          operation: 'file.upload',
          uploads,
          ...(warnings.length > 0 ? { warnings } : {}),
          meta: metaBlock(),
        },
        human: (write) => {
          for (const upload of uploads) {
            const landed = str(upload, 'folder_id');
            write(
              `${String(upload.source)} → ${String(upload.file_id ?? upload.id ?? '?')}` +
                `${landed !== undefined ? ` (in ${landed})` : ''}` +
                `${upload.was_duplicate === true ? ' — already existed (deduplicated)' : ''}`,
            );
          }
          for (const warning of warnings) write(`warning: ${warning}`);
        },
        exitCode: EXIT_OK,
      };
    }),
  );
}

/** One `moda file search` line (team assets and the stock library share the shape). */
export function assetLine(asset: JsonObject): string {
  return `${str(asset, 'id') ?? '?'}  ${str(asset, 'name') ?? ''}`;
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
        itemLine: assetLine,
      });
      const inner = outcome.human;
      // The stock contract applies to the PHOTO lane only — for kind=icon the server ignores
      // `source` by contract (the shared packs ARE the stock icons), so no echo check there.
      const stockLane = kind === 'photo' && source === 'stock';
      if (stockLane && str(pages.root, 'provider_status') === 'unavailable') {
        // Degraded stock lane: 'unavailable' means "could not search", NOT "no matches" —
        // REPLACE the renderer so the default zero-hit hint cannot claim an empty match set.
        outcome.human = (write) => {
          write(str(pages.root, 'note') ?? 'stock photo search is unavailable on this deployment — use --source team, or upload the image');
        };
        return outcome;
      }
      // Independent cautions, composed (never an else-if): mislabeled old-server results can
      // ALSO be low-confidence, and dropping the verify-visually guard is a real regression.
      const cautions: string[] = [];
      if (stockLane && str(pages.root, 'source') !== 'stock') {
        // A server predating the source param ignores it and silently serves TEAM results —
        // the response echo is the truth signal. Say so rather than mislabeling the hits.
        cautions.push('note: this server predates stock sourcing — these are team-asset results');
        inv.note('server did not echo source=stock — team-asset results returned');
      }
      if (pages.root.has_good_matches === false && pages.items.length > 0) {
        // The server scores relevance: has_good_matches false means every hit is below its
        // confidence bar. Surface it in the human lane too — a silent low-confidence page reads
        // as a match and gets placed as-is (the JSON body already carries the flag via root).
        cautions.push('low-confidence matches — verify visually before placing (or generate instead)');
      }
      if (cautions.length > 0) {
        outcome.human = (write) => {
          for (const line of cautions) write(line);
          inner?.(write);
        };
      }
      return outcome;
    }),
  );

  addGlobalFlags(
    file
      .command('list')
      .description('list drive files (newest first, true total) — the view the app file browser shows')
      .option('--folder <folder_ref|root>', "only files in this folder (fld_…), or 'root' for unfiled files")
      .option('--limit <n>', 'page size (server default 50, capped at 200)', parseListLimit)
      .option('--offset <n>', 'pagination offset', parseListOffset)
      .option('--all', `fetch every page (bounded at ${LIST_ALL_CAP} items)`)
      .option('--output <file>', 'write the full payload to a file; stdout gets a small summary + preview'),
  )
    .addHelpText(
      'after',
      '\nExamples:\n  moda file list\n  moda file list --folder fld_01HZX9K2ABCDEFGHJKMNPQRSTV\n\n' +
        'Not for: finding an asset by what it shows (moda file search) or listing folders\n' +
        'themselves (moda drive folders / moda drive tree).\n',
    )
    .action(
      wrapAction(async (_args, opts, cmd) => {
        const inv = buildInvocation(cmd);
        const { client } = await authedClient(inv, FILE_TIMEOUT_MS);
        return performFileList(client, listFlagsOf(opts), typeof opts.folder === 'string' ? opts.folder : undefined);
      }),
    );

  addGlobalFlags(
    file
      .command('show <file_ref>')
      .description('file metadata: name, folder, visibility, MIME type, size, creator'),
  )
    .addHelpText(
      'after',
      '\nExamples:\n  moda file show file_01HZX9K2ABCDEFGHJKMNPQRSTV\n\n' +
        "Not for: the file's bytes (moda file download) or canvas metadata (moda canvas show).\n",
    )
    .action(
      wrapAction(async (args, _opts, cmd) => {
        const inv = buildInvocation(cmd);
        const ref = parseRef(args[0] as string, 'file').ref;
        const { client } = await authedClient(inv, FILE_TIMEOUT_MS);
        return performFileShow(client, ref);
      }),
    );

  addGlobalFlags(
    file
      .command('download <file_ref>')
      .description("download a file's bytes to disk (rides the files:read scope)")
      .option('-o, --output <path>', "output path ('-' = stdout; default: the file's own name in the output dir)"),
  )
    .addHelpText(
      'after',
      '\nExamples:\n  moda file download file_01HZX9K2ABCDEFGHJKMNPQRSTV\n' +
        '  moda file download file_01HZX9K2ABCDEFGHJKMNPQRSTV -o brief.pdf\n\n' +
        'Not for: rendering a canvas to a file (moda export) or referencing an asset in\n' +
        'markup — image(file_…) fills take the ref directly, no download needed.\n',
    )
    .action(
      wrapAction(async (args, opts, cmd) => {
        const inv = buildInvocation(cmd);
        const ref = parseRef(args[0] as string, 'file').ref;
        const { client } = await authedClient(inv, FILE_TIMEOUT_MS);
        return performFileDownload(client, inv, ref, typeof opts.output === 'string' ? opts.output : undefined);
      }),
    );
}

/** `file_…  name  mime  size` — plus the privacy marker the listing itself would hide behind. */
export function fileLine(file: JsonObject): string {
  const size = num(file, 'size_bytes');
  return (
    `${str(file, 'id') ?? '?'}  ${str(file, 'name') ?? '(unnamed)'}` +
    `${str(file, 'mime_type') !== undefined ? `  ${str(file, 'mime_type')}` : ''}` +
    `${size !== undefined ? `  ${size} bytes` : ''}` +
    `${str(file, 'visibility') === 'private' ? '  (private)' : ''}`
  );
}

export async function performFileList(client: ApiClient, flags: ListFlags, folder?: string): Promise<CommandOutcome> {
  // `root` is a literal the endpoint understands (unfiled files); anything else is a folder ref.
  const isRoot = folder !== undefined && folder.trim().toLowerCase() === 'root';
  const folderId = folder === undefined ? undefined : isRoot ? 'root' : parseFolderRef(folder);
  const pages = await fetchListPages(
    client,
    endpoints.driveFiles(),
    { folder_id: folderId },
    flags,
    FILE_TIMEOUT_MS,
    'offset',
  ).catch(rethrowFileLane);
  return listOutcome({
    operation: 'file.list',
    pages,
    flags,
    emptyHint:
      folder === undefined
        ? 'no files in the drive library yet — add one: moda file upload <path>'
        : isRoot
          ? 'no unfiled files — files may live inside folders (moda drive tree); list one with --folder fld_…'
          : `no files in ${folder} — upload into it: moda file upload <path> --folder ${folder}`,
    itemLine: fileLine,
  });
}

export async function performFileShow(client: ApiClient, ref: string): Promise<CommandOutcome> {
  const response = await client
    .request({ method: 'GET', path: endpoints.driveFile(ref) })
    .catch(rethrowFileLane);
  const root = asObject(response.body);
  const file = asObject(root.file);
  return {
    body: {
      ok: true,
      ...root,
      operation: 'file.show',
      meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
    },
    human: (write) => {
      const id = str(file, 'id') ?? ref;
      write(`${str(file, 'name') ?? '(unnamed)'}  (${id})`);
      write(`folder: ${str(file, 'folder_id') ?? 'unfiled (library root)'}`);
      const visibility = str(file, 'visibility');
      const libraryHidden = file.show_in_library === false;
      if (visibility !== undefined || libraryHidden) {
        write(
          `visibility: ${visibility ?? 'unknown'}${file.visibility_inherited === true ? ' (inherited from its folder)' : ''}` +
            `${libraryHidden ? ' — hidden from the library (embedded asset)' : ''}`,
        );
      }
      const size = num(file, 'size_bytes');
      const mime = str(file, 'mime_type');
      if (mime !== undefined || size !== undefined) {
        write(`type: ${mime ?? 'unknown'}${size !== undefined ? `, ${size} bytes` : ''}`);
      }
      const creator = asObject(file.created_by);
      const creatorLabel = str(creator, 'name') ?? str(creator, 'email');
      const createdAt = str(file, 'created_at');
      const updatedAt = str(file, 'updated_at');
      if (creatorLabel !== undefined || createdAt !== undefined) {
        write(
          `created${creatorLabel !== undefined ? ` by ${creatorLabel}` : ''}${createdAt !== undefined ? ` ${createdAt}` : ''}` +
            `${updatedAt !== undefined ? `; updated ${updatedAt}` : ''}`,
        );
      }
      write(`bytes: moda file download ${id}`);
    },
    exitCode: EXIT_OK,
  };
}

export async function performFileDownload(
  client: ApiClient,
  inv: Invocation,
  ref: string,
  output?: string,
): Promise<CommandOutcome> {
  const response = await client
    .request({ method: 'GET', path: endpoints.driveFileDownload(ref) })
    .catch(rethrowFileLane);
  const root = asObject(response.body);
  const downloadUrl = str(root, 'download_url');
  // An empty string would resolve to the API base itself — treat it as missing.
  if (downloadUrl === undefined || downloadUrl.trim() === '') {
    throw new CliError({
      type: 'upstream_error',
      code: 'download_failed',
      message: 'The server returned no download_url for this file.',
      source: 'api',
    });
  }
  const filename = str(root, 'filename');
  const sizeBytes = num(root, 'size_bytes');
  const bytes = await downloadArtifact(client, downloadUrl, inv, 'download_failed');
  const toStdout = output === '-';
  // Default name: the file's OWN name (server-reported) — reduced to a basename so server data
  // can never traverse paths (`.`/`..` fall back to the ref) — in the configured output dir.
  const reduced = filename !== undefined ? basename(filename) : '';
  const safeName = reduced !== '' && reduced !== '.' && reduced !== '..' ? reduced : ref;
  const outPath = toStdout ? '-' : (output ?? join(inv.context.outputDir.value ?? '.', safeName));
  if (toStdout) {
    await writeBytesToStdout(bytes);
  } else {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, bytes);
  }
  // The presigned URL is time-limited: report what was fetched, never the URL as a durable ref.
  // A declared-size mismatch is a committed-but-degraded outcome — it rides the --json body
  // (`warnings`) as well as the human lane.
  const warnings: string[] = [];
  if (sizeBytes !== undefined && sizeBytes !== bytes.byteLength) {
    warnings.push(`the server reported ${sizeBytes} bytes but ${bytes.byteLength} were downloaded — verify the file`);
  }
  return {
    body: {
      ok: true,
      operation: 'file.download',
      file_id: ref,
      ...(filename !== undefined ? { filename } : {}),
      ...(str(root, 'mime_type') !== undefined ? { mime_type: str(root, 'mime_type') } : {}),
      ...(sizeBytes !== undefined ? { size_bytes: sizeBytes } : {}),
      output: outPath,
      bytes: bytes.byteLength,
      ...(warnings.length > 0 ? { warnings } : {}),
      meta: metaBlock({ requestId: response.requestId, durationMs: response.durationMs }),
    },
    human: (write) => {
      write(`${filename ?? ref} -> ${toStdout ? '(stdout)' : outPath} (${bytes.byteLength} bytes)`);
      for (const warning of warnings) write(`warning: ${warning}`);
    },
    exitCode: EXIT_OK,
    summaryToStderr: toStdout,
  };
}

/** Server contract: FileUploadResponse {id (file_...), url, filename, mime_type, size_bytes, was_duplicate, folder_id}. */
function shapeUpload(body: Record<string, unknown>, source: string): Record<string, unknown> {
  return {
    source,
    file_id: str(body, 'id') ?? str(body, 'file_id'),
    ...body,
  };
}
