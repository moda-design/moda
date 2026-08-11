/** Entry: commander program assembly. */
import { Command, CommanderError } from 'commander';
import { registerAuth } from './commands/auth.ts';
import { registerContext } from './commands/context.ts';
import { registerMeta } from './commands/meta.ts';
import { registerOrg } from './commands/org.ts';
import { EXIT_INVALID_INPUT, EXIT_SIGINT } from './output/exitCodes.ts';
import { CLI_VERSION } from './version.ts';

export function buildProgram(): Command {
  const program = new Command('moda');
  program
    .description('Drive Moda as a deterministic artifact runtime — canvases, brand kits, uploads, exports')
    .version(CLI_VERSION, '-V, --version-flag', 'print the CLI version')
    .enablePositionalOptions()
    .exitOverride();

  registerMeta(program);
  registerContext(program);
  registerOrg(program);
  registerAuth(program);
  return program;
}

export async function main(argv: string[]): Promise<void> {
  process.on('SIGINT', () => process.exit(EXIT_SIGINT));
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version displays exit 0; everything else is a usage error (exit 2 per cli.md §4.1).
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version' || err.exitCode === 0) {
        process.exit(0);
      }
      process.exit(EXIT_INVALID_INPUT);
    }
    throw err;
  }
}

if (import.meta.main) {
  await main(process.argv);
}
