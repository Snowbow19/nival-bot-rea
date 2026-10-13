import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { buildMessages, handleChat } from "./model-service.mjs";

const listen = async (handler) => {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${server.address().port}` };
};
const close = (server) => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
};
const body = JSON.stringify({
  bot: { name: "研究助理", description: "只做资料分析" },
  messages: [{ role: "user", content: "你好" }],
});

test("Bot identity and group role are kept separate from message history", () => {
  const result = buildMessages({
    bot: { name: "写作伙伴", description: "改进表达" },
    group: {
      name: "产品组",
      members: [{ name: "写作伙伴" }, { name: "设计师" }],
    },
    messages: [{ role: "user", content: "请给建议" }],
  });
  assert.match(result[0].content, /写作伙伴/);
  assert.match(result[0].content, /产品组/);
  assert.match(result[0].content, /不要代替其他成员发言/);
  assert.deepEqual(result.at(-1), { role: "user", content: "请给建议" });
  assert.throws(() =>
    buildMessages({ messages: [{ role: "system", content: "bad" }] }),
  );
});

test("Split SSE chunks preserve Unicode, usage and completion, without exposing reasoning", async () => {
  let providerRequest;
  const upstream = await listen(async (req, res) => {
    let source = "";
    for await (const c of req) source += c;
    providerRequest = JSON.parse(source);
    assert.equal(req.headers.authorization, "Bearer test-only-key");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const bytes = Buffer.from(
      "data: " +
        JSON.stringify({
          model: "test-model",
          choices: [
            {
              delta: { reasoning_content: "not-visible", content: "你好" },
              finish_reason: null,
            },
          ],
        }) +
        "\n\n" +
        "data: " +
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { total_tokens: 12 },
        }) +
        "\n\ndata: [DONE]\n\n",
    );
    for (let i = 0; i < bytes.length; i += 7)
      res.write(bytes.subarray(i, i + 7));
    res.end();
  });
  const previous = { ...process.env };
  Object.assign(process.env, {
    MODEL_API_URL: upstream.url,
    MODEL_API_KEY: "test-only-key",
    MODEL_NAME: "test-model",
  });
  const local = await listen(handleChat);
  try {
    const response = await fetch(local.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const stream = await response.text();
    assert.equal(response.status, 200);
    assert.match(stream, /你好/);
    assert.match(stream, /"type":"done"/);
    assert.match(stream, /"total_tokens":12/);
    assert.doesNotMatch(stream, /not-visible|test-only-key/);
    assert.equal(providerRequest.stream, true);
    assert.equal(providerRequest.thinking.type, "disabled");
  } finally {
    process.env = previous;
    await close(local.server);
    await close(upstream.server);
  }
});

test("Provider authentication errors are translated without returning provider secrets", async () => {
  const upstream = await listen((req, res) => {
    res.writeHead(401);
    res.end("private-provider-debug-secret");
  });
  const previous = { ...process.env };
  Object.assign(process.env, {
    MODEL_API_URL: upstream.url,
    MODEL_API_KEY: "test-only-key",
    MODEL_NAME: "test-model",
  });
  const local = await listen(handleChat);
  try {
    const response = await fetch(local.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const result = await response.text();
    assert.equal(response.status, 401);
    assert.match(result, /密钥无效/);
    assert.doesNotMatch(result, /private-provider|test-only-key/);
  } finally {
    process.env = previous;
    await close(local.server);
    await close(upstream.server);
  }
});

test("Stopping the browser stream closes the upstream model response", async () => {
  let signalClosed;
  const closed = new Promise((resolve) => {
    signalClosed = resolve;
  });
  const upstream = await listen((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"开始"}}]}\n\n');
    const timer = setInterval(() => res.write(": keep-alive\n\n"), 50);
    res.on("close", () => {
      clearInterval(timer);
      signalClosed(true);
    });
  });
  const previous = { ...process.env };
  Object.assign(process.env, {
    MODEL_API_URL: upstream.url,
    MODEL_API_KEY: "test-only-key",
    MODEL_NAME: "test-model",
  });
  const local = await listen(handleChat);
  const controller = new AbortController();
  try {
    const response = await fetch(local.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    assert.equal(
      await Promise.race([
        closed,
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 2000);
          timer.unref();
        }),
      ]),
      true,
    );
  } finally {
    process.env = previous;
    await close(local.server);
    await close(upstream.server);
  }
});
