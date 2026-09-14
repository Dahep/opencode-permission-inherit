import { PermissionInherit } from "./permission-inherit.ts"

type Session = { id: string; directory: string; parentID?: string; permission?: unknown }

function makeClient(sessions: Record<string, Session>, configPermission: unknown, opts?: { configFails?: boolean }) {
  const posts: Array<{ id: string; permissionID: string; response: string }> = []
  const client = {
    session: {
      get: async ({ path }: { path: { id: string } }) => {
        const s = sessions[path.id]
        if (!s) throw new Error("404")
        return { data: s }
      },
    },
    config: {
      get: async () => {
        if (opts?.configFails) throw new Error("boom")
        return { data: { permission: configPermission } }
      },
    },
    postSessionIdPermissionsPermissionId: async (o: { path: { id: string; permissionID: string }; body: { response: string } }) => {
      posts.push({ id: o.path.id, permissionID: o.path.permissionID, response: o.body.response })
      return { data: true }
    },
  }
  return { client, posts }
}

const GLOBAL = { "*": "ask", read: { "*": "ask", "**/custom-secret": "deny" } }

async function fire(hooks: any, props: unknown, type = "permission.updated") {
  await hooks.event({ event: { type, properties: props } })
  await new Promise((r) => setTimeout(r, 30)) // let inflight work settle
}

let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`ok   ${name}`)
  else { failures++; console.log(`FAIL ${name}`, extra ?? "") }
}

const FULL = [{ permission: "*", pattern: "*", action: "allow" }]
const EDITS = [{ permission: "edit", pattern: "*", action: "allow" }]

// 1. full access root overlay -> subagent ask allowed, response "once"
{
  const { client, posts } = makeClient(
    { root: { id: "root", directory: "/tmp/x", permission: FULL }, sub: { id: "sub", directory: "/tmp/x", parentID: "root" } }, GLOBAL)
  const hooks = await PermissionInherit({ client } as any)
  await fire(hooks, { id: "p1", sessionID: "sub", type: "bash", pattern: "ls -la" })
  check("full-access allows bash (once)", posts.length === 1 && posts[0]!.response === "once", posts)
}

// 2. built-in deny pattern survives full access
{
  const { client, posts } = makeClient(
    { root: { id: "root", directory: "/tmp/x", permission: FULL }, sub: { id: "sub", directory: "/tmp/x", parentID: "root" } }, GLOBAL)
  const hooks = await PermissionInherit({ client } as any)
  await fire(hooks, { id: "p2", sessionID: "sub", type: "read", pattern: "/tmp/x/app/.env" })
  check(".env rejected under full access", posts.length === 1 && posts[0]!.response === "reject", posts)
}

// 3. user's global config deny survives full access
{
  const { client, posts } = makeClient(
    { root: { id: "root", directory: "/tmp/x", permission: FULL }, sub: { id: "sub", directory: "/tmp/x", parentID: "root" } }, GLOBAL)
  const hooks = await PermissionInherit({ client } as any)
  await fire(hooks, { id: "p3", sessionID: "sub", type: "read", pattern: "/tmp/x/custom-secret" })
  check("global config deny rejected", posts.length === 1 && posts[0]!.response === "reject", posts)
}

// 4. narrow overlay: read ask not in overlay -> reject (default unresolved)
// 5. narrow overlay: edit ask -> allow
{
  const { client, posts } = makeClient(
    { root: { id: "root", directory: "/tmp/x", permission: EDITS }, sub: { id: "sub", directory: "/tmp/x", parentID: "root" } }, GLOBAL)
  const hooks = await PermissionInherit({ client } as any)
  await fire(hooks, { id: "p4", sessionID: "sub", type: "read", pattern: "/tmp/x/a.txt" })
  await fire(hooks, { id: "p5", sessionID: "sub", type: "edit", pattern: "/tmp/x/a.txt" })
  check("narrow overlay rejects read", posts.some((p) => p.permissionID === "p4" && p.response === "reject"), posts)
  check("narrow overlay allows edit", posts.some((p) => p.permissionID === "p5" && p.response === "once"), posts)
}

// 6. no overlay -> pending (no POST). 7. supervised:"reject" -> reject
{
  const { client, posts } = makeClient(
    { root: { id: "root", directory: "/tmp/x" }, sub: { id: "sub", directory: "/tmp/x", parentID: "root" } }, GLOBAL)
  const hooks = await PermissionInherit({ client } as any)
  await fire(hooks, { id: "p6", sessionID: "sub", type: "bash", pattern: "ls" })
  check("no-overlay thread left pending", posts.length === 0, posts)

  const hooks2 = await PermissionInherit({ client } as any, { supervised: "reject" })
  await fire(hooks2, { id: "p7", sessionID: "sub", type: "bash", pattern: "ls" })
  check("supervised:reject rejects", posts.length === 1 && posts[0]!.response === "reject", posts)
}

// 8. trustedDirectories legacy path
{
  const { client, posts } = makeClient(
    { root: { id: "root", directory: `${process.env.HOME}/.t3/worktrees/w` }, sub: { id: "sub", directory: `${process.env.HOME}/.t3/worktrees/w`, parentID: "root" } }, GLOBAL)
  const hooks = await PermissionInherit({ client } as any, { trustedDirectories: ["~/.t3/worktrees/"] })
  await fire(hooks, { id: "p8", sessionID: "sub", type: "bash", pattern: "make" })
  check("trusted directory grants full access", posts.length === 1 && posts[0]!.response === "once", posts)
}

// 9. primary session ask -> never touched
{
  const { client, posts } = makeClient(
    { root: { id: "root", directory: "/tmp/x", permission: FULL } }, GLOBAL)
  const hooks = await PermissionInherit({ client } as any)
  await fire(hooks, { id: "p9", sessionID: "root", type: "bash", pattern: "ls" })
  check("primary-session ask left alone", posts.length === 0, posts)
}

// 10. config fetch failure -> fail closed (reject, since unresolved=reject)
{
  const { client, posts } = makeClient(
    { root: { id: "root", directory: "/tmp/x", permission: FULL }, sub: { id: "sub", directory: "/tmp/x", parentID: "root" } }, GLOBAL, { configFails: true })
  const hooks = await PermissionInherit({ client } as any)
  await fire(hooks, { id: "p10", sessionID: "sub", type: "bash", pattern: "ls" })
  check("config failure fails closed", posts.length === 1 && posts[0]!.response === "reject", posts)
}

// 11. nested subagent (sub -> subsub) resolves root overlay
{
  const { client, posts } = makeClient(
    { root: { id: "root", directory: "/tmp/x", permission: FULL },
      sub: { id: "sub", directory: "/tmp/x", parentID: "root" },
      subsub: { id: "subsub", directory: "/tmp/x", parentID: "sub" } }, GLOBAL)
  const hooks = await PermissionInherit({ client } as any)
  await fire(hooks, { id: "p11", sessionID: "subsub", type: "bash", pattern: "ls" })
  check("nested subagent inherits from root", posts.length === 1 && posts[0]!.response === "once", posts)
}

// 12. ~ expansion in overlay rules; $HOME deny via config key; dedupe of same ask id
{
  const home = process.env.HOME!
  const { client, posts } = makeClient(
    { root: { id: "root", directory: "/tmp/x", permission: [{ permission: "read", pattern: "~/workspace/**", action: "allow" }] },
      sub: { id: "sub", directory: "/tmp/x", parentID: "root" } },
    { "*": "ask", read: { "*": "ask", "**/*.key": "deny" } })
  const hooks = await PermissionInherit({ client } as any)
  await fire(hooks, { id: "p12", sessionID: "sub", type: "read", pattern: `${home}/workspace/a.ts` })
  await fire(hooks, { id: "p12", sessionID: "sub", type: "read", pattern: `${home}/workspace/a.ts` }) // dup
  await fire(hooks, { id: "p13", sessionID: "sub", type: "read", pattern: `${home}/workspace/k.key` })
  check("~-scoped overlay rule allows", posts.some((p) => p.permissionID === "p12" && p.response === "once"), posts)
  check("dup ask answered once", posts.filter((p) => p.permissionID === "p12").length === 1, posts)
  check("global *.key deny wins over overlay allow", posts.some((p) => p.permissionID === "p13" && p.response === "reject"), posts)
}

// 13. hook path sets status
{
  const { client, posts } = makeClient(
    { root: { id: "root", directory: "/tmp/x", permission: FULL }, sub: { id: "sub", directory: "/tmp/x", parentID: "root" } }, GLOBAL)
  const hooks = await PermissionInherit({ client } as any)
  const out = { status: "ask" as string }
  await hooks["permission.ask"]({ id: "h1", sessionID: "sub", type: "bash", pattern: "ls" }, out)
  check("hook sets allow", out.status === "allow", out)
  const out2 = { status: "ask" as string }
  await hooks["permission.ask"]({ id: "h2", sessionID: "sub", type: "read", pattern: "/x/.env" }, out2)
  check("hook sets deny on secret", out2.status === "deny", out2)
  check("hook path never POSTs", posts.length === 0, posts)
}

// 14. enabled:false disables the plugin entirely
{
  const { client, posts } = makeClient(
    { root: { id: "root", directory: "/tmp/x", permission: FULL }, sub: { id: "sub", directory: "/tmp/x", parentID: "root" } }, GLOBAL)
  const hooks = await PermissionInherit({ client } as any, { enabled: false })
  await fire(hooks, { id: "p20", sessionID: "sub", type: "bash", pattern: "ls" })
  const out = { status: "ask" as string }
  await hooks["permission.ask"]({ id: "h3", sessionID: "sub", type: "bash", pattern: "ls" }, out)
  check("enabled:false answers nothing", posts.length === 0 && out.status === "ask", posts)
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
