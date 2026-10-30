const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { fileURLToPath } = require('node:url');
const { settleAuth } = require('./lib/auth');
const { getNamespace } = require('./lib/container-tag');
const { getAuthToken, getMcpUrl } = require('./lib/settings');
const { ALWAYS_LOAD_TOOLS, REPO_SCOPED_TOOLS } = require('./lib/tools');
const { SOURCE } = require('./lib/version');

// A stdio bridge to the hosted Supermemory MCP server. It exists so the MCP
// tools and the hooks share one sign-in (OAuth or API key) and so tool calls
// default to the current repository's memory space.
const REQUEST_TIMEOUT_MS = 30000;
const ROOTS_WAIT_MS = 1500;
const ALWAYS_LOAD_META = 'antigravity/alwaysLoad';

let sessionId = null;
let protocolVersion = null;
let workspace = null;
let rootsRequest = 0;
let rootsResolve = null;
let rootsReady = new Promise((resolve) => {
  rootsResolve = resolve;
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(id, code, message) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// The plugin's cwd is the plugin directory, never the project, so the
// workspace comes from the client's roots.
function requestRoots() {
  rootsRequest += 1;
  send({
    jsonrpc: '2.0',
    id: `sm-roots-${rootsRequest}`,
    method: 'roots/list',
  });
}

function rootPath(root) {
  try {
    const uri = String(root?.uri || '');
    const candidate = uri.startsWith('file:') ? fileURLToPath(uri) : uri;
    return candidate && fs.statSync(candidate).isDirectory()
      ? path.resolve(candidate)
      : null;
  } catch {
    return null;
  }
}

function handleRoots(message) {
  const roots = Array.isArray(message.result?.roots)
    ? message.result.roots
    : [];
  workspace = roots.map(rootPath).find(Boolean) || null;
  rootsResolve?.();
}

async function currentNamespace() {
  if (!workspace) {
    await Promise.race([
      rootsReady,
      new Promise((resolve) => setTimeout(resolve, ROOTS_WAIT_MS)),
    ]);
  }
  if (!workspace) return null;
  try {
    return getNamespace(workspace);
  } catch {
    return null;
  }
}

function parseArgs(args) {
  if (typeof args !== 'string') return { value: args, encoded: false };
  try {
    return { value: JSON.parse(args), encoded: true };
  } catch {
    return { value: null, encoded: true };
  }
}

async function injectRepoNamespace(message) {
  if (message.method !== 'tools/call') return;
  const params = message.params;
  if (!params || typeof params !== 'object') return;
  if (!REPO_SCOPED_TOOLS.has(params.name)) return;
  const { value, encoded } = parseArgs(params.arguments);
  const args = value == null ? {} : value;
  if (typeof args !== 'object' || Array.isArray(args)) return;
  const hasScope = ['namespace', 'containerTag'].some(
    (key) => typeof args[key] === 'string' && args[key].trim(),
  );
  if (hasScope) return;
  const namespace = await currentNamespace();
  if (!namespace) return;
  args.namespace = namespace;
  params.arguments = encoded ? JSON.stringify(args) : args;
}

// tools/list results get the always-load flag; initialize results tell us the
// negotiated protocol version for later request headers.
function rewriteResult(message, requestMethod) {
  if (!message || typeof message !== 'object' || !message.result)
    return message;
  if (requestMethod === 'initialize' && message.result.protocolVersion) {
    protocolVersion = message.result.protocolVersion;
  }
  if (requestMethod === 'tools/list' && Array.isArray(message.result.tools)) {
    for (const tool of message.result.tools) {
      if (ALWAYS_LOAD_TOOLS.has(tool?.name)) {
        tool._meta = { ...(tool._meta || {}), [ALWAYS_LOAD_META]: true };
      }
    }
  }
  return message;
}

function emitPayload(data, requestMethod) {
  const text = data.trim();
  if (!text) return;
  try {
    const parsed = JSON.parse(text);
    const rewritten = Array.isArray(parsed)
      ? parsed.map((m) => rewriteResult(m, requestMethod))
      : rewriteResult(parsed, requestMethod);
    send(rewritten);
  } catch {
    process.stdout.write(`${text}\n`);
  }
}

// Emit each SSE event as it arrives: a server-initiated request inside the
// stream must reach the client before the stream ends, or both sides wait.
async function streamSse(response, requestMethod) {
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (chunk) => {
    const data = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data) emitPayload(data, requestMethod);
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(buffer);
      if (!boundary) break;
      const event = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      flush(event);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) flush(buffer);
}

async function forward(message, apiKey) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'x-sm-source': SOURCE,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;

  const response = await fetch(getMcpUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const nextSessionId = response.headers.get('mcp-session-id');
  if (nextSessionId) sessionId = nextSessionId;

  if (response.status === 202) return;
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (response.status === 404 && sessionId) sessionId = null;
    sendError(
      message.id,
      response.status === 401 ? -32001 : -32000,
      response.status === 401
        ? 'Supermemory rejected the credentials. Run /supermemory-login, or check SUPERMEMORY_ANTIGRAVITY_API_KEY.'
        : `Supermemory MCP ${response.status}: ${text.slice(0, 200) || 'request failed'}`,
    );
    return;
  }

  if (
    (response.headers.get('content-type') || '').includes('text/event-stream')
  ) {
    await streamSse(response, message.method);
    return;
  }
  const body = await response.text();
  if (body.trim()) emitPayload(body, message.method);
}

async function handle(message) {
  try {
    // Re-read on every message: SessionStart may finish signing in after
    // this process started, and OAuth tokens expire during long sessions.
    const apiKey = await getAuthToken(workspace || undefined);
    await injectRepoNamespace(message);
    await forward(message, apiKey);
  } catch (err) {
    // A failed relay of the client's own response has no request to answer.
    if (!message.method) return;
    if (err.code === 'AUTH_REQUIRED') {
      sessionId = null;
      sendError(
        message.id,
        -32001,
        'Supermemory is not signed in. Start a new Antigravity conversation to sign in, run /supermemory-login, or set SUPERMEMORY_ANTIGRAVITY_API_KEY.',
      );
      return;
    }
    sendError(
      message.id,
      -32000,
      `Supermemory MCP proxy error: ${err.message}`,
    );
  }
}

function main() {
  let queue = Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    // Answers to our own roots/list requests never leave the machine.
    if (
      !message.method &&
      typeof message.id === 'string' &&
      message.id.startsWith('sm-roots-')
    ) {
      handleRoots(message);
      return;
    }
    if (message.method === 'notifications/roots/list_changed') {
      rootsReady = new Promise((resolve) => {
        rootsResolve = resolve;
      });
      requestRoots();
      return;
    }
    // The 2026-07-28 discovery handshake is not served by the hosted server;
    // declining it makes the client fall back to initialize.
    if (message.method === 'server/discover') {
      sendError(message.id, -32601, 'Method not found');
      return;
    }

    // Responses to server-initiated requests must not wait behind a tool call
    // that is itself waiting for them.
    if (!message.method) {
      handle(message);
      return;
    }

    queue = queue.then(() => handle(message));
    if (message.method === 'notifications/initialized') {
      queue = queue.then(() => requestRoots());
    }
  });

  rl.on('close', () => {
    // Let a refresh that is still rotating tokens save them before exiting.
    queue.then(settleAuth).then(() => process.exit(0));
  });
}

if (require.main === module) main();

module.exports = { handleRoots, injectRepoNamespace, rewriteResult, streamSse };
