# Changelog

## 0.2.0

- `agy -p` (print mode) runs make no Supermemory calls by default: no session context,
  recall or capture. Set `captureHeadless: true` in `~/.supermemory-antigravity/settings.json`
  or `SUPERMEMORY_CAPTURE_HEADLESS=true` to restore the previous behaviour (the variable
  wins over the setting in both directions). Conductor and Vibe Kanban runs are always
  recorded, and prompt text containing `-p` never marks an interactive session headless.

## 0.1.0

First release for Antigravity App, CLI (`agy` 1.4+) and IDE.

- `SessionStart` signs in (background browser login, five-minute window) and loads
  profile context for the repository, with welcome-back and failed-save notices.
- `PreInvocation` recalls up to 15 memories for each new prompt, deduplicated within the
  conversation; tool-loop model calls are skipped.
- `PreToolUse` auto-approves read-only Supermemory MCP tools.
- `Stop` saves new turns from a detached worker, under the conversation id, in the shared
  `repo_<name>__<hash>` space.
- Bundled MCP server bridges to the hosted Supermemory MCP with the hooks' credentials,
  scopes calls to the repository through workspace roots, and loads `search_memory` and
  `add_memory` as native tools.
- Skills: `supermemory-status`, `supermemory-login`, `supermemory-logout`.
- `context-gatherer` subagent and an always-on rule.
- Antigravity CLI status line, on by default and never replacing a custom one.
