---
name: supermemory-status
description: >-
  Check whether Supermemory is connected: sign-in state, signed-in account,
  this project's memory space, and API reachability. Use when the user asks
  about Supermemory's status or connection, or memory seems not to work.
---

Report the user's Supermemory status.

1. Run the bundled probe from the user's project directory. It never prints
   credentials:

   ```
   node "<this skill's directory>/scripts/status.js" --cwd "<workspace root>"
   ```

2. Interpret the result:
   - `Signed in: yes` with `HTTP 200` means memory is working.
   - `HTTP 401` means the stored credentials were rejected: suggest
     `/supermemory-login`.
   - `HTTP 403` is a permission problem, not proof of bad credentials.
   - `HTTP 404` means the endpoint answered but the profile may be absent;
     authentication is unknown, not invalid.
   - A timeout, connection error or `5xx` means Supermemory is unreachable.
   - `Not connected` means no credentials exist yet: a new conversation opens
     the browser sign-in automatically, or the user can run
     `/supermemory-login` or set `SUPERMEMORY_ANTIGRAVITY_API_KEY`.
3. If the Supermemory MCP server is connected, call its `who_am_i` tool and say
   whether the MCP path works too.
4. Summarize: signed in or not, account, memory space, API and MCP
   reachability, and whether the Antigravity CLI status line is installed.
   Never print or guess credentials.
