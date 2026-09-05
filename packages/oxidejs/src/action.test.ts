import { expect, test } from "bun:test";

import {
  action,
  ACTION_CALL,
  brandServerAction,
  wrapClientRpc,
} from "./action";

interface ActionCallPayload {
  a: unknown[];
  k: string;
}

interface ActionCallCarrier {
  [ACTION_CALL]?: ActionCallPayload;
}

const actionCall = function actionCall(handler: ActionCallCarrier) {
  return handler[ACTION_CALL];
};

test("action wraps Atom.fn with set, bind, and invoke", async () => {
  const ping = action(() => "pong");
  expect(ping.$$atom).toBe(1);
  expect(await ping.set()).toBe("pong");
  expect(await ping()).toBe("pong");

  const branded = brandServerAction(
    "x:echo",
    action((value: string) => value)
  ).bind("hi");
  // SAFETY: bind attaches ACTION_CALL for ilha server-island capture.
  expect(actionCall(branded as ActionCallCarrier)).toEqual({
    a: ["hi"],
    k: "x:echo",
  });
});

test("wrapClientRpc zero-arg call invokes RPC (does not read the atom)", async () => {
  const calls: unknown[][] = [];
  const ping = wrapClientRpc((...args: []) => {
    calls.push(args);
    return Promise.resolve("pong");
  });
  expect(await ping()).toBe("pong");
  expect(calls).toEqual([[]]);
  expect(ping.result).toBeDefined();
});

test("wrapClientRpc rest stubs preserve argument lists on call and set", async () => {
  const calls: unknown[][] = [];
  const echo = wrapClientRpc((...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve(args);
  });
  expect(await echo("a")).toEqual(["a"]);
  expect(await echo("a", "b")).toEqual(["a", "b"]);
  expect(await echo.set(["x", "y"])).toEqual([["x", "y"]]);
  expect(calls).toEqual([["a"], ["a", "b"], [["x", "y"]]]);
});

test("with is an alias for bind", () => {
  const echo = brandServerAction(
    "x:echo",
    action((value: string) => value)
  );
  // SAFETY: with attaches ACTION_CALL payload for ilha capture.
  const viaWith = actionCall(echo.with("hi") as ActionCallCarrier);
  // SAFETY: bind attaches ACTION_CALL payload for ilha capture.
  const viaBind = actionCall(echo.bind("hi") as ActionCallCarrier);
  expect(viaWith).toEqual({ a: ["hi"], k: "x:echo" });
  expect(viaBind).toEqual({ a: ["hi"], k: "x:echo" });
});

test("stream actions return async generators", async () => {
  const ticks = action(async function* ticks() {
    yield 0;
    yield 1;
  });
  const gen = ticks();
  const first = await gen.next();
  expect(first.value).toBe(0);
  const second = await gen.next();
  expect(second.value).toBe(1);
  expect(() => ticks.bind()).toThrow("stream actions cannot be bound");
});
