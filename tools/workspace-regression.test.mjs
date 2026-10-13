import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspaceStore } from "./workspace-store.mjs";
import { executeWorkspaceTool } from "./workspace-actions.mjs";
import { createRoutineScheduler } from "./routine-scheduler.mjs";
import { mergeWorkspace } from "../src/workspace-sync.js";
import { scheduleFromSpec } from "../src/routine-schedule.js";

test("Browser edits preserve backend-created Bots and backend deletion of untouched Bots", () => {
  const base = {
    agents: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
  };
  const local = structuredClone(base);
  local.agents[0].name = "renamed";
  const remote = {
    agents: [
      { id: "a", name: "A" },
      { id: "c", name: "C" },
    ],
  };
  assert.deepEqual(mergeWorkspace(base, local, remote).agents, [
    { id: "a", name: "renamed" },
    { id: "c", name: "C" },
  ]);
});
test("One-off delay keeps native display contract and executes only once", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nival-routine-"));
  const store = createWorkspaceStore({
    filePath: path.join(dir, "workspace.json"),
  });
  let runs = 0;
  let complete;
  const finished = new Promise((resolve) => {
    complete = resolve;
  });
  const scheduler = createRoutineScheduler({
    store,
    execute: async () => {
      runs++;
      return { summary: "done" };
    },
    onChange: async () => {
      const s = await store.read();
      if (s.state.automations.a?.[0]?.runs[0]?.status === "completed")
        complete();
    },
  });
  try {
    await store.replace({ agents: [{ id: "a", name: "A" }] });
    const result = await executeWorkspaceTool(
      "create_routine",
      {
        name: "once",
        prompt: "reply",
        schedule: { type: "once", afterSeconds: 15 },
      },
      { store, agentId: "a" },
    );
    assert.equal(result.success, true);
    const row = (await store.read()).state.automations.a[0];
    await executeWorkspaceTool(
      "update_routine",
      { routineId: row.id, schedule: { type: "once", afterSeconds: 30 } },
      { store, agentId: "a" },
    );
    const updated = (await store.read()).state.automations.a[0];
    assert.equal(updated.schedule, updated.localSchedule.at);
    assert.equal(typeof updated.schedule, "string");
    await store.update((s) => {
      const r = s.automations.a[0];
      r.localSchedule.at = new Date(Date.now() - 1000).toISOString();
      r.nextRunAt = Date.now() - 1000;
    });
    await scheduler.tick();
    await Promise.race([
      finished,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("routine timeout")),
          2000,
        );
        timer.unref();
      }),
    ]);
    await scheduler.tick();
    const done = (await store.read()).state.automations.a[0];
    assert.equal(runs, 1);
    assert.equal(done.runs.length, 1);
    assert.equal(done.isEnabled, false);
    assert.equal(done.runs[0].status, "completed");
  } finally {
    await scheduler.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("Native schedule editing supports daily/once and rejects unsupported triggers", () => {
  assert.deepEqual(scheduleFromSpec({ schedule: "5 9 * * *" }), {
    type: "daily",
    time: "09:05",
    timeZone: "Asia/Shanghai",
  });
  assert.throws(() =>
    scheduleFromSpec({ schedule: "* * * * *", trigger: { type: "webhook" } }),
  );
});
