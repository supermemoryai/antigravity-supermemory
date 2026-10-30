const fs = require('node:fs');
const path = require('node:path');

const MARK = '◪';

// Hooks run with the plugin directory as cwd, never the user's project, so the
// workspace always comes from the payload. With several roots, the first one
// that exists is the primary workspace.
function getWorkspace(input) {
  const paths = Array.isArray(input?.workspacePaths)
    ? input.workspacePaths
    : [];
  for (const candidate of paths) {
    if (typeof candidate !== 'string' || !candidate) continue;
    const resolved = candidate.startsWith('file://')
      ? decodeURIComponent(new URL(candidate).pathname)
      : candidate;
    try {
      if (fs.statSync(resolved).isDirectory()) return path.resolve(resolved);
    } catch {}
  }
  return null;
}

// Whether the conversation has a message the user typed. Reads only the head
// of the transcript: a user's conversation opens with their request.
function hasUserInput(transcriptPath) {
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const head = buffer.toString(
      'utf8',
      0,
      fs.readSync(fd, buffer, 0, buffer.length, 0),
    );
    return head
      .split('\n')
      .some(
        (line) =>
          line.includes('"USER_INPUT"') && line.includes('"USER_EXPLICIT"'),
      );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Subagents share the parent's workspace and report back to it; only the
// user's own conversation recalls and captures. agy 1.4 does not fill in
// parentConversationId yet, but a subagent's task arrives as a system
// message, so it has no user input of its own.
function isSubagent(input) {
  if (
    typeof input?.parentConversationId === 'string' &&
    input.parentConversationId.trim()
  )
    return true;
  return (
    typeof input?.lastUserInput === 'string' &&
    !input.lastUserInput.trim() &&
    !hasUserInput(input.transcriptPath)
  );
}

// A system message persists in the conversation, so the model keeps seeing it
// on later turns (like Claude Code's additionalContext).
function contextStep(text) {
  return { systemMessage: { systemMessage: text } };
}

// renderInfo with empty text is shown to the user and never sent to the model:
// Antigravity's equivalent of Claude Code's systemMessage notices.
function noticeStep(markdown) {
  return {
    systemMessage: {
      systemMessage: '',
      renderInfo: { title: `${MARK} supermemory`, markdown },
    },
  };
}

function injectOutput(steps) {
  const injectSteps = steps.filter(Boolean);
  return injectSteps.length ? { injectSteps } : {};
}

module.exports = {
  MARK,
  contextStep,
  getWorkspace,
  injectOutput,
  isSubagent,
  noticeStep,
};
