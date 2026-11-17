const fs = require('node:fs');
const {
  AGENT_SUPPORTING_CONTEXT,
  addMemory,
  addSession,
  useV5,
} = require('./lib/api');
const { settleAuth } = require('./lib/auth');
const { withCaptureLock } = require('./lib/capture-lock');
const {
  getNamespace,
  getProjectIdentity,
  getProjectName,
} = require('./lib/container-tag');
const { getUserFriendlyError } = require('./lib/error-helpers');
const { saveLastSession } = require('./lib/last-session');
const { loadProjectConfig } = require('./lib/project-config');
const { redactSecrets } = require('./lib/redact');
const { readRawDelta } = require('./lib/session');
const {
  clearCaptureNotice,
  readState,
  writeCaptureNotice,
  writeState,
} = require('./lib/session-state');
const {
  debugLog,
  getApiVersion,
  getAuthToken,
  getBaseUrl,
  loadSettings,
} = require('./lib/settings');
const { formatNewEntries, setCursor } = require('./lib/transcript');

const CAPTURE_TIMEOUT_MS = 25000;
// Stop can fire a beat before the final reply is flushed to the transcript.
const SETTLE_MS = 250;

// The surface is the transcript's app data dir: antigravity (App),
// antigravity-cli, or antigravity-ide.
function surfaceOf(transcriptPath) {
  const match = String(transcriptPath).match(
    /[/\\]\.gemini[/\\](antigravity(?:-cli|-ide)?)[/\\]/,
  );
  return (
    { antigravity: 'app', 'antigravity-cli': 'cli', 'antigravity-ide': 'ide' }[
      match?.[1]
    ] || 'unknown'
  );
}

async function runCapture(job) {
  const settings = loadSettings();
  const { conversationId, transcriptPath, cwd } = job;
  const captured = readState(conversationId, 'capture')?.count || 0;

  try {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    let outcome = 'no_content';
    const acquired = await withCaptureLock(conversationId, async () => {
      const projectConfig = loadProjectConfig(cwd);
      const baseUrl = getBaseUrl(cwd, projectConfig);
      const apiVersion = getApiVersion(cwd, projectConfig);
      const namespace = getNamespace(cwd);
      const metadata = {
        type: 'session_turn',
        project: getProjectName(cwd),
        sm_project_id: getProjectIdentity(cwd),
        sm_scope: 'personal',
        sm_capture_mode: 'automatic',
        agent_surface: surfaceOf(transcriptPath),
        timestamp: new Date().toISOString(),
      };
      const markSaved = (result, details) => {
        outcome = 'saved';
        writeState(conversationId, 'capture', {
          status: 'saved',
          count: captured + 1,
        });
        clearCaptureNotice();
        try {
          saveLastSession({ id: result?.id, containerTag: namespace });
        } catch {}
        debugLog(settings, 'Conversation turn saved', details);
      };

      if (useV5(baseUrl, { apiVersion }, namespace)) {
        const session = readRawDelta(transcriptPath, conversationId);
        if (!session) return;
        const apiKey = await getAuthToken(cwd, projectConfig);
        writeState(conversationId, 'capture', {
          status: 'saving',
          count: captured,
        });
        const result = await addSession(
          baseUrl,
          apiKey,
          namespace,
          session.raw,
          {
            id: conversationId,
            generation: session.generation,
            offset: session.offset,
            supportingContext: AGENT_SUPPORTING_CONTEXT,
            metadata,
            timeoutMs: CAPTURE_TIMEOUT_MS,
          },
        );
        session.commit();
        markSaved(result, {
          bytes: Buffer.byteLength(session.raw),
          generation: session.generation,
          offset: session.offset,
        });
        return;
      }

      const delta = formatNewEntries(transcriptPath, conversationId, cwd);
      if (!delta) return;
      if (delta.skipped) {
        setCursor(conversationId, delta.cursor);
        return;
      }
      if (!delta.formatted) return;

      const apiKey = await getAuthToken(cwd, projectConfig);
      writeState(conversationId, 'capture', {
        status: 'saving',
        count: captured,
      });

      const result = await addMemory(
        baseUrl,
        apiKey,
        redactSecrets(delta.formatted),
        namespace,
        metadata,
        {
          id: conversationId,
          supportingContext: AGENT_SUPPORTING_CONTEXT,
          apiVersion,
          timeoutMs: CAPTURE_TIMEOUT_MS,
        },
      );

      // The cursor only moves once the upload is acknowledged, so a failed
      // save is retried with the next turn.
      setCursor(conversationId, delta.cursor);
      markSaved(result, {
        length: delta.formatted.length,
        turns: delta.turns,
      });
    });

    if (!acquired) throw new Error('Another capture is still running.');
    if (outcome === 'no_content') {
      writeState(conversationId, 'capture', {
        status: 'no_content',
        count: captured,
      });
    }
    return outcome;
  } catch (err) {
    // Without credentials there is nothing to save to; SessionStart already
    // told the user how to sign in.
    if (err?.code === 'AUTH_REQUIRED') return 'skipped';
    const status = err?.status ?? err?.statusCode;
    const friendly = redactSecrets(
      getUserFriendlyError(
        typeof status === 'number'
          ? { status, message: `Supermemory API returned HTTP ${status}.` }
          : err,
      ),
    );
    debugLog(settings, 'Capture error', { error: friendly });
    writeCaptureNotice(friendly);
    writeState(conversationId, 'capture', { status: 'error', count: captured });
    return 'error';
  }
}

async function main() {
  const jobFile = process.argv[2];
  let job;
  try {
    job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  } finally {
    try {
      fs.unlinkSync(jobFile);
    } catch {}
  }
  await runCapture(job);
}

if (require.main === module) {
  main()
    .catch(() => {})
    // Let a refresh that is still rotating tokens save them before exiting.
    .finally(() => settleAuth().finally(() => process.exit(0)));
}

module.exports = { runCapture, surfaceOf };
