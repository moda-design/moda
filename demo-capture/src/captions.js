// On-screen caption text — a DIFFERENT job from the voiceover, and a different
// source from the one this pipeline has been using.
//
// The bug this replaces: `timelineToProps` falls back to `Step N: ${a.label}`,
// and in `llm` mode `label` is the discovery agent's per-step REASONING. A real
// run produced the caption:
//
//   "The page didn't navigate to the app. Let me scroll up to find the Go to App
//    link or navigate directly to /templates"
//
// — the agent narrating its own confusion, burned into the video. `scriptNarration`
// was written to fix this ("used for BOTH the narration and the on-screen
// captions so they match") and was never wired to `captionOverrides`, which has
// no writers at all.
//
// Wiring it as-is would not have fixed it either, for two reasons:
//
//   1. It is fed the same labels, so the reasoning survives into a warmer sentence.
//   2. It writes for the EAR — "~10-18 words, about 3-5 seconds spoken". A caption
//      is read at a glance while the viewer is watching something else, and 18
//      words in the compiler's fixed 96px plate is a wall of text.
//
// So captions get their own writer, and a better source: the RESOLVED ELEMENT
// IDENTITY. The selector says what was actually clicked; the label says what the
// agent was thinking about clicking. Only the first is a fact about the video.


const MODEL = 'claude-sonnet-4-6';

/** Longest caption the compiler's plate reads cleanly at font-size 28. */
const MAX_CAPTION_CHARS = 48;

/** Remove one matched pair of surrounding quotes, and nothing else. */
function unwrap(text) {
  const first = text[0];
  if ((first === '"' || first === "'") && text.length > 1 && text[text.length - 1] === first) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/** Pull the accessible name out of a Playwright role selector. */
function accessibleName(selector) {
  if (!selector) return null;
  const m = /name="((?:[^"\\]|\\.)*)"/.exec(selector);
  if (m) return m[1].replace(/\\(.)/g, '$1').trim() || null;
  // css/text selectors: `text=Create`, or a bare visible-text selector
  const t = /^text=(.+)$/.exec(selector);
  return t ? t[1].trim() : null;
}

/**
 * A caption derived from what the run actually resolved — no model, no guessing.
 * Returns null when there is nothing factual to say, which is the honest answer
 * for a step with no identity: better no caption than a confident wrong one.
 */
function deriveCaption(action) {
  const name = accessibleName(action.selector);
  switch (action.type) {
    case 'click':
      return name ? `Click "${name}"` : null;
    case 'type':
      return name ? `Type into "${name}"` : null;
    // Scroll and navigation are how the demo GETS somewhere, not something the
    // viewer needs told. In llm mode a scroll is usually the agent recovering
    // from a wrong turn, and captioning it advertises the mistake.
    case 'scroll':
    case 'navigate':
    case 'nav':
    case 'wait':
      return '';
    default:
      return name ? `${action.type} "${name}"` : null;
  }
}

// Which transport produced the last caption pass. Read by the bridge so the
// report can say so — see `lastTransport`.
let lastTransport = 'derived';

/**
 * Ask a model, over whichever transport this machine actually has.
 *
 * The API key is the fast path but it is NOT the common case here: this pipeline
 * is driven from a Claude Code session, where `ANTHROPIC_API_KEY` is normally
 * unset and the `claude` CLI is installed and already authenticated. The old code
 * returned the derived captions on a missing key WITHOUT SAYING SO, so every
 * demo published so far shipped `Click "User menu"` while the bridge reported a
 * plain "3 captioned" — a degraded result indistinguishable from a good one.
 *
 * Returns the raw "<index>: <caption>" lines, or null if no transport is
 * available. Never throws; the caller falls back to the derived text.
 */
async function askModel({ system, user, tool }) {
  if (process.env.ANTHROPIC_API_KEY) {
    // Required HERE, not at module load. At the top level it made the SDK a
    // hard dependency of a module whose own comment says the key is normally
    // absent — so an installed package would carry it for a branch that does
    // not run. `narration.js` already did it this way.
    const Anthropic = require('@anthropic-ai/sdk').default ?? require('@anthropic-ai/sdk');
    const resp = await new Anthropic().messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: user }],
    });
    const tu = resp.content.find((b) => b.type === 'tool_use');
    lastTransport = 'api';
    return tu && tu.input ? tu.input[Object.keys(tool.input_schema.properties)[0]] : null;
  }

  const { execFileSync } = require('node:child_process');
  // stdout ONLY. The CLI writes MCP chatter to stderr, and folding the two
  // together puts "Client.listTools() called but..." in front of the JSON.
  const raw = execFileSync(
    'claude',
    ['-p', user, '--output-format', 'json', '--append-system-prompt', system, '--strict-mcp-config'],
    { encoding: 'utf8', maxBuffer: 8 << 20, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  lastTransport = 'cli';
  return JSON.parse(raw).result ?? null;
}

/**
 * Polish the derived captions with one model pass. Falls back to the derived
 * text on any failure, so a missing key or a bad response degrades to something
 * factual rather than to the agent's reasoning.
 *
 * The prompt is given the DERIVED text as the fact and the label only as context,
 * and is told the label may be reasoning. That ordering is the fix: the model can
 * make "Click "Create"" read better, but it cannot invent a step, and it is never
 * asked to summarise a thought.
 */
async function scriptCaptions({ goal, steps }) {
  const derived = steps.map(deriveCaption);

  const listed = steps
    .map((s, i) => {
      if (derived[i] === '') return null; // deliberately uncaptioned; don't offer it
      return `${i}. type=${s.type} | resolved=${derived[i] ?? '(no element identity)'} | agent note: ${s.label || '(none)'}`;
    })
    .filter(Boolean)
    .join('\n');
  if (!listed) {
    lastTransport = 'derived';
    return derived.map((d) => d ?? '');
  }

  const tool = {
    name: 'captions',
    description: 'Short on-screen caption per step.',
    input_schema: {
      type: 'object',
      properties: {
        captions: {
          type: 'string',
          description:
            'One line per listed step, formatted "<index>: <caption>", in order. Use an empty caption ' +
            'after the colon to show nothing for that step.',
        },
      },
      required: ['captions'],
    },
  };

  const system =
        'You write ON-SCREEN CAPTIONS for a product demo video. These are read at a glance while the ' +
        'viewer is watching the screen, so they are SHORT: 2-6 words, ' +
        `${MAX_CAPTION_CHARS} characters maximum. Not sentences, not narration. ` +
        'For each step you are given: the action type, the element the run ACTUALLY RESOLVED AND CLICKED, ' +
        'and an "agent note". ' +
        'THE RESOLVED ELEMENT IS THE ONLY FACT. The agent note is an automated explorer thinking out loud ' +
        'about what to try — it frequently describes confusion, wrong turns, or intentions that did not ' +
        'happen ("the page did not navigate, let me scroll up to find..."). NEVER caption the note, never ' +
        'repeat a mistake it describes, and never mention navigating, retrying, looking for, or failing. ' +
        'Describe only what a viewer SEES happen. Prefer the element name verbatim over a paraphrase. ' +
        'If a step is pure navigation or has no resolved element, return an empty caption for it. ' +
        'Return one line per listed step as "<index>: <caption>".';
  const user = `Demo goal: ${goal}\n\nSteps:\n${listed}`;

  try {
    const raw = await askModel({ system, user, tool });
    if (typeof raw !== 'string') return derived.map((d) => d ?? '');

    const out = derived.map((d) => d ?? '');
    for (const line of raw.split('\n')) {
      const m = /^\s*(\d+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      const i = Number(m[1]);
      if (!(i >= 0 && i < out.length)) continue;
      if (derived[i] === '') continue; // the model does not get to caption a step we suppressed
      // Strip only a MATCHED surrounding pair. The naive
      // `.replace(/^["']|["']$/g, '')` is an alternation, so on a caption that
      // legitimately ends in a quoted element name — `Click "Create"` — it
      // matches the closing quote alone and leaves `Click "Create`.
      const text = unwrap(m[2].trim());
      // Over-length means it wrote narration despite the instruction. Keep the
      // derived text rather than truncating mid-word into nonsense.
      out[i] = text.length && text.length <= MAX_CAPTION_CHARS ? text : (derived[i] ?? '');
    }
    return out;
  } catch (e) {
    lastTransport = 'derived';
    console.warn(`  caption scripting failed (${e.message}) — using derived captions`);
    return derived.map((d) => d ?? '');
  }
}

module.exports = {
  scriptCaptions,
  deriveCaption,
  accessibleName,
  unwrap,
  MAX_CAPTION_CHARS,
  captionTransport: () => lastTransport,
};
