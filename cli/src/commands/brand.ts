/** `moda brand` — brand kits (cli.md §8). Brand APPLICATION is client-side: author with tokens. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import { endpoints } from '../api/endpoints.ts';
import { asObject, listItems, str } from '../api/types.ts';
import { CliError } from '../cliError.ts';
import { readConfig, writeConfig } from '../config/config.ts';
import { writeRepoContextKey } from '../config/context.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import { parseRef } from '../refs.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction } from './runtime.ts';
import { LIST_ALL_CAP, fetchListPages, listFlagsOf, listOutcome, parseListLimit, parseListOffset } from './listLane.ts';
import { passthroughOutcome } from './canvasShared.ts';

const READ_TIMEOUT_MS = 60_000;
const CREATE_TIMEOUT_MS = 300_000;

export function registerBrand(program: Command): void {
  const brand = program.command('brand').description('brand kits: list, read tokens, set the default');

  addGlobalFlags(
    brand
      .command('list')
      .description('brand kits visible to this credential')
      .option('--limit <n>', 'page size', parseListLimit)
      .option('--cursor <token>', "resume token from a previous page's next_cursor")
      .option('--all', `fetch every page (bounded at ${LIST_ALL_CAP} items)`)
      .option('--output <file>', 'write the full payload to a file; stdout gets a small summary + preview'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const flags = listFlagsOf(opts);
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      // Cursor lane (#9317): brand-kits page by next_cursor (items under `data`).
      const pages = await fetchListPages(client, endpoints.brandList(), {}, flags, READ_TIMEOUT_MS, 'cursor');
      return listOutcome({
        operation: 'brand.list',
        pages,
        flags,
        emptyHint: 'no brand kits',
        itemLine: (kit) => `${str(kit, 'id') ?? '?'}  ${str(kit, 'name') ?? ''}`,
      });
    }),
  );

  addGlobalFlags(brand.command('guides <brand>').description("list the kit's brand-guide documents (the written brand rules)")).action(
    wrapAction(async (args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      const ref = parseRef(args[0] as string, 'brand_kit').ref;
      const response = await client.request({ method: 'GET', path: endpoints.brandGuides(ref) });
      const root = asObject(response.body);
      const guides = Array.isArray(root.guides) ? root.guides.map(asObject) : [];
      return {
        body: {
          ok: true,
          ...root,
          operation: 'brand.guides',
          returned: guides.length,
          meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
        },
        human: (write) => {
          for (const guide of guides) {
            write(`${str(guide, 'id') ?? '?'}  ${str(guide, 'title') ?? ''}${str(guide, 'description') !== undefined ? ` — ${str(guide, 'description')}` : ''}`);
          }
          if (guides.length === 0) write('no guides on this kit');
        },
        exitCode: EXIT_OK,
      };
    }),
  );

  addGlobalFlags(
    brand.command('guide <brand> <guide_id>').description("read one guide's full prose (markdown; frontmatter under metadata)"),
  ).action(
    wrapAction(async (args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      const ref = parseRef(args[0] as string, 'brand_kit').ref;
      const response = await client.request({ method: 'GET', path: endpoints.brandGuide(ref, args[1] as string) });
      const root = asObject(response.body);
      const guide = asObject(root.guide);
      return {
        body: {
          ok: true,
          ...root,
          operation: 'brand.guide',
          meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
        },
        human: (write) => {
          const title = str(guide, 'title');
          if (title !== undefined) write(`# ${title}`);
          write(str(guide, 'markdown') ?? '(empty guide)');
        },
        exitCode: EXIT_OK,
      };
    }),
  );

  addGlobalFlags(
    brand.command('show <brand>').description('verbose kit: palette, fonts, logos (durable file_ ids + signed URLs)'),
  ).action(
    wrapAction(async (args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      const ref = parseRef(args[0] as string, 'brand_kit').ref;
      // Server contract: GET /v1/brand-kits/{ref} (gated verbose read) — no query params.
      const response = await client.request({ method: 'GET', path: endpoints.brandShow(ref) });
      return passthroughOutcome('brand.show', response, inv);
    }),
  );

  addGlobalFlags(
    brand
      .command('use <brand>')
      .description('persist defaults.brand (config, or repo context with --local)')
      .option('--local', 'write the repo .moda/context.local.json instead of the user config'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const ref = parseRef(args[0] as string, 'brand_kit').ref;
      let target: string;
      if (opts.local === true) {
        target = writeRepoContextKey('brand', ref, { local: true });
      } else {
        const config = readConfig(inv.env);
        config.defaults = { ...config.defaults, brand: ref };
        writeConfig(config, inv.env);
        target = 'config';
      }
      return {
        body: { ok: true, operation: 'brand.use', brand: ref, target, meta: metaBlock() },
        human: (write) => write(`default brand set to ${ref} (${target})`),
        exitCode: EXIT_OK,
      };
    }),
  );

  addGlobalFlags(
    brand
      .command('pull <brand>')
      .description('write the verbose kit JSON to a local file')
      .requiredOption('-o, --output <path>', 'output path, e.g. brand.json'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      const ref = parseRef(args[0] as string, 'brand_kit').ref;
      const response = await client.request({ method: 'GET', path: endpoints.brandShow(ref) });
      const outPath = opts.output as string;
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${JSON.stringify(response.body, null, 2)}\n`, 'utf8');
      return {
        body: { ok: true, operation: 'brand.pull', brand: ref, output: outPath, meta: metaBlock() },
        human: (write) => write(`${ref} → ${outPath}`),
        exitCode: EXIT_OK,
      };
    }),
  );

  addGlobalFlags(
    brand
      .command('create')
      .description('extract a brand kit from a website (deterministic — no credits)')
      .option('--url <url>', 'extract from a website')
      .option('--fig <path>', 'import from a .fig file (not yet available in the prototype)'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      if (typeof opts.fig === 'string') {
        throw new CliError({
          type: 'unprocessable',
          code: 'unsupported_import',
          message: '.fig brand import is not available in the prototype.',
          hint: 'Use --url, or import the .fig in the Moda app.',
          source: 'local',
        });
      }
      if (typeof opts.url !== 'string') throw CliError.usage('Pass --url <site> (e.g. --url acme.com).');
      const { client } = await authedClient(inv, CREATE_TIMEOUT_MS);
      const response = await client.request({
        method: 'POST',
        path: endpoints.brandCreate(),
        body: { url: opts.url },
        idempotency: { command: 'brand create', canvas: '', expectedRevision: undefined, payload: opts.url },
      });
      const root = asObject(response.body);
      return {
        body: {
          ok: true,
          operation: 'brand.create',
          ...root,
          meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
        },
        exitCode: EXIT_OK,
      };
    }),
  );
}
