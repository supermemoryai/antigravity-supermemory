---
name: supermemory-logout
description: >-
  Sign Supermemory out of Antigravity and revoke the stored token. Use only
  when the user explicitly asks to sign out of or disconnect Supermemory.
disable-model-invocation: true
---

Sign out of Supermemory.

1. Run:

   ```
   node "<this skill's directory>/scripts/logout.js"
   ```

2. Tell the user that memory is now off: new conversations will not load or
   save memories until they run `/supermemory-login`. Memories already saved
   stay in their Supermemory account, and the connection is still listed under
   console.supermemory.ai → Agents & MCP until they disconnect it there.
