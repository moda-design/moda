/** `moda version`, `moda doctor`, `moda __inventory` (hidden), and — from slice 4 — `moda update`. */
import type { Command } from 'commander';
import { endpoints } from '../api/endpoints.ts';
import { parseWhoami } from '../api/types.ts';
import { resolveCredential, type ResolvedCredential } from '../auth/credentials.ts';
import { selectKeychainBackend } from '../auth/keychain.ts';
import { CliError } from '../cliError.ts';
import { readLastError, readUpdateStamp } from '../config/state.ts';
import { EXIT_AUTH, EXIT_OK, EXIT_TRANSPORT } from '../output/exitCodes.ts';
import { compareVersions, pinnedInstallCommand, RELEASES_REPO, updateAvailable } from '../update.ts';
import { API_VERSION_PIN } from '../api/endpoints.ts';
import { CLI_CHANNEL, CLI_VERSION, platformArch } from '../version.ts';
// Embedded reference texts — compiled into the binary, no runtime file lookup.
import markupDoc from '../docs/markup.md' with { type: 'text' };
import editDoc from '../docs/edit.md' with { type: 'text' };
import workflowDoc from '../docs/workflow.md' with { type: 'text' };

const DOCS: Record<string, string> = {
  markup: markupDoc,
  edit: editDoc,
  workflow: workflowDoc,
};
import { addGlobalFlags, anonymousClient, authedClient, buildInvocation, metaBlock, verbSemanticsOf, wrapAction } from './runtime.ts';

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

  addGlobalFlags(
    program
      .command('update')
      .description('update the CLI (dogfood: prints the pinned gh release download command; never silent)'),
  ).action(
    wrapAction(async (_args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const available = updateAvailable(inv.env);
      // Ruling 13: while the repo is private, `moda update` PRINTS the pinned command on every
      // channel instead of self-updating; the npm/brew channels always print their own command.
      const command =
        CLI_CHANNEL === 'npm'
          ? 'npm install -g moda@latest'
          : CLI_CHANNEL === 'brew'
            ? 'brew upgrade moda'
            : pinnedInstallCommand();
      return {
        body: {
          ok: true,
          operation: 'update',
          channel: CLI_CHANNEL,
          current: CLI_VERSION,
          update_available: available !== undefined ? available.latest : false,
          command,
          self_update: false,
          meta: metaBlock(),
        },
        human: (write) => {
          if (available !== undefined) write(`moda ${available.latest} is available (current: ${CLI_VERSION}).`);
          else write(`no newer version recorded (current: ${CLI_VERSION}).`);
          write('Update with:');
          write(`  ${command}`);
        },
        exitCode: EXIT_OK,
      };
    }),
  );

  program
    .command('completion <shell>')
    .description('print a shell completion script (bash | zsh | fish)')
    .action((shell: string, _opts: Record<string, unknown>, cmd: Command) => {
      const program_ = cmd.parent as Command;
      const script = renderCompletion(shell, program_);
      process.stdout.write(script);
      process.exit(0);
    });

  addGlobalFlags(
    program.command('docs [topic]').description('print offline reference texts (markup | edit | workflow)'),
  ).action(
    wrapAction(async (args, _opts, _cmd) => {
      const topic = args[0] ?? 'workflow';
      const text = DOCS[topic];
      if (text === undefined) {
        throw CliError.usage(`Unknown docs topic '${topic}'.`, `Topics: ${Object.keys(DOCS).sort().join(', ')}.`);
      }
      return {
        body: { ok: true, operation: 'docs', topic, text, meta: metaBlock() },
        human: (write) => write(text),
        exitCode: EXIT_OK,
      };
    }),
  );

  addGlobalFlags(
    program
      .command('last-error')
      .description('re-print the full error envelope of the last failed command (no re-run needed)'),
  ).action(
    wrapAction(async (_args, _opts, _cmd) => {
      const doc = readLastError();
      if (doc === undefined) {
        throw new CliError({
          type: 'not_found',
          code: 'no_last_error',
          message: 'No failed command has been recorded yet.',
          source: 'local',
        });
      }
      return {
        body: { ok: true, operation: 'last-error', last_error: doc, meta: metaBlock() },
        human: (write) => {
          // Lead with WHEN it failed — an old timestamp tells the agent this is a stale failure.
          if (typeof doc.exited_at === 'string') write(`recorded at: ${doc.exited_at}`);
          write(JSON.stringify(doc, null, 2));
        },
        exitCode: EXIT_OK,
      };
    }),
  );

  addGlobalFlags(
    program
      .command('describe [verb...]')
      .description('machine-readable verb schema — all verbs compact, or one verb in full (markers: mutating/destructive/metered/read_lane)'),
  ).action(
    wrapAction(async (args, _opts, cmd) => {
      const verbs = collectVerbs(cmd.parent as Command, '');
      if (args.length === 0) {
        // Token-frugal listing: name + one-line + markers only.
        const listing = verbs.map((verb) => ({ name: verb.name, description: verb.description, markers: verb.markers }));
        return {
          body: { ok: true, operation: 'describe', verbs: listing, meta: metaBlock() },
          human: (write) => {
            for (const verb of listing) {
              const marks = Object.entries(verb.markers)
                .filter(([, v]) => v)
                .map(([k]) => k)
                .join(',');
              write(`${verb.name}${marks.length > 0 ? ` [${marks}]` : ''} — ${verb.description}`);
            }
          },
          exitCode: EXIT_OK,
        };
      }
      const wanted = args.join(' ');
      const match = verbs.find((verb) => verb.name === wanted);
      if (match === undefined) {
        const near = verbs.filter((verb) => verb.name.startsWith(`${args[0]} `) || verb.name === args[0]).map((v) => v.name);
        throw CliError.usage(
          `Unknown verb '${wanted}'.`,
          near.length > 0 ? `Did you mean: ${near.join(', ')}` : 'List all verbs: moda describe --json',
        );
      }
      return {
        body: { ok: true, operation: 'describe', verb: match, meta: metaBlock() },
        human: (write) => write(JSON.stringify(match, null, 2)),
        exitCode: EXIT_OK,
      };
    }),
  );

  // Hidden machine-readable verb inventory for skills CI parity (skills-and-distribution §3.5).
  program
    .command('__inventory', { hidden: true })
    .option('--json', 'emit JSON (always on for this verb)')
    .description('machine-readable verb inventory')
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const verbs = collectVerbs(cmd.parent as Command, '');
      process.stdout.write(`${JSON.stringify({ verbs })}\n`);
      process.exit(0);
    });
}

interface FlagEntry {
  flag: string;
  description: string;
  /** Flag takes a value (`--limit <n>`) vs boolean switch. */
  takes_value: boolean;
  required: boolean;
  default?: unknown;
}

interface PositionalEntry {
  name: string;
  required: boolean;
  variadic: boolean;
}

interface VerbMarkers {
  mutating: boolean;
  /** Gated by --yes under --json/--no-input. */
  destructive: boolean;
  metered: boolean;
  read_lane: boolean;
}

interface VerbEntry {
  name: string;
  description: string;
  positionals: PositionalEntry[];
  flags: FlagEntry[];
  markers: VerbMarkers;
}

/**
 * THE machine-readable verb schema — consumed identically by `moda describe`, `__inventory`,
 * the committed snapshot (cli/verb-inventory.json), and CI parity. Everything is introspected
 * from the live commander registrations plus the tagVerb semantics attached at those same
 * registration sites; `destructive` is derived from the presence of a --yes gate.
 */
export function collectVerbs(program: Command, prefix: string): VerbEntry[] {
  const out: VerbEntry[] = [];
  for (const sub of program.commands) {
    const name = sub.name();
    if (name.startsWith('__')) continue;
    const full = prefix.length > 0 ? `${prefix} ${name}` : name;
    if (sub.commands.length > 0) {
      out.push(...collectVerbs(sub, full));
    } else {
      const semantics = verbSemanticsOf(sub);
      out.push({
        name: full,
        description: sub.description(),
        positionals: sub.registeredArguments.map((arg) => ({
          name: arg.name(),
          required: arg.required,
          variadic: arg.variadic,
        })),
        flags: sub.options
          .map((option) => ({
            flag: option.long ?? option.short ?? '',
            description: option.description ?? '',
            takes_value: /[<[]/.test(option.flags),
            required: option.mandatory === true,
            ...(option.defaultValue !== undefined ? { default: option.defaultValue } : {}),
          }))
          .filter((entry) => entry.flag.length > 0)
          .sort((a, b) => a.flag.localeCompare(b.flag)),
        markers: {
          mutating: semantics.mutating === true,
          destructive: sub.options.some((option) => option.long === '--yes'),
          metered: semantics.metered === true,
          read_lane: semantics.read_lane === true,
        },
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
    // Step-0's entitlement gate reads these: whoami delivers them, so doctor must surface them.
    checks.entitlements = who.raw.entitlements ?? {};
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
      const entitlements = checks.entitlements;
      if (entitlements !== undefined && typeof entitlements === 'object' && Object.keys(entitlements as object).length > 0) {
        write(`entitlements: ${JSON.stringify(entitlements)}`);
      }
      if (belowMinimum) write(`CLI ${CLI_VERSION} is below the minimum supported version — run: moda update`);
      else if (available !== undefined) write(`update available: ${available.latest} — run: moda update`);
      write(`install/update (pinned): ${pinnedInstallCommand()}`);
    },
    exitCode,
  };
}

// --- Shell completion (minimal two-level generator over the commander tree) ---

function topLevelNames(program: Command): string[] {
  return program.commands.filter((c) => !c.name().startsWith('__')).map((c) => c.name());
}

function subNames(program: Command, name: string): string[] {
  const found = program.commands.find((c) => c.name() === name);
  return found === undefined ? [] : found.commands.filter((c) => !c.name().startsWith('__')).map((c) => c.name());
}

function renderCompletion(shell: string, program: Command): string {
  const tops = topLevelNames(program);
  const subs = Object.fromEntries(tops.map((t) => [t, subNames(program, t)]));
  if (shell === 'bash') {
    const cases = tops
      .filter((t) => (subs[t] ?? []).length > 0)
      .map((t) => `    ${t}) COMPREPLY=($(compgen -W "${(subs[t] ?? []).join(' ')}" -- "$cur")); return ;;`)
      .join('\n');
    return [
      '_moda_completions() {',
      '  local cur=${COMP_WORDS[COMP_CWORD]}',
      '  local first=${COMP_WORDS[1]}',
      '  if [ "$COMP_CWORD" -eq 1 ]; then',
      `    COMPREPLY=($(compgen -W "${tops.join(' ')}" -- "$cur")); return`,
      '  fi',
      '  case "$first" in',
      cases,
      '  esac',
      '}',
      'complete -F _moda_completions moda',
      '',
    ].join('\n');
  }
  if (shell === 'zsh') {
    const cases = tops
      .filter((t) => (subs[t] ?? []).length > 0)
      .map((t) => `    ${t}) _values 'subcommand' ${(subs[t] ?? []).map((s) => `'${s}'`).join(' ')} ;;`)
      .join('\n');
    return [
      '#compdef moda',
      '_moda() {',
      '  if (( CURRENT == 2 )); then',
      `    _values 'command' ${tops.map((t) => `'${t}'`).join(' ')}`,
      '  else',
      '  case "$words[2]" in',
      cases,
      '  esac',
      '  fi',
      '}',
      '_moda "$@"',
      '',
    ].join('\n');
  }
  if (shell === 'fish') {
    const lines = [`complete -c moda -f -n '__fish_use_subcommand' -a '${tops.join(' ')}'`];
    for (const t of tops) {
      const s = subs[t] ?? [];
      if (s.length > 0) lines.push(`complete -c moda -f -n '__fish_seen_subcommand_from ${t}' -a '${s.join(' ')}'`);
    }
    return `${lines.join('\n')}\n`;
  }
  process.stderr.write(`moda: unknown shell '${shell}' — supported: bash, zsh, fish\n`);
  process.exit(2);
}
