/**
 * "I am done working on this canvas" — the hand-off signal (ENG-5160).
 *
 * While an agent works, every canvas mutation records that fact so a reader who
 * followed the link out of Claude Code or the CLI sees a working state instead
 * of a blank page (ENG-5099). Nothing in the protocol says when the turn ENDS —
 * the agent's turn finishes in a process the server never hears from — so
 * without a signal that state only expires on a timer, and a finished deck goes
 * on saying "Editing the design" with its elapsed clock still climbing minutes
 * after the agent stopped. That is the reported bug this exists to end.
 *
 * The signal rides the DELIVERY verbs rather than a verb of its own. `moda
 * canvas open` and a completed `moda export` are what every format skill runs
 * at the end of a run, they already mean "here is the artifact, look at it",
 * and firing from them costs the model nothing to remember. A run that crashes,
 * is interrupted, or never opens the canvas simply never sends one — which is
 * why the server keeps its TTL as the contract and treats this as the fast path.
 *
 * NEVER fails its caller, and never prints. The work it follows is already
 * committed and the artifact is already delivered; a stale pill is a far smaller
 * cost than an export that reports failure after writing the file. Older servers
 * 404 this route, which is exactly the same non-event.
 */
import { endpoints } from '../api/endpoints.ts';
import type { ApiClient } from '../api/client.ts';

const HAND_OFF_TIMEOUT_MS = 5_000;

export async function signalCanvasHandOff(client: ApiClient, ref: string): Promise<void> {
  try {
    await client.request({
      method: 'POST',
      path: endpoints.canvasAgentActivityDone(ref),
      timeoutMs: HAND_OFF_TIMEOUT_MS,
    });
  } catch {
    // Deliberately silent: see the module docstring. There is nothing a user
    // could do with "the working-state indicator may linger for 90 seconds".
  }
}
