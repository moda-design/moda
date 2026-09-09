// Which stage owns a finding.
//
// EXTRACTED so a test can call it. `iterate.mjs` is a script — importing it
// runs a whole iteration — so while this lived there the only way to check the
// routing was to grep the source, and the guard that did could pass while the
// routing was wrong: it asserted `'shorten_narration'` appeared in the
// condition, which stayed true the entire time the fix was being handed to a
// stage that could not act on it (ENG-6137).

/**
 * The stage that owns a finding, from its declared stage, its fix, or its type.
 *
 * A finding that names its own `stage` wins outright — inference is a fallback
 * for model-authored findings, and inference is what misrouted narration.
 */
function ownerOf(issue) {
  if (issue.stage) return issue.stage;                       // countable ones say so
  if (issue.fix === 'speed_up') return 'pacing';
  // NOT pacing. The pacing stage's only action is a compress-speed bump, and a
  // narration span is kept at 1x at EVERY speed — so routing it there produced
  // a round that re-cut, moved nothing, counted itself as work, and paid a
  // metered render for the privilege, until the plateau detector gave up.
  if (issue.fix === 'shorten_narration') return 'narration';
  if (issue.fix === 'disable_zoom' || issue.type === 'result_cropped') return 'camera';
  if (issue.type === 'no_visible_change' || issue.type === 'blank_screen') return 'pacing';
  return 'flow';
}

module.exports = { ownerOf };
