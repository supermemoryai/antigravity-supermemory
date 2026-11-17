const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TRACKER_DIR } = require('./paths');
const { atomicWriteJson } = require('./session-state');

const HEAD_BYTES = 4096;
const MAX_DELTA_BYTES = 20 * 1024 * 1024;

function cursorFile(conversationId) {
  const key = crypto.createHash('sha256').update(conversationId).digest('hex');
  return path.join(TRACKER_DIR, `${key}.session.json`);
}

function readCursor(conversationId) {
  try {
    const cursor = JSON.parse(
      fs.readFileSync(cursorFile(conversationId), 'utf8'),
    );
    if (
      Number.isSafeInteger(cursor?.offset) &&
      Number.isSafeInteger(cursor?.generation)
    ) {
      return {
        offset: cursor.offset,
        generation: cursor.generation,
        headHash: typeof cursor.headHash === 'string' ? cursor.headHash : '',
      };
    }
  } catch {}
  return { offset: 0, generation: 0, headHash: '' };
}

function hashPrefix(fd, length) {
  if (length <= 0) return '';
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, 0);
  return crypto
    .createHash('sha256')
    .update(buffer.subarray(0, read))
    .digest('hex');
}

function readRawDelta(transcriptPath, conversationId) {
  if (!fs.statSync(transcriptPath).isFile()) {
    throw new Error('Transcript must be a regular file');
  }
  const previous = readCursor(conversationId);
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let { offset, generation } = previous;
    if (
      size < offset ||
      (previous.headHash &&
        previous.headHash !== hashPrefix(fd, Math.min(HEAD_BYTES, offset)))
    ) {
      offset = 0;
      generation += 1;
    }
    const length = Math.min(size - offset, MAX_DELTA_BYTES);
    if (length <= 0) return null;
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, offset);
    const end = buffer.subarray(0, read).lastIndexOf(0x0a) + 1;
    if (end === 0) return null;
    const nextOffset = offset + end;
    const headHash = hashPrefix(fd, Math.min(HEAD_BYTES, nextOffset));
    return {
      raw: buffer.toString('utf8', 0, end),
      generation,
      offset,
      commit: () =>
        atomicWriteJson(cursorFile(conversationId), {
          offset: nextOffset,
          generation,
          headHash,
        }),
    };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readRawDelta };
