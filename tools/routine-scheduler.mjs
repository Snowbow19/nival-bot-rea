import { randomUUID } from "node:crypto";

const readSchedule = (routine) => {
  const s = routine.localSchedule ?? routine.schedule;
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  if (
    s.type === "interval" &&
    Number.isInteger(s.minutes) &&
    s.minutes >= 1 &&
    s.minutes <= 525600
  )
    return s;
  if (
    s.type === "once" &&
    typeof s.at === "string" &&
    Number.isFinite(Date.parse(s.at))
  )
    return s;
  if (s.type === "daily" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time ?? "")) {
    try {
      new Intl.DateTimeFormat("en", {
        timeZone: s.timeZone ?? "Asia/Shanghai",
      });
      return s;
    } catch {
      return null;
    }
  }
  return null;
};
export function nextRoutineRun(schedule, after = Date.now()) {
  if (schedule.type === "once") return Date.parse(schedule.at);
  if (schedule.type === "interval") return after + schedule.minutes * 60000;
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone: schedule.timeZone ?? "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  // Iterate UTC minutes so DST gaps and duplicate local times are handled by Intl.
  const start = Math.floor(after / 60000) * 60000 + 60000;
  for (let at = start; at < start + 72 * 3600000; at += 60000) {
    if (format.format(at) === schedule.time) return at;
  }
  throw new Error("Unable to calculate daily schedule");
}
export function createRoutineScheduler({
  store,
  execute,
  isBusy = () => false,
  onChange = async () => {},
}) {
  const active = new Map();
  let timer = null;
  let stopping = false;
  let ticking = null;
  let starting = null;
  const notify = async () => {
    try {
      await onChange();
    } catch {}
  };
  const find = (state, agentId, routineId) =>
    state?.automations?.[agentId]?.find((r) => r.id === routineId);
  async function run(agentId, routineId, trigger) {
    if (stopping)
      return {
        success: false,
        error: { code: "STOPPED", message: "Scheduler is stopped" },
      };
    if (active.has(agentId) || isBusy(agentId))
      return {
        success: false,
        error: {
          code: "BUSY",
          message: "This Bot already has a routine running",
        },
      };
    const controller = new AbortController();
    const marker = { controller, promise: null };
    active.set(agentId, marker);
    const job = (async () => {
      let runId;
      try {
        const now = Date.now();
        const claim = await store.update((state) => {
          const routine = find(state, agentId, routineId);
          if (!routine)
            throw Object.assign(new Error("Routine not found"), {
              code: "NOT_FOUND",
            });
          if (!state.agents.some((a) => a.id === agentId && !a.archived))
            throw Object.assign(new Error("Bot unavailable"), {
              code: "BOT_UNAVAILABLE",
            });
          if (typeof routine.prompt !== "string" || !routine.prompt.trim())
            throw new Error("Routine has no prompt");
          if ((routine.runs ?? []).some((r) => r.status === "running"))
            throw Object.assign(new Error("Routine is already running"), {
              code: "BUSY",
            });
          const schedule = readSchedule(routine);
          if (
            trigger === "schedule" &&
            (!routine.isEnabled ||
              !schedule ||
              !Number.isFinite(routine.nextRunAt) ||
              routine.nextRunAt > now)
          )
            throw Object.assign(new Error("Routine is no longer due"), {
              code: "NOT_DUE",
            });
          runId = randomUUID();
          const record = {
            id: runId,
            trigger,
            status: "running",
            startedAt: now,
            startedAtMs: now,
            createdAt: now,
            summary: "",
          };
          routine.runs ??= [];
          routine.runs.unshift(record);
          if (trigger === "schedule") {
            if (schedule.type === "once") {
              routine.isEnabled = false;
              routine.nextRunAt = null;
            } else routine.nextRunAt = nextRoutineRun(schedule, now);
          }
          routine.updatedAt = now;
          return { prompt: routine.prompt };
        });
        await notify();
        controller.signal.throwIfAborted();
        const value = await execute({
          agentId,
          prompt: claim.result.prompt,
          routineId,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        if (value?.success === false)
          throw new Error(
            value.error?.message ?? value.error ?? "Routine execution failed",
          );
        const summary = (
          typeof value === "string"
            ? value
            : (value?.summary ?? value?.content ?? value?.text ?? "执行完成")
        ).slice(0, 1000);
        await finish(agentId, routineId, runId, "completed", summary);
        return { success: true, runId, summary };
      } catch (error) {
        if (runId)
          await finish(
            agentId,
            routineId,
            runId,
            "failed",
            controller.signal.aborted || error.code === "INTERRUPTED"
              ? "执行已中断"
              : String(error.message).slice(0, 500),
            controller.signal.aborted || error.code === "INTERRUPTED",
          ).catch(() => {});
        return {
          success: false,
          runId,
          error: {
            code: controller.signal.aborted
              ? "INTERRUPTED"
              : (error.code ?? "EXECUTION_FAILED"),
            message: controller.signal.aborted
              ? "Execution interrupted"
              : error.message,
          },
        };
      } finally {
        active.delete(agentId);
      }
    })();
    marker.promise = job;
    return job;
  }
  async function finish(
    agentId,
    routineId,
    runId,
    status,
    summary,
    interrupted = false,
  ) {
    await store.update((state) => {
      const routine = find(state, agentId, routineId);
      const record = routine?.runs?.find((r) => r.id === runId);
      if (!record) return;
      const now = Date.now();
      Object.assign(record, {
        status,
        summary,
        interrupted,
        finishedAt: now,
        finishedAtMs: now,
        completedAt: now,
        durationMs: Math.max(0, now - record.startedAtMs),
      });
      routine.updatedAt = now;
    });
    await notify();
  }
  async function processTick() {
    if (stopping) return;
    let snapshot = await store.read();
    if (!snapshot.state) return;
    const missing = Object.values(snapshot.state.automations)
      .flat()
      .some(
        (r) => r.isEnabled && readSchedule(r) && !Number.isFinite(r.nextRunAt),
      );
    if (missing) {
      await store.update((state) => {
        for (const rows of Object.values(state.automations))
          for (const routine of rows) {
            const schedule = readSchedule(routine);
            if (
              routine.isEnabled &&
              schedule &&
              !Number.isFinite(routine.nextRunAt)
            )
              routine.nextRunAt = nextRoutineRun(schedule, Date.now());
          }
      });
      await notify();
      snapshot = await store.read();
    }
    const jobs = [];
    for (const [agentId, rows] of Object.entries(snapshot.state.automations)) {
      for (const routine of rows) {
        if (
          routine.isEnabled &&
          readSchedule(routine) &&
          Number.isFinite(routine.nextRunAt) &&
          routine.nextRunAt <= Date.now() &&
          !active.has(agentId) &&
          !isBusy(agentId)
        )
          jobs.push(run(agentId, routine.id, "schedule"));
      }
    }
    for (const job of jobs) job.catch(() => {});
  }
  function tick() {
    if (!ticking)
      ticking = processTick().finally(() => {
        ticking = null;
      });
    return ticking;
  }
  async function start() {
    if (timer) return;
    if (starting) return starting;
    starting = (async () => {
      stopping = false;
      const snapshot = await store.read();
      const interrupted = Object.values(snapshot.state?.automations ?? {})
        .flat()
        .some((r) => r.runs?.some((run) => run.status === "running"));
      if (interrupted) {
        await store.update((state) => {
          for (const rows of Object.values(state.automations))
            for (const routine of rows)
              for (const run of routine.runs ?? []) {
                if (run.status === "running")
                  Object.assign(run, {
                    status: "failed",
                    interrupted: true,
                    summary: "服务停止，执行已中断",
                    finishedAt: Date.now(),
                    finishedAtMs: Date.now(),
                    completedAt: Date.now(),
                  });
              }
        });
        await notify();
      }
      if (stopping) return;
      timer = setInterval(() => {
        tick().catch(() => {});
      }, 1000);
      timer.unref?.();
      tick().catch(() => {});
    })().finally(() => {
      starting = null;
    });
    return starting;
  }
  async function stop() {
    stopping = true;
    if (timer) clearInterval(timer);
    timer = null;
    const jobs = [...active.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map((job) => job.promise));
  }
  return {
    start,
    stop,
    runNow: (agentId, routineId) => run(agentId, routineId, "manual"),
    tick,
  };
}
