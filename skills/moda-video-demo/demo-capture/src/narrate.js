// Narration: one spoken line per action, placed at that action's window.
//
// The plan on the artifact was "voice it, then RE-PACE the video to the
// voiceover" — the voiceover as master clock. That half is blocked: re-pacing
// mid-clip needs an export scope the public API does not expose (ENG-5833).
//
// So this inverts the dependency. The video is the clock, and the SCRIPT is
// written to fit it. That is a real constraint rather than a workaround: a line
// that does not fit its action's window would either talk over the next step or
// force a rate change we cannot make, so `fit()` measures every line against the
// window it has to live in and reports the ones that do not fit. Shortening a
// line is cheap; stretching the video is blocked.
//
// The audio reaches the export because of a rule that is already settled and
// costs us nothing: `AGENT_VIDEO_FILL_MUTED = false` (utils/markup/videoFills.ts)
// means an agent-authored clip plays and exports with sound, and the server
// executor "muxes audible video-fill audio unconditionally"
// (services/exports/contract.py). So narration muxed onto the RECORDING arrives
// in the exported mp4 with no composition audio clip and no scope parameter.
const { humanizeAction } = require('./narration.js');
const { execFileSync } = require('node:child_process');
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = require('./bin.js');
const { existsSync, mkdirSync, rmSync } = require('node:fs');
const path = require('node:path');

//: Moda's own neural TTS. The first version of this used macOS `say`, which was
//: the right call for proving the MUX — audio reaching the exported mp4 at all —
//: and the wrong thing to leave in. `say` is formant synthesis and sounds it, and
//: no measurement I was taking could see that: "an aac stream exists, peaks at
//: -1.4 dB, aligns to the action timestamps" is all true of a robot.
//: Chosen by listening to the same line across six models, not by picking the
//: first one the model list returned — which is what I did the first time, and
//: it landed on the slowest of the ten. Measured on one sentence:
//: elevenlabs-turbo/Sarah 3.37s, eleven-v3/Will 3.63s, eleven-v3/Rachel 3.87s,
//: minimax 3.88s, xai 4.06s — and inworld/Celeste 6.24s, 70% slower than the
//: rest. That pace, not "TTS is just slow", is why the first cut could only
//: carry two lines instead of three.
const TTS_MODEL = 'elevenlabs-eleven-v3';
const TTS_VOICE = 'Rachel';

//: A beat after the last word before the video stops.
const TAIL_BEAT_SEC = 0.6;

//: Beat between the last step's line and the closing line. The reference's
//: CONCLUSION_GAP of 10 frames at 30fps.
const CONCLUSION_GAP_SEC = 0.33;

//: How much static tail to tolerate before trimming it. Some is a beat to let
//: the result land; a lot is the viewer waiting for a video that has finished.
const TAIL_SLACK_SEC = 0.8;

/**
 * How long the narrated mux should come out, given the footage and the tail
 * adjustment. Exactly one of `tailNeeded` / `tailExcess` is ever non-zero.
 *
 * Separate and exported so the ffmpeg bound and the test assert the SAME
 * arithmetic. A test that recomputes the expected length from its own copy of
 * this expression cannot catch the two drifting apart.
 */
function narratedDurationSec({ clipEnd, tailNeeded, tailExcess }) {
  if (tailNeeded > 0) return clipEnd + tailNeeded;
  if (tailExcess > 0) return clipEnd - tailExcess;
  return clipEnd;
}

// `deriveLine` LIVED HERE and is deleted (ENG-5919). It was a three-branch
// template — `Start in X.` / `Then X.` / `And that's X.` — which made every demo
// read as its own click ledger. It was invented during the port; the reference
// implementation never had it. The real script pass is `src/narration.js`
// (`scriptNarration`), and its gap-filler is `humanizeAction`, which is a
// sentence rather than a label.

/** The accessible name a role selector resolved to, e.g. role=button[name="Create"]. */
function elementName(action) {
  const sel = action.selector || '';
  const m = /name=(?:"([^"]+)"|'([^']+)'|\/([^/]+)\/)/i.exec(sel);
  const raw = m ? (m[1] ?? m[2] ?? m[3]) : '';
  if (raw) return raw.replace(/\\/g, '').trim();
  // No selector (a keypress, a coordinate-only click): fall back to the label,
  // spoken as written rather than wrapped in a template that would double a verb.
  return (action.label || '').trim();
}

/** Render one line and return its measured duration in seconds. */
function speak(text, out, voice, model) {
  execFileSync('moda', ['media', 'generate-audio', '--mode', 'text_to_speech',
    '--model', model, '--voice', voice, '--prompt', text, '-o', out, '--json'],
    { encoding: 'utf8', maxBuffer: 32 << 20 });
  if (!existsSync(out)) throw new Error(`TTS produced no file for ${JSON.stringify(text)}`);
  return +execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', out]).toString().trim();
}

/**
 * Does each line fit the window it is placed in?
 *
 * Reported rather than enforced: a line that overruns still gets spoken, it just
 * runs into the next step. The number is the thing to act on — it is the direct
 * measure of whether the script matches the footage.
 */
function fit(lines, clipDurationSec) {
  // The budget is until the NEXT LINE starts, not until this line's own action
  // ends. The constraint is that two lines must not overlap — a line may run on
  // over the following moments of footage, and the last line has the clip's
  // trailing hold to finish in.
  //
  // Measuring against the action window instead reported the closing line of a
  // real take as overrunning by 1.03s when it had 4.7s of clip left. A metric
  // that cries wolf gets ignored, which is worse than not measuring.
  return lines.map((l, i) => {
    const until = i + 1 < lines.length ? lines[i + 1].startSec : clipDurationSec;
    const budget = Math.max(0, until - l.startSec);
    return { index: i, text: l.text, spokenSec: +l.durationSec.toFixed(2), budgetSec: +budget.toFixed(2),
             fits: l.durationSec <= budget + 0.15, overrunSec: +Math.max(0, l.durationSec - budget).toFixed(2) };
  });
}

/**
 * Narrate a clip: write the lines, speak them, mux them onto the recording at
 * each action's start, and return the new mp4 plus the fit report.
 */
/**
 * Render the lines and MEASURE them, without touching the video yet.
 *
 * Split from the mux because idle-gap compression needs to know where narration
 * sits — a line spoken over a sped-up gap is talking about something the viewer
 * has already flashed past — and compression then MOVES those positions. So the
 * order is: plan (here) -> compress -> mux at the rebased times.
 */
function planNarration({ clip, outDir, voice = TTS_VOICE, model = TTS_MODEL, lines: given, preVoiced, preVoicedConclusion }) {
  // The take was PACED to this audio, so it is the audio that must be muxed.
  // Re-synthesizing would pay the TTS bill twice and, worse, a second script
  // pass returns different sentences — the recording would then be paced to
  // lines nobody hears. Also note the `rmSync` below: without this branch,
  // finish would delete the very mp3s the capture was timed against.
  //
  // AN EMPTY ARRAY IS AN ANSWER, not a missing one. `?.length` treated "the
  // narration stage dropped every line" identically to "this take has no
  // pre-voiced record", so the last drop fell through to the synthesis path
  // below: fresh `speak()` calls for every action — a second, metered TTS bill
  // — sentences the recording was never paced to, and an `rmSync` that deletes
  // the cached audio the take WAS paced to. The requested removal then undid
  // itself, loudly and expensively (ENG-6137).
  //: THE CONCLUSION GOES WITH THEM, deliberately. The closing line is not
  //: droppable — the loop only names step lines by `actionIndex`, and the
  //: conclusion's is null — but the pre-voiced branch below already ties it to a
  //: non-empty step set (`preVoicedConclusion?.wav && spoken.length`), so a take
  //: with no step lines has never carried one. Reaching this at all needs every
  //: step line dropped, which needs a short take and several narration rounds.
  //:
  //: An ARRAY, matching what both branches below return — `finish.mjs` uses the
  //: result as `planned.length` / `planned.map`, so an object here would throw
  //: on the one path this guard exists to make safe.
  if (Array.isArray(preVoiced) && preVoiced.length === 0) return [];
  if (preVoiced?.length) {
    const spoken = preVoiced
      .map((l) => {
        const a = clip.actions[l.index];
        if (!a) return null;
        return {
          text: l.text,
          wav: l.wav,
          durationSec: l.durationSec,
          startSec: l.index === 0 ? (a.moveStartSec ?? a.startSec) : (a.clickSec ?? a.startSec),
          actionIndex: l.index,
        };
      })
      .filter((l) => l && l.text);
    spoken.sort((a, b) => a.startSec - b.startSec);
    if (preVoicedConclusion?.wav && spoken.length) {
      // The closing line starts right after the last step line, FILLING the
      // final-state tail, rather than waiting for the outro card. The reference
      // is explicit about why: waiting leaves a silent gap on a static screen,
      // which reads as the demo having ended twice.
      //
      // It needs no special case downstream. The mux already freezes the final
      // frame for a closing line that overruns the footage, so appending the
      // conclusion as the last spoken line gets exactly that behaviour for free.
      const lastEnd = Math.max(...spoken.map((l) => l.startSec + (l.durationSec || 0)));
      spoken.push({
        text: preVoicedConclusion.text,
        wav: preVoicedConclusion.wav,
        durationSec: preVoicedConclusion.durationSec,
        startSec: lastEnd + CONCLUSION_GAP_SEC,
        actionIndex: null,
        isConclusion: true,
      });
    }
    return spoken;
  }

  const spoken = clip.actions.map((a, i) => ({
    // A gap in the script falls back to a SENTENCE, never a label.
    text: (given?.[i] || humanizeAction(a)).trim(),
    // The OPENING line leads its action; every later line lands on the click.
    //
    // Both halves were found by watching, one after the other. Placed at the
    // action's start, a line describing a result ran ahead of it — "the voiceover
    // describing the MCP and CLI tab starts before the tab is clicked". Moved to
    // the click, the opening line then ran late — "begins slightly after the user
    // avatar is clicked". They are different jobs: the first line orients you
    // before anything happens, the rest confirm what just did.
    startSec: i === 0 ? (a.moveStartSec ?? a.startSec) : (a.clickSec ?? a.startSec),
    actionIndex: i,
  })).filter((l) => l.text);
  if (!spoken.length) return [];
  spoken.sort((a, b) => a.startSec - b.startSec);

  const work = path.join(outDir, 'vo');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  for (const [i, line] of spoken.entries()) {
    line.wav = path.join(work, `${i}.mp3`);
    line.durationSec = speak(line.text, line.wav, voice, model);
  }
  return spoken;
}

function narrate({ clip, mp4, outDir, id, voice = TTS_VOICE, model = TTS_MODEL, lines: given, planned }) {
  const spoken = planned ?? planNarration({ clip, outDir, voice, model, lines: given });
  if (!spoken.length) return { mp4, narrated: false, report: [], reason: 'no action produced a line' };

  // One input per line, each delayed to its action's start, summed and muxed
  // over the (silent) recording.
  //
  // `normalize=0` and NO per-input gain. amix's default normalization divides by
  // the input count, so the obvious compensation is to multiply each input by it
  // — but that is not unity in practice: measured, a source peaking at -1.4 dB
  // came out of the export at 0.0 dB, i.e. clipped. The lines never overlap
  // (`fit` is what guarantees that), so an un-normalized SUM is exactly the
  // original level with no fudge factor to get wrong.
  // A CLOSING line may run past the end of the footage, and that is the one
  // overrun worth fixing rather than editing around: the last thing said is
  // usually the point of the demo, and cutting it off mid-word is worse than
  // holding on the result a moment longer. Freezing the final frame is not a
  // re-pace — no rate changes, nothing mid-clip moves — so it needs none of the
  // export machinery that blocks real re-pacing.
  //
  // Mid-clip lines get no such help: inserting time between two actions IS a
  // re-pace, so those still have to fit, and `fit` still reports them.
  const last = spoken[spoken.length - 1];
  const clipEnd = clip.durationSec;
  const wantEnd = last.startSec + last.durationSec + TAIL_BEAT_SEC;
  const tailNeeded = Math.max(0, wantEnd - clipEnd);
  // And the reverse: a tail that runs on well past the last word is dead air on
  // a static screen. Also caught by watching — "a slight pause of about 5 seconds
  // at the end on a static screen after the objective has been reached".
  const tailExcess = Math.max(0, clipEnd - wantEnd - TAIL_SLACK_SEC);

  const out = path.join(outDir, `${id}.narrated.mp4`);
  const inputs = spoken.flatMap((l) => ['-i', l.wav]);
  const delays = spoken.map((l, i) =>
    `[${i + 1}:a]adelay=${Math.round(l.startSec * 1000)}|${Math.round(l.startSec * 1000)}[a${i}]`
  ).join(';');
  const mixIn = spoken.map((_, i) => `[a${i}]`).join('');
  // `tpad` clones the final frame so a closing line lands instead of being cut
  // off mid-word. Not a re-pace: nothing mid-clip changes rate, so this needs
  // none of the export machinery that blocks real re-pacing.
  const vFilter = tailNeeded > 0
    ? `[0:v]tpad=stop_mode=clone:stop_duration=${tailNeeded.toFixed(3)}[v]`
    : tailExcess > 0
      ? `[0:v]trim=end=${(clipEnd - tailExcess).toFixed(3)},setpts=PTS-STARTPTS[v]`
      : null;
  // How long this mux is supposed to be. Both the padding and a hard `-t` are
  // pinned to it, because `-shortest` ALONE DOES NOT BOUND THIS GRAPH.
  //
  // Bare `apad` is an infinite audio stream, and inside a filter_complex the
  // muxer keeps pulling it after the video has ended. Measured on a 24.8s take
  // whose source mp4 is 430 KB: ffmpeg sat at 99.7% CPU for over ten minutes and
  // wrote a 137 MB file before dying on "Error writing trailer: Cannot allocate
  // memory". Nothing downstream ran, so from outside it read as a slow stage
  // rather than a hang — there is no timeout on this call.
  //
  // `whole_dur` ends the padding; `-t` is the hard stop if it ever does not.
  const outDurSec = narratedDurationSec({ clipEnd, tailNeeded, tailExcess });
  execFileSync(FFMPEG, ['-v', 'error', '-i', mp4, ...inputs,
    // `duration=longest` then `apad`, NOT `duration=first`. `first` ends the mix
    // when the FIRST delayed line finishes, and with `-shortest` that truncates
    // the VIDEO to it: measured, a 10.07s take came out at 3.22s — a third of the
    // demo, silently, with a perfectly valid audio track. `apad` then keeps the
    // audio at least as long as the video, bounded by `whole_dur`.
    '-filter_complex',
    `${vFilter ? vFilter + ';' : ''}${delays};${mixIn}amix=inputs=${spoken.length}:duration=longest:normalize=0,apad=whole_dur=${outDurSec.toFixed(3)}[aout]`,
    '-map', vFilter ? '[v]' : '0:v', '-map', '[aout]',
    // A copy when there is no tail; tpad has to re-encode, so it only pays that
    // cost when the closing line actually needs the room.
    ...(vFilter ? ['-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p'] : ['-c:v', 'copy']),
    '-c:a', 'aac', '-b:a', '128k', '-t', outDurSec.toFixed(3), '-shortest', out, '-y']);
  if (!existsSync(out)) throw new Error('ffmpeg produced no narrated file');
  // VERIFY the tail landed rather than trusting the flag. An earlier version
  // computed `tailNeeded`, reported it, and fed it to `fit()` — while the ffmpeg
  // patch had silently not applied, so every line "fitted" a tail that did not
  // exist. The report measured the intention, not the artifact.
  const actualSec = +execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', out]).toString().trim();
  // The SAME value `-t` and `apad=whole_dur` were given. This used to recompute
  // the expression inline, which happens to agree today but is the third copy of
  // arithmetic the helper exists to hold: change the helper and this check would
  // still expect the old length, failing every narrated cut with a message that
  // blames ffmpeg.
  const wantSec = outDurSec;
  if (Math.abs(actualSec - wantSec) > 0.25) {
    throw new Error(`narrated cut is ${actualSec.toFixed(2)}s but should be ${wantSec.toFixed(2)}s ` +
      `(clip ${clipEnd.toFixed(2)} + tail ${tailNeeded.toFixed(2)}) — the mux did not do what the report claims`);
  }

  return { mp4: out, narrated: true, tailSec: +tailNeeded.toFixed(2),
           durationSec: actualSec, report: fit(spoken, actualSec), lines: spoken.map((l) => l.text) };
}

/**
 * The pre-voiced lines that survive a drop, by ACTION INDEX.
 *
 * A FUNCTION, not a filter inlined in `finish.mjs`, so a test can drive the
 * drop instead of grepping for it — the guard this replaces asserted a string
 * appeared in a condition, and stayed green through the entire period the fix
 * it named could not act (ENG-6137).
 *
 * Keyed by `index`, which is what `pacing.spoken` carries and what the finding
 * names. A positional filter would drift the moment one line is already gone.
 * `spec` is the raw `DEMO_DROP_LINES` value: absent, empty and malformed all
 * mean "drop nothing", because a re-cut that silently dropped a line nobody
 * asked for is worse than one that drops none.
 */
function keepLines(spoken, spec) {
  // EMPTY SEGMENTS FIRST. `Number('') === 0`, so splitting an empty spec yields
  // `['']` -> `[0]` and the "drop nothing" case silently drops action 0 — and
  // `iterate.mjs` sends an empty spec on every ordinary re-cut, so that is the
  // first narration line of every take, deleted by a pacing bump.
  const dropped = new Set(
    String(spec ?? '').split(',')
      .map((n) => n.trim())
      .filter((n) => n !== '')
      .map(Number)
      .filter(Number.isInteger)
  );
  if (!Array.isArray(spoken)) return { kept: null, dropped: [] };
  return {
    kept: spoken.filter((l) => !dropped.has(l.index)),
    dropped: spoken.filter((l) => dropped.has(l.index)).map((l) => l.index),
  };
}

/**
 * The narration record written beside a take, as the critique reads it back.
 *
 * `keptLines` is the pre-voiced set the drop actually filters — `null` when the
 * take had no `pacing.json`. The SYNTHESIS branch also stamps an `actionIndex`,
 * but `DEMO_DROP_LINES` filters `pacing.spoken`, which a scriptless take does
 * not have, so a drop there is inert and the whole script is re-synthesized
 * anyway. Writing the index regardless raised a finding whose remedy could not
 * move it: one metered re-cut, counted as work, keeping the round alive — the
 * shape ENG-6130 and ENG-6137 exist to remove. Unnameable is not actionable.
 */
function narrationRecord(planned, keptLines) {
  return (planned ?? []).map((l) => ({
    startSec: l.startSec,
    durationSec: l.durationSec,
    actionIndex: keptLines ? (l.actionIndex ?? null) : null,
  }));
}

module.exports = { narrate, planNarration, keepLines, narrationRecord, elementName, speak, narratedDurationSec, TTS_MODEL, TTS_VOICE };
