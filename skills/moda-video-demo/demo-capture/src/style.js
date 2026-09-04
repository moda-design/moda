const { execFileSync } = require('node:child_process');

const MODEL = 'claude-opus-5';

const JUDGE = [
  'You decide whether a short product-demo video needs a VOICEOVER, given its goal and the actions',
  'it performs.',
  '',
  'Answer NO when the product\'s own screen carries the value — someone types a link and a QR code',
  'appears, someone writes a prompt and a design appears. The result explains itself, and a narrator',
  'talking over it adds length without adding understanding. Published outcome demos usually run on',
  'music alone.',
  '',
  'Answer YES when what happens on screen is not self-explanatory: where to click is the content, or',
  'the point is WHY a step matters rather than what it does, or the result looks unremarkable without',
  'someone saying what it means. A menu path, a settings page, a switch whose effect is subtle.',
  '',
  'The test is not "does the demo type something". It is whether a viewer with the sound off would',
  'understand what they just watched and why it is good.',
  '',
  'Reply with ONLY a JSON object, no prose:',
  '{"voiceover": true|false, "why": "<one short clause>"}',
].join('\n');

/** Ask the model. Returns null on any failure so the caller falls back. */
function askJudge(goal, steps) {
  const listed = steps.map((a, i) => `${i}. ${a.type}${a.label ? ` — ${a.label}` : ''}`).join('\n');
  const user = `Demo goal: ${goal || '(not stated)'}\n\nActions:\n${listed}\n\nDoes this demo need a voiceover?`;
  // NO SDK BRANCH. There was one, guarded on ANTHROPIC_API_KEY, and it
  // constructed a client, threw it away and returned null — so on any machine
  // with that variable set the judge silently produced nothing and the caller
  // fell back to the heuristic it exists to replace. It never fired here
  // because the variable is not set locally, which is exactly why it survived.
  //
  // `askJudge` is synchronous by construction: `chooseStyle` is called from
  // straight-line code in take.mjs and finish.mjs. An async SDK call cannot be
  // bolted onto that, and the CLI path is authenticated anyway.
  try {
    const raw = execFileSync(
      'claude',
      ['-p', user, '--output-format', 'json', '--append-system-prompt', JUDGE, '--strict-mcp-config'],
      { encoding: 'utf8', maxBuffer: 8 << 20, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const text = JSON.parse(raw).result ?? '';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const out = JSON.parse(text.slice(start, end + 1));
    return typeof out.voiceover === 'boolean' ? out : null;
  } catch {
    return null;
  }
}

function chooseStyle(clip) {
  const forced = process.env.DEMO_STYLE;
  if (forced) return { style: forced, why: 'DEMO_STYLE was set' };
  // ASK, don't infer from the action types.
  //
  // The heuristic below — any `fill` means an outcome demo means no voiceover —
  // came from three published references that all had no voiceover. But all
  // three were the same company AND the same genre, so genre and house style
  // were confounded, and "outcome demos have no voiceover" may simply have been
  // "that company doesn't narrate". `docs`/`what-good-looks-like.md` says as
  // much in its own caveat, which I then encoded as a law anyway.
  //
  // The proxy was also crude: typing a URL into a QR box is a feature explainer,
  // not an outcome demo. The real question is whether a viewer with the sound
  // off would understand what they watched, which is a judgement about the
  // demo — so it is asked, with the heuristic kept only for when no model
  // answers.
  const judged = askJudge(clip.goal, clip.actions);
  if (judged) {
    return judged.voiceover
      ? { style: 'tutorial', why: `narration earns its place — ${judged.why}` }
      : { style: 'marketing', why: `the screen speaks for itself — ${judged.why}` };
  }

  const typed = clip.actions.filter((a) => a.type === 'fill' || a.type === 'type' || a.type === 'key');
  return typed.length
    ? { style: 'marketing', why: `no model answered; ${typed.length} action(s) type into the product` }
    : { style: 'tutorial', why: 'no model answered; every action is a click on chrome' };
}
module.exports = { chooseStyle };
