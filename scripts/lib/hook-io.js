const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { readSessionJson, writeSessionJson } = require('./session-state');

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

const PRINT_FLAGS = new Set(['-p', '--print', '--prompt']);
const INTERACTIVE_FLAGS = new Set(['-i', '--prompt-interactive']);
const VALUE_FLAGS = new Set([
  '--add-dir',
  '--agent',
  '--conversation',
  '--effort',
  '--input-format',
  '--json-schema',
  '--log-file',
  '--mode',
  '--model',
  '--output-format',
  '--print-timeout',
  '--project',
  '--settings',
]);
const ORCHESTRATOR_ENV = [
  'CONDUCTOR_WORKSPACE_PATH',
  'CONDUCTOR_SESSION_ID',
  'VK_WORKSPACE_ID',
];
const HEADLESS_FILE = 'headless.json';

function processInfo(pid) {
  if (process.platform === 'linux') {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return {
      ppid: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]),
      argv: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'),
    };
  }
  const [ppid, ...argv] = execFileSync(
    'ps',
    ['-o', 'ppid=,args=', '-p', String(pid)],
    {
      encoding: 'utf8',
      timeout: 1000,
    },
  )
    .trim()
    .split(/\s+/);
  return { ppid: Number(ppid), argv };
}

// Only option tokens before the first positional count, so prompt text (split on spaces by macOS ps) is never read as a flag.
function isPrintArgv(args) {
  let print = false;
  for (let i = 0; i < args.length; i++) {
    const separator = args[i].indexOf('=');
    const name = separator < 0 ? args[i] : args[i].slice(0, separator);
    if (!name.startsWith('-') || name === '--') break;
    if (INTERACTIVE_FLAGS.has(name)) return false;
    if (PRINT_FLAGS.has(name))
      print = separator < 0 || args[i].slice(separator + 1) !== 'false';
    if (VALUE_FLAGS.has(name) && separator < 0) i++;
  }
  return print;
}

// The nearest `agy` ancestor, null when there is none, undefined when the process table can't be read.
function findAgy() {
  try {
    let pid = process.ppid;
    for (let depth = 0; depth < 4 && pid > 1; depth++) {
      const { ppid, argv } = processInfo(pid);
      if (/^agy(\.exe)?$/.test(path.basename(argv[0] || ''))) {
        return { pid, argv };
      }
      pid = ppid;
    }
    return null;
  } catch {
    return undefined;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// agy runs hooks through a shell and puts no print-mode flag in the payload, so read `agy -p` off the CLI's own argv, once per agy process and conversation.
function isHeadless(conversationId) {
  if (process.platform === 'win32') return false;
  if (ORCHESTRATOR_ENV.some((name) => process.env[name])) return false;
  const cached = readSessionJson(conversationId, HEADLESS_FILE);
  if (
    typeof cached?.headless === 'boolean' &&
    (cached.pid === null || isAlive(cached.pid))
  )
    return cached.headless;
  const agy = findAgy();
  if (agy === undefined) return false;
  const headless = Boolean(agy && isPrintArgv(agy.argv.slice(1)));
  writeSessionJson(conversationId, HEADLESS_FILE, {
    pid: agy ? agy.pid : null,
    headless,
  });
  return headless;
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
  isHeadless,
  isPrintArgv,
  isSubagent,
  noticeStep,
};
