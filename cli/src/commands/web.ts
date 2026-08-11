/**
 * `moda web` — metered web research: structured search and clean page-to-markdown reads.
 * Provider-neutral by contract: commands, flags, help, errors, and output never name an
 * underlying search or extraction provider — this is Moda's research surface, full stop.
 *
 * Server contracts (binding; the backend implements exactly this):
 *   POST /v1/web/search {query, num_results (<=10, default 5), include_text (default false)}
 *     → {results: [{url, title, snippet, text?, published_at?}], usage}
 *   POST /v1/web/read {url}
 *     → {url, title, content_markdown, links?, usage}
 * Both responses carry the same metered usage receipt shape as the media verbs.
 */
import type { Command } from 'commander';
import type { ApiClient } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { asObject, str } from '../api/types.ts';
import { CliError } from '../cliError.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import type { CommandOutcome } from '../output/emit.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction } from './runtime.ts';

const WEB_TIMEOUT_MS = 120_000;

/** Server-side bounds on `num_results` (cli contract: <=10, default 5). */
export const MAX_SEARCH_RESULTS = 10;

/** Commander parser for `--results`: an integer in [1, 10]. */
export function parseResultsCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value.trim()) || !Number.isFinite(parsed) || parsed < 1 || parsed > MAX_SEARCH_RESULTS) {
    throw CliError.usage(`Invalid --results value '${value}' — expected an integer between 1 and ${MAX_SEARCH_RESULTS}.`);
  }
  return parsed;
}

export function registerWeb(program: Command): void {
  const web = program
    .command('web')
    .description('metered web research — search and page reads spend Moda credits, receipts on every response');

  addGlobalFlags(
    web
      .command('search <query>')
      .description('web search (metered) — structured results: url, title, snippet')
      .option('--results <n>', `number of results, 1-${MAX_SEARCH_RESULTS} (default 5)`, parseResultsCount)
      .option('--full-text', 'include extracted page text on each result (metered at the higher read class)'),
  ).action(
    wrapAction(async (args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, WEB_TIMEOUT_MS);
      const outcome = await performWebSearch(client, {
        query: args[0] as string,
        results: opts.results as number | undefined,
        fullText: opts.fullText === true,
      });
      return outcome;
    }),
  );

  addGlobalFlags(
    web
      .command('read <url>')
      .description('read a web page as clean markdown (metered)'),
  ).action(
    wrapAction(async (args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, WEB_TIMEOUT_MS);
      const outcome = await performWebRead(client, args[0] as string);
      return outcome;
    }),
  );
}

export interface WebSearchOptions {
  query: string;
  /** 1..MAX_SEARCH_RESULTS; omitted → the server default (5). */
  results?: number;
  fullText?: boolean;
}

export async function performWebSearch(client: ApiClient, opts: WebSearchOptions): Promise<CommandOutcome> {
  const query = opts.query.trim();
  if (query.length === 0) throw CliError.usage('Search query is empty.');
  const payload = {
    query,
    ...(opts.results !== undefined ? { num_results: opts.results } : {}),
    ...(opts.fullText === true ? { include_text: true } : {}),
  };
  // No idempotency parts: web verbs are reads over POST, and the binding body contract is
  // exactly {query, num_results, include_text} (the client would inject idempotency_key).
  const response = await client.request({ method: 'POST', path: endpoints.webSearch(), body: payload });
  const root = asObject(response.body);
  const results = Array.isArray(root.results) ? root.results.map(asObject) : [];
  return {
    body: {
      ok: true,
      operation: 'web.search',
      metered: true,
      ...root,
      meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
    },
    human: (write) => {
      write(`web.search: ${results.length} result${results.length === 1 ? '' : 's'} for "${query}" (metered)`);
      results.forEach((result, index) => {
        const title = str(result, 'title') ?? '(untitled)';
        const url = str(result, 'url') ?? '';
        const published = str(result, 'published_at');
        write(`${index + 1}. ${title} — ${url}${published !== undefined ? ` (${published})` : ''}`);
        const snippet = str(result, 'snippet');
        if (snippet !== undefined && snippet.length > 0) write(`   ${snippet.replace(/\s+/g, ' ').trim()}`);
        if (str(result, 'text') !== undefined) write('   [full text captured — read it with --json]');
      });
    },
    exitCode: EXIT_OK,
  };
}

export async function performWebRead(client: ApiClient, url: string): Promise<CommandOutcome> {
  const target = url.trim();
  if (!target.startsWith('http://') && !target.startsWith('https://')) {
    throw CliError.usage(`'${url}' is not an http(s) URL.`);
  }
  const payload = { url: target };
  const response = await client.request({ method: 'POST', path: endpoints.webRead(), body: payload });
  const root = asObject(response.body);
  return {
    body: {
      ok: true,
      operation: 'web.read',
      metered: true,
      ...root,
      meta: { ...asObject(root.meta), ...metaBlock({ requestId: response.requestId, durationMs: response.durationMs }) },
    },
    human: (write) => {
      const title = str(root, 'title');
      write(`web.read: ${title !== undefined ? `"${title}" — ` : ''}${str(root, 'url') ?? target} (metered)`);
      const markdown = str(root, 'content_markdown');
      if (markdown !== undefined) write(markdown);
    },
    exitCode: EXIT_OK,
  };
}
