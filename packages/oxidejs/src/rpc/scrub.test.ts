import { expect, test } from "bun:test";

import {
  extractJsonRpcRequestId,
  extractJsonRpcRequestIds,
  scrubNdjsonTransform,
  scrubRpcJson,
} from "./scrub";

test("scrubRpcJson strips Defect and restores request id", () => {
  const raw = JSON.stringify({
    jsonrpc: "2.0",
    id: -32603,
    error: {
      _tag: "Defect",
      code: 1,
      message: "A defect occurred",
      data: { name: "Error", message: "secret" },
    },
  });
  expect(JSON.parse(scrubRpcJson(raw, [42]))).toEqual({
    jsonrpc: "2.0",
    id: 42,
    error: { code: -32603, message: "Internal error" },
  });
});

test("scrubRpcJson maps Cause unknown-method and invalid-params", () => {
  expect(
    JSON.parse(
      scrubRpcJson(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            _tag: "Cause",
            message: '[{"_tag":"Die","defect":"Unknown request tag: x"}]',
            data: [{ _tag: "Die", defect: "Unknown request tag: x" }],
          },
        }),
      ),
    ),
  ).toEqual({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32601, message: "Method not found" },
  });

  expect(
    JSON.parse(
      scrubRpcJson(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { _tag: "Cause", message: 'Missing key\n  at ["args"]', data: [] },
        }),
      ),
    ),
  ).toEqual({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32602, message: "Invalid params" },
  });

  expect(
    JSON.parse(
      scrubRpcJson(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            _tag: "Cause",
            message: '[{"_tag":"Die","defect":"Expected never\\n  at [\\"cause\\"]"}]',
            data: [],
          },
        }),
      ),
    ),
  ).toEqual({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32603, message: "Internal error" },
  });

  expect(
    JSON.parse(
      scrubRpcJson(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            _tag: "Cause",
            message: '[{"_tag":"Interrupt"}]',
            data: [{ _tag: "Interrupt" }],
          },
        }),
      ),
    ),
  ).toEqual({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32603, message: "Internal error" },
  });
});

test("scrubRpcJson keeps plain Forbidden errors (no data)", () => {
  expect(
    JSON.parse(
      scrubRpcJson(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Forbidden", data: { sneak: true } },
        }),
      ),
    ),
  ).toEqual({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "Forbidden" },
  });
});

test("scrubRpcJson rewrites each NDJSON frame independently", () => {
  const raw =
    JSON.stringify({
      jsonrpc: "2.0",
      chunk: true,
      id: 1,
      result: [0],
    }) +
    "\n" +
    JSON.stringify({
      jsonrpc: "2.0",
      id: -32603,
      error: { _tag: "Defect", data: { message: "secret" } },
    }) +
    "\n";
  expect(scrubRpcJson(raw, [1])).toBe(
    '{"jsonrpc":"2.0","chunk":true,"id":1,"result":[0]}\n' +
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"Internal error"}}\n',
  );
});

test("scrubNdjsonTransform flushes frames without waiting for the stream end", async () => {
  const transform = scrubNdjsonTransform([9]);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          JSON.stringify({
            jsonrpc: "2.0",
            id: -32603,
            error: { _tag: "Defect", data: { message: "secret" } },
          }) + "\n",
        ),
      );
      // Leave the stream open briefly so flush is not required for the first frame.
    },
  });

  const reader = input.pipeThrough(transform).getReader();
  const { value } = await reader.read();
  expect(decoder.decode(value)).toBe(
    '{"jsonrpc":"2.0","id":9,"error":{"code":-32603,"message":"Internal error"}}\n',
  );
  await reader.cancel();
});

test("scrubNdjsonTransform reassembles a line split across multi-byte UTF-8", async () => {
  const transform = scrubNdjsonTransform([3]);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const line =
    JSON.stringify({
      jsonrpc: "2.0",
      id: -32603,
      error: { _tag: "Defect", data: { message: "sécret-café" } },
    }) + "\n";
  const bytes = encoder.encode(line);
  // Split inside the multi-byte UTF-8 sequence for é (C3 A9).
  const é = bytes.indexOf(0xc3);
  expect(é).toBeGreaterThan(0);
  const mid = é + 1;

  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, mid));
      controller.enqueue(bytes.subarray(mid));
      controller.close();
    },
  });

  const reader = input.pipeThrough(transform).getReader();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  expect(out).toBe('{"jsonrpc":"2.0","id":3,"error":{"code":-32603,"message":"Internal error"}}\n');
  expect(out).not.toContain("sécret");
});

test("scrubRpcJson repairs distinct Defect ids for multi-request batches", () => {
  const batch = JSON.stringify([
    {
      jsonrpc: "2.0",
      id: -32603,
      error: { _tag: "Defect", data: { message: "first" } },
    },
    {
      jsonrpc: "2.0",
      id: -32603,
      error: { _tag: "Defect", data: { message: "second" } },
    },
  ]);
  expect(JSON.parse(scrubRpcJson(batch, [10, 20]))).toEqual([
    { jsonrpc: "2.0", id: 10, error: { code: -32603, message: "Internal error" } },
    { jsonrpc: "2.0", id: 20, error: { code: -32603, message: "Internal error" } },
  ]);

  const ndjson =
    JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      result: "ok",
    }) +
    "\n" +
    JSON.stringify({
      jsonrpc: "2.0",
      id: -32603,
      error: { _tag: "Defect", data: { message: "boom" } },
    }) +
    "\n";
  expect(scrubRpcJson(ndjson, [10, 20])).toBe(
    '{"jsonrpc":"2.0","id":10,"result":"ok"}\n' +
      '{"jsonrpc":"2.0","id":20,"error":{"code":-32603,"message":"Internal error"}}\n',
  );
});

test("extractJsonRpcRequestIds reads unary, batch array, and NDJSON ids", () => {
  expect(extractJsonRpcRequestId('{"jsonrpc":"2.0","id":7,"method":"x"}')).toBe(7);
  expect(
    extractJsonRpcRequestIds(
      '[{"jsonrpc":"2.0","id":3,"method":"a"},{"jsonrpc":"2.0","id":4,"method":"b"}]',
    ),
  ).toEqual([3, 4]);
  expect(
    extractJsonRpcRequestIds(
      '{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n',
    ),
  ).toEqual([1, 2]);
});
