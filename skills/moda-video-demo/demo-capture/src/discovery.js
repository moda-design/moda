// The discovery agent — PORTED from the reference generator's `src/discovery.js`
// (ENG-5919). A headless, throwaway run where a model is shown the page's
// interactable elements one step at a time, proposes ONE action, and we execute
// it, re-snapshot, and repeat until it says done. The output is a flow of
// DURABLE selectors that the real capture can then replay cleanly.
//
// Why this and not a hand-written flow. Moda's own agent runs a VARIABLE-LENGTH
// intake before it designs anything: measured across runs it asked three
// questions, then four; the first is a format picker, the second is free text,
// and `Skip` advances one question rather than the set. A fixed step list cannot
// express "answer or skip however many come back", so the outcome demo — type a
// prompt, get a design — is not authorable by hand. It needs an agent that looks
// at the page and decides.
//
// The loop, the prompt and the durability rules are the reference's. What
// differs is the TRANSPORT: it used the Anthropic SDK with a forced tool call,
// and `ANTHROPIC_API_KEY` is normally absent here, so this drives the
// authenticated `claude` CLI and carries the conversation with `--resume`.
const { execFileSync } = require('node:child_process');
const { snapshotInteractables, resolveDurableSelector, formatSnapshot } = require('./snapshot.js');
const { checkBotChallenge } = require('./page-health.js');

const MAX_STEPS = 25;
//: An agent-driven app legitimately takes minutes to produce its result, and
//: that result is the whole demo. Overridable because how long is reasonable is
//: a property of the app being filmed, not of this module.
const TIMEOUT_MS = Number(process.env.DEMO_DISCOVER_TIMEOUT_MS) || 600_000;
//: Two identical actions in a row means the page is not responding to it —
//: EXCEPT waiting, which is the correct thing to do repeatedly while a job
//: runs. Counting `wait` here killed the discovery of Moda's own design flow at
//: step 6 with "the page is not responding", while the page was responding
//: perfectly and the agent was still generating.
const MAX_REPEAT = 2;
//: Waiting is bounded separately: by the overall timeout, and by this many
//: consecutive waits, so a genuinely hung page still terminates.
const MAX_CONSECUTIVE_WAITS = 8;
//: Each consecutive wait doubles, so a handful of turns can span minutes
//: without burning a model call per second. A flat 1s could not outlast any
//: real generation, which is why discovery kept re-asking and looked stuck.
const WAIT_BASE_MS = 1500;
const WAIT_MAX_MS = 45_000;

//: What the loop can execute. `done` is NOT here — it is a terminator, matched
//: before this set is consulted. Putting the check above that branch made the
//: harness reject `done` as invented, and the model, told its only way out was
//: refused, invented a Download click to escape — a step that then appeared in
//: the flow as if a person had chosen it.
const KNOWN_ACTIONS = new Set(['click', 'type', 'scroll', 'wait']);

//: Consecutive non-JSON replies tolerated before giving up.
const MAX_UNPARSABLE = 2;

const SYSTEM = [
  'You drive a web browser to accomplish a goal. Each turn you are given the goal and the page\'s',
  "currently interactable elements, each with a [ref-N] id. Choose the SINGLE next action that makes",
  'progress. Only reference a ref-N that appears in the CURRENT list — they are renumbered every turn.',
  'Prefer the most direct path to the goal. Use "type" only on text fields, and provide the text.',
  '',
  'IMPORTANT — durability: prefer elements with a stable identifier (shown as {testid:...}) or a clear',
  'visible label. When more than one path reaches the same result, choose the one whose controls are',
  'clearly labelled, so the steps can be reliably replayed later.',
  '',
  'This is a PRODUCT DEMO being recorded. Take the path a person showing off the product would take:',
  'no detours, no settings you do not need, no opening something just to close it again. If the app',
  'asks you questions before it can continue, answer them the way a real user would — briefly and',
  'plausibly — rather than skipping, because the answers are part of what the demo shows.',
  '',
  'When the goal is visibly accomplished, return the "done" action.',
  '',
  'Reply with ONLY a JSON object, no prose and no code fence:',
  '{"type": "click|type|scroll|wait|done", "ref": "ref-N", "text": "...", "reason": "a few words"}',
].join('\n');

/** One CLI turn. Returns `{ text, session }`; `session` continues the conversation. */
function ask(prompt, session) {
  const args = ['-p', prompt, '--output-format', 'json', '--strict-mcp-config'];
  if (session) args.push('--resume', session);
  else args.push('--append-system-prompt', SYSTEM);
  // stdout ONLY — the CLI writes MCP chatter to stderr.
  const raw = execFileSync('claude', args, { encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  const out = JSON.parse(raw);
  return { text: out.result ?? '', session: out.session_id ?? session };
}

/** First JSON object in a reply that may be fenced or prefaced. */
function parseAction(raw) {
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

/** The discovered action, as a step the capture flow understands. */
function asFlowStep(action, durable) {
  const why = action.reason || action.type;
  if (action.type === 'click') return durable ? { action: 'click', locator: durable.selector, why } : null;
  if (action.type === 'type') return durable ? { action: 'fill', locator: durable.selector, text: action.text ?? '', why } : null;
  if (action.type === 'wait') return { action: 'wait', quietMs: 3000, maxMs: 120_000, why };
  // Scroll is how a demo GETS somewhere, not something worth a step of its own —
  // and in an agent-driven run it is usually the model recovering from a wrong
  // turn, which is the last thing a demo should show.
  return null;
}

async function execute(page, action, { waitMs = WAIT_BASE_MS } = {}) {
  const loc = action.ref ? page.locator(`[data-llm-ref="${action.ref}"]`).first() : null;
  switch (action.type) {
    case 'click':
      await loc.click({ timeout: 8000 });
      break;
    case 'type':
      await loc.click({ timeout: 8000 }).catch(() => {});
      await loc.fill(action.text ?? '');
      break;
    case 'scroll':
      if (loc) await loc.scrollIntoViewIfNeeded();
      else await page.mouse.wheel(0, 500);
      break;
    case 'wait':
      if (loc) await loc.waitFor({ state: 'visible', timeout: Math.max(8000, waitMs) });
      else await page.waitForTimeout(waitMs);
      break;
  }
}

/**
 * Drive the page until the goal is met, and return a replayable flow.
 *
 * THROWAWAY BY CONSTRUCTION: this run is not the recording. It exists to find
 * out what the steps ARE, in a browser nobody is filming, so the take can be a
 * clean replay of a known-good path rather than a recording of an agent
 * figuring things out. The reference is emphatic about this and it is why the
 * capture takes a flow file rather than driving the model itself.
 */
async function discover({ goal, startUrl, storageState, chromium, guidance }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const steps = [];
  let stopped = 'max_steps';
  const began = Date.now();

  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500);

    let { list } = await snapshotInteractables(page);
    let session = null;
    let prompt =
      `Goal: ${goal}\n` +
      (guidance ? `\nA previous attempt had these problems; avoid them:\n${guidance}\n` : '') +
      `\nInteractable elements:\n${formatSnapshot(list)}\n\nChoose the next action.`;
    let lastSig = null;
    let repeat = 0;
    let unparsable = 0;
    let consecutiveWaits = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (Date.now() - began > TIMEOUT_MS) {
        stopped = 'timeout';
        break;
      }
      // A BOT CHALLENGE IS NOT A PAGE TO DRIVE. Seen on a real run: a Cloudflare
      // interstitial appeared mid-flow, the model correctly refused to report
      // the goal met, and then spent every remaining step waiting for a page
      // that was not coming back — twenty model calls to arrive at no flow,
      // with nothing naming the cause. Waiting is the right instinct and the
      // wrong action, so the loop makes the call instead of the model.
      const challenge = await checkBotChallenge(page);
      if (challenge.blocked) {
        stopped = 'bot_challenge';
        console.log(`  stopping: the site is showing a bot challenge (${challenge.by}) — this is not the product`);
        break;
      }
      let reply;
      try {
        reply = ask(prompt, session);
      } catch (e) {
        stopped = 'model_error';
        console.log(`  step ${step}: model call failed — ${String(e.message).split('\n')[0].slice(0, 80)}`);
        break;
      }
      session = reply.session;
      const action = parseAction(reply.text);
      if (!action || !action.type) {
        // Usually the model finishing in prose ("the goal is accomplished")
        // rather than returning {"type":"done"}. Aborting there threw away a
        // discovery that had already found every step it needed and reported
        // `unparsable`, which reads like a defect rather than a finished run.
        // Nudge, and only give up if it keeps happening.
        if (++unparsable > MAX_UNPARSABLE) {
          stopped = 'unparsable';
          break;
        }
        prompt =
          'That was not JSON. Reply with ONLY a JSON object and nothing else. ' +
          'If the goal is already visibly accomplished, reply exactly {"type":"done"}.';
        console.log(`  step ${step}: reply was not JSON — asking again`);
        continue;
      }
      unparsable = 0;
      if (action.type === 'done') {
        console.log(`  step ${step}: done — ${action.reason || ''}`);
        stopped = 'done';
        break;
      }

      // An action type outside the vocabulary is the model's ordinary mistake,
      // not a reason to throw the run away. It invented "screenshot" on a tool
      // page that had nothing left to do, and aborting there cost a discovery
      // that had already found its one real step. Hand it back the way a stale
      // ref is handed back.
      if (!KNOWN_ACTIONS.has(action.type)) {
        prompt =
          `Error: "${action.type}" is not an action. Use one of: ${[...KNOWN_ACTIONS].join(', ')}, done.\n` +
          `If the goal is already visibly accomplished, return {"type":"done"}.\n\n` +
          `Interactable elements:\n${formatSnapshot(list)}\n\nChoose the next action.`;
        console.log(`  step ${step}: invented action ${JSON.stringify(action.type)} — asking again`);
        continue;
      }
      const needsRef = action.type === 'click' || action.type === 'type';
      const refValid = action.ref && list.some((e) => e.ref === action.ref);
      let result;
      if (needsRef && !refValid) {
        // Handed straight back to the model rather than aborting: the refs are
        // renumbered every turn and picking a stale one is an ordinary mistake.
        result = `Error: ref "${action.ref}" is not in the current list. Choose one that appears in it.`;
        console.log(`  step ${step}: ${action.type} -> stale ref ${action.ref}`);
      } else {
        const durable = refValid ? await resolveDurableSelector(page, action.ref) : null;
        const waitMs = Math.min(WAIT_MAX_MS, WAIT_BASE_MS * 2 ** consecutiveWaits);
        try {
          await execute(page, action, { waitMs });
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          const flowStep = asFlowStep(action, durable);
          if (flowStep) steps.push(flowStep);
          console.log(
            `  step ${step}: ${action.type}` +
              `${durable ? ` via ${durable.type} ${durable.selector}` : needsRef ? ' (NO durable selector — dropped)' : ''}` +
              `${action.reason ? `  — ${action.reason}` : ''}`
          );
          result = `Action executed (${action.type}${needsRef ? `, selector: ${durable ? durable.type : 'none'}` : ''}).`;

          if (action.type === 'wait') {
            consecutiveWaits += 1;
            repeat = 0;
            lastSig = null;
            if (consecutiveWaits >= MAX_CONSECUTIVE_WAITS) {
              stopped = 'waited_out';
              console.log(`  stopping: ${consecutiveWaits} waits in a row without the page reaching the goal`);
              break;
            }
          } else {
            consecutiveWaits = 0;
            const sig = `${action.type}|${flowStep ? flowStep.locator || '' : ''}|${action.text || ''}`;
            if (sig === lastSig) repeat += 1;
            else {
              repeat = 0;
              lastSig = sig;
            }
            if (repeat >= MAX_REPEAT) {
              stopped = 'repeated_action';
              console.log('  stopping: the same action twice in a row, so the page is not responding to it');
              break;
            }
          }
        } catch (e) {
          result = `Error executing ${action.type}: ${e.message}`;
          console.log(`  step ${step}: ${action.type} failed — ${String(e.message).split('\n')[0].slice(0, 70)}`);
        }
      }

      ({ list } = await snapshotInteractables(page));
      prompt = `${result}\n\nInteractable elements:\n${formatSnapshot(list)}\n\nChoose the next action.`;
    }
  } finally {
    await browser.close();
  }
  return { goal, startUrl, steps, stopped };
}

module.exports = { discover, MAX_STEPS };
