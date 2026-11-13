const fs = require('node:fs');
const path = require('node:path');
const { getProfile } = require('./lib/api');
const {
  getOAuthConfig,
  isLoggedOut,
  settleAuth,
  startBackgroundAuth,
} = require('./lib/auth');
const { getNamespace, getProjectName } = require('./lib/container-tag');
const { getUserFriendlyError } = require('./lib/error-helpers');
const {
  MARK,
  contextStep,
  getWorkspace,
  injectOutput,
  isHeadless,
  isSubagent,
  noticeStep,
} = require('./lib/hook-io');
const { addSeen } = require('./lib/facts');
const { welcomeBackNotice } = require('./lib/last-session');
const { MARK_TIP_FILE } = require('./lib/paths');
const { loadProjectConfig } = require('./lib/project-config');
const {
  pruneState,
  readCaptureNotice,
  writeState,
} = require('./lib/session-state');
const {
  captureHeadless,
  debugLog,
  getApiVersion,
  getAuthToken,
  getBaseUrl,
  getMcpUrl,
  loadSettings,
} = require('./lib/settings');
const { exitAfterFlush, readStdin, writeOutput } = require('./lib/stdin');
const { ensureStatusline } = require('./lib/statusline-setup');

const AUTH_BUDGET_MS = 20000;

// The status line is on by default; it also shows when signed out.
function setupStatusline(settings) {
  try {
    return ensureStatusline();
  } catch (err) {
    debugLog(settings, 'Status line setup skipped', { error: err.message });
    return null;
  }
}

function joinNotices(...notices) {
  return notices.filter(Boolean).join('\n\n');
}

function markTip() {
  try {
    if (fs.existsSync(MARK_TIP_FILE)) return null;
    fs.mkdirSync(path.dirname(MARK_TIP_FILE), { recursive: true });
    fs.writeFileSync(MARK_TIP_FILE, new Date().toISOString());
    return `${MARK} is the supermemory mark — whenever you see it (here or in Antigravity's answers), that information came from supermemory.`;
  } catch {
    return null;
  }
}

function formatContext(profileResult, maxItems, namespace, projectName) {
  const profileText = (items) =>
    (items || [])
      .map((item) => (typeof item === 'string' ? item : item?.memory))
      .filter((text) => typeof text === 'string' && text.trim())
      .slice(0, maxItems);
  const statics = profileText(profileResult?.profile?.static);
  const dynamics = profileText(profileResult?.profile?.dynamic);
  if (statics.length === 0 && dynamics.length === 0) return null;

  const sections = [];
  if (statics.length > 0) {
    sections.push(
      `## User Profile (Persistent)\n${statics.map((f) => `- ◪ ${f}`).join('\n')}`,
    );
  }
  if (dynamics.length > 0) {
    sections.push(
      `## Recent Context\n${dynamics.map((f) => `- ◪ ${f}`).join('\n')}`,
    );
  }

  return {
    text: `<supermemory-context>
Recalled memory for this project (${projectName}). Every line marked ◪ comes from supermemory — when citing one, keep the mark and phrase it naturally (e.g. "◪ last week you told me about X"). If you name the source, say "from supermemory" — never "from memory".
This project's memory container: ${namespace}

${sections.join('\n\n')}
</supermemory-context>`,
    facts: [...statics, ...dynamics],
  };
}

function captureFailureNotice() {
  const message = readCaptureNotice()?.message;
  return message ? `last session save failed — ${message}` : null;
}

async function main() {
  const settings = loadSettings();
  let conversationId;

  try {
    const input = await readStdin();
    conversationId = input.conversationId;
    const cwd = getWorkspace(input);
    if (
      isSubagent(input) ||
      !cwd ||
      (!captureHeadless(settings) && isHeadless(input.conversationId))
    ) {
      writeOutput({});
      return;
    }

    pruneState();
    const statuslineNotice = setupStatusline(settings);
    writeState(conversationId, 'context', {
      status: 'loading',
      memoryItemsLoaded: 0,
    });

    const projectConfig = loadProjectConfig(cwd);
    const projectName = getProjectName(cwd);
    const namespace = getNamespace(cwd);
    const baseUrl = getBaseUrl(cwd, projectConfig);
    debugLog(settings, 'SessionStart', { cwd, projectName, namespace });

    const authStartedAt = Date.now();
    let apiKey;
    try {
      apiKey = await getAuthToken(cwd, projectConfig);
    } catch (error) {
      if (error.code !== 'AUTH_REQUIRED') throw error;
      if (isLoggedOut()) {
        writeState(conversationId, 'context', {
          status: 'signed_out',
          memoryItemsLoaded: 0,
        });
        writeOutput(
          injectOutput([
            noticeStep(
              joinNotices(
                'Signed out — memory is off. Run `/supermemory-login` to turn it back on.',
                statuslineNotice,
              ),
            ),
          ]),
        );
        return;
      }
      try {
        apiKey = await startBackgroundAuth(
          getOAuthConfig(baseUrl, getMcpUrl(cwd, projectConfig)),
          Math.max(1, AUTH_BUDGET_MS - (Date.now() - authStartedAt)),
        );
      } catch (authErr) {
        writeState(conversationId, 'context', {
          status: 'error',
          memoryItemsLoaded: 0,
        });
        const pending = authErr.message === 'AUTH_PENDING';
        writeOutput(
          injectOutput([
            contextStep(`<supermemory-status>
Supermemory is installed but not connected yet${pending ? ' (the user is signing in through the browser)' : ''}. Memories from earlier sessions are not loaded for this turn. If the user asks, tell them to finish the browser sign-in or run /supermemory-login.
</supermemory-status>`),
            noticeStep(
              joinNotices(
                pending
                  ? 'Finish connecting Supermemory in the browser window (you have 5 minutes). Memory turns on from your next message. If no browser opened, run `/supermemory-login`.'
                  : 'Sign-in did not complete. Run `/supermemory-login` to retry, or set `SUPERMEMORY_ANTIGRAVITY_API_KEY`.',
                statuslineNotice,
              ),
            ),
          ]),
        );
        return;
      }
    }

    let profileResult = null;
    let apiError = null;
    try {
      profileResult = await getProfile(
        baseUrl,
        apiKey,
        namespace,
        projectName,
        { apiVersion: getApiVersion(cwd, projectConfig) },
      );
    } catch (err) {
      if ((err?.status ?? err?.statusCode) !== 404)
        apiError = getUserFriendlyError(err);
      debugLog(settings, 'Profile fetch failed', {
        error: getUserFriendlyError(err),
      });
    }

    const context =
      settings.injectProfile === false
        ? null
        : formatContext(
            profileResult,
            settings.maxProfileItems,
            namespace,
            projectName,
          );
    const loaded = context?.facts.length || 0;
    // Prompt recall skips what the profile already put in context.
    if (context) addSeen(conversationId, context.facts);
    writeState(conversationId, 'context', {
      status: apiError ? 'error' : 'ready',
      memoryItemsLoaded: loaded,
    });

    const modelContext = apiError
      ? `<supermemory-status>
Memory could not be loaded this session (${apiError}) — do not assume this project has no memories.
</supermemory-status>`
      : context?.text ||
        `<supermemory-context>
No previous memories found for this project (container: ${namespace}).
Memories will be saved as you work.
</supermemory-context>`;

    const headline = apiError
      ? `memory unavailable — ${apiError}`
      : loaded > 0
        ? `${loaded} ${loaded === 1 ? 'memory' : 'memories'} loaded for **${projectName}**`
        : `active · no memories saved for **${projectName}** yet`;
    const notices = joinNotices(
      captureFailureNotice(),
      [headline, welcomeBackNotice(namespace)].filter(Boolean).join(' · '),
      statuslineNotice,
      markTip(),
    );

    writeOutput(injectOutput([contextStep(modelContext), noticeStep(notices)]));
  } catch (err) {
    const friendly = getUserFriendlyError(err);
    debugLog(settings, 'SessionStart error', { error: friendly });
    writeState(conversationId, 'context', {
      status: 'error',
      memoryItemsLoaded: 0,
    });
    writeOutput(
      injectOutput([noticeStep(`could not load memories — ${friendly}`)]),
    );
  }
}

main()
  .catch(() => writeOutput({}))
  .finally(() => settleAuth().finally(() => exitAfterFlush(0)));
