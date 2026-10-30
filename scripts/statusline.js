#!/usr/bin/env node
// Antigravity CLI status line. The CLI pipes its session state (JSON) to this
// script whenever the agent state changes and shows whatever it prints. Hooks
// write per-conversation state under ~/.supermemory-antigravity; this script
// only reads it, so it stays fast (the CLI kills runs over 5 seconds).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { STATE_ROOT } = require('./lib/paths');

const SCHEMA_VERSION = 1;
const SAVING_TTL_MS = 30 * 1000;
const ERROR_TTL_MS = 60 * 1000;
const INPUT_TIMEOUT_MS = 500;

const color = !process.env.NO_COLOR;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
// Mid-luminance tint of the brand blue (#3B35F3): terminals can't report
// their theme, so the glyph must clear both dark and light backgrounds.
const BRAND = `${paint('1;38;2;124;120;250', '◪')} ${paint('1', 'supermemory')}`;
const dot = paint('38;5;245', ' · ');

function formatAge(ms) {
  const s = Math.max(1, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

function readEvent(conversationId, event) {
  if (!conversationId) return null;
  try {
    const dir = crypto
      .createHash('sha256')
      .update(conversationId)
      .digest('hex');
    const record = JSON.parse(
      fs.readFileSync(path.join(STATE_ROOT, dir, `${event}.json`), 'utf8'),
    );
    return record?.version === SCHEMA_VERSION ? record : null;
  } catch {
    return null;
  }
}

function render(conversationId, now = Date.now()) {
  const context = readEvent(conversationId, 'context');
  const search = readEvent(conversationId, 'search');
  const capture = readEvent(conversationId, 'capture');

  if (capture?.status === 'saving' && now - capture.updatedAt < SAVING_TTL_MS) {
    return `${BRAND}${dot}saving conversation…`;
  }
  if (capture?.status === 'error' && now - capture.updatedAt < ERROR_TTL_MS) {
    return `${BRAND}${dot}${paint('31', 'save failed')}`;
  }
  if (context?.status === 'signed_out') return `${BRAND}${dot}signed out`;
  if (context?.status === 'error') return `${BRAND}${dot}not connected`;

  const parts = [];
  if (context?.status === 'ready')
    parts.push(`${context.memoryItemsLoaded} loaded`);
  if (search?.memories > 0) parts.push(`${search.memories} recalled`);
  if (capture?.status === 'saved') {
    parts.push(`saved ${formatAge(now - capture.updatedAt)} ago`);
  }
  return parts.length ? `${BRAND}${dot}${parts.join(dot)}` : BRAND;
}

function readInput() {
  return new Promise((resolve) => {
    let data = '';
    const done = () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    };
    if (process.stdin.isTTY) return resolve({});
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', done);
    setTimeout(done, INPUT_TIMEOUT_MS).unref();
  });
}

if (require.main === module) {
  readInput().then((input) => {
    process.stdout.write(
      `${render(input.conversation_id || input.session_id)}\n`,
    );
  });
}

module.exports = { render };
