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
  'canvas import-pages': { mutating: true },
  'canvas import-pptx': { mutating: true },
  'canvas duplicate': { mutating: true },
  'canvas share': { mutating: true },
  'canvas delete': { mutating: true },
  // The pinnable-revision read lane (lint refreshes the cached revision too)
  'canvas read': { read_lane: true },
  'canvas lint': { read_lane: true },
  // Files / brand
  'file upload': { mutating: true },
  'brand create': { mutating: true },
  'brand update': { mutating: true },
  'brand images': {},
  'brand add-image': { mutating: true },
  'brand remove-image': { mutating: true },
  // Websites (deterministic writes)
  'site create': { mutating: true },
  'site set-content': { mutating: true },
  'site publish': { mutating: true },
  'site unpublish': { mutating: true },
  'site delete': { mutating: true },
  'site add-page': { mutating: true },
  'site delete-page': { mutating: true },
  // Drive (folders, placement, visibility — deterministic writes; rm derives destructive from --yes)
  'drive mkdir': { mutating: true },
  'drive move': { mutating: true },
  'drive rename': { mutating: true },
  'drive visibility': { mutating: true },
  'drive rm': { mutating: true },
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
  // Pure reads / local-state / meta verbs — explicitly classified as marker-free so that a
  // NEWLY REGISTERED verb fails the build until someone classifies it (see the leaf sweep).
  'account costs': {},
  'account status': {},
  'account usage': {},
  'auth login': {},
  'auth logout': {},
  'auth status': {},
  'brand guide': {},
  'brand guides': {},
  'brand list': {},
  'brand pull': {},
  'brand show': {},
  'brand use': {},
  'canvas instructions': {},
  'canvas list': {},
  'canvas open': {},
  'canvas screenshot': {},
  'canvas search': {},
  'canvas show': {},
  'completion': {},
  'context clear': {},
  'context set': {},
  'context show': {},
  'describe': {},
  'docs': {},
  'drive folders': {},
  'drive tree': {},
  'doctor': {},
  'export': {},
  'file download': {},
  'file list': {},
  'file search': {},
  'file show': {},
  'last-error': {},
  'media models': {},
  'media upscale-video': { metered: true, mutating: true },
  'org current': {},
  'org list': {},
  'org use': {},
  'site list': {},
  'site pages': { read_lane: true },
  'site screenshot': {},
  'site show': { read_lane: true },
  'task list': {},
  'task status': {},
  'template list': {},
  'template pull': {},
  'update': {},
  'version': {},
};

function resolveCommand(program: Command, path: string): Command | undefined {
  let current: Command | undefined = program;
  for (const segment of path.split(' ')) {
    current = current?.commands.find((sub) => sub.name() === segment);
  }
  return current;
}

function leafPaths(program: Command, prefix: string): string[] {
  const out: string[] = [];
  for (const sub of program.commands) {
    const name = sub.name();
    if (name.startsWith('__')) continue;
    const full = prefix.length > 0 ? `${prefix} ${name}` : name;
    if (sub.commands.length > 0) out.push(...leafPaths(sub, full));
    else out.push(full);
  }
  return out;
}

/**
 * Apply the marker table onto the built program. Self-checking in BOTH directions: an entry
 * naming a removed verb throws, and a registered leaf verb with no entry throws — a newly
 * added verb fails the build until someone classifies it (explicit {} for a pure read).
 */
export function applyVerbSemantics(program: Command): void {
  for (const [path, semantics] of Object.entries(SEMANTICS)) {
    const cmd = resolveCommand(program, path);
    if (cmd === undefined) {
      throw new Error(`verbSemantics: entry '${path}' matches no registered command — update the table`);
    }
    tagVerb(cmd, semantics);
  }
  const unclassified = leafPaths(program, '').filter((path) => !(path in SEMANTICS));
  if (unclassified.length > 0) {
    throw new Error(
      `verbSemantics: unclassified verb(s): ${unclassified.join(', ')} — add table entries ({} for a pure read)`,
    );
  }
}
