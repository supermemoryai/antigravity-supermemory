#!/usr/bin/env node
// Command-line entry point used by the plugin's skills and by people directly:
//   node scripts/cli.js <login|logout|status|statusline|version> [options]
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
const { loadProjectConfig } = require('./lib/project-config');
const {
  getApiKeySource,
  getApiVersion,
  getAuthToken,
  getBaseUrl,
  getMcpUrl,
  getRecallConfig,
} = require('./lib/settings');
const {
  installStatusline,
  statuslineState,
  uninstallStatusline,
} = require('./lib/statusline-setup');
const { PLUGIN_VERSION, SOURCE } = require('./lib/version');

const AGENT_LOGIN_WAIT_MS = 25000;

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

// The status line turns itself on at SessionStart; these commands turn it
// back on after a removal, or off for good.
function statusline(args) {
  const action = args[0] || 'status';
  if (action === 'status') {
    console.log(`Status line: ${statuslineState()}`);
    return;
  }
  if (action === 'install') {
    const { custom } = installStatusline();
    console.log(
      custom
        ? `A custom status line is already configured (${custom}); Supermemory's line was not added. Remove it first to use Supermemory's.`
        : 'Supermemory status line turned on under the built-in one. Restart agy to see it.',
    );
    return;
  }
  if (action === 'uninstall') {
    console.log(
      uninstallStatusline()
        ? 'Supermemory status line turned off. Restart agy to apply.'
        : 'No Supermemory status line is configured; it will stay off.',
    );
    return;
  }
  throw new Error('Usage: statusline <install|uninstall|status>');
}

const HELP = `Usage: node scripts/cli.js <command>

  login [--print-url]   Connect Supermemory through the browser (OAuth)
  logout                Sign out and revoke the stored token
  status [--json]       Show sign-in, project memory space, and API reachability
  statusline <install|uninstall|status>
                        Turn the Antigravity CLI status line on or off (on by default)
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

module.exports = { main, run };
