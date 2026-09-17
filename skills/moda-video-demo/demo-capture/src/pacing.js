// Narration-driven pacing — PORTED from the reference's `prepPacing`
// (`~/repos/kleo-autogen-feature-demo/generate.js`).
//
// THE DIRECTION IS THE POINT, and it was inverted here (ENG-5919).
//
// The script is written and SPOKEN before a single frame is recorded, each line
// is measured, and the recorder is told how long each step must last. The video
// is paced to the script. That is what ENG-5761 calls the inversion that makes
// the feature work — "the video is re-paced to fit the voiceover — sync by
// construction rather than by trimming."
//
// `moda-demo` had it the other way round: record first, then squeeze the script's
// word count into whatever gaps the footage happened to leave. That cannot
// produce a natural sentence, because the sentence is not what is being written —
// a word budget is. Measured on a real take, the same three-step demo overran two
// of its three slots by 1.4s and 1.5s with a good script, and the "fix" for that
// was to write worse sentences.
//
// Synthesis happens ONCE. The mp3s and their measured durations are handed to
// `finish.mjs` so the same audio that set the pace is the audio that gets muxed —
// re-synthesizing would pay twice and could drift.
const path = require('node:path');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { scriptNarration, humanizeAction } = require('./narration.js');
const { stepName } = require('./element-name.js');
const { checkInventions } = require('./invention.js');
const { safeText } = require('./sensitive.js');
const { TAIL_KEEP } = require('./compress.js');

//: Breathing room after each line before the next step may begin. The
//: reference's value.
const NARRATION_GAP_SEC = 0.3;

//: How long a step marked `pace: 'hold'` must last, whatever its line measures.
//:
//: This is where the editorial pass's hold-or-hurry actually acts, and it acts
//: as a FLOOR composed `max()` with the line's own length — not as a competing
//: lever. Two levers writing one number is how `chooseStyle` once produced a
//: take paced for a genre `finish` then disagreed with.
//:
//: Sized to `compress.js`'s `TAIL_KEEP` rather than picked. That stage protects
//: the final beat of the cut at 1x and speeds everything else that is idle, so
//: a hold shorter than it is invisible and a hold longer than it has its
//: overhang sped back up. It composes for the case that matters because
//: `disposeEdit` guarantees the payoff is the LAST step: its hold and the
//: protected tail are the same stretch of footage.
//:
//: A mid-flow hold's silent portion IS still compressible, and that is correct
//: rather than a gap — a frozen frame in the middle of a demo with nothing
//: being said over it is the definition of the dead air that stage exists to
//: remove (ENG-6130).
const HOLD_FLOOR_SEC = TAIL_KEEP;

//: What to say over a completion wait, when the flow does not supply its own.
const WAIT_LINE = 'Give it a moment — Moda is designing it now.';

/**
 * The step floors an edit implies on its own, with no narration to measure.
 *
 * A MARKETING take never reaches `planPacing` — `chooseStyle` says the screen
 * speaks for itself, `take.mjs` skips the voiceover, and `stepMinDurations`
 * is null. Without this, `pace: 'hold'` would be a lever that silently does
 * nothing on the genre the reference demos say is the common one: all three in
 * `what-good-looks-like.md` run on music with no voiceover.
 *
 * It is also the genre where the hold matters MOST. There is no narrator to
 * tell you the payoff has landed, so the only thing that says "this is the
 * moment" is how long it stays on screen.
 *
 * Returns null when no step asked to be held, so the caller passes null through
 * and the recorder keeps its own cadence rather than being handed an array of
 * zeroes that reads like a decision.
 */
function paceFloors(steps) {
  if (!(steps ?? []).some((s) => s?.pace === 'hold')) return null;
  return steps.map((s) => (s?.pace === 'hold' ? HOLD_FLOOR_SEC : 0));
}

/**
 * Write and voice the script, then say how long each step needs.
 *
 * `steps` is the FLOW, before anything is recorded: `{ action, locator, why }`.
 * Returns `{ spoken, conclusion, stepMinDurations }` where `stepMinDurations[i]`
 * is the minimum wall-clock seconds step `i` must occupy for its line to land.
 *
 * Returns nulls when there is nothing to pace to, so the caller records at its
 * own natural cadence rather than failing.
 */
async function planPacing({ goal, steps, outDir, speak, voice, model, about = null }) {
  const none = { spoken: null, conclusion: null, stepMinDurations: null };
  if (!steps.length) return none;

  // THE ELEMENT NAME AND THE REASON ARE DIFFERENT FIELDS (ENG-5766).
  //
  // This used to be `label: s.why`, and `why` is `action.reason` from the
  // discovery model — what the agent was thinking, not what is on screen. So
  // the voiceover was written from reasoning while `captions.js` deliberately
  // wrote from the resolved element. Both are passed now, each labelled as what
  // it is, and `narration.js`'s appended prompt tells the writer which one is a
  // fact about the video.
  //
  // `beat` and `pace` ride ON the step, put there by `disposeEdit`. Reading
  // them from a parallel array indexed by position would have gone wrong the
  // first time `curate` or the no-op drop removed a step between the edit and
  // here — see the note in `edit.js` where they are attached.
  //
  // Absent (no edit ran, or it was refused) every step is an unannotated
  // `build`, which is exactly the behaviour before this.
  const asActions = steps.map((s) => ({
    type: s.action === 'press' ? 'key' : s.action,
    label: s.why || s.action,
    name: stepName(s),
    // NULL for a secret, so the value never reaches the script model and
    // `humanizeAction` falls back to "our text" — see `sensitive.js`.
    text: safeText(s),
    beat: s.beat,
    pace: s.pace,
  }));
  const script = await scriptNarration({ goal, steps: asActions, about });
  if (!script) {
    console.log('  pacing: no script — recording at its own cadence');
    return none;
  }

  // DON'T INVENT. A line that quotes a name this flow cannot show is replaced
  // with `humanizeAction`, which names the resolved element and asserts nothing
  // else — plain instead of confidently wrong, which is the trade ENG-5766
  // asks for in those words.
  //
  // The report is printed EVEN WHEN IT FOUND NOTHING, because "no line quoted a
  // name" and "every quoted name checked out" are different results and this
  // package has shipped three checks that could not tell them apart.
  const invented = checkInventions({ lines: script.lines, flow: { steps }, closing: script.conclusion });
  const inventedAt = new Map(invented.inventions.map((i) => [i.index, i.quoted]));
  if (invented.closing) {
    console.log(`  ⚠ the closing line named ${JSON.stringify(invented.closing.quoted)}, which this demo cannot show — dropped`);
  }
  if (invented.inventions.length) {
    console.log(`  ⚠ the script named ${invented.inventions.length} thing(s) this demo cannot show:`);
    for (const i of invented.inventions) console.log(`      line ${i.index}: ${JSON.stringify(i.quoted)} — replaced`);
  } else if (invented.measured) {
    console.log(`  don't-invent: ${invented.checked} quoted name(s) checked, all on screen`);
  } else {
    console.log(`  don't-invent: ${invented.reason}`);
  }

  const work = path.join(outDir, 'vo');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const spoken = asActions.map((a, i) => ({
    index: i,
    // A completion wait gets a PATIENCE line, and it wins over the script: the
    // model is writing about UI actions and has nothing useful to say about a
    // pause. The reference does the same — the wait's own `narration` beats the
    // scripted line. Without it the video sits silent through a generation, which
    // reads as the demo having stalled.
    //
    // A gap anywhere else falls back to a SENTENCE (`humanizeAction`), never a
    // bare label — the reason a degraded run still sounds human.
    //
    // AN INVENTED LINE IS A GAP. `inventedAt` suppresses the script's line for
    // that index so the same `humanizeAction` fallback catches it — the failure
    // is "the model named something that is not there", and the remedy for it
    // is the remedy for "the model said nothing", because both end with a plain
    // sentence built from the resolved element.
    //
    // It is deliberately NOT placed ahead of the two overrides above. Neither
    // came from the model, so neither can have invented anything, and letting a
    // replacement win over the flow author's own `narration` would discard a
    // human's line over a machine's finding.
    text: (
      steps[i]?.narration ||
      (a.type === 'wait' ? WAIT_LINE : null) ||
      (inventedAt.has(i) ? null : script.lines[i]) ||
      humanizeAction(a)
    ).trim(),
  }));
  for (const line of spoken) {
    line.wav = path.join(work, `${line.index}.mp3`);
    line.durationSec = speak(line.text, line.wav, voice, model);
  }

  let conclusion = null;
  // DROPPED, not replaced, when it invents. A step line falls back to
  // `humanizeAction`; a conclusion has no action to build a sentence from, and
  // the pipeline already handles having none — `narrate.js` ties the closing
  // line to a non-empty step set and the mux simply carries one fewer input.
  // Silence on the final beat beats the most quotable sentence in the video
  // being false.
  if (script.conclusion && !invented.closing) {
    conclusion = { text: script.conclusion, wav: path.join(work, 'conclusion.mp3') };
    conclusion.durationSec = speak(conclusion.text, conclusion.wav, voice, model);
  }

  // A FLOOR, composed max() with the line — see `HOLD_FLOOR_SEC`. A `hurry`
  // adds nothing here on purpose: it already acted, upstream, by asking the
  // script for a short line, and a short line is a small floor. Making it
  // subtract as well would let it undercut `capture.mjs`'s `HOLD_AFTER`, which
  // is not slack — it is one term of the beat arithmetic that decides whether
  // the camera chains its punch-ins or drops them.
  const stepMinDurations = spoken.map((l) => {
    const line = (l.durationSec || 0) + NARRATION_GAP_SEC;
    return steps[l.index]?.pace === 'hold' ? Math.max(line, HOLD_FLOOR_SEC) : line;
  });
  writeFileSync(
    path.join(outDir, 'pacing.json'),
    JSON.stringify(
      {
        spoken,
        conclusion,
        stepMinDurations,
        transport: script.transport,
        // The editorial decision the take was recorded under, written down for
        // the same reason `take.mjs` writes `genre.json`: it is a model call,
        // the critique reads the cut afterwards, and two independent answers to
        // one question is how a take got paced for a genre `finish` disagreed
        // with. It is also what ENG-5762's review surface needs to show a human
        // and what ENG-6306's storyboard reads its page structure from.
        about,
        plan: steps.map((s, i) => ({ position: i, beat: s.beat ?? null, pace: s.pace ?? null, why: s.editWhy ?? null })),
        inventions: invented,
      },
      null,
      2
    )
  );
  const held = stepMinDurations.filter(
    (d, i) => steps[i]?.pace === 'hold' && d > (spoken[i].durationSec || 0) + NARRATION_GAP_SEC
  ).length;
  console.log(
    `  pacing: ${spoken.length} line(s) voiced (${script.transport})` +
      `${conclusion ? ` + a ${conclusion.durationSec.toFixed(1)}s conclusion` : ''} — ` +
      `steps need ${stepMinDurations.map((d) => d.toFixed(1) + 's').join(', ')}` +
      (held ? ` (${held} held to the ${HOLD_FLOOR_SEC.toFixed(1)}s floor)` : '')
  );
  for (const l of spoken) {
    const s = steps[l.index];
    const beat = s?.beat ? ` [${s.beat}${s.pace && s.pace !== 'normal' ? `/${s.pace}` : ''}]` : '';
    console.log(`    ${l.index}. ${l.durationSec.toFixed(2)}s${beat}  ${l.text}`);
  }
  return { spoken, conclusion, stepMinDurations };
}

module.exports = { planPacing, paceFloors, NARRATION_GAP_SEC, HOLD_FLOOR_SEC };
