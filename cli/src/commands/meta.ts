/** `moda version`, `moda doctor`, `moda __inventory` (hidden), and — from slice 4 — `moda update`. */
import type { Command } from 'commander';
import { endpoints } from '../api/endpoints.ts';
import { parseWhoami } from '../api/types.ts';
import { resolveCredential, type ResolvedCredential } from '../auth/credentials.ts';
import { selectKeychainBackend } from '../auth/keychain.ts';
import { CliError } from '../cliError.ts';
import { readUpdateStamp } from '../config/state.ts';
import { EXIT_AUTH, EXIT_OK, EXIT_TRANSPORT } from '../output/exitCodes.ts';
import { compareVersions, pinnedInstallCommand, RELEASES_REPO, updateAvailable } from '../update.ts';
import { API_VERSION_PIN } from '../api/endpoints.ts';
import { CLI_CHANNEL, CLI_VERSION, platformArch } from '../version.ts';
import { addGlobalFlags, anonymousClient, authedClient, buildInvocation, metaBlock, wrapAction } from './runtime.ts';

export function registerMeta(program: Command): void {
  addGlobalFlags(program.command('version').description('CLI version, pinned API version, endpoint, install channel'))
    .action(
      wrapAction(async (_args, _opts, cmd) => {
        const inv = buildInvocation(cmd);
        const available = updateAvailable(inv.env);
        return {
          body: {
            ok: true,
            version: CLI_VERSION,
            channel: CLI_CHANNEL,
            platform: platformArch(),
            api_version: API_VERSION_PIN,
            api_base: inv.context.apiBase.value,
            update_available: available !== undefined ? available.latest : false,
            meta: metaBlock(),
          },
          human: (write) => {
            write(`moda ${CLI_VERSION} (${CLI_CHANNEL}; ${platformArch()})`);
            write(`api ${inv.context.apiBase.value} (pin ${API_VERSION_PIN})`);
            if (available !== undefined) write(`update available: ${available.latest} — run: moda update`);
          },
          exitCode: EXIT_OK,
        };
      }),
    );

  addGlobalFlags(
    program
      .command('doctor')
      .description('connectivity, credential validity, scopes, version range, keychain health'),
  ).action(
    wrapAction(async (_args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      return runDoctor(inv);
    }),
  );

  // Hidden machine-readable verb inventory for skills CI parity (skills-and-distribution §3.5).
  program
    .command('__inventory', { hidden: true })
    .option('--json', 'emit JSON (always on for this verb)')
    .description('machine-readable verb inventory')
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const verbs = collectVerbs(cmd.parent as Command, '');
      process.stdout.write(`${JSON.stringify({ verbs }, null, 2)}\n`);
      process.exit(0);
    });
}

interface VerbEntry {
  name: string;
  description: string;
  flags: string[];
}

function collectVerbs(program: Command, prefix: string): VerbEntry[] {
  const out: VerbEntry[] = [];
  for (const sub of program.commands) {
    const name = sub.name();
    if (name.startsWith('__')) continue;
    const full = prefix.length > 0 ? `${prefix} ${name}` : name;
    if (sub.commands.length > 0) {
      out.push(...collectVerbs(sub, full));
    } else {
      out.push({
        name: full,
        description: sub.description(),
        flags: sub.options.map((o) => o.long ?? o.short ?? '').filter((f) => f.length > 0).sort(),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

type DoctorInvocation = ReturnType<typeof buildInvocation>;

async function runDoctor(inv: DoctorInvocation) {
  const checks: Record<string, unknown> = {};
  let exitCode = EXIT_OK;

  // Credential resolution (may throw a multi-account error — surface it as a check, not a crash).
  let credential: ResolvedCredential | undefined;
  let credentialNote: string | undefined;
  try {
    credential = await resolveCredential({ apiBase: inv.context.apiBase.value, org: inv.context.org.value, env: inv.env });
  } catch (err) {
    credentialNote = err instanceof CliError ? err.fields.message : String(err);
  }
  checks.credential_source = credential?.source ?? 'none';
  if (credentialNote !== undefined) checks.credential_note = credentialNote;

  const backend = await selectKeychainBackend(inv.env);
  checks.keychain = backend.name;

  // Connectivity + identity through GET /v1/whoami (also refreshes the version-header stamp).
  let authenticated = false;
  let connectivity = false;
  try {
    const client = credential !== undefined ? (await authedClient(inv, 15_000)).client : anonymousClient(inv, 15_000);
    const response = await client.request({ method: 'GET', path: endpoints.whoami(), timeoutMs: 15_000 });
    connectivity = true;
    authenticated = true;
    const who = parseWhoami(response.body);
    checks.identity = { email: who.email, org: who.orgId, org_name: who.orgName, plan: who.plan };
    checks.scopes = who.scopes;
  } catch (err) {
    if (err instanceof CliError && err.fields.source === 'api') {
      connectivity = true;
      if (err.fields.type === 'authentication' || err.fields.type === 'permission') {
        authenticated = false;
        if (credential !== undefined) {
          checks.credential_error = err.fields.message;
          exitCode = EXIT_AUTH;
        }
      } else {
        checks.api_error = { type: err.fields.type, code: err.fields.code, message: err.fields.message };
      }
    } else {
      connectivity = false;
      checks.connectivity_error = err instanceof CliError ? err.fields.message : String(err);
      exitCode = EXIT_TRANSPORT;
    }
  }
  checks.connectivity = connectivity;
  checks.authenticated = authenticated;

  // Version range, from the headers recorded off the calls above (offline ⇒ silent).
  const stamp = readUpdateStamp(inv.env);
  const available = updateAvailable(inv.env);
  const belowMinimum =
    stamp.minimum_supported !== undefined && compareVersions(CLI_VERSION, stamp.minimum_supported) < 0;
  checks.version = {
    cli: CLI_VERSION,
    latest: stamp.latest,
    minimum_supported: stamp.minimum_supported,
    below_minimum: belowMinimum,
  };

  const body: Record<string, unknown> = {
    ok: exitCode === EXIT_OK,
    api_base: inv.context.apiBase.value,
    org: inv.context.org.value,
    authenticated,
    update_available: available !== undefined ? available.latest : false,
    install_command: pinnedInstallCommand(),
    releases_repo: RELEASES_REPO,
    checks,
    meta: metaBlock(),
  };

  return {
    body,
    human: (write: (line: string) => void) => {
      write(`api_base: ${inv.context.apiBase.value} — ${connectivity ? 'reachable' : 'UNREACHABLE'}`);
      write(`credential: ${String(checks.credential_source)}${authenticated ? ' (valid)' : ''}`);
      if (!authenticated) write('not authenticated — run: moda auth login');
      write(`keychain: ${backend.name}`);
      if (belowMinimum) write(`CLI ${CLI_VERSION} is below the minimum supported version — run: moda update`);
      else if (available !== undefined) write(`update available: ${available.latest} — run: moda update`);
      write(`install/update (pinned): ${pinnedInstallCommand()}`);
    },
    exitCode,
  };
}
