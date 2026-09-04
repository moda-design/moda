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

const SCRIPT_MODEL = 'claude-opus-5';

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
  const label = (a.label || '')
    .replace(/^(click|type)\s+/i, '')
    .replace(/^["“”']+|["“”']+$/g, '')
    .trim();
  if (a.type === 'scroll') return `Now, let's scroll ${/up/i.test(a.label || '') ? 'back up' : 'down'} to see more.`;
  if (a.type === 'type') return `Next, let's type in ${a.text ? `“${a.text}”` : 'our text'}.`;
  return label ? `Now, let's click on ${label}.` : `Let's move on to the next step.`;
}

/** Ask over whichever transport this machine has. Returns raw reply text. */
function ask(user) {
  if (process.env.ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk').default ?? require('@anthropic-ai/sdk');
    return new Anthropic().messages
      .create({ model: SCRIPT_MODEL, max_tokens: 1024, system: SYSTEM, messages: [{ role: 'user', content: user }] })
      .then((r) => r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
  }
  // stdout ONLY — the CLI writes MCP chatter to stderr, and merging the two puts
  // "Client.listTools() called but..." in front of the JSON.
  const raw = execFileSync(
    'claude',
    ['-p', user, '--output-format', 'json', '--append-system-prompt', SYSTEM, '--strict-mcp-config'],
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
async function scriptNarration({ goal, steps }) {
  const stepList = steps.map((s, i) => `${i + 1}. (${s.type}) ${s.label || '(no label)'}`).join('\n');
  const user = [
    `Demo goal: ${goal}`,
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

module.exports = { scriptNarration, humanizeAction, SCRIPT_MODEL };
