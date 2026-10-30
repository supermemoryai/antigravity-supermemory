const crypto = require('node:crypto');
const { readSessionJson, writeSessionJson } = require('./session-state');

const MAX_SEEN = 500;
const SEEN_FILE = 'recalled.json';

// Profile facts carry a "[2026-10-30] " date tag that the same memory lacks as
// a search hit; hash the fact itself so one memory is injected once.
function factHash(text) {
  return crypto
    .createHash('sha256')
    .update(
      String(text)
        .replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .digest('hex')
    .slice(0, 16);
}

function readSeen(conversationId) {
  const list = readSessionJson(conversationId, SEEN_FILE);
  return Array.isArray(list) ? list.filter((h) => typeof h === 'string') : [];
}

// Best effort: a failed write only risks repeating a fact.
function addSeen(conversationId, texts) {
  if (!texts.length) return;
  const seen = readSeen(conversationId);
  writeSessionJson(
    conversationId,
    SEEN_FILE,
    [...new Set([...seen, ...texts.map(factHash)])].slice(-MAX_SEEN),
  );
}

module.exports = { addSeen, factHash, readSeen };
