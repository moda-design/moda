## Step 0 — doctor (always run first; skip nothing)

1. Run `moda doctor --json`. It verifies CLI version compatibility, auth state,
   API reachability, and account entitlements in one call.
   - `moda` is not on PATH, the CLI is below this skill's compatibility floor,
     or doctor reports an update is required: STOP. Show the user the exact
     pinned install/upgrade command doctor prints (or the one in this repo's
     INSTALL.md when the CLI is missing entirely) and wait for them to run it.
     Never install or update anything yourself, never pipe curl to sh, and
     never use sudo.
   - `authenticated: false`: tell the user to run `moda auth login` (opens the
     browser to mint a scoped key; the credential goes to the OS keychain — on
     headless machines use `moda auth login --paste`, or set `MODA_API_KEY`).
     Never ask for, print, or handle keys or tokens — no CLI verb reveals
     them. Do not proceed unauthenticated and do not loop on auth errors.
   - Any entitlement gate (e.g. the account cannot author canvases yet):
     relay doctor's actionable hint verbatim and stop. Never retry in a loop.
2. Run `moda account status --json`. Note the org, plan, and remaining
   credits (metered verbs spend them; deterministic authoring never does).
3. Run `moda brand list`. If the account has at least one brand kit, on-brand
   is the default: read the kit before designing (see references/brand.md).
   With several kits, use the one the listing marks as default unless the
   user names another — never guess between clients' kits; ask if no default
   exists and the choice is unclear. An explicit "no brand" from the user
   wins over everything.
