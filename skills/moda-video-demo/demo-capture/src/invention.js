// Don't invent: a narration line may not name something that is not there.
//
// "A confidently wrong voiceover is worse than a plain one" (ENG-5766). The
// failure this catches is specific and it is the worst output this pipeline can
// produce: the script says *click "Invite teammate"* over footage of a button
// that says something else, and everything downstream agrees with it — the
// caption comes from a different source and is right, the camera frames the
// real button, and the only thing wrong is the sentence a human will believe.
//
// WHAT IS ACTUALLY DECIDABLE, and what is not. A quoted name is a claim about a
// string on screen, and the flow knows every such string: the resolved element
// names and the text the demo types. That is checkable. An unquoted paraphrase
// — "let's open the comments tool" — is not: there is no way to decide from the
// flow whether "the comments tool" is a fair description of a button named
// "Comments" or an invention, and a guard that guessed would fire on the good
// sentences the prompt exists to produce.
//
// So this checks the decidable half and REPORTS ITS OWN COVERAGE. `checked` is
// how many quoted names it examined, and a script that quoted nothing comes
// back `{ measured: false }` rather than clean — because "no inventions found"
// and "nothing to look at" are different answers, and three checks in this
// package have already shipped green while measuring nothing.
const { stepName } = require('./element-name.js');
const { safeText } = require('./sensitive.js');

//: Quoted runs the script might present as a name on screen.
//:
//: DOUBLE QUOTES ONLY — straight, curly and guillemets. The apostrophe is NOT a
//: quote mark here, in either form, and admitting it was a false-positive
//: machine: this prompt asks for warm, contraction-heavy prose, so a line like
//: *"Let's open the designer and see what Moda's engine does"* has two of them
//: and everything between reads as one quoted run. A false positive here is not
//: harmless — it REPLACES a good line with the plain fallback, so the guard
//: would have made the script worse on exactly the sentences the prompt exists
//: to produce.
//:
//: The cost is that a single-quoted name goes unchecked. That is the right way
//: round: the prompt's own examples use double quotes, and an unchecked line is
//: the status quo while a wrongly-replaced one is a regression.
const QUOTED = /[«"“]([^«»"“”]{1,60})[»"”]/g;

/**
 * Compare the way a viewer would: case, punctuation and spacing are not the
 * claim.
 *
 * UNICODE LETTERS AND NUMBERS, not `[a-z0-9]`. The ASCII class stripped every
 * character of a Japanese, Chinese, Cyrillic or Greek name, so a quoted
 * non-Latin control normalized to the empty string, tokenized to nothing, and
 * `supported()` returned true on the spot — `measured: true` with no
 * inventions, for a name that matched nothing on screen. The same fail-open
 * the word-run matcher was written to close, reintroduced for every
 * internationalized app.
 */
const normalize = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Normalized words. Matching is per-WORD; see `supported`. */
const words = (s) => normalize(s).split(' ').filter(Boolean);

//: Words a script may add around a real name and still be naming that thing.
//: *"the Share button"* is the Share button; *"Share to Google Drive"* is not.
//: Deliberately tiny — every word admitted here is a word an invention may
//: hide behind, and the failure it buys is the one this file exists to stop.
const WRAPPERS = new Set([
  'the', 'a', 'an', 'that', 'this', 'our', 'your',
  'button', 'tab', 'menu', 'option', 'field', 'link', 'icon',
  'control', 'panel', 'toggle', 'box', 'item', 'entry',
]);

/** Is `needle` a contiguous run of words inside `haystack`? */
function containsRun(haystack, needle) {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((w, k) => haystack[i + k] === w)) return true;
  }
  return false;
}

/**
 * Every string this demo can truthfully quote.
 *
 * The resolved element names and the text the flow types — both facts about
 * what will be on screen. Deliberately NOT the steps' `why`: that is the
 * discovery model's reason for the step, and admitting it here would let the
 * script quote the agent's own reasoning back and pass.
 */
function sayableNames(flow, upToIndex = Infinity) {
  const out = new Set();
  for (const [i, s] of (flow?.steps ?? []).entries()) {
    if (i > upToIndex) break;
    const name = stepName(s);
    if (name) out.add(normalize(name));
    // A secret is not a sayable name. Admitting it here would let a script
    // that quoted the typed API key pass the don't-invent check — technically
    // true, and the worst possible thing to be right about.
    const text = safeText(s);
    if (text) out.add(normalize(text));
  }
  out.delete('');
  return out;
}

/**
 * Is a quoted fragment supported by something the demo will actually show?
 *
 * WORD RUNS, not raw substrings. This was `n.includes(q) || q.includes(n)` on
 * normalized strings, and that FAILS OPEN — which is worse than not checking,
 * because it returns `measured: true, inventions: []` and reads as a clean
 * pass. A flow with a button named "Go" validated *"Google Drive"* and *"Let
 * us get going"*; one with "OK" validated anything containing "look". The
 * shorter the real control's name, the more inventions it waved through, and
 * short names are the common case.
 *
 * Two directions, both at word boundaries:
 *
 *   - the quote is PART of a name — "Create" of "Create a new canvas". The
 *     script being briefer than the label.
 *   - a name is part of the QUOTE — but then every extra word must be a
 *     wrapper. "the Share button" is the Share button; "Share to Google
 *     Drive" is an invention wearing a real name.
 */
function supported(quoted, names) {
  const q = words(quoted);
  // A fragment with no letters or digits at all — "…", "1." — is not a claim
  // about a control. `checkInventions` does not even count it, so this is the
  // defensive half of one decision rather than a second answer to it.
  if (!q.length) return true;
  for (const n of names) {
    const nw = words(n);
    if (!nw.length) continue;
    if (containsRun(nw, q)) return true;
    if (containsRun(q, nw) && q.every((w) => nw.includes(w) || WRAPPERS.has(w))) return true;
  }
  return false;
}

/**
 * Check a script's lines against what the flow can show.
 *
 * Returns `{ measured, checked, lines, inventions, closing }`. `inventions` is
 * `[{ index, quoted, text }]` — the caller replaces those lines rather than
 * shipping them, and `pacing.js` replaces them with `humanizeAction`, which
 * names the resolved element and asserts nothing else.
 *
 * `closing` is the script's CONCLUSION line, and it has to be passed in
 * separately for two reasons. It was omitted entirely at first, which made
 * this the rubric-10.7 shape: the conclusion is voiced and muxed as the LAST
 * THING THE VIDEO SAYS, and the run reported full coverage while never having
 * looked at it. And its scope is different — it summarises the finished demo,
 * so every step has been seen by the time it plays, where a step line is only
 * allowed what the viewer has seen so far.
 *
 * `measured: false` when nothing quoted anything. That is the common case for a
 * good script and it is NOT a pass — it means this guard had no purchase on
 * this run, and saying so is the difference between a check and a decoration.
 */
function checkInventions({ lines, flow, closing = null }) {
  const inventions = [];
  let checked = 0;
  (lines ?? []).forEach((text, index) => {
    // SCOPED TO WHAT THE VIEWER HAS SEEN BY THIS LINE, not to the whole flow.
    //
    // Checking against every step's names let a line spoken over Generate say
    // *click "Share"* and pass, purely because some later step happened to
    // have a Share control — a voiceover visibly out of sync with the action,
    // waved through by the guard that exists to catch exactly that.
    //
    // CUMULATIVE rather than this-step-only, because a line may legitimately
    // refer back to something already on screen ("the deck we just named"),
    // and a false positive here REPLACES a good line. A forward reference is
    // flagged, which is right: the prompt asks for one line about the action
    // it is spoken over, so naming a control that has not appeared yet is the
    // failure, not a style.
    const names = sayableNames(flow, index);
    for (const m of String(text ?? '').matchAll(QUOTED)) {
      const quoted = m[1].trim();
      // NOT COUNTED when it carries no letters or digits. Counting it would
      // report a name as checked that this guard cannot decide anything
      // about, which is the difference between a check and a decoration.
      if (!quoted || !words(quoted).length) continue;
      checked++;
      if (!supported(quoted, names)) inventions.push({ index, quoted, text });
    }
  });
  // THE CLOSING LINE, against the WHOLE flow. It plays last, so nothing in the
  // demo is a forward reference by then. Reported on its own key because its
  // remedy is different too: a step line falls back to `humanizeAction`, and
  // a conclusion has no action to build a sentence from — the caller drops it.
  let closingInvention = null;
  if (closing) {
    const all = sayableNames(flow);
    for (const m of String(closing).matchAll(QUOTED)) {
      const quoted = m[1].trim();
      if (!quoted || !words(quoted).length) continue;
      checked++;
      if (!supported(quoted, all)) {
        closingInvention = { quoted, text: closing };
        break;
      }
    }
  }

  return {
    measured: checked > 0,
    checked,
    lines: (lines ?? []).length + (closing ? 1 : 0),
    inventions,
    closing: closingInvention,
    reason: checked ? undefined : 'no line quoted a name — nothing this check can decide',
  };
}

module.exports = { checkInventions, sayableNames };
