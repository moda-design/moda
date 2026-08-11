# moda canvas edit — sandboxed JS edit reference (offline copy)

`moda canvas edit CANVAS_REF --file edit.js [--page PAGE_ID] [--screenshot out.jpg]` runs one
synchronous JS batch against the canvas. It requires a revision token (cached from your last
`moda canvas read`, or `--revision`). `--screenshot PATH` captures the canvas's current page
right after the commit — the same files `moda canvas screenshot -o PATH` would write, in one
invocation. An edit program can land on any page and `--page` only scopes the read snapshot,
so it never steers the capture; a capture failure never changes the edit's exit code.

## The sandbox

- One synchronous `code` string (16,384-char cap, ~100 ms budget). Blocked: `eval`,
  `Function`, `import`, `fetch`, `await`/`async`, DOM, timers.
- Read-only pre-mutation snapshots: `nodes`, `pages`, `variables`, `animations`, `comments`.
- Verbs: `create(type, props)`, `duplicate`, `update(id, props)`, `reorder`, `group`,
  `ungroup`, `movePages`, `details(id)`, `select`, `print`/`log`/`inspect`; frozen `Math`.
- `create` types: `rectangle, ellipse, container, richtext, line, star, polygon, path,
  group, table, image` plus `page`/`variable`/`animation`/`comment` (friendly aliases work).
- `remove()` THROWS — deletion is the standalone verb: `moda canvas delete-items REF n7 n9`.

## Failure semantics

- Rejected programs (parse failure, blocked construct, runtime error) are ATOMIC: nothing
  applied, exit 2 with `{line, column, code_excerpt}` — fix and re-run safely.
- Applied-with-skips exits 0 with `requires_repair: true` and
  `operation_counts.skipped > 0` (per-call op limits: create 500, update 10,000). Read the
  skipped bucket and author a follow-up; never re-run the same batch.
- A stale revision fails BEFORE any mutation with `stale_revision` (exit 5): re-read
  (`moda canvas read`), then re-apply.

## Patterns

```js
// Update by short id from the last read
update('n7', { fill: '#0B5FFF', cornerRadius: 12 });

// Find and batch-update
for (const n of nodes.filter((n) => n.type === 'richtext')) {
  update(n.id, { fontFamily: 'Inter' });
}

// Create against a page from the read legend
create('rectangle', { pageId: 'p_a', x: 40, y: 40, width: 200, height: 120, fill: '#111' });
```

Short ids (`n7`, `p_a`, `img1`) come from `moda canvas read` and are session-scoped per
(user, canvas); submitting ids absent from your last read triggers a stderr warning and
usually means you should re-read.
