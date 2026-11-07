const { searchMemories } = require('./lib/api');
const { settleAuth } = require('./lib/auth');
const { getNamespace } = require('./lib/container-tag');
const { getUserFriendlyError, isTimeout } = require('./lib/error-helpers');
const { addSeen, factHash, readSeen } = require('./lib/facts');
const {
  contextStep,
  getWorkspace,
  injectOutput,
  isHeadless,
  isSubagent,
  noticeStep,
} = require('./lib/hook-io');
const { loadProjectConfig } = require('./lib/project-config');
const { parseTranscript } = require('./lib/transcript');
const {
  readSessionJson,
  readState,
  writeSessionJson,
  writeState,
} = require('./lib/session-state');
const {
  captureHeadless,
  debugLog,
  getApiVersion,
  getAuthToken,
  getBaseUrl,
  getRecallConfig,
  loadSettings,
} = require('./lib/settings');
const { exitAfterFlush, readStdin, writeOutput } = require('./lib/stdin');

// Recall is performed HERE, not delegated to the model: the hook searches
// supermemory with the prompt itself and injects the top matches, so recall
// happens on every substantive prompt instead of only when the model chooses
// to spend a tool call. A configured recallDirective restores advisory mode.
//
// Antigravity has no UserPromptSubmit event. PreInvocation fires before every
// model call, including each step of a tool loop; invocationNum is 0 only for
// the first call of a turn, which is where the user's new prompt lands.
const MIN_PROMPT_LENGTH = 12;
const MAX_QUERY_LENGTH = 500;
const MAX_RESULTS = 15;
const MAX_RESULT_CHARS = 300;
const MIN_SIMILARITY = 0.55;
const SEARCH_TIMEOUT_MS = 4000;

function shouldSkip(prompt) {
  if (prompt.length < MIN_PROMPT_LENGTH) return true;
  return ['/', '!', '#', '@'].includes(prompt[0]);
}

// Search hits are memory-shaped (.memory) or document/chunk-shaped
// (.chunk/.content/.text, usually with a filepath) — read whichever carries
// the text.
function resultText(r) {
  const text = [r?.memory, r?.chunk, r?.content, r?.text].find(
    (v) => typeof v === 'string' && v.trim(),
  );
  return text || null;
}

// Builds older than agy 1.4 do not send lastUserInput; the newest request the
// user typed is in the transcript.
function latestUserRequest(transcriptPath) {
  try {
    const users = parseTranscript(transcriptPath).filter(
      (e) => e.role === 'user',
    );
    return users.length ? users[users.length - 1].text : '';
  } catch {
    return '';
  }
}

// The hook can only inject what it finds. When a project has no stored memories
// the model gets silence — and silence reads as "there is nothing to search",
// so it never reaches for the tool and any history living in another container
// stays invisible. Say once per session that the tool exists and what to scope
// it to.
function formatDiscovery(namespace) {
  return `<supermemory-recall>
No stored memories matched this prompt for this project.

Deeper history may still exist. Search it with the supermemory search_memory
MCP tool (server supermemory_supermemory; call it directly, or through
call_mcp_tool when it is lazy-loaded).

- Scope to this project with namespace: "${namespace}"
- Omit namespace to use this project's default space.
- Read-only supermemory calls are auto-approved; they never prompt the user.

Worth a call when the user refers to past decisions, earlier sessions, or says
"remember" / "we decided" / "last time". Skip it for self-contained tasks.
</supermemory-recall>`;
}

function formatRecall(results, namespace) {
  const lines = results.map((r) => {
    const text = resultText(r).replace(/\s+/g, ' ').slice(0, MAX_RESULT_CHARS);
    const title =
      typeof r.title === 'string' && r.title.trim() ? r.title.trim() : null;
    const prefix = title && !text.startsWith(title) ? `${title} — ` : '';
    return `- ◪ ${prefix}${text}${typeof r.filepath === 'string' && r.filepath ? ` (${r.filepath})` : ''}`;
  });
  return `<supermemory-recall>
◪ Recalled from supermemory for this prompt (relevance-ranked):
${lines.join('\n')}

When one of these shapes your answer, credit it naturally with the ◪ prefix (e.g. "◪ earlier you decided X"); if you name the source, say "from supermemory" — never "from memory". For deeper history, call the supermemory search_memory tool — it defaults to this project's space (${namespace}). Pass namespace only to search a different space. Or delegate to the context-gatherer subagent.
</supermemory-recall>`;
}

async function main() {
  const settings = loadSettings();

  try {
    const input = await readStdin();
    const conversationId = input.conversationId;
    const cwd = getWorkspace(input);
    const firstCallOfTurn =
      !Number.isInteger(input.invocationNum) || input.invocationNum === 0;
    if (
      isSubagent(input) ||
      !cwd ||
      !firstCallOfTurn ||
      (!captureHeadless(settings) && isHeadless())
    ) {
      writeOutput({});
      return;
    }

    const prompt = (
      typeof input.lastUserInput === 'string'
        ? input.lastUserInput
        : latestUserRequest(input.transcriptPath)
    ).trim();
    // Guard against a turn whose first call fires the hook twice.
    const turnKey = factHash(
      `${conversationId}\n${input.initialNumSteps ?? ''}\n${prompt}`,
    );
    if (readSessionJson(conversationId, 'last-recall.json')?.key === turnKey) {
      writeOutput({});
      return;
    }
    writeSessionJson(conversationId, 'last-recall.json', { key: turnKey });

    // The directive is guidance for this turn only, so it must not pile up in
    // the conversation the way persistent context does.
    const { directive } = getRecallConfig(cwd);
    if (directive) {
      writeOutput(injectOutput([{ ephemeralMessage: directive }]));
      return;
    }

    if (shouldSkip(prompt)) {
      writeOutput({});
      return;
    }

    const projectConfig = loadProjectConfig(cwd);
    const requestStarted = Date.now();
    let apiKey;
    try {
      // SessionStart owns sign-in; recall must never open a browser.
      apiKey = await getAuthToken(cwd, projectConfig, 1000);
    } catch {
      writeOutput({});
      return;
    }

    const namespace = getNamespace(cwd);
    const response = await searchMemories(
      getBaseUrl(cwd, projectConfig),
      apiKey,
      namespace,
      prompt.slice(0, MAX_QUERY_LENGTH),
      {
        timeoutMs: Math.max(
          1,
          SEARCH_TIMEOUT_MS - (Date.now() - requestStarted),
        ),
        apiVersion: getApiVersion(cwd, projectConfig),
      },
    );

    const batchHashes = new Set();
    const results = (response || [])
      .filter((r) => resultText(r))
      .filter(
        (r) => !Number.isFinite(r.similarity) || r.similarity >= MIN_SIMILARITY,
      )
      .filter((r) => {
        const hash = factHash(resultText(r));
        if (batchHashes.has(hash)) return false;
        batchHashes.add(hash);
        return true;
      })
      .slice(0, MAX_RESULTS);

    // Facts already in context (earlier recalls and the SessionStart profile)
    // are not injected again.
    const seenSet = new Set(readSeen(conversationId));
    const fresh = results.filter((r) => !seenSet.has(factHash(resultText(r))));
    const repeats = results.length - fresh.length;

    const prev = readState(conversationId, 'search') || {};
    writeState(conversationId, 'search', {
      results: fresh.length,
      count: (prev.count || 0) + 1,
      memories: (prev.memories || 0) + fresh.length,
    });

    debugLog(settings, 'Prompt recall', {
      query: prompt.slice(0, 80),
      hits: results.length,
      fresh: fresh.length,
    });

    if (fresh.length === 0) {
      // Only when the container is genuinely empty: if results came back but
      // were all repeats, the earlier recall already carried this guidance.
      if (
        results.length === 0 &&
        !readSessionJson(conversationId, 'discovery.json')
      ) {
        writeSessionJson(conversationId, 'discovery.json', {
          sentAt: new Date().toISOString(),
        });
        writeOutput(
          injectOutput([
            contextStep(formatDiscovery(namespace)),
            noticeStep('no memories yet for this project'),
          ]),
        );
        return;
      }
      writeOutput({});
      return;
    }

    addSeen(conversationId, fresh.map(resultText));

    const context = formatRecall(fresh, namespace);
    // ~4 chars/token: close enough to show what the injection costs.
    const tok = `(${Math.round(context.length / 4)} tok)`;
    const label = repeats
      ? `recalled ${fresh.length} new ${tok} · ${repeats} already in context`
      : `recalled ${fresh.length} ${fresh.length === 1 ? 'memory' : 'memories'} ${tok}`;
    writeOutput(injectOutput([contextStep(context), noticeStep(label)]));
  } catch (err) {
    debugLog(settings, 'Recall error', { error: getUserFriendlyError(err) });
    // A slow recall should not interrupt every prompt with an error banner.
    if (isTimeout(err)) {
      writeOutput({});
      return;
    }
    writeOutput(
      injectOutput([
        noticeStep(`recall failed: ${getUserFriendlyError(err).slice(0, 120)}`),
      ]),
    );
  }
}

main()
  .catch(() => writeOutput({}))
  .finally(() => settleAuth().finally(() => exitAfterFlush(0)));
