import { scheduleFromSpec } from "./routine-schedule.js";
import { createWorkspaceSync, applyInPlace } from "./workspace-sync.js";
/* Local implementation of the desktop and coordinator contracts recovered with REA.
 * The shipped renderer is unmodified. No original main process or credentials are used. */
(() => {
  const config = window.GROK_UI;
  const clone = (value) =>
    value === undefined ? undefined : structuredClone(value);
  const read = (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
  const stateKey = "nival-bot.local.v1";
  const timestamp = Date.now();
  const agent = (data) => ({
    id: crypto.randomUUID(),
    name: "新 Bot",
    description: "",
    harness: "temporal",
    isGroup: false,
    memberIds: [],
    avatarShape: "squircle",
    avatarColor: "blue",
    isRunning: false,
    isRunningTurn: false,
    awaitingUserResponse: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasUnread: false,
    archived: false,
    viewerIsOwner: true,
    ...data,
  });
  const message = (role, content, seq, extra = {}) => ({
    kind: "message",
    id: crypto.randomUUID(),
    role,
    content,
    seq,
    timestampMs: Date.now(),
    isStreaming: false,
    ...extra,
  });
  const state = read(stateKey, {
    agents: config.bots.map(agent),
    pinned: config.pinnedBotIds,
    sections: config.sections,
    mainAgentId: config.bots[0].id,
    transcripts: {
      "local-assistant": [
        message("user", "我想做一个属于自己的 AI 工作空间。", 1),
        message(
          "assistant",
          "我们可以从你每天最常做的事情开始。\n\n你希望它帮你整理资料、打磨想法，还是推进一个具体项目？",
          2,
        ),
        message("user", "先把想法整理清楚，再一步步做出来。", 3),
        message(
          "assistant",
          "好。把你的想法写下来，我们一起确定目标、拆解步骤，再把第一步变得足够具体。",
          4,
        ),
      ],
    },
    automations: {},
    workflows: {},
    files: {},
    preferences: {},
    persistence: {},
    userName: config.userName,
  });
  if (!state.automations["local-assistant"])
    state.automations["local-assistant"] = [
      {
        id: "local-routine",
        agentId: "local-assistant",
        name: "每日灵感整理",
        prompt: "整理今天记录的想法。",
        trigger: { type: "cron", schedule: "0 9 * * *" },
        triggerDescription: "每天 09:00",
        isEnabled: false,
        createdAt: timestamp,
      },
    ];
  for (const bot of state.agents) {
    if (bot.profile) {
      Object.assign(bot, bot.profile);
      delete bot.profile;
    }
  }
  for (const bot of state.agents) {
    bot.isRunning = false;
    bot.isRunningTurn = false;
    bot.currentActivity = null;
  }
  for (const entries of Object.values(state.transcripts))
    for (const entry of entries) {
      if (entry.isStreaming || entry.streaming) {
        entry.isStreaming = false;
        entry.streaming = false;
        entry.interrupted = true;
      }
      if (entry.content === "尚未连接模型服务。你的消息已保存在本机。")
        entry.serviceFeedback = true;
    }
  let workspaceSync = null;
  const persist = () => {
    save(stateKey, state);
    workspaceSync?.schedule();
  };
  persist();
  const log = (kind, value) =>
    fetch("/__log", {
      method: "POST",
      body: JSON.stringify({
        kind,
        value: value?.method
          ? {
              method: value.method,
              argumentKeys: Object.keys(value.args ?? {}),
            }
          : value,
      }),
      headers: { "Content-Type": "application/json" },
    }).catch(() => {});
  window.addEventListener("error", (e) =>
    log("error", { message: e.message, stack: e.error?.stack }),
  );
  window.addEventListener("unhandledrejection", (e) =>
    log("rejection", { message: String(e.reason), stack: e.reason?.stack }),
  );
  const noop = () => {};
  window.__duneReliability = { report: noop };
  window.sandRenderTrace = { postMessage: noop };
  const theme = () => ({
    preference: state.preferences.theme ?? config.theme,
    resolved: state.preferences.theme ?? config.theme,
    system: "light",
  });
  const language = () => ({
    preference: state.preferences.language ?? config.language,
    resolved: state.preferences.language ?? config.language,
    systemLanguage: config.language,
  });
  const experiments = { featureGates: config.featureGates };
  const subscribers = [];
  const ports = [];
  const desktopEvent = (type, value) =>
    subscribers.forEach((h) => h[type]?.(clone(value)));
  const event = (family, payload) =>
    ports.forEach((emit) =>
      emit({ kind: "event", family, payload: clone(payload) }),
    );
  const snapshot = (id) =>
    event("transcript", {
      type: "snapshot",
      activeAgentId: id,
      agentId: id,
      entries: state.transcripts[id] ?? [],
      cloudAgentPeerIds: [],
    });
  const rosterChanged = () =>
    event("server-roster-changed", { kind: "resync" });
  const findAgent = (id) => state.agents.find((a) => a.id === id);
  const activeRuns = new Map();
  let stopButton = null;
  function updateRunControl() {
    const running = activeRuns.has(state.selectedAgentId);
    const form = document.querySelector("main .sand-prompt-form");
    if (!running || !form) {
      stopButton?.remove();
      stopButton = null;
      return;
    }
    if (!stopButton) {
      stopButton = document.createElement("button");
      stopButton.type = "button";
      stopButton.className = "nival-stop-generation";
      stopButton.textContent = "停止生成";
      stopButton.setAttribute("aria-label", "停止生成");
      stopButton.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        interruptRun(event.currentTarget.dataset.agentId);
      };
    }
    stopButton.dataset.agentId = state.selectedAgentId;
    if (!stopButton.isConnected) form.appendChild(stopButton);
  }
  function publishActivity(id, running) {
    const bot = findAgent(id);
    if (!bot) return;
    bot.isRunning = running;
    bot.isRunningTurn = running;
    bot.currentActivity = null;
    event("agents", {
      agents: state.agents,
      activeAgentId: state.selectedAgentId ?? id,
    });
    rosterChanged();
    requestAnimationFrame(updateRunControl);
  }
  function interruptRun(id) {
    const run = activeRuns.get(id);
    log("run-interrupt", {
      agentId: id,
      found: Boolean(run),
      selected: state.selectedAgentId,
    });
    if (run) run.controller.abort();
    if (id)
      fetch("/api/agents/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: id }),
      }).catch(() => {});
  }
  function entryText(entry) {
    return entry.kind === "send-message"
      ? (entry.message?.content ?? "")
      : (entry.content ?? "");
  }
  async function streamReply(
    id,
    entries,
    bot,
    actor,
    controller,
    paint,
    promptArgs,
  ) {
    const context = entries
      .filter(
        (e) =>
          ["message", "send-message"].includes(e.kind) &&
          !e.serviceFeedback &&
          entryText(e).trim(),
      )
      .map((e) => ({
        role:
          e.kind === "send-message"
            ? e.author?.id === actor.id
              ? "assistant"
              : "user"
            : e.role,
        content:
          bot.isGroup && e.author?.name && e.author.id !== actor.id
            ? `[${e.author.name}] ${entryText(e)}`
            : entryText(e),
      }));
    const reply = bot.isGroup
      ? {
          kind: "send-message",
          id: crypto.randomUUID(),
          seq: entries.length + 1,
          timestampMs: Date.now(),
          message: { type: "text", content: "" },
          author: { id: actor.id, name: actor.name },
          streaming: true,
          provider: "DeepSeek",
        }
      : message("assistant", "", entries.length + 1, {
          isStreaming: true,
          provider: "DeepSeek",
        });
    entries.push(reply);
    paint(true);
    let ended = false;
    try {
      await workspaceSync?.flush();
      const result = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          messages: context,
          conversationId: id,
          attachmentPaths: promptArgs?.attachmentPaths ?? [],
          userRequest: promptArgs?.prompt ?? "",
          bot: {
            id: actor.id,
            name: actor.name,
            description: actor.description,
            instructions: (state.workflows[actor.id] ?? [])
              .map((w) => w.body ?? w.content ?? w.description ?? "")
              .filter(Boolean)
              .join("\n\n"),
          },
          ...(bot.isGroup
            ? {
                group: {
                  name: bot.name,
                  members: bot.memberIds
                    .map(findAgent)
                    .filter(Boolean)
                    .map((a) => ({ name: a.name, description: a.description })),
                },
              }
            : {}),
        }),
      });
      if (!result.ok) {
        const data = await result.json().catch(() => ({}));
        throw new Error(data.error ?? "模型请求失败，请重试。");
      }
      if (!result.body) throw new Error("没有收到模型回复，请重试。");
      const reader = result.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith("data:")) continue;
            const item = JSON.parse(line.slice(5).trim());
            if (item.type === "tool_start") {
              bot.currentActivity = {
                kind: "tool",
                tool: item.name,
                detail: null,
              };
              event("agents", {
                agents: state.agents,
                activeAgentId: state.selectedAgentId ?? id,
              });
            }
            if (item.type === "tool_result") {
              await workspaceSync?.refresh();
              const file =
                item.name === "WriteArtifact" && item.result?.success
                  ? item.result.data
                  : null;
              if (file && !entries.some((e) => e.artifactId === file.id)) {
                entries.push({
                  kind: "send-message",
                  id: crypto.randomUUID(),
                  seq: entries.length + 1,
                  timestampMs: Date.now(),
                  message: {
                    type: "attachment",
                    url: `/api/artifacts/${file.id}/${file.name}`,
                  },
                  ...(bot.isGroup
                    ? { author: { id: actor.id, name: actor.name } }
                    : {}),
                  artifactId: file.id,
                  serviceFeedback: true,
                });
                paint(true);
              }
              bot.currentActivity = null;
              event("agents", {
                agents: state.agents,
                activeAgentId: state.selectedAgentId ?? id,
              });
            }
            if (item.type === "delta") {
              if (reply.kind === "send-message")
                reply.message.content += item.text;
              else reply.content += item.text;
              paint();
            }
            if (item.type === "done") {
              ended = true;
              reply.model = item.model;
              reply.usage = item.usage;
              reply.finishReason = item.finishReason;
            }
            if (item.type === "error") throw new Error(item.error);
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (!ended) throw new Error("连接中断，已保留收到的回复，请重试。");
      if (reply.finishReason === "length")
        entries.push(
          message(
            "assistant",
            "回复已达到长度上限，你可以让我继续。",
            entries.length + 1,
            { serviceFeedback: true },
          ),
        );
      return reply;
    } catch (error) {
      reply.interrupted = controller.signal.aborted;
      if (!entryText(reply).trim()) entries.splice(entries.indexOf(reply), 1);
      throw error;
    } finally {
      reply.isStreaming = false;
      reply.streaming = false;
      paint(true);
    }
  }
  async function runCompletion(id, promptArgs) {
    const entries = state.transcripts[id],
      bot = findAgent(id),
      controller = new AbortController();
    const run = { controller };
    activeRuns.set(id, run);
    const members = bot.isGroup
      ? bot.memberIds.map(findAgent).filter((a) => a && !a.isGroup)
      : [bot];
    const mentioned = members.filter((a) =>
      (promptArgs.prompt ?? "").includes(`@${a.name}`),
    );
    const actors = mentioned.length ? mentioned : members;
    let lastPaint = 0,
      lastReply = null;
    const paint = (force = false) => {
      if (force || Date.now() - lastPaint > 75) {
        snapshot(id);
        lastPaint = Date.now();
      }
      if (force) persist();
    };
    publishActivity(id, true);
    persist();
    snapshot(id);
    try {
      for (const actor of actors) {
        if (controller.signal.aborted) break;
        if (bot.isGroup && !bot.memberIds.includes(actor.id)) continue;
        bot.activeGroupMemberId = bot.isGroup ? actor.id : undefined;
        publishActivity(id, true);
        lastReply = await streamReply(
          id,
          entries,
          bot,
          actor,
          controller,
          paint,
          promptArgs,
        );
        bot.lastMessageId = lastReply.id;
        bot.lastEntry = { kind: "text", text: entryText(lastReply) };
        bot.lastMessagePreview = entryText(lastReply);
        bot.lastActivityAt = Date.now();
        persist();
      }
    } catch (error) {
      entries.push(
        message(
          "assistant",
          controller.signal.aborted
            ? "已停止生成。"
            : /[\u3400-\u9fff]/.test(error.message ?? "")
              ? error.message
              : "连接中断，已保留收到的回复，请重试。",
          entries.length + 1,
          { serviceFeedback: true },
        ),
      );
    } finally {
      controller.abort();
      if (activeRuns.get(id) === run) {
        activeRuns.delete(id);
        if (findAgent(id) && state.transcripts[id] === entries) {
          bot.activeGroupMemberId = undefined;
          bot.lastMessagePreview = entryText(entries.at(-1) ?? {});
          bot.lastActivityAt = Date.now();
          if (lastReply) {
            bot.lastMessageId = lastReply.id;
            bot.lastEntry = { kind: "text", text: entryText(lastReply) };
          }
          bot.lastViewedAt =
            state.selectedAgentId === id ? Date.now() : bot.lastViewedAt;
          paint(true);
          publishActivity(id, false);
          persist();
        }
      }
    }
  }
  window.addEventListener("pagehide", () => {
    for (const run of activeRuns.values()) run.controller.abort();
  });
  const auth = () => ({
    kind: "logged-in",
    authId: "local-user",
    email: "local@example.test",
    name: state.userName,
    displayName: state.userName,
    profileReady: true,
  });
  const stagedFiles = new Map();
  async function stageFile(filename, file) {
    if (!file.size) return { ok: false, reason: "empty" };
    if (file.size > 8 * 1024 * 1024) return { ok: false, reason: "too-large" };
    const key = `/local/staging/${crypto.randomUUID()}/${filename}`;
    stagedFiles.set(key, {
      name: filename,
      contentType: file.type || "text/plain",
      bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
    });
    return { ok: true, path: key };
  }
  const emptyMcp = { servers: [], plugins: [], effectivePlugins: [] };
  const desktopDefaults = {
    getCursorLoginFlight: { kind: "idle" },
    getCursorAvatar: null,
    listCursorAccounts: { accounts: [], activeAccountId: "local-user" },
    hasMigratedClientPersistence: true,
    getOnboardingSeen: true,
    getBoxHostPhase: "settled",
    getBoxMigrationStatus: null,
    getCursorSelectedTeam: { selectedTeamId: null, fallback: null },
    getSandAccess: { state: "granted" },
    getCursorUnifyCta: null,
    getMcpCatalog: [],
    refreshMcpCatalog: [],
    getMcpState: emptyMcp,
    getEffectivePlugins: [],
    getMcpTeamPopularity: [],
    getSandMachines: {
      machines: [
        {
          machineId: "local-ui",
          label: "本机",
          platform: "darwin",
          isCurrent: true,
          isOnline: true,
          lastSeenAt: timestamp,
        },
      ],
      currentMachineId: "local-ui",
      currentMachineRemoved: false,
    },
    getWindowState: {
      isFocused: true,
      isMaximized: false,
      isFullScreen: false,
    },
    getDesktopWindowState: {
      isFocused: true,
      isMaximized: false,
      isFullScreen: false,
    },
    getHardwareAcceleration: { enabled: true, enabledAtLaunch: true },
    getSpellCheckEnabled: true,
    getBotColorInChatEnabled: false,
    getWebauthnProxyEnabled: false,
    getEgressTunnelEnabled: false,
    getEgressTunnelStatus: { status: "disabled" },
    getDesktopNotificationPreferences: { enabled: false, soundEnabled: false },
    getUpdateStatus: {
      state: { type: "disabled" },
      isBelowMinimumVersion: false,
      currentVersion: "0.70.2",
      currentTrack: "stable",
      availableTracks: ["stable"],
      isTrackManagedByPolicy: false,
      autoUpdateWhenIdle: false,
    },
    getTimeZone: { detectedTimeZone: "Asia/Shanghai", overrideTimeZone: null },
    getLocalToolPermission: "ask",
    getMessagesAppIcon: null,
    getAutoReviewInstructions: {
      isEnabled: false,
      allowInstructions: [],
      blockInstructions: [],
    },
    getTeamMemberPolicy: null,
    getGrokBotTermsRecord: { accepted: true },
    getCursorUsageSummary: null,
    getCursorPrReviewPreferences: { enabled: false },
    getCursorTeamInviteEligibility: { eligible: false },
    getGrokBotAgentMcpServers: [],
    getGrokBotAgentSkills: [],
    getGrokBotAgentSecrets: { keys: [] },
    getGrokBotAgentFiles: [],
  };
  async function desktopCall(method, args = {}) {
    if (!/^(report|expose|note|log)/.test(method))
      log("desktop", { method, args });
    switch (method) {
      case "stageAttachmentBytes":
        return stageFile(args.filename, new Blob([new Uint8Array(args.bytes)]));
      case "discardStagedAttachment":
        stagedFiles.delete(args.path);
        return;
      case "commitStagedAttachments": {
        await workspaceSync?.flush();
        const committed = [];
        for (const source of args.paths) {
          const file = stagedFiles.get(source);
          if (!file) throw new Error("附件已失效，请重新选择。");
          const r = await fetch("/api/attachments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...file, agentId: args.agentId }),
          });
          if (!r.ok) throw new Error("附件保存失败。");
          const saved = await r.json();
          committed.push(saved.url);
          stagedFiles.delete(source);
        }
        await workspaceSync.refresh();
        return committed;
      }
      case "downloadAttachment": {
        const target = new URL(args.path, location.origin);
        if (
          target.origin !== location.origin ||
          !target.pathname.startsWith("/api/artifacts/")
        )
          throw new Error("文件未保存到工作空间。");
        const a = document.createElement("a");
        a.href = target.href;
        a.download = args.suggestedName ?? "";
        a.click();
        return;
      }
      case "readAttachmentText":
      case "readAttachmentBytes": {
        const target = new URL(args.path, location.origin);
        if (
          target.origin !== location.origin ||
          !target.pathname.startsWith("/api/artifacts/")
        )
          return null;
        const r = await fetch(target);
        if (!r.ok) return null;
        const bytes = new Uint8Array(await r.arrayBuffer());
        return method === "readAttachmentText"
          ? {
              kind: /^(text\/|application\/(json|xml))/.test(
                r.headers.get("content-type") ?? "",
              )
                ? "text"
                : "binary",
              bytes: bytes.length,
            }
          : {
              kind: "bytes",
              bytes,
              size: bytes.length,
              resolvedName: decodeURIComponent(
                target.pathname.split("/").at(-1),
              ),
            };
      }
      case "getThemeState":
        return theme();
      case "setThemePreference":
        state.preferences.theme =
          args.preference === "system" ? "light" : args.preference;
        persist();
        desktopEvent("theme-changed", theme());
        return theme();
      case "getLanguageState":
        return language();
      case "setLanguagePreference":
        state.preferences.language =
          args.preference === "system" ? config.language : args.preference;
        persist();
        desktopEvent("language-changed", language());
        return language();
      case "getSpellCheckEnabled":
        return state.preferences.spellCheck ?? true;
      case "setSpellCheckEnabled":
        state.preferences.spellCheck = args.enabled;
        persist();
        return args.enabled;
      case "getAutoReviewInstructions":
        return (
          state.preferences.autoReview ??
          desktopDefaults.getAutoReviewInstructions
        );
      case "setAutoReviewInstructions":
        state.preferences.autoReview = args.instructions;
        persist();
        return args.instructions;
      case "getExperimentsSnapshot":
        return experiments;
      case "getCursorAuthStatus":
        return auth();
      case "updateCursorAccountName":
        state.userName = args.name;
        persist();
        desktopEvent("cursor-auth-changed", auth());
        return auth();
      case "getHostPinnedAgents":
      case "getServerPinnedAgents":
        return state.pinned;
      case "setHostPinnedAgents":
        state.pinned = args.pinnedAgentIds;
        persist();
        return state.pinned;
      case "getHostSidebarSections":
        return state.sections;
      case "setHostSidebarSections":
        state.sections = args.sections;
        persist();
        return state.sections;
      case "readClientPersistence":
        return state.persistence[args.key] ?? null;
      case "readManyClientPersistence":
        return Object.fromEntries(
          Object.entries(state.persistence).filter(([k]) => {
            const match = (prefixes) =>
              Math.max(
                -1,
                ...(prefixes ?? [])
                  .filter((p) => k.startsWith(p))
                  .map((p) => p.length),
              );
            return (
              match(args.include) >= 0 &&
              match(args.include) >= match(args.exclude)
            );
          }),
        );
      case "writeClientPersistence":
        state.persistence[args.key] = args.value;
        persist();
        return;
      case "removeClientPersistence":
        delete state.persistence[args.key];
        persist();
        return;
      case "listClientPersistenceKeys":
        return Object.keys(state.persistence).filter((k) =>
          k.startsWith(args.prefix ?? ""),
        );
      case "readTranscriptStoreTail":
        return null;
      case "listLibraryPages":
        return { pages: [] };
      case "listLibraryDocs":
        return [];
      case "listGrokBotAgentFiles": {
        const files = (state.files[args.agentId] ?? []).map((f) => ({
          name: f.name,
          path: f.url ?? `/api/artifacts/${f.id}`,
          sizeBytes:
            f.bytes ??
            f.size ??
            new TextEncoder().encode(f.content ?? "").length,
          contentType: f.contentType ?? "text/plain",
          updatedAtMs: f.updatedAt ?? f.createdAt,
          etag: f.id,
        }));
        return {
          files,
          totalBytes: files.reduce((n, f) => n + f.sizeBytes, 0),
          canEdit: true,
        };
      }
      case "uploadGrokBotAgentFile": {
        await workspaceSync?.flush();
        const r = await fetch("/api/attachments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: args.agentId,
            name: args.fileName,
            contentType: args.contentType,
            bytes: Array.from(args.bytes),
          }),
        });
        if (!r.ok) throw new Error("保存文件失败。");
        const f = await r.json();
        await workspaceSync.refresh();
        return {
          name: f.name,
          path: f.url,
          sizeBytes: f.bytes,
          contentType: f.contentType,
          updatedAtMs: f.updatedAt,
          etag: f.id,
        };
      }
      case "deleteGrokBotAgentFile":
        state.files[args.agentId] = (state.files[args.agentId] ?? []).filter(
          (f) => f.name !== args.name,
        );
        persist();
        await workspaceSync?.flush();
        return;
      case "getGrokBotAgentFiles":
        return state.files[args.agentId] ?? [];
      case "getGrokBotAgent":
        return findAgent(args.agentId ?? args.id) ?? null;
      case "updateGrokBotAgent": {
        const a = findAgent(args.agentId ?? args.id ?? args.serverId);
        if (a) {
          Object.assign(a, args.profile ?? args.patch ?? args);
          persist();
          rosterChanged();
        }
        return a;
      }
      case "openExternal":
      case "openUrl": {
        const target = new URL(
          typeof args === "string" ? args : args.url,
          location.origin,
        );
        if (
          target.origin === location.origin &&
          target.pathname.startsWith("/api/artifacts/")
        ) {
          const a = document.createElement("a");
          a.href = target.href;
          a.download = "";
          a.click();
          return;
        }
        if (["http:", "https:"].includes(target.protocol)) {
          window.open(target.href, "_blank", "noopener,noreferrer");
          return;
        }
        throw new Error("不支持此链接。");
      }
      case "setViewingAgent":
        state.selectedAgentId = args.agentId;
        persist();
        requestAnimationFrame(updateRunControl);
        return;
    }
    if (Object.hasOwn(desktopDefaults, method))
      return clone(desktopDefaults[method]);
    if (method.startsWith("list")) return [];
    if (method.startsWith("get")) return {};
    return undefined;
  }
  const main = new Proxy(
    {
      subscribe(h) {
        subscribers.push(h);
        return () => subscribers.splice(subscribers.indexOf(h), 1);
      },
    },
    {
      get(t, k) {
        return k in t ? t[k] : (args) => desktopCall(k, args);
      },
    },
  );
  window.desktop = {
    main,
    boot: {
      theme: theme(),
      language: language(),
      experiments,
      isBotColorInChatEnabled: false,
      isAssistiveTechEnabled: false,
      egressTunnelStatus: { status: "disabled" },
    },
    environment: {
      platform: "darwin",
      isDev: false,
      usesProductionBackend: false,
      hasChromeCookieImport: false,
      devVoiceHarness: "package",
    },
    local: {
      getZoomFactor: () => 1,
      stageAttachmentFile: stageFile,
      noteRendererAlive: noop,
      noteBootGateLanded: noop,
      noteBootGateOpened: noop,
    },
  };
  window.desktopMount = new Proxy(
    { subscribe: () => noop },
    { get: (t, k) => t[k] ?? (async () => ({})) },
  );
  const types = {
    createAgentFromTemplate: "record",
    resolveAgentCreation: "record",
    restoreTemporalAgentRouting: "void",
    noteMountedAgent: "void",
    getServerAgentRoster: "record",
    getAgentTranscriptTail: "transcript-page",
    openAgentTail: "transcript-page",
    sendPrompt: "send-result",
    promptAcceptanceStatus: "acceptance-lookup",
    respondToWidget: "record-or-null",
    resolveAutoReviewApproval: "void",
    resolveLocalToolPermission: "void",
    resolveConnectorGrant: "void",
    resolveMessagesGrants: "void",
    resolveVirtualCardApproval: "record",
    beginSpendApproval: "record",
    listVirtualCardPaymentMethods: "record",
    getMainAgent: "record",
    setMainAgent: "record",
    ensureDefaultMainAgent: "record",
    dismissWidget: "record",
    sendDraft: "record",
    discardDraft: "record",
    submitSecret: "void",
    submitUserForm: "void",
    dismissUserForm: "void",
    reactToMessage: "void",
    voteFeedback: "void",
    publishBotTemplate: "record",
    getBotTemplateVersion: "record",
    getBotTemplateForSourceAgent: "record-or-null",
    getBotTemplateExportPolicy: "record",
    deleteBotTemplate: "void",
    setBotTemplateVisibility: "record",
    getHostStatus: "host-status",
    updateHostNow: "record",
    listAgents: "array",
    countAgents: "count",
    searchAgents: "array",
    searchMedia: "array",
    createAgent: "record",
    createGroup: "record",
    setGroupMembers: "record-or-null",
    updateAgent: "record-or-null",
    seedConversationName: "record",
    deleteAgents: "record",
    kickstartAgent: "record-or-null",
    interruptAgentRun: "record",
    startFreshConversation: "void",
    rollBackConversation: "void",
    requestDiskSaverAudit: "record-or-null",
    getCloudAgentInfo: "record-or-null",
    getCloudAgentConversation: "record-or-null",
    ensureCloudAgentArtifacts: "array",
    stopCloudAgent: "void",
    getCloudAgentPublishProposals: "record",
    listCloudAgentPublishedApps: "record",
    confirmCloudAgentPublishProposal: "record",
    dismissCloudAgentPublishProposal: "record",
    updateCloudAgentPublishApp: "record",
    getListenerIntegrations: "record",
    getListenerConnectUrl: "connect-url",
    completeGithubConnect: "record",
    setAgentUnread: "void",
    clearGeneratedRoomNameStamps: "record",
    setAgentHiddenFromSidebar: "void",
    setAgentNotifyOnUpdates: "void",
    setAgentDraftingDisabled: "void",
    setAgentVoice: "void",
    previewVoice: "record",
    setAgentAvatarBytes: "record-or-null",
    getAgentAvatar: "record",
    getAgentWorkflows: "array",
    createAgentWorkflow: "array",
    updateAgentWorkflow: "array",
    deleteAgentWorkflow: "array",
    runAgentWorkflowNow: "void",
    importAgentWorkflowText: "import-result",
    importAgentWorkflowUrl: "import-result",
    getConversationOutline: "array",
    readMainAgentContext: "record",
    nudgeVoiceCall: "record",
    recordVoiceCall: "void",
    setVoiceCallPresence: "void",
    getVoiceCall: "record-or-null",
    readMcpAppResource: "record",
    callMcpAppTool: "record",
    skillsCatalog: "array",
    syncPluginSkills: "array",
    getPluginSyncStatus: "record",
    getMcpState: "record",
    getMcpCatalog: "array",
    getMcpPluginLogo: "record-or-null",
    removeMcpServer: "record",
    authenticateMcpServer: "record",
    renameMcpAccount: "record",
    removeMcpAccount: "record",
    setMcpCustomInstructions: "record",
    listMcpServerTools: "array",
    toggleMcpToolDisabled: "array",
    transcribeAudio: "record",
    generateAgentAvatarImage: "record",
    getSkillPublishTargets: "record",
    publishSkill: "record",
    resyncPublishedSkill: "record",
    unpublishSkill: "record",
    unpublishPluginListing: "record",
    hasRestorablePluginListingCopy: "boolean",
    getSubagents: "array",
    getAsyncTasks: "array",
    getForeverBoxStatus: "box-status",
    ensureForeverBox: "box-status",
    handBackForeverBox: "void",
    startTeachRecording: "record",
    stopTeachRecording: "record",
    getTeachRecordingStatus: "record",
    getTrays: "array",
    dismissTray: "void",
    clearTrays: "void",
    getAgentChannels: "channels-view",
    connectChannel: "channels-view",
    disconnectChannel: "channels-view",
    refreshChannel: "channels-view",
    getBoxSecretsStatus: "box-secrets",
    getAgentAutomations: "array",
    getAgentTasks: "array",
    markAgentTaskDone: "array",
    markAgentTaskRead: "array",
    getAutomationWebhookCredential: "record",
    listAllAutomations: "array",
    isEgressTunnelAvailable: "boolean",
    setAgentAutomationEnabled: "array",
    createAgentAutomation: "array",
    updateAgentAutomation: "array",
    deleteAgentAutomation: "array",
    runAgentAutomationNow: "void",
  };
  const coordinatorDefaults = {
    getHostStatus: {
      hostVersion: "0.70.2",
      latestHostVersion: null,
      hostUpdateAvailable: false,
      isBusy: false,
      capabilities: [],
    },
    getTrays: [],
    skillsCatalog: [],
    getAsyncTasks: [],
    getSubagents: [],
    getForeverBoxStatus: null,
    isEgressTunnelAvailable: false,
    getTeachRecordingStatus: { status: "idle" },
    getBotTemplateExportPolicy: { canExport: false },
    getAgentChannels: { manifests: [], connections: [] },
    getMcpState: emptyMcp,
    getMcpCatalog: [],
    getPluginSyncStatus: { status: "ready", plugins: [] },
    getBoxSecretsStatus: { keys: [], isApplied: false, lastAppliedAtMs: null },
    getAgentTasks: [],
  };
  async function coordinatorCall(method, args = {}) {
    log("coordinator", { method, args });
    const id = args.id ?? args.agentId;
    switch (method) {
      case "listAgents":
        return state.agents;
      case "getServerAgentRoster":
        return { agents: state.agents, revision: 1 };
      case "countAgents":
        return state.agents.length;
      case "searchAgents":
        return Object.entries(state.transcripts).flatMap(([agentId, entries]) =>
          entries
            .filter(
              (entry) =>
                entry.kind === "message" &&
                entry.content
                  .toLowerCase()
                  .includes((args.query ?? "").toLowerCase()),
            )
            .map((entry) => ({
              agentId,
              entryId: entry.id,
              snippet: entry.content,
              role: entry.role,
              timestampMs: entry.timestampMs,
            })),
        );
      case "getMainAgent":
      case "ensureDefaultMainAgent":
        return { agentId: state.mainAgentId };
      case "setMainAgent":
        state.mainAgentId = id;
        persist();
        return { agentId: id };
      case "resolveAgentCreation":
        return { kind: "box" };
      case "createAgent":
      case "createAgentFromTemplate":
      case "createGroup": {
        const data = args.spec ?? args;
        const a = agent({
          ...data,
          name: data.name || "新 Bot",
          isGroup: method === "createGroup",
          memberIds: data.memberAgentIds ?? data.memberIds ?? [],
        });
        state.agents.push(a);
        state.transcripts[a.id] = [];
        persist();
        queueMicrotask(rosterChanged);
        return { agent: a, activeAgentId: a.id, transcript: [] };
      }
      case "updateAgent":
      case "setGroupMembers":
      case "seedConversationName": {
        const a = findAgent(id);
        if (!a) return null;
        if (method === "updateAgent")
          Object.assign(a, args.profile ?? args.patch ?? args);
        if (method === "setGroupMembers")
          a.memberIds = args.memberAgentIds ?? args.memberIds ?? [];
        if (method === "seedConversationName" && a.name === "新 Bot")
          a.name = args.prompt.slice(0, 20);
        a.updatedAt = Date.now();
        persist();
        queueMicrotask(rosterChanged);
        return a;
      }
      case "deleteAgents":
        for (const botId of args.ids) interruptRun(botId);
        state.agents = state.agents.filter((a) => !args.ids.includes(a.id));
        persist();
        queueMicrotask(rosterChanged);
        return { refusedAgentIds: [], failedAgentIds: [] };
      case "setAgentUnread": {
        const a = findAgent(id);
        if (a) a.hasUnread = args.isUnread;
        persist();
        rosterChanged();
        return;
      }
      case "setAgentHiddenFromSidebar": {
        const a = findAgent(id);
        if (a) a.hiddenFromSidebar = args.isHidden;
        persist();
        rosterChanged();
        return;
      }
      case "getAgentTranscriptTail":
      case "openAgentTail":
        return {
          entries: state.transcripts[id] ?? [],
          nextBeforeSeq: null,
          cloudAgentPeerIds: [],
        };
      case "sendPrompt": {
        if (!findAgent(id)) throw new Error("这个 Bot 已不存在。");
        const entries = state.transcripts[id] ?? (state.transcripts[id] = []);
        if (
          args.clientNonce &&
          entries.some((e) => e.clientNonce === args.clientNonce)
        )
          return { accepted: true };
        if (
          findAgent(id).isGroup &&
          !findAgent(id).memberIds.some(
            (memberId) => findAgent(memberId) && !findAgent(memberId).isGroup,
          )
        )
          throw new Error("请先为群聊添加 Bot。");
        if (activeRuns.has(id))
          throw new Error("正在回复，请先停止生成或等待回复结束。");
        if (
          (typeof args.prompt !== "string" || !args.prompt.trim()) &&
          !args.attachmentPaths?.length
        )
          throw new Error("请输入消息。");
        for (const [index, filePath] of (
          args.attachmentPaths ?? []
        ).entries()) {
          const file = (state.files[id] ?? []).find((f) => f.url === filePath);
          entries.push({
            kind: "user-attachment",
            id: crypto.randomUUID(),
            seq: entries.length + 1,
            file_path: filePath,
            file_name: args.attachmentNames?.[index] ?? file?.name ?? "附件",
            timestampMs: Date.now(),
            byteSize: file?.bytes ?? file?.size,
            clientNonce: args.clientNonce,
            batchId: args.clientNonce,
          });
        }
        entries.push(
          message("user", args.prompt || "请阅读附件。", entries.length + 1, {
            attachmentPaths: args.attachmentPaths ?? [],
            attachmentNames: args.attachmentNames ?? [],
            clientNonce: args.clientNonce,
          }),
        );
        persist();
        snapshot(id);
        void runCompletion(id, args);
        return { accepted: true };
      }
      case "interruptAgentRun":
        interruptRun(id);
        return { interrupted: true };
      case "promptAcceptanceStatus":
        return { outcome: "accepted" };
      case "startFreshConversation":
        interruptRun(id);
        state.transcripts[id] = [];
        persist();
        snapshot(id);
        return;
      case "getAgentAutomations":
        return state.automations[id] ?? [];
      case "listAllAutomations":
        return Object.entries(state.automations).flatMap(([agentId, rows]) =>
          rows.map((automation) => ({
            agentId,
            agentName: findAgent(agentId)?.name ?? "",
            automation,
          })),
        );
      case "createAgentAutomation": {
        const rows = state.automations[id] ?? (state.automations[id] = []);
        rows.push({
          ...args.spec,
          localSchedule: scheduleFromSpec(args.spec),
          runs: [],
          filePath: "local-routine",
          id: crypto.randomUUID(),
          agentId: id,
          isEnabled: true,
          createdAt: Date.now(),
        });
        persist();
        return rows;
      }
      case "setAgentAutomationEnabled":
      case "updateAgentAutomation":
      case "deleteAgentAutomation": {
        let rows = state.automations[id] ?? [];
        const item = rows.find((a) => a.id === args.automationId);
        if (item && method === "setAgentAutomationEnabled")
          item.isEnabled = args.isEnabled;
        if (item && method === "updateAgentAutomation") {
          const scheduling =
            args.spec.schedule !== undefined || args.spec.trigger !== undefined;
          const changed = scheduling
            ? {
                localSchedule: scheduleFromSpec({ ...item, ...args.spec }),
                nextRunAt: null,
              }
            : {};
          Object.assign(item, args.spec, changed);
        }
        if (method === "deleteAgentAutomation")
          rows = state.automations[id] = rows.filter(
            (a) => a.id !== args.automationId,
          );
        persist();
        return rows;
      }
      case "getAgentWorkflows":
        return state.workflows[id] ?? [];
      case "createAgentWorkflow": {
        const rows = state.workflows[id] ?? (state.workflows[id] = []);
        rows.push({
          ...args.spec,
          id: crypto.randomUUID(),
          createdAt: Date.now(),
        });
        persist();
        return rows;
      }
      case "updateAgentWorkflow":
      case "deleteAgentWorkflow": {
        let rows = state.workflows[id] ?? [];
        const item = rows.find((a) => a.id === args.workflowId);
        if (item && args.spec) Object.assign(item, args.spec);
        if (method === "deleteAgentWorkflow")
          rows = state.workflows[id] = rows.filter(
            (a) => a.id !== args.workflowId,
          );
        persist();
        return rows;
      }
      case "getAgentTasks":
        return state.persistence.tasks?.[id] ?? [];
      case "markAgentTaskDone": {
        const rows = state.persistence.tasks?.[id] ?? [];
        const task = rows.find((t) => t.id === args.taskId);
        if (task) {
          task.status = "done";
          task.updatedAtMs = Date.now();
        }
        persist();
        return rows;
      }
      case "markAgentTaskRead": {
        const rows = state.persistence.tasks?.[id] ?? [];
        const task = rows.find((t) => t.id === args.taskId);
        if (task) {
          delete task.unreadEntryId;
          delete task.unreadAtMs;
          delete task.unreadPreview;
        }
        persist();
        return rows;
      }
      case "runAgentAutomationNow": {
        await workspaceSync?.flush();
        const r = await fetch("/api/routines/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: id, routineId: args.automationId }),
        });
        await workspaceSync.refresh();
        if (!r.ok) throw new Error("任务执行失败。");
        return;
      }
    }
    if (Object.hasOwn(coordinatorDefaults, method))
      return clone(coordinatorDefaults[method]);
    const type = types[method];
    if (type === "array") return [];
    if (type === "record-or-null" || type === "box-status") return null;
    if (type === "boolean") return false;
    if (type === "count") return 0;
    if (type === "void") return undefined;
    return {};
  }
  window.coordinatorPort = {
    claim({ onPort }) {
      const listeners = [];
      const emit = (data) =>
        queueMicrotask(() =>
          listeners.forEach((fn) => fn({ data: clone(data) })),
        );
      ports.push(emit);
      const port = {
        addEventListener(k, fn) {
          if (k === "message") listeners.push(fn);
        },
        removeEventListener() {},
        start() {},
        close() {},
        postMessage(msg) {
          if (msg.kind === "lifecycle" && msg.phase === "hello") {
            emit({ kind: "lifecycle", phase: "ready", protocolVersion: 3 });
            return;
          }
          if (msg.kind !== "request") return;
          coordinatorCall(msg.method, msg.args).then(
            (value) =>
              emit({
                kind: "reply",
                requestId: msg.requestId,
                outcome: { status: "ok", value },
              }),
            (error) =>
              emit({
                kind: "reply",
                requestId: msg.requestId,
                outcome: {
                  status: "failed",
                  failure: {
                    code: "local/unavailable",
                    message: error.message,
                  },
                },
              }),
          );
        },
      };
      return {
        request() {
          onPort(port);
        },
        dispose: noop,
      };
    },
  };
  workspaceSync = createWorkspaceSync({
    getState: () => state,
    applyRemote(remote) {
      applyInPlace(state, remote);
      save(stateKey, state);
      event("agents", {
        agents: state.agents,
        activeAgentId: state.selectedAgentId ?? state.mainAgentId,
      });
      rosterChanged();
      for (const [agentId, automations] of Object.entries(state.automations))
        event("agents-automation", { agentId, automations });
      for (const agentId of Object.keys(state.workflows))
        event("agents-workflow", {
          agentId,
          workflows: state.workflows[agentId],
        });
      for (const agentId of Object.keys(state.persistence.tasks ?? {}))
        event("agents-tasks", { agentId });
      if (state.selectedAgentId) snapshot(state.selectedAgentId);
    },
    onError() {
      log("workspace-sync-error", { message: "保存失败" });
    },
  });
  workspaceSync.start();
  document.addEventListener("DOMContentLoaded", () => {
    document.title = config.appName;
    const connections = document.createElement("a");
    connections.href = "/connections";
    connections.className = "nival-connections";
    connections.textContent = "Notion 与日历";
    connections.title = "Notion 与日历";
    document.body.appendChild(connections);
  });
})();
