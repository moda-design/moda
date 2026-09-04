// How a flow step is performed — ONE implementation, shared by the capture and
// the validation walk.
//
// They had two, and they diverged. Validation used `locator.fill()`; the capture
// used `pressSequentially` so the typing would be visible in the footage. That
// is right for a text box and does nothing at all to an `<input type="color">`,
// which is what the CSS gradient tool's colour stops are. So validation really
// did change the gradient and measured real result regions, while the recording
// typed into a control that ignores typing — and the published demo showed a
// cursor entering values with the gradient never changing. The measurements said
// the page changed because, in validation's browser, it had.
//
// A validator that does not execute what the recorder executes is not validating
// the recording. Hence one function.
const TYPEABLE = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'textarea', 'contenteditable']);

/** What kind of control is this, for the purpose of putting a value in it? */
async function controlKind(locator) {
  return locator.evaluate((el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return 'textarea';
    if (el.isContentEditable) return 'contenteditable';
    if (tag === 'input') return (el.getAttribute('type') || 'text').toLowerCase();
    return tag;
  });
}

/**
 * Put `text` into a control the way a person would, where that is possible.
 *
 * Typing is the point in a recording — `fill()` sets the value in one tick, so
 * an empty box becomes a full sentence between two frames and reads as a cut.
 * But only some controls accept keystrokes. A colour swatch, a range slider or a
 * date picker takes a value, not typing, and sending it keystrokes silently does
 * nothing.
 *
 * `visible: false` (validation) skips the per-character delay, since nobody is
 * watching and the delay is pure wall-clock.
 */
async function enterText(locator, text, { visible = true, typeDelayMs = 45 } = {}) {
  const kind = await controlKind(locator);
  if (visible && TYPEABLE.has(kind)) {
    await locator.click({ timeout: 8000 }).catch(() => {});
    await locator.fill('');
    await locator.pressSequentially(text ?? '', { delay: typeDelayMs });
    return kind;
  }
  // NO CLICK on this branch. Clicking an `<input type="color">` opens the native
  // colour picker, which is a browser-level dialog: it blocked the following
  // step and the capture stopped after one action with nothing reported.
  // `fill()` sets the value without opening anything.
  await locator.fill(text ?? '');
  // A colour or range input often only commits on change; `fill` dispatches it,
  // but firing it explicitly makes frameworks that listen for it settle too.
  await locator.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true }))).catch(() => {});
  return kind;
}

module.exports = { enterText, controlKind, TYPEABLE };
