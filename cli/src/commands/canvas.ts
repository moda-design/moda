/** `moda canvas` — the deterministic authoring core (cli.md §9) plus lifecycle reuse verbs. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { endpoints } from '../api/endpoints.ts';
import { asObject, str } from '../api/types.ts';
import { resolveAppBase, openBrowser } from '../auth/login.ts';
import { CliError } from '../cliError.ts';
import { shotsDir } from '../config/state.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import { extractShortIds } from '../refs.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction, type Invocation } from './runtime.ts';
import {
  cacheFromResponse,
  chooseRevision,
  mutationOutcome,
  parseSize,
  passthroughOutcome,
  readFileArg,
  resolveCanvasRef,
  warnStaleShortIds,
} from './canvasShared.ts';

const MUTATION_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 60_000;
const SCREENSHOT_TIMEOUT_MS = 180_000;

export function registerCanvas(program: Command): void {
  const canvas = program.command('canvas').description('deterministic canvas authoring and lifecycle');

  // --- Create and structure ---

  addGlobalFlags(
    canvas
      .command('create')
      .description('create a canvas')
      .requiredOption('--name <name>', 'canvas name')
      .option('--brand <brand>', 'brand kit ref')
      .option('--size <WxH>', 'page size, e.g. 1920x1080')
      .option('--pages <n>', 'initial page count', (v: string) => Number.parseInt(v, 10))
      .option('--folder <folder>', 'destination folder id')
      .option('--category <category>', 'canvas category (drives export defaults and multi-page semantics)'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MUTATION_TIMEOUT_MS);
      const payload = {
        name: opts.name as string,
        ...(typeof opts.brand === 'string' ? { brand_id: opts.brand } : {}),
        ...(typeof opts.size === 'string' ? { size: parseSize(opts.size) } : {}),
        ...(typeof opts.pages === 'number' ? { pages: opts.pages } : {}),
        ...(typeof opts.folder === 'string' ? { folder_id: opts.folder } : {}),
        ...(typeof opts.category === 'string' ? { category: opts.category } : {}),
      };
      const response = await client.request({
        method: 'POST',
        path: endpoints.canvasCreate(),
        body: payload,
        idempotency: {
          command: 'canvas create',
          canvas: '',
          expectedRevision: undefined,
          payload: JSON.stringify(payload),
        },
      });
      return mutationOutcome('canvas.create', '', inv, response);
    }),
  );

  addGlobalFlags(
    canvas
      .command('add-pages <canvas>')
      .description('append pages to a canvas')
      .requiredOption('--count <n>', 'number of pages to add', (v: string) => Number.parseInt(v, 10))
      .option('--size <WxH>', 'page size override')
      .option('--revision <token>', 'expected revision (advisory on appends)'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MUTATION_TIMEOUT_MS);
      const ref = await resolveCanvasRef(args[0] as string, client);
      const revision = chooseRevision(ref, opts.revision as string | undefined, false, inv.env);
      const payload = {
        count: opts.count as number,
        ...(typeof opts.size === 'string' ? { size: parseSize(opts.size) } : {}),
        ...(revision.expectedRevision !== undefined ? { expected_revision: revision.expectedRevision } : {}),
      };
      const response = await client.request({
        method: 'POST',
        path: endpoints.canvasAddPages(ref),
        body: payload,
        idempotency: {
          command: 'canvas add-pages',
          canvas: ref,
          expectedRevision: revision.expectedRevision,
          payload: JSON.stringify(payload),
        },
      });
      return mutationOutcome('canvas.create_pages', ref, inv, response);
    }),
  );

  // --- Author ---

  addGlobalFlags(
    canvas
      .command('markup <canvas>')
      .description('apply XML markup to a page (append or atomic full-page replace)')
      .requiredOption('--file <path>', "markup file, or '-' for stdin")
      .option('--page <page_id>', 'target page (short id or "canvas" for floating nodes)')
      .option('--mode <mode>', 'append | replace', 'append')
      .option('--revision <token>', 'expected revision (required for --mode replace)'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const mode = opts.mode as string;
      if (mode !== 'append' && mode !== 'replace') {
        throw CliError.usage(`Invalid --mode '${mode}' — expected append or replace.`);
      }
      const markup = await readFileArg(opts.file as string);
      const { client } = await authedClient(inv, MUTATION_TIMEOUT_MS);
      const ref = await resolveCanvasRef(args[0] as string, client);
      const revision = chooseRevision(ref, opts.revision as string | undefined, mode === 'replace', inv.env);
      const payload = {
        markup,
        mode: mode === 'replace' ? 'replace_page_nodes' : 'append',
        ...(typeof opts.page === 'string' ? { page_id: opts.page } : {}),
        ...(revision.expectedRevision !== undefined ? { expected_revision: revision.expectedRevision } : {}),
      };
      const response = await client.request({
        method: 'POST',
        path: endpoints.canvasMarkup(ref),
        body: payload,
        idempotency: {
          command: 'canvas markup',
          canvas: ref,
          expectedRevision: revision.expectedRevision,
          payload: JSON.stringify(payload),
        },
      });
      return mutationOutcome('canvas.create_from_markup', ref, inv, response);
    }),
  );

  addGlobalFlags(
    canvas
      .command('edit <canvas>')
      .description('run a sandboxed JS edit batch against the canvas')
      .requiredOption('--file <path>', "edit program file, or '-' for stdin")
      .option('--page <page_id>', 'target page')
      .option('--revision <token>', 'expected revision (defaults to the cached last read; required)'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const code = await readFileArg(opts.file as string);
      const { client } = await authedClient(inv, MUTATION_TIMEOUT_MS);
      const ref = await resolveCanvasRef(args[0] as string, client);
      const revision = chooseRevision(ref, opts.revision as string | undefined, true, inv.env);
      warnStaleShortIds(ref, extractShortIds(code), inv);
      const payload = {
        code,
        ...(typeof opts.page === 'string' ? { page_id: opts.page } : {}),
        expected_revision: revision.expectedRevision,
      };
      const response = await client.request({
        method: 'POST',
        path: endpoints.canvasEdit(ref),
        body: payload,
        idempotency: {
          command: 'canvas edit',
          canvas: ref,
          expectedRevision: revision.expectedRevision,
          payload: JSON.stringify(payload),
        },
      });
      return mutationOutcome('canvas.edit', ref, inv, response);
    }),
  );

  addGlobalFlags(
    canvas
      .command('delete-items <canvas> <node_ids...>')
      .description('delete nodes by id (standalone by contract — remove() throws inside edit code)')
      .option('--revision <token>', 'expected revision (defaults to the cached last read; required)')
      .option('--yes', 'confirm large deletions under --json/--no-input'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const [refArg, ...nodeIds] = args;
      if (nodeIds.length === 0) throw CliError.usage('Pass at least one NODE_ID.');
      if (nodeIds.length > 10 && inv.flags.noInput && opts.yes !== true) {
        throw CliError.usage(
          `Deleting ${nodeIds.length} nodes requires --yes under --json/--no-input.`,
          'Destructive verbs need the host approval step (cli.md §9).',
        );
      }
      const { client } = await authedClient(inv, MUTATION_TIMEOUT_MS);
      const ref = await resolveCanvasRef(refArg as string, client);
      const revision = chooseRevision(ref, opts.revision as string | undefined, true, inv.env);
      warnStaleShortIds(ref, nodeIds.filter((id) => /^(n\d+|p_[a-z0-9]+|img\d+)$/.test(id)), inv);
      const payload = { node_ids: nodeIds, expected_revision: revision.expectedRevision };
      const response = await client.request({
        method: 'POST',
        path: endpoints.canvasDeleteItems(ref),
        body: payload,
        idempotency: {
          command: 'canvas delete-items',
          canvas: ref,
          expectedRevision: revision.expectedRevision,
          payload: JSON.stringify(payload),
        },
      });
      return mutationOutcome('canvas.delete_items', ref, inv, response);
    }),
  );

  // --- The explicit revise loop ---

  addGlobalFlags(
    canvas
      .command('read <canvas>')
      .description('authoring DSL state snapshot + revision token')
      .option('--page <page_id>', 'limit to one page')
      .option('--node <node_id>', 'limit to one node')
      .option('--detail <level>', 'detail level (server-defined)'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      const ref = await resolveCanvasRef(args[0] as string, client);
      const response = await client.request({
        method: 'GET',
        path: endpoints.canvasState(ref),
        query: {
          page: opts.page as string | undefined,
          node: opts.node as string | undefined,
          detail: opts.detail as string | undefined,
        },
      });
      const root = asObject(response.body);
      const dsl = str(root, 'state') ?? str(root, 'dsl') ?? '';
      cacheFromResponse(ref, root, inv.env, dsl);
      return {
        body: {
          ok: true,
          operation: 'canvas.read',
          ...root,
          meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
        },
        human: (write) => {
          if (dsl.length > 0) write(dsl);
          const revision = str(root, 'revision');
          if (revision !== undefined) write(`revision: ${revision}`);
        },
        exitCode: EXIT_OK,
      };
    }),
  );

  addGlobalFlags(
    canvas
      .command('lint <canvas>')
      .description('read-only design linter (exits 0 whenever the lint ran)')
      .option('--page <page_id>', 'limit to one page'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      const ref = await resolveCanvasRef(args[0] as string, client);
      const response = await client.request({
        method: 'POST',
        path: endpoints.canvasLint(ref),
        body: typeof opts.page === 'string' ? { page_id: opts.page } : {},
      });
      const root = asObject(response.body);
      return {
        body: {
          ok: true,
          operation: 'canvas.lint',
          ...root,
          meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
        },
        exitCode: EXIT_OK,
      };
    }),
  );

  addGlobalFlags(
    canvas
      .command('screenshot <canvas>')
      .description('render pages to PNG files (the revise loop is explicit: mutate → screenshot → inspect)')
      .option('--page <pages>', 'comma-separated page ids')
      .option('--pixel-ratio <n>', 'pixel ratio 1-4', (v: string) => Number.parseInt(v, 10))
      .option('-o, --output <path>', 'output file (single page) or directory'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, SCREENSHOT_TIMEOUT_MS);
      const ref = await resolveCanvasRef(args[0] as string, client);
      const pages = typeof opts.page === 'string' ? opts.page.split(',').map((p) => p.trim()) : undefined;
      const response = await client.request({
        method: 'POST',
        path: endpoints.canvasScreenshot(ref),
        body: {
          ...(pages !== undefined ? { page_ids: pages } : {}),
          ...(typeof opts.pixelRatio === 'number' ? { pixel_ratio: opts.pixelRatio } : {}),
        },
      });
      const root = asObject(response.body);
      const written = writeScreenshotPages(root, ref, opts.output as string | undefined, inv);
      const { pages: _dropped, ...rest } = root;
      return {
        body: {
          ok: true,
          operation: 'canvas.screenshot',
          ...rest,
          pages: written,
          meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
        },
        human: (write) => {
          for (const page of written) write(`${page.page_id ?? '?'} → ${page.path}`);
        },
        exitCode: EXIT_OK,
      };
    }),
  );

  // --- Lifecycle (existing public REST) ---

  addGlobalFlags(
    canvas
      .command('list')
      .description('list canvases (cursor pagination)')
      .option('--limit <n>', 'page size', (v: string) => Number.parseInt(v, 10))
      .option('--cursor <cursor>', 'pagination cursor'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      const response = await client.request({
        method: 'GET',
        path: endpoints.canvasList(),
        query: {
          limit: typeof opts.limit === 'number' ? String(opts.limit) : undefined,
          cursor: opts.cursor as string | undefined,
        },
      });
      return passthroughOutcome('canvas.list', response, inv);
    }),
  );

  addGlobalFlags(canvas.command('search <query>').description('search canvases')).action(
    wrapAction(async (args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      const response = await client.request({
        method: 'GET',
        path: endpoints.canvasSearch(),
        query: { q: args[0] as string },
      });
      return passthroughOutcome('canvas.search', response, inv);
    }),
  );

  addGlobalFlags(
    canvas
      .command('show <canvas>')
      .description('canvas details + pages')
      .option('--tokens', 'include design tokens'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      const ref = await resolveCanvasRef(args[0] as string, client);
      const details = await client.request({ method: 'GET', path: endpoints.canvasShow(ref) });
      const pages = await client.request({ method: 'GET', path: endpoints.canvasPages(ref) });
      const tokens = opts.tokens === true ? await client.request({ method: 'GET', path: endpoints.canvasTokens(ref) }) : undefined;
      return {
        body: {
          ok: true,
          operation: 'canvas.show',
          canvas: asObject(details.body),
          pages: pages.body,
          ...(tokens !== undefined ? { tokens: tokens.body } : {}),
          meta: metaBlock({ requestId: details.requestId, durationMs: details.durationMs }),
        },
        exitCode: EXIT_OK,
      };
    }),
  );

  addGlobalFlags(canvas.command('rename <canvas> <name>').description('rename a canvas')).action(
    wrapAction(async (args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      const ref = await resolveCanvasRef(args[0] as string, client);
      const response = await client.request({
        method: 'PATCH',
        path: endpoints.canvasRename(ref),
        body: { name: args[1] as string },
      });
      return passthroughOutcome('canvas.rename', response, inv);
    }),
  );

  addGlobalFlags(
    canvas
      .command('share <canvas>')
      .description('create/print the share URL')
      .option('--remix', 'allow remixing'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      const ref = await resolveCanvasRef(args[0] as string, client);
      const response = await client.request({
        method: 'POST',
        path: endpoints.canvasShare(ref),
        body: opts.remix === true ? { remix: true } : {},
      });
      const root = asObject(response.body);
      const url = str(root, 'share_url') ?? str(root, 'url');
      return {
        body: {
          ok: true,
          operation: 'canvas.share',
          ...root,
          meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
        },
        human: (write) => write(url ?? JSON.stringify(root)),
        exitCode: EXIT_OK,
      };
    }),
  );

  addGlobalFlags(canvas.command('open <canvas>').description('open the canvas in the browser (local)')).action(
    wrapAction(async (args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const parsedRef = args[0] as string;
      const appBase = resolveAppBase(inv.context.apiBase.value, inv.env);
      // Local verb: build the editor URL without a network call when the ref is direct.
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      const ref = await resolveCanvasRef(parsedRef, client);
      const url = new URL(`/c/${ref}`, appBase).toString();
      const opened = await openBrowser(url, inv.env);
      if (!opened) inv.note(`Open manually: ${url}`);
      return {
        body: { ok: true, operation: 'canvas.open', editor_url: url, opened, meta: metaBlock() },
        human: (write) => write(url),
        exitCode: EXIT_OK,
      };
    }),
  );
}

interface WrittenPage {
  page_id?: string;
  path: string;
}

function writeScreenshotPages(
  root: Record<string, unknown>,
  ref: string,
  output: string | undefined,
  inv: Invocation,
): WrittenPage[] {
  const pagesRaw = Array.isArray(root.pages) ? root.pages : [];
  const written: WrittenPage[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  pagesRaw.forEach((pageRaw, index) => {
    const page = asObject(pageRaw);
    const dataUrl = str(page, 'dataURL') ?? str(page, 'data_url');
    if (dataUrl === undefined) return;
    const pageId = str(page, 'page_id') ?? str(page, 'id');
    const comma = dataUrl.indexOf(',');
    const bytes = Buffer.from(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, 'base64');
    let path: string;
    if (output !== undefined && pagesRaw.length === 1) {
      path = output;
    } else if (output !== undefined) {
      path = join(output, `${pageId ?? `page-${index + 1}`}.png`);
    } else {
      path = join(shotsDir(ref, inv.env), `${stamp}-${pageId ?? index + 1}.png`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    written.push({ page_id: pageId, path });
  });
  return written;
}

