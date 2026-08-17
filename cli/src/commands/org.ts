/** `moda org list|use|current` — orgs are the billing boundary (cli.md §6). */
import type { Command } from 'commander';
import { endpoints } from '../api/endpoints.ts';
import { listItems, str, type JsonObject } from '../api/types.ts';
import { resolveCredential } from '../auth/credentials.ts';
import { CliError } from '../cliError.ts';
import { readConfig, writeConfig } from '../config/config.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction } from './runtime.ts';
import { LIST_ALL_CAP, fetchListPages, listFlagsOf, listOutcome, parseListLimit, parseListOffset } from './listLane.ts';

/** One `moda org list` line. */
export function orgLine(o: JsonObject): string {
  const slug = str(o, 'slug');
  return `${str(o, 'id') ?? '?'}  ${str(o, 'name') ?? ''}${slug !== undefined ? ` (${slug})` : ''}`;
}

export function registerOrg(program: Command): void {
  const org = program.command('org').description('organization context');

  addGlobalFlags(
    org
      .command('list')
      .description('organizations this credential can act in')
      .option('--limit <n>', 'page size', parseListLimit)
      .option('--cursor <token>', "resume token from a previous page's next_cursor")
      .option('--all', `fetch every page (bounded at ${LIST_ALL_CAP} items)`)
      .option('--output <file>', 'write the full payload to a file; stdout gets a small summary + preview'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const flags = listFlagsOf(opts);
      const { client } = await authedClient(inv, 30_000);
      // Cursor lane (#9317).
      const pages = await fetchListPages(client, endpoints.organizations(), {}, flags, 30_000, 'cursor');
      return listOutcome({
        operation: 'org.list',
        pages,
        flags,
        emptyHint: 'no organizations',
        itemLine: orgLine,
      });
    }),
  );

  addGlobalFlags(org.command('use <org>').description('set the configured org context')).action(
    wrapAction(async (args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const target = args[0];
      if (target === undefined) throw CliError.usage('Usage: moda org use <org_id|slug>');
      const config = readConfig(inv.env);
      config.context = { ...config.context, org: target };
      writeConfig(config, inv.env);
      // Helpful warning when no credential exists for the target org (cli-repo-plan §7 gotcha).
      let warning: string | undefined;
      try {
        const cred = await resolveCredential({ apiBase: inv.context.apiBase.value, org: target, env: inv.env });
        if (cred === undefined) warning = `No credential stored for ${target} — run: moda auth login`;
      } catch {
        warning = `No credential stored for ${target} — run: moda auth login`;
      }
      if (warning !== undefined) inv.note(warning);
      return {
        body: { ok: true, org: target, ...(warning !== undefined ? { warning } : {}), meta: metaBlock() },
        human: (write) => write(`org context set to ${target}`),
        exitCode: EXIT_OK,
      };
    }),
  );

  addGlobalFlags(org.command('current').description('the effective org context and its source')).action(
    wrapAction(async (_args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      return {
        body: {
          ok: true,
          org: inv.context.org.value,
          source: inv.context.org.source,
          meta: metaBlock(),
        },
        human: (write) => write(`org: ${inv.context.org.value ?? '(unset)'}  [${inv.context.org.source}]`),
        exitCode: EXIT_OK,
      };
    }),
  );
}
