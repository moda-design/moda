/**
 * `moda site` — hosted websites on *.moda.page (deterministic lane, 0 metered credits).
 *
 * Server contract (settled): v1 is static single-page sites — HTML in, published to
 * https://<slug>.moda.page. POST /v1/websites (create, idempotent), GET /v1/websites
 * (paginated), GET /v1/websites/{id}, PUT /v1/websites/{id}/content (replace HTML; does NOT
 * auto-republish — has_unpublished_changes signals staleness), POST .../publish (slug_prefix
 * hint on first publish only; review_status "pending_review" = published but held for review
 * before serving), POST .../unpublish, DELETE. Site ids are plain UUIDs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import type { ApiClient } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { asObject, str, type JsonObject } from '../api/types.ts';
import { CliError } from '../cliError.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import type { CommandOutcome } from '../output/emit.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction, type Invocation } from './runtime.ts';
import { LIST_ALL_CAP, fetchListPages, listFlagsOf, listOutcome, parseListOffset, type ListFlags } from './listLane.ts';
import { readFileArg } from './canvasShared.ts';

const SITE_TIMEOUT_MS = 120_000;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Route grammar the server enforces ON CREATION: /-rooted, [A-Za-z0-9_-] segments; /_moda reserved. */
export function isCanonicalRoutePath(route: string): boolean {
  return /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(route) && !route.startsWith('/_moda');
}

/**
 * Throwing form — ADD-PAGE ONLY. The server deliberately skips grammar validation on
 * update/delete so sites authored through other lanes are never orphaned (an out-of-grammar
 * path just 404s there); the CLI must not close that escape hatch — set-content/delete-page
 * get an advisory note at most, never a throw.
 */
export function validateRoutePath(route: string): string {
  if (!isCanonicalRoutePath(route)) {
    throw CliError.usage(
      `Invalid route '${route}'.`,
      "Routes are /-rooted with [A-Za-z0-9_-] segments (e.g. /pricing, /docs/faq); /_moda is reserved.",
    );
  }
  return route;
}

/** Site ids are plain UUIDs on the wire — no prefixed form, no URL sugar. */
export function parseSiteId(input: string): string {
  const trimmed = input.trim();
  if (!UUID_RE.test(trimmed)) {
    throw CliError.usage(`'${input}' is not a site id (a UUID).`, 'Find site ids with: moda site list');
  }
  return trimmed;
}

/** Destructive-verb approval gate, mirroring `moda canvas delete`. */
export function requireYes(action: string, noInput: boolean, yes: boolean, rerunCommand: string): void {
  if (noInput && !yes) {
    throw CliError.usage(
      `${action} requires --yes under --json/--no-input.`,
      `If the host/user approved this action, re-run with --yes: ${rerunCommand} --yes`,
    );
  }
}

export function registerSite(program: Command): void {
  const site = program
    .command('site')
    .description('hosted websites on *.moda.page — create, publish, manage (deterministic, unmetered)');

  addGlobalFlags(
    site
      .command('create')
      .description('create a site from a single HTML page')
      .requiredOption('--file <path>', "the page HTML file, or '-' for stdin")
      .option('--title <title>', 'site title'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, SITE_TIMEOUT_MS);
      const html = await readFileArg(opts.file as string);
      return performSiteCreate(client, { html, title: opts.title as string | undefined });
    }),
  );

  addGlobalFlags(
    site
      .command('list')
      .description("list the team's sites")
      .option('--limit <n>', 'page size, 1-100 (default 25)', parseCount)
      .option('--offset <n>', 'pagination offset', parseListOffset)
      .option('--all', `fetch every page (bounded at ${LIST_ALL_CAP} items)`)
      .option('--output <file>', 'write the full payload to a file; stdout gets a small summary + preview'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, SITE_TIMEOUT_MS);
      return performSiteList(client, listFlagsOf(opts));
    }),
  );

  addGlobalFlags(site.command('show <site>').description('site metadata, publish state, and live URL')).action(
    wrapAction(async (args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, SITE_TIMEOUT_MS);
      return performSiteShow(client, args[0] as string);
    }),
  );

  addGlobalFlags(
    site
      .command('set-content <site>')
      .description('replace page HTML (--path targets one route; the live site serves the last publish until you republish)')
      .requiredOption('--file <path>', "the new page HTML file, or '-' for stdin")
      .option('--path <route>', "target route (e.g. /pricing); omit for the site's single-page/home content")
      .option('--title <title>', 'update the site title (site-level form only)')
      .option(
        '--expected-version <n>',
        'read-modify-write guard: the version from your last read; mismatch fails instead of overwriting',
        parseVersion,
      ),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, SITE_TIMEOUT_MS);
      const html = await readFileArg(opts.file as string);
      if (typeof opts.path === 'string') {
        if (typeof opts.title === 'string') {
          throw CliError.usage('--title applies to the site, not a page — set it without --path.');
        }
        if (!isCanonicalRoutePath(opts.path)) {
          inv.note(`route '${opts.path}' is outside the canonical grammar — passing through (legacy paths are updatable; an unknown path 404s)`);
        }
        return performSitePageSetContent(client, args[0] as string, {
          path: opts.path,
          html,
          expectedVersion: opts.expectedVersion as number | undefined,
        });
      }
      return performSiteSetContent(client, args[0] as string, {
        html,
        title: opts.title as string | undefined,
        expectedVersion: opts.expectedVersion as number | undefined,
      });
    }),
  );

  addGlobalFlags(site.command('pages <site>').description("list the site's pages (path, name) + the pinnable version")).action(
    wrapAction(async (args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, SITE_TIMEOUT_MS);
      return performSitePages(client, args[0] as string);
    }),
  );

  addGlobalFlags(
    site
      .command('add-page <site>')
      .description('add a routable page from an HTML file')
      .requiredOption('--path <route>', "the new page's route, e.g. /pricing")
      .requiredOption('--file <path>', "the page HTML file, or '-' for stdin")
      .option('--name <name>', 'display name (derived from the path when omitted)')
      .option('--expected-version <n>', 'read-modify-write guard', parseVersion),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, SITE_TIMEOUT_MS);
      const html = await readFileArg(opts.file as string);
      return performSiteAddPage(client, args[0] as string, {
        path: opts.path as string,
        html,
        name: opts.name as string | undefined,
        expectedVersion: opts.expectedVersion as number | undefined,
      });
    }),
  );

  addGlobalFlags(
    site
      .command('delete-page <site>')
      .description('delete a routable page (the homepage cannot be deleted; requires --yes under --json/--no-input)')
      .requiredOption('--path <route>', 'the route to delete, e.g. /pricing')
      .option('--expected-version <n>', 'read-modify-write guard', parseVersion)
      .option('--yes', 'confirm deletion'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      requireYes('Deleting a page', inv.flags.noInput, opts.yes === true, `moda site delete-page ${args[0] as string} --path ${opts.path as string}`);
      if (!isCanonicalRoutePath(opts.path as string)) {
        inv.note(`route '${opts.path as string}' is outside the canonical grammar — passing through (legacy paths are deletable; an unknown path 404s)`);
      }
      const { client } = await authedClient(inv, SITE_TIMEOUT_MS);
      return performSiteDeletePage(client, args[0] as string, {
        path: opts.path as string,
        expectedVersion: opts.expectedVersion as number | undefined,
      });
    }),
  );

  addGlobalFlags(
    site
      .command('screenshot <site>')
      .description('render up to 3 pages to images (draft content; desktop/tablet/mobile viewport)')
      .option('--path <routes...>', 'route(s) to capture (default: the homepage)')
      .option('--viewport <vp>', 'desktop | tablet | mobile', 'desktop')
      .option('--format <fmt>', 'jpg | png', 'jpg')
      .option('--scale <n>', 'device scale factor 1-2 (default 2)', (v: string) => Number.parseInt(v, 10))
      .option('-o, --output <path>', 'output file (single capture) or directory'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, SCREENSHOT_TIMEOUT_MS);
      return performSiteScreenshot(client, inv, args[0] as string, {
        paths: Array.isArray(opts.path) ? (opts.path as string[]) : undefined,
        viewport: opts.viewport as string,
        format: opts.format as string,
        scale: typeof opts.scale === 'number' ? opts.scale : undefined,
        output: opts.output as string | undefined,
      });
    }),
  );

  addGlobalFlags(
    site
      .command('publish <site>')
      .description('publish (or republish) to the public *.moda.page URL')
      .option('--slug <prefix>', 'subdomain hint, first publish only (final slug gets a random suffix)'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, SITE_TIMEOUT_MS);
      const id = parseSiteId(args[0] as string);
      const slugPrefix = opts.slug as string | undefined;
      if (slugPrefix !== undefined) {
        // Free pre-check: the hint only applies to a first publish — warn instead of silently
        // sending a hint the server will ignore on a site that already owns a slug.
        const current = await client.request({ method: 'GET', path: endpoints.websiteShow(id) });
        const existingSlug = str(asObject(asObject(current.body).website), 'slug');
        if (existingSlug !== undefined && existingSlug.length > 0) {
          inv.note(`--slug is a first-publish hint — this site already has slug '${existingSlug}'; the hint is ignored.`);
        }
      }
      return performSitePublish(client, id, slugPrefix);
    }),
  );

  addGlobalFlags(
    site
      .command('unpublish <site>')
      .description('take the live site down (requires --yes under --json/--no-input)')
      .option('--yes', 'confirm taking the live site down'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      requireYes('Unpublishing a live site', inv.flags.noInput, opts.yes === true, `moda site unpublish ${args[0] as string}`);
      const { client } = await authedClient(inv, SITE_TIMEOUT_MS);
      return performSiteUnpublish(client, args[0] as string);
    }),
  );

  addGlobalFlags(
    site
      .command('delete <site>')
      .description('delete the site — destructive; the slug enters cooldown (requires --yes under --json/--no-input)')
      .option('--yes', 'confirm deletion'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      requireYes('Deleting a site', inv.flags.noInput, opts.yes === true, `moda site delete ${args[0] as string}`);
      const { client } = await authedClient(inv, SITE_TIMEOUT_MS);
      return performSiteDelete(client, args[0] as string);
    }),
  );
}

function parseCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value.trim()) || parsed < 1 || parsed > 100) {
    throw CliError.usage(`Invalid --limit value '${value}' — expected an integer between 1 and 100.`);
  }
  return parsed;
}

function parseVersion(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value.trim()) || parsed < 1) {
    throw CliError.usage(`Invalid --expected-version value '${value}' — expected a positive integer.`);
  }
  return parsed;
}

function parseOffset(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value.trim()) || parsed < 0) {
    throw CliError.usage(`Invalid --offset value '${value}' — expected a non-negative integer.`);
  }
  return parsed;
}

interface WireResponse {
  requestId?: string;
  durationMs: number;
}

function outcome(
  operation: string,
  root: Record<string, unknown>,
  response: WireResponse,
  human: (write: (line: string) => void) => void,
): CommandOutcome {
  return {
    body: {
      ok: true,
      // Spread first: the server envelope carries its own `operation` (e.g. websites.publish);
      // the CLI's verb-lane name wins in CLI output. (media.ts differs — it spreads root last,
      // and its server operations already match the CLI names — deliberately left as is.)
      ...root,
      operation,
      meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
    },
    human,
    exitCode: EXIT_OK,
  };
}

/** CLI-owned honesty field: is the page actually being served right now? (pending_review = no). */
function isServing(website: Record<string, unknown>): boolean {
  return website.is_published === true && str(website, 'review_status') !== 'pending_review';
}

function siteLine(website: Record<string, unknown>): string {
  const id = str(website, 'id') ?? '?';
  const name = str(website, 'name') ?? '(unnamed)';
  const url = str(website, 'url');
  const published = website.is_published === true;
  const stale = website.has_unpublished_changes === true;
  const pendingReview = str(website, 'review_status') === 'pending_review';
  let state: string;
  if (!published) {
    state = 'not published';
  } else if (pendingReview) {
    state = `published (held for review) — ${url ?? '?'} goes live once approved`;
  } else {
    state = `live at ${url ?? '?'}`;
  }
  if (published && stale) state += ' (unpublished changes — republish to update)';
  return `${id}  ${name} — ${state}`;
}

export interface SiteContentInput {
  html: string;
  title?: string;
  /** set-content only: PUT /content's optional expected_version read-modify-write guard. */
  expectedVersion?: number;
}

/** Re-throw a typed error with an actionable hint for known site-lane codes (contract-settled). */
function withSiteHint(err: unknown, hints: Record<string, string>): never {
  if (err instanceof CliError && err.fields.hint === undefined) {
    const hint = hints[err.fields.code];
    if (hint !== undefined) throw new CliError({ ...err.fields, hint });
  }
  throw err;
}

export async function performSiteCreate(client: ApiClient, input: SiteContentInput): Promise<CommandOutcome> {
  if (input.html.trim().length === 0) throw CliError.usage('The HTML page is empty.');
  const payload = { html: input.html, ...(input.title !== undefined ? { title: input.title } : {}) };
  const response = await client.request({
    method: 'POST',
    path: endpoints.websiteCreate(),
    body: payload,
    // Standard pipeline: the client injects the derived in-body idempotency_key (contract-supported).
    idempotency: { command: 'site create', canvas: '', expectedRevision: undefined, payload: JSON.stringify(payload) },
  });
  const root = asObject(response.body);
  const website = asObject(root.website);
  return outcome('site.create', root, response, (write) => {
    const id = str(website, 'id') ?? '?';
    write(`site.create: ${id} — "${str(website, 'name') ?? ''}" (not published yet)`);
    if (root.replayed === true) write('(replayed — this site already existed)');
    write(`publish it: moda site publish ${id}`);
  });
}

export async function performSiteList(client: ApiClient, flags: ListFlags): Promise<CommandOutcome> {
  const pages = await fetchListPages(client, endpoints.websiteList(), {}, flags, SITE_TIMEOUT_MS);
  // Same CLI-owned `serving` honesty the publish path carries — annotated per site (the server
  // reports is_published: true + url even while a publish is held for review).
  pages.items = pages.items.map((website) => ({ ...website, serving: isServing(website) }));
  if (pages.itemKey !== undefined) pages.root[pages.itemKey] = pages.items;
  return listOutcome({
    operation: 'site.list',
    pages,
    flags,
    emptyHint: 'no sites — create one: moda site create',
    itemLine: siteLine,
  });
}

export async function performSiteShow(client: ApiClient, siteRef: string): Promise<CommandOutcome> {
  const id = parseSiteId(siteRef);
  const response = await client.request({ method: 'GET', path: endpoints.websiteShow(id) });
  const root = asObject(response.body);
  const website = asObject(root.website);
  return outcome('site.show', { ...root, serving: isServing(website) }, response, (write) => {
    write(siteLine(website));
    const review = str(website, 'review_status');
    // pending_review is already part of siteLine; name any other non-approved status explicitly.
    if (review !== undefined && review !== 'approved' && review !== 'pending_review') {
      write(`review_status: ${review}`);
    }
  });
}

export async function performSiteSetContent(
  client: ApiClient,
  siteRef: string,
  input: SiteContentInput,
): Promise<CommandOutcome> {
  const id = parseSiteId(siteRef);
  if (input.html.trim().length === 0) throw CliError.usage('The HTML page is empty.');
  const payload = {
    html: input.html,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.expectedVersion !== undefined ? { expected_version: input.expectedVersion } : {}),
  };
  const response = await client
    .request({ method: 'PUT', path: endpoints.websiteContent(id), body: payload })
    .catch((err: unknown) =>
      withSiteHint(err, {
        website_version_conflict:
          `The site changed since your read — re-read (moda site show ${id}), re-apply, then republish.`,
      }),
    );
  const root = asObject(response.body);
  const website = asObject(root.website);
  return outcome('site.set-content', root, response, (write) => {
    write(`site.set-content: saved (version ${website.version ?? '?'})`);
    if (website.is_published === true) {
      write(`the live site still serves the last publish — republish: moda site publish ${id}`);
    }
  });
}

export async function performSitePublish(
  client: ApiClient,
  siteId: string,
  slugPrefix: string | undefined,
): Promise<CommandOutcome> {
  const id = parseSiteId(siteId);
  const payload = slugPrefix !== undefined ? { slug_prefix: slugPrefix } : {};
  const response = await client
    .request({ method: 'POST', path: endpoints.websitePublish(id), body: payload })
    .catch((err: unknown) =>
      withSiteHint(err, {
        // Contract-settled: fires only when two concurrent FIRST publishes race; republish is
        // safe by construction (same row, same slug, artifact rebuilt).
        website_already_published:
          `Another publish just won the first-publish race — re-run: moda site publish ${id} (it will succeed).`,
        slug_invalid:
          `Pick a different --slug (3-63 chars, lowercase letters/digits/single hyphens, no reserved or brand words) and re-run: moda site publish ${id} --slug <prefix>.`,
        slug_taken:
          `That slug is already in use — pick a different --slug and re-run: moda site publish ${id} --slug <prefix>.`,
        slug_cooldown:
          `That slug was recently unpublished and is cooling down — pick a different --slug and re-run: moda site publish ${id} --slug <prefix>.`,
        free_publishing_disabled:
          'Publishing is temporarily disabled platform-wide — not an auth or account problem; retry later.',
      }),
    );
  const root = asObject(response.body);
  const pendingReview = str(root, 'review_status') === 'pending_review';
  // (isServing() is for <Website> shapes; the publish response carries is_live + review_status.)
  const base = outcome('site.publish', root, response, (write) => {
    const url = str(root, 'url') ?? '?';
    if (pendingReview) {
      write(`site.publish: published, but held for review before serving — ${url} goes live once approved`);
    } else {
      write(`site.publish: live at ${url}`);
    }
    const warnings = Array.isArray(root.warnings) ? root.warnings.filter((w): w is string => typeof w === 'string') : [];
    for (const warning of warnings) write(`warning: ${warning}`);
  });
  // The server reports is_live: true even when the publish is held for review. Rather than
  // mutating the server body, add a CLI-owned `serving` field: true only when the page is
  // actually being served right now.
  base.body = { ...base.body, serving: root.is_live === true && !pendingReview };
  return base;
}

const SCREENSHOT_TIMEOUT_MS = 180_000;

export interface SitePageContentInput {
  path: string;
  html: string;
  expectedVersion?: number;
}

export async function performSitePageSetContent(
  client: ApiClient,
  siteRef: string,
  input: SitePageContentInput,
): Promise<CommandOutcome> {
  const id = parseSiteId(siteRef);
  if (input.html.trim().length === 0) throw CliError.usage('The HTML page is empty.');
  const payload = {
    path: input.path,
    html: input.html,
    ...(input.expectedVersion !== undefined ? { expected_version: input.expectedVersion } : {}),
  };
  const response = await client
    .request({ method: 'PUT', path: endpoints.websitePageContent(id), body: payload })
    .catch((err: unknown) =>
      withSiteHint(err, {
        website_version_conflict: `The site changed since your read — re-read (moda site pages ${id}), re-apply, then republish.`,
      }),
    );
  const root = asObject(response.body);
  const website = asObject(root.website);
  return outcome('site.set-content', root, response, (write) => {
    write(`site.set-content: ${input.path} saved (version ${website.version ?? root.version ?? '?'})`);
    if (website.is_published === true) {
      write(`the live site still serves the last publish — republish: moda site publish ${id}`);
    }
  });
}

export async function performSitePages(client: ApiClient, siteRef: string): Promise<CommandOutcome> {
  const id = parseSiteId(siteRef);
  const response = await client.request({ method: 'GET', path: endpoints.websitePages(id) });
  const root = asObject(response.body);
  const pages = Array.isArray(root.pages) ? root.pages.map(asObject) : [];
  return outcome('site.pages', root, response, (write) => {
    for (const page of pages) write(`${str(page, 'path') ?? '?'}  ${str(page, 'name') ?? ''}`);
    write(`${pages.length} page${pages.length === 1 ? '' : 's'}; version: ${root.version ?? '?'}`);
  });
}

export interface SiteAddPageInput {
  path: string;
  html: string;
  name?: string;
  expectedVersion?: number;
}

export async function performSiteAddPage(client: ApiClient, siteRef: string, input: SiteAddPageInput): Promise<CommandOutcome> {
  validateRoutePath(input.path);
  const id = parseSiteId(siteRef);
  if (input.html.trim().length === 0) throw CliError.usage('The HTML page is empty.');
  const payload = {
    path: input.path,
    html: input.html,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.expectedVersion !== undefined ? { expected_version: input.expectedVersion } : {}),
  };
  const response = await client
    .request({
      method: 'POST',
      path: endpoints.websitePages(id),
      body: payload,
      idempotency: { command: 'site add-page', canvas: id, expectedRevision: undefined, payload: JSON.stringify(payload) },
    })
    .catch((err: unknown) =>
      withSiteHint(err, {
        website_page_exists: `A page already exists at ${input.path} — update it instead: moda site set-content ${id} --path ${input.path} --file …`,
      }),
    );
  const root = asObject(response.body);
  return outcome('site.add-page', root, response, (write) => {
    write(`site.add-page: ${input.path} added${root.replayed === true ? ' (replayed)' : ''}`);
    write(`the live site still serves the last publish — republish: moda site publish ${id}`);
  });
}

export interface SiteDeletePageInput {
  path: string;
  expectedVersion?: number;
}

export async function performSiteDeletePage(
  client: ApiClient,
  siteRef: string,
  input: SiteDeletePageInput,
): Promise<CommandOutcome> {
  const id = parseSiteId(siteRef);
  const response = await client
    .request({
      method: 'DELETE',
      path: endpoints.websitePages(id),
      query: {
        path: input.path,
        ...(input.expectedVersion !== undefined ? { expected_version: String(input.expectedVersion) } : {}),
      },
    })
    .catch((err: unknown) =>
      withSiteHint(err, {
        website_home_page_protected: 'The homepage (/) cannot be deleted — replace its content instead: moda site set-content … --path /',
      }),
    );
  const root = asObject(response.body);
  return outcome('site.delete-page', root, response, (write) => write(`site.delete-page: ${input.path} deleted`));
}

export interface SiteScreenshotInput {
  paths?: string[];
  viewport: string;
  format: string;
  scale?: number;
  output?: string;
}

export async function performSiteScreenshot(
  client: ApiClient,
  inv: Invocation,
  siteRef: string,
  input: SiteScreenshotInput,
): Promise<CommandOutcome> {
  const id = parseSiteId(siteRef);
  if (!['desktop', 'tablet', 'mobile'].includes(input.viewport)) {
    throw CliError.usage(`Invalid --viewport '${input.viewport}' — expected desktop, tablet, or mobile.`);
  }
  if (!['jpg', 'png'].includes(input.format)) {
    throw CliError.usage(`Invalid --format '${input.format}' — expected jpg or png.`);
  }
  if (input.paths !== undefined && input.paths.length > 3) {
    throw CliError.usage(`--path takes at most 3 routes per call (got ${input.paths.length}).`);
  }
  if (input.scale !== undefined && (!Number.isInteger(input.scale) || input.scale < 1 || input.scale > 2)) {
    throw CliError.usage(`Invalid --scale '${input.scale}' — expected 1 or 2.`);
  }
  const payload = {
    ...(input.paths !== undefined ? { paths: input.paths } : {}),
    viewport: input.viewport,
    format: input.format,
    ...(input.scale !== undefined ? { scale: input.scale } : {}),
  };
  const response = await client.request({
    method: 'POST',
    path: endpoints.websiteScreenshot(id),
    body: payload,
    timeoutMs: SCREENSHOT_TIMEOUT_MS,
  });
  const root = asObject(response.body);
  const images = Array.isArray(root.images) ? root.images.map(asObject) : [];
  // File-pointer discipline: signed URLs are short-lived — download to files, return paths.
  // Per-entry annotation (never a success-compacted side list): a failed download marks ITS
  // image with download_failed, and every other image keeps the right file.
  const annotated: JsonObject[] = [];
  for (const image of images) {
    const url = str(image, 'url');
    const route = (str(image, 'path') ?? 'page').replaceAll('/', '_').replace(/^_$/, 'home') || 'home';
    const target = resolveShotPath(input.output, images.length, route, input.format, inv);
    let entry: JsonObject = { ...image, url: undefined };
    if (url === undefined) {
      entry = { ...entry, download_failed: true };
    } else {
      const bare = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!bare.ok) {
        inv.note(`capture download failed for ${str(image, 'path') ?? route} (HTTP ${bare.status})`);
        entry = { ...entry, download_failed: true };
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, new Uint8Array(await bare.arrayBuffer()));
        entry = { ...entry, file: target };
      }
    }
    annotated.push(entry);
  }
  return outcome('site.screenshot', { ...root, images: annotated }, response, (write) => {
    for (const image of annotated) {
      const dims = typeof image.width === 'number' ? ` (${image.width}x${image.height})` : '';
      write(
        `${str(image, 'path') ?? '?'} [${str(image, 'viewport') ?? ''}] → ` +
          `${str(image, 'file') ?? '(download failed — re-run to re-capture)'}${dims}` +
          `${image.js_disabled === true ? ' — rendered with JS off (degraded)' : ''}` +
          `${image.truncated === true ? ' — capture truncated (page over the pixel budget)' : ''}`,
      );
    }
  });
}

function resolveShotPath(
  output: string | undefined,
  count: number,
  route: string,
  format: string,
  inv: Invocation,
): string {
  if (output === undefined) {
    const dir = (inv.context as { outputDir?: { value?: string } }).outputDir?.value ?? '.';
    return `${dir.replace(/\/$/, '')}/site-${route}.${format}`;
  }
  if (count === 1 && /\.[a-z]+$/i.test(output)) return output;
  return `${output.replace(/\/$/, '')}/${route}.${format}`;
}

export async function performSiteUnpublish(client: ApiClient, siteRef: string): Promise<CommandOutcome> {
  const id = parseSiteId(siteRef);
  const response = await client.request({ method: 'POST', path: endpoints.websiteUnpublish(id), body: {} });
  const root = asObject(response.body);
  return outcome('site.unpublish', root, response, (write) => {
    write(`site.unpublish: ${str(root, 'slug') ?? id} is no longer live`);
  });
}

export async function performSiteDelete(client: ApiClient, siteRef: string): Promise<CommandOutcome> {
  const id = parseSiteId(siteRef);
  const response = await client.request({ method: 'DELETE', path: endpoints.websiteShow(id) });
  const root = asObject(response.body);
  return outcome('site.delete', root, response, (write) => write(`site.delete: ${id} deleted`));
}
