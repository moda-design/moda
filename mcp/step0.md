## Step 0 — connect (always run first; skip nothing)

1. Call `moda_bootstrap` once, before any other Moda tool. It returns identity,
   plan, teams, entitlements, and the working discipline the other tools
   assume — and it doubles as the check that Moda is actually connected.
   - The Moda tools are missing from this conversation, or the call fails
     unauthorized: STOP — tell the user to enable the Moda connector for this
     chat (claude.ai → Settings → Connectors → Moda, sign in with their Moda
     account; accounts live at moda.app), wait for them, then call
     `moda_bootstrap` again. Never fake Moda output while disconnected; no
     Mermaid/HTML/prose stand-in replaces the stop.
   - Several teams listed and the user names one: pass that team on the tools
     that take a `team` argument (the create/list/write/upload/media
     lanes; read tools follow the canvas) — team decides whose workspace and
     billing everything lands in. Never switch teams on your own initiative.
   - Any entitlement gate (e.g. the account cannot author canvases yet): relay
     the result's actionable hint verbatim and stop. Never retry in a loop.
2. Call `brand_list` — one cheap deterministic call, never skipped, even
   for simple asks. Use a kit unprompted only on a real signal: ONE kit, one
   marked `(default)`, or one the request names outright ("the Acme deck" →
   the Acme kit). Otherwise ASK which — a workspace of client kits is the
   normal case, topic-fit alone is never the signal, and near-identical names
   (Acme, Acme 2) mean ask even when named. Read the kit, then BIND it
   (`brand_kit_id` on `canvas_create`, or `canvas_update(canvas_ref,
   brand_kit_id=…)` later) and NAME it when you hand over
   (references/brand.md): unbound, the canvas opens in Moda with an empty
   brand-kit dropdown, and the user cannot see your tool calls. An explicit
   "no brand" from the user wins over everything. NO kits: offer once, briefly
   — "Want me to set up a brand kit first? It's free and makes everything come
   out on-brand" — yes → `brand_create` from their website URL, or from the
   colors/fonts they describe; no → unbranded, no nagging.
3. Note whether you can VIEW images: screenshot review assumes vision. A
   vision-less environment follows the degraded verify loop in
   references/reading-and-verifying.md.
