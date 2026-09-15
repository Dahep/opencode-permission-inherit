# AGENTS.md

Single-file opencode plugin, no build step, no package manager, no runtime dependencies. One source file (`permission-inherit.ts`), one smoke test (`test-smoke.mts`), one README.

## Commands

```sh
# Smoke tests (use node with native TS type-stripping; deno test fails on deno-specific
# module handling, deno check fails on missing @opencode-ai/plugin types — node is the harness here)
node --experimental-strip-types test-smoke.mts

# Type permission: npm i is NOT set up; the plugin imports types-only from
# @opencode-ai/plugin, which is not in node_modules. Full typecheck of
# permission-inherit.ts only works where that package is installed.
# tsc is intentionally configured (tsconfig.json, noEmit, strict) against that assumption.

# Release (see README "Trust model and release flow"):
scripts/release.sh check --tag vX.Y.Z      # preflight
scripts/release.sh create --tag vX.Y.Z --dry-run
scripts/release.sh create --tag vX.Y.Z     # --yes to skip confirmation

# Install from a pinned release (consumer side):
scripts/install.sh --tag v0.1.0 --hash <sha256-of-permission-inherit.ts> [--dir X] [--force]
```

There are no lint/format/typecheck commands that run clean in this repo as-is; verify behavior with the smoke test above.

## Architecture

`permission-inherit.ts` (single file, ~600 lines):

- Purpose: when a client grants a permission *mode* to a thread root session (stored server-side as a permission overlay on `session.permission`), inherit that grant down to subagent sessions spawned via the task tool. Fail closed. Two delivery paths: the `permission.ask` plugin hook (currently never invoked by opencode core) and bus events (`permission.asked` / `permission.updated` / `permission.replied`).
- Key sections, in file order: `Options` + `DEFAULTS` ; `wildcardMatch` / `expandHome` / `patternCandidates` (matcher mirrors opencode 1.18.30 core semantics: `*` crosses `/`, trailing ` *` also matches the bare prefix); `parseOptions` (invalid values warn and fall back); `normalizeOverlay` (accepts t3code ruleset array shape and opencode config object shape); `toAsk` (normalizes hook/bus event payloads); `PermissionInherit` plugin factory containing: `walkToRoot`/`walkDedup` (parentID walk, depth-capped, deduped, never cached so mid-session mode switches apply), `globalPermissionConfig` (deny floor from `GET /config`, 30s TTL), `configDenies`, `overlayAction` (last match wins), `isTrustedDirectory`, `decide` (the decision tree: primary-session leave-alone → deny floor → overlay allow), `respond` (POSTs reply with retry; dedupe by ask id via `answered`/`inflight` sets).

Behavior contract and security model are documented in `README.md` — that table and the "Security model" section are the spec; changes must not silently widen what the root overlay allows.

## Invariants (do not break these)

- Fail closed: any fetch/walk failure leaves the prompt pending or rejects — never approves.
- Deny floor (built-in secret patterns + global config denies) wins even under full-access overlays.
- Requests on primary sessions (no `parentID`) are never answered by the plugin.
- Replies use `once` by default (`persistence` option), so no stale grants after mode downgrades; overlay is re-read fresh per ask.
- SDK types for `session.permission` and bus events are incomplete/lagging; the loose `unknown`-based shapes with runtime validation at trust boundaries are deliberate — keep them.

## Testing

`test-smoke.mts` is a self-contained script (no assertions framework): builds a fake client, fires bus events, asserts POSTs. It uses numbered scenario blocks (1–14) with a `check()` helper. Add new behavior as a new numbered block; run via `node --experimental-strip-types`.
