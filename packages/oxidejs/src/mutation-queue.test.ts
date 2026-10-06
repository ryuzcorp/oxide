import { describe, expect, test } from "bun:test";

import type {
  MutationQueue,
  MutationQueueStorage,
  PersistedMutation,
} from "./mutation-queue";
import { createMutationQueue, indexedDbStorage } from "./mutation-queue";

type FakeListener = () => void;

const fakeEvents = function fakeEvents() {
  const listeners = new Map<string, FakeListener[]>();
  return {
    addEventListener(type: string, listener: FakeListener) {
      const current = listeners.get(type);
      if (current) {
        current.push(listener);
      } else {
        listeners.set(type, [listener]);
      }
    },
    emit(type: string) {
      for (const listener of listeners.get(type) ?? []) {
        listener();
      }
    },
  };
};

interface FakeIdbRequest<T> {
  addEventListener: (type: string, listener: FakeListener) => void;
  error: Error | null;
  result: T | undefined;
}

const fakeRequest = function fakeRequest<T>(run: () => T): FakeIdbRequest<T> {
  const events = fakeEvents();
  const request: FakeIdbRequest<T> = {
    addEventListener: events.addEventListener,
    error: null,
    result: undefined,
  };
  queueMicrotask(() => {
    request.result = run();
    events.emit("success");
  });
  return request;
};

const fakeObjectStore = function fakeObjectStore(
  records: Map<string, PersistedMutation>,
  complete: () => void
) {
  return {
    delete: (id: string) =>
      fakeRequest(() => {
        records.delete(id);
        queueMicrotask(complete);
      }),
    getAll: () => fakeRequest(() => [...records.values()]),
    put: (value: PersistedMutation) =>
      fakeRequest(() => {
        records.set(value.id, value);
        queueMicrotask(complete);
      }),
  };
};

/** Resolves on the next queue event of `type` — no wall-clock waiting. */
const eventOf = function eventOf(queue: MutationQueue, type: string) {
  // oxlint-disable-next-line promise/avoid-new -- test signal
  return new Promise<void>((resolve) => {
    const off = queue.subscribe((event) => {
      if (event.type === type) {
        off();
        resolve();
      }
    });
  });
};

interface FakeStorage {
  deletes: string[];
  entries: Map<string, PersistedMutation>;
  releaseLoad: () => void;
  storage: MutationQueueStorage;
  whenPut: (id: string) => Promise<void>;
}

/**
 * Recording storage adapter: the shape a real adapter must implement.
 * `holdLoad` parks `load` until `releaseLoad`, so a test can enqueue before
 * persisted writes land.
 */
const fakeStorage = function fakeStorage(
  seed: PersistedMutation[] = [],
  holdLoad = false
): FakeStorage {
  const entries = new Map<string, PersistedMutation>(
    seed.map((entry) => [entry.id, entry])
  );
  const deletes: string[] = [];
  const puts = new Set<string>();
  const waiters = new Map<string, () => void>();
  let release: (() => void) | undefined;
  // oxlint-disable-next-line promise/avoid-new -- test signal
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const storage: MutationQueueStorage = {
    delete: (id) => {
      deletes.push(id);
      entries.delete(id);
      return Promise.resolve();
    },
    load: async () => {
      if (holdLoad) {
        await gate;
      }
      return [...entries.values()];
    },
    put: (entry) => {
      entries.set(entry.id, entry);
      puts.add(entry.id);
      waiters.get(entry.id)?.();
      waiters.delete(entry.id);
      return Promise.resolve();
    },
  };
  const whenPut = async function whenPut(id: string): Promise<void> {
    if (puts.has(id)) {
      return;
    }
    // oxlint-disable-next-line promise/avoid-new -- test signal
    await new Promise<void>((resolve) => {
      waiters.set(id, resolve);
    });
  };
  return {
    deletes,
    entries,
    releaseLoad: () => release?.(),
    storage,
    whenPut,
  };
};

/** Minimal IndexedDB surface that `indexedDbStorage` talks to. */
const installFakeIndexedDb = function installFakeIndexedDb() {
  const stores = new Map<string, Map<string, PersistedMutation>>();

  const recordsFor = function recordsFor(name: string) {
    const existing = stores.get(name);
    if (existing) {
      return existing;
    }
    const records = new Map<string, PersistedMutation>();
    stores.set(name, records);
    return records;
  };

  const fakeTransaction = function fakeTransaction(name: string) {
    const events = fakeEvents();
    return {
      addEventListener: events.addEventListener,
      error: null,
      objectStore: () =>
        fakeObjectStore(recordsFor(name), () => {
          events.emit("complete");
        }),
    };
  };

  const database = {
    createObjectStore: (name: string) => {
      recordsFor(name);
    },
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    transaction: (name: string) => fakeTransaction(name),
  };

  return {
    open: () => {
      const events = fakeEvents();
      const request: FakeIdbRequest<typeof database> = {
        addEventListener: events.addEventListener,
        error: null,
        result: database,
      };
      queueMicrotask(() => {
        events.emit("upgradeneeded");
        queueMicrotask(() => {
          events.emit("success");
        });
      });
      return request;
    },
  };
};

const withFakeIndexedDb = async function withFakeIndexedDb(
  run: () => Promise<void>
) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: installFakeIndexedDb(),
    writable: true,
  });
  try {
    await run();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "indexedDB", previous);
    } else {
      Reflect.deleteProperty(globalThis, "indexedDB");
    }
  }
};

const persisted = function persisted(
  overrides: Partial<PersistedMutation> = {}
): PersistedMutation {
  return {
    args: ["milk"],
    createdAt: 1,
    id: "add:milk",
    key: "tasks.add",
    seq: 1,
    ...overrides,
  };
};

describe("createMutationQueue", () => {
  test("passes through successful calls", async () => {
    const queue = createMutationQueue();
    const add = queue.wrap((n: number) => Promise.resolve(n + 1));
    expect(await add(1)).toBe(2);
    expect(queue.pending).toBe(0);
  });

  test("enqueues on transient failure and resolves on flush", async () => {
    const queue = createMutationQueue();
    let fail = true;
    const add = queue.wrap(
      (text: string) => {
        if (fail) {
          return Promise.reject(new Error("SocketCloseError: 1001"));
        }
        return Promise.resolve(text);
      },
      { idempotencyKey: (text) => `add:${text}` }
    );

    const pending = add("milk");
    await Bun.sleep(10);
    expect(queue.pending).toBe(1);

    fail = false;
    await queue.flush();
    expect(await pending).toBe("milk");
    expect(queue.pending).toBe(0);
  });

  test("coalesces duplicate idempotency keys", async () => {
    const queue = createMutationQueue();
    let calls = 0;
    let fail = true;
    const add = queue.wrap(
      () => {
        calls += 1;
        if (fail) {
          return Promise.reject(new Error("SocketCloseError: 1000"));
        }
        return Promise.resolve(calls);
      },
      { idempotencyKey: () => "once" }
    );

    const a = add();
    const b = add();
    await Bun.sleep(10);
    expect(queue.pending).toBe(1);

    fail = false;
    await queue.flush();
    expect(await Promise.all([a, b])).toEqual([2, 2]);
    expect(calls).toBe(2);
  });

  test("forwards idempotencyKey as CallOptions", async () => {
    const queue = createMutationQueue();
    let seen: string | undefined;
    const add = queue.wrap(
      (text: string, opts?: { idempotencyKey?: string }) => {
        seen = opts?.idempotencyKey;
        return Promise.resolve(text);
      },
      { idempotencyKey: (text) => `add:${text}` }
    );
    expect(await add("milk")).toBe("milk");
    expect(seen).toBe("add:milk");
  });

  test("flush retries transient failures with Schedule", async () => {
    const queue = createMutationQueue({
      retries: 3,
      retryBase: "1 millis",
    });
    let attempts = 0;
    const add = queue.wrap(() => {
      attempts += 1;
      if (attempts < 3) {
        return Promise.reject(new Error("SocketCloseError: 1006"));
      }
      return Promise.resolve("ok");
    });

    const pending = add();
    await Bun.sleep(5);
    expect(queue.pending).toBe(1);

    await queue.flush();
    expect(await pending).toBe("ok");
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(queue.pending).toBe(0);
  });
});

describe("createMutationQueue storage", () => {
  test("persists a failed write and deletes it after a successful flush", async () => {
    const { entries, storage, whenPut } = fakeStorage();
    const queue = createMutationQueue({ retries: 0, storage });
    let fail = true;
    const add = queue.wrap(
      (text: string) => {
        if (fail) {
          return Promise.reject(new Error("SocketCloseError: 1001"));
        }
        return Promise.resolve(text);
      },
      { idempotencyKey: (text) => `add:${text}`, key: "tasks.add" }
    );

    const pending = add("milk");
    await whenPut("add:milk");
    expect(queue.pending).toBe(1);
    const entry = entries.get("add:milk");
    expect(entry?.args).toEqual(["milk"]);
    expect(entry?.key).toBe("tasks.add");
    expect(entry?.seq).toBeGreaterThan(0);

    fail = false;
    await queue.flush();
    expect(await pending).toBe("milk");
    expect(queue.pending).toBe(0);
    expect(entries.size).toBe(0);
  });

  test("restores persisted writes in FIFO order once the action is wrapped", async () => {
    const { entries, storage, whenPut } = fakeStorage();
    const first = createMutationQueue({ retries: 0, storage });
    const firstAdd = first.wrap(
      (text: string) =>
        Promise.reject<string>(new Error(`SocketCloseError: 1001 ${text}`)),
      { idempotencyKey: (text) => `add:${text}`, key: "tasks.add" }
    );
    void firstAdd("milk");
    await whenPut("add:milk");
    void firstAdd("eggs");
    await whenPut("add:eggs");
    expect([...entries.keys()]).toEqual(["add:milk", "add:eggs"]);

    const events: string[] = [];
    const calls: [string, string | undefined][] = [];
    const second = createMutationQueue({ storage });
    second.subscribe((event) => events.push(event.type));
    second.wrap(
      (text: string, opts?: { idempotencyKey?: string }) => {
        calls.push([text, opts?.idempotencyKey]);
        return Promise.resolve(text);
      },
      { key: "tasks.add" }
    );

    await second.ready;
    expect(second.pending).toBe(2);
    expect(events).toContain("restore");
    await second.flush();
    expect(calls).toEqual([
      ["milk", "add:milk"],
      ["eggs", "add:eggs"],
    ]);
    expect(events.filter((type) => type === "success")).toHaveLength(2);
    expect(second.pending).toBe(0);
    expect(entries.size).toBe(0);
  });

  test("keeps restored writes ahead of writes enqueued during the load", async () => {
    const { entries, releaseLoad, storage, whenPut } = fakeStorage(
      [persisted()],
      true
    );
    const queue = createMutationQueue({ retries: 0, storage });
    const calls: string[] = [];
    let fail = true;
    const add = queue.wrap(
      (text: string) => {
        if (fail) {
          return Promise.reject<string>(new Error("SocketCloseError: 1006"));
        }
        calls.push(text);
        return Promise.resolve(text);
      },
      { idempotencyKey: (text) => `add:${text}`, key: "tasks.add" }
    );

    const enqueued = eventOf(queue, "enqueue");
    const bread = add("bread");
    await enqueued;
    await whenPut("add:bread");

    fail = false;
    releaseLoad();
    await queue.ready;
    expect(await bread).toBe("bread");
    expect(calls).toEqual(["milk", "bread"]);
    expect(queue.pending).toBe(0);
    expect(entries.size).toBe(0);
  });

  test("runs a restored write when its action is wrapped after the load", async () => {
    const { entries, storage } = fakeStorage([persisted()]);
    const queue = createMutationQueue({ storage });
    await queue.ready;
    expect(queue.pending).toBe(1);

    const calls: string[] = [];
    queue.wrap(
      (text: string) => {
        calls.push(text);
        return Promise.resolve(text);
      },
      { key: "tasks.add" }
    );

    await queue.flush();
    expect(calls).toEqual(["milk"]);
    expect(queue.pending).toBe(0);
    expect(entries.size).toBe(0);
  });

  test("falls back to memory when the storage load fails", async () => {
    const events: string[] = [];
    const queue = createMutationQueue({
      storage: {
        delete: () => Promise.resolve(),
        load: () => Promise.reject(new Error("IndexedDB is blocked")),
        put: () => Promise.resolve(),
      },
    });
    queue.subscribe((event) => events.push(event.type));
    await queue.ready;
    expect(events).toContain("error");

    let fail = true;
    const add = queue.wrap(
      (text: string) => {
        if (fail) {
          return Promise.reject<string>(new Error("SocketCloseError: 1001"));
        }
        return Promise.resolve(text);
      },
      { idempotencyKey: () => "add:milk", key: "tasks.add" }
    );
    const enqueued = eventOf(queue, "enqueue");
    const pending = add("milk");
    await enqueued;
    expect(queue.pending).toBe(1);

    fail = false;
    await queue.flush();
    expect(await pending).toBe("milk");
  });

  test("discards a restored write that fails permanently", async () => {
    const { entries, storage } = fakeStorage([persisted()]);
    const queue = createMutationQueue({ retries: 0, storage });
    const events: string[] = [];
    queue.subscribe((event) => events.push(event.type));
    queue.wrap(() => Promise.reject(new Error("bad payload")), {
      key: "tasks.add",
    });

    await queue.ready;
    await queue.flush();
    expect(queue.pending).toBe(0);
    expect(entries.size).toBe(0);
    expect(events).toContain("discard");
    expect(events).not.toContain("success");
  });

  test("rejects non-cloneable args at enqueue when storage is set", async () => {
    const { entries, storage } = fakeStorage();
    const queue = createMutationQueue({ storage });
    const send = queue.wrap(
      (step: () => void) =>
        Promise.reject(new Error(`SocketCloseError: 1001 ${step.name}`)),
      { idempotencyKey: () => "step", key: "tasks.run" }
    );

    await expect(send(() => 0)).rejects.toThrow(/structured-cloneable/u);
    expect(queue.pending).toBe(0);
    expect(entries.size).toBe(0);
  });

  test("requires a stable action key when storage is set", async () => {
    const { storage } = fakeStorage();
    const queue = createMutationQueue({ storage });
    const send = queue.wrap(() =>
      Promise.reject(new Error("SocketCloseError: 1001"))
    );

    await expect(send()).rejects.toThrow(/stable action key/u);
    expect(queue.pending).toBe(0);
  });

  test('storage: "memory" behaves like no storage', async () => {
    const queue = createMutationQueue({ storage: "memory" });
    let fail = true;
    const add = queue.wrap((text: string) => {
      if (fail) {
        return Promise.reject<string>(new Error("SocketCloseError: 1001"));
      }
      return Promise.resolve(text);
    });

    const enqueued = eventOf(queue, "enqueue");
    const pending = add("milk");
    await enqueued;
    expect(queue.pending).toBe(1);

    fail = false;
    await queue.flush();
    expect(await pending).toBe("milk");
  });
});

describe("indexedDbStorage", () => {
  test("throws when IndexedDB is missing", () => {
    expect(() => indexedDbStorage()).toThrow(/IndexedDB/u);
  });

  test("round-trips records through IndexedDB", async () => {
    await withFakeIndexedDb(async () => {
      const storage = indexedDbStorage(`test-${crypto.randomUUID()}`);
      const entry = persisted();
      await storage.put(entry);
      expect(await storage.load()).toEqual([entry]);
      await storage.delete(entry.id);
      expect(await storage.load()).toEqual([]);
    });
  });
});
