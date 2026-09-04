// Is the product still working?
//
// Network quiet is a poor proxy for "done" on an agent app. The stream between
// turns goes silent, the page stops requesting, and the recorder concludes the
// step is over — while the product is mid-generation and the payoff has not
// been drawn yet.
//
// This is the single failure that has capped every Moda sample. One take ended
// on "Designing. Please wait to edit" and scored 3/10; the run before it
// happened to be quick and reached 7/10 with the identical flow. The difference
// was how long the product took, which is exactly the thing a fixed quiet
// window cannot adapt to.
//
// So the recorder asks the page instead. These are the signals a product gives
// when it is working, and they are checked in the DOM rather than inferred from
// traffic.

//: Accessibility state first — it is the least ambiguous thing on the page and
//: costs nothing to check.
const BUSY_SELECTORS = [
  '[aria-busy="true"]',
  '[role="progressbar"]',
  '[data-loading="true"]',
  '[data-state="loading"]',
];

//: And the words products use while they work. Anchored to short strings so a
//: paragraph merely CONTAINING "generating" does not read as a spinner.
const BUSY_TEXT = [
  /\b(designing|generating|thinking|processing|working on it|please wait)\b/i,
  /\b(loading|rendering)[.…]{0,3}$/i,
];

//: A busy signal inside a longer string is prose, not status. The real ones
//: are short — "Designing. Please wait to edit" is 30 characters, "Generating
//: design elements..." is 29, "Thinking..." is 11. A first cut at 120 matched
//: a paragraph about "generating electricity from tidal flows".
//:
//: A short sentence that merely contains one of these words still matches, and
//: that is the trade taken deliberately: a false busy costs wall-clock inside
//: the step's own maxMs, a false idle ends the recording on a spinner.
const MAX_STATUS_CHARS = 48;

/**
 * Whether the page is showing a busy signal, and which one.
 *
 * Deliberately conservative: a false "busy" only costs wall-clock inside the
 * step's own `maxMs`, while a false "idle" ends the recording on a spinner —
 * which is what this exists to stop.
 */
async function isBusy(page) {
  return page.evaluate(([sels, pats, maxChars]) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
    };
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        if (visible(el)) return { busy: true, by: sel };
      }
    }
    const res = pats.map(([src, flags]) => new RegExp(src, flags));
    // Leaf elements only: a status string is its own node, and matching every
    // ancestor that CONTAINS it would match <body> on any page that has one.
    for (const el of document.querySelectorAll('body *')) {
      if (el.childElementCount > 0) continue;
      const text = (el.textContent || '').trim();
      if (!text || text.length > maxChars) continue;
      if (!visible(el)) continue;
      for (const re of res) if (re.test(text)) return { busy: true, by: text.slice(0, 60) };
    }
    return { busy: false };
  }, [BUSY_SELECTORS, BUSY_TEXT.map((r) => [r.source, r.flags]), MAX_STATUS_CHARS]).catch(() => ({ busy: false }));
}

module.exports = { isBusy, BUSY_SELECTORS, BUSY_TEXT };
