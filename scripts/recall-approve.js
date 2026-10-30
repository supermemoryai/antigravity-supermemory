const { readState, writeState } = require('./lib/session-state');
const { debugLog, loadSettings } = require('./lib/settings');
const { exitAfterFlush, readStdin, writeOutput } = require('./lib/stdin');
const { READ_ONLY_TOOLS, resolveSupermemoryTool } = require('./lib/tools');

// Only read-only tools run without a prompt; writes (add_memory,
// forget_memory, ...) still ask. Antigravity's "allow" defers to the user's
// permission policy, so the read-only path uses "auto_approve". Every other
// call must get an explicit "allow": an empty decision is a denial, and this
// hook also sees other servers' lazy calls through call_mcp_tool.
const DEFER = { decision: 'allow' };

async function main() {
  const settings = loadSettings();
  try {
    const input = await readStdin();
    const resolved = resolveSupermemoryTool(input.toolCall);
    if (!resolved || !READ_ONLY_TOOLS.has(resolved.tool)) {
      writeOutput(DEFER);
      return;
    }
    debugLog(settings, 'Auto-approving supermemory recall', {
      tool: resolved.tool,
    });
    if (resolved.tool === 'search_memory') {
      const prev = readState(input.conversationId, 'search') || {};
      writeState(input.conversationId, 'search', {
        results: 0,
        count: (prev.count || 0) + 1,
        memories: prev.memories || 0,
      });
    }
    writeOutput({
      decision: 'auto_approve',
      reason:
        'Supermemory recall runs automatically (read-only memory access).',
    });
  } catch (err) {
    debugLog(settings, 'Recall approve error', { error: err.message });
    writeOutput(DEFER);
  }
}

main()
  .catch(() => writeOutput(DEFER))
  .finally(() => exitAfterFlush(0));
