const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { STATE_ROOT, CAPTURE_NOTICE_FILE } = require('./paths');

// Per-conversation state shared by the hooks (writers) and the status line
// (reader). Keyed by a hash of the conversation id so ids never hit the disk.
const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SCHEMA_VERSION = 1;

function getSessionDir(conversationId) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) return null;
  return path.join(
    STATE_ROOT,
    crypto.createHash('sha256').update(conversationId.trim()).digest('hex'),
  );
}

function atomicWriteJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
  const temporary = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );

  try {
    fs.writeFileSync(temporary, JSON.stringify(value), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
}

function normalizeCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.floor(count));
}

function writeState(conversationId, event, data = {}) {
  if (!['context', 'capture', 'search'].includes(event)) return false;
  const sessionDir = getSessionDir(conversationId);
  if (!sessionDir) return false;
  let fields;
  if (event === 'context') {
    fields = {
      status: ['loading', 'ready', 'error', 'signed_out'].includes(data.status)
        ? data.status
        : 'ready',
      memoryItemsLoaded: normalizeCount(data.memoryItemsLoaded),
    };
  } else if (event === 'capture') {
    fields = {
      status: ['saving', 'saved', 'error', 'no_content'].includes(data.status)
        ? data.status
        : 'error',
      count: normalizeCount(data.count),
    };
  } else {
    fields = {
      results: normalizeCount(data.results),
      count: normalizeCount(data.count),
      memories: normalizeCount(data.memories),
    };
  }
  try {
    atomicWriteJson(path.join(sessionDir, `${event}.json`), {
      version: SCHEMA_VERSION,
      event,
      updatedAt: Date.now(),
      ...fields,
    });
    return true;
  } catch {
    return false;
  }
}

function readState(conversationId, event) {
  const sessionDir = getSessionDir(conversationId);
  if (!sessionDir) return null;
  try {
    const record = JSON.parse(
      fs.readFileSync(path.join(sessionDir, `${event}.json`), 'utf8'),
    );
    return record?.version === SCHEMA_VERSION && record?.event === event
      ? record
      : null;
  } catch {
    return null;
  }
}

function readSessionJson(conversationId, name) {
  const sessionDir = getSessionDir(conversationId);
  if (!sessionDir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, name), 'utf8'));
  } catch {
    return null;
  }
}

function writeSessionJson(conversationId, name, value) {
  const sessionDir = getSessionDir(conversationId);
  if (!sessionDir) return false;
  try {
    atomicWriteJson(path.join(sessionDir, name), value);
    return true;
  } catch {
    return false;
  }
}

function pruneState() {
  const cutoff = Date.now() - SESSION_RETENTION_MS;
  try {
    for (const entry of fs.readdirSync(STATE_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const sessionDir = path.join(STATE_ROOT, entry.name);
      let newest = 0;
      try {
        newest = fs.statSync(sessionDir).mtimeMs;
        for (const file of fs.readdirSync(sessionDir)) {
          newest = Math.max(
            newest,
            fs.statSync(path.join(sessionDir, file)).mtimeMs,
          );
        }
      } catch {
        continue;
      }
      if (newest < cutoff)
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  } catch {}
}

// Capture runs detached and exits 0, so a failed save only reaches the user
// through the next SessionStart notice.
function writeCaptureNotice(message) {
  const text = String(message || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  if (!text) return false;
  try {
    atomicWriteJson(CAPTURE_NOTICE_FILE, { message: text });
    return true;
  } catch {
    return false;
  }
}

function readCaptureNotice() {
  try {
    const record = JSON.parse(fs.readFileSync(CAPTURE_NOTICE_FILE, 'utf8'));
    if (typeof record?.message !== 'string' || !record.message.trim())
      return null;
    return { message: record.message.trim() };
  } catch {
    return null;
  }
}

function clearCaptureNotice() {
  try {
    fs.unlinkSync(CAPTURE_NOTICE_FILE);
  } catch {}
}

module.exports = {
  atomicWriteJson,
  clearCaptureNotice,
  getSessionDir,
  pruneState,
  readCaptureNotice,
  readSessionJson,
  readState,
  writeCaptureNotice,
  writeSessionJson,
  writeState,
};
