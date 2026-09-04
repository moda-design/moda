// PORTED VERBATIM from `~/repos/kleo-autogen-feature-demo/src/snapshot.js`
// (ENG-5919). Pure in-page JS with no dependencies, so there was nothing to
// adapt — and nothing here should be rewritten from memory: the durability
// ladder (testid > id > name/placeholder > role+name > text), the volatile-id
// rejection list, and the unique-CSS-path fallback for ambiguous role selectors
// are all hard-won and easy to get subtly wrong.
//
// Snapshot the page's visible, interactable elements for the discovery LLM,
// tagging each with a data-llm-ref the model references. After the model picks
// a ref, resolveDurableSelector() turns it into a selector that survives the
// browser restart: prefer data-testid > id > role+name > text; null if none.

// --- in-page helpers (serialized into the browser) ---

function pageSnapshot(maxText) {
  // Clear stale refs from the previous snapshot.
  document.querySelectorAll('[data-llm-ref]').forEach((e) => e.removeAttribute('data-llm-ref'));

  const SEL =
    'a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],' +
    '[role="checkbox"],[role="menuitem"],[role="tab"],[role="switch"],[role="combobox"],[contenteditable="true"]';

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button' }[t] || 'textbox';
    }
    return tag;
  };
  const nameOf = (el) => {
    let name = (el.getAttribute('aria-label') || '').trim();
    if (!name) name = (el.innerText || el.textContent || '').trim();
    if (!name) name = (el.getAttribute('placeholder') || '').trim();
    return name.replace(/\s+/g, ' ');
  };

  const out = [];
  const seen = new Set();
  let n = 0;
  for (const el of document.querySelectorAll(SEL)) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    if (el.disabled) continue;

    const role = roleOf(el);
    const name = nameOf(el).slice(0, maxText);
    const key = role + '|' + name;
    if (seen.has(key)) continue; // dedupe identical role+name
    seen.add(key);

    n += 1;
    const ref = 'ref-' + n;
    el.setAttribute('data-llm-ref', ref);
    out.push({
      ref,
      role,
      name,
      tag: el.tagName.toLowerCase(),
      testid: el.getAttribute('data-testid') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
    });
  }
  return out;
}

function pageResolve(refSel) {
  const el = document.querySelector(refSel);
  if (!el) return null;
  const q = (s) => JSON.stringify(s); // safe quoting + escaping
  const tag = el.tagName.toLowerCase();

  // 1) Test attributes (most durable).
  const TEST_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-cy', 'data-tid'];
  for (const attr of TEST_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) return { type: 'testid', selector: `[${attr}=${q(v)}]` };
  }

  // 2) Stable id (reject framework-generated/volatile ids).
  const id = el.id;
  const volatile = /(^radix-)|(_r_)|(^:r)|(^react-aria)|(^headlessui-)|(^mui-)|^[0-9a-f]{8}-[0-9a-f]{4}/i;
  if (id && !volatile.test(id)) {
    const simple = /^[A-Za-z][\w-]*$/.test(id);
    return { type: 'id', selector: simple ? `#${id}` : `[id=${q(id)}]` };
  }

  // 3) Stable form attributes.
  const nameAttr = el.getAttribute('name');
  if (nameAttr) return { type: 'name', selector: `${tag}[name=${q(nameAttr)}]` };
  const ph = el.getAttribute('placeholder');
  if (ph) return { type: 'placeholder', selector: `[placeholder=${q(ph)}]` };

  // 4) role + accessible name
  let role = el.getAttribute('role');
  if (!role) {
    if (tag === 'a') role = 'link';
    else if (tag === 'button') role = 'button';
    else if (tag === 'textarea') role = 'textbox';
    else if (tag === 'select') role = 'combobox';
    else if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      role = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button' }[t] || 'textbox';
    } else role = tag;
  }
  let name = (el.getAttribute('aria-label') || '').trim();
  if (!name) name = (el.innerText || el.textContent || '').trim();
  name = name.replace(/\s+/g, ' ').slice(0, 50);

  if (role && name) return { type: 'role', selector: `role=${role}[name=${q(name)}i]` };
  if (name) return { type: 'text', selector: `${tag}:has-text(${q(name)})` };
  return null; // nothing durable — caller flags the step
}

// A verified, unique structural CSS path for the ref element (anchored at the
// nearest stable id/test-id ancestor). Used to disambiguate when a role/text
// selector matches more than one element, so replay targets the SAME element.
function pageCssPath(refSel) {
  const el = document.querySelector(refSel);
  if (!el) return null;
  const q = (s) => JSON.stringify(s);
  const TEST_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-cy', 'data-tid'];
  const volatile = /(^radix-)|(_r_)|(^:r)|(^react-aria)|(^headlessui-)|(^mui-)|^[0-9a-f]{8}-[0-9a-f]{4}/i;
  const parts = [];
  let node = el;
  let depth = 0;
  while (node && node.nodeType === 1 && node !== document.documentElement && depth < 6) {
    const ta = TEST_ATTRS.find((a) => node.getAttribute(a));
    if (ta) {
      parts.unshift(`[${ta}=${q(node.getAttribute(ta))}]`);
      break;
    }
    if (node.id && !volatile.test(node.id) && /^[A-Za-z][\w-]*$/.test(node.id)) {
      parts.unshift(`#${node.id}`);
      break;
    }
    const t = node.tagName.toLowerCase();
    let i = 1;
    for (let s = node.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === node.tagName) i++;
    parts.unshift(`${t}:nth-of-type(${i})`);
    node = node.parentElement;
    depth++;
  }
  if (!parts.length) return null;
  // A path that never found a stable ancestor is NOT durable, however unique it
  // is right now. The loop above breaks out when it hits a test-id or a stable
  // id; if it exits by exhausting `depth` instead, what is left is positional
  // all the way up — `body > div:nth-of-type(5) > …` — and the index of a
  // top-level div depends on how many portals, toasts and overlays happen to be
  // mounted at that moment. Measured: a LinkedIn card resolved to exactly that
  // during discovery, matched something else on replay, and the capture died two
  // steps later looking for a button that never appeared.
  //
  // Returning null flags the step instead, which is the honest outcome — better
  // no selector than one that silently points somewhere else next run.
  const anchored = /^\[|^#/.test(parts[0]);
  if (!anchored) return null;
  const sel = parts.join(' > ');
  try {
    const f = document.querySelectorAll(sel);
    if (f.length === 1 && f[0] === el) return sel;
  } catch {
    /* invalid */
  }
  return null;
}

// --- node-side API ---

async function snapshotInteractables(page, { maxText = 60 } = {}) {
  const list = await page.evaluate(pageSnapshot, maxText);
  return { list };
}

async function resolveDurableSelector(page, ref) {
  const refSel = `[data-llm-ref="${ref}"]`;
  const res = await page.evaluate(pageResolve, refSel);
  if (!res) return null;
  // role/text selectors are substring/ambiguity-prone. If the chosen selector
  // doesn't match exactly one element, prefer a verified unique structural path
  // so the recorder clicks the intended element (not a wrong .first()).
  if (res.type === 'role' || res.type === 'text') {
    let count = 1;
    try {
      count = await page.locator(res.selector).count();
    } catch {
      count = 99;
    }
    if (count !== 1) {
      const path = await page.evaluate(pageCssPath, refSel);
      if (path) return { type: 'csspath', selector: path };
      // NO SELECTOR beats a selector that does not resolve. This used to fall
      // through and return the role selector anyway, unverified — so a name the
      // page reports and a name Playwright computes could disagree and the step
      // shipped as "durable" while matching nothing.
      //
      // Measured: a format card rendering "Landscape" and "1200x627" on two
      // lines gives innerText "Landscape 1200x627", which is not its accessible
      // name. The replay found no button, the capture broke two steps in, and
      // the timeline simply had fewer actions than the flow — a silent truncation
      // with nothing anywhere saying a selector had failed.
      return null;
    }
  }
  return res;
}

function formatSnapshot(list) {
  if (!list.length) return '(no interactable elements found)';
  return list
    .map((e) => {
      let s = `[${e.ref}] ${e.role} "${e.name}"`;
      if (e.testid) s += ` {testid:${e.testid}}`;
      if (e.placeholder) s += ` (placeholder: "${e.placeholder}")`;
      return s;
    })
    .join('\n');
}

module.exports = { snapshotInteractables, resolveDurableSelector, formatSnapshot };
