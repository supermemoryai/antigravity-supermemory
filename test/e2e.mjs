// End-to-end: the real Antigravity CLI (`agy`) loads this plugin from an
// isolated HOME, talks to a scripted mock model, and the plugin talks to a mock
// Supermemory backend. Needs agy on PATH (or AGY=/path/to/agy).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { makeRepo, ROOT, startMockApi, tempDir } from './helpers.mjs';
import { modelTexts, startMockGemini, toolNames } from './mock-gemini.mjs';

const require = createRequire(import.meta.url);
const AGY =
  process.env.AGY ||
  [path.join(os.homedir(), '.local', 'bin', 'agy'), 'agy'].find(
    (candidate) => candidate === 'agy' || fs.existsSync(candidate),
  );

function agy(args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(AGY, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`agy timed out\n${stdout}\n${stderr}`));
    }, 120000);
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const events = stdout
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      resolve({ code, stdout, stderr, events });
    });
  });
}

async function waitFor(predicate, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

describe('agy end to end', { skip: !AGY && 'agy not installed' }, () => {
  let home;
  let workspace;
  let gemini;
  let api;
  let env;
  let namespace;
  let conversationId;
  const transcriptCount = (texts, marker) =>
    texts.filter((t) => t.includes(marker)).length;

  before(async () => {
    home = tempDir('sm-agy-e2e-home-');
    workspace = makeRepo('git@github.com:acme/agy-e2e.git');
    fs.writeFileSync(path.join(workspace, 'README.md'), '# agy e2e\n');
    gemini = await startMockGemini();
    api = await startMockApi();
    env = {
      PATH: process.env.PATH,
      HOME: home,
      GEMINI_API_KEY: 'mock-gemini-key',
      GOOGLE_GEMINI_BASE_URL: gemini.url,
      SUPERMEMORY_ANTIGRAVITY_API_KEY: 'sm_test_key',
      SUPERMEMORY_API_URL: api.url,
      SUPERMEMORY_MCP_URL: `${api.url}/mcp`,
      SUPERMEMORY_API_VERSION: 'v5',
    };
    process.env.HOME = home;
    namespace = require('../scripts/lib/container-tag.js').getNamespace(
      workspace,
    );
    const installed = execFileSync(AGY, ['plugin', 'install', ROOT], {
      env,
      encoding: 'utf8',
    });
    assert.match(installed, /Installed to/);
  });

  after(async () => {
    await gemini?.close();
    await api?.close();
  });

  test('the plugin loads every component', () => {
    const [plugin] = JSON.parse(
      execFileSync(AGY, ['plugin', 'list', '--json'], {
        env,
        encoding: 'utf8',
      }),
    );
    assert.equal(plugin.name, 'supermemory');
    assert.equal(plugin.enabled, true);
    assert.deepEqual(plugin.skills.sort(), [
      'supermemory-login',
      'supermemory-logout',
      'supermemory-status',
    ]);
    assert.deepEqual(plugin.agents, ['context-gatherer']);
    assert.deepEqual(plugin.mcpServers, ['supermemory']);
    assert.deepEqual(plugin.hooks, ['supermemory']);
  });

  test('first turn: profile + recall injected, MCP search auto-approved, turn saved', async () => {
    gemini.script.push(
      {
        functionCall: {
          name: 'mcp_supermemory_supermemory_search_memory',
          // agy requires a UI summary on every native tool call.
          args: {
            query: 'deploy process',
            toolSummary: 'Search memory for deploys',
          },
        },
      },
      {
        text: 'Deploys go through scripts/deploy.sh once CI is green; I will keep using that.',
      },
    );
    const run = await agy(
      [
        '--settings',
        '{"modelProvider":"gemini"}',
        '-p',
        'How do deploys work in this repo? Check memory first please.',
        '--output-format',
        'stream-json',
      ],
      env,
      workspace,
    );
    conversationId = run.events.find((e) => e.conversation_id)?.conversation_id;
    assert.ok(conversationId, run.stdout + run.stderr);

    const [first, second] = gemini.agentRequests();
    const firstTexts = modelTexts(first);
    assert.equal(transcriptCount(firstTexts, '<supermemory-context>'), 1);
    assert.ok(firstTexts.some((t) => t.includes('◪ Prefers pnpm')));
    assert.equal(transcriptCount(firstTexts, '<supermemory-recall>'), 1);
    assert.ok(
      firstTexts.some((t) =>
        t.includes('Deploys run through scripts/deploy.sh'),
      ),
    );
    // Notices are rendered for the user and never sent to the model.
    assert.ok(!firstTexts.some((t) => t.includes('memories loaded for')));

    // search_memory/add_memory are always-loaded native tools.
    const tools = toolNames(first);
    assert.ok(
      tools.includes('mcp_supermemory_supermemory_search_memory'),
      tools.join(','),
    );
    assert.ok(tools.includes('mcp_supermemory_supermemory_add_memory'));

    // The tool loop's second model call gets no second recall.
    assert.equal(
      transcriptCount(modelTexts(second), '<supermemory-recall>'),
      1,
    );

    const toolSteps = run.events.filter(
      (e) => e.step_update?.step_type === 'tool',
    );
    assert.equal(
      toolSteps.at(-1).step_update.state,
      'DONE',
      JSON.stringify(toolSteps),
    );
    const mcpCall = api.requests.find(
      (r) => r.url === '/mcp' && r.body?.method === 'tools/call',
    );
    assert.equal(mcpCall.body.params.name, 'search_memory');
    assert.deepEqual(mcpCall.body.params.arguments, {
      query: 'deploy process',
      namespace,
    });
    assert.equal(mcpCall.headers['x-sm-source'], 'antigravity');

    const notices = run.events.filter(
      (e) => e.step_update?.step_type === 'system_message',
    );
    assert.ok(notices.length >= 2, 'expected SessionStart and recall notices');

    const save = await waitFor(() =>
      api.requests.find((r) => r.url === `/ns/${namespace}/document`),
    );
    assert.ok(save, 'turn was not saved');
    assert.equal(save.body.id, conversationId);
    assert.match(
      save.body.content,
      /<\|start\|>user<\|message\|>How do deploys work in this repo\?/,
    );
    assert.match(
      save.body.content,
      /<\|start\|>assistant<\|message\|>Deploys go through scripts\/deploy.sh/,
    );
    assert.doesNotMatch(
      save.body.content,
      /supermemory-recall|supermemory-context|ADDITIONAL_METADATA/,
    );
    assert.equal(save.body.metadata.agent_surface, 'cli');
  });

  test('write tools defer to the permission policy instead of being denied', async () => {
    const before = api.requests.length;
    gemini.script.push(
      {
        functionCall: {
          name: 'mcp_supermemory_supermemory_add_memory',
          args: {
            content: 'agy-e2e uses pnpm and Node 22.',
            toolSummary: 'Save package manager note',
          },
        },
      },
      { text: 'Saved.' },
    );
    // With prompts disabled the policy allows the write; the hook must not
    // turn that into a denial.
    const run = await agy(
      [
        '--settings',
        '{"modelProvider":"gemini"}',
        '--dangerously-skip-permissions',
        '-p',
        'Save this to memory: agy-e2e uses pnpm and Node 22.',
        '--output-format',
        'stream-json',
      ],
      env,
      workspace,
    );
    const tool = run.events
      .filter((e) => e.step_update?.step_type === 'tool')
      .at(-1)?.step_update;
    assert.equal(tool?.state, 'DONE', JSON.stringify(tool));
    const write = api.requests
      .slice(before)
      .find((r) => r.body?.params?.name === 'add_memory');
    assert.deepEqual(write.body.params.arguments, {
      content: 'agy-e2e uses pnpm and Node 22.',
      namespace,
    });
    // Let this conversation's detached capture land before the next test.
    const writeId = run.events.find((e) => e.conversation_id)?.conversation_id;
    await waitFor(() =>
      api.requests.some(
        (r) => r.url.endsWith('/document') && r.body?.id === writeId,
      ),
    );
  });

  test('second turn: no repeated recall, only the new turn is saved', async () => {
    const before = api.requests.length;
    gemini.script.push({
      text: 'Rollbacks use scripts/rollback.sh with the previous tag.',
    });
    const run = await agy(
      [
        '--settings',
        '{"modelProvider":"gemini"}',
        '--conversation',
        conversationId,
        '-p',
        'And how do we roll back a bad prod deploy?',
        '--output-format',
        'stream-json',
      ],
      env,
      workspace,
    );
    assert.equal(
      run.events.find((e) => e.event === 'result')?.result?.status,
      'SUCCESS',
    );
    const texts = modelTexts(gemini.agentRequests().at(-1));
    // The persisted recall from turn 1 is still there; the repeat is not added.
    assert.equal(transcriptCount(texts, '<supermemory-recall>'), 1);
    // Resuming a conversation does not inject the profile a second time.
    assert.equal(transcriptCount(texts, '<supermemory-context>'), 1);

    const save = await waitFor(() =>
      api.requests
        .slice(before)
        .find((r) => r.url === `/ns/${namespace}/document`),
    );
    assert.ok(save, 'second turn was not saved');
    assert.equal(save.body.id, conversationId);
    assert.match(save.body.content, /roll back a bad prod deploy/);
    assert.doesNotMatch(save.body.content, /How do deploys work in this repo/);
  });

  test('context-gatherer subagent searches memory; its own conversation is never recalled or saved', async () => {
    const before = api.requests.length;
    gemini.route('You are the Supermemory context gatherer', [
      {
        functionCall: {
          name: 'call_mcp_tool',
          args: {
            ServerName: 'supermemory_supermemory',
            ToolName: 'search_memory',
            Arguments: { query: 'deploy history' },
          },
        },
      },
      { text: 'Brief: ◪ deploys go through scripts/deploy.sh after CI.' },
    ]);
    gemini.script.push(
      {
        functionCall: {
          name: 'invoke_subagent',
          args: {
            TypeName: 'context-gatherer',
            Role: 'Memory Researcher',
            Prompt: 'Gather background on deploys from Supermemory.',
          },
        },
      },
      // Print mode exits when the parent's turn ends and takes background
      // subagents with it, so the parent waits before replying.
      {
        functionCall: {
          name: 'run_command',
          args: {
            CommandLine: 'sleep 6',
            WaitMsBeforeAsync: 10000,
            toolSummary: 'Wait for the context gatherer',
          },
        },
      },
      { text: 'Per the brief, deploys run scripts/deploy.sh after CI passes.' },
      { text: 'Done.' },
    );
    const run = await agy(
      [
        '--settings',
        '{"modelProvider":"gemini"}',
        // Only so the headless parent may run its `sleep`.
        '--dangerously-skip-permissions',
        '-p',
        'Give me the deploy background before we start the release.',
        '--output-format',
        'stream-json',
      ],
      env,
      workspace,
    );
    const mainId = run.events.find((e) => e.conversation_id)?.conversation_id;
    assert.ok(mainId);
    assert.ok(
      gemini.requests.some(
        (r) =>
          r.isAgent &&
          r.system.includes('You are the Supermemory context gatherer'),
      ),
      `subagent never ran\n${run.events
        .filter((e) => e.step_update?.step_type === 'subagent')
        .map((e) => JSON.stringify(e).slice(0, 600))
        .join('\n')}`,
    );
    const subagentSearch = await waitFor(() =>
      api.requests
        .slice(before)
        .find(
          (r) =>
            r.body?.method === 'tools/call' &&
            r.body.params.arguments?.query === 'deploy history',
        ),
    );
    assert.ok(subagentSearch, 'subagent MCP search was not forwarded');
    assert.equal(subagentSearch.body.params.arguments.namespace, namespace);

    await waitFor(() =>
      api.requests.slice(before).some((r) => r.url.endsWith('/document')),
    );
    const since = api.requests.slice(before);
    // One SessionStart and one prompt recall: the subagent's own hooks skip.
    const trail = since
      .map(
        (r) =>
          `${r.url} ${JSON.stringify(r.body?.query ?? r.body?.params?.name ?? '')}`,
      )
      .join('\n');
    assert.equal(
      since.filter((r) => r.url.endsWith('/profile')).length,
      1,
      trail,
    );
    assert.equal(
      since.filter((r) => r.url.endsWith('/search')).length,
      1,
      trail,
    );
    const saves = since.filter((r) => r.url.endsWith('/document'));
    assert.ok(saves.length >= 1);
    assert.ok(
      saves.every((r) => r.body.id === mainId),
      JSON.stringify(saves.map((r) => r.body.id)),
    );
  });
});
