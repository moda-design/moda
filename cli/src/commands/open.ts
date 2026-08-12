/**
 * The shared open lane behind every `<noun> open <ref>` verb: resolve ref → read the resource →
 * find the server-provided app URL → launch the browser (or print the URL). One implementation;
 * the per-noun verbs are thin wrappers that supply the read and the field/route names.
 *
 * Contract:
 * - The SERVER-provided URL wins whenever the read returns one. Routing should be the server's
 *   to own — it currently hardcodes /canvas/<uuid> (flow canvases, which the app serves under
 *   /flow/, are a known server-side gap) — so the CLI never second-guesses a URL it is handed.
 * - Client-side construction is the documented fallback for a server that predates the URL
 *   field: appBase + the real app route — /canvas/<uuid>, /brand-kit/<uuid>, /website/<uuid>,
 *   /files/folder/<uuid> — always with the BARE UUID, never the wire form, and never the
 *   unrouted /c/<id> shape the API examples once used (nothing serves it).
 * - A browser that cannot launch NEVER fails the verb: exit 0, the URL on stdout, a stderr note.
 */
import { resolveAppBase } from '../auth/login.ts';
import { str } from '../api/types.ts';
import { openBrowser } from '../browser.ts';
import { CliError } from '../cliError.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import type { CommandOutcome } from '../output/emit.ts';
import { metaBlock, type Invocation } from './runtime.ts';

export interface OpenLaneContext {
  appBase: string;
  env: NodeJS.ProcessEnv;
  note: (message: string) => void;
  /** Injectable browser launcher for tests; defaults to the real one. */
  launch?: (url: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
}

export function openLaneContext(inv: Invocation): OpenLaneContext {
  return { appBase: resolveAppBase(inv.context.apiBase.value, inv.env), env: inv.env, note: inv.note };
}

/** Where the opened URL came from — carried on the --json document as `url_source`. */
export type UrlSource = 'server' | 'constructed' | 'share_link';

/** Launch (or print) a fully-resolved URL — the tail every open verb funnels through. */
export async function openUrlOutcome(
  ctx: OpenLaneContext,
  input: { operation: string; url: string; urlSource: UrlSource; meta: { requestId?: string; durationMs?: number } },
): Promise<CommandOutcome> {
  const launch = ctx.launch ?? openBrowser;
  // `launched` = the launcher spawned; it is NOT proof a window appeared (headless xdg-open
  // spawns fine), which is why the URL is the human output either way.
  const launched = await launch(input.url, ctx.env);
  if (!launched) ctx.note(`no browser could be launched — open it manually: ${input.url}`);
  return {
    body: {
      ok: true,
      operation: input.operation,
      url: input.url,
      url_source: input.urlSource,
      launched,
      meta: metaBlock(input.meta),
    },
    human: (write) => write(input.url),
    exitCode: EXIT_OK,
  };
}

export interface ResourceOpenInput {
  operation: string;
  /**
   * Objects to search for the URL. FIELD priority dominates (outer loop): the first name in
   * `urlFields` found on ANY source wins; source order only breaks ties within one field name.
   */
  sources: Array<Record<string, unknown>>;
  /** URL field names in priority order. Only http(s) string values count. */
  urlFields: string[];
  /** Bare resource UUID for the constructed fallback (server predates the URL field). */
  fallbackUuid: string | undefined;
  /** The real app route for the fallback, e.g. (uuid) => `/canvas/${uuid}`. */
  fallbackPath: (uuid: string) => string;
  meta: { requestId?: string; durationMs?: number };
}

export async function resourceOpenOutcome(ctx: OpenLaneContext, input: ResourceOpenInput): Promise<CommandOutcome> {
  let url: string | undefined;
  let urlSource: UrlSource = 'server';
  for (const field of input.urlFields) {
    for (const source of input.sources) {
      const candidate = str(source, field);
      if (candidate !== undefined && /^https?:\/\//.test(candidate)) {
        url = candidate;
        break;
      }
    }
    if (url !== undefined) break;
  }
  if (url === undefined) {
    if (input.fallbackUuid === undefined) {
      // Unreachable in practice (the read succeeded, so a UUID was derivable) — typed, not thrown away.
      throw new CliError({
        type: 'internal_error',
        code: 'open_url_unavailable',
        message: 'The server returned no app URL and the reference has no derivable UUID.',
        hint: 'Open the resource from the Moda app directly.',
        source: 'local',
      });
    }
    url = new URL(input.fallbackPath(input.fallbackUuid), ctx.appBase).toString();
    urlSource = 'constructed';
  }
  return openUrlOutcome(ctx, { operation: input.operation, url, urlSource, meta: input.meta });
}
