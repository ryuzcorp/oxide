/* eslint-disable func-names -- Effect.gen uses anonymous generators (AGENTS.md) */
import { describe, expect, test } from "bun:test";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { action, readActionMeta } from "./action";
import { runWithRequest } from "./context";
import { OxideCtx, OxideRequest } from "./services";
import { withSchema } from "./with-schema";

describe("action Effect surface", () => {
  test("stamps payload meta from action options and withSchema", () => {
    const Payload = Schema.Struct({ text: Schema.String });
    const viaOpts = action(() => null, { payload: Payload });
    expect(readActionMeta(viaOpts).payload).toBe(Payload);

    const viaSugar = action(withSchema(Payload, (p) => p));
    expect(readActionMeta(viaSugar).payload).toBe(Payload);
  });

  test("runs Effect handlers and resolves the success value", async () => {
    const ping = action(() => Effect.succeed("pong"));
    await expect(ping()).resolves.toBe("pong");
  });

  test("Effect handlers can read OxideRequest / OxideCtx", async () => {
    const who = action(() =>
      Effect.gen(function* () {
        const req = yield* OxideRequest;
        const ctx = yield* OxideCtx;
        return { hasReq: ctx.req === req, path: new URL(req.url).pathname };
      })
    );
    const result = await runWithRequest(
      new Request("http://localhost/who"),
      () => who()
    );
    expect(result).toEqual({ hasReq: true, path: "/who" });
  });

  test("marks async generators and Stream actions as stream meta", async () => {
    const ticks = action(async function* () {
      yield 1;
    });
    expect(readActionMeta(ticks).stream).toBe(true);

    const streamed = action(() => Stream.fromIterable([1, 2]), {
      stream: true,
    });
    expect(readActionMeta(streamed).stream).toBe(true);
    const values: number[] = [];
    for await (const n of streamed()) {
      // SAFETY: stream yields numbers from fromIterable([1, 2]).
      values.push(n as number);
    }
    expect(values).toEqual([1, 2]);
  });

  test("error schema is stamped for Rpc codegen", () => {
    // oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory, not a throw
    class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
      id: Schema.String,
    }) {}
    const get = action(() => null, { error: NotFound });
    expect(readActionMeta(get).error).toBe(NotFound);
  });
});
