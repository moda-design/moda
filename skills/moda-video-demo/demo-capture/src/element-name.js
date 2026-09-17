// The accessible name a selector resolved to — the one fact about the video.
//
// This existed THREE times over, which is how the narration ended up writing
// from a different source than the captions (ENG-5766):
//
//   - `curate.js` `nameOf`      — `/name="([^"]*)"/i`, double quotes only
//   - `narrate.js` `elementName` — quotes, apostrophes and /regex/, unescaped
//   - `captions.js`              — its own resolution, off the clip's selector
//
// The distinction that matters is not which regex: it is `selector` versus
// `label`. The selector says what was actually clicked. The label says what the
// discovery agent was THINKING about clicking, and burning that into a video is
// the bug `captions.js` was rewritten to fix — a real run captioned a step
// "The page didn't navigate to the app. Let me scroll up to find the Go to App
// link". The narration is still fed the label today, which is the other half of
// that same bug and what ENG-5766 calls "say the real names".
//
// So there is one extractor, and callers that want the resolved identity ask
// for it by name rather than each deciding what a selector looks like.

/**
 * The `name=` of a Playwright role selector, however it was quoted.
 *
 * ONLY a `role=` selector. `snapshot.js`'s resolver also emits the plain CSS
 * attribute form — `input[name="email"]`, branch 3, for any element with an
 * HTML `name` and no test id or stable id — and an HTML `name` is a form-field
 * KEY, not an accessible name. Nothing with that text is necessarily on
 * screen. Matching `name=` anywhere pulled "email" out of it and handed it to
 * three consumers as the resolved element name: the editor's prompt, the
 * script's prompt (under a rule that says to use it because it is "the
 * accessible name of the thing actually clicked"), and the don't-invent
 * allowlist — which would then have licensed a line saying *click "email"*.
 * The mistake was self-confirming, because the guard that exists to catch a
 * name that is not on screen was reading the same bad source.
 *
 * Handles `name="Create"`, `name='Create'` and `name=/Create/` — the three
 * forms Playwright accepts — and unescapes, because `name="Say \"hi\""` reaches
 * us with the backslashes still in it. Returns `''` for every other selector
 * shape, which is a real and ordinary answer: not every element has an
 * accessible name to say out loud.
 */
function nameFromSelector(selector) {
  // The quoted alternatives allow an ESCAPED delimiter inside them. A plain
  // `[^"]*` stops at the first `\\"`, so `name="Say \\"hi\\""` extracted `Say` —
  // a truncated name, which is worse than none: it reads like a real answer,
  // and both the editor's prompt and the don't-invent check would then treat
  // "Say" as the thing on screen.
  const sel = String(selector ?? '');
  // ANCHORED at `role=`. See above: the unanchored form read an HTML name
  // attribute as an accessible name.
  if (!/^role=/i.test(sel)) return '';
  const m = /name=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\/([^/]+)\/)/i.exec(sel);
  const raw = m ? (m[1] ?? m[2] ?? m[3]) : '';
  return raw.replace(/\\/g, '').trim();
}

/**
 * The resolved name for a recorded clip ACTION (`{ selector, label }`).
 *
 * Falls back to the label only when there is no selector to read — a keypress
 * or a coordinate-only click genuinely has no element identity, and saying the
 * label is better than saying nothing. Everywhere a selector exists, the
 * selector wins.
 */
function elementName(action) {
  return nameFromSelector(action?.selector) || String(action?.label ?? '').trim();
}

/**
 * The resolved name for a FLOW step (`{ locator, why }`), which is what exists
 * before anything has been recorded.
 *
 * Deliberately does NOT fall back to `why`. `why` is `action.reason` from the
 * discovery model (`discovery.js:110`) — the agent's reason for the step, not a
 * fact about the screen — and a caller that wants it should read it and know
 * that is what it is reading. Returns `''` rather than quietly substituting it.
 */
function stepName(step) {
  return nameFromSelector(step?.locator);
}

module.exports = { nameFromSelector, elementName, stepName };
