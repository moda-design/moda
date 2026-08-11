/**
 * Semantic markers for the machine-readable verb schema (`moda describe` / `__inventory`).
 *
 * This is NOT a parallel verb registry: names/flags/positionals are always introspected from
 * the live commander registrations, and `destructive` is derived from the --yes gate. Only the
 * three markers that cannot be derived are declared here — and application is self-checking:
 * an entry naming a verb that no longer exists throws at program build, so drift fails every
 * test run and the CI inventory snapshot immediately.
 */
import type { Command } from 'commander';
import { tagVerb, type VerbSemantics } from './runtime.ts';

const SEMANTICS: Record<string, VerbSemantics> = {
  // Canvas authoring (deterministic writes; revision-disciplined)
  'canvas create': { mutating: true },
  'canvas add-pages': { mutating: true },
  'canvas markup': { mutating: true },
  'canvas edit': { mutating: true },
  'canvas delete-items': { mutating: true },
  'canvas rename': { mutating: true },
  'canvas share': { mutating: true },
  'canvas delete': { mutating: true },
  // The pinnable-revision read lane
  'canvas read': { read_lane: true },
  // Files / brand
  'file upload': { mutating: true },
  'brand create': { mutating: true },
  // Websites (deterministic writes)
  'site create': { mutating: true },
  'site set-content': { mutating: true },
  'site publish': { mutating: true },
  'site unpublish': { mutating: true },
  'site delete': { mutating: true },
  // Metered lanes
  'media generate-image': { metered: true, mutating: true },
  'media edit-image': { metered: true, mutating: true },
  'media generate-video': { metered: true, mutating: true },
  'media upscale': { metered: true, mutating: true },
  'media remove-background': { metered: true, mutating: true },
  'web search': { metered: true },
  'web read': { metered: true },
  'task start': { metered: true, mutating: true },
  'task cancel': { mutating: true },
};

function resolveCommand(program: Command, path: string): Command | undefined {
  let current: Command | undefined = program;
  for (const segment of path.split(' ')) {
    current = current?.commands.find((sub) => sub.name() === segment);
  }
  return current;
}

/** Apply the marker table onto the built program; throws on any entry that no longer resolves. */
export function applyVerbSemantics(program: Command): void {
  for (const [path, semantics] of Object.entries(SEMANTICS)) {
    const cmd = resolveCommand(program, path);
    if (cmd === undefined) {
      throw new Error(`verbSemantics: entry '${path}' matches no registered command — update the table`);
    }
    tagVerb(cmd, semantics);
  }
}
