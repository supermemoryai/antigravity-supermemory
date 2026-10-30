const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TRACKER_DIR } = require('./paths');

const RETRY_MS = 20;
const WAIT_MS = 25000;
// Beyond a detached capture's full lifetime, so a healthy lock is never stolen.
const STALE_MS = 60000;

function ownerAlive(lockFile) {
  try {
    const pid = Number(fs.readFileSync(lockFile, 'utf8').split(':', 1)[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code !== 'ESRCH';
    }
  } catch {
    return null;
  }
}

/**
 * Serialize the read / upload / commit transaction for one conversation. Two
 * Stop events in quick succession spawn two detached captures; the later one
 * waits and then re-reads the cursor the earlier one committed.
 */
async function withCaptureLock(conversationId, action, waitMs = WAIT_MS) {
  fs.mkdirSync(TRACKER_DIR, { recursive: true, mode: 0o700 });
  const key = crypto.createHash('sha256').update(conversationId).digest('hex');
  const lockFile = path.join(TRACKER_DIR, `${key}.capture.lock`);
  const deadline = Date.now() + waitMs;

  while (Date.now() <= deadline) {
    let fd = null;
    const owner = `${process.pid}:${Date.now()}:${Math.random()}`;
    try {
      fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(fd, owner);
      await action();
      return true;
    } catch (error) {
      if (fd !== null || error.code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        // PID reuse must not make a lock immortal.
        if (ownerAlive(lockFile) === false || age > STALE_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    } finally {
      if (fd !== null) {
        fs.closeSync(fd);
        try {
          if (fs.readFileSync(lockFile, 'utf8') === owner)
            fs.unlinkSync(lockFile);
        } catch {}
      }
    }
  }
  return false;
}

module.exports = { withCaptureLock };
