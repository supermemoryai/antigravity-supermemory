const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getWorkspace, isHeadless, isSubagent } = require('./lib/hook-io');
const { PENDING_DIR } = require('./lib/paths');
const {
  captureHeadless,
  debugLog,
  isConfigured,
  loadSettings,
} = require('./lib/settings');
const { exitAfterFlush, readStdin, writeOutput } = require('./lib/stdin');

// Antigravity hooks are synchronous: the turn does not finish until Stop
// returns. The upload runs in a detached worker so a slow network never holds
// up the agent, and it survives `agy -p` exiting right after the turn.
// Any decision other than "continue" lets the agent stop.
const ALLOW_STOP = { decision: '' };

async function main() {
  const settings = loadSettings();
  try {
    const input = await readStdin();
    const cwd = getWorkspace(input);
    if (
      isSubagent(input) ||
      !cwd ||
      !input.conversationId ||
      !input.transcriptPath ||
      !isConfigured(cwd) ||
      (!captureHeadless(settings) && isHeadless(input.conversationId))
    ) {
      writeOutput(ALLOW_STOP);
      return;
    }

    const job = {
      conversationId: input.conversationId,
      transcriptPath: input.transcriptPath,
      cwd,
      terminationReason: input.terminationReason || null,
    };

    if (process.env.SUPERMEMORY_CAPTURE_SYNC === 'true') {
      await require('./capture-worker').runCapture(job);
      writeOutput(ALLOW_STOP);
      return;
    }

    fs.mkdirSync(PENDING_DIR, { recursive: true, mode: 0o700 });
    const jobFile = path.join(PENDING_DIR, `${crypto.randomUUID()}.json`);
    fs.writeFileSync(jobFile, JSON.stringify(job), { mode: 0o600, flag: 'wx' });
    const child = spawn(
      process.execPath,
      [path.join(__dirname, 'capture-worker.js'), jobFile],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
    writeOutput(ALLOW_STOP);
  } catch (err) {
    debugLog(settings, 'Capture dispatch error', { error: err.message });
    writeOutput(ALLOW_STOP);
  }
}

main()
  .catch(() => writeOutput(ALLOW_STOP))
  .finally(() => exitAfterFlush(0));
