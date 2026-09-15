# opencode-permission-inherit

Subagent permission inheritance for [opencode](https://opencode.ai). When a
client grants a permission mode to the primary session of a thread, this
plugin passes exactly that grant down to the subagent sessions the thread
spawns — never more, and never less than "don't hang".

## The problem

opencode clients can attach a permission overlay to a session:
`session.permission`, a ruleset of `{permission, pattern, action}` rules,
written through the authenticated server API (which does type it; only the
generated SDK types lag). (It is not part
of the SDK's typed `Session` surface in 1.18.x; see Compatibility.) Clients
use overlays to implement per-thread permission *modes* — for example "auto accept edits" (an overlay that
allows edit/write) or "full access" (a wildcard allow rule). The human grants
the mode once for the thread; the client answers prompts for the primary
session accordingly.

Sessions created through the task tool (subagents) do **not** inherit the
overlay. They fall back to the global config rules — typically `"*": "ask"`.
Two failure modes follow:

- In any client whose UI only surfaces permission prompts for the primary
  session of a thread (e.g. t3code), a subagent that needs permission blocks
  **forever** on a prompt nobody will ever see.
- Even where the prompt is visible, re-answering for every subagent defeats
  the point of granting a mode to the thread.

Tracked upstream: t3code issue
[#2778](https://github.com/pingdotgg/t3code/issues/2778) (open) and opencode
issues [#44747](https://github.com/anomalyco/opencode/issues/44747) /
[#48232](https://github.com/anomalyco/opencode/issues/48232). Note opencode's
own deny-only inheritance of parent permission rules into subagent sessions
([#26597](https://github.com/anomalyco/opencode/pull/26597)) is a deliberate
security decision; what is missing upstream is (a) a documented contract for
client mode-grants on subagent sessions and (b) hook restoration
([#7006](https://github.com/anomalyco/opencode/issues/7006)). This plugin
adds a fail-closed compat layer at that seam; it can be retired if clients
either surface subagent prompts or core inherits allow overlays natively.

## How it works

On every permission request raised by a session that has a parent (i.e. a
subagent — asks on the primary session are left to the client), the plugin:

1. **Walks to the thread root** via `session.parentID` (depth-capped, one
   walk per session even under a burst of asks). The root's current overlay
   is the thread's granted mode — read fresh on every ask, so switching the
   thread's mode mid-session takes effect immediately.
2. **Applies the deny floor.** A built-in list of secret patterns
   (`**/.env`, `**/*.key`, `**/.ssh/**`, ...) plus the `deny` rules from your
   own effective opencode config (fetched via `GET /config`) reject the
   request — even when the thread is full-access.
3. **Matches the request against the root's overlay**, rule by rule:
   permission type + wildcard pattern, last match wins, using the same
   wildcard semantics as opencode core (`*` crosses `/`, `?` matches one
   char, a trailing ` *` also matches the bare prefix, `~`/`$HOME` expand).
   Every requested pattern must be allowed.
4. **Answers the request** via `POST /session/{id}/permissions/{permissionID}`
   — the same endpoint the TUI uses — with `once` (default), `always`, or
   `reject`, per the table below.

| Situation | Default outcome |
| --- | --- |
| Root has an overlay; request matches an `allow` rule; no deny floor hit | approve (`once`) |
| Root has an overlay; request not covered | `reject` (option: leave pending) |
| Root has an overlay; deny floor hit | `reject` (always) |
| Root has no overlay ("supervised" / unmanaged thread) | leave pending (option: `reject`) |
| Root has no overlay but is under a configured `trustedDirectories` prefix | treated as full access |
| Asking session *is* the primary session | leave pending (client's UI owns it) |
| Session/config fetch fails | fail closed (pending / `reject`, never approve) |

If the thread's mode is narrowed mid-session, the next ask is evaluated
against the new overlay — nothing is cached, and `once` approvals leave no
stale grants behind on the subagent session.

## Install

No build step, one file, no runtime dependencies beyond `@opencode-ai/plugin`
(types only) and the SDK client opencode injects. Requires opencode >= 1.18.

**Install for one user (recommended):**

```sh
mkdir -p ~/.config/opencode/plugins
curl -fsSL \
  https://raw.githubusercontent.com/Dahep/opencode-permission-inherit/main/permission-inherit.ts \
  > ~/.config/opencode/plugins/permission-inherit.ts
```

opencode auto-loads it for every project with the default options.

**Install for one project:** create `.opencode/plugins/` in the project root
and copy the file there instead.

**With options** (config tuple form; the second element is passed to the
plugin):

```jsonc
{
  "plugin": [
    ["file:///home/you/.config/opencode/plugins/permission-inherit.ts", {
      "unresolved": "reject"
    }]
  ]
}
```

`~` does not expand in plugin specs, so use the absolute path or a
`file://` URL; relative specs resolve against the config file that declares
them.

## Per-project on/off

opencode's config files merge, and a plugin referenced from both the global
and a project's config loads a single instance whose options come from the
*project* config (later configs win). That gives you a global default with a
per-project off switch:

Global config (`~/.config/opencode/opencode.json`), on always:

```jsonc
{
  "plugin": [["file:///home/you/.config/opencode/plugins/permission-inherit.ts", {}]]
}
```

Project config (`opencode.json` in the project root), same file URL, disabled:

```jsonc
{
  "plugin": [["file:///home/you/.config/opencode/plugins/permission-inherit.ts", { "enabled": false }]]
}
```

Two conditions for this to work:

1. Both tuples must point at the **same specifier** (same absolute path or
   `file://` URL; `~` does not expand in plugin specs). The dedupe is by
   specifier, so different spellings would load two instances.
2. Install via config tuples, not by dropping the file into
   `~/.config/opencode/plugins/`. Auto-scanned plugin files always load and
   cannot be disabled per project.

The reverse (global off, per-project on) works the same way: leave the
global tuple out and add the tuple in the projects that want it.

## Configuration

All options are optional; invalid values are ignored with a warning in the
log file (when `log` is set).

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Turn the plugin off entirely (all hooks become no-ops). See the per-project section below. |
| `unresolved` | `"reject" \| "pending"` | `"reject"` | In a managed thread (root has an overlay), what to do when the overlay doesn't allow the request. `"reject"` gives the subagent immediate feedback; `"pending"` leaves the prompt for a human (choose this if your client surfaces subagent prompts, e.g. vanilla opencode TUI). |
| `supervised` | `"pending" \| "reject"` | `"pending"` | Threads whose root has **no** overlay. `"pending"` keeps vanilla opencode behavior untouched. `"reject"` fails subagent asks closed — useful only if your client never shows subagent prompts and you run threads without a mode grant. |
| `persistence` | `"once" \| "always"` | `"once"` | `"once"` re-evaluates every ask against the root's *current* overlay (mode downgrades apply immediately). `"always"` persists the allow rule on the subagent's session, cutting event traffic on long full-access threads at the cost of stale grants after a downgrade. |
| `trustedDirectories` | `string[]` | `[]` | Directory prefixes (`~` and `$HOME` expand) whose threads are treated as full-access when the root has no overlay. Escape hatch for clients that manage threads without writing overlays — t3code users with legacy threads can set `["~/.t3/worktrees/"]`. |
| `honorGlobalDeny` | `boolean` | `true` | When true, `deny` rules from the effective opencode config reject matching requests even if the root overlay allows them. Set `false` only if "full access" in your setup is meant literally. |
| `denyPatterns` | `string[]` | see below | Additional hard denies, always rejected under inheritance. Each entry is `"glob"` (any permission type) or `"type:glob"` (e.g. `"read:**/.env"`). Replaces the built-in list when set. |
| `maxDepth` | `number` | `16` | Max `parentID` hops when walking to the thread root. |
| `log` | `string \| false` | `false` | Append every decision (with reason) to this file. No secrets are logged — only permission types, patterns, session ids, and decision reasons. |

Built-in `denyPatterns`:

```
**/.env  **/.env.*  **/secrets/**  **/*.key  **/*.pem  **/*.p12
**/credentials*  **/token*  **/api-key*  **/.aws/**  **/.ssh/**
```

Example — t3code-style client, legacy worktree threads, verbose:

```jsonc
["file:///home/you/.config/opencode/plugins/permission-inherit.ts", {
  "trustedDirectories": ["~/.t3/worktrees/"],
  "supervised": "reject",
  "log": "/tmp/permission-inherit.log"
}]
```

## Security model

**Ground truth is server-side state.** The plugin trusts the root session's
overlay because it is stored by the opencode server and written through the
authenticated API (e.g. by your client when you pick a mode). The plugin only
ever *reads* overlays; the reply endpoint it calls can answer a pending
permission request but cannot edit overlays.

**Subagents never exceed the root's mode.** A request is approved only if the
root's own overlay allows it. A full-access root inherits full access; an
"edits only" root inherits edits only; everything else is rejected (default)
so the subagent reports back instead of hanging.

**Deny rules survive inheritance.** Granting a thread "full access" means
"stop prompting me", not "exfiltrate my credentials". The built-in secret
patterns and your own config denies reject matching requests regardless of
the overlay. The asymmetry is deliberate: a leaked `.env` is unrecoverable, a
wrongly blocked read is one retry away. Both layers are overridable
(`denyPatterns`, `honorGlobalDeny`).

**Fail closed.** If the session walk or the config fetch fails, the plugin
never approves: it leaves the prompt pending or rejects per `unresolved`.

**The opencode server API is not a security boundary.** Any local process
that can reach the server port can create sessions and answer permission
requests — including this plugin. Keep the server bound to localhost; do not
expose it. This plugin narrows, never widens, what a caller with server
access could already do.

**Hook vs. bus.** When core starts invoking the `permission.ask` hook, the
same decision logic runs there (`allow`/`deny` statuses); until then the bus
path does the work. Both paths dedupe by request id.

## Compatibility & known issues

- Requires opencode >= 1.18 (developed against 1.18.30).
- The `permission.ask` plugin hook is declared in `@opencode-ai/plugin` but,
  as of 1.18.x, **never invoked by core** (opencode issues
  [#7006](https://github.com/anomalyco/opencode/issues/7006),
  [#9229](https://github.com/anomalyco/opencode/issues/9229),
  [#28066](https://github.com/anomalyco/opencode/issues/28066)). The plugin
  therefore does its work on bus events (`permission.asked`,
  `permission.updated`) and keeps the hook wired for when core restores it.
- `permission.asked` is **not in the SDK's `Event` union**; the types are
  incomplete, the event still arrives at runtime. The plugin casts at that
  boundary deliberately.
- `session.permission` (the overlay) is **not part of the generated SDK's
  `Session` type** as of 1.18.30; the server API schema does type it (session
  create/update accept a permission ruleset, PATCH is merge-based), the
  generated SDK types just lag the server. The plugin treats it as `unknown`
  and validates the shape at runtime.
- Current core emits only `permission.asked` and `permission.replied` on the
  event stream; the emitted-before `permission.updated` survives only in
  older 1.18.x builds and in 1.18.30's stale generated SDK union. The plugin
  listens to both defensively.
- Overlay evaluation assumes core's rule semantics: last matching rule wins,
  wildcard matcher as in core (`*` crosses `/`). Verified against the
  1.18.30 core implementation.
- If the asking session was deleted between the ask and the reply, the reply
  fails silently (the prompt is gone anyway).

## FAQ

**Does this change anything for vanilla opencode (TUI) users?**
Only if your sessions carry overlays. No overlay → the plugin leaves every
prompt alone (`supervised: "pending"` default). If you do use overlays and
want subagent prompts shown to you, set `unresolved: "pending"`.

**Does it answer prompts on my primary session?**
No. Sessions without a `parentID` are always left to the client's own UI.

**Why `once` and not `always` for approvals?**
`always` writes a persistent allow rule onto the subagent session; if you
then downgrade the thread's mode, the subagent keeps the stale grant. `once`
re-evaluates each ask against the root's *current* overlay. Set
`persistence: "always"` if you prefer fewer round-trips on threads whose mode
never changes.

**What if two asks race?** Requests are deduped by permission id (in-flight
and answered sets); walks are deduped per session. Duplicate bus events and a
future double delivery via hook + bus resolve to one reply; a late duplicate
reply fails harmlessly server-side.

**How do I see what it's doing?** Set `log: "/tmp/permission-inherit.log"`.
Every line is `timestamp <path>-<approved(...)|rejected> <type> <patterns>
for <session> [<reason>]`.

## Trust model and release flow

Releases are the trust anchor. Tags are meant for scripts that install this
plugin, and each release ships a `SHA256SUMS` asset. Consumers who install
automatically should pin a tag and verify the hash before placing the file in
a plugins directory; the hash line in the consuming repo's diff is then the
only thing a reviewer has to trust.

Example (the pins below live in the installer script, not the plugin repo):

```sh
wanted="v0.1.0"
hash="48756392a405094817dc15ef881bc57dd055649cba177077ede824344984138d"
curl -fsSL "https://raw.githubusercontent.com/Dahep/opencode-permission-inherit/$wanted/permission-inherit.ts" -o "$tmp"
printf '%s  %s\n' "$hash" "$tmp" | sha256sum --check --strict --quiet || { echo "abort: hash mismatch"; exit 1; }
```

Why pin instead of tracking `main`: the file is executed inside opencode's
plugin context and can auto-approve permission asks, so "whatever main
contains right now" is a standing offer to future account compromise.
Tracking `main` means an attacker who takes over the repo gets the next
install. Pinning means they get nothing until you actively re-pin.

Making a release (maintainer side — `scripts/release.sh`):

```sh
scripts/release.sh check --tag vX.Y.Z        # preflight, never mutates
scripts/release.sh create --tag vX.Y.Z --dry-run
scripts/release.sh create --tag vX.Y.Z       # or add --yes to skip confirmation
```

`create` runs every preflight (clean tree, on `main`, in sync with origin,
checksums match, tag free), tags, pushes, creates the GitHub release with
`permission-inherit.ts` and `SHA256SUMS` as assets, then re-downloads the
assets and verifies them against the tagged file. It is idempotent: re-running
after a partial failure skips the steps already done.

Consumers install with `scripts/install.sh`, which enforces the pin:

```sh
scripts/install.sh --tag v0.1.0 \
  --hash 48756392a405094817dc15ef881bc57dd055649cba177077ede824344984138d \
  [--dir ./.opencode/plugins] [--force]
```

The installer downloads only from a pinned release, fails closed on hash
mismatch, and no-ops if the pinned version is already installed.

Upgrading a pinned installer is a two-line edit (tag + hash) in one commit;
the diff is the review unit. Untagged commits on `main` are unreleased: a
new `main` push alone changes nothing for anyone pinning.
