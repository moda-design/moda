/**
 * `moda drive` — the workspace drive: folders, where things live, and who can see them.
 *
 * Server contract (frozen): POST /v1/drive/folders (create; idempotent), GET /v1/drive/folders
 * (OFFSET-paginated flat list of every visible folder, sorted by path), GET /v1/drive/tree?depth=
 * (nested, server default 3), POST /v1/drive/items/{item_ref}/move ({folder_id: "fld_…"|null}),
 * PATCH /v1/drive/items/{item_ref} ({name?, visibility?}), DELETE /v1/drive/items/{item_ref}
 * ?recursive=. Mutations answer with the canvas-actions envelope — {operation, committed: true,
 * folder|item, usage} (a zero-credit receipt: the drive lane is deterministic and unmetered).
 *
 * `item_ref` is a TYPED wire id — `fld_…`, `cvs_…`, or `file_…`. A bare UUID is ambiguous across
 * kinds on this route, so the CLI refuses one locally instead of guessing.
 */
import type { Command } from 'commander';
import type { ApiClient } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { asObject, num, str, type JsonObject } from '../api/types.ts';
import { CliError, withCodeHint } from '../cliError.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import type { CommandOutcome } from '../output/emit.ts';
import { parseRef } from '../refs.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction } from './runtime.ts';
import { LIST_ALL_CAP, fetchListPages, listFlagsOf, listOutcome, parseListLimit, parseListOffset, type ListFlags } from './listLane.ts';
import { requireYes } from './site.ts';

const DRIVE_TIMEOUT_MS = 60_000;

/** The three kinds a drive item ref can name, keyed by wire prefix. */
const ITEM_KIND_BY_PREFIX: Record<string, 'folder' | 'canvas' | 'file'> = {
  fld: 'folder',
  cvs: 'canvas',
  file: 'file',
};

export interface DriveItemRef {
  /** The value to place in the URL path — always the typed wire id. */
  ref: string;
  kind: 'folder' | 'canvas' | 'file';
}

/**
 * Parse an ITEM_REF for the /v1/drive/items routes. Typed ids ONLY: the route is kind-neutral,
 * so a bare UUID cannot be resolved to a folder vs canvas vs file without guessing — and a wrong
 * guess would move or delete the wrong thing.
 */
export function parseItemRef(input: string): DriveItemRef {
  const trimmed = input.trim();
  const match = /^(fld|cvs|file)_[0-9A-Za-z]{10,40}$/.exec(trimmed);
  const kind = match === null ? undefined : ITEM_KIND_BY_PREFIX[match[1] as string];
  if (kind === undefined) {
    throw CliError.usage(
      `'${trimmed}' is not a typed drive item id.`,
      'Drive items need the typed id — fld_… (folder), cvs_… (canvas), or file_… (file); a bare UUID is ' +
        'ambiguous across kinds here. Find ids with: moda drive folders, moda canvas list, moda file search.',
    );
  }
  return { ref: trimmed, kind };
}

/** Parse a folder-only ref (`--parent`, `--in`, `canvas create --folder`). */
export function parseFolderRef(input: string): string {
  return parseRef(input, 'folder').ref;
}

/** Move/list destination: the literal `root` means the team root (`folder_id: null`). */
export function parseDestination(input: string): string | null {
  return input.trim().toLowerCase() === 'root' ? null : parseFolderRef(input);
}

/** Commander parser for `--depth` (server range 1..10; omitted = the server default of 3). */
export function parseDepth(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value.trim()) || parsed < 1 || parsed > 10) {
    throw CliError.usage(`Invalid --depth value '${value}' — expected an integer between 1 and 10.`);
  }
  return parsed;
}

const VISIBILITIES = ['team', 'private'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** Shared by `drive visibility` and `canvas create --visibility`. */
export function parseVisibility(value: string): Visibility {
  const trimmed = value.trim();
  if (!(VISIBILITIES as readonly string[]).includes(trimmed)) {
    throw CliError.usage(
      `Invalid visibility '${value}' — expected team or private.`,
      'private hides the item from teammates; team makes it visible to the whole team.',
    );
  }
  return trimmed as Visibility;
}

/** Folder/item names the server bounds at 1..255 characters — fail locally instead of round-tripping. */
export function validateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw CliError.usage('The name is empty.');
  if (trimmed.length > 255) {
    throw CliError.usage(`The name is ${trimmed.length} characters — the server accepts at most 255.`);
  }
  return trimmed;
}

export function registerDrive(program: Command): void {
  const drive = program
    .command('drive')
    .description('workspace drive: folders, where new work lands, and who can see it');

  addGlobalFlags(
    drive
      .command('folders')
      .description('list drive folders (flat, sorted by path, with item counts)')
      .option('--parent <folder_ref|root>', "only folders directly under this folder, or 'root' for the top-level ones")
      .option('--limit <n>', 'page size (server default 50, capped at 200)', parseListLimit)
      .option('--offset <n>', 'pagination offset', parseListOffset)
      .option('--all', `fetch every page (bounded at ${LIST_ALL_CAP} items)`)
      .option('--output <file>', 'write the full payload to a file; stdout gets a small summary + preview'),
  )
    .addHelpText(
      'after',
      '\nExamples:\n  moda drive folders\n  moda drive folders --parent root\n\n' +
        'Not for: the nested shape of the workspace (moda drive tree) or listing the canvases\n' +
        'inside a folder (moda canvas list / moda canvas search).\n',
    )
    .action(
      wrapAction(async (_args, opts, cmd) => {
        const inv = buildInvocation(cmd);
        const { client } = await authedClient(inv, DRIVE_TIMEOUT_MS);
        const parent = typeof opts.parent === 'string' ? opts.parent : undefined;
        return performDriveFolders(client, listFlagsOf(opts), parent);
      }),
    );

  addGlobalFlags(
    drive
      .command('tree')
      .description('the nested folder tree — how this workspace is actually organized')
      .option('--depth <n>', 'levels to expand, 1-10 (server default 3)', parseDepth),
  )
    .addHelpText(
      'after',
      '\nExamples:\n  moda drive tree\n  moda drive tree --depth 5\n\n' +
        'Not for: a flat, paginated folder list with counts (moda drive folders).\n',
    )
    .action(
      wrapAction(async (_args, opts, cmd) => {
        const inv = buildInvocation(cmd);
        const { client } = await authedClient(inv, DRIVE_TIMEOUT_MS);
        return performDriveTree(client, typeof opts.depth === 'number' ? opts.depth : undefined);
      }),
    );

  addGlobalFlags(
    drive
      .command('mkdir <name>')
      .description('create a drive folder (the place to group one project\'s deliverables)')
      .option('--in <folder_ref>', 'parent folder (fld_…); omitted, the folder is created at the team root'),
  )
    .addHelpText(
      'after',
      '\nExamples:\n  moda drive mkdir "Acme rebrand"\n  moda drive mkdir "Decks" --in fld_01HZX9K2ABCDEFGHJKMNPQRSTV\n\n' +
        'Not for: putting EXISTING work into a folder (moda drive move) or renaming a folder\n' +
        'you already made (moda drive rename).\n',
    )
    .action(
      wrapAction(async (args, opts, cmd) => {
        const inv = buildInvocation(cmd);
        const { client } = await authedClient(inv, DRIVE_TIMEOUT_MS);
        return performDriveMkdir(client, {
          name: args[0] as string,
          parent: typeof opts.in === 'string' ? parseFolderRef(opts.in) : null,
        });
      }),
    );

  addGlobalFlags(
    drive
      .command('move <ref> <destination>')
      .description("move a canvas, file, or folder into another folder (destination 'root' = the team root)"),
  )
    .addHelpText(
      'after',
      '\nExamples:\n  moda drive move cvs_01HZX9K2ABCDEFGHJKMNPQRSTV fld_01HZX9K2ABCDEFGHJKMNPQRSTV\n' +
        '  moda drive move fld_01HZX9K2ABCDEFGHJKMNPQRSTV root\n\n' +
        'Not for: creating the destination folder first (moda drive mkdir) or moving a PAGE\n' +
        'between canvases (moda canvas import-pages).\n',
    )
    .action(
      wrapAction(async (args, _opts, cmd) => {
        const inv = buildInvocation(cmd);
        const item = parseItemRef(args[0] as string);
        const destination = parseDestination(args[1] as string);
        const { client } = await authedClient(inv, DRIVE_TIMEOUT_MS);
        return performDriveMove(client, item, destination);
      }),
    );

  addGlobalFlags(drive.command('rename <ref> <new-name>').description('rename a canvas, file, or folder in the drive'))
    .addHelpText(
      'after',
      '\nExamples:\n  moda drive rename fld_01HZX9K2ABCDEFGHJKMNPQRSTV "Acme rebrand 2026"\n\n' +
        'Not for: renaming a canvas you are authoring (moda canvas rename does the same thing\n' +
        'for a canvas ref) or moving it somewhere else (moda drive move).\n',
    )
    .action(
      wrapAction(async (args, _opts, cmd) => {
        const inv = buildInvocation(cmd);
        const item = parseItemRef(args[0] as string);
        const name = validateName(args[1] as string);
        const { client } = await authedClient(inv, DRIVE_TIMEOUT_MS);
        return performDriveRename(client, item, name);
      }),
    );

  addGlobalFlags(
    drive
      .command('visibility <ref> <visibility>')
      .description(
        'set who can see an item: private hides it from teammates; team makes it visible to the whole team ' +
          '(canvases and files — a folder takes its visibility from where it lives)',
      ),
  )
    .addHelpText(
      'after',
      '\nExamples:\n  moda drive visibility cvs_01HZX9K2ABCDEFGHJKMNPQRSTV private\n' +
        '  moda drive visibility cvs_01HZX9K2ABCDEFGHJKMNPQRSTV team\n\n' +
        'Set private ONLY when the user asked for private — it hides the work from their\n' +
        'teammates. Not for: sharing outside the team (moda canvas share) or deleting\n' +
        'something you did not mean to create (moda drive rm).\n',
    )
    .action(
      wrapAction(async (args, _opts, cmd) => {
        const inv = buildInvocation(cmd);
        const item = parseItemRef(args[0] as string);
        const visibility = parseVisibility(args[1] as string);
        const { client } = await authedClient(inv, DRIVE_TIMEOUT_MS);
        return performDriveVisibility(client, item, visibility);
      }),
    );

  addGlobalFlags(
    drive
      .command('rm <ref>')
      .description('delete a canvas, file, or folder from the drive (destructive — requires --yes under --json/--no-input)')
      .option('--recursive', 'delete a folder together with everything inside it')
      .option('--yes', 'confirm deletion'),
  )
    .addHelpText(
      'after',
      '\nExamples:\n  moda drive rm file_01HZX9K2ABCDEFGHJKMNPQRSTV --yes\n' +
        '  moda drive rm fld_01HZX9K2ABCDEFGHJKMNPQRSTV --recursive --yes\n\n' +
        'Not for: deleting nodes or pages INSIDE a canvas (moda canvas delete-items) or taking\n' +
        'a site off the web (moda site unpublish).\n',
    )
    .action(
      wrapAction(async (args, opts, cmd) => {
        const inv = buildInvocation(cmd);
        const recursive = opts.recursive === true;
        requireYes(
          'Deleting a drive item',
          inv.flags.noInput,
          opts.yes === true,
          `moda drive rm ${args[0] as string}${recursive ? ' --recursive' : ''}`,
        );
        const item = parseItemRef(args[0] as string);
        const { client } = await authedClient(inv, DRIVE_TIMEOUT_MS);
        return performDriveDelete(client, item, recursive);
      }),
    );
}

interface WireResponse {
  requestId?: string;
  durationMs: number;
}

/**
 * Shape a drive response into the §3 output document. Spread first so the CLI's verb-lane
 * `operation` wins over the server envelope's own (`drive.folder_create` etc.) — same rule as
 * the site lane.
 */
function driveOutcome(
  operation: string,
  root: JsonObject,
  response: WireResponse,
  human: (write: (line: string) => void) => void,
): CommandOutcome {
  return {
    body: {
      ok: true,
      ...root,
      operation,
      meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
    },
    human,
    exitCode: EXIT_OK,
  };
}

const COUNT_FIELDS: Array<[field: string, singular: string, plural: string]> = [
  ['canvas_count', 'canvas', 'canvases'],
  ['file_count', 'file', 'files'],
  ['website_count', 'website', 'websites'],
  ['subfolder_count', 'subfolder', 'subfolders'],
];

/** `(3 canvases, 1 file)` — only the counts the server reported, only when non-zero. */
function countSummary(folder: JsonObject): string {
  const reported = COUNT_FIELDS.filter(([field]) => num(folder, field) !== undefined);
  if (reported.length === 0) return '';
  const parts = reported
    .map(([field, singular, plural]) => [num(folder, field) as number, singular, plural] as const)
    .filter(([count]) => count > 0)
    .map(([count, singular, plural]) => `${count} ${count === 1 ? singular : plural}`);
  return parts.length === 0 ? '(empty)' : `(${parts.join(', ')})`;
}

function folderLine(folder: JsonObject): string {
  const label = str(folder, 'path') ?? str(folder, 'name') ?? '(unnamed)';
  const counts = countSummary(folder);
  return `${label}  ${str(folder, 'id') ?? '?'}${counts.length > 0 ? `  ${counts}` : ''}`;
}

/** How the human line names the thing that was touched: `canvas "Q3 deck" (cvs_…)`. */
function itemLabel(item: JsonObject, fallback: DriveItemRef): string {
  const kind = str(item, 'kind') ?? fallback.kind;
  const name = str(item, 'name');
  return `${kind}${name !== undefined ? ` "${name}"` : ''} (${str(item, 'id') ?? fallback.ref})`;
}

export async function performDriveFolders(
  client: ApiClient,
  flags: ListFlags,
  parent?: string,
): Promise<CommandOutcome> {
  // `root` is a literal the endpoint understands (top-level only); anything else is a folder ref.
  const isRoot = parent !== undefined && parent.trim().toLowerCase() === 'root';
  const parentId = parent === undefined ? undefined : isRoot ? 'root' : parseFolderRef(parent);
  const pages = await fetchListPages(
    client,
    endpoints.driveFolders(),
    { parent_id: parentId },
    flags,
    DRIVE_TIMEOUT_MS,
    'offset',
  );
  return listOutcome({
    operation: 'drive.folders',
    pages,
    flags,
    emptyHint:
      parent === undefined || isRoot
        ? 'no folders yet — create one: moda drive mkdir "<project>"'
        : `no folders under ${parent} — create one: moda drive mkdir "<project>" --in ${parent}`,
    itemLine: folderLine,
  });
}

export async function performDriveTree(client: ApiClient, depth?: number): Promise<CommandOutcome> {
  const response = await client.request({
    method: 'GET',
    path: endpoints.driveTree(),
    query: { depth: depth !== undefined ? String(depth) : undefined },
  });
  const root = asObject(response.body);
  const nodes = Array.isArray(root.tree) ? root.tree.map(asObject) : [];
  return driveOutcome('drive.tree', root, response, (write) => {
    if (nodes.length === 0) {
      write('no folders yet — create one: moda drive mkdir "<project>"');
      return;
    }
    writeTreeNodes(nodes, 0, write);
    // The tree is a DEPTH-BOUNDED view, not the universe — say so whenever branches were cut.
    if (root.truncated === true) {
      write(`cut off at depth ${root.depth ?? '?'} — re-run with a larger --depth to see deeper levels`);
    }
  });
}

function writeTreeNodes(nodes: JsonObject[], level: number, write: (line: string) => void): void {
  for (const node of nodes) {
    const counts = countSummary(node);
    write(
      `${'  '.repeat(level)}${str(node, 'name') ?? '(unnamed)'}/ [${str(node, 'id') ?? '?'}]` +
        `${counts.length > 0 ? ` ${counts}` : ''}` +
        `${node.children_truncated === true ? ' … (deeper levels not shown — --depth)' : ''}`,
    );
    const children = Array.isArray(node.children) ? node.children.map(asObject) : [];
    writeTreeNodes(children, level + 1, write);
  }
}

export interface DriveMkdirInput {
  name: string;
  /** null = the team root. */
  parent: string | null;
}

export async function performDriveMkdir(client: ApiClient, input: DriveMkdirInput): Promise<CommandOutcome> {
  const name = validateName(input.name);
  const payload = { name, parent_folder_id: input.parent };
  const response = await client
    .request({
      method: 'POST',
      path: endpoints.driveFolderCreate(),
      body: payload,
      // Standard pipeline: the client injects the derived in-body idempotency_key.
      idempotency: { command: 'drive mkdir', canvas: '', expectedRevision: undefined, payload: JSON.stringify(payload) },
    })
    .catch((err: unknown) => {
      if (err instanceof CliError && err.fields.code === 'folder_name_conflict' && err.fields.hint === undefined) {
        const existing = str(asObject(err.fields.details), 'existing_folder_id');
        throw new CliError({
          ...err.fields,
          hint:
            existing !== undefined
              ? `A folder named "${name}" already exists: ${existing} — use it, or pick another name.`
              : `A folder named "${name}" already exists here — find it with moda drive folders, or pick another name.`,
        });
      }
      throw err;
    });
  const root = asObject(response.body);
  const folder = asObject(root.folder);
  return driveOutcome('drive.mkdir', root, response, (write) => {
    if (root.reused_existing === true) {
      const createdAt = str(root, 'created_at');
      write(
        `⚠ REUSED the existing folder${createdAt !== undefined ? ` (created ${createdAt})` : ''} — the server ` +
          'replayed your idempotency key; pick a different name for a separate folder',
      );
    } else if (root.replayed === true) {
      write('⚠ REPLAYED — the server returned the stored result of an earlier identical call; nothing was created again');
    }
    const serverNote = str(root, 'note');
    if (serverNote !== undefined) write(`server note: ${serverNote}`);
    write(`drive.mkdir: ${str(folder, 'path') ?? name} — ${str(folder, 'id') ?? '?'}`);
    write(`put work in it: moda canvas create --name "…" --folder ${str(folder, 'id') ?? '<fld_…>'}`);
  });
}

/** Name-collision codes the drive lane returns per item kind — one shared recovery. */
const NAME_CONFLICT_HINT =
  'Something with that name is already there — pick a different name (moda drive rename), or choose another folder.';

export async function performDriveMove(
  client: ApiClient,
  item: DriveItemRef,
  destination: string | null,
): Promise<CommandOutcome> {
  const response = await client
    .request({ method: 'POST', path: endpoints.driveItemMove(item.ref), body: { folder_id: destination } })
    .catch((err: unknown) =>
      withCodeHint(err, {
        folder_name_conflict: NAME_CONFLICT_HINT,
        file_name_conflict: NAME_CONFLICT_HINT,
        canvas_name_conflict: NAME_CONFLICT_HINT,
        folder_circular_reference:
          'A folder cannot move into itself or one of its own descendants — pick a destination outside its subtree (moda drive tree).',
        brand_kit_folder_protected: 'Brand-kit folders are managed by Moda and cannot be moved.',
      }),
    );
  const root = asObject(response.body);
  const moved = asObject(root.item);
  return driveOutcome('drive.move', root, response, (write) => {
    write(`drive.move: ${itemLabel(moved, item)} → ${destination ?? 'the team root'}`);
  });
}

export async function performDriveRename(
  client: ApiClient,
  item: DriveItemRef,
  name: string,
): Promise<CommandOutcome> {
  const response = await client
    .request({ method: 'PATCH', path: endpoints.driveItem(item.ref), body: { name } })
    .catch((err: unknown) =>
      withCodeHint(err, {
        folder_name_conflict: NAME_CONFLICT_HINT,
        file_name_conflict: NAME_CONFLICT_HINT,
        canvas_name_conflict: NAME_CONFLICT_HINT,
      }),
    );
  const root = asObject(response.body);
  const renamed = asObject(root.item);
  return driveOutcome('drive.rename', root, response, (write) => {
    write(`drive.rename: ${str(renamed, 'kind') ?? item.kind} ${str(renamed, 'id') ?? item.ref} is now "${str(renamed, 'name') ?? name}"`);
  });
}

export async function performDriveVisibility(
  client: ApiClient,
  item: DriveItemRef,
  visibility: Visibility,
): Promise<CommandOutcome> {
  const response = await client
    .request({ method: 'PATCH', path: endpoints.driveItem(item.ref), body: { visibility } })
    .catch((err: unknown) =>
      withCodeHint(err, {
        visibility_change_denied:
          'Only the creator can change a canvas’s visibility, and a file needs edit permission — ask them, or leave it as it is.',
        system_folder_visibility_locked: 'This is a system folder — its visibility is fixed and cannot be changed.',
      }),
    );
  const root = asObject(response.body);
  const updated = asObject(root.item);
  const effective = str(updated, 'visibility') ?? visibility;
  return driveOutcome('drive.visibility', root, response, (write) => {
    write(
      `drive.visibility: ${itemLabel(updated, item)} is now ${effective} — ` +
        `${effective === 'private' ? 'hidden from teammates' : 'visible to the whole team'}` +
        `${updated.visibility_inherited === true ? ' (inherited from the folder it lives in)' : ''}`,
    );
  });
}

export async function performDriveDelete(
  client: ApiClient,
  item: DriveItemRef,
  recursive: boolean,
): Promise<CommandOutcome> {
  const response = await client
    .request({
      method: 'DELETE',
      path: endpoints.driveItem(item.ref),
      query: recursive ? { recursive: 'true' } : {},
    })
    .catch((err: unknown) =>
      withCodeHint(err, {
        folder_not_empty:
          `This folder still has contents. Once the user has approved deleting everything inside it, re-run: ` +
          `moda drive rm ${item.ref} --recursive --yes`,
        brand_kit_folder_protected: 'Brand-kit folders are managed by Moda and cannot be deleted.',
      }),
    );
  const root = asObject(response.body);
  const deleted = asObject(root.item);
  return driveOutcome('drive.rm', root, response, (write) => {
    write(`drive.rm: deleted ${itemLabel(deleted, item)}${root.recursive === true ? ' and everything inside it' : ''}`);
  });
}
