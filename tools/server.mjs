import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  handleChat,
  modelStatus,
  readJson,
  runStoredAgent,
  isModelBusy,
  cancelStoredAgent,
} from "./model-service.mjs";
import {
  workspaceStore,
  syncWorkspace,
  getArtifact,
  saveAttachment,
} from "./workspace-runtime.mjs";
import { createRoutineScheduler } from "./routine-scheduler.mjs";
const scheduler = createRoutineScheduler({
  store: workspaceStore,
  execute: runStoredAgent,
  isBusy: isModelBusy,
});
const publicSnapshot = (snapshot) => ({
  version: snapshot.version,
  state: snapshot.state
    ? {
        ...snapshot.state,
        files: Object.fromEntries(
          Object.entries(snapshot.state.files).map(([id, files]) => [
            id,
            files.map(({ base64, ...file }) => file),
          ]),
        ),
      }
    : null,
});
import {
  connectionStatus,
  saveNotionToken,
  startNotionOAuth,
  finishNotionOAuth,
  authorizeCalendar,
} from "./connections.mjs";
import { getApproval, resolveApproval } from "./approval-store.mjs";
const root = path.resolve(import.meta.dirname, "..");
if (fs.existsSync(path.join(root, ".env")))
  process.loadEnvFile(path.join(root, ".env"));
const renderer = path.join(root, "app");
fs.mkdirSync(path.join(root, "evidence"), { recursive: true });
const types = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".html": "text/html",
  ".css": "text/css",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};
const server = http.createServer(async (req, res) => {
  const port = process.env.PORT ?? 4317;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) {
    res.writeHead(403);
    res.end();
    return;
  }
  const url = new URL(req.url, "http://localhost");
  if (
    url.pathname === "/connections" ||
    url.pathname.startsWith("/connections/")
  ) {
    const files = {
      "/connections": "index.html",
      "/connections/": "index.html",
      "/connections/app.js": "app.js",
      "/connections/style.css": "style.css",
    };
    const filename = files[url.pathname];
    if (!filename) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader(
      "Content-Type",
      filename.endsWith(".js")
        ? "text/javascript"
        : filename.endsWith(".css")
          ? "text/css"
          : "text/html; charset=utf-8",
    );
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
    res.setHeader("Cache-Control", "no-store");
    res.end(fs.readFileSync(path.join(root, "src/connections", filename)));
    return;
  }
  if (url.pathname.startsWith("/api/") && req.method === "POST") {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) {
      res.writeHead(403);
      res.end();
      return;
    }
  }
  if (
    url.pathname.startsWith("/api/connections") ||
    url.pathname.startsWith("/api/approvals/")
  ) {
    try {
      let result;
      if (url.pathname === "/api/connections" && req.method === "GET")
        result = await connectionStatus();
      else if (
        url.pathname === "/api/connections/notion/token" &&
        req.method === "POST"
      )
        result = await saveNotionToken((await readJson(req)).token);
      else if (
        url.pathname === "/api/connections/notion/start" &&
        req.method === "POST"
      )
        result = await startNotionOAuth({
          redirectUri: `http://127.0.0.1:${process.env.PORT ?? 4317}/api/connections/notion/callback`,
        });
      else if (
        url.pathname === "/api/connections/notion/callback" &&
        req.method === "GET"
      ) {
        await finishNotionOAuth({
          code: url.searchParams.get("code"),
          state: url.searchParams.get("state"),
          redirectUri: `http://127.0.0.1:${process.env.PORT ?? 4317}/api/connections/notion/callback`,
        });
        res.writeHead(302, { Location: "/connections" });
        res.end();
        return;
      } else if (
        url.pathname === "/api/connections/calendar/authorize" &&
        req.method === "POST"
      )
        result = await authorizeCalendar();
      else if (
        url.pathname.startsWith("/api/approvals/") &&
        req.method === "GET"
      ) {
        result = await getApproval(url.pathname.split("/").at(-1));
        if (!result) throw new Error("操作不存在。");
      } else if (
        url.pathname.startsWith("/api/approvals/") &&
        req.method === "POST"
      )
        result = await resolveApproval(
          url.pathname.split("/").at(-1),
          await readJson(req),
        );
      else {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: /[\u3400-\u9fff]/.test(error.message ?? "")
            ? error.message
            : "连接尚未完成，请检查网络或授权后重试。",
        }),
      );
    }
    return;
  }
  if (url.pathname === "/api/workspace" && req.method === "GET") {
    try {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(publicSnapshot(await workspaceStore.read())));
    } catch {
      res.writeHead(500);
      res.end("{}");
    }
    return;
  }
  if (url.pathname === "/api/workspace/sync" && req.method === "POST") {
    try {
      const { base, state } = await readJson(req);
      const updated = await syncWorkspace(base, state);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(publicSnapshot(updated)));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "工作空间同步失败。" }));
    }
    return;
  }
  if (url.pathname === "/api/attachments" && req.method === "POST") {
    try {
      const file = await saveAttachment(await readJson(req));
      const { base64, ...publicFile } = file;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(publicFile));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "文件保存失败，请检查格式和大小。" }));
    }
    return;
  }
  if (url.pathname === "/api/agents/stop" && req.method === "POST") {
    const { agentId } = await readJson(req);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ stopped: cancelStoredAgent(agentId) }));
    return;
  }
  if (url.pathname === "/api/routines/run" && req.method === "POST") {
    try {
      const { agentId, routineId } = await readJson(req);
      const result = await scheduler.runNow(agentId, routineId);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "任务暂时无法执行，请确认任务存在且当前没有运行中的任务。",
        }),
      );
    }
    return;
  }
  if (url.pathname.startsWith("/api/artifacts/") && req.method === "GET") {
    const file = await getArtifact(url.pathname.split("/")[3]);
    if (!file) {
      res.writeHead(404);
      res.end("文件不存在");
      return;
    }
    res.setHeader(
      "Content-Type",
      file.contentType ?? file.mimeType ?? "text/plain; charset=utf-8",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(file.name ?? file.fileName ?? "document.txt")}`,
    );
    res.end(
      file.base64 ? Buffer.from(file.base64, "base64") : (file.content ?? ""),
    );
    return;
  }
  if (url.pathname === "/api/model-status" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(modelStatus()));
    return;
  }
  if (url.pathname === "/api/chat" && req.method === "POST") {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) {
      res.writeHead(403);
      res.end();
      return;
    }
    await handleChat(req, res);
    return;
  }
  if (url.pathname === "/__log" && req.method === "POST") {
    let body = "";
    for await (const p of req) {
      body += p;
      if (body.length > 20000) break;
    }
    fs.appendFileSync(path.join(root, "evidence/runtime.jsonl"), body + "\n");
    res.end("ok");
    return;
  }
  const isLocalSource = [
    "/local-bridge.js",
    "/workspace-sync.js",
    "/routine-schedule.js",
    "/config.js",
    "/custom.css",
  ].includes(url.pathname);
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  let file = isLocalSource
    ? path.join(root, "src", url.pathname.slice(1))
    : path.join(renderer, decodedPath);
  if (url.pathname === "/" || url.pathname === "/index.html")
    file = path.join(renderer, "index.html");
  if (!isLocalSource && !file.startsWith(renderer + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    let data = fs.readFileSync(file);
    if (file.endsWith("/index.html")) {
      data = data
        .toString()
        .replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, "")
        .replace("</head>", '<link rel="stylesheet" href="/custom.css"></head>')
        .replace(
          "<head>",
          '<head><script src="/config.js"></script><script type="module" src="/local-bridge.js"></script>',
        );
    }
    if (/\.(?:js|html)$/.test(file)) {
      const appName =
        fs
          .readFileSync(path.join(root, "src/config.js"), "utf8")
          .match(/appName:\s*(["'])(.*?)\1/)?.[2] ?? "Nival Bot";
      const safeName = /^[\p{L}\p{N} ._-]{1,80}$/u.test(appName)
        ? appName
        : "Nival Bot";
      data = data.toString().replaceAll("Grok Bot", safeName);
    }
    res.setHeader(
      "Content-Type",
      types[path.extname(file)] ?? "application/octet-stream",
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'self' blob:",
    );
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
server.listen(Number(process.env.PORT ?? 4317), "127.0.0.1", () => {
  console.log(`Local UI: http://127.0.0.1:${process.env.PORT ?? 4317}`);
  scheduler.start();
});
process.once("SIGINT", () => {
  scheduler.stop();
  server.close();
});
process.once("SIGTERM", () => {
  scheduler.stop();
  server.close();
});
