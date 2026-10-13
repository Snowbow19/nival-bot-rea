const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const copy = (x) => (x === undefined ? undefined : structuredClone(x));
export function mergeWorkspace(base, local, remote) {
  if (same(local, base)) return copy(remote);
  if (same(remote, base) || remote === undefined) return copy(local);
  if (Array.isArray(local) && Array.isArray(remote) && Array.isArray(base)) {
    const all = [...base, ...local, ...remote];
    if (all.length && all.every((x) => object(x) && typeof x.id === "string")) {
      const b = new Map(base.map((x) => [x.id, x])),
        l = new Map(local.map((x) => [x.id, x])),
        r = new Map(remote.map((x) => [x.id, x]));
      const ids = [
        ...new Set([...local.map((x) => x.id), ...remote.map((x) => x.id)]),
      ];
      return ids
        .filter(
          (id) =>
            !(
              b.has(id) &&
              (!l.has(id) || (!r.has(id) && same(l.get(id), b.get(id))))
            ),
        )
        .map((id) =>
          mergeWorkspace(b.get(id), l.get(id) ?? r.get(id), r.get(id)),
        )
        .filter((x) => x !== undefined);
    }
    return copy(local);
  }
  if (object(local) && object(remote)) {
    const out = {};
    for (const key of new Set([
      ...Object.keys(base ?? {}),
      ...Object.keys(local),
      ...Object.keys(remote),
    ])) {
      if (Object.hasOwn(base ?? {}, key) && !Object.hasOwn(local, key))
        continue;
      const value = mergeWorkspace(
        base?.[key],
        Object.hasOwn(local, key) ? local[key] : remote[key],
        remote[key],
      );
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  return copy(local);
}
export function applyInPlace(target, source) {
  if (Array.isArray(target) && Array.isArray(source)) {
    const keyed = new Map(
      target.filter((x) => object(x) && x.id).map((x) => [x.id, x]),
    );
    const values = source.map((x) => {
      const old = object(x) && x.id ? keyed.get(x.id) : undefined;
      return old ? applyInPlace(old, x) : copy(x);
    });
    target.splice(0, target.length, ...values);
    return target;
  }
  if (object(target) && object(source)) {
    for (const key of Object.keys(target))
      if (!Object.hasOwn(source, key)) delete target[key];
    for (const [key, value] of Object.entries(source)) {
      target[key] =
        (Array.isArray(value) && Array.isArray(target[key])) ||
        (object(value) && object(target[key]))
          ? applyInPlace(target[key], value)
          : copy(value);
    }
    return target;
  }
  return copy(source);
}
export function createWorkspaceSync({ getState, applyRemote, onError }) {
  let base = null,
    version = 0,
    flight = null,
    timer = null,
    ready = false;
  try {
    base = JSON.parse(localStorage.getItem("nival-bot.sync-base.v1"));
  } catch {}
  const remember = (snapshot) => {
    base = copy(snapshot.state);
    version = snapshot.version;
    try {
      localStorage.setItem("nival-bot.sync-base.v1", JSON.stringify(base));
    } catch {}
  };
  const request = async (url, options) => {
    const r = await fetch(url, options);
    if (!r.ok) throw new Error("工作空间保存失败");
    return r.json();
  };
  async function push() {
    if (flight) return flight;
    flight = (async () => {
      if (!ready) {
        const snapshot = await request("/api/workspace");
        if (snapshot.state) {
          const merged = base
            ? mergeWorkspace(base, getState(), snapshot.state)
            : snapshot.state;
          applyRemote(merged);
          remember(snapshot);
        }
        ready = true;
      }
      let rounds = 0;
      while (!same(base, getState()) && rounds++ < 6) {
        const sent = copy(getState());
        const snapshot = await request("/api/workspace/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base, state: sent }),
        });
        const merged = mergeWorkspace(sent, getState(), snapshot.state);
        remember(snapshot);
        applyRemote(merged);
      }
    })()
      .catch((error) => {
        onError?.(error);
        throw error;
      })
      .finally(() => {
        flight = null;
      });
    return flight;
  }
  async function refresh() {
    if (flight) return flight;
    await push();
    const snapshot = await request("/api/workspace");
    if (snapshot.state && snapshot.version !== version) {
      const merged = mergeWorkspace(base, getState(), snapshot.state);
      remember(snapshot);
      applyRemote(merged);
    }
  }
  return {
    flush: push,
    refresh,
    schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => push().catch(() => {}), 180);
    },
    start() {
      push().catch(() => {});
      const poll = setInterval(() => refresh().catch(() => {}), 1800);
      return () => {
        clearInterval(poll);
        clearTimeout(timer);
      };
    },
  };
}
