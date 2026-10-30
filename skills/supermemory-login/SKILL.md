---
name: supermemory-login
description: >-
  Connect Supermemory to Antigravity through a browser sign-in. Use when the
  user asks to sign in or reconnect Supermemory, or after a status check shows
  it is not connected.
disable-model-invocation: true
---

Connect Supermemory.

1. Run, from the user's project directory:

   ```
   node "<this skill's directory>/scripts/login.js" --cwd "<workspace root>"
   ```

   It opens the browser and returns within about 25 seconds. The sign-in page
   stays valid for 5 minutes after that.
2. Relay the command's message. If it says a browser window opened, tell the
   user to finish signing in there; memory turns on from their next message.
3. If no browser can open (for example over SSH), tell the user to set
   `SUPERMEMORY_ANTIGRAVITY_API_KEY` to an API key from
   https://console.supermemory.ai instead.
