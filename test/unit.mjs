import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  contextText,
  hookEnv,
  makeRepo,
  modelStep,
  noticeText,
  ROOT,
  runScript,
  startMockApi,
  tempDir,
  userStep,
  writeTranscript,
} from './helpers.mjs';

// Library modules resolve ~/.supermemory-antigravity at load time.
const HOME = tempDir('sm-agy-home-');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const require = createRequire(import.meta.url);
const transcript = require('../scripts/lib/transcript.js');
const tools = require('../scripts/lib/tools.js');
const containerTag = require('../scripts/lib/container-tag.js');
const { redactSecrets, stripPrivate } = require('../scripts/lib/redact.js');
const { render } = require('../scripts/statusline.js');
const sessionState = require('../scripts/lib/session-state.js');

function sha16(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

describe('plugin manifests', () => {
  test('plugin.json carries the Marketplace fields', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'),
    );
    assert.match(manifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    for (const field of [
      'displayName',
      'description',
      'version',
      'logo',
      'author',
    ]) {
      assert.ok(manifest[field], `missing ${field}`);
    }
    assert.ok(fs.existsSync(path.join(ROOT, manifest.logo)));
    assert.ok(manifest.suggestedPrompts.length <= 3);
    assert.doesNotMatch(
      manifest.displayName,
      /^(Antigravity|Gemini|Claude|Cursor)/,
    );
  });

  test('every hook command points at a bundled script', () => {
    const hooks = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'hooks.json'), 'utf8'),
    );
    const commands = Object.values(hooks.supermemory)
      .flat()
      .flatMap((entry) => (entry.hooks ? entry.hooks : [entry]))
      .map((handler) => handler.command);
    assert.deepEqual(Object.keys(hooks.supermemory).sort(), [
      'PreInvocation',
      'PreToolUse',
      'SessionStart',
      'Stop',
    ]);
    for (const command of commands) {
      const script = command.match(/node \.\/(\S+)/)[1];
      assert.ok(fs.existsSync(path.join(ROOT, script)), script);
      // IDE extensions exec hook commands without a shell.
      assert.doesNotMatch(command, /[|&;$`]/);
    }
  });

  test('the MCP server runs the bundled proxy', () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'mcp_config.json'), 'utf8'),
    );
    const server = config.mcpServers.supermemory;
    assert.equal(server.command, 'node');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: agy expands this placeholder
    assert.equal(server.args[0], '${PLUGIN_ROOT}/scripts/mcp-proxy.js');
  });

  test('skill folders match their names and bundle their scripts', () => {
    for (const dir of fs.readdirSync(path.join(ROOT, 'skills'))) {
      const skill = fs.readFileSync(
        path.join(ROOT, 'skills', dir, 'SKILL.md'),
        'utf8',
      );
      assert.equal(skill.match(/^name: (.+)$/m)[1], dir);
      for (const match of skill.matchAll(/scripts\/([a-z-]+\.js)/g)) {
        const file = path.join(ROOT, 'skills', dir, 'scripts', match[1]);
        assert.ok(fs.existsSync(file), file);
        assert.ok(fs.statSync(file).mode & 0o100, `${file} is not executable`);
      }
    }
  });
});

describe('transcript', () => {
  const steps = [
    userStep('How do deploys work in this repo? Keep it short please.'),
    {
      source: 'SYSTEM_SDK',
      type: 'EPHEMERAL_MESSAGE',
      content: 'injected recall',
    },
    {
      source: 'SYSTEM_SDK',
      type: 'SYSTEM_MESSAGE',
      content: '<supermemory-context>facts</supermemory-context>',
    },
    modelStep(null, [
      {
        name: 'call_mcp_tool',
        args: {
          ServerName: 'supermemory_supermemory',
          ToolName: 'search_memory',
          Arguments: { query: 'deploy' },
        },
      },
    ]),
    {
      source: 'MODEL',
      type: 'GENERIC',
      content: 'Created At: x\nCompleted At: y\nDeploys use scripts/deploy.sh',
    },
    modelStep(
      'Deploys run scripts/deploy.sh once CI passes. <private>internal-host</private>',
    ),
  ];

  test('extracts only the user request and the model text', () => {
    const file = writeTranscript(tempDir(), steps);
    const entries = transcript.parseTranscript(file);
    assert.deepEqual(
      entries.map((e) => e.role),
      ['user', 'assistant', 'tool', 'assistant'],
    );
    assert.equal(
      entries[0].text,
      'How do deploys work in this repo? Keep it short please.',
    );
    assert.equal(entries[2].call.args.ToolName, 'search_memory');
    assert.equal(entries[2].text, 'Deploys use scripts/deploy.sh');
    assert.equal(
      entries[3].text,
      'Deploys run scripts/deploy.sh once CI passes. [REDACTED]',
    );
  });

  test('holds back a trailing prompt whose reply has not landed', () => {
    const file = writeTranscript(tempDir(), [
      ...steps,
      userStep('And how do I roll back?'),
    ]);
    const fresh = transcript.getNewEntries(
      transcript.parseTranscript(file),
      null,
    );
    assert.equal(fresh[fresh.length - 1].role, 'assistant');
    const resumed = transcript.getNewEntries(transcript.parseTranscript(file), {
      lastStepIndex: 5,
    });
    assert.deepEqual(resumed, []);
  });

  test('formats turns like the Claude Code plugin and skips tools by default', () => {
    const file = writeTranscript(tempDir(), steps);
    const delta = transcript.formatNewEntries(file, 'conv-format', makeRepo());
    assert.match(delta.formatted, /^<\|turn_start\|>2026-10-30T06:00:00Z/);
    assert.match(
      delta.formatted,
      /<\|start\|>user<\|message\|>How do deploys work/,
    );
    assert.match(
      delta.formatted,
      /<\|start\|>assistant<\|message\|>Deploys run/,
    );
    assert.doesNotMatch(
      delta.formatted,
      /tool_result|injected recall|supermemory-context/,
    );
    assert.match(delta.formatted, /<\|turn_end\|>$/);
    assert.deepEqual(delta.cursor, {
      lastStepIndex: 5,
      lastCreatedAt: '2026-10-30T06:00:05Z',
    });
  });

  test('includes tool calls and results listed in includeTools', () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, '.agents', '.supermemory'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repo, '.agents', '.supermemory', 'config.json'),
      JSON.stringify({ includeTools: ['search_memory'] }),
    );
    const file = writeTranscript(tempDir(), steps);
    const delta = transcript.formatNewEntries(file, 'conv-tools', repo);
    assert.match(
      delta.formatted,
      /assistant:tool<\|message\|>supermemory_supermemory\/search_memory: query="deploy"/,
    );
    assert.match(
      delta.formatted,
      /tool_result<\|message\|>supermemory_supermemory\/search_memory\(success\): Deploys use/,
    );
  });

  test('saves nothing until the first reply lands', () => {
    const file = writeTranscript(tempDir(), [
      userStep('Kick off the migration please'),
    ]);
    assert.equal(
      transcript.formatNewEntries(file, 'conv-noreply', makeRepo()),
      null,
    );
  });

  test('falls back to timestamps when compaction rewrote step indices', () => {
    const file = writeTranscript(tempDir(), steps);
    const entries = transcript.parseTranscript(file);
    const fresh = transcript.getNewEntries(entries, {
      lastStepIndex: 99,
      lastCreatedAt: '2026-10-30T06:00:03Z',
    });
    assert.deepEqual(
      fresh.map((e) => e.stepIndex),
      [4, 5],
    );
  });
});

describe('tool resolution', () => {
  test('recognizes lazy call_mcp_tool calls to the Supermemory server', () => {
    assert.deepEqual(
      tools.resolveSupermemoryTool({
        name: 'call_mcp_tool',
        args: {
          ServerName: 'supermemory_supermemory',
          ToolName: 'search_memory',
          Arguments: '{"query":"x"}',
        },
      }),
      { tool: 'search_memory', args: { query: 'x' } },
    );
    assert.equal(
      tools.resolveSupermemoryTool({
        name: 'call_mcp_tool',
        args: { ServerName: 'github', ToolName: 'search_code' },
      }),
      null,
    );
  });

  test('recognizes always-loaded native tool names', () => {
    assert.equal(
      tools.resolveSupermemoryTool({
        name: 'mcp_supermemory_supermemory_search_memory',
        args: {},
      }).tool,
      'search_memory',
    );
    assert.equal(
      tools.resolveSupermemoryTool({ name: 'run_command', args: {} }),
      null,
    );
  });
});

describe('namespace', () => {
  test('matches the shared repo_<name>__<hash> convention', () => {
    const repo = makeRepo('git@github.com:Acme/Widgets.git');
    assert.equal(
      containerTag.getNamespace(repo),
      `repo_widgets__${sha16('github.com/acme/widgets')}`,
    );
    // HTTPS and SSH remotes of the same repository share one space.
    const https = makeRepo('https://github.com/acme/widgets.git');
    assert.equal(
      containerTag.getNamespace(https),
      containerTag.getNamespace(repo),
    );
  });

  test('is identical to the Claude Code plugin for the same checkout', (t) => {
    const claude = process.env.CLAUDE_PLUGIN_CONTAINER_TAG;
    if (!claude || !fs.existsSync(claude)) {
      t.skip(
        'set CLAUDE_PLUGIN_CONTAINER_TAG to claude-supermemory/plugin/hooks/lib/container-tag.js',
      );
      return;
    }
    const repo = makeRepo('https://gitlab.com/team/sub/project.git');
    const claudeTags = require(claude);
    const claudeNamespace = (
      claudeTags.getNamespace ?? claudeTags.getContainerTag
    )(repo);
    assert.equal(containerTag.getNamespace(repo), claudeNamespace);
  });

  test('honors a namespace pinned for the Claude Code plugin', () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, '.claude', '.supermemory-claude'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repo, '.claude', '.supermemory-claude', 'config.json'),
      JSON.stringify({ repoContainerTag: 'team_shared' }),
    );
    assert.equal(containerTag.getNamespace(repo), 'team_shared');
  });
});

describe('redaction', () => {
  test('removes credentials and private regions', () => {
    const text = redactSecrets(
      'export SUPERMEMORY_API_KEY=sm_abcdefghijklmnopqrstuvwx and Bearer abcdefghijklmnopqrstu',
    );
    assert.doesNotMatch(text, /sm_abcdefgh|abcdefghijklmnopqrstu/);
    assert.equal(
      stripPrivate('a <private>b</private> c <private>tail'),
      'a [REDACTED] c [REDACTED]',
    );
  });
});

describe('status line', () => {
  test('summarizes loaded, recalled and saved state', () => {
    sessionState.writeState('conv-status', 'context', {
      status: 'ready',
      memoryItemsLoaded: 4,
    });
    sessionState.writeState('conv-status', 'search', {
      results: 2,
      count: 1,
      memories: 2,
    });
    sessionState.writeState('conv-status', 'capture', {
      status: 'saved',
      count: 1,
    });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colors
    const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const line = plain(render('conv-status'));
    assert.match(
      line,
      /^◪ supermemory · 4 loaded · 2 recalled · saved \d+s ago$/,
    );
    sessionState.writeState('conv-status', 'capture', {
      status: 'saving',
      count: 1,
    });
    assert.match(plain(render('conv-status')), /saving conversation/);
    assert.equal(plain(render('conv-unknown')), '◪ supermemory');
  });
});

describe('hooks', () => {
  let api;
  let home;
  let repo;
  let env;
  before(async () => {
    api = await startMockApi();
  });
  after(() => api.close());

  function setup(extra = {}) {
    home = tempDir('sm-agy-hookhome-');
    repo = makeRepo();
    env = hookEnv(home, api, extra);
    api.requests.length = 0;
  }

  const common = () => ({
    conversationId: `conv-${crypto.randomUUID()}`,
    workspacePaths: [repo],
    transcriptPath: path.join(repo, 'missing.jsonl'),
    modelName: 'gemini-3.1-pro-low',
    lastUserInput: 'How do we deploy this service to staging safely?',
  });

  test('SessionStart injects the profile and a user-only notice', async () => {
    setup();
    const { json } = await runScript('session-start.js', common(), env);
    const context = contextText(json);
    assert.match(context, /<supermemory-context>/);
    assert.match(context, /- ◪ Prefers pnpm/);
    assert.match(context, /- ◪ Migrating auth to OAuth/);
    assert.match(context, new RegExp(containerTag.getNamespace(repo)));
    assert.match(noticeText(json), /2 memories loaded for \*\*widgets\*\*/);
    assert.ok(
      api.requests.some(
        (r) => r.url === `/ns/${containerTag.getNamespace(repo)}/profile`,
      ),
    );
    assert.equal(api.requests[0].headers['x-sm-source'], 'antigravity');
  });

  test('SessionStart stays silent for subagents and workspace-less sessions', async () => {
    setup();
    const sub = await runScript(
      'session-start.js',
      { ...common(), parentConversationId: 'parent' },
      env,
    );
    assert.deepEqual(sub.json, {});
    // agy 1.4 leaves parentConversationId unset; a subagent's task arrives as
    // a system message, so there is no user input.
    const unlabeled = await runScript(
      'session-start.js',
      {
        ...common(),
        lastUserInput: '',
        transcriptPath: writeTranscript(tempDir(), [
          {
            source: 'SYSTEM',
            type: 'SYSTEM_MESSAGE',
            content: '[Message] gather deploy background',
          },
        ]),
      },
      env,
    );
    assert.deepEqual(unlabeled.json, {});
    const none = await runScript(
      'session-start.js',
      { ...common(), workspacePaths: [] },
      env,
    );
    assert.deepEqual(none.json, {});
    assert.equal(api.requests.length, 0);
  });

  test('SessionStart respects an explicit logout', async () => {
    setup({ SUPERMEMORY_ANTIGRAVITY_API_KEY: '' });
    fs.mkdirSync(path.join(home, '.supermemory-antigravity'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(home, '.supermemory-antigravity', 'logged-out.json'),
      '{}',
    );
    const { json } = await runScript('session-start.js', common(), env);
    assert.match(noticeText(json), /Signed out/);
    assert.equal(contextText(json), '');
  });

  test('SessionStart reports a failed sign-in without hanging', async () => {
    // Discovery 404s on the mock, so the background login fails fast.
    setup({ SUPERMEMORY_ANTIGRAVITY_API_KEY: '' });
    const started = Date.now();
    const { json } = await runScript('session-start.js', common(), env);
    assert.ok(Date.now() - started < 15000);
    assert.match(
      noticeText(json),
      /Sign-in did not complete|Finish connecting/,
    );
    assert.match(contextText(json), /not connected yet/);
  });

  test('PreInvocation recalls once per turn, above the similarity floor', async () => {
    setup();
    const payload = { ...common(), invocationNum: 0, initialNumSteps: 1 };
    const { json } = await runScript('recall.js', payload, env);
    const context = contextText(json);
    assert.match(context, /<supermemory-recall>/);
    assert.match(context, /- ◪ Deploys run through scripts\/deploy.sh/);
    assert.doesNotMatch(context, /Low relevance/);
    assert.match(noticeText(json), /recalled 1 memory \(\d+ tok\)/);
    const search = api.requests.find((r) => r.url.endsWith('/search'));
    assert.equal(search.body.query, payload.lastUserInput);
    assert.equal(search.body.limit, 15);

    // The same turn again (a duplicate hook) and later model calls are no-ops.
    assert.deepEqual((await runScript('recall.js', payload, env)).json, {});
    assert.deepEqual(
      (await runScript('recall.js', { ...payload, invocationNum: 1 }, env))
        .json,
      {},
    );
    // A new turn with the same memory only reports it as already in context.
    const next = await runScript(
      'recall.js',
      {
        ...payload,
        initialNumSteps: 4,
        lastUserInput: 'What about deploying to prod then?',
      },
      env,
    );
    assert.deepEqual(next.json, {});
  });

  test('PreInvocation skips memories the SessionStart profile already injected', async () => {
    setup();
    const original = api.state.profile;
    // Profile facts carry a date tag; the same memory as a search hit does not.
    api.state.profile = {
      static: [],
      dynamic: [
        '[2026-10-30] Deploys run through scripts/deploy.sh after tests pass',
      ],
    };
    try {
      const payload = { ...common(), invocationNum: 0, initialNumSteps: 1 };
      await runScript('session-start.js', payload, env);
      const { json } = await runScript('recall.js', payload, env);
      assert.deepEqual(json, {});
    } finally {
      api.state.profile = original;
    }
  });

  test('PreInvocation skips short prompts and slash commands', async () => {
    setup();
    for (const lastUserInput of [
      'thanks',
      '/supermemory-status',
      '!ls -la in here now',
    ]) {
      const { json } = await runScript(
        'recall.js',
        { ...common(), invocationNum: 0, initialNumSteps: 1, lastUserInput },
        env,
      );
      assert.deepEqual(json, {});
    }
    assert.equal(api.requests.length, 0);
  });

  test('PreInvocation reads the prompt from the transcript on older builds', async () => {
    setup();
    const payload = {
      ...common(),
      invocationNum: 0,
      initialNumSteps: 1,
      transcriptPath: writeTranscript(tempDir(), [
        userStep('Where do the deploy scripts live in this repository?'),
      ]),
    };
    delete payload.lastUserInput;
    await runScript('recall.js', payload, env);
    const search = api.requests.find((r) => r.url.endsWith('/search'));
    assert.equal(
      search.body.query,
      'Where do the deploy scripts live in this repository?',
    );
  });

  test('PreInvocation injects an advisory directive for this turn only', async () => {
    setup();
    fs.mkdirSync(path.join(repo, '.agents', '.supermemory'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repo, '.agents', '.supermemory', 'config.json'),
      JSON.stringify({
        recallDirective: 'Search Supermemory before answering.',
      }),
    );
    const { json } = await runScript(
      'recall.js',
      { ...common(), invocationNum: 0, initialNumSteps: 1 },
      env,
    );
    assert.deepEqual(json, {
      injectSteps: [
        { ephemeralMessage: 'Search Supermemory before answering.' },
      ],
    });
    assert.equal(api.requests.length, 0);
  });

  test('PreInvocation points at the search tool once when nothing matches', async () => {
    setup();
    api.state.search = [];
    try {
      const payload = { ...common(), invocationNum: 0, initialNumSteps: 1 };
      const first = await runScript('recall.js', payload, env);
      assert.match(contextText(first.json), /Deeper history may still exist/);
      assert.match(noticeText(first.json), /no memories yet/);
      const second = await runScript(
        'recall.js',
        {
          ...payload,
          initialNumSteps: 3,
          lastUserInput: 'Another question about the build please',
        },
        env,
      );
      assert.deepEqual(second.json, {});
    } finally {
      api.state.search = [
        {
          id: 'm1',
          memory: 'Deploys run through scripts/deploy.sh after tests pass',
          similarity: 0.82,
        },
      ];
    }
  });

  test('PreToolUse auto-approves only read-only Supermemory tools', async () => {
    setup();
    const call = (ServerName, ToolName) => ({
      ...common(),
      toolCall: {
        name: 'call_mcp_tool',
        args: { ServerName, ToolName, Arguments: {} },
      },
    });
    assert.equal(
      (
        await runScript(
          'recall-approve.js',
          call('supermemory_supermemory', 'search_memory'),
          env,
        )
      ).json.decision,
      'auto_approve',
    );
    assert.equal(
      (
        await runScript(
          'recall-approve.js',
          call('supermemory', 'who_am_i'),
          env,
        )
      ).json.decision,
      'auto_approve',
    );
    // Everything else defers explicitly: agy reads an empty decision as deny.
    assert.deepEqual(
      (
        await runScript(
          'recall-approve.js',
          call('supermemory_supermemory', 'add_memory'),
          env,
        )
      ).json,
      { decision: 'allow' },
    );
    assert.deepEqual(
      (
        await runScript(
          'recall-approve.js',
          call('github', 'search_memory'),
          env,
        )
      ).json,
      { decision: 'allow' },
    );
    assert.deepEqual(
      (await runScript('recall-approve.js', 'not json', env)).json,
      { decision: 'allow' },
    );
    assert.equal(
      (
        await runScript(
          'recall-approve.js',
          {
            ...common(),
            toolCall: {
              name: 'mcp_supermemory_supermemory_get_profile',
              args: {},
            },
          },
          env,
        )
      ).json.decision,
      'auto_approve',
    );
  });

  test('Stop saves new turns once, under the conversation id', async () => {
    setup({ SUPERMEMORY_CAPTURE_SYNC: 'true' });
    const payload = {
      ...common(),
      executionNum: 0,
      terminationReason: 'NO_TOOL_CALL',
      fullyIdle: true,
      transcriptPath: writeTranscript(tempDir(), [
        userStep(
          'Remember that we deploy with scripts/deploy.sh after CI is green.',
        ),
        modelStep(
          'Noted — deploys go through scripts/deploy.sh once CI passes; I will use that from now on.',
        ),
      ]),
    };
    const { json } = await runScript('capture.js', payload, env);
    assert.deepEqual(json, { decision: '' });
    const save = api.requests.find((r) => r.url.endsWith('/document'));
    assert.equal(save.url, `/ns/${containerTag.getNamespace(repo)}/document`);
    assert.equal(save.body.id, payload.conversationId);
    assert.match(
      save.body.content,
      /<\|start\|>user<\|message\|>Remember that we deploy/,
    );
    assert.equal(save.body.metadata.sm_source, 'antigravity');
    assert.equal(save.body.metadata.type, 'session_turn');

    api.requests.length = 0;
    await runScript('capture.js', payload, env);
    assert.equal(
      api.requests.filter((r) => r.url.endsWith('/document')).length,
      0,
    );
  });

  test('a failed save keeps the cursor and surfaces at the next SessionStart', async () => {
    setup({ SUPERMEMORY_CAPTURE_SYNC: 'true' });
    api.state.status = { '/document': 500 };
    const payload = {
      ...common(),
      transcriptPath: writeTranscript(tempDir(), [
        userStep(
          'Remember: the staging database is reset every Monday morning.',
        ),
        modelStep(
          'Understood — staging data is wiped every Monday, so I will not rely on it persisting.',
        ),
      ]),
    };
    try {
      await runScript('capture.js', payload, env);
    } finally {
      api.state.status = {};
    }
    const start = await runScript('session-start.js', common(), env);
    assert.match(noticeText(start.json), /last session save failed/);
    api.requests.length = 0;
    await runScript('capture.js', payload, env);
    assert.equal(
      api.requests.filter((r) => r.url.endsWith('/document')).length,
      1,
    );
  });

  test('Stop returns immediately and saves from a detached worker', async () => {
    setup();
    const payload = {
      ...common(),
      transcriptPath: writeTranscript(tempDir(), [
        userStep(
          'Remember that feature flags live in config/flags.yaml in this repo.',
        ),
        modelStep(
          'Got it — feature flags are defined in config/flags.yaml; I will look there first.',
        ),
      ]),
    };
    const started = Date.now();
    const { json } = await runScript('capture.js', payload, env);
    assert.deepEqual(json, { decision: '' });
    assert.ok(Date.now() - started < 5000);
    const deadline = Date.now() + 10000;
    while (
      !api.requests.some((r) => r.url.endsWith('/document')) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(api.requests.some((r) => r.url.endsWith('/document')));
  });
});

describe('MCP proxy', () => {
  test('scopes calls to the workspace and marks core tools always-loaded', async () => {
    const api = await startMockApi({ sseTools: true });
    const repo = makeRepo();
    const home = tempDir('sm-agy-proxyhome-');
    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'scripts', 'mcp-proxy.js')],
      {
        cwd: ROOT,
        env: { PATH: process.env.PATH, ...hookEnv(home, api) },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const messages = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines)
        if (line.trim()) messages.push(JSON.parse(line));
    });
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`timed out; got ${JSON.stringify(messages)}`);
    };
    const write = (message) =>
      child.stdin.write(`${JSON.stringify(message)}\n`);
    try {
      write({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
      assert.equal((await waitFor((m) => m.id === 1)).error.code, -32601);

      write({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25' },
      });
      await waitFor((m) => m.id === 2);
      write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const roots = await waitFor((m) => m.method === 'roots/list');
      write({
        jsonrpc: '2.0',
        id: roots.id,
        result: { roots: [{ uri: pathToFileURL(repo).href }] },
      });

      write({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
      const list = await waitFor((m) => m.id === 3);
      const byName = Object.fromEntries(
        list.result.tools.map((t) => [t.name, t]),
      );
      assert.equal(byName.search_memory._meta['antigravity/alwaysLoad'], true);
      assert.equal(byName.who_am_i._meta, undefined);

      write({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'search_memory', arguments: { query: 'deploy' } },
      });
      await waitFor((m) => m.id === 4);
      const forwarded = api.requests.find((r) => r.body?.id === 4);
      assert.equal(
        forwarded.body.params.arguments.namespace,
        containerTag.getNamespace(repo),
      );
      assert.equal(forwarded.headers.authorization, 'Bearer sm_test_key');
      assert.equal(forwarded.headers['mcp-session-id'], 'sess-1');
      assert.equal(forwarded.headers['mcp-protocol-version'], '2025-06-18');
      assert.ok(
        !api.requests.some(
          (r) =>
            r.body?.method === 'roots/list' ||
            String(r.body?.id).startsWith('sm-roots'),
        ),
      );
    } finally {
      child.kill();
      await api.close();
    }
  });
});

describe('cli', () => {
  test('statusline install keeps a custom line and uninstall removes only its own', async () => {
    const home = tempDir('sm-agy-clihome-');
    const settingsFile = path.join(
      home,
      '.gemini',
      'antigravity-cli',
      'settings.json',
    );
    const run = (...args) =>
      new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [path.join(ROOT, 'scripts', 'cli.js'), ...args],
          {
            env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
          },
        );
        let out = '';
        child.stdout.on('data', (c) => {
          out += c;
        });
        child.on('close', () => resolve(out));
      });

    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        theme: 'dark',
        statusLine: { type: 'command', command: 'mine.sh' },
      }),
    );
    assert.match(
      await run('statusline', 'install'),
      /custom status line is already configured/,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(settingsFile, 'utf8')).statusLine.command,
      'mine.sh',
    );

    fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark' }));
    assert.match(await run('statusline', 'install'), /installed/);
    const installed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(installed.theme, 'dark');
    assert.equal(installed.statusLine.stack_with_default, true);
    assert.match(installed.statusLine.command, /scripts\/statusline\.js"$/);

    assert.match(await run('statusline', 'uninstall'), /removed/);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), {
      theme: 'dark',
    });
  });

  test('status reports a missing sign-in without credentials', async () => {
    const home = tempDir('sm-agy-statushome-');
    const repo = makeRepo();
    const out = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          path.join(ROOT, 'scripts', 'cli.js'),
          'status',
          '--json',
          '--cwd',
          repo,
        ],
        {
          env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
        },
      );
      let data = '';
      child.stdout.on('data', (c) => {
        data += c;
      });
      child.on('close', () => resolve(JSON.parse(data)));
    });
    assert.equal(out.authenticated, false);
    assert.equal(out.keySource, null);
    assert.equal(out.namespace, containerTag.getNamespace(repo));
  });
});
