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

//: Breathing room after each line before the next step may begin. The
//: reference's value.
const NARRATION_GAP_SEC = 0.3;

//: What to say over a completion wait, when the flow does not supply its own.
const WAIT_LINE = 'Give it a moment — Moda is designing it now.';

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
async function planPacing({ goal, steps, outDir, speak, voice, model }) {
  const none = { spoken: null, conclusion: null, stepMinDurations: null };
  if (!steps.length) return none;

  // The flow's `why` is the action label the script pass reads.
  const asActions = steps.map((s) => ({
    type: s.action === 'press' ? 'key' : s.action,
    label: s.why || s.action,
    text: s.text,
  }));
  const script = await scriptNarration({ goal, steps: asActions });
  if (!script) {
    console.log('  pacing: no script — recording at its own cadence');
    return none;
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
    text: (steps[i]?.narration || (a.type === 'wait' ? WAIT_LINE : null) || script.lines[i] || humanizeAction(a)).trim(),
  }));
  for (const line of spoken) {
    line.wav = path.join(work, `${line.index}.mp3`);
    line.durationSec = speak(line.text, line.wav, voice, model);
  }

  let conclusion = null;
  if (script.conclusion) {
    conclusion = { text: script.conclusion, wav: path.join(work, 'conclusion.mp3') };
    conclusion.durationSec = speak(conclusion.text, conclusion.wav, voice, model);
  }

  const stepMinDurations = spoken.map((l) => (l.durationSec || 0) + NARRATION_GAP_SEC);
  writeFileSync(
    path.join(outDir, 'pacing.json'),
    JSON.stringify({ spoken, conclusion, stepMinDurations, transport: script.transport }, null, 2)
  );
  console.log(
    `  pacing: ${spoken.length} line(s) voiced (${script.transport})` +
      `${conclusion ? ` + a ${conclusion.durationSec.toFixed(1)}s conclusion` : ''} — ` +
      `steps need ${stepMinDurations.map((d) => d.toFixed(1) + 's').join(', ')}`
  );
  for (const l of spoken) console.log(`    ${l.index}. ${l.durationSec.toFixed(2)}s  ${l.text}`);
  return { spoken, conclusion, stepMinDurations };
}

module.exports = { planPacing, NARRATION_GAP_SEC };
