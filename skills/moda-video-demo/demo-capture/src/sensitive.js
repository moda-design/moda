// What a demo must not say out loud, or send to a model.
//
// A `fill` step carries the literal text the flow types, and that text reaches
// three places: the editorial prompt, the narration prompt, and — through
// `sayableNames` and `humanizeAction`'s "Next, let's type in …" — the spoken
// voiceover of a published video. A flow that types into a password field, or
// pastes an API key to demonstrate a connection, turns a masked secret into
// narration over footage.
//
// TWO OF THOSE THREE PREDATE ENG-5766 (`pacing.js` has always passed `s.text`
// to the script, and `humanizeAction` has always spoken it); the editorial
// prompt is new. It is one seam either way, so it gets one guard.
//
// THIS IS A HEURISTIC OVER THE SELECTOR AND THE VALUE, and heuristics over
// user data are exactly the thing not to trust: discovery does not record
// whether a field was a password, so there is nothing authoritative to read.
// The real fix is to carry that from the recorder, where `input[type=password]`
// is a fact rather than a guess — filed as ENG-6319. Until then this closes
// the shapes that actually occur, and it fails toward redaction: a value it
// cannot classify but that looks like a credential is redacted, because a
// demo that says "our text" is merely bland and one that reads out a token is
// unrecoverable.

//: The field is for a secret. Read off the locator and the accessible name,
//: which is all a flow step carries.
//:
//: Note what is NOT here: a bare `code`. This pipeline's own reference demo is
//: a QR-code generator, and redacting "QR code" would blank the one field that
//: demo is about. Every one-time-code form is spelled out instead.
const SECRET_FIELD = new RegExp(
  [
    'password', 'passwd', '\\bpwd\\b', '\\bpin\\b', 'passcode', 'passphrase',
    'secret', '\\btoken\\b', 'api[-_\\s]?key', 'access[-_\\s]?key', 'private[-_\\s]?key',
    'credential', '\\botp\\b', '\\b2fa\\b', '\\bmfa\\b',
    'one[-_\\s]?time[-_\\s]?(code|password|passcode)',
    '(verification|security|auth|authentication)[-_\\s]?code',
    '\\bcvv\\b', '\\bcvc\\b', 'card[-_\\s]?number', '\\bssn\\b',
  ].join('|'),
  'i'
);

//: The VALUE is a credential whatever it was typed into. Prefixes that are
//: unambiguous by construction, plus a JWT.
const SECRET_VALUE = [
  /^sk-[A-Za-z0-9_-]{16,}$/,          // OpenAI-style
  /^sk_(live|test)_[A-Za-z0-9]{16,}$/, // Stripe
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,     // GitHub
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/,   // Slack
  /^AKIA[0-9A-Z]{16}$/,               // AWS access key id
  /^ya29\.[A-Za-z0-9_-]{20,}$/,       // Google OAuth
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/, // JWT
  /^[A-Fa-f0-9]{40,}$/,               // a long bare hex secret
];

/**
 * Would typing this step's text into a demo leak something?
 *
 * `step` is a FLOW step (`{ action, locator, text }`). Only a `fill` can leak:
 * a click types nothing.
 */
function isSensitive(step) {
  if (step?.action !== 'fill') return false;
  // THE AUTHORITATIVE ANSWER FIRST. `snapshot.js`'s resolver stamps this from
  // the live element — `type="password"`, or an `autocomplete` that names a
  // credential — so a discovered step does not depend on any of the guessing
  // below. It has to: the resolver prefers a test id or a stable id, so
  // `<input id="login" type="password">` reaches us as `#login`, and a value
  // like `hunter2` matches no credential shape. Nothing downstream could have
  // recovered that.
  if (step.sensitive === true) return true;
  const target = `${step.locator ?? ''} ${step.name ?? ''}`;
  if (SECRET_FIELD.test(target)) return true;
  const value = String(step.text ?? '').trim();
  return SECRET_VALUE.some((r) => r.test(value));
}

/**
 * The step's typed text, or null when it must not leave the machine.
 *
 * Null rather than a placeholder string, so every caller has to decide what to
 * do with the absence rather than accidentally speaking the word "REDACTED" —
 * `humanizeAction` already says "our text" when there is none, which is the
 * right sentence.
 */
function safeText(step) {
  return isSensitive(step) ? null : (step?.text ?? null);
}

module.exports = { isSensitive, safeText, SECRET_FIELD, SECRET_VALUE };
