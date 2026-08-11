/** `moda auth login|status|logout` — browser key-mint flow per prototype-plan (rulings 2, 10). */
import type { Command } from 'commander';
import { ApiClient } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { parseWhoami } from '../api/types.ts';
import { deleteCredential, requireCredential, storeCredential } from '../auth/credentials.ts';
import {
  generateState,
  mintUrl,
  openBrowser,
  readKeyFromStdin,
  resolveAppBase,
  startLoginListener,
} from '../auth/login.ts';
import { CliError } from '../cliError.ts';
import { readConfig, writeConfig } from '../config/config.ts';
import { removeAccountIndex, upsertAccountIndex } from '../config/state.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction, type Invocation } from './runtime.ts';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export function registerAuth(program: Command): void {
  const auth = program.command('auth').description('authentication');

  addGlobalFlags(
    auth
      .command('login')
      .description('log in via the browser key-mint flow; credentials go to the OS keychain')
      .option('--scopes <scopes>', 'comma-separated scope list to request')
      .option('--paste', 'headless: print the mint URL and read the key from a hidden prompt'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const scopes = typeof opts.scopes === 'string' ? opts.scopes.split(',').map((s) => s.trim()) : undefined;
      const key = opts.paste === true ? await pasteFlow(inv, scopes) : await browserFlow(inv, scopes);

      // Immediately validate before storing (login.ts step 5). Failure ⇒ typed error, nothing stored.
      const client = new ApiClient({ apiBase: inv.context.apiBase.value, apiKey: key, env: inv.env, onNotice: inv.note });
      const response = await client.request({ method: 'GET', path: endpoints.whoami(), timeoutMs: 30_000 });
      const who = parseWhoami(response.body);
      if (who.orgId === undefined) {
        throw new CliError({
          type: 'authentication',
          code: 'whoami_incomplete',
          message: 'The minted key validated but whoami returned no organization; nothing was stored.',
          source: 'api',
        });
      }

      const backendName = await storeCredential(
        inv.context.apiBase.value,
        {
          key,
          org: who.orgId,
          scopes: who.scopes,
          created_at: new Date().toISOString(),
          api_base: inv.context.apiBase.value,
        },
        inv.env,
      );
      upsertAccountIndex({ host: new URL(inv.context.apiBase.value).host, org: who.orgId }, inv.env);

      const config = readConfig(inv.env);
      if (config.context?.org === undefined) {
        config.context = { ...config.context, org: who.orgId };
        writeConfig(config, inv.env);
      }

      const storage = backendName === 'file' ? 'credentials file (0600)' : backendName;
      return {
        body: {
          ok: true,
          authenticated: true,
          identity: { email: who.email, org: who.orgId, org_name: who.orgName, plan: who.plan },
          scopes: who.scopes,
          credential_storage: backendName,
          meta: metaBlock({ requestId: response.requestId, durationMs: response.durationMs }),
        },
        human: (write) => {
          write(`Logged in as ${who.email ?? who.userId ?? 'unknown'} (${who.orgName ?? who.orgId}, plan: ${who.plan ?? '?'})`);
          write(`Credential stored in ${storage} (service: moda-cli).`);
        },
        exitCode: EXIT_OK,
      };
    }),
  );

  addGlobalFlags(auth.command('status').description('identity, org, plan, scopes — never the credential')).action(
    wrapAction(async (_args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client, credential } = await authedClient(inv, 30_000);
      const response = await client.request({ method: 'GET', path: endpoints.whoami() });
      const who = parseWhoami(response.body);
      return {
        body: {
          ok: true,
          authenticated: true,
          identity: { email: who.email, org: who.orgId, org_name: who.orgName, plan: who.plan },
          scopes: who.scopes,
          credential_source: credential.source,
          meta: metaBlock({ requestId: response.requestId, durationMs: response.durationMs }),
        },
        human: (write) => {
          write(`${who.email ?? who.userId ?? 'unknown'} — ${who.orgName ?? who.orgId ?? '?'} (plan: ${who.plan ?? '?'})`);
          write(`scopes: ${who.scopes.join(', ') || '(none reported)'}`);
          write(`credential source: ${credential.source}`);
        },
        exitCode: EXIT_OK,
      };
    }),
  );

  addGlobalFlags(auth.command('logout').description('delete the local credential (server revocation stays in the app)')).action(
    wrapAction(async (_args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const credential = await requireCredential({
        apiBase: inv.context.apiBase.value,
        org: inv.context.org.value,
        env: inv.env,
      });
      if (credential.source === 'env') {
        throw CliError.usage(
          'Credential comes from MODA_API_KEY — nothing stored locally to delete.',
          'Unset the environment variable instead.',
        );
      }
      const org = credential.org ?? inv.context.org.value;
      if (org === undefined) throw CliError.auth('No stored credential found for this org.');
      const deleted = await deleteCredential(inv.context.apiBase.value, org, inv.env);
      removeAccountIndex({ host: new URL(inv.context.apiBase.value).host, org }, inv.env);
      return {
        body: { ok: true, deleted, org, meta: metaBlock() },
        human: (write) => write(deleted ? `Logged out of ${org} (local credential deleted).` : 'No credential found.'),
        exitCode: EXIT_OK,
      };
    }),
  );
}

async function browserFlow(inv: Invocation, scopes: string[] | undefined): Promise<string> {
  const state = generateState();
  const timeoutMs = inv.flags.timeout !== undefined ? inv.flags.timeout * 1000 : LOGIN_TIMEOUT_MS;
  const listener = startLoginListener(state, timeoutMs);
  try {
    const appBase = resolveAppBase(inv.context.apiBase.value, inv.env);
    const url = mintUrl(appBase, state, listener.port, scopes);
    inv.note(`Opening ${url}`);
    inv.note('Waiting for the browser login… (Ctrl-C to cancel)');
    const opened = await openBrowser(url, inv.env);
    if (!opened) inv.note('Could not open a browser — visit the URL above manually.');
    const { key } = await listener.result;
    return key;
  } finally {
    listener.close();
  }
}

async function pasteFlow(inv: Invocation, scopes: string[] | undefined): Promise<string> {
  if (inv.flags.noInput) {
    throw CliError.usage(
      '`auth login --paste` needs an interactive prompt, which --json/--no-input forbids.',
      'Use MODA_API_KEY for headless environments.',
    );
  }
  const appBase = resolveAppBase(inv.context.apiBase.value, inv.env);
  const url = mintUrl(appBase, generateState(), undefined, scopes);
  inv.note(`Visit: ${url}`);
  inv.note('The page shows the key once — copy it.');
  const key = await readKeyFromStdin('Paste key (input hidden): ');
  if (key.length === 0) throw CliError.usage('Empty key.');
  return key;
}
