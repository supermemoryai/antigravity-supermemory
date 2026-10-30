---
name: supermemory-statusline
description: >-
  Add or remove the Supermemory line in the Antigravity CLI status bar
  (memories loaded, recalled, last save). Use when the user asks to show or
  hide Supermemory's status in the CLI.
disable-model-invocation: true
---

Manage the Supermemory status line for the Antigravity CLI (`agy`).

1. To add it, run:

   ```
   node "<this skill's directory>/scripts/statusline.js" install
   ```

   To remove it, run the same script with `uninstall`. Use `status` to check.
2. Relay the result. The line appears under Antigravity's own status line
   after `agy` restarts. An existing custom status line is never replaced.
3. The status line is a CLI feature; the Antigravity App and IDE show
   Supermemory notices inline in the conversation instead.
