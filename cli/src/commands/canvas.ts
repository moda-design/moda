/** `moda canvas` — the deterministic authoring core (cli.md §9) plus lifecycle reuse verbs. */
import type { Command } from 'commander';
import type { ApiClient } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { asObject, str } from '../api/types.ts';
import { resolveAppBase, openBrowser } from '../auth/login.ts';
import { CliError } from '../cliError.ts';
import { shotsDir } from '../config/state.ts';
import { alert, type CommandOutcome } from '../output/emit.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import { extractShortIds } from '../refs.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction, type Invocation } from './runtime.ts';
import {
  attachScreenshotResult,
  captureAfterMutation,
  pagesForMarkupTarget,
} from './mutationScreenshot.ts';
import { captureScreenshots, writeCaptureRun, writtenPageLine } from './screenshotCapture.ts';
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

const SCREENSHOT_FLAG_HELP =
  'after the commit, capture the touched page(s) to this file/dir (same behavior as canvas screenshot -o)';

/**
 * `--screenshot` sugar on mutation verbs: when the flag is present, run the standalone capture
 * for the touched page(s) right after the committed mutation and attach the result
 * (mutationScreenshot.ts). A capture failure never changes the mutation's exit code.
 */
async function maybeAttachScreenshot(input: {
  outcome: CommandOutcome;
  screenshot: unknown;
  client: ApiClient;
  ref: string;
  pages?: string[];
  inv: Invocation;
}): Promise<CommandOutcome> {
  if (typeof input.screenshot !== 'string') return input.outcome;
  const result = await captureAfterMutation({
    call: async (body) =>
      await input.client.request({
        method: 'POST',
        path: endpoints.canvasScreenshot(input.ref),
        body,
        timeoutMs: SCREENSHOT_TIMEOUT_MS,
      }),
    pages: input.pages,
    output: input.screenshot,
    shotsDirPath: shotsDir(input.ref, input.inv.env),
    note: input.inv.note,
    alert,
  });
  return attachScreenshotResult(input.outcome, result);
}

export function registerCanvas(program: Command): void {
  const canvas = program.command('canvas').description('deterministic canvas authoring and lifecycle');

  // --- Create and structure ---

  addGlobalFlags(
    canvas
      .command('create')
      .description('create a canvas (brand application is client-side: read the kit, author with its tokens)')
      .requiredOption('--name <name>', 'canvas name')
      .option('--size <WxH>', 'page size, e.g. 1920x1080')
      .option('--pages <n>', 'initial page count', (v: string) => Number.parseInt(v, 10))
      .option('--category <category>', 'canvas category (drives export defaults and multi-page semantics)'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, MUTATION_TIMEOUT_MS);
      // Server contract: CanvasCreateRequest {name, width, height, page_count, category?}.
      const size = typeof opts.size === 'string' ? parseSize(opts.size) : undefined;
      const payload = {
        name: opts.name as string,
        ...(size !== undefined ? { width: size.width, height: size.height } : {}),
        ...(typeof opts.pages === 'number' ? { page_count: opts.pages } : {}),
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
      // Server contract: CanvasPagesRequest {pages: int | per-page configs, width?, height?, expected_revision?}.
      const size = typeof opts.size === 'string' ? parseSize(opts.size) : undefined;
      const payload = {
        pages: opts.count as number,
        ...(size !== undefined ? { width: size.width, height: size.height } : {}),
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
      // No --screenshot here: freshly appended pages are blank — nothing worth capturing.
      return mutationOutcome('canvas.create_pages', ref, inv, response);
    }),
  );

  // --- Author ---

  addGlobalFlags(
    canvas
      .command('markup <canvas>')
      .description('apply XML markup to a page (append or atomic full-page replace)')
      .requiredOption('--file <path>', "markup file, or '-' for stdin")
      .requiredOption('--page <page_id>', 'target page (short id or "canvas" for floating nodes)')
      .option('--mode <mode>', 'append | replace', 'append')
      .option('--revision <token>', 'expected revision (required for --mode replace)')
      .option('--screenshot <path>', SCREENSHOT_FLAG_HELP),
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
      // Server contract: CanvasMarkupRequest {page_id (required), markup, mode, expected_revision?}.
      const payload = {
        page_id: opts.page as string,
        markup,
        mode: mode === 'replace' ? 'replace_page_nodes' : 'append',
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
      return await maybeAttachScreenshot({
        outcome: mutationOutcome('canvas.create_from_markup', ref, inv, response),
        screenshot: opts.screenshot,
        client,
        ref,
        pages: pagesForMarkupTarget(opts.page as string),
        inv,
      });
    }),
  );

  addGlobalFlags(
    canvas
      .command('edit <canvas>')
      .description('run a sandboxed JS edit batch against the canvas')
      .requiredOption('--file <path>', "edit program file, or '-' for stdin")
      .option('--page <page_id>', 'target page')
      .option('--revision <token>', 'expected revision (defaults to the cached last read; required)')
      .option('--screenshot <path>', SCREENSHOT_FLAG_HELP),
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
      return await maybeAttachScreenshot({
        outcome: mutationOutcome('canvas.edit', ref, inv, response),
        screenshot: opts.screenshot,
        client,
        ref,
        // Always the default capture: an edit program addresses ids canvas-wide, and --page only
        // scopes the read-only snapshot — steering the capture by it would mislead when the edit
        // landed elsewhere. (markup differs: its --page IS the destination.)
        pages: undefined,
        inv,
      });
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
      // Server contract: CanvasDeleteItemsRequest {ids, expected_revision}.
      const payload = { ids: nodeIds, expected_revision: revision.expectedRevision };
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
      .option('--page <page_id>', 'limit to one page'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      const ref = await resolveCanvasRef(args[0] as string, client);
      // Server contract: GET .../state?page_id= — the only query param the endpoint accepts.
      const response = await client.request({
        method: 'GET',
        path: endpoints.canvasState(ref),
        query: { page_id: opts.page as string | undefined },
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
      // Server contract: CanvasLintRequest {page_ids?: string[]}.
      const response = await client.request({
        method: 'POST',
        path: endpoints.canvasLint(ref),
        body: typeof opts.page === 'string' ? { page_ids: [opts.page] } : {},
      });
      const root = asObject(response.body);
      cacheFromResponse(ref, root, inv.env); // lint is a read lane — its token is pinnable
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
      .description('render pages to image files (the revise loop is explicit: mutate → screenshot → inspect)')
      .option('--page <pages>', 'comma-separated page ids (requests past the server 3-per-call cap are auto-batched)')
      .option('--pixel-ratio <n>', 'pixel ratio 1-4', (v: string) => Number.parseInt(v, 10))
      .option('-o, --output <path>', 'output file (single page) or directory'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, SCREENSHOT_TIMEOUT_MS);
      const ref = await resolveCanvasRef(args[0] as string, client);
      const pages =
        typeof opts.page === 'string'
          ? (opts.page as string)
              .split(',')
              .map((p) => p.trim())
              .filter((p) => p.length > 0)
          : undefined;
      const capture = await captureScreenshots({
        call: async (body) => await client.request({ method: 'POST', path: endpoints.canvasScreenshot(ref), body }),
        pages,
        pixelRatio: typeof opts.pixelRatio === 'number' ? opts.pixelRatio : undefined,
        note: inv.note,
      });
      const written = writeCaptureRun({
        capture,
        output: opts.output as string | undefined,
        shotsDirPath: shotsDir(ref, inv.env),
        note: inv.note,
      });
      const firstRoot = capture.roots[0] ?? {};
      const { pages: _dropped, ...rest } = firstRoot;
      return {
        body: {
          ok: true,
          operation: 'canvas.screenshot',
          // First response's fields verbatim (incl. clamp_note); `truncated` marks that the
          // server clamped the single-call request — the batched `pages` below still carry
          // every requested page.
          ...rest,
          ...(capture.truncated ? { truncated: true } : {}),
          ...(capture.calls > 1 ? { capture_calls: capture.calls } : {}),
          pages: written,
          meta: {
            ...asObject(firstRoot.meta),
            ...metaBlock({ requestId: capture.requestId, durationMs: capture.durationMs }),
          },
        },
        human: (write) => {
          for (const page of written) write(writtenPageLine(page));
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
      // Server contract: MakeCanvasPublicRequest {permission: 'view'|'view_remix'} (default view_remix).
      const response = await client.request({
        method: 'POST',
        path: endpoints.canvasShare(ref),
        body: { permission: opts.remix === true ? 'view_remix' : 'view' },
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

  addGlobalFlags(
    canvas
      .command('delete <canvas>')
      .description('delete a canvas (destructive — requires --yes under --json/--no-input)')
      .option('--yes', 'confirm deletion'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      if (inv.flags.noInput && opts.yes !== true) {
        throw CliError.usage(
          'Deleting a canvas requires --yes under --json/--no-input.',
          'Destructive verbs need the host approval step (cli.md §9).',
        );
      }
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      const ref = await resolveCanvasRef(args[0] as string, client);
      const response = await client.request({ method: 'DELETE', path: endpoints.canvasDelete(ref) });
      const root = asObject(response.body);
      return {
        body: {
          ok: true,
          operation: 'canvas.delete',
          canvas_id: ref,
          ...root,
          meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
        },
        human: (write) => write(`deleted ${ref}`),
        exitCode: EXIT_OK,
      };
    }),
  );
}

