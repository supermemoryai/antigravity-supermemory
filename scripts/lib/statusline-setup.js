const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PLUGIN_ROOT,
  SETTINGS_DIR,
  STATUSLINE_MARKER_FILE,
} = require('./paths');

// The status line is an Antigravity CLI setting, not a plugin component, so
// turning it on edits ~/.gemini/antigravity-cli/settings.json. The entry runs a
// small launcher under ~/.supermemory-antigravity instead of the plugin's own
// script: the plugin directory disappears on uninstall, and a launcher that
// prints nothing then is better than a broken status bar.
const LAUNCHER_FILE = path.join(SETTINGS_DIR, 'statusline.js');

function cliDir() {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

function cliSettingsFile() {
  return path.join(cliDir(), 'settings.json');
}

function statuslineCommand() {
  return `node "${LAUNCHER_FILE}"`;
}

// Builds before the launcher pointed the CLI straight at the plugin script.
function directCommand() {
  return `node "${path.join(PLUGIN_ROOT, 'scripts', 'statusline.js')}"`;
}

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeJsonAtomic(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
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

// Present once Supermemory has set up the line on this machine, so a line the
// user removed stays removed.
function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(STATUSLINE_MARKER_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function isOurs(command, marker) {
  return (
    command === statuslineCommand() ||
    command === directCommand() ||
    (Boolean(marker?.command) && command === marker.command)
  );
}

function writeLauncher() {
  const target = path.join(PLUGIN_ROOT, 'scripts', 'statusline.js');
  const source = `// Written by the Supermemory plugin for Antigravity. Runs the plugin's status
// line while it is installed and prints nothing once it is removed.
const target = ${JSON.stringify(target)};
if (require('node:fs').existsSync(target)) require(target).main();
`;
  try {
    if (fs.readFileSync(LAUNCHER_FILE, 'utf8') === source) return;
  } catch {}
  writeFileAtomic(LAUNCHER_FILE, source);
}

function writeEntry(settings) {
  writeLauncher();
  const command = statuslineCommand();
  settings.statusLine = { type: 'command', command, stack_with_default: true };
  writeJsonAtomic(cliSettingsFile(), settings);
  writeJsonAtomic(STATUSLINE_MARKER_FILE, { command });
}

function statuslineState() {
  let command;
  try {
    command = readCliSettings().statusLine?.command;
  } catch {
    return 'unreadable CLI settings';
  }
  const marker = readMarker();
  if (command) return isOurs(command, marker) ? 'on' : 'custom status line';
  if (marker) return 'off';
  return fs.existsSync(cliDir())
    ? 'turns on at the next conversation'
    : 'Antigravity CLI not set up';
}

// SessionStart: turn the line on once, keep it pointing at this plugin, and
// never bring it back after the user removed it. Returns a notice when it
// changed the user's settings for the first time.
function ensureStatusline() {
  // Nothing to configure until the Antigravity CLI has run on this machine.
  if (!fs.existsSync(cliDir())) return null;
  const settings = readCliSettings();
  const marker = readMarker();
  const command = settings.statusLine?.command;
  if (command) {
    if (!isOurs(command, marker)) return null;
    if (command === statuslineCommand()) writeLauncher();
    else writeEntry(settings);
    return null;
  }
  if (marker) return null;
  writeEntry(settings);
  return 'added the Supermemory line to the Antigravity CLI status bar (shows from the next `agy` start)';
}

// Explicit `statusline install`: also turns a removed line back on. Returns
// the command of a custom line it left in place.
function installStatusline() {
  const settings = readCliSettings();
  const command = settings.statusLine?.command;
  if (command && !isOurs(command, readMarker())) return { custom: command };
  writeEntry(settings);
  return { installed: true };
}

// Removes only the entry Supermemory wrote and keeps the marker, so the line
// stays off.
function uninstallStatusline() {
  const settings = readCliSettings();
  const marker = readMarker();
  const command = settings.statusLine?.command;
  const removed = Boolean(command) && isOurs(command, marker);
  if (removed) {
    delete settings.statusLine;
    writeJsonAtomic(cliSettingsFile(), settings);
  }
  writeJsonAtomic(STATUSLINE_MARKER_FILE, {
    command: marker?.command || statuslineCommand(),
    removedAt: new Date().toISOString(),
  });
  return removed;
}

module.exports = {
  LAUNCHER_FILE,
  ensureStatusline,
  installStatusline,
  statuslineCommand,
  statuslineState,
  uninstallStatusline,
};
