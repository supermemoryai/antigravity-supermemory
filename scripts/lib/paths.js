const os = require('node:os');
const path = require('node:path');

// Fixed home-relative location: hooks, the MCP proxy, the status line and the
// CLI run as separate processes with different working directories, so none of
// them may rely on cwd or the plugin directory to find shared state. The plugin
// directory itself is replaced on every update.
const SETTINGS_DIR = path.join(os.homedir(), '.supermemory-antigravity');

module.exports = {
  SETTINGS_DIR,
  SETTINGS_FILE: path.join(SETTINGS_DIR, 'settings.json'),
  CREDENTIALS_FILE: path.join(SETTINGS_DIR, 'credentials.json'),
  CLIENT_FILE: path.join(SETTINGS_DIR, 'oauth-client.json'),
  LOCK_FILE: path.join(SETTINGS_DIR, 'auth.lock'),
  LOGGED_OUT_FILE: path.join(SETTINGS_DIR, 'logged-out.json'),
  TRACKER_DIR: path.join(SETTINGS_DIR, 'trackers'),
  STATE_ROOT: path.join(SETTINGS_DIR, 'statusline', 'statusline-state'),
  CAPTURE_NOTICE_FILE: path.join(SETTINGS_DIR, 'capture-notice.json'),
  LAST_SESSION_FILE: path.join(SETTINGS_DIR, 'last-session.json'),
  MARK_TIP_FILE: path.join(SETTINGS_DIR, 'mark-tip-shown'),
  STATUSLINE_MARKER_FILE: path.join(SETTINGS_DIR, 'statusline-installed.json'),
  PENDING_DIR: path.join(SETTINGS_DIR, 'pending'),
  LOG_FILE: path.join(SETTINGS_DIR, 'debug.log'),
  PLUGIN_ROOT: path.resolve(__dirname, '..', '..'),
};
