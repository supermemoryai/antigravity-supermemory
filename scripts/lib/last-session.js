const fs = require('node:fs');
const { SETTINGS_DIR, LAST_SESSION_FILE } = require('./paths');

// The most recent saved conversation, for the "welcome back" notice.
function saveLastSession({ id, containerTag }) {
  if (!id) return;
  fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    LAST_SESSION_FILE,
    JSON.stringify(
      {
        id,
        containerTag: containerTag || null,
        savedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

function welcomeBackNotice(namespace, now = Date.now()) {
  try {
    const last = JSON.parse(fs.readFileSync(LAST_SESSION_FILE, 'utf-8'));
    if (!last.savedAt || last.containerTag !== namespace) return null;
    const hours = (now - new Date(last.savedAt).getTime()) / 3600000;
    if (!(hours >= 6)) return null;
    const ago =
      hours < 48
        ? `${Math.round(hours)}h ago`
        : `${Math.round(hours / 24)}d ago`;
    return `welcome back — last session here ${ago}`;
  } catch {
    return null;
  }
}

module.exports = { LAST_SESSION_FILE, saveLastSession, welcomeBackNotice };
