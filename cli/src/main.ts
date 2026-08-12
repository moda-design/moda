/** Entry: commander program assembly. */
import { Command, CommanderError } from 'commander';
import { CliError, type CliErrorFields } from './cliError.ts';
import { registerAccount } from './commands/account.ts';
import { registerAuth } from './commands/auth.ts';
import { registerBrand } from './commands/brand.ts';
import { registerCanvas } from './commands/canvas.ts';
import { registerContext } from './commands/context.ts';
import { registerDrive } from './commands/drive.ts';
import { registerExport } from './commands/export.ts';
import { registerFileFacade, registerFileUpload } from './commands/file.ts';
import { registerMedia } from './commands/media.ts';
import { registerMeta } from './commands/meta.ts';
import { registerOrg } from './commands/org.ts';
import { registerSite } from './commands/site.ts';
import { registerTask } from './commands/task.ts';
import { registerTemplate } from './commands/template.ts';
import { registerWeb } from './commands/web.ts';
import { applyVerbSemantics } from './commands/verbSemantics.ts';
import { metaBlock } from './commands/runtime.ts';
import { persistLastError } from './config/state.ts';
import { emitError, emitOutcome, errorBody } from './output/emit.ts';
import { exitCodeForError, EXIT_INVALID_INPUT, EXIT_SIGINT } from './output/exitCodes.ts';
import { CLI_VERSION } from './version.ts';

export function buildProgram(onErrorOutput?: (text: string) => void): Command {
  const program = new Command('moda');
  program
    .description('Drive Moda as a deterministic artifact runtime — canvases, brand kits, uploads, exports')
    .version(CLI_VERSION, '-V, --version', 'print the CLI version')
    .enablePositionalOptions()
    .exitOverride();
  // Must be configured BEFORE subcommand registration: each .command() copies the parent's
  // output configuration at creation time.
  if (onErrorOutput !== undefined) program.configureOutput({ writeErr: onErrorOutput });

  registerMeta(program);
  registerContext(program);
  registerOrg(program);
  registerAuth(program);
  registerCanvas(program);
  registerExport(program);
  registerFileUpload(program);
  registerFileFacade(program);
  registerBrand(program);
  registerTemplate(program);
  registerTask(program);
  registerAccount(program);
  registerMedia(program);
  registerWeb(program);
  registerSite(program);
  registerDrive(program);
  applyVerbSemantics(program);
  return program;
}

/**
 * Commander parse-stage failures that must become TYPED usage envelopes (cli.md §3: under
 * --json, stdout carries exactly one JSON document — commander's bare stderr line taught
 * nothing and left --json stdout empty; the missing `canvas markup --page` was a guaranteed
 * first-contact stumble in real agent runs).
 */
const USAGE_ERROR_CODES = new Set([
  'commander.missingMandatoryOptionValue',
  'commander.missingArgument',
  'commander.optionMissingArgument',
  'commander.unknownOption',
  'commander.unknownCommand',
  'commander.invalidArgument',
  'commander.excessArguments',
  'commander.conflictingOption',
]);

/** Per-flag retry shapes worth naming exactly (gate finding F6). */
const USAGE_HINTS: Array<{ verb: string; flagMark: string; hint: string }> = [
  {
    verb: 'canvas markup',
    flagMark: "'--page <page_id>'",
    hint:
      'Markup applies to ONE page — retry: moda canvas markup CANVAS --file FILE --page PAGE_ID. ' +
      'Page ids come from moda canvas show/read; --page canvas targets floating nodes on a Design canvas.',
  },
];

function usageFields(err: CommanderError, argv: string[]): CliErrorFields {
  // CommanderError.message is what commander would have printed: "error: <message>" plus, on
  // some codes, a "(Did you mean …?)" suggestion on a following line.
  const [firstLine = '', ...restLines] = err.message.replace(/^error:\s*/, '').split('\n');
  const suggestion = restLines.join(' ').trim();
  const verbWords = argv
    .slice(2)
    .filter((arg) => !arg.startsWith('-'))
    .slice(0, 2);
  const tableHint = USAGE_HINTS.find(
    (entry) => entry.verb === verbWords.join(' ') && firstLine.includes(entry.flagMark),
  )?.hint;
  const hint =
    tableHint ??
    (suggestion.length > 0
      ? suggestion
      : `Flags and required options: moda describe${verbWords.length > 0 ? ` ${verbWords.join(' ')}` : ''} --json`);
  return { type: 'invalid_request', code: 'usage', message: firstLine, hint, source: 'local' };
}

/** Persist + emit a typed error from outside wrapAction (parse-stage failures). */
function emitTypedFailure(fields: CliErrorFields, argv: string[]): never {
  const exitCode = exitCodeForError(fields);
  const emitOpts = { json: argv.includes('--json'), quiet: argv.includes('--quiet') || argv.includes('-q'), pretty: argv.includes('--pretty') };
  const doc = { ...errorBody(fields), meta: metaBlock() };
  persistLastError(doc);
  if (emitOpts.json) emitOutcome({ body: doc, exitCode }, emitOpts);
  else emitError(fields, exitCode, emitOpts);
  process.exit(exitCode);
}

export async function main(argv: string[]): Promise<void> {
  process.on('SIGINT', () => process.exit(EXIT_SIGINT));
  // Commander's own error output is buffered: usage errors are re-emitted as typed envelopes
  // instead; everything else (e.g. bare `moda` printing help on stderr) flushes verbatim.
  let commanderErr = '';
  const program = buildProgram((text) => {
    commanderErr += text;
  });
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version displays exit 0; everything else is a usage error (exit 2 per cli.md §4.1).
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version' || err.exitCode === 0) {
        process.exit(0);
      }
      if (USAGE_ERROR_CODES.has(err.code)) emitTypedFailure(usageFields(err, argv), argv);
      process.stderr.write(commanderErr);
      process.exit(EXIT_INVALID_INPUT);
    }
    // A CliError thrown at parse time (option-value parsers) gets the same typed envelope the
    // action lane produces — never a raw stack trace.
    if (err instanceof CliError) emitTypedFailure(err.fields, argv);
    throw err;
  }
}

if (import.meta.main) {
  await main(process.argv);
}
