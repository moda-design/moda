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
import type { Command } from 'commander';
import type { ApiClient } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { asObject, str } from '../api/types.ts';
import { CliError } from '../cliError.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import type { CommandOutcome } from '../output/emit.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction } from './runtime.ts';
import { readFileArg } from './canvasShared.ts';

const SITE_TIMEOUT_MS = 120_000;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Site ids are plain UUIDs on the wire — no prefixed form, no URL sugar. */
export function parseSiteId(input: string): string {
  const trimmed = input.trim();
  if (!UUID_RE.test(trimmed)) {
    throw CliError.usage(`'${input}' is not a site id (a UUID).`, 'Find site ids with: moda site list');
  }
  return trimmed;
}

/** Destructive-verb approval gate, mirroring `moda canvas delete` (cli.md §9). */
export function requireYes(action: string, noInput: boolean, yes: boolean): void {
  if (noInput && !yes) {
    throw CliError.usage(
      `${action} requires --yes under --json/--no-input.`,
      'Destructive verbs need the host approval step (cli.md §9).',
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
      .option('--offset <n>', 'pagination offset', parseOffset),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, SITE_TIMEOUT_MS);
      return performSiteList(client, {
        limit: opts.limit as number | undefined,
        offset: opts.offset as number | undefined,
      });
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
      .description('replace the page HTML (the live site keeps serving the last publish until you republish)')
      .requiredOption('--file <path>', "the new page HTML file, or '-' for stdin")
      .option('--title <title>', 'update the site title'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, SITE_TIMEOUT_MS);
      const html = await readFileArg(opts.file as string);
      return performSiteSetContent(client, args[0] as string, { html, title: opts.title as string | undefined });
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
      requireYes('Unpublishing a live site', inv.flags.noInput, opts.yes === true);
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
      requireYes('Deleting a site', inv.flags.noInput, opts.yes === true);
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

export interface SiteListOptions {
  limit?: number;
  offset?: number;
}

export async function performSiteList(client: ApiClient, opts: SiteListOptions): Promise<CommandOutcome> {
  const response = await client.request({
    method: 'GET',
    path: endpoints.websiteList(),
    query: {
      ...(opts.limit !== undefined ? { limit: String(opts.limit) } : {}),
      ...(opts.offset !== undefined ? { offset: String(opts.offset) } : {}),
    },
  });
  const root = asObject(response.body);
  const websites = Array.isArray(root.websites) ? root.websites.map(asObject) : [];
  return outcome('site.list', root, response, (write) => {
    const total = typeof root.total === 'number' ? root.total : websites.length;
    write(`site.list: ${websites.length} of ${total} site${total === 1 ? '' : 's'}`);
    for (const website of websites) write(siteLine(website));
  });
}

export async function performSiteShow(client: ApiClient, siteRef: string): Promise<CommandOutcome> {
  const id = parseSiteId(siteRef);
  const response = await client.request({ method: 'GET', path: endpoints.websiteShow(id) });
  const root = asObject(response.body);
  const website = asObject(root.website);
  return outcome('site.show', root, response, (write) => {
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
  const payload = { html: input.html, ...(input.title !== undefined ? { title: input.title } : {}) };
  const response = await client.request({ method: 'PUT', path: endpoints.websiteContent(id), body: payload });
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
  const response = await client.request({ method: 'POST', path: endpoints.websitePublish(id), body: payload });
  const root = asObject(response.body);
  const pendingReview = str(root, 'review_status') === 'pending_review';
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
