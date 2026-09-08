// A music bed under the whole demo.
//
// Unanimous across three published demos, measured: music from the first frame,
// continuous, never ducking, and the analysis of one says outright that it is
// what carries the pacing. Ours had none, which is a large part of why a correct
// video still felt like a screencast rather than something you would publish.
//
// Generated per demo rather than shipped as a fixed asset: the references match
// tempo to content — upbeat electronic for a feature tour, lo-fi for a quiet
// integration clip — and a prompt is the natural place for that choice.
const { execFileSync } = require('node:child_process');
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = require('./bin.js');
const { existsSync, renameSync, rmSync } = require('node:fs');
const path = require('node:path');

const MUSIC_MODEL = 'elevenlabs-music';

//: Under the voice, not beside it. A bed that competes is worse than no bed, and
//: the references never duck — they simply sit low enough not to need to.
const BED_GAIN_DB = -22;
//: Narration is the one thing that must stay intelligible; where they overlap the
//: bed steps down further. The references have no voiceover to duck FOR, so this
//: has no reference value behind it — it is the honest cost of keeping both.
const DUCK_GAIN_DB = -30;

/** Generate a bed at least `seconds` long. */
function generateBed({ outDir, seconds, mood = 'calm, modern, understated product-demo underscore; no vocals' }) {
  const out = path.join(outDir, 'bed.mp3');
  execFileSync('moda', ['media', 'generate-audio', '--mode', 'text_to_music',
    '--model', MUSIC_MODEL, '--prompt', mood,
    // Ask for a little more than the clip: trimming is free, looping is audible.
    '--duration', String(Math.ceil(seconds + 3)), '-o', out, '--json'],
    { encoding: 'utf8', maxBuffer: 32 << 20 });
  if (!existsSync(out)) throw new Error('music generation produced no file');
  return out;
}

/**
 * Mix a bed under `mp4` (which may already carry narration) and return the path.
 *
 * `narrationSpans` are where the bed ducks. Passing none is the reference
 * behaviour — a flat bed under a silent demo.
 */
function addMusicBed({ mp4, outDir, id, bed, narrationSpans = [] }) {
  const out = path.join(outDir, `${id}.scored.mp4`);
  const duck = narrationSpans
    .map((n) => `between(t,${n.startSec.toFixed(2)},${(n.startSec + n.durationSec).toFixed(2)})`)
    .join('+');
  // A single volume expression rather than sidechain compression: the spans are
  // known exactly, so there is nothing to detect.
  const bedChain = duck
    ? `[1:a]volume='if(${duck},${dbToGain(DUCK_GAIN_DB)},${dbToGain(BED_GAIN_DB)})':eval=frame[bed]`
    : `[1:a]volume=${dbToGain(BED_GAIN_DB)}[bed]`;

  // `-t` caps the mix so a longer bed is cut to the video, and a BOUNDED `apad`
  // on the voice side so a video longer than the voice is still covered.
  //
  // The pad is bounded for the reason spelled out in narrate.js: a bare `apad`
  // is an infinite stream, `duration=first` then makes that infinite stream the
  // one controlling the mix, and `-shortest` does not reliably stop a
  // filter_complex graph. Today the video is `-c:v copy` from input 0, so there
  // is a finite stream to bound against and this has not bitten — but that is
  // luck, and narrate.js hung on exactly this shape the moment its video side
  // became a filter output. `whole_dur` plus `-t` makes it not depend on luck.
  const videoSec = durationOf(mp4);
  const hasVoice = hasAudio(mp4);
  const graph = hasVoice
    ? `${bedChain};[0:a]apad=whole_dur=${videoSec.toFixed(3)}[voice];[voice][bed]amix=inputs=2:duration=first:normalize=0[aout]`
    : `${bedChain};[bed]anull[aout]`;

  // NO `-shortest`. `-t` already caps this output, and `-shortest` is the one
  // flag here that can make the scored cut shorter than the PICTURE. On the
  // no-voice path the only audio is the bed, and nothing checks that the model
  // returned the length we asked for — so a short bed would end the encode
  // early and silently cut the payoff frames off the end. `finish.mjs` prefers
  // `.scored.mp4` and publish takes the most finished file, so that truncated
  // cut is what would ship, with "scored" printed as success. Without the flag a
  // short bed leaves silence under the tail instead, which is merely quiet.
  // Encode to a STAGING path and only become `.scored.mp4` once verified.
  //
  // Rejecting a cut is not enough on its own: `finish.mjs` catches this throw and
  // carries on, and both its final-cut choice and `publish-take.mjs` prefer
  // `.scored.mp4` because it EXISTS. A rejected file left on disk is therefore
  // still the file that ships — the failure mode this whole tool keeps
  // relearning, where a fallback landing on a file that exists looks exactly
  // like success. Renaming last means the name never refers to unverified bytes.
  const staged = `${out}.staging.mp4`;
  try {
    execFileSync(FFMPEG, ['-v', 'error', '-i', mp4, '-i', bed, '-filter_complex', graph,
      '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
      '-t', videoSec.toFixed(3), staged, '-y'], { maxBuffer: 64 << 20 });
    if (!existsSync(staged)) throw new Error('scoring produced no file');
    // Same verification narrate.js does, for the same reason: the length is the
    // one property a silently wrong mux still looks correct without. A probe
    // that throws counts as a failure too — hence inside the try.
    const actualSec = durationOf(staged);
    if (Math.abs(actualSec - videoSec) > 0.25) {
      throw new Error(`scored cut is ${actualSec.toFixed(2)}s but the picture is ${videoSec.toFixed(2)}s ` +
        `— the music mux changed the length`);
    }
  } catch (e) {
    rmSync(staged, { force: true });
    throw e;
  }
  renameSync(staged, out);
  return out;
}

function dbToGain(db) {
  return (10 ** (db / 20)).toFixed(4);
}

/** The video's length — what the mixed audio has to be bounded to. */
function durationOf(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', file]).toString().trim();
  const sec = Number(out);
  if (!Number.isFinite(sec) || sec <= 0) throw new Error(`could not read a duration from ${file} (got "${out}")`);
  return sec;
}

function hasAudio(file) {
  const streams = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=index', '-of', 'csv=p=0', file]).toString().trim();
  return streams.length > 0;
}

module.exports = { generateBed, addMusicBed, BED_GAIN_DB, DUCK_GAIN_DB };
