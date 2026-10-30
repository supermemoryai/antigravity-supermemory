import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

export function tempDir(prefix = 'sm-agy-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function makeRepo(remote = 'git@github.com:acme/widgets.git') {
  const dir = tempDir('sm-agy-repo-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (remote)
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  return dir;
}

/** Write an Antigravity transcript_full.jsonl from step objects. */
export function writeTranscript(dir, steps) {
  const file = path.join(dir, 'transcript_full.jsonl');
  fs.writeFileSync(
    file,
    `${steps.map((step, i) => JSON.stringify({ step_index: i, status: 'DONE', created_at: `2026-10-30T06:00:${String(i).padStart(2, '0')}Z`, ...step })).join('\n')}\n`,
  );
  return file;
}

export function userStep(text) {
  return {
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-30T12:00:00+05:30.\n</ADDITIONAL_METADATA>`,
  };
}

export function modelStep(text, toolCalls) {
  return {
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    content: text ?? null,
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
  };
}

/**
 * A fake Supermemory backend: v5 namespace routes, legacy routes, /session,
 * and a Streamable HTTP MCP endpoint. Every request is recorded.
 */
export async function startMockApi(options = {}) {
  const requests = [];
  const state = {
    profile: options.profile ?? {
      static: ['Prefers pnpm'],
      dynamic: ['Migrating auth to OAuth'],
    },
    search: options.search ?? [
      {
        id: 'm1',
        memory: 'Deploys run through scripts/deploy.sh after tests pass',
        similarity: 0.82,
      },
      { id: 'm2', memory: 'Low relevance memory', similarity: 0.2 },
    ],
    status: options.status ?? {},
    sseTools: options.sseTools ?? false,
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let json = null;
      try {
        json = body ? JSON.parse(body) : null;
      } catch {}
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: json,
      };
      requests.push(record);
      const forced = Object.entries(state.status).find(([route]) =>
        req.url.includes(route),
      );
      if (forced) {
        res
          .writeHead(forced[1], { 'content-type': 'application/json' })
          .end('{"error":"forced"}');
        return;
      }
      const send = (value, code = 200) =>
        res
          .writeHead(code, { 'content-type': 'application/json' })
          .end(JSON.stringify(value));

      if (/\/ns\/[^/]+\/profile$/.test(req.url) || req.url === '/v4/profile') {
        return send({
          profile: state.profile,
          ...(req.url === '/v4/profile' && json?.q
            ? {
                searchResults: {
                  results: state.search,
                  total: state.search.length,
                },
              }
            : {}),
        });
      }
      if (/\/ns\/[^/]+\/search$/.test(req.url)) {
        return send({
          results: state.search,
          total: state.search.length,
          searchTime: 12,
        });
      }
      if (
        /\/ns\/[^/]+\/document$/.test(req.url) ||
        req.url === '/v3/documents'
      ) {
        return send({ id: `doc_${requests.length}`, status: 'queued' });
      }
      if (req.url === '/session') {
        return send({
          user: { email: 'dev@example.com', name: 'Dev' },
          org: { name: 'Acme' },
        });
      }
      if (req.url === '/mcp') {
        const reply = (result) => {
          const payload = { jsonrpc: '2.0', id: json.id, result };
          if (state.sseTools && json.method === 'tools/list') {
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'mcp-session-id': 'sess-1',
            });
            res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
            res.end();
            return;
          }
          res.writeHead(200, {
            'content-type': 'application/json',
            'mcp-session-id': 'sess-1',
          });
          res.end(JSON.stringify(payload));
        };
        if (json?.id === undefined) return res.writeHead(202).end();
        if (json.method === 'initialize') {
          return reply({
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'mock', version: '1' },
          });
        }
        if (json.method === 'tools/list') {
          return reply({
            tools: [
              { name: 'search_memory', inputSchema: { type: 'object' } },
              { name: 'add_memory', inputSchema: { type: 'object' } },
              { name: 'who_am_i', inputSchema: { type: 'object' } },
            ],
          });
        }
        if (json.method === 'tools/call') {
          return reply({
            content: [
              {
                type: 'text',
                text: `called ${json.params.name} ${JSON.stringify(json.params.arguments)}`,
              },
            ],
          });
        }
        return reply({});
      }
      send({ error: 'not found' }, 404);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Run a plugin script with a JSON payload on stdin; resolves with stdout. */
export function runScript(
  script,
  payload,
  env = {},
  { timeoutMs = 20000 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'scripts', script)],
      {
        cwd: ROOT,
        env: { PATH: process.env.PATH, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${script} timed out\n${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = stdout.trim() ? JSON.parse(stdout.trim()) : null;
      } catch {}
      resolve({ code, stdout, stderr, json });
    });
    child.stdin.end(payload === undefined ? '' : JSON.stringify(payload));
  });
}

export function hookEnv(home, api, extra = {}) {
  return {
    HOME: home,
    USERPROFILE: home,
    SUPERMEMORY_ANTIGRAVITY_API_KEY: 'sm_test_key',
    SUPERMEMORY_API_URL: api.url,
    SUPERMEMORY_MCP_URL: `${api.url}/mcp`,
    SUPERMEMORY_API_VERSION: 'v5',
    ...extra,
  };
}

export function noticeText(output) {
  return (output?.injectSteps || [])
    .filter(
      (step) => step.systemMessage && step.systemMessage.systemMessage === '',
    )
    .map((step) => step.systemMessage.renderInfo?.markdown)
    .join('\n');
}

export function contextText(output) {
  return (output?.injectSteps || [])
    .filter((step) => step.systemMessage?.systemMessage)
    .map((step) => step.systemMessage.systemMessage)
    .join('\n');
}
