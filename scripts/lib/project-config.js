const fs = require('node:fs');
const path = require('node:path');
const { getGitRoot } = require('./git-utils');

// Antigravity keeps workspace customizations under .agents/.
const CONFIG_DIR = path.join('.agents', '.supermemory');
const CONFIG_FILE = 'config.json';
// A namespace pinned for the Claude Code plugin applies here too, so both
// agents keep reading and writing the same project memory.
const CLAUDE_CONFIG = path.join(
  '.claude',
  '.supermemory-claude',
  'config.json',
);

function getBasePath(cwd) {
  return getGitRoot(cwd) || cwd;
}

function getConfigPath(cwd) {
  return path.join(getBasePath(cwd), CONFIG_DIR, CONFIG_FILE);
}

function readJson(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {}
  return null;
}

function loadProjectConfig(cwd) {
  if (!cwd) return null;
  const own = readJson(getConfigPath(cwd));
  const claude = readJson(path.join(getBasePath(cwd), CLAUDE_CONFIG));
  if (!own && !claude) return null;
  const shared = claude
    ? {
        namespace: claude.namespace,
        repoContainerTag: claude.repoContainerTag,
      }
    : {};
  return { ...shared, ...(own || {}) };
}

function saveProjectConfig(cwd, config) {
  const configPath = getConfigPath(cwd);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const existing = readJson(configPath) || {};
  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...existing, ...config }, null, 2),
  );
  return configPath;
}

module.exports = {
  getConfigPath,
  loadProjectConfig,
  saveProjectConfig,
};
