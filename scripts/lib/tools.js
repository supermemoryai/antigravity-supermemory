// Hosted Supermemory MCP tool names (snake_case since the v5 MCP, with the
// camelCase aliases that cached clients still call).
const READ_ONLY_TOOLS = new Set([
  'search_memory',
  'get_profile',
  'list_documents',
  'listDocuments',
  'get_document',
  'getDocument',
  'list_memories',
  'listMemories',
  'list_spaces',
  'listSpaces',
  'who_am_i',
  'whoAmI',
  'memory-graph',
  'fetch-graph-data',
]);

// Tools scoped to one space: without an explicit namespace the hosted server
// falls back to the account's active space, where this project's recall would
// never find the memory.
const REPO_SCOPED_TOOLS = new Set([
  'search_memory',
  'add_memory',
  'forget_memory',
  'get_profile',
  'list_documents',
  'listDocuments',
  'get_document',
  'getDocument',
  'list_memories',
  'listMemories',
  'memory-graph',
  'fetch-graph-data',
  'save-memory',
]);

// Registered as native tools instead of behind call_mcp_tool, so the agent can
// search and save without first reading a schema file.
const ALWAYS_LOAD_TOOLS = new Set(['search_memory', 'add_memory']);

// Plugin servers are named <plugin>_<server> (supermemory_supermemory); a
// hosted server the user added directly is usually just "supermemory".
function isSupermemoryServer(serverName) {
  return /(^|[_-])supermemory$/i.test(
    String(serverName || '').replace(/^"|"$/g, ''),
  );
}

/**
 * Resolve the Supermemory tool behind an Antigravity tool call: either
 * call_mcp_tool {ServerName, ToolName, Arguments} for lazy tools, or the
 * native mcp_<server>_<tool> name an always-loaded tool gets.
 */
function resolveSupermemoryTool(toolCall) {
  const name = String(toolCall?.name || '');
  const args = toolCall?.args || {};
  if (name === 'call_mcp_tool') {
    if (!isSupermemoryServer(args.ServerName)) return null;
    const tool = String(args.ToolName || '').replace(/^"|"$/g, '');
    let toolArgs = args.Arguments;
    if (typeof toolArgs === 'string') {
      try {
        toolArgs = JSON.parse(toolArgs);
      } catch {}
    }
    return tool ? { tool, args: toolArgs || {} } : null;
  }
  const native = name.match(/^mcp_(.*supermemory)_(.+)$/i);
  if (native) return { tool: native[2], args };
  return null;
}

module.exports = {
  ALWAYS_LOAD_TOOLS,
  READ_ONLY_TOOLS,
  REPO_SCOPED_TOOLS,
  isSupermemoryServer,
  resolveSupermemoryTool,
};
