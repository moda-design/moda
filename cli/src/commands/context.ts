/** `moda context show|set|clear` — effective merged context + provenance (cli.md §2.3). */
import type { Command } from 'commander';
import { CliError } from '../cliError.ts';
import { assertContextKey, writeRepoContextKey } from '../config/context.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import { addGlobalFlags, buildInvocation, metaBlock, wrapAction } from './runtime.ts';

export function registerContext(program: Command): void {
  const context = program.command('context').description('repo/user context (org, brand, canvas)');

  addGlobalFlags(context.command('show').description('effective merged context and where each value came from')).action(
    wrapAction(async (_args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const entries = {
        org: inv.context.org,
        brand: inv.context.brand,
        canvas: inv.context.canvas,
        api_base: inv.context.apiBase,
        output_dir: inv.context.outputDir,
      };
      return {
        body: {
          ok: true,
          context: Object.fromEntries(
            Object.entries(entries).map(([key, resolved]) => [key, { value: resolved.value, source: resolved.source }]),
          ),
          repo_root: inv.context.repoRoot,
          meta: metaBlock(),
        },
        human: (write) => {
          for (const [key, resolved] of Object.entries(entries)) {
            write(`${key}: ${resolved.value ?? '(unset)'}  [${resolved.source}]`);
          }
          if (inv.context.repoRoot !== undefined) write(`repo context: ${inv.context.repoRoot}/.moda/`);
        },
        exitCode: EXIT_OK,
      };
    }),
  );

  addGlobalFlags(
    context
      .command('set <key> <value>')
      .description('set org/brand/canvas in .moda/context.json (or the gitignored local override)')
      .option('--local', 'write .moda/context.local.json and gitignore it'),
  ).action(
    wrapAction(async (args, opts) => {
      const [keyRaw, value] = args;
      if (keyRaw === undefined || value === undefined) throw CliError.usage('Usage: moda context set KEY VALUE');
      const key = assertContextKey(keyRaw);
      const path = writeRepoContextKey(key, value, { local: opts.local === true });
      return {
        body: { ok: true, key, value, path, meta: metaBlock() },
        human: (write) => write(`${key} = ${value}  → ${path}`),
        exitCode: EXIT_OK,
      };
    }),
  );

  addGlobalFlags(
    context
      .command('clear [key]')
      .description('clear one context key (or all keys) in the repo context')
      .option('--local', 'operate on .moda/context.local.json'),
  ).action(
    wrapAction(async (args, opts) => {
      const local = opts.local === true;
      const keys = args[0] !== undefined ? [assertContextKey(args[0])] : (['org', 'brand', 'canvas'] as const);
      let path = '';
      for (const key of keys) path = writeRepoContextKey(key, undefined, { local });
      return {
        body: { ok: true, cleared: [...keys], path, meta: metaBlock() },
        human: (write) => write(`cleared ${keys.join(', ')} in ${path}`),
        exitCode: EXIT_OK,
      };
    }),
  );
}
