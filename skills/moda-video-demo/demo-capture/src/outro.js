// A branded closing card: logo, tagline, URL.
//
// Unanimous across three published demos — every one ends on a logo and a call
// to action, 5 to 9 seconds. It is also the one piece of the intro/outro
// question that is NOT a design decision: two of the three open cold on the
// product, but all three close this way.
//
// COMPOSITED INTO THE VIDEO, not built as canvas nodes — and that is a
// concession, recorded here so the next person does not repeat the attempt.
//
// The canvas route is the right one on paper: "a live canvas you can keep
// editing" is the offer, so the card should be an image and two text nodes with
// opacity tracks, exactly like the captions. Three attempts did not render. What
// came back from the read-back: the `<image>` became a 79x79 SQUARE rectangle
// with a pattern fill instead of the 282x79 asked for, the tagline text node was
// missing from the scene entirely, and only two of the nodes received their
// opacity tracks — so the card was invisible at every point in the clip while
// every command reported success.
//
// That is markup-and-motion behaviour worth fixing at the source, in
// `canvas_compiler`, as a real outro feature with tests — not worked around by
// appending markup from a pipeline. Until then the card is composited, which
// costs editability and is the honest trade for a card that actually appears.
const { execFileSync } = require('node:child_process');
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = require('./bin.js');
const { readFileSync } = require('node:fs');
const path = require('node:path');

//: The references hold their card for 5-9s — but on videos of 29s, 72s and
//: 119s, which is 17%, 8% and 8% of the runtime. Copying the SECONDS onto a
//: 10-second demo copies the wrong thing: 4s of static card on a 10s demo is
//: 28% of the video, and it reads as padding rather than as a sign-off.
//:
//: So take the proportion and floor it at what the card takes to READ. A
//: tagline and a URL is about two seconds of reading, and the fade eats 0.4 of
//: whatever it gets.
const OUTRO_MIN_SEC = 2.5;
const OUTRO_MAX_SEC = 5.0;
const OUTRO_SHARE = 0.2;
//: How long the card lingers after the closing line finishes.
const OUTRO_TAIL_BEAT_SEC = 1.5;
const FADE_SEC = 0.4;

/** How long the card should hold for a clip of `clipSec`. */
function outroSeconds(clipSec) {
  return Math.min(OUTRO_MAX_SEC, Math.max(OUTRO_MIN_SEC, +(clipSec * OUTRO_SHARE).toFixed(2)));
}

/** Pull the pieces of the kit the card needs. Returns null if the kit has none. */
function brandCard(brandId) {
  const raw = execFileSync('moda', ['brand', 'show', brandId, '--json'], { encoding: 'utf8', maxBuffer: 32 << 20 });
  const kit = JSON.parse(raw.trim().split('\n').filter((l) => l.startsWith('{')).pop()).brand_kit;
  // A kit carries a palette per MODE, so a flat label lookup keeps whichever
  // came last — which silently returned the dark-mode value and inverted the
  // card. Scoped to the kit's own default.
  const mode = kit.default_color_mode || 'light';
  const byLabel = Object.fromEntries(
    (kit.colors || []).filter((c) => (c.mode || mode) === mode).map((c) => [c.label, c.color])
  );

  // The LOGO decides the ground, not the other way round. This kit ships only
  // "Logo (Dark)" — a dark-coloured mark — so a card on the inverted ground would
  // have a hole where the logo is. Pick the mark, then a ground it shows on.
  const logos = (kit.logos || []).flatMap((g) => g.images || []);
  const wordmark = logos.filter((l) => !/icon/i.test(l.name));
  const logo = wordmark[0] || logos[0] || null;
  const logoIsDark = logo ? /dark/i.test(logo.name) : true;
  return {
    background: logoIsDark ? byLabel['bg-primary'] || '#ffffff' : byLabel['bg-inverted'] || '#0a090a',
    ink: logoIsDark ? byLabel['text-primary'] || '#0a090a' : byLabel['bg-primary'] || '#ffffff',
    logoUrl: logo ? logo.url : null,
    tagline: kit.tagline || '',
    url: (kit.company_url || '').replace(/^https?:\/\//, ''),
    font: ((kit.fonts || []).find((f) => f.label === 'display' && f.supported)
        || (kit.fonts || []).find((f) => f.label === 'heading' && f.supported) || {}).family,
  };
}

//: The card is rendered as a PAGE and screenshotted, not drawn by ffmpeg.
//:
//: ffmpeg was the obvious tool and this build has no `drawtext` at all — no
//: libfreetype, so "No such filter". Playwright is already a dependency for the
//: capture, and it is the better instrument anyway: the kit names a real font
//: ("DM Serif Display") which a browser can fetch from Google Fonts and ffmpeg
//: could never have, and centring two lines of type is what a layout engine is
//: for.

/** Download the kit's mark once so ffmpeg can overlay it. */
function fetchLogo(url, outDir) {
  const out = path.join(outDir, 'logo.png');
  execFileSync('curl', ['-sL', '-o', out, url], { maxBuffer: 32 << 20 });
  return out;
}

/**
 * Extend the tail and composite the card onto it.
 *
 * One ffmpeg pass: pad with the brand ground, overlay the mark, draw the tagline
 * and the URL, all gated to the tail with `enable=`. The audio is padded to
 * match so the bed carries under the card rather than stopping dead on it.
 */
async function renderCard({ card, outDir, width, height }) {
  const { chromium } = require('playwright');
  // INLINED, not a file:// src. `setContent` gives the page an about:blank
  // origin, so a file:// image is blocked and renders as a broken-image icon —
  // which is exactly what the first card did, with everything else correct.
  const logoPath = card.logoUrl ? fetchLogo(card.logoUrl, outDir) : null;
  const logo = logoPath
    ? `data:image/png;base64,${readFileSync(logoPath).toString('base64')}`
    : null;
  const font = card.font || 'Georgia';
  const html = `<!doctype html><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}:wght@400&display=swap">
<style>
  html,body{margin:0;height:100%}
  body{background:${card.background};color:${card.ink};
       display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;
       font-family:'${font}',Georgia,serif;-webkit-font-smoothing:antialiased}
  img{width:96px;height:96px;object-fit:contain}
  .tagline{font-size:46px;letter-spacing:-0.01em}
  .url{font-size:22px;opacity:.62;font-family:Inter,-apple-system,sans-serif;letter-spacing:.02em}
</style>
${logo ? `<img src="${logo}">` : ''}
${card.tagline ? `<div class="tagline">${card.tagline}</div>` : ''}
${card.url ? `<div class="url">${card.url}</div>` : ''}`;
  const out = path.join(outDir, 'outro-card.png');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'load' });
  // Webfonts arrive after load; screenshotting first bakes the fallback.
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

async function compositeOutro({ mp4, outDir, id, card, seconds, startAtSec }) {
  const out = path.join(outDir, `${id}.with-outro.mp4`);
  const colour = `0x${card.background.replace('#', '')}`;
  const clipSec = +execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', mp4]).toString().trim();
  // The card comes up when the FOOTAGE ends, not when the file does. They
  // differ whenever a closing line extended the clip, and the difference is
  // frozen app pixels — the worst thing to land the last sentence on.
  const cardAt = Math.min(clipSec, startAtSec ?? clipSec);
  const covered = clipSec - cardAt;
  // When the card comes up early it is ALREADY on screen for the whole closing
  // line, so it needs a beat after the last word, not a second full outro on
  // top. Adding `outroSeconds` to the coverage put the card up for 12.7s of a
  // 32.6s video — the sign-off outstaying the demo.
  const hold = seconds ?? (covered > 0 ? covered + OUTRO_TAIL_BEAT_SEC : outroSeconds(clipSec));
  const from = cardAt.toFixed(2);
  // What the FILE grows by (the card's hold beyond the existing footage) —
  // which is what the canvas page duration must grow by too.
  const grow = +Math.max(0, hold - covered).toFixed(2);
  const ink = card.ink.replace('#', '0x');
  const esc = (t) => t.replace(/[\\':]/g, (m) => '\\' + m);

  const size = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', mp4]).toString().trim().split(',');
  const cardPng = await renderCard({ card, outDir, width: +size[0], height: +size[1] });

  // ASK WHETHER THERE IS AUDIO. The graph referenced `[0:a]` unconditionally,
  // which is right for the scored and narrated cuts — both carry a track — and
  // wrong for the silent one, where ffmpeg fails on a stream that is not there.
  const hasAudio = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=index', '-of', 'csv=p=0', mp4]).toString().trim().length > 0;

  // One still, held for the tail, cross-faded in over `FADE_SEC`.
  const graph =
    `[0:v]tpad=stop_mode=clone:stop_duration=${grow}[base];` +
    `[1:v]scale=${size[0]}:${size[1]},format=rgba,` +
    `fade=t=in:st=${from}:d=${FADE_SEC}:alpha=1[card];` +
    `[base][card]overlay=0:0:enable='gte(t,${from})'[v]` +
    (hasAudio ? `;[0:a]apad=pad_dur=${grow}[a]` : '');
  execFileSync(FFMPEG, ['-v', 'error', '-i', mp4, '-loop', '1', '-i', cardPng,
    '-filter_complex', graph, '-map', '[v]',
    ...(hasAudio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '160k'] : []),
    '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
    // BOUND THE OUTPUT EXPLICITLY. `-shortest` was doing that job, but only
    // because the audio track was the shortest stream — the card is a `-loop 1`
    // still, i.e. an infinite input. Drop the audio (the silent cut has none)
    // and `-shortest` has nothing finite left to stop at, and ffmpeg runs
    // forever. Found by testing the branch the audio fix had just created.
    '-t', String((clipSec + +grow).toFixed(3)),
    '-shortest', out, '-y'], { maxBuffer: 64 << 20 });

  // MEASURE THE RESULT, do not report the request. `grow` is what was asked
  // for; `-shortest` and the pad can land somewhere else, and publish-take
  // writes this number straight into the canvas page duration — so a video and
  // a page that disagree is a demo whose last seconds are cut or blank. The two
  // ffprobes above already treat this file as something to interrogate rather
  // than assume; this one was the exception.
  const actual = +execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', out]).toString().trim();
  const grew = actual - clipSec;
  if (!Number.isFinite(actual) || grew <= 0) {
    throw new Error(`the outro composite produced ${actual}s from a ${clipSec}s clip — the card did not land`);
  }
  return { path: out, seconds: grew, cardAt };
}

/** Extend the recording with solid brand-coloured frames for the card to sit on. */
function extendTail({ mp4, outDir, id, background, seconds = OUTRO_MIN_SEC }) {
  const out = path.join(outDir, `${id}.with-outro.mp4`);
  const colour = `0x${background.replace('#', '')}`;
  execFileSync(FFMPEG, ['-v', 'error', '-i', mp4,
    '-filter_complex', `[0:v]tpad=stop_mode=add:stop_duration=${seconds}:color=${colour}[v];[0:a]apad=pad_dur=${seconds}[a]`,
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', out, '-y'], { maxBuffer: 64 << 20 });
  return out;
}

/** Markup for the card, full-bleed over the clip. */
function outroMarkup({ card, width, height }) {
  const cx = Math.round(width / 2);
  const lines = [`<content padding="0">`];
  // NO full-bleed plate. The extended tail is already the brand ground, so a
  // plate only duplicates it — and it landed ON TOP of the logo and text, which
  // is why the first cut ended on four seconds of blank white with the card's
  // own nodes hidden behind it.
  if (card.logoUrl) {
    const w = Math.round(width * 0.22);
    lines.push(
      `  <image name="Outro logo" src="${card.logoUrl}" fit="contain" ` +
        `x="${cx - Math.round(w / 2)}" y="${Math.round(height * 0.34)}" width="${w}" height="${Math.round(w * 0.28)}" />`
    );
  }
  if (card.tagline) {
    lines.push(
      `  <text name="Outro tagline" x="0" y="${Math.round(height * 0.52)}" width="${width}" height="56" ` +
        `text-align="center" vertical-align="middle" font-size="34"` +
        `${card.font ? ` font-family="${card.font}"` : ''} color="${card.ink}">${card.tagline}</text>`
    );
  }
  if (card.url) {
    lines.push(
      `  <text name="Outro url" x="0" y="${Math.round(height * 0.60)}" width="${width}" height="40" ` +
        `text-align="center" vertical-align="middle" font-size="22" color="${card.ink}">${card.url}</text>`
    );
  }
  lines.push('</content>');
  return lines.join('\n');
}

/** Opacity program: hidden until the card's moment, then held to the end. */
function outroMotion({ pageId, nodeIds, clipSec, totalSec }) {
  const inAt = Math.max(0, clipSec);
  const kfs = (id) =>
    `  t.keyframes(${JSON.stringify(id)}, "opacity", ` +
    JSON.stringify([
      { tMs: 0, value: 0, easing: 'linear' },
      { tMs: Math.round(inAt * 1000), value: 0, easing: 'linear' },
      { tMs: Math.round((inAt + FADE_SEC) * 1000), value: 1, easing: 'easeInOut' },
      { tMs: Math.round(totalSec * 1000), value: 1, easing: 'linear' },
    ]) +
    ');';
  return `motion.page(${JSON.stringify(pageId)}, (t) => {\n${nodeIds.map(kfs).join('\n')}\n});`;
}

module.exports = { brandCard, compositeOutro, extendTail, outroMarkup, outroMotion, outroSeconds };
