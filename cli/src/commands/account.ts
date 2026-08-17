/** `moda account` — plan, credits, usage, and the metered-vs-deterministic model (cli.md §12). */
import type { Command } from 'commander';
import { endpoints } from '../api/endpoints.ts';
import { asObject, listItems, num, parseWhoami, str } from '../api/types.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction } from './runtime.ts';
import { passthroughOutcome } from './canvasShared.ts';

const READ_TIMEOUT_MS = 30_000;

export function registerAccount(program: Command): void {
  const account = program.command('account').description('plan, credits, usage, cost model');

  addGlobalFlags(account.command('status').description('plan, credits remaining/limit, org')).action(
    wrapAction(async (_args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      const credits = await client.request({ method: 'GET', path: endpoints.credits() });
      const orgs = await client.request({ method: 'GET', path: endpoints.organizations() });
      const creditsBody = asObject(credits.body);
      return {
        body: {
          ok: true,
          operation: 'account.status',
          credits: creditsBody,
          organizations: listItems(orgs.body, 'organizations'),
          meta: metaBlock({ requestId: credits.requestId, durationMs: credits.durationMs }),
        },
        human: (write) => {
          const remaining = num(creditsBody, 'remaining') ?? num(creditsBody, 'credits_remaining');
          const limit = num(creditsBody, 'limit') ?? num(creditsBody, 'credits_limit');
          write(`credits: ${remaining ?? '?'} / ${limit ?? '?'}`);
          for (const org of listItems(orgs.body, 'organizations')) {
            write(`org: ${str(org, 'id') ?? '?'}  ${str(org, 'name') ?? ''}${str(org, 'plan') !== undefined ? ` (plan: ${str(org, 'plan')})` : ''}`);
          }
        },
        exitCode: EXIT_OK,
      };
    }),
  );

  addGlobalFlags(
    account
      .command('usage')
      .description('usage over time')
      .option('--days <n>', 'window in days', (v: string) => Number.parseInt(v, 10))
      .option('--by-operation', 'group by operation'),
  ).action(
    wrapAction(async (_args, opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      const response = await client.request({
        method: 'GET',
        path: endpoints.usage(),
        query: {
          days: typeof opts.days === 'number' ? String(opts.days) : undefined,
          by_operation: opts.byOperation === true ? 'true' : undefined,
        },
      });
      return passthroughOutcome('account.usage', response, inv);
    }),
  );

  addGlobalFlags(
    account.command('costs').description('what is metered vs not — from the server entitlement summary, never hardcoded'),
  ).action(
    wrapAction(async (_args, _opts, cmd) => {
      const inv = buildInvocation(cmd);
      const { client } = await authedClient(inv, READ_TIMEOUT_MS);
      const response = await client.request({ method: 'GET', path: endpoints.whoami() });
      const who = parseWhoami(response.body);
      const entitlements = asObject(who.raw.entitlements);
      return {
        body: {
          ok: true,
          operation: 'account.costs',
          plan: who.plan,
          entitlements,
          model: {
            deterministic_lane: 'canvas authoring, reads, lint, screenshot, export, site.* — 0 metered credits on every plan',
            metered_lanes:
              'task.* (Omni), media.*, and web.* — every response carries usage.class; the exact per-call ' +
              'credit amount is NOT returned inline. Per-call credits appear in `moda account usage` once the ' +
              'server has finalized them, and `moda account status` reports the running balance.',
          },
          meta: metaBlock({ requestId: response.requestId, durationMs: response.durationMs }),
        },
        human: (write) => {
          write('deterministic lane (authoring, read, lint, screenshot, export, site.*): 0 credits, every plan');
          write('metered lanes (task.*, media.*, web.*): cost class labeled on every response');
          write('  exact per-call credits are not returned inline — see: moda account usage (balance: moda account status)');
          if (Object.keys(entitlements).length > 0) write(`entitlements: ${JSON.stringify(entitlements)}`);
          else write('entitlement details: not reported by this server build');
        },
        exitCode: EXIT_OK,
      };
    }),
  );
}
