import { createServer } from 'node:http';

/**
 * A scripted stand-in for the Gemini API, so agy runs end to end without a
 * Google sign-in: GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL point the CLI here.
 * Agent-loop requests (the ones that carry tools) pop the next scripted turn;
 * side requests such as title generation get a fixed reply.
 */
export async function startMockGemini() {
  const requests = [];
  const script = [];
  // Subagents run their own model loop concurrently with the parent; a turn
  // queued under a marker serves only requests whose system prompt has it.
  const routed = new Map();
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let json = null;
      try {
        json = JSON.parse(body);
      } catch {}
      const isAgent = Boolean(json?.tools);
      const system = (json?.systemInstruction?.parts ?? [])
        .map((p) => p.text)
        .join('\n');
      const queue =
        [...routed].find(([marker]) => system.includes(marker))?.[1] ?? script;
      const turn = isAgent
        ? (queue.shift() ?? { text: 'Done.' })
        : { text: 'Mock title' };
      requests.push({ url: req.url, body: json, isAgent, turn, system });
      const parts =
        turn.functionCall !== undefined
          ? [
              {
                functionCall: {
                  name: turn.functionCall.name,
                  args: turn.functionCall.args ?? {},
                },
              },
            ]
          : [{ text: turn.text }];
      const payload = {
        candidates: [
          { content: { role: 'model', parts }, finishReason: 'STOP', index: 0 },
        ],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 10,
          totalTokenCount: 110,
        },
        modelVersion: 'gemini-mock',
      };
      if (/streamGenerateContent/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify(payload)}\r\n\r\n`);
      } else {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(payload));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    script,
    route: (marker, turns) => routed.set(marker, [...turns]),
    agentRequests: () => requests.filter((r) => r.isAgent),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Every text part the model was sent, in order. */
export function modelTexts(request) {
  return (request.body?.contents ?? []).flatMap((c) =>
    (c.parts ?? [])
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text),
  );
}

export function toolNames(request) {
  return (request.body?.tools ?? []).flatMap((t) =>
    (t.functionDeclarations ?? []).map((f) => f.name),
  );
}
