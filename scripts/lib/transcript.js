const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TRACKER_DIR } = require('./paths');
const { atomicWriteJson } = require('./session-state');
const {
  getIncludeTools,
  getSignalConfig,
  shouldIncludeTool,
} = require('./settings');
const { stripPrivate } = require('./redact');

// Antigravity writes one JSON object per trajectory step to
// <app_data_dir>/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl:
//   USER_INPUT (source USER_EXPLICIT)  the user's turn, wrapped in <USER_REQUEST>
//   PLANNER_RESPONSE (source MODEL)    model text and/or tool_calls
//   GENERIC, RUN_COMMAND, ...          tool results, in tool_calls order
//   SYSTEM_MESSAGE, EPHEMERAL_MESSAGE  hook-injected context (never captured)
const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
const MAX_TOOL_RESULT_LENGTH = 500;
const MIN_CAPTURE_LENGTH = 100;
const SKIPPED_TYPES = new Set([
  'SYSTEM_MESSAGE',
  'EPHEMERAL_MESSAGE',
  'CHECKPOINT',
  'ERROR_MESSAGE',
]);
const INCOMPLETE_STATUS = /PENDING|RUNNING|ACTIVE|GENERATING|CANCEL/i;

function cleanContent(text) {
  if (!text || typeof text !== 'string') return '';
  return stripPrivate(
    text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<supermemory-context>[\s\S]*?<\/supermemory-context>/g, '')
      .replace(/<supermemory-recall>[\s\S]*?<\/supermemory-recall>/g, '')
      .replace(/<supermemory-status>[\s\S]*?<\/supermemory-status>/g, ''),
  ).trim();
}

// The CLI appends local time and settings-change notices to the user's text.
function extractUserRequest(content) {
  if (typeof content !== 'string') return '';
  const request = content.match(
    /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/,
  );
  if (request) return request[1];
  return content
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '');
}

// Tool results start with "Created At: …\nCompleted At: …" bookkeeping.
function toolResultText(step) {
  const content =
    typeof step.content === 'string' ? step.content : step.error || '';
  return content
    .replace(/^Created At:[^\n]*\n?/, '')
    .replace(/^Completed At:[^\n]*\n?/, '')
    .trim();
}

function toolNames(call) {
  const names = [call?.name];
  const args = call?.args || {};
  if (call?.name === 'call_mcp_tool' && args.ToolName) {
    const server = String(args.ServerName || '').replace(/^"|"$/g, '');
    const tool = String(args.ToolName).replace(/^"|"$/g, '');
    names.push(tool, server ? `${server}/${tool}` : tool);
  }
  return names.filter(Boolean);
}

function displayToolName(call) {
  const names = toolNames(call);
  return names[names.length - 1] || 'unknown';
}

function readSteps(transcriptPath) {
  const stat = fs.statSync(transcriptPath);
  if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) {
    throw new Error('Transcript must be a regular file under 20 MiB');
  }
  const steps = [];
  for (const line of fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const step = JSON.parse(line);
      if (step && typeof step === 'object' && Number.isInteger(step.step_index))
        steps.push(step);
    } catch {
      // A partially written final line; the next capture reads it whole.
    }
  }
  return steps.sort((a, b) => a.step_index - b.step_index);
}

/**
 * Turn raw steps into user / assistant / tool entries. Tool results are paired
 * with the tool call that produced them.
 */
function parseTranscript(transcriptPath) {
  const entries = [];
  let pendingCalls = [];
  for (const step of readSteps(transcriptPath)) {
    const type = String(step.type || '').replace(/^CORTEX_STEP_TYPE_/, '');
    const source = String(step.source || '').replace(
      /^CORTEX_STEP_SOURCE_/,
      '',
    );
    if (SKIPPED_TYPES.has(type)) continue;
    if (step.status && INCOMPLETE_STATUS.test(String(step.status))) continue;
    const base = {
      stepIndex: step.step_index,
      createdAt: step.created_at || null,
    };

    if (type === 'USER_INPUT') {
      pendingCalls = [];
      // Hook-injected user messages are not the user's words.
      if (source && source !== 'USER_EXPLICIT') continue;
      const text = cleanContent(extractUserRequest(step.content));
      if (text) entries.push({ ...base, role: 'user', text });
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      const text = cleanContent(
        typeof step.content === 'string' ? step.content : '',
      );
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      pendingCalls = [...calls];
      entries.push({ ...base, role: 'assistant', text, toolCalls: calls });
      continue;
    }

    if (source === 'MODEL' || pendingCalls.length > 0) {
      const call = pendingCalls.shift() || null;
      entries.push({
        ...base,
        role: 'tool',
        call,
        ok: !/ERROR/i.test(String(step.status || '')) && !step.error,
        text: cleanContent(toolResultText(step)),
      });
    }
  }
  return entries;
}

function trackerFile(conversationId) {
  const key = crypto.createHash('sha256').update(conversationId).digest('hex');
  return path.join(TRACKER_DIR, `${key}.json`);
}

function getCursor(conversationId) {
  try {
    const cursor = JSON.parse(
      fs.readFileSync(trackerFile(conversationId), 'utf8'),
    );
    return Number.isInteger(cursor?.lastStepIndex) ? cursor : null;
  } catch {
    return null;
  }
}

function setCursor(conversationId, cursor) {
  atomicWriteJson(trackerFile(conversationId), {
    lastStepIndex: cursor.lastStepIndex,
    lastCreatedAt: cursor.lastCreatedAt || null,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Entries after the cursor, ending at the last assistant reply: a trailing user
 * message whose reply has not landed yet waits for the next capture.
 */
function getNewEntries(entries, cursor) {
  let fresh = entries;
  if (cursor) {
    const maxIndex = entries.length
      ? entries[entries.length - 1].stepIndex
      : -1;
    fresh =
      maxIndex >= cursor.lastStepIndex
        ? entries.filter((e) => e.stepIndex > cursor.lastStepIndex)
        : // The log was rewritten (compaction); fall back to timestamps.
          entries.filter(
            (e) =>
              cursor.lastCreatedAt &&
              e.createdAt &&
              e.createdAt > cursor.lastCreatedAt,
          );
  }
  let end = -1;
  for (let i = fresh.length - 1; i >= 0; i--) {
    if (fresh[i].role === 'assistant' && fresh[i].text) {
      end = i;
      break;
    }
  }
  // Tool results that belong to the final reply's calls stay with it.
  while (end >= 0 && end + 1 < fresh.length && fresh[end + 1].role === 'tool') {
    end++;
  }
  return end >= 0 ? fresh.slice(0, end + 1) : [];
}

function truncate(text, maxLength) {
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function formatToolInputCompact(input) {
  const parts = [];
  for (const [key, value] of Object.entries(input || {})) {
    const valueStr = truncate(
      typeof value === 'string' ? value : JSON.stringify(value),
      100,
    );
    parts.push(`${key}="${valueStr}"`);
  }
  return parts.join(' ');
}

function formatEntry(entry, includeList, textOnly) {
  if (entry.role === 'user') {
    return `<|start|>user<|message|>${entry.text}<|end|>`;
  }
  if (entry.role === 'assistant') {
    const parts = [];
    if (entry.text) {
      parts.push(`<|start|>assistant<|message|>${entry.text}<|end|>`);
    }
    if (!textOnly) {
      for (const call of entry.toolCalls || []) {
        if (!shouldIncludeTool(toolNames(call), includeList)) continue;
        const args =
          call.name === 'call_mcp_tool' ? call.args?.Arguments : call.args;
        parts.push(
          `<|start|>assistant:tool<|message|>${displayToolName(call)}: ${formatToolInputCompact(
            typeof args === 'string' ? { input: args } : args,
          )}<|end|>`,
        );
      }
    }
    return parts.length ? parts.join('\n') : null;
  }
  if (entry.role === 'tool' && !textOnly && entry.call && entry.text) {
    if (!shouldIncludeTool(toolNames(entry.call), includeList)) return null;
    return `<|start|>assistant:tool_result<|message|>${displayToolName(entry.call)}(${
      entry.ok ? 'success' : 'error'
    }): ${truncate(entry.text, MAX_TOOL_RESULT_LENGTH)}<|end|>`;
  }
  return null;
}

function groupIntoTurns(entries) {
  const turns = [];
  let current = null;
  for (const entry of entries) {
    if (entry.role === 'user' || !current) {
      current = { user: [], rest: [], all: [] };
      turns.push(current);
    }
    (entry.role === 'user' ? current.user : current.rest).push(entry);
    current.all.push(entry);
  }
  return turns;
}

function filterSignalTurns(entries, { keywords, turnsBefore }) {
  const turns = groupIntoTurns(entries);
  const include = new Set();
  turns.forEach((turn, index) => {
    const text = turn.all
      .map((e) => e.text || '')
      .join(' ')
      .toLowerCase();
    if (keywords.some((keyword) => text.includes(keyword))) {
      for (let i = Math.max(0, index - turnsBefore); i <= index; i++) {
        include.add(i);
      }
    }
  });
  return [...include].sort((a, b) => a - b).flatMap((i) => turns[i].all);
}

/**
 * Format everything not yet captured for this conversation. Returns null when
 * there is nothing worth saving; otherwise the formatted turn block and the
 * cursor to commit once the upload is acknowledged.
 */
function formatNewEntries(transcriptPath, conversationId, cwd) {
  const entries = parseTranscript(transcriptPath);
  const fresh = getNewEntries(entries, getCursor(conversationId));
  if (fresh.length === 0) return null;
  const last = fresh[fresh.length - 1];
  const cursor = {
    lastStepIndex: last.stepIndex,
    lastCreatedAt: last.createdAt,
  };

  const signal = getSignalConfig(cwd);
  const selected = signal.enabled ? filterSignalTurns(fresh, signal) : fresh;
  const includeList = getIncludeTools(cwd);
  const parts = [
    `<|turn_start|>${fresh[0].createdAt || new Date().toISOString()}`,
  ];
  for (const entry of selected) {
    const formatted = formatEntry(entry, includeList, signal.enabled);
    if (formatted) parts.push(formatted);
  }
  parts.push('<|turn_end|>');
  const formatted = parts.join('\n\n');

  return {
    // Short exchanges wait (cursor not advanced) and ride along with the next
    // turn, matching the Claude Code plugin's 100-character floor.
    formatted: formatted.length < MIN_CAPTURE_LENGTH ? null : formatted,
    cursor,
    // With signal extraction on, turns without a signal are skipped for good.
    skipped: signal.enabled && selected.length === 0,
    turns: groupIntoTurns(selected).length,
  };
}

module.exports = {
  cleanContent,
  extractUserRequest,
  formatNewEntries,
  getCursor,
  getNewEntries,
  parseTranscript,
  setCursor,
};
