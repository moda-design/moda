/** `moda brand` — brand kits (cli.md §8). Brand APPLICATION is client-side: author with tokens. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import type { ApiClient } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { asObject, listItems, str } from '../api/types.ts';
import { CliError } from '../cliError.ts';
import { readConfig, writeConfig } from '../config/config.ts';
import { writeRepoContextKey } from '../config/context.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import type { CommandOutcome } from '../output/emit.ts';
import { parseRef } from '../refs.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction } from './runtime.ts';
import { LIST_ALL_CAP, fetchListPages, listFlagsOf, listOutcome, parseListLimit, parseListOffset } from './listLane.ts';
import { passthroughOutcome } from './canvasShared.ts';

const READ_TIMEOUT_MS = 60_000;
const CREATE_TIMEOUT_MS = 300_000;
const WRITE_TIMEOUT_MS = 60_000;

/** `--color '#0F172A:Primary'` → `{color, label?}` (label optional, may itself contain colons). */
export function parseColorFlag(value: string): { color: string; label?: string } {
  const sep = value.indexOf(':');
  const color = (sep === -1 ? value : value.slice(0, sep)).trim();
  if (color.length === 0) throw CliError.usage(`Empty color in --color '${value}'.`, "Format: --color '#0F172A:Primary' (label optional).");
  const label = sep === -1 ? undefined : value.slice(sep + 1).trim();
  return label !== undefined && label.length > 0 ? { color, label } : { color };
}

/** `--font 'Inter:title:600'` → `{family, label?, weight?}` (`'Inter::600'` skips the label). */
export function parseFontFlag(value: string): { family: string; label?: string; weight?: number } {
  const [familyRaw, labelRaw, weightRaw] = value.split(':', 3);
  const family = (familyRaw ?? '').trim();
  if (family.length === 0) throw CliError.usage(`Empty font family in --font '${value}'.`, "Format: --font 'Inter:title:600' (label and weight optional; 'Inter::600' skips the label).");
  const entry: { family: string; label?: string; weight?: number } = { family };
  const label = labelRaw?.trim();
  if (label !== undefined && label.length > 0) entry.label = label;
  const weightText = weightRaw?.trim();
  if (weightText !== undefined && weightText.length > 0) {
    const weight = Number.parseInt(weightText, 10);
    if (!Number.isFinite(weight) || String(weight) !== weightText) {
      throw CliError.usage(`Font weight '${weightText}' in --font '${value}' is not an integer.`);
    }
    entry.weight = weight;
  }
  return entry;
}

const collectRepeatable = (value: string, previous: string[] = []): string[] => [...previous, value];

interface ManualCreateFields {
  name?: string;
  colors?: Array<{ color: string; label?: string }>;
  fonts?: Array<{ family: string; label?: string; weight?: number }>;
  logo_file_ids?: string[];
}

/** Build the manual-create body from `--from-file kit.json` (the full-kit lane). */
export function readManualKitFile(path: string): ManualCreateFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw CliError.usage(
      `Cannot read kit file '${path}': ${error instanceof Error ? error.message : String(error)}`,
      'Expected JSON: {"name": "...", "colors": [{"color": "#0F172A", "label": "Primary"}], "fonts": [{"family": "Inter"}], "logo_file_ids": ["file_..."]}',
    );
  }
  const root = asObject(parsed);
  const body: ManualCreateFields = {};
  if (typeof root.name === 'string') body.name = root.name;
  if (Array.isArray(root.colors)) body.colors = root.colors as ManualCreateFields['colors'];
  if (Array.isArray(root.fonts)) body.fonts = root.fonts as ManualCreateFields['fonts'];
  if (Array.isArray(root.logo_file_ids)) body.logo_file_ids = (root.logo_file_ids as unknown[]).map(String);
  if (body.name === undefined) throw CliError.usage(`Kit file '${path}' has no "name".`, 'A manual kit needs at least a name.');
  return body;
}

export async function performBrandCreate(client: ApiClient, body: Record<string, unknown>): Promise<CommandOutcome> {
  const response = await client.request({
    method: 'POST',
    path: endpoints.brandCreate(),
    body,
    idempotency: { command: 'brand create', canvas: '', expectedRevision: undefined, payload: JSON.stringify(body) },
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
}

export async function performBrandUpdate(client: ApiClient, ref: string, patch: Record<string, unknown>): Promise<CommandOutcome> {
  const response = await client.request({ method: 'PATCH', path: endpoints.brandUpdate(ref), body: patch });
  const root = asObject(response.body);
  return {
    body: {
      ok: true,
      operation: 'brand.update',
      ...root,
      meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
    },
    human: (write) => write(`brand.update: ${str(root, 'id') ?? ref} — "${str(root, 'title') ?? ''}"`),
    exitCode: EXIT_OK,
  };
}

export async function performBrandImages(client: ApiClient, ref: string): Promise<CommandOutcome> {
  const response = await client.request({ method: 'GET', path: endpoints.brandImages(ref) });
  const root = asObject(response.body);
  const rows = Array.isArray(root.data) ? root.data.map(asObject) : [];
  return {
    body: {
      ok: true,
      operation: 'brand.images',
      ...root,
      meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
    },
    human: (write) => {
      for (const row of rows) {
        const label = str(row, 'name');
        write(`${str(row, 'id') ?? '?'}  ${str(row, 'role') ?? '?'}  ${label ?? '(unnamed)'}  [${str(row, 'group_name') ?? ''}]`);
      }
      if (rows.length === 0) write('no images on this kit — add one: moda brand add-image <brand> --file <file_ref>');
    },
    exitCode: EXIT_OK,
  };
}

export async function performBrandAddImage(
  client: ApiClient,
  ref: string,
  input: { file_id: string; role: string; label?: string },
): Promise<CommandOutcome> {
  const response = await client.request({
    method: 'POST',
    path: endpoints.brandImages(ref),
    body: { file_id: input.file_id, role: input.role, ...(input.label !== undefined ? { label: input.label } : {}) },
  });
  const root = asObject(response.body);
  return {
    body: {
      ok: true,
      operation: 'brand.add-image',
      ...root,
      meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
    },
    human: (write) => {
      write(`added ${input.role} ${input.file_id} to ${ref}`);
      write(`list attachments (with their bki_ ids): moda brand images ${ref}`);
    },
    exitCode: EXIT_OK,
  };
}

export async function performBrandRemoveImage(client: ApiClient, ref: string, imageId: string): Promise<CommandOutcome> {
  const response = await client.request({ method: 'DELETE', path: endpoints.brandImage(ref, imageId) });
  return {
    body: {
      ok: true,
      operation: 'brand.remove-image',
      brand: ref,
      image_id: imageId,
      meta: metaBlock({ requestId: response.requestId, durationMs: response.durationMs }),
    },
    human: (write) => write(`removed ${imageId} from ${ref}`),
    exitCode: EXIT_OK,
  };
}

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
      .description('create a brand kit: extract from a website, or build manually from fields (deterministic — no credits)')
      .option('--url <url>', 'extract from a website (mutually exclusive with the manual flags)')
      .option('--name <name>', 'manual path: kit name (doubles as the company name)')
      .option('--color <hex[:label]>', "manual path: palette entry, repeatable (e.g. --color '#0F172A:Primary')", collectRepeatable)
      .option('--font <family[:label[:weight]]>', "manual path: font entry, repeatable (e.g. --font 'Inter:title:600')", collectRepeatable)
      .option('--logo <file_ref>', 'manual path: attach an uploaded file_ ref as a logo, repeatable (upload first: moda file upload)', collectRepeatable)
      .option('--from-file <path>', 'manual path: full kit JSON ({name, colors, fonts, logo_file_ids}) — beats many flags for rich palettes')
      .option('--fig <path>', 'import from a .fig file (not yet available in the prototype)'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      if (typeof opts.fig === 'string') {
        throw new CliError({
          type: 'unprocessable',
          code: 'unsupported_import',
          message: '.fig brand import is not available in the prototype.',
          hint: 'Use --url or the manual fields, or import the .fig in the Moda app.',
          source: 'local',
        });
      }
      const manualFlagUsed =
        typeof opts.name === 'string' || Array.isArray(opts.color) || Array.isArray(opts.font) || Array.isArray(opts.logo);
      if (typeof opts.url === 'string' && (manualFlagUsed || typeof opts.fromFile === 'string')) {
        throw CliError.usage('--url is one creation path, the manual fields are the other — pass one or the other, not both.');
      }
      if (typeof opts.fromFile === 'string' && manualFlagUsed) {
        throw CliError.usage('--from-file already carries the whole kit — do not combine it with --name/--color/--font/--logo.');
      }

      let body: Record<string, unknown>;
      if (typeof opts.url === 'string') {
        body = { url: opts.url };
      } else if (typeof opts.fromFile === 'string') {
        body = { ...readManualKitFile(opts.fromFile) };
      } else if (manualFlagUsed) {
        if (typeof opts.name !== 'string') throw CliError.usage('The manual path needs --name <kit name>.');
        body = { name: opts.name };
        if (Array.isArray(opts.color)) body.colors = (opts.color as string[]).map(parseColorFlag);
        if (Array.isArray(opts.font)) body.fonts = (opts.font as string[]).map(parseFontFlag);
        if (Array.isArray(opts.logo)) body.logo_file_ids = (opts.logo as string[]).map((ref) => parseRef(ref, 'file').ref);
      } else {
        throw CliError.usage(
          "Pass --url <site> to extract from a website, or --name (+ --color/--font/--logo) / --from-file kit.json to build a kit manually.",
        );
      }

      const { client } = await authedClient(inv, CREATE_TIMEOUT_MS);
      return performBrandCreate(client, body);
    }),
  );

  addGlobalFlags(
    brand
      .command('update <brand>')
      .description('update kit fields in place (fix an extraction, evolve the kit) — colors/fonts REPLACE the whole list')
      .option('--title <name>', 'kit display name')
      .option('--company-name <name>', 'company name')
      .option('--description <text>', 'company description')
      .option('--tagline <text>', 'tagline')
      .option('--values <csv>', "brand values, comma-separated (e.g. 'transparent,fast')")
      .option('--tone <csv>', "tone-of-voice words, comma-separated (e.g. 'direct,friendly')")
      .option('--color <hex[:label]>', 'palette entry, repeatable — the flags you pass become the ENTIRE palette', collectRepeatable)
      .option('--font <family[:label[:weight]]>', 'font entry, repeatable — the flags you pass become the ENTIRE font list', collectRepeatable),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const ref = parseRef(args[0] as string, 'brand_kit').ref;
      const patch: Record<string, unknown> = {};
      if (typeof opts.title === 'string') patch.title = opts.title;
      if (typeof opts.companyName === 'string') patch.company_name = opts.companyName;
      if (typeof opts.description === 'string') patch.company_description = opts.description;
      if (typeof opts.tagline === 'string') patch.tagline = opts.tagline;
      if (typeof opts.values === 'string') patch.brand_values = (opts.values as string).split(',').map((v) => v.trim()).filter((v) => v.length > 0);
      if (typeof opts.tone === 'string') patch.brand_tone_of_voice = (opts.tone as string).split(',').map((v) => v.trim()).filter((v) => v.length > 0);
      if (Array.isArray(opts.color)) patch.colors = (opts.color as string[]).map(parseColorFlag);
      if (Array.isArray(opts.font)) patch.fonts = (opts.font as string[]).map(parseFontFlag);
      if (Object.keys(patch).length === 0) {
        throw CliError.usage('Nothing to update — pass at least one field flag.', 'e.g. moda brand update <brand> --color "#0F172A:Primary" --color "#F97316:Accent"');
      }
      const { client } = await authedClient(inv, WRITE_TIMEOUT_MS);
      return performBrandUpdate(client, ref, patch);
    }),
  );

  addGlobalFlags(
    brand.command('images <brand>').description('list the kit\'s attached images (bki_ ids pair with remove-image)'),
  ).action(
    wrapAction(async (args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const ref = parseRef(args[0] as string, 'brand_kit').ref;
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      return performBrandImages(client, ref);
    }),
  );

  addGlobalFlags(
    brand
      .command('add-image <brand>')
      .description('attach an uploaded image to the kit (default role: logo)')
      .requiredOption('--file <file_ref>', 'the file_ ref from moda file upload')
      .option('--role <role>', 'logo | reference | asset', 'logo')
      .option('--label <text>', "human-readable label (e.g. 'Dark mode logo')"),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const ref = parseRef(args[0] as string, 'brand_kit').ref;
      const role = opts.role as string;
      if (!['logo', 'reference', 'asset'].includes(role)) {
        throw CliError.usage(`Unknown --role '${role}'.`, 'Roles: logo (brand marks), reference (style hints), asset (placeable imagery).');
      }
      const fileRef = parseRef(opts.file as string, 'file').ref;
      const { client } = await authedClient(inv, WRITE_TIMEOUT_MS);
      return performBrandAddImage(client, ref, { file_id: fileRef, role, label: opts.label as string | undefined });
    }),
  );

  addGlobalFlags(
    brand.command('remove-image <brand> <image_id>').description('detach an image by its bki_ id (from moda brand images)'),
  ).action(
    wrapAction(async (args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const ref = parseRef(args[0] as string, 'brand_kit').ref;
      const imageId = parseRef(args[1] as string, 'brand_kit_image').ref;
      const { client } = await authedClient(inv, WRITE_TIMEOUT_MS);
      return performBrandRemoveImage(client, ref, imageId);
    }),
  );
}
