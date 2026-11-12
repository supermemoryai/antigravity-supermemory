const fs = require('node:fs');
const { SETTINGS_DIR, SETTINGS_FILE, LOG_FILE } = require('./paths');
const {
  loadCredentials,
  getAccessToken,
  getOAuthConfig,
  hasOAuthCredentials,
} = require('./auth');
const { loadProjectConfig } = require('./project-config');

const BASE_URL = 'https://api.supermemory.ai';

const DEFAULT_SETTINGS = {
  includeTools: [],
  maxProfileItems: 5,
  debug: false,
  injectProfile: true,
  recallDirective: null,
  signalExtraction: false,
  signalKeywords: [
    'remember',
    'implementation',
    'refactor',
    'architecture',
    'decision',
    'important',
    'bug',
    'fix',
    'solved',
    'solution',
    'pattern',
    'approach',
    'design',
    'tradeoff',
    'migrate',
    'upgrade',
    'deprecate',
  ],
  signalTurnsBefore: 3,
  captureHeadless: false,
};

function loadSettings() {
  const settings = { ...DEFAULT_SETTINGS };
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      Object.assign(
        settings,
        JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')),
      );
    }
  } catch (err) {
    console.error(`Settings: Failed to load ${SETTINGS_FILE}: ${err.message}`);
  }
  if (process.env.SUPERMEMORY_DEBUG === 'true') settings.debug = true;
  return settings;
}

// Antigravity-specific key first, then the generic one shared with other tools.
function getEnvApiKey() {
  return (
    process.env.SUPERMEMORY_ANTIGRAVITY_API_KEY ||
    process.env.SUPERMEMORY_API_KEY ||
    null
  );
}

function getApiKeySource(projectConfig) {
  if (process.env.SUPERMEMORY_ANTIGRAVITY_API_KEY)
    return 'SUPERMEMORY_ANTIGRAVITY_API_KEY';
  if (process.env.SUPERMEMORY_API_KEY) return 'SUPERMEMORY_API_KEY';
  if (projectConfig?.apiKey) return 'project config';
  const credentials = loadCredentials();
  if (credentials?.type === 'oauth') return 'oauth';
  if (credentials?.apiKey) return 'credentials.json';
  return null;
}

async function getAuthToken(cwd, projectConfig, timeoutMs) {
  const envKey = getEnvApiKey();
  if (envKey) return envKey;

  projectConfig = projectConfig || loadProjectConfig(cwd);
  if (projectConfig?.apiKey) return projectConfig.apiKey;

  const credentials = loadCredentials();
  if (credentials?.type === 'oauth') {
    return getAccessToken(
      getOAuthConfig(
        getBaseUrl(cwd, projectConfig),
        getMcpUrl(cwd, projectConfig),
      ),
      timeoutMs,
    );
  }
  if (credentials?.apiKey) return credentials.apiKey;

  throw Object.assign(new Error('AUTH_REQUIRED'), { code: 'AUTH_REQUIRED' });
}

// Cheap synchronous check for hooks that must never start a login.
function isConfigured(cwd, projectConfig) {
  if (getEnvApiKey()) return true;
  projectConfig = projectConfig || loadProjectConfig(cwd);
  if (projectConfig?.apiKey) return true;
  const credentials = loadCredentials();
  if (credentials?.apiKey) return true;
  try {
    return hasOAuthCredentials(
      getOAuthConfig(
        getBaseUrl(cwd, projectConfig),
        getMcpUrl(cwd, projectConfig),
      ),
    );
  } catch {
    return false;
  }
}

function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return null;

  const trimmed = baseUrl.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return trimmed;
  } catch {
    return null;
  }
}

function getBaseUrl(cwd, projectConfig) {
  projectConfig = projectConfig || loadProjectConfig(cwd);
  const configured =
    process.env.SUPERMEMORY_API_URL ||
    process.env.SUPERMEMORY_BASE_URL ||
    projectConfig?.baseUrl ||
    loadCredentials()?.apiBaseUrl ||
    BASE_URL;
  const normalized = normalizeBaseUrl(configured);
  if (!normalized) {
    throw new Error('Invalid baseUrl: expected an absolute http(s) URL');
  }
  return normalized;
}

function getMcpUrl(cwd, projectConfig) {
  if (process.env.SUPERMEMORY_MCP_URL) {
    const configured = normalizeBaseUrl(process.env.SUPERMEMORY_MCP_URL);
    if (!configured) throw new Error('Invalid SUPERMEMORY_MCP_URL');
    return configured;
  }
  const api = new URL(getBaseUrl(cwd, projectConfig));
  if (api.hostname.startsWith('api.')) {
    api.hostname = api.hostname.replace(/^api\./, 'mcp.');
    api.pathname = '/mcp';
    api.search = '';
    api.hash = '';
    return api.toString();
  }
  throw new Error('Set SUPERMEMORY_MCP_URL for a custom Supermemory backend.');
}

function resolveApiVersion(baseUrl, configured) {
  if (configured !== undefined && configured !== null && configured !== '') {
    if (configured !== 'v5' && configured !== 'legacy') {
      throw new Error('Invalid apiVersion: expected "v5" or "legacy"');
    }
    return configured;
  }
  const url = new URL(baseUrl);
  const hosted =
    url.origin === BASE_URL &&
    !url.pathname.replace(/\/+$/, '') &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password;
  return hosted ? 'v5' : 'legacy';
}

function getApiVersion(cwd, projectConfig) {
  projectConfig = projectConfig || loadProjectConfig(cwd);
  return resolveApiVersion(
    getBaseUrl(cwd, projectConfig),
    process.env.SUPERMEMORY_API_VERSION || projectConfig?.apiVersion,
  );
}

// Hook stdout is the protocol channel and stderr lands in Antigravity's own
// log, so debug output goes to a file the user can tail.
function debugLog(settings, message, data) {
  if (!settings.debug) return;
  const line = data
    ? `[${new Date().toISOString()}] ${message}: ${JSON.stringify(data)}\n`
    : `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

function getIncludeTools(cwd) {
  const settings = loadSettings();
  const projectConfig = loadProjectConfig(cwd);
  return [
    ...new Set([
      ...(settings.includeTools || []),
      ...(projectConfig?.includeTools || []),
    ]),
  ].map((t) => String(t).toLowerCase());
}

function shouldIncludeTool(toolNames, includeList) {
  if (includeList.length === 0) return false;
  return toolNames.some(
    (name) => name && includeList.includes(String(name).toLowerCase()),
  );
}

function getSignalConfig(cwd) {
  const settings = loadSettings();
  const projectConfig = loadProjectConfig(cwd);

  const enabled =
    projectConfig?.signalExtraction !== undefined
      ? projectConfig.signalExtraction
      : settings.signalExtraction || false;

  const keywords = [
    ...new Set([
      ...(settings.signalKeywords || DEFAULT_SETTINGS.signalKeywords),
      ...(projectConfig?.signalKeywords || []),
    ]),
  ].map((k) => k.toLowerCase());

  const turnsBefore =
    projectConfig?.signalTurnsBefore ||
    settings.signalTurnsBefore ||
    DEFAULT_SETTINGS.signalTurnsBefore;

  return { enabled, keywords, turnsBefore };
}

// true/1/yes/on or false/0/no/off, any case; anything else leaves the setting.
function envFlag(name) {
  const value = process.env[name]?.trim().toLowerCase() ?? '';
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  return undefined;
}

function captureHeadless(settings) {
  return (
    envFlag('SUPERMEMORY_CAPTURE_HEADLESS') ?? settings.captureHeadless === true
  );
}

function getRecallConfig(cwd) {
  const settings = loadSettings();
  const projectConfig = loadProjectConfig(cwd);
  return {
    directive:
      projectConfig?.recallDirective || settings.recallDirective || null,
  };
}

module.exports = {
  BASE_URL,
  captureHeadless,
  DEFAULT_SETTINGS,
  debugLog,
  getApiKeySource,
  getApiVersion,
  getAuthToken,
  getBaseUrl,
  getIncludeTools,
  getMcpUrl,
  getRecallConfig,
  getSignalConfig,
  isConfigured,
  loadSettings,
  resolveApiVersion,
  shouldIncludeTool,
};
