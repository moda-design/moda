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
const { existsSync } = require('node:fs');
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

  // `shortest` on the MIX so a longer bed is cut to the video, and `apad` on the
  // voice side so a video longer than the voice is still covered.
  const hasVoice = hasAudio(mp4);
  const graph = hasVoice
    ? `${bedChain};[0:a]apad[voice];[voice][bed]amix=inputs=2:duration=first:normalize=0[aout]`
    : `${bedChain};[bed]anull[aout]`;

  execFileSync(FFMPEG, ['-v', 'error', '-i', mp4, '-i', bed, '-filter_complex', graph,
    '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
    '-shortest', out, '-y'], { maxBuffer: 64 << 20 });
  if (!existsSync(out)) throw new Error('scoring produced no file');
  return out;
}

function dbToGain(db) {
  return (10 ** (db / 20)).toFixed(4);
}

function hasAudio(file) {
  const streams = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=index', '-of', 'csv=p=0', file]).toString().trim();
  return streams.length > 0;
}

module.exports = { generateBed, addMusicBed, BED_GAIN_DB, DUCK_GAIN_DB };
