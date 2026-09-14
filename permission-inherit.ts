/**
 * opencode-permission-inherit
 * ===========================
 *
 * Subagent permission inheritance for opencode.
 *
 * Some opencode clients (e.g. t3code) let the human grant a permission *mode*
 * to the primary session of a thread ("auto accept edits", "full access",
 * ...). The grant is stored server-side as a permission overlay on that root
 * session (`session.permission`, a ruleset of `{permission, pattern, action}`
 * rules). Sessions spawned through the
 * task tool do NOT inherit the overlay, so subagents fall back to the global
 * config rules ("ask") and — if the client only surfaces permission prompts
 * for the primary session — block forever on prompts nobody will ever see.
 *
 * This plugin adds a fail-closed compat layer: for every permission request
 * raised by a *subagent* session it walks the `parentID` chain to the thread
 * root, reads the root's current overlay, and auto-answers the request with
 * exactly what the root's mode grants — never more:
 *
 *   - The request must match an `allow` rule in the root's overlay
 *     (permission type + wildcard pattern, last match wins, matcher verified
 *     against opencode 1.18.30 core). A wildcard overlay (`*`/`*`) inherits
 *     as full access; a narrower overlay inherits narrowly.
 *   - Deny rules survive inheritance: a built-in list of secret patterns
 *     plus the user's own global config denies (fetched from `GET /config`)
 *     reject the request even when the root is full-access.
 *   - Anything the overlay does not allow is rejected immediately (default;
 *     configurable) so subagents get feedback instead of hanging.
 *
 * Threads whose root has no overlay are left untouched by default: vanilla
 * opencode shows subagent prompts itself, so the plugin stays out of the way.
 *
 * Two delivery paths, because upstream is in flux (opencode issues
 * #7006/#9229/#28066 — as of 1.18.x the `permission.ask` hook is declared in
 * @opencode-ai/plugin but never invoked by core):
 *   1. "permission.ask" hook    — wired for when core starts calling it.
 *   2. Bus event "permission.asked" (plus "permission.replied" for human-race
 *      protection) — emitted today by every pending ask. "permission.updated"
 *      is legacy (older 1.18.x builds and 1.18.30's stale generated union
 *      carry it; current core emits asked/replied), kept defensively.
 *      Answered via POST /session/{id}/permissions/{permissionID}, the same
 *      endpoint the TUI and t3code use.
 */

import { homedir } from "node:os"
import { appendFile } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Action = "allow" | "ask" | "deny"

type OverlayRule = { permission: string; pattern: string; action: Action }

/**
 * Session as returned by `client.session.get`. The per-session permission
 * overlay (`permission`) IS a typed server-API field (session create/update
 * schemas accept a PermissionV1.Ruleset; PATCH merges it); only the generated
 * SDK types lag the server schema (SessionUpdateData exposes just `title` as
 * of @opencode-ai/sdk 1.18.30), hence this loose shape at the trust boundary.
 */
type SessionLike = {
  id?: string
  directory?: string
  parentID?: string
  permission?: unknown
}

/** A permission request, normalized from the hook input or a bus event. */
type Ask = {
  id: string
  sessionID: string
  /** Permission type, e.g. "read" | "edit" | "write" | "bash" | ... */
  type: string
  /** Requested patterns; `[""]` when the request carries none. */
  patterns: string[]
}

type Decision = { kind: "allow" | "reject" | "pending"; reason: string }

type Options = {
  /** Turn the plugin off entirely (no-op hooks). Lets a project's own opencode.json disable a globally installed instance. */
  enabled: boolean
  /** Managed thread, request not allowed by the root overlay: reject or leave pending. */
  unresolved: "reject" | "pending"
  /** Thread with no root overlay at all: leave pending (default) or reject subagent asks. */
  supervised: "pending" | "reject"
  /** Response used when approving: "once" re-evaluates every ask; "always" persists the rule on the subagent session. */
  persistence: "once" | "always"
  /** Directory prefixes whose threads are treated as full-access even without an overlay (legacy escape hatch). */
  trustedDirectories: string[]
  /** Honor "deny" rules from the effective global config even when the root overlay allows the request. */
  honorGlobalDeny: boolean
  /** Additional hard denies: "glob" (any type) or "type:glob". Always reject, even under full access. */
  denyPatterns: string[]
  /** Max parentID hops when walking to the thread root. */
  maxDepth: number
  /** Append decisions to this file; false disables logging. */
  log: string | false
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * High-value secret patterns that must survive even a full-access grant.
 * Mirrors the deny lists opencode docs recommend; the blast radius of leaking
 * a credential is unrecoverable, a wrongly blocked read is one retry away.
 */
const DEFAULT_DENY_PATTERNS = [
  "**/.env",
  "**/.env.*",
  "**/secrets/**",
  "**/*.key",
  "**/*.pem",
  "**/*.p12",
  "**/credentials*",
  "**/token*",
  "**/api-key*",
  "**/.aws/**",
  "**/.ssh/**",
]

const DEFAULTS: Options = {
  enabled: true,
  unresolved: "reject",
  supervised: "pending",
  persistence: "once",
  trustedDirectories: [],
  honorGlobalDeny: true,
  denyPatterns: DEFAULT_DENY_PATTERNS,
  maxDepth: 16,
  log: false,
}

// ---------------------------------------------------------------------------
// Wildcard matching — verified against opencode 1.18.30 core
// (packages/opencode/src/util/wildcard): both sides get `\` -> `/`, then the
// pattern is regex-escaped, `*` -> `.*` (crosses `/`, dotall), `?` -> `.`,
// and a trailing " *" becomes an optional suffix so "git status *" also
// matches the bare "git status". Config rules additionally expand a leading
// "~"/"$HOME" to the home directory (core's fromConfig transform).
// ---------------------------------------------------------------------------

function wildcardMatch(value: string, pattern: string): boolean {
  const v = value.replaceAll("\\", "/")
  let p = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (p.endsWith(" .*")) p = p.slice(0, -3) + "( .*)?"
  return new RegExp(`^${p}$`, "s").test(v)
}

function expandHome(pattern: string): string {
  if (pattern.startsWith("~/")) return homedir() + pattern.slice(1)
  if (pattern === "~") return homedir()
  if (pattern.startsWith("$HOME/")) return homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return homedir() + pattern.slice(5)
  return pattern
}

/**
 * The forms a requested pattern is matched against: as given, home-expanded,
 * and — for relative paths — resolved against the asking session's directory.
 */
function patternCandidates(pattern: string, directory?: string): string[] {
  const out = new Set<string>()
  const add = (value: string) => {
    out.add(value)
    out.add(expandHome(value))
  }
  add(pattern)
  if (pattern !== "" && directory) {
    const expanded = expandHome(pattern)
    if (!isAbsolute(expanded)) add(join(directory, pattern))
  }
  return [...out]
}

// ---------------------------------------------------------------------------
// Option parsing (plugins receive options from the ["name", {opts}] tuple in
// the opencode config's `plugin` array; invalid values fall back to defaults)
// ---------------------------------------------------------------------------

function parseOptions(raw: unknown): { options: Options; warnings: string[] } {
  const warnings: string[] = []
  const options: Options = { ...DEFAULTS, trustedDirectories: [], denyPatterns: [...DEFAULT_DENY_PATTERNS] }
  if (raw == null) return { options, warnings }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("plugin options must be an object; ignoring")
    return { options, warnings }
  }
  const o = raw as Record<string, unknown>
  const pick = <T extends string>(key: string, allowed: readonly T[], current: T): T => {
    const v = o[key]
    if (v === undefined) return current
    if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T
    warnings.push(`invalid ${key}: ${JSON.stringify(v)}; using ${JSON.stringify(current)}`)
    return current
  }
  if (o.enabled !== undefined) {
    if (typeof o.enabled === "boolean") options.enabled = o.enabled
    else warnings.push("invalid enabled: expected boolean; ignoring")
  }
  options.unresolved = pick("unresolved", ["reject", "pending"] as const, options.unresolved)
  options.supervised = pick("supervised", ["pending", "reject"] as const, options.supervised)
  options.persistence = pick("persistence", ["once", "always"] as const, options.persistence)
  if (o.trustedDirectories !== undefined) {
    if (Array.isArray(o.trustedDirectories) && o.trustedDirectories.every((d) => typeof d === "string")) {
      options.trustedDirectories = o.trustedDirectories as string[]
    } else warnings.push("invalid trustedDirectories: expected string[]; ignoring")
  }
  if (o.honorGlobalDeny !== undefined) {
    if (typeof o.honorGlobalDeny === "boolean") options.honorGlobalDeny = o.honorGlobalDeny
    else warnings.push("invalid honorGlobalDeny: expected boolean; ignoring")
  }
  if (o.denyPatterns !== undefined) {
    if (Array.isArray(o.denyPatterns) && o.denyPatterns.every((d) => typeof d === "string")) {
      options.denyPatterns = o.denyPatterns as string[]
    } else warnings.push("invalid denyPatterns: expected string[]; ignoring")
  }
  if (o.maxDepth !== undefined) {
    if (typeof o.maxDepth === "number" && Number.isInteger(o.maxDepth) && o.maxDepth > 0) options.maxDepth = o.maxDepth
    else warnings.push("invalid maxDepth: expected positive integer; ignoring")
  }
  if (o.log !== undefined) {
    if (o.log === false || typeof o.log === "string") options.log = o.log
    else warnings.push("invalid log: expected string | false; ignoring")
  }
  return { options, warnings }
}

// ---------------------------------------------------------------------------
// Overlay + ask normalization (runtime data crosses the type boundary here)
// ---------------------------------------------------------------------------

const ACTIONS: ReadonlySet<string> = new Set(["allow", "ask", "deny"])

function toAction(value: unknown): Action | undefined {
  return typeof value === "string" && ACTIONS.has(value) ? (value as Action) : undefined
}

/**
 * Accepts the t3code ruleset shape `[{permission, pattern, action}]` and,
 * defensively, the opencode config shape (`{read: {"~/x/**": "allow"}, ...}`).
 * Unknown entries are dropped. Returns [] for "no overlay".
 */
function normalizeOverlay(raw: unknown): OverlayRule[] {
  const rules: OverlayRule[] = []
  const push = (permission: unknown, pattern: unknown, action: unknown) => {
    const a = toAction(action)
    if (typeof permission !== "string" || !a) return
    for (const p of Array.isArray(pattern) ? pattern : [pattern]) {
      if (typeof p === "string") rules.push({ permission, pattern: p, action: a })
    }
  }
  if (Array.isArray(raw)) {
    for (const r of raw) {
      if (r && typeof r === "object") {
        const rule = r as Record<string, unknown>
        push(rule.permission, rule.pattern, rule.action)
      }
    }
  } else if (raw && typeof raw === "object") {
    for (const [permission, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") push(permission, "*", value)
      else if (value && typeof value === "object") {
        for (const [pattern, action] of Object.entries(value as Record<string, unknown>)) push(permission, pattern, action)
      }
    }
  }
  return rules
}

/**
 * The SDK's Permission type is `{id, type, pattern?, sessionID, ...}`; older
 * shapes floating around use `permission`/`patterns`. Accept both.
 */
function toAsk(raw: unknown): Ask | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const p = raw as Record<string, unknown>
  if (typeof p.id !== "string" || typeof p.sessionID !== "string") return undefined
  const type = typeof p.type === "string" ? p.type : typeof p.permission === "string" ? p.permission : ""
  const rawPatterns = p.pattern ?? p.patterns
  const patterns = Array.isArray(rawPatterns)
    ? rawPatterns.filter((s): s is string => typeof s === "string")
    : typeof rawPatterns === "string"
      ? [rawPatterns]
      : [""]
  if (patterns.length === 0) patterns.push("")
  return { id: p.id, sessionID: p.sessionID, type, patterns }
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

export const PermissionInherit: Plugin = async ({ client }, rawOptions) => {
  const { options, warnings } = parseOptions(rawOptions)
  if (!options.enabled)
    return {
      // Disabled per registration (e.g. a project's opencode.json re-registering
      // this same file URL with enabled:false, which wins over the global tuple).
      // Returning explicit no-op hooks keeps the plugin in the hook list without
      // touching any permission decision.
      "permission.ask": async () => {},
      event: async () => {},
    }

  function log(message: string): void {
    if (!options.log) return
    appendFile(options.log, `${new Date().toISOString()} ${message}\n`).catch(() => {})
  }
  for (const w of warnings) log(`option-warning ${w}`)

  const trustedDirs = options.trustedDirectories.map((d) => {
    // Normalize before comparing so trailing slashes, "." segments, and
    // spelling differences in the configured prefix cannot bypass containment.
    return resolve(expandHome(d.endsWith("/") ? d : `${d}/`))
  })
  // "type:glob" scopes the deny to one permission type; a plain "glob"
  // applies to all types. A prefix containing "/" (e.g. "$HOME/x") is a glob.
  const denyList = options.denyPatterns.map((entry) => {
    const i = entry.indexOf(":")
    const scoped = i > 0 && !entry.slice(0, i).includes("/")
    return {
      permission: scoped ? entry.slice(0, i) : "",
      pattern: expandHome(scoped ? entry.slice(i + 1) : entry),
    }
  })

  // -- thread root resolution ------------------------------------------------
  // No result caching: the client can change the thread's mode mid-session
  // (t3code's mode switcher rewrites the root overlay), so every ask
  // re-reads the overlay. Walks for the same session are deduped in flight;
  // a burst of asks from one subagent costs one walk.

  type Walk = { asking: SessionLike; root: SessionLike }

  async function walkToRoot(sessionID: string): Promise<Walk | undefined> {
    let id: string | undefined = sessionID
    let asking: SessionLike | undefined
    let current: SessionLike | undefined
    for (let depth = 0; id && depth < options.maxDepth; depth++) {
      let session: SessionLike | undefined
      try {
        session = (await client.session.get({ path: { id } })).data as SessionLike | undefined
      } catch {
        return undefined // fail closed: cannot establish management, leave the prompt alone
      }
      if (!session || typeof session !== "object") return undefined
      if (!asking) asking = session
      current = session
      id = typeof session.parentID === "string" ? session.parentID : undefined
    }
    return asking && current ? { asking, root: current } : undefined
  }

  const walks = new Map<string, Promise<Walk | undefined>>()
  function walkDedup(sessionID: string): Promise<Walk | undefined> {
    const existing = walks.get(sessionID)
    if (existing) return existing
    const pending = walkToRoot(sessionID).finally(() => walks.delete(sessionID))
    walks.set(sessionID, pending)
    return pending
  }

  // -- global config deny floor ----------------------------------------------
  // Fetched lazily, cached briefly; on fetch failure the floor is "unknown"
  // and nothing is auto-allowed (fail closed).

  const CONFIG_TTL_MS = 30_000
  let configCache: { at: number; permission: unknown } | undefined
  let configInflight: Promise<unknown> | undefined

  async function globalPermissionConfig(): Promise<unknown> {
    if (!options.honorGlobalDeny) return {}
    if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.permission
    if (!configInflight) {
      configInflight = (async () => {
        try {
          const res = await client.config.get({})
          const permission = (res.data as { permission?: unknown } | undefined)?.permission
          configCache = { at: Date.now(), permission: permission ?? {} }
          return configCache.permission
        } catch (err) {
          log(`config-get-failed ${String(err)}`)
          return undefined
        } finally {
          configInflight = undefined
        }
      })()
    }
    return configInflight
  }

  /** True if the effective global config denies this (type, pattern). */
  function configDenies(configPermission: unknown, type: string, candidates: string[]): boolean {
    if (!configPermission || typeof configPermission !== "object") return false
    // A top-level "*" *key* (a catch-all map) can stack with a per-type map;
    // check both and let deny win only if the effective action is deny.
    const denies = (anyType: string) => {
      const entry = (configPermission as Record<string, unknown>)[anyType]
      if (typeof entry === "string") return entry === "deny"
      if (!entry || typeof entry !== "object") return false
      let matched: string | undefined
      let fallback: string | undefined
      for (const [pattern, action] of Object.entries(entry as Record<string, unknown>)) {
        if (typeof action !== "string") continue
        if (pattern === "*") {
          fallback = action
          continue
        }
        const expanded = expandHome(pattern)
        if (candidates.some((c) => wildcardMatch(c, expanded))) matched = action // last match wins
      }
      return (matched ?? fallback) === "deny"
    }
    return type !== "*" ? denies(type) || denies("*") : denies("*")
  }

  // -- decisions ---------------------------------------------------------------

  /** Last matching overlay rule wins; `*` matches any type / any pattern. */
  function overlayAction(rules: OverlayRule[], type: string, candidates: string[]): Action | undefined {
    let action: Action | undefined
    for (const rule of rules) {
      if (rule.permission !== "*" && rule.permission !== type) continue
      const expanded = expandHome(rule.pattern)
      if (candidates.some((c) => wildcardMatch(c, expanded))) action = rule.action
    }
    return action
  }

  function isTrustedDirectory(directory: string | undefined): boolean {
    if (!directory) return false
    const actual = resolve(directory)
    return trustedDirs.some((dir) => (actual === dir || actual.startsWith(`${dir}${sep}`)))
  }

  async function decide(ask: Ask): Promise<Decision> {
    const walk = await walkDedup(ask.sessionID)
    if (!walk) return { kind: "pending", reason: "walk-failed" }

    // Asks on the primary session itself are the client's business (its UI
    // surfaces them); the plugin only inherits into subagents.
    if (!walk.asking.parentID || walk.asking.id === walk.root.id) {
      return { kind: "pending", reason: "primary-session" }
    }

    let overlay = normalizeOverlay(walk.root.permission)
    let source = "root-overlay"
    if (overlay.length === 0 && (isTrustedDirectory(walk.root.directory) || isTrustedDirectory(walk.asking.directory))) {
      overlay = [{ permission: "*", pattern: "*", action: "allow" }]
      source = "trusted-directory"
    }

    // No overlay anywhere: unmanaged thread ("supervised" in t3code terms).
    if (overlay.length === 0) {
      return options.supervised === "reject"
        ? { kind: "reject", reason: "supervised-no-overlay" }
        : { kind: "pending", reason: "unmanaged-thread" }
    }

    // Deny floor: built-in/plugin secret patterns, then the user's own global
    // config denies. Both reject even when the overlay would allow.
    const directory = typeof walk.asking.directory === "string" ? walk.asking.directory : undefined
    const candidatesByPattern = ask.patterns.map((p) => patternCandidates(p, directory))
    for (const candidates of candidatesByPattern) {
      for (const deny of denyList) {
        if (deny.permission && deny.permission !== ask.type) continue
        if (candidates.some((c) => wildcardMatch(c, deny.pattern))) {
          return { kind: "reject", reason: `deny-pattern:${deny.pattern}` }
        }
      }
    }

    const configPermission = await globalPermissionConfig()
    if (configPermission === undefined) {
      // Cannot verify the deny floor -> never auto-allow.
      return options.unresolved === "reject"
        ? { kind: "reject", reason: "config-unavailable" }
        : { kind: "pending", reason: "config-unavailable" }
    }
    for (const candidates of candidatesByPattern) {
      if (configDenies(configPermission, ask.type, candidates)) {
        return { kind: "reject", reason: `global-config-deny:${ask.type}` }
      }
    }

    // Inheritance: every requested pattern must be allowed by the overlay.
    const allowed = candidatesByPattern.every((candidates) => overlayAction(overlay, ask.type, candidates) === "allow")
    if (allowed) return { kind: "allow", reason: `inherited:${source}` }

    return options.unresolved === "reject"
      ? { kind: "reject", reason: `not-in-overlay:${ask.type}` }
      : { kind: "pending", reason: `not-in-overlay:${ask.type}` }
  }

  // -- reply plumbing ----------------------------------------------------------

  const ANSWERED_CAP = 4096
  const answered = new Set<string>()
  const inflight = new Map<string, Promise<void>>()

  function markAnswered(id: string): void {
    if (answered.size >= ANSWERED_CAP) {
      const oldest = answered.values().next().value
      if (oldest !== undefined) answered.delete(oldest)
    }
    answered.add(id)
  }

  async function respond(ask: Ask, decision: "allow" | "reject", via: string, reason: string): Promise<void> {
    const response = decision === "allow" ? options.persistence : "reject"
    // A transient reply failure must not strand a subagent on a prompt the
    // client will never show, so retry briefly before giving up. The id is
    // only marked answered after success (or a definitive failure): the
    // in-flight dedupe prevents a duplicate event from double-POSTing while
    // we work, and an unmarked id lets a refired event try again later.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await client.postSessionIdPermissionsPermissionId({
          path: { id: ask.sessionID, permissionID: ask.id },
          body: { response },
        })
        markAnswered(ask.id)
        log(`${via}-${decision === "allow" ? `approved(${response})` : "rejected"} ${ask.type} ${JSON.stringify(ask.patterns)} for ${ask.sessionID} [${reason}]`)
        return
      } catch (err) {
        // Already answered (by the client, the hook path, or a duplicate
        // event) counts as success: nothing to retry.
        if (attempt === 3 && err) {
          markAnswered(ask.id)
          log(`reply-failed ${ask.id} ${String(err)}`)
          return
        }
        await new Promise((r) => setTimeout(r, attempt * 250))
      }
    }
  }

  function handle(raw: unknown, via: string): void {
    const ask = toAsk(raw)
    if (!ask || answered.has(ask.id) || inflight.has(ask.id)) return
    const pending = (async () => {
      const decision = await decide(ask)
      if (decision.kind !== "pending") await respond(ask, decision.kind, via, decision.reason)
    })()
      .catch((err) => log(`error ${String(err)}`))
      .finally(() => inflight.delete(ask.id))
    inflight.set(ask.id, pending)
  }

  return {
    // Declared in @opencode-ai/plugin but, as of opencode 1.18.x, never
    // invoked by core (issues #7006/#9229/#28066). Wired for when it is.
    "permission.ask": async (input, output) => {
      try {
        const ask = toAsk(input)
        if (!ask) return
        const decision = await decide(ask)
        if (decision.kind === "allow") output.status = "allow"
        else if (decision.kind === "reject") output.status = "deny"
      } catch (err) {
        log(`hook-error ${String(err)}`)
      }
    },
    event: async ({ event }) => {
      try {
        const type = (event as { type?: string }).type
        if (type === "permission.asked" || type === "permission.updated") {
          handle((event as { properties?: unknown }).properties, type)
        } else if (type === "permission.replied") {
          // A human (or another consumer) answered: never race them, so the
          // id joins the answered set, not leaves it.
          const props = (event as { properties?: { permissionID?: unknown } }).properties
          if (props && typeof props.permissionID === "string") markAnswered(props.permissionID)
        }
      } catch (err) {
        log(`event-error ${String(err)}`)
      }
    },
  }
}

export default PermissionInherit
