/**
 * `moda template` — the team's template canvases: the approved starting points for recurring
 * artifacts (QBR decks, launch posts, one-pagers). Instantiation is `moda canvas create
 * --template <canvas>`: the server makes a full copy, and the copy is a regular canvas.
 *
 * Two read verbs on purpose. `list` is the model-safe browse (redaction scrubs signature
 * params from every emitted byte, so its thumbnail URLs are not fetchable); `pull` writes the
 * raw payload to a file with the signed thumbnail URLs intact — the same use-and-discard
 * handles `moda brand pull` gives logos, so you can LOOK at a template before choosing it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import { endpoints } from '../api/endpoints.ts';
import { listItems, num, str } from '../api/types.ts';
import { EXIT_OK } from '../output/exitCodes.ts';
import { addGlobalFlags, authedClient, buildInvocation, metaBlock, wrapAction } from './runtime.ts';
import { LIST_ALL_CAP, fetchListPages, listFlagsOf, listOutcome, parseListLimit } from './listLane.ts';

const READ_TIMEOUT_MS = 60_000;

const PULL_STEER =
  '\nThumbnails: signature params are scrubbed from everything `template list` emits (--output\n' +
  'included), so its thumbnail_url values are NOT fetchable. `moda template pull` writes the raw\n' +
  'payload — download those URLs, look at them, discard them (they expire).\n';

/** `cvs_…  Name  [category · N pages]` — category/page_count are both optional on the wire. */
export function templateLine(template: Record<string, unknown>): string {
  const facets: string[] = [];
  const category = str(template, 'category');
  if (category !== undefined) facets.push(category);
  const pageCount = num(template, 'page_count');
  if (pageCount !== undefined) facets.push(`${pageCount} page${pageCount === 1 ? '' : 's'}`);
  return (
    `${str(template, 'id') ?? '?'}  ${str(template, 'name') ?? ''}` +
    `${facets.length > 0 ? `  [${facets.join(' · ')}]` : ''}`
  );
}

export function registerTemplate(program: Command): void {
  const template = program
    .command('template')
    .description('team templates: start a canvas from a design the team already approved');

  addGlobalFlags(
    template
      .command('list')
      .description("the team's template canvases — start recurring work from an approved look, not from scratch")
      .option('--limit <n>', 'page size', parseListLimit)
      .option('--cursor <token>', "resume token from a previous page's next_cursor")
      .option('--all', `fetch every page (bounded at ${LIST_ALL_CAP} items)`)
      .option('--output <file>', 'write the full payload to a file; stdout gets a small summary + preview'),
  )
    .addHelpText(
      'after',
      `${PULL_STEER}\nInstantiate: moda canvas create --template cvs_… --name "…" (full copy; edit the copy).\n`,
    )
    .action(
      wrapAction(async (_args, opts, cmd) => {
        const inv = buildInvocation(cmd);
        const flags = listFlagsOf(opts);
        const { client } = await authedClient(inv, READ_TIMEOUT_MS);
        // Cursor lane (#9317): templates page by next_cursor (items under `data`).
        const pages = await fetchListPages(client, endpoints.templateList(), {}, flags, READ_TIMEOUT_MS, 'cursor');
        return listOutcome({
          operation: 'template.list',
          pages,
          flags,
          emptyHint: 'no team templates — mark canvases as templates in the app, or create from scratch',
          itemLine: templateLine,
        });
      }),
    );

  addGlobalFlags(
    template
      .command('pull')
      .description('write the raw templates payload — the one read whose thumbnail URLs are fetchable — to a file')
      .requiredOption('-o, --output <path>', 'output path, e.g. templates.json')
      .option('--limit <n>', 'page size', parseListLimit)
      .option('--cursor <token>', "resume token from a previous page's next_cursor"),
  )
    .addHelpText(
      'after',
      '\nDownload each candidate thumbnail (curl -o) and LOOK at it with your own vision before\n' +
        'choosing. Signed URLs are use-and-discard: never put one in markup, and never persist one.\n',
    )
    .action(
      wrapAction(async (_args, opts, cmd) => {
        const inv = buildInvocation(cmd);
        const { client } = await authedClient(inv, READ_TIMEOUT_MS);
        const response = await client.request({
          method: 'GET',
          path: endpoints.templateList(),
          query: {
            ...(typeof opts.limit === 'number' ? { limit: String(opts.limit) } : {}),
            ...(typeof opts.cursor === 'string' ? { cursor: opts.cursor } : {}),
          },
        });
        // RAW write, exactly like `brand pull`: this bypasses the emit/redaction pipeline on
        // purpose — a redacted thumbnail URL cannot be fetched, and fetching is the point.
        const outPath = opts.output as string;
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, `${JSON.stringify(response.body, null, 2)}\n`, 'utf8');
        const returned = listItems(response.body, 'data').length;
        return {
          body: {
            ok: true,
            operation: 'template.pull',
            output: outPath,
            returned,
            meta: metaBlock({ requestId: response.requestId, durationMs: response.durationMs }),
          },
          human: (write) => {
            write(`${returned} template${returned === 1 ? '' : 's'} → ${outPath}`);
            write('thumbnail_url values in this file are fetchable and short-lived — download, look, discard');
          },
          exitCode: EXIT_OK,
        };
      }),
    );
}
