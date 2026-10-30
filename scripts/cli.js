#!/usr/bin/env node
// Command-line entry point used by the plugin's skills and by people directly:
//   node scripts/cli.js <login|logout|status|statusline|version> [options]
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getProfile } = require('./lib/api');
const {
  AUTH_WAIT_MS,
  clearCredentials,
  getOAuthConfig,
  settleAuth,
  startAuthFlow,
  startBackgroundAuth,
} = require('./lib/auth');
const { getNamespace, getProjectName } = require('./lib/container-tag');
const { getUserFriendlyError } = require('./lib/error-helpers');
const { PLUGIN_ROOT, STATUSLINE_MARKER_FILE } = require('./lib/paths');
const { loadProjectConfig } = require('./lib/project-config');
const {
  getApiKeySource,
  getApiVersion,
  getAuthToken,
  getBaseUrl,
  getMcpUrl,
  getRecallConfig,
} = require('./lib/settings');
const { PLUGIN_VERSION, SOURCE } = require('./lib/version');

const AGENT_LOGIN_WAIT_MS = 25000;

function cliSettingsFile() {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
}

function statuslineCommand() {
  return `node "${path.join(PLUGIN_ROOT, 'scripts', 'statusline.js')}"`;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function workspaceFrom(args) {
  return path.resolve(argValue(args, '--cwd') || process.cwd());
}

async function login(args) {
  const cwd = workspaceFrom(args);
  const projectConfig = loadProjectConfig(cwd);
  const config = getOAuthConfig(
    getBaseUrl(cwd, projectConfig),
    getMcpUrl(cwd, projectConfig),
  );
  if (args.includes('--print-url')) {
    await startAuthFlow(config, { force: true, printUrl: true });
    console.log('Supermemory connected.');
    return;
  }
  // An agent's run_command is not a terminal: hand the browser wait to a
  // detached listener so the command returns while the user signs in.
  if (!process.stdout.isTTY || args.includes('--background')) {
    try {
      await startBackgroundAuth(config, AGENT_LOGIN_WAIT_MS);
      console.log(
        'Supermemory connected. Memory is active from the next message.',
      );
    } catch (error) {
      if (error.message !== 'AUTH_PENDING') throw error;
      console.log(
        `A browser window opened for Supermemory sign-in. Finish it within ${AUTH_WAIT_MS / 60000} minutes; memory turns on from the next message.`,
      );
    }
    return;
  }
  console.log('Opening the browser to connect Supermemory…');
  await startAuthFlow(config, { force: true });
  console.log('Supermemory connected.');
}

async function logout() {
  await clearCredentials();
  console.log(
    'Supermemory signed out. New conversations will not load or save memory until you run /supermemory-login.',
  );
}

async function fetchSession(baseUrl, apiKey) {
  for (const route of ['/session', '/v3/session']) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${route}`, {
        headers: { Authorization: `Bearer ${apiKey}`, 'x-sm-source': SOURCE },
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) return await response.json();
    } catch {}
  }
  return null;
}

function statuslineState() {
  try {
    const settings = JSON.parse(fs.readFileSync(cliSettingsFile(), 'utf8'));
    const command = settings?.statusLine?.command;
    if (!command) return 'not installed';
    return command === statuslineCommand() ? 'installed' : 'custom status line';
  } catch {
    return 'not installed';
  }
}

async function status(args) {
  const cwd = workspaceFrom(args);
  const projectConfig = loadProjectConfig(cwd);
  const report = {
    version: PLUGIN_VERSION,
    authenticated: false,
    keySource: getApiKeySource(projectConfig),
    project: getProjectName(cwd),
    namespace: null,
    apiOrigin: null,
    apiVersion: null,
    mcpUrl: null,
    httpStatus: null,
    account: null,
    recall: getRecallConfig(cwd).directive
      ? 'advisory directive'
      : 'every substantive prompt',
    capture: 'after each completed turn',
    statusLine: statuslineState(),
  };
  try {
    report.namespace = getNamespace(cwd);
    const baseUrl = getBaseUrl(cwd, projectConfig);
    report.apiOrigin = new URL(baseUrl).origin;
    report.apiVersion = getApiVersion(cwd, projectConfig);
    report.mcpUrl = getMcpUrl(cwd, projectConfig);
    let apiKey;
    try {
      apiKey = await getAuthToken(cwd, projectConfig, 8000);
    } catch {
      return finish(report, args);
    }
    try {
      await getProfile(baseUrl, apiKey, report.namespace, undefined, {
        apiVersion: report.apiVersion,
        timeoutMs: 8000,
      });
      report.authenticated = true;
      report.httpStatus = 200;
    } catch (err) {
      report.httpStatus = err?.status ?? err?.statusCode ?? null;
      report.authenticated = report.httpStatus === 401 ? false : null;
      report.error =
        report.httpStatus === 404
          ? 'Endpoint responded; profile absent or route unsupported. Authentication is unknown.'
          : getUserFriendlyError(err);
    }
    const session = await fetchSession(baseUrl, apiKey);
    if (session) {
      report.account = {
        email: session.user?.email,
        name: session.user?.name,
        organization: session.org?.name,
      };
    }
  } catch (err) {
    report.error = getUserFriendlyError(err);
  }
  return finish(report, args);
}

function finish(report, args) {
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const signedIn =
    report.authenticated === true
      ? `yes (${report.keySource})`
      : report.authenticated === null
        ? `unknown (${report.keySource})`
        : report.keySource
          ? `no — credentials rejected (${report.keySource})`
          : 'no';
  const lines = [
    `◪ supermemory for Antigravity v${report.version}`,
    '',
    `Signed in:    ${signedIn}`,
  ];
  if (report.account?.email) {
    lines.push(
      `Account:      ${report.account.email}${report.account.organization ? ` (${report.account.organization})` : ''}`,
    );
  }
  if (report.apiOrigin) {
    lines.push(
      `API:          ${report.apiOrigin} (${report.apiVersion})${report.httpStatus ? ` — HTTP ${report.httpStatus}` : ''}`,
    );
  }
  if (report.mcpUrl) lines.push(`MCP:          ${report.mcpUrl}`);
  lines.push(`Project:      ${report.project}`);
  if (report.namespace) lines.push(`Memory space: ${report.namespace}`);
  lines.push(`Recall:       ${report.recall}`);
  lines.push(`Capture:      ${report.capture}`);
  lines.push(`Status line:  ${report.statusLine} (Antigravity CLI)`);
  if (report.error) lines.push('', `Note: ${report.error}`);
  if (!report.keySource) {
    lines.push(
      '',
      'Not connected. Start a new conversation to sign in, run /supermemory-login, or set SUPERMEMORY_ANTIGRAVITY_API_KEY.',
    );
  }
  console.log(lines.join('\n'));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readCliSettings() {
  const file = cliSettingsFile();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON (${error.message}). Fix it and rerun; nothing was changed.`,
    );
  }
}

// The status line is an Antigravity CLI setting, not a plugin component, so
// installing it edits ~/.gemini/antigravity-cli/settings.json. An existing
// custom line is left alone; uninstall removes only the entry written here.
function statusline(args) {
  const action = args[0] || 'status';
  const command = statuslineCommand();
  if (action === 'status') {
    console.log(`Status line: ${statuslineState()}`);
    return;
  }
  const settings = readCliSettings();
  if (action === 'install') {
    const existing = settings.statusLine;
    if (existing?.command && existing.command !== command) {
      console.log(
        `A custom status line is already configured (${existing.command}); Supermemory's line was not added. Remove it first, or run its output alongside with "stack_with_default": true.`,
      );
      return;
    }
    settings.statusLine = {
      type: 'command',
      command,
      stack_with_default: true,
    };
    writeJsonAtomic(cliSettingsFile(), settings);
    writeJsonAtomic(STATUSLINE_MARKER_FILE, { command });
    console.log(
      'Supermemory status line installed under the built-in one. Restart agy to see it.',
    );
    return;
  }
  if (action === 'uninstall') {
    let marker = null;
    try {
      marker = JSON.parse(fs.readFileSync(STATUSLINE_MARKER_FILE, 'utf8'));
    } catch {}
    if (settings.statusLine?.command === (marker?.command || command)) {
      delete settings.statusLine;
      writeJsonAtomic(cliSettingsFile(), settings);
      console.log('Supermemory status line removed. Restart agy to apply.');
    } else {
      console.log('No Supermemory status line is installed.');
    }
    fs.rmSync(STATUSLINE_MARKER_FILE, { force: true });
    return;
  }
  throw new Error('Usage: statusline <install|uninstall|status>');
}

const HELP = `Usage: node scripts/cli.js <command>

  login [--print-url]   Connect Supermemory through the browser (OAuth)
  logout                Sign out and revoke the stored token
  status [--json]       Show sign-in, project memory space, and API reachability
  statusline <install|uninstall|status>
                        Manage the Antigravity CLI status line
  version               Print the plugin version

Options: --cwd <path> selects the project (default: current directory).`;

async function run(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case 'login':
      return login(args);
    case 'logout':
      return logout();
    case 'status':
      return status(args);
    case 'statusline':
      return statusline(args);
    case 'version':
      console.log(PLUGIN_VERSION);
      return;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

// Shared by this file and the skills' wrapper scripts.
function main(argv) {
  return run(argv)
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(() => settleAuth());
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { main, run, statuslineCommand };
