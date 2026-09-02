import { expect, test } from "bun:test";

import { action, ACTION_CALL, brandServerAction } from "./action";

test("action wraps Atom.fn with set, bind, and invoke", async () => {
  const ping = action(async () => "pong");
  expect(ping.$$atom).toBe(1);
  expect(await ping.set()).toBe("pong");
  expect(await ping()).toBe("pong");

  const branded = brandServerAction(
    "x:echo",
    action(async (value: string) => value),
  ).bind("hi");
  expect((branded as unknown as Record<symbol, { k: string; a: unknown[] }>)[ACTION_CALL]).toEqual({
    k: "x:echo",
    a: ["hi"],
  });
});

test("with is an alias for bind", () => {
  const echo = action(async (value: string) => value);
  const BRAND = ACTION_CALL;
  const viaWith = echo.with("hi") as unknown as Record<symbol, { k: string; a: unknown[] }>;
  const viaBind = echo.bind("hi") as unknown as Record<symbol, { k: string; a: unknown[] }>;
  expect(viaWith[BRAND]?.a).toEqual(viaBind[BRAND]?.a);
});

test("stream actions return async generators", async () => {
  const ticks = action(async function* () {
    yield 0;
    yield 1;
  });
  const gen = ticks();
  expect((await gen.next()).value).toBe(0);
  expect((await gen.next()).value).toBe(1);
  expect(() => ticks.bind()).toThrow("stream actions cannot be bound");
});
