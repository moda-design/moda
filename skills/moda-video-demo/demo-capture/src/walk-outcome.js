// Did the discovery walk FINISH, or give up? (ENG-6133)
//
// `discover()` ends on one of eight reasons and only `done` means the agent
// judged the goal accomplished. The other seven — it ran out of steps, ran out
// of clock, hit a bot wall, the model failed or replied unparsably, it waited
// eight times for a page that never arrived, or it repeated an action the page
// ignored — all mean the walk was abandoned partway.
//
// Every one of them used to be curated, validated, recorded, paced, scored and
// published exactly like a success. The take that filed this scored 2/10 with
// three of its five actions being the agent narrating an absence ("the Templates
// tab has no template cards") before giving up.
//
// Nothing here infers anything. Discovery already knows and already says so;
// this is the reading of a fact that was being thrown away.

//: The one ending that means the agent got where it was going.
const FINISHED = 'done';

//: What each abandonment means, in words a re-discovery can act on. Keyed by the
//: exact strings `src/discovery.js` assigns to `stopped`.
//:
//: `kind` matters because the finding becomes GUIDANCE, appended to the next
//: discovery's system prompt. Telling a run that broke on a Cloudflare wall to
//: "find a different path" steers it away from a path that may have been
//: perfectly good. `unparsable` is the sharpest case: discovery's own comment
//: records it as "usually the model finishing in prose rather than returning
//: {type: done}" on a walk that had already found every step it needed.
const GAVE_UP = {
  max_steps: { kind: 'path', why: 'the agent ran out of steps before reaching the goal — the path it found is too long, or it never arrived' },
  timeout: { kind: 'path', why: 'the walk ran out of time before reaching the goal' },
  waited_out: { kind: 'path', why: 'the agent waited eight times over for a page that never arrived' },
  repeated_action: { kind: 'path', why: 'the agent repeated an action the page did not respond to' },
  bot_challenge: { kind: 'harness', why: 'the site showed a bot challenge — what was on screen is not the product' },
  model_error: { kind: 'harness', why: 'the discovery model failed, so the steps are whatever it managed before it did' },
  unparsable: { kind: 'harness', why: 'the discovery model stopped replying in a form the harness could read — often it finished in prose instead of saying done' },
};

//: What to tell the next attempt, by kind. A path failure means the route was
//: wrong; a harness failure means the walk broke on the tooling or the site and
//: the route may have been fine.
const ADVICE = {
  path: 'What it found is the part of the path it managed before it stopped, so recording it films the agent giving up. ' +
    'Find a path that reaches the goal, or a goal this product can actually reach from here.',
  harness: 'The walk broke on the tooling or the site rather than on the path, so the route it was taking may have been ' +
    'fine — walk it again rather than choosing a different goal.',
};

/**
 * Whether this flow is worth recording, from the reason discovery stopped.
 *
 * Returns `{ measured, finished, reason }`. `measured: false` when the flow
 * carries no `stopped` — a hand-supplied `--flow` never ran discovery, and a
 * file written before this existed has no field. Refusing those would be worse
 * than the bug: the third state stays a third state.
 */
function checkWalkFinished(flow) {
  const stopped = flow?.stopped;
  if (typeof stopped !== 'string' || !stopped) {
    return { measured: false, reason: 'this flow carries no discovery outcome, so whether the walk finished is unknown' };
  }
  if (stopped === FINISHED) return { measured: true, finished: true };
  const known = GAVE_UP[stopped];
  return {
    measured: true,
    finished: false,
    stopped,
    // An unrecognised value is still not `done`, so it is still an abandonment —
    // just one this list has not learned to describe. Saying that beats either
    // silence or a fabricated explanation. It is treated as a PATH failure
    // because that advice is the conservative one: it asks for a different
    // route rather than asserting the tooling is at fault.
    kind: known?.kind ?? 'path',
    reason: known?.why ?? `discovery stopped with "${stopped}", which is not a completed walk`,
    advice: ADVICE[known?.kind ?? 'path'],
  };
}

module.exports = { checkWalkFinished, FINISHED, GAVE_UP, ADVICE };
