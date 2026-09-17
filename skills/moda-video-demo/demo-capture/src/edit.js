// The editorial pass: what this demo is ABOUT, and which steps tell that story.
//
// Everything upstream of here answers "what did the agent do". Nothing asked
// "what is worth watching". Discovery drives the product to REACH a goal, which
// is a different job from showing it off, and the two stages that look like
// they cover this do not:
//
//   - `curate.js` is a regex junk filter — `Try again`, `Maybe later`, cookie
//     banners. It removes what a demo must never show. It has no opinion about
//     what a demo SHOULD show.
//   - the no-op drop in `run.mjs` is a pixel diff. It removes steps that
//     provably changed nothing.
//
// Neither can drop a step that works fine and simply is not the point, which is
// most of the compression a real edit performs. The clearest evidence that the
// gap is real is `flow-shape.js`: it already detects "that is a tour of a
// widget, not a demo of a product", prints the warning, and records anyway. The
// pipeline could see a flow had no story and had no lever to give it one.
//
// GENERATOR PROPOSES, CODE DISPOSES. The split is the one the audit named: if
// there is a wrong answer a machine can detect, it belongs in code. So the
// model decides what the demo is about, what to cut, which beat each step is
// and whether to hold or hurry — all judgement, none of it checkable — and
// `disposeEdit` enforces the invariants that are:
//
//   - a `wait` is never cut (it is a synchronisation primitive, not a beat)
//   - the flow never empties, and keeps at least two visible actions when it
//     had them — `run.mjs` already calls one "a thin demo"
//   - exactly one payoff, and it is the last kept step
//   - a decision the model omitted is a KEEP, never a silent drop
//   - a reorder is applied only if the reordered flow still replays, which the
//     caller establishes by walking it (see `run.mjs`)
//
// WHY BEFORE THE RECORDING. A cut costs nothing here and costs a re-record
// afterwards, which is `run.mjs`'s cheapest-first ordering. It also means the
// script — written and voiced from this flow in `pacing.js` — is written for
// the edit rather than for the transcript. The post-hoc form of this belongs to
// the upload lane, where the source is given rather than produced (ENG-5835).
const { execFileSync } = require('node:child_process');
const { stepName } = require('./element-name.js');
const { isSensitive } = require('./sensitive.js');

//: Where a kept step sits in the film. Chosen to line up 1:1 with the
//: storyboard ENG-6306 compiles from the reference canvas — `01 Hook`,
//: `02 Feature`, `03 Closing` — so the composition layer consumes these rather
//: than asking a model the same question a second time.
const BEATS = ['hook', 'build', 'payoff', 'close'];

//: What the EDITOR may assign. `close` is in the vocabulary but not in its
//: gift: nothing the editor can see is a close, so `settleBeats` puts that
//: beat on the trailing hold instead.
//:
//: Validating against all four let a `close` on the LAST real action survive —
//: the demotion only rejected a close that was not final — and the payoff then
//: settled onto the step before it, breaking the one invariant the hold
//: depends on. Refusing it at the door is the fix; `settleBeats`'s own rule
//: then only ever sees the close it assigned itself.
const EDITOR_BEATS = ['hook', 'build', 'payoff'];

//: Whether this moment wants room or wants to get out of the way. It acts in
//: exactly one place each, and `pacing.js` is where both land:
//:   hold   -> a wall-clock floor on the step, composed max() with the line
//:   hurry  -> the script is asked for a SHORT line, which lowers that floor
//:   normal -> the line's own measured length, as today
//: `hurry` deliberately does NOT reach `compress.js`. That stage's protection
//: set encodes several hard-won results about waits, typing and the closing
//: beat, and a per-step override there would be a fourth interacting rule in
//: the one place where the failures have all been silent.
const PACES = ['hold', 'normal', 'hurry'];

//: Below this many visible actions in the SOURCE, there is no edit to make —
//: the flow is already the shortest thing that demonstrates anything.
const MIN_EDITABLE = 3;

//: What the edit must leave behind, when the source had that much. The same
//: threshold `run.mjs` uses to call a flow "a thin demo".
const MIN_KEPT_ACTIONS = 2;

const SYSTEM = [
  'You are the editor of a short product demo video. You are given the demo\'s goal and the ordered',
  'list of UI actions an agent performed to reach it. Your job is NOT to describe what happened — it',
  'is to decide what the finished video is about and which of these moments tell that story.',
  '',
  'The list you are given is a record of REACHING a goal. That is a different job from showing a',
  'product off, and it is usually longer. Steps that got the agent somewhere — navigating to the right',
  'workspace, opening the panel the real feature lives in, selecting a prerequisite — are transport.',
  'They are not wrong, they are just not what anyone came to watch. Cut without mercy.',
  '',
  'For every action decide:',
  '',
  '  keep   — true or false. False cuts it from the video entirely.',
  '  beat   — for a keeper: "hook", "build" or "payoff".',
  '             hook    the opening moment that says what this is. Usually one.',
  '             build   the work: the steps that set the payoff up.',
  '             payoff  the moment the product delivers. EXACTLY ONE, and it is the',
  '                     LAST thing that plays — if you mark it earlier, it moves.',
  '           There is no "close" to assign: the closing beat is a hold on the result',
  '           and a brand card, and both are added for you after this.',
  '  pace   — "hold" to give the moment room, "hurry" to get it out of the way,',
  '           "normal" otherwise. Hold the payoff. Hurry transport you kept only',
  '           because the next step needs it.',
  '  why    — a few words. For a cut, why it is not the story. For a keeper, what',
  '           it contributes.',
  '',
  'Also write:',
  '',
  '  about  — ONE sentence naming what the finished video demonstrates. Not the goal restated:',
  '           what a viewer would say they had just been shown. This is the spine the script is',
  '           written against, so make it specific.',
  '  order  — the indices of the kept actions in the order they should PLAY. Usually this is',
  '           source order. Propose a different one only when the best moment was shown last and',
  '           the earlier steps do not set it up. Two limits: a reordering that cannot be replayed',
  '           against the live app is discarded, and nothing may move across a `wait` — a wait is',
  '           the flow waiting for the product to finish, and what follows it depends on that.',
  '',
  'Use the RESOLVED ELEMENT NAME when you reason about a step. The "reason" field is what the agent',
  'was thinking; the element name is what is actually on screen.',
  '',
  'Reply with ONLY a JSON object, no prose and no code fence:',
  '{"about": "...", "order": [0, 2, 3], "decisions": [{"index": 0, "keep": true, "beat": "hook",',
  ' "pace": "normal", "why": "..."}]}',
].join('\n');

/** How a step is shown to the editor: the element it resolved, then the agent's reason. */
function describeStep(step, index) {
  const name = stepName(step);
  const bits = [`${index}. (${step.action})`];
  if (name) bits.push(`element: ${JSON.stringify(name)}`);
  // The VALUE, unless it would leak. The editor needs to know a step types
  // something and roughly what kind of thing; it never needs the secret.
  if (step.action === 'fill' && step.text) {
    bits.push(isSensitive(step) ? 'types: (a secret — withheld)' : `types: ${JSON.stringify(step.text)}`);
  }
  if (!name && step.locator) bits.push(`selector: ${step.locator}`);
  // LAST, and labelled for what it is. The whole point of ENG-5766's "say the
  // real names" is that these two are not interchangeable, so the prompt must
  // not present them as one field.
  if (step.why) bits.push(`agent's reason: ${JSON.stringify(step.why)}`);
  return bits.join('  ');
}

/** The first JSON object in a reply that may be fenced or prefaced. */
function parseReply(raw) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Ask the editor. Returns the raw proposal, or null on any failure so the
 * caller records the flow exactly as discovery found it.
 *
 * Synchronous for the same reason `style.js` is: `run.mjs` calls this from
 * straight-line code between two stages, and the CLI transport is the
 * authenticated one on these machines.
 */
function proposeEdit({ goal, steps }) {
  const listed = (steps ?? []).map(describeStep).join('\n');
  const user = [
    `Demo goal: ${goal || '(not stated)'}`,
    '',
    'Actions the agent performed, in order:',
    listed,
    '',
    `Edit this into a video. Decide for all ${steps?.length ?? 0} action(s).`,
  ].join('\n');
  try {
    const raw = execFileSync(
      'claude',
      ['-p', user, '--output-format', 'json', '--append-system-prompt', SYSTEM, '--strict-mcp-config'],
      { encoding: 'utf8', maxBuffer: 8 << 20, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return parseReply(JSON.parse(raw).result ?? '');
  } catch {
    return null;
  }
}

/** Does this step put something on screen a viewer could be shown? */
const isVisibleAction = (s) => s?.action === 'click' || s?.action === 'fill';

/**
 * Apply an edit proposal to a flow, enforcing everything code can check.
 *
 * PURE — no model call, no I/O — so every invariant below is testable without a
 * transport. `proposeEdit` is the half that cannot be tested that way, and it
 * is deliberately the half that decides nothing on its own.
 *
 * Returns `{ flow, about, plan, cuts, corrections, edited }`:
 *   - `flow`        the edited flow, steps in play order
 *   - `plan`        one entry per kept step, in play order, carrying `beat`,
 *                   `pace`, `why` and `sourceIndex`
 *   - `cuts`        `[{ index, why }]` for everything dropped, so the log, the
 *                   critique and ENG-5762's review surface all have something
 *                   to argue with
 *   - `corrections` what the disposer had to overrule, in words
 *   - `edited`      false when the proposal changed nothing, so the caller can
 *                   skip re-walking a flow it already walked
 *
 * `allowReorder: false` pins play order to source order. `run.mjs` uses it to
 * retry after a reordered flow fails to replay — the reorder is a proposal like
 * any other, and the walk is what disposes of it.
 */
function disposeEdit({ flow, proposal, allowReorder = true }) {
  const steps = flow?.steps ?? [];
  const corrections = [];
  const unedited = { flow, about: null, plan: null, cuts: [], corrections, edited: false };
  if (!proposal || !steps.length) return unedited;

  // TOO SHORT TO EDIT. A three-action flow is already the shortest thing that
  // demonstrates anything, and the interesting failure here is not a bad cut —
  // it is an editor asked to compress what is already compressed, which finds
  // something to remove because it was asked to.
  const sourceActions = steps.filter(isVisibleAction).length;
  if (sourceActions < MIN_EDITABLE) {
    corrections.push(`only ${sourceActions} visible action(s) — too short to edit, kept as discovered`);
    return { ...unedited, about: typeof proposal.about === 'string' ? proposal.about.trim() || null : null };
  }

  const byIndex = new Map();
  for (const d of Array.isArray(proposal.decisions) ? proposal.decisions : []) {
    if (Number.isInteger(d?.index) && d.index >= 0 && d.index < steps.length) byIndex.set(d.index, d);
  }

  // A MISSING DECISION IS A KEEP. The model returning fewer decisions than
  // there are steps is the ordinary ragged-output case `scriptNarration`
  // already handles by index-aligning; here the failure mode is worse, because
  // treating absence as a cut deletes footage nobody decided to delete.
  const missing = steps.map((_, i) => i).filter((i) => !byIndex.has(i));
  if (missing.length) {
    corrections.push(`no decision for step(s) ${missing.join(', ')} — kept`);
  }

  const decisions = steps.map((step, index) => {
    const d = byIndex.get(index);
    let beat = EDITOR_BEATS.includes(d?.beat) ? d.beat : null;
    let pace = PACES.includes(d?.pace) ? d.pace : null;
    if (d && d.beat === 'close') {
      corrections.push(`step ${index}: the closing beat is the appended hold, not a step — treated as build`);
    } else if (d && d.beat != null && !beat) {
      corrections.push(`step ${index}: unknown beat ${JSON.stringify(d.beat)} — treated as build`);
    }
    if (d && d.pace != null && !pace) corrections.push(`step ${index}: unknown pace ${JSON.stringify(d.pace)} — treated as normal`);
    let keep = d ? d.keep !== false : true;
    // A WAIT IS NEVER CUT. It is not an editorial unit — it is how the flow
    // synchronises with the product finishing something, and removing it makes
    // the next step race a result that has not arrived. Its own dead time is
    // already handled, and handled better, by `compress.js`, which speeds a
    // wait's body and keeps only the tail where the result lands.
    if (!keep && step.action === 'wait') {
      corrections.push(`step ${index}: a wait is a synchronisation step, not a beat — kept`);
      keep = true;
    }
    return { index, keep, beat: beat ?? 'build', pace: pace ?? 'normal', why: typeof d?.why === 'string' ? d.why.trim() : '' };
  });

  // NEVER EMPTY THE FLOW, and never cut past "a thin demo". `run.mjs` already
  // refuses to drop every inert step for exactly this reason: on the markdown
  // publisher both discovered steps measured as no-ops, both were dropped, and
  // the run recorded a 3.9s video of a static page that scored 2/10. An edit
  // that cuts everything is an editorial failure to report, not one to apply.
  const keptActions = decisions.filter((d) => d.keep && isVisibleAction(steps[d.index])).length;
  const floor = Math.min(MIN_KEPT_ACTIONS, sourceActions);
  if (keptActions < floor) {
    corrections.push(
      `the edit kept ${keptActions} visible action(s) of ${sourceActions}, below the floor of ${floor} — ` +
        'no cuts applied'
    );
    for (const d of decisions) d.keep = true;
  }

  const kept = decisions.filter((d) => d.keep);
  const cuts = decisions.filter((d) => !d.keep).map((d) => ({ index: d.index, why: d.why || 'not the story' }));

  // ── play order ──────────────────────────────────────────────────────────
  // A proposed order is honoured only for the steps it actually names, and a
  // step it forgot keeps its source position rather than being dropped by
  // omission — the same reason a missing decision is a keep.
  let order = kept.map((d) => d.index);
  let reordered = false;
  if (allowReorder && Array.isArray(proposal.order)) {
    const want = proposal.order.filter((i) => Number.isInteger(i) && order.includes(i));
    const deduped = [...new Set(want)];
    const seen = new Set(deduped);
    const appended = order.filter((i) => !seen.has(i));
    if (appended.length) corrections.push(`the proposed order omitted step(s) ${appended.join(', ')} — appended in source order`);
    const candidate = [...deduped, ...appended];
    // A REORDER MAY NOT CROSS A WAIT, and a wait may not move.
    //
    // The walk was doing all the disposing here, and a walk establishes that
    // the steps still EXECUTE — not that they still mean the same thing. A
    // `wait` is the flow's only record of "this step cannot start until the
    // product has finished"; move the click that starts a generation to after
    // the wait that guards it and the walk is perfectly happy, because the
    // thing being waited for is simply not there yet. The recording then races
    // the result and can end mid-generation.
    //
    // So the dependency waits encode is enforced structurally instead. Within
    // a segment the editor may permute freely, which is the whole capability
    // on a flow with no waits at all; across one it may not, which is exactly
    // where replayability stops implying equivalence.
    const segmentOf = (list) => {
      const seg = new Map();
      let n = 0;
      for (const i of list) {
        seg.set(i, n);
        if (steps[i].action === 'wait') n++;
      }
      return seg;
    };
    const before = segmentOf(order);
    const crossed = candidate.filter((i) => before.get(i) !== segmentOf(candidate).get(i));
    if (crossed.length) {
      corrections.push(
        `the proposed order moves step(s) ${crossed.join(', ')} across a wait — refused, because replaying ` +
          'is not the same as meaning the same thing; playing in source order'
      );
    } else {
      reordered = candidate.some((i, n) => i !== order[n]);
      order = candidate;
    }
  } else if (!allowReorder && Array.isArray(proposal.order)) {
    corrections.push('reordering was refused by the caller — playing in source order');
  }

  // THE DECISION RIDES ON THE STEP, not in a parallel array keyed by index.
  //
  // Two stages downstream of here still remove steps — `curate`'s junk filter
  // and `run.mjs`'s no-op drop — and both use `without()`, which filters
  // `flow.steps` and knows nothing about a sidecar. A plan addressed by index
  // would silently re-point onto the wrong steps the first time either fired,
  // and the symptom would be a payoff hold landing on some other moment: a
  // wrong video that every check passes.
  const planned = order.map((i) => {
    const d = kept.find((k) => k.index === i);
    return { ...steps[i], beat: d.beat, pace: d.pace, editWhy: d.why };
  });
  const settled = settleBeats(planned);
  corrections.push(...settled.corrections);

  return {
    flow: { ...flow, steps: settled.steps },
    about: typeof proposal.about === 'string' ? proposal.about.trim() || null : null,
    plan: settled.steps.map((s, n) => ({ position: n, sourceIndex: order[n], beat: s.beat, pace: s.pace, why: s.editWhy })),
    cuts,
    corrections,
    reordered,
    edited: cuts.length > 0 || reordered,
  };
}

/**
 * Make a beat assignment structurally valid for the order it is actually in.
 *
 * SEPARATE AND RE-RUNNABLE, because "the payoff is last" is a fact about the
 * final step list and the final step list is not settled when `disposeEdit`
 * returns. `curate` drops junk after it, and `run.mjs` drops provable no-ops
 * after that — and the no-op drop can perfectly well remove the step the edit
 * called the payoff. Asserting this once, early, would leave a flow whose
 * payoff had been deleted and whose last step nobody chose to hold.
 *
 * So `run.mjs` calls it again once the step list is final. It is idempotent:
 * on an already-settled list it changes nothing and reports nothing.
 *
 * Steps with no beat at all are left alone — an unedited flow has no beats and
 * must not acquire them here, or a run where the editor failed would quietly
 * gain a structure nobody decided on.
 */
function settleBeats(steps) {
  const out = steps.map((s) => ({ ...s }));
  const corrections = [];
  if (!out.some((s) => s.beat)) return { steps: out, corrections };

  // ── `close` is not a beat the editor gets to assign ─────────────────────
  //
  // In this pipeline nothing the editor can see is a close. The closing beat is
  // the trailing hold `curate.ensureTrailingHold` APPENDS — after this pass has
  // already run — plus the brand outro card, which is composited at publish.
  // So a `close` on a step the editor chose is always a mislabel, and allowing
  // it broke the invariant that matters: the payoff stopped being last, because
  // everything after it was being relabelled `close` instead of the payoff
  // moving to the end.
  //
  // The vocabulary keeps all four (ENG-6306 consumes the beat names), but the
  // only step that may carry `close` is the final one, and it acquires it below
  // rather than claiming it.
  out.forEach((s, n) => {
    if (s.beat === 'close' && n !== out.length - 1) {
      corrections.push(`the step at position ${n} was marked close but is not the end — treated as build`);
      s.beat = 'build';
    }
  });

  // ── exactly one payoff, and it is genuinely last ────────────────────────
  //
  // "Last" is enforced by MOVING the payoff rather than by relabelling what
  // follows it. If the editor called step 2 the payoff and also kept 3 and 4,
  // one of those two judgements is wrong and code cannot tell which — but the
  // one it can act on without discarding work is the beat, because the cuts are
  // the expensive decision and the beat is a label.
  //
  // It is also what the hold depends on: `pacing.js` sizes a hold to the tail
  // `compress.js` protects at 1x, and those two are the same stretch of footage
  // only when the held step is the last one.
  // EXCLUDING THE CLOSE, which on a second call is already sitting on the last
  // step. Taking the last beated step flat would have walked the payoff onto
  // the trailing hold — so `settleBeats` would not have been idempotent, and
  // the payoff would have migrated onto a `wait` the moment `run.mjs` called it
  // again after the drops. That is the one call this function exists for.
  const substantive = out.map((s, n) => (s.beat && s.beat !== 'close' ? n : -1)).filter((n) => n >= 0);
  if (!substantive.length) return { steps: out, corrections };
  const lastBeated = substantive[substantive.length - 1];
  const claimed = out.map((s) => s.beat).lastIndexOf('payoff');
  for (const s of out) if (s.beat === 'payoff') s.beat = 'build';
  const payoff = out[lastBeated];
  if (claimed < 0) {
    corrections.push('no step was marked payoff — the last one plays last, so it is the payoff');
  } else if (claimed !== lastBeated) {
    corrections.push(
      `the payoff was marked at position ${claimed} but ${lastBeated} plays last — moved, and the earlier one is a build`
    );
  }
  payoff.beat = 'payoff';
  // THE PAYOFF IS HELD, whatever pace it arrived with. Not a taste call — it is
  // the one moment the whole edit exists to arrive at, and it is the only thing
  // that makes the beat mean anything on a marketing take, where there is no
  // narration to give the moment length.
  if (payoff.pace !== 'hold') {
    if (payoff.pace === 'hurry') corrections.push('the payoff was marked hurry — held instead');
    payoff.pace = 'hold';
  }

  // The hook is the opening, or there is no hook. A hook in the middle is a
  // mislabel, not a structure.
  out.forEach((s, n) => {
    if (s.beat === 'hook' && n !== 0) {
      corrections.push(`the step at position ${n} was marked hook but does not open — treated as build`);
      s.beat = 'build';
    }
  });

  // ── the trailing hold IS the close ──────────────────────────────────────
  //
  // Every step the edit kept left here with a beat, so an unbeated one in a
  // list that has beats can only have been added afterwards — which is exactly
  // `ensureTrailingHold`'s appended wait. Naming it gives ENG-6306's storyboard
  // its third page from the step list rather than from a special case, and it
  // keeps this function idempotent: on a second call the close is already
  // there, on the last step, so nothing above touches it.
  const tail = out[out.length - 1];
  if (!tail.beat && tail.action === 'wait') tail.beat = 'close';

  return { steps: out, corrections };
}

/**
 * The edit, as the runner prints it.
 *
 * A FUNCTION, not a template literal inlined in `run.mjs`, for the reason
 * `narrate.js` gives for `keepLines`: logic in the runner is logic no test can
 * drive. This one had already earned it — the inline version read
 * `edit.plan.map(...)`, and `plan` is null whenever the flow was too short to
 * edit, which is the commonest shape there is. Every run on a two-action
 * outcome demo would have died in the log line, after the model call and
 * before anything was recorded.
 */
function describeEdit(edit, sourceCount) {
  if (!edit) return ['no edit proposed — recording the flow as discovered'];
  const lines = [];
  if (edit.about) lines.push(`about: ${edit.about}`);
  for (const c of edit.cuts) lines.push(`cut step ${c.index}: ${c.why}`);
  for (const c of edit.corrections) lines.push(`⚠ ${c}`);
  if (!edit.plan) {
    lines.push(`nothing to cut — ${sourceCount} step(s) recorded as discovered`);
    return lines;
  }
  const shape = edit.plan.map((p) => `${p.sourceIndex}:${p.beat}${p.pace === 'normal' ? '' : `/${p.pace}`}`);
  lines.push(`${edit.plan.length} of ${sourceCount} step(s) kept — ${shape.join('  ')}`);
  return lines;
}

module.exports = {
  proposeEdit,
  disposeEdit,
  settleBeats,
  describeEdit,
  describeStep,
  BEATS,
  EDITOR_BEATS,
  PACES,
  MIN_EDITABLE,
  MIN_KEPT_ACTIONS,
};
