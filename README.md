<div align="center">

# antigravity-supermemory

**Persistent memory for Google Antigravity, powered by [Supermemory](https://supermemory.ai)**

[![version](https://img.shields.io/github/package-json/v/supermemoryai/antigravity-supermemory/main?filename=plugin.json&label=version&color=9C5C10)](https://github.com/supermemoryai/antigravity-supermemory)
[![license](https://img.shields.io/badge/license-MIT-9C5C10)](#license)

</div>

An Antigravity plugin that gives your agent persistent memory across conversations
using [Supermemory](https://supermemory.ai). It recalls what matters for each prompt,
saves what you work on, and shares one memory space per repository with the Claude
Code, Codex, Cursor and OpenCode plugins.

Works in the **Antigravity App**, the **Antigravity CLI** (`agy`), the standalone
**Antigravity IDE**, and the Antigravity extensions for VS Code, JetBrains, Zed,
Xcode and Eclipse (they run the CLI underneath).

<div align="center">

[Install](#installation) · [Features](#features) · [How it works](#how-it-works) · [Shared memory](#shared-agents-memory) · [Configuration](#configuration) · [Skills](#skills) · [Privacy](#privacy)

</div>

---

## Installation

> **Requires Node.js 18+** on your PATH. The hooks and the MCP server run as Node
> scripts. **Requires Antigravity CLI 1.4 or later** (or the matching App/IDE).

```bash
agy plugin install https://github.com/supermemoryai/antigravity-supermemory
```

Or from a local checkout: `agy plugin install /path/to/antigravity-supermemory`.
In the App, open **Customizations → Installed** to confirm the plugin is enabled.

Start a new conversation. The first one opens the browser to connect your Supermemory
account (you have five minutes; memory turns on from your next message). To use an API
key instead, get one at [console.supermemory.ai](https://console.supermemory.ai):

```bash
export SUPERMEMORY_ANTIGRAVITY_API_KEY="sm_..."
```

Hooks only run in folders you trust: accept Antigravity's "trust this folder" prompt
the first time you open a project.

## Features

|  |  |
| --- | --- |
| 🧠 **Direct recall**<br>Before the model answers a new prompt, the hook searches Supermemory with it and injects fresh matches. No tool call, no permission prompt. | 🔎 **Supermemory MCP tools**<br>`search_memory` and `add_memory` load as native tools; `get_profile`, `list_memories`, `forget_memory` and the rest are one call away. Read-only calls are auto-approved. |
| 💾 **Auto capture**<br>When a turn finishes, the new conversation content is saved in the background, so the agent never waits on the network. | 🏷️ **Shared repo memory**<br>Captures use the repository space shared with Claude Code, Codex, Cursor and OpenCode, with `sm_scope: personal` metadata. |
| 🧭 **Context gatherer**<br>The `context-gatherer` subagent runs several searches and returns a brief with provenance before big tasks. | 📟 **CLI status line**<br>On by default: `◪ supermemory · 5 loaded · 2 recalled · saved 1m ago` appears under agy's own line. A custom status line is left alone. |
| 👋 **Session context**<br>Loads profile facts when a conversation starts and says welcome back when you return to a project after 6+ hours. | 🔐 **Browser sign-in**<br>The first conversation opens the Supermemory sign-in; `/supermemory-login` and `/supermemory-logout` switch or disconnect accounts. |

Notices such as `3 memories loaded for my-repo` or `recalled 2 memories (180 tok)`
appear inline in the conversation. They are shown to you only and never sent to the
model.

## How it works

Antigravity plugins can bundle hooks, an MCP server, skills, subagents and rules.
`supermemory` registers four hooks, in lifecycle order:

**`SessionStart`** → **`PreInvocation`** → **`PreToolUse`** → **`Stop`**

| Step | Script | Event | What it does |
| --- | --- | --- | --- |
| 1 | `session-start` | `SessionStart` | Signs in if needed (a background browser login) and injects profile context for this project, plus a notice. |
| 2 | `recall` | `PreInvocation` | On the first model call of each turn, searches Supermemory with the prompt and injects fresh matches, deduplicated within the conversation. Tool-loop calls are skipped. |
| 3 | `recall-approve` | `PreToolUse` | Auto-approves read-only Supermemory MCP tools; writes still ask. |
| 4 | `capture` | `Stop` | Hands the new turns to a detached worker that saves them under the conversation id, so the turn ends immediately. |

Antigravity has no prompt-submit event, so recall runs on `PreInvocation` and reads the
prompt from the hook payload. Context is injected as a system message, which stays in the
conversation for later turns. Notices use a separate system message with empty model text
and markdown for you.

The `supermemory` MCP server (`scripts/mcp-proxy.js`) bridges to the hosted Supermemory
MCP with the same credentials as the hooks. It learns the project from Antigravity's
workspace roots and scopes tool calls to this repository unless a `namespace` is given.

Setting `recallDirective` switches to advisory mode: the hook stops searching and instead
tells the agent when it should search on its own.

The hooks fail open: if Supermemory is unreachable, credentials are missing, or anything
else fails, they return cleanly and your conversation continues. A failed save is
reported when the next conversation starts. Subagent conversations neither recall nor
capture; the parent conversation does.

### Shared Agents memory

Antigravity, Claude Code, Codex, Cursor and OpenCode generate the same space for a
repository, so memories are shared:

```text
repo_<project-name>__<remote-hash>   default space for capture and MCP memory tools
sm_scope: personal                   metadata on automatic captures
```

The hash comes from the normalized Git remote, so clones share memory while
same-named repositories do not collide. Repositories without a remote fall back to a
local path identity. Set `SUPERMEMORY_ISOLATE_WORKTREES=true` to key the space on the
worktree path instead.

A namespace pinned for the Claude Code plugin (`.claude/.supermemory-claude/config.json`)
is honored too, so both agents keep using the same space.

## Configuration

### Environment variables

| Variable | Purpose |
| --- | --- |
| `SUPERMEMORY_ANTIGRAVITY_API_KEY` | Your Supermemory API key (browser sign-in is preferred). `SUPERMEMORY_API_KEY` also works. |
| `SUPERMEMORY_API_URL` | Override the Supermemory REST base URL; custom URLs default to legacy compatibility. |
| `SUPERMEMORY_MCP_URL` | Override the hosted MCP endpoint (default `https://mcp.supermemory.ai/mcp`). |
| `SUPERMEMORY_API_VERSION` | `v5` or `legacy` for self-hosted servers. |
| `SUPERMEMORY_REPO_TAG` | Project space override, used when no project setting is set. |
| `SUPERMEMORY_ISOLATE_WORKTREES` | `true` keys the project space on the worktree path instead of the Git remote. |
| `SUPERMEMORY_DEBUG` | `true` writes debug logs to `~/.supermemory-antigravity/debug.log`. |

Antigravity passes its environment to hooks and MCP servers. For the App or IDE
launched from the Dock, prefer browser sign-in or the project config over shell
variables.

### Global settings (`~/.supermemory-antigravity/settings.json`)

```json
{
  "maxProfileItems": 5,
  "signalExtraction": true,
  "signalKeywords": ["remember", "architecture", "decision", "bug", "fix"],
  "signalTurnsBefore": 3,
  "includeTools": ["run_command", "search_memory"]
}
```

| Option | Description |
| --- | --- |
| `maxProfileItems` | Max profile facts per section at conversation start (default: 5). |
| `injectProfile` | Set to `false` to skip profile context at conversation start. |
| `recallDirective` | Switches prompt recall from direct search to an advisory instruction. |
| `signalExtraction` | Only capture turns that contain signal keywords (default: false). |
| `signalKeywords` | Keywords that mark a turn worth saving. |
| `signalTurnsBefore` | Context turns kept before a signal turn (default: 3). |
| `includeTools` | Tool calls and results to capture, by name (`run_command`, `view_file`, an MCP tool such as `search_memory`, or `server/tool`). |
| `debug` | Enable debug logging (default: false). |

### Project config (`.agents/.supermemory/config.json`)

Per-repo overrides. API key precedence is `SUPERMEMORY_ANTIGRAVITY_API_KEY`,
`SUPERMEMORY_API_KEY`, project `apiKey`, then `~/.supermemory-antigravity/credentials.json`.

```json
{
  "apiKey": "sm_...",
  "baseUrl": "https://api.supermemory.ai",
  "namespace": "my-team-project",
  "signalExtraction": true
}
```

| Option | Description |
| --- | --- |
| `apiKey` | Project-specific API key. |
| `baseUrl` | Supermemory API URL. |
| `apiVersion` | `v5` or `legacy`, for self-hosted servers. |
| `namespace` | Canonical project space. |
| `repoContainerTag` | Compatible alias of `namespace`, checked before `SUPERMEMORY_REPO_TAG`. |

Scope precedence is project `namespace`, project `repoContainerTag`, the Claude Code
plugin's pinned namespace, `SUPERMEMORY_REPO_TAG`, then the generated identity. V5
spaces allow 1–100 letters, digits, underscores, hyphens, or colons.

## Skills

| Skill | Description |
| --- | --- |
| `/supermemory-status` | Show sign-in, account, the project's memory space, and API and MCP reachability. |
| `/supermemory-login` | Connect Supermemory through the browser. |
| `/supermemory-logout` | Sign out and revoke the stored token. New conversations stop loading and saving memory until you sign in again. |

The same commands are available from a terminal:

```bash
node ~/.gemini/config/plugins/supermemory/scripts/cli.js status
```

### Status line

The Antigravity CLI status line is on by default. The first conversation after the
CLI has run on your machine adds it to `~/.gemini/antigravity-cli/settings.json`, and
it shows from the next `agy` start. A custom status line is never replaced. To turn it
off (it stays off until you turn it back on with `statusline install`):

```bash
node ~/.gemini/config/plugins/supermemory/scripts/cli.js statusline uninstall
```

For a one-off save, ask the agent to use `add_memory`. Without a `namespace`, the
proxy scopes it to this repository.

## Privacy

Automatic capture sends new conversation content to Supermemory: your messages and the
agent's replies, plus tool activity only for tools listed in `includeTools`. Injected
memory blocks are stripped first, and anything inside `<private>…</private>` is
replaced with `[REDACTED]`. An offline filter also replaces common credential-shaped
values (provider tokens, credential assignments, private keys, Bearer tokens and URL
credentials) with `[REDACTED:…]` markers. It cannot detect every secret.

Credentials are stored in `~/.supermemory-antigravity/credentials.json` with `0600`
permissions. Signing out revokes the refresh token; the connection stays listed under
console.supermemory.ai → Agents & MCP until you disconnect it there.

For how Supermemory collects, uses and retains data, see the
[Supermemory Privacy Policy](https://supermemory.ai/privacy/).

## Troubleshooting

- **No memories load:** run `/supermemory-status`. Hooks only run in trusted folders,
  and `node` must be on the PATH Antigravity was started with.
- **Debug logs:** set `SUPERMEMORY_DEBUG=true`; logs go to
  `~/.supermemory-antigravity/debug.log`. Antigravity's own hook errors are in
  `~/.gemini/antigravity-cli/log/` (CLI) or the App's logs.
- **The Supermemory tools are missing on the very first prompt:** Antigravity loads MCP
  servers in the background at startup. Recall still works through the hook.

## License

MIT

## Development

Installations need only Node 18 or later, not `npm install`. `scripts/vendor/supermemory.cjs`
is the committed runtime bundle built from the exact official SDK and esbuild versions in
`package-lock.json`. Maintainers reproduce it with `npm ci && npm run build:sdk`; CI rejects
a stale bundle. The SDK's Apache-2.0 license is included alongside the bundle.

```bash
npm ci
npm run lint
npm test            # unit tests: hooks, transcript parsing, MCP proxy, CLI
npm run test:e2e    # drives the real agy CLI against a scripted model and a mock API
npm run validate    # agy plugin validate --strict .
```

The end-to-end suite installs the plugin into a throwaway `HOME`, points `agy` at a mock
Gemini endpoint (`GOOGLE_GEMINI_BASE_URL`) and the plugin at a mock Supermemory server, so
it needs neither a Google sign-in nor a Supermemory account.

---

<div align="center">
<sub>◪ is the supermemory mark. Whenever you see it (notices, the status line, or the agent's answers), that information came from supermemory.</sub>
</div>
