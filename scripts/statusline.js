#!/usr/bin/env node
// Antigravity CLI status line. The CLI pipes its session state (JSON) to this
// script whenever the agent state changes and shows whatever it prints. Hooks
// write per-conversation state under ~/.supermemory-antigravity; this script
// only reads it, so it stays fast (the CLI kills runs over 5 seconds).
//
// The CLI never redraws the line on a timer, so whatever it prints stays up
// until the next prompt or tool call. A save finishes after the turn's last
// redraw, so "saving…" or "saved 5s ago" would sit there long after it stopped
// being true. The line shows settled counts instead, which are right whenever
// they are drawn; a turn's save shows up from the next redraw.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { STATE_ROOT } = require('./lib/paths');

const SCHEMA_VERSION = 1;
const INPUT_TIMEOUT_MS = 500;

const color = !process.env.NO_COLOR;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
// Mid-luminance tint of the brand blue (#3B35F3): terminals can't report
// their theme, so the glyph must clear both dark and light backgrounds.
const BRAND = `${paint('1;38;2;124;120;250', '◪')} ${paint('1', 'supermemory')}`;
const dot = paint('38;5;245', ' · ');

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

function render(conversationId) {
  const context = readEvent(conversationId, 'context');
  const search = readEvent(conversationId, 'search');
  const capture = readEvent(conversationId, 'capture');

  if (context?.status === 'signed_out') return `${BRAND}${dot}signed out`;
  if (context?.status === 'error') return `${BRAND}${dot}not connected`;
  // Stays until a later save in this conversation goes through.
  if (capture?.status === 'error') {
    return `${BRAND}${dot}${paint('31', 'last save failed')}`;
  }

  // Zero counts are left out: a new project has nothing to load yet, and
  // fresh saves take a few minutes to become searchable.
  const parts = [];
  if (context?.memoryItemsLoaded > 0)
    parts.push(`${context.memoryItemsLoaded} loaded`);
  if (search?.memories > 0) parts.push(`${search.memories} recalled`);
  if (capture?.count > 0) parts.push(`${capture.count} saved`);
  if (parts.length) return `${BRAND}${dot}${parts.join(dot)}`;
  return context?.status === 'ready' ? `${BRAND}${dot}ready` : BRAND;
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

function main() {
  return readInput().then((input) => {
    process.stdout.write(
      `${render(input.conversation_id || input.session_id)}\n`,
    );
  });
}

// The CLI runs this through the launcher under ~/.supermemory-antigravity.
if (require.main === module) main();

module.exports = { main, render };
