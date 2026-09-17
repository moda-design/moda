// The conversational voiceover script — PORTED FROM THE REFERENCE, not rewritten.
//
// Source: `~/repos/kleo-autogen-feature-demo/src/narration.js` (commit b39aba0).
// The system prompt below is that file's, verbatim. Only the TRANSPORT differs:
// the reference used the Anthropic SDK with a tool schema and returned null when
// `ANTHROPIC_API_KEY` was missing; here the key is normally absent and the
// authenticated `claude` CLI carries the call, so the tool becomes a JSON reply.
//
// What this replaces, and why it matters (ENG-5919). `narrate.js` derived each
// spoken line from a three-branch template:
//
//     index 0        -> `Start in ${name}.`
//     the last one   -> `And that's ${name}.`
//     everything else-> `Then ${name}.`
//
// so a three-step demo said "Start in User menu. Then Settings. And that's MCP
// and CLI." That template does not exist in the reference — it was invented
// during the port, and it is the whole reason the voiceover sounds robotic. The
// sentences ARE a list because they were generated one per list item.
//
// Two rules in the prompt are load-bearing and easy to "improve" backwards:
//
//   - COMPLETE sentences, never fragments or bare button labels. A later attempt
//     at this rewrote it toward terse fragments ("Claude Code can design in
//     Moda") on the theory that short reads as confident. It reads as clipped.
//   - VARY THE OPENINGS, and the listed openings include "Let's start by…" and
//     "Now we'll…". The same attempt BANNED those exact phrases as "the manual
//     register". They are what a person showing you something actually says.
//
// Captions are a DIFFERENT job with a different source and length — see the
// header of `captions.js` (ENG-5766). Do not merge the two.
const { execFileSync } = require('node:child_process');
const { elementName } = require('./element-name.js');

const SCRIPT_MODEL = 'claude-opus-5';

//: What the script is told BEYOND the reference's prompt (ENG-5766).
//:
//: Appended rather than merged, and the reason is in this file's header: the
//: reference's prompt is the asset, it has been iterated on, and two of its
//: rules have already been "improved" backwards once. Keeping the addition
//: separate means a future reader can see exactly which sentences are ours and
//: revert them without touching the part that was earned.
//:
//: Both halves are ENG-5766's "two things it must get right", and each is paired
//: with something code enforces, because neither is trustworthy on its own:
//:   - say the real names -> the element name is now IN the input (it was not:
//:     the script was fed the discovery agent's reason, the same source
//:     `captions.js` was moved off)
//:   - don't invent       -> `src/invention.js` checks every quoted name against
//:     what the flow can actually show, and replaces a line that fails
const EDITORIAL = [
  '',
  'Each action is given with the RESOLVED ELEMENT NAME — the accessible name of the thing actually',
  'clicked. Use it. "Now let\'s hit Invite teammate to bring the rest of the team in" is worth far',
  'more than "now let\'s click the button", and that specificity is most of what separates a demo',
  'script from filler.',
  '',
  'NEVER NAME SOMETHING YOU WERE NOT GIVEN. If an action has no element name, describe what is',
  'happening without asserting what the screen says — a plain sentence is fine, a confidently wrong',
  'one is the worst thing this video can contain. The "reason" on an action is what the agent was',
  'thinking, not a fact about the screen: never quote it as a label.',
  '',
  'Each action also carries its place in the film and how much room it wants:',
  '  hook    the opening. Say what this is.',
  '  build   the work. Keep it moving.',
  '  payoff  the moment the product delivers. This is the line that matters most.',
  '  close   after the payoff has landed.',
  '  pace "hurry" means the moment is transport — write a SHORT line, under about 8 words, or the',
  '  video has to wait for you. pace "hold" means the moment has room: use it.',
].join('\n');

//: The reference's prompt, unchanged. Edit with care — see the header.
const SYSTEM =
  'You write the voiceover script for a short product demo video. Given the demo goal and an ordered ' +
  'list of UI actions, write ONE warm, natural, fully-formed spoken sentence per action — the way a ' +
  'friendly host narrates while showing someone around the product. Rules: write COMPLETE, grammatical ' +
  'sentences with a subject and a verb — never clipped fragments or bare button labels (say "Now let\'s ' +
  'open the comments tool to leave some feedback", NOT "Open comments"). Aim for ~10–18 words, about ' +
  '3–5 seconds spoken. Sound relaxed and human, never robotic or terse. No step numbers. Vary the ' +
  'openings naturally ("Let\'s start by…", "Now we\'ll…", "From here, you can…", "Next, go ahead and…", ' +
  '"Once that\'s open…"). Describe what the user is doing and why it\'s useful, not the raw selector. ' +
  'Return exactly one line per action, in order. ALSO write a separate closing "conclusion" line that ' +
  'warmly wraps up the whole demo with a friendly summary or call to action — a full sentence, not ' +
  'another step.';

/**
 * A complete, conversational sentence for a step when the model script is
 * missing that line — so a fallback never sounds like a clipped button label.
 *
 * Ported verbatim. This is the reason a degraded run still sounds human: the
 * gap-filler is a sentence, not `${name}`.
 */
function humanizeAction(a) {
  // THE RESOLVED NAME FIRST (ENG-5766). This read `a.label`, which is the
  // discovery agent's reason — so the sentence this produces said "Now, let's
  // click on share it." rather than naming the Share button.
  //
  // It matters more here than anywhere else, because this is what the
  // don't-invent check falls back TO. Replacing a confidently wrong line with
  // a line built from the same untrustworthy source is not a remedy; it just
  // launders the problem into a plainer sentence.
  //
  // PRESENT-BUT-EMPTY IS AN ANSWER. `pacing.js` always sets `name` from the
  // flow step's selector, so `name: ''` means "this step resolved no element
  // identity" — and falling through to `elementName` there put us straight
  // back on `label`, i.e. the discovery model's reason, for every step with a
  // CSS locator. The laundering this function was just fixed to stop, via the
  // one path that still reached it.
  //
  // So a flow-derived action is trusted to its `name` alone, and the
  // `selector`-then-label fallback is kept only for a RECORDED clip action,
  // which sets no `name` and where a keypress genuinely has no element.
  // When neither yields anything the sentence below is the bland one, which is
  // the whole trade: plain beats confidently wrong.
  const identity = 'name' in a ? a.name : elementName(a);
  const label = (identity || '')
    .replace(/^(click|type)\s+/i, '')
    .replace(/^["“”']+|["“”']+$/g, '')
    .trim();
  if (a.type === 'scroll') return `Now, let's scroll ${/up/i.test(a.label || '') ? 'back up' : 'down'} to see more.`;
  // `fill` AS WELL AS `type`. The reference called this action `type`; every
  // flow in this pipeline calls it `fill`, so the typing sentence was
  // unreachable and a fill fell through to the CLICK branch — "Now, let's
  // click on Prompt." over footage of someone typing. A confidently wrong
  // sentence, produced by the fallback whose whole job is to be the plain,
  // safe one (ENG-5766).
  //
  // No text means there is nothing to quote — either the step carried none, or
  // `sensitive.js` withheld it — and "our text" is the right thing to say
  // about a password field.
  if (a.type === 'type' || a.type === 'fill') {
    return `Next, let's type in ${a.text ? `“${a.text}”` : 'our text'}.`;
  }
  return label ? `Now, let's click on ${label}.` : `Let's move on to the next step.`;
}

/** Ask over whichever transport this machine has. Returns raw reply text. */
function ask(user) {
  // ONE prompt for both transports. They used to be assembled separately, which
  // is how the SDK branch would have kept the reference prompt while the CLI
  // branch got the editorial addition — the same shape as `style.js`'s dead SDK
  // branch, which returned null on every machine that had the variable set and
  // survived precisely because nobody here has it.
  const system = SYSTEM + '\n' + EDITORIAL;
  if (process.env.ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk').default ?? require('@anthropic-ai/sdk');
    return new Anthropic().messages
      .create({ model: SCRIPT_MODEL, max_tokens: 1024, system, messages: [{ role: 'user', content: user }] })
      .then((r) => r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
  }
  // stdout ONLY — the CLI writes MCP chatter to stderr, and merging the two puts
  // "Client.listTools() called but..." in front of the JSON.
  const raw = execFileSync(
    'claude',
    ['-p', user, '--output-format', 'json', '--append-system-prompt', system, '--strict-mcp-config'],
    { encoding: 'utf8', maxBuffer: 8 << 20, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  return Promise.resolve(JSON.parse(raw).result ?? '');
}

/** First JSON object in a reply that may be fenced or prefaced. */
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
 * Write the conversational script.
 *
 * Returns `{ lines, conclusion, transport }`, or null on any failure so the
 * caller falls back to `humanizeAction` per step — still sentences, still human.
 */
async function scriptNarration({ goal, steps, about }) {
  // ONE LINE PER ACTION, and the element name is the first thing on it.
  //
  // What this replaces is the whole of ENG-5766's "say the real names": the
  // list used to be `(${s.type}) ${s.label}`, and `label` arrives here as the
  // flow's `why`, which `discovery.js:110` sets from the model's `reason`. So
  // the voiceover was written from the agent's reasoning while the captions
  // were written from the resolved element — two descriptions of one video,
  // and only one of them a fact about it.
  //
  // The reason is still passed, LABELLED as the reason, because it carries
  // intent the element name does not ("pick a format", "run it"). What changed
  // is that it is no longer the only thing here, and no longer presented as if
  // it were a name.
  const stepList = steps.map((s, i) => {
    const bits = [`${i + 1}. (${s.type})`];
    if (s.name) bits.push(`element: ${JSON.stringify(s.name)}`);
    if (s.text) bits.push(`types: ${JSON.stringify(s.text)}`);
    if (s.beat) bits.push(`beat: ${s.beat}`);
    if (s.pace && s.pace !== 'normal') bits.push(`pace: ${s.pace}`);
    if (s.label) bits.push(`reason: ${JSON.stringify(s.label)}`);
    return bits.length > 1 ? bits.join('  ') : `${i + 1}. (${s.type}) (no label)`;
  }).join('\n');
  const user = [
    `Demo goal: ${goal}`,
    // The editorial pass's one-line spine, when there was one. It is a stronger
    // brief than the goal: the goal says what the agent was asked to do, this
    // says what the finished video demonstrates.
    ...(about ? ['', `What this video is about: ${about}`] : []),
    '',
    'Actions (in order):',
    stepList,
    '',
    `Write ${steps.length} conversational voiceover line(s), one per action.`,
    'Return ONLY a JSON object:',
    '{"script": "<one line per action, newline-separated, in order, no numbering>", "conclusion": "<one closing sentence>"}',
  ].join('\n');

  let raw;
  try {
    raw = await ask(user);
  } catch (e) {
    console.warn(`  narration script generation failed: ${String(e.message).split('\n')[0].slice(0, 90)}`);
    return null;
  }
  const out = parseReply(raw);
  if (!out || typeof out.script !== 'string') {
    console.warn('  narration script: could not parse the model reply');
    return null;
  }
  const lines = out.script
    .split('\n')
    .map((s) => s.replace(/^\s*\d+[.)]\s*/, '').trim()) // strip any stray numbering
    .filter(Boolean);
  // Best-effort on a count mismatch: the caller maps by index and fills any gap
  // with `humanizeAction`, which is better than discarding a good script and
  // going robotic for every step.
  if (lines.length !== steps.length) {
    console.warn(
      `  narration script: got ${lines.length} lines for ${steps.length} steps — ` +
        'aligning by index, conversational fallback for any gap'
    );
  }
  return {
    lines,
    conclusion: typeof out.conclusion === 'string' ? out.conclusion.trim() : null,
    transport: process.env.ANTHROPIC_API_KEY ? 'api' : 'cli',
  };
}

module.exports = { scriptNarration, humanizeAction, SCRIPT_MODEL, SYSTEM, EDITORIAL };
