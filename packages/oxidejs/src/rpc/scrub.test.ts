import { expect, test } from "bun:test";

import {
  extractJsonRpcRequestIds,
  scrubNdjsonTransform,
  scrubRpcJson,
} from "./scrub";

const readAll = async function readAll(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  out = ""
): Promise<string> {
  const { done, value } = await reader.read();
  if (done) {
    return out;
  }
  return readAll(
    reader,
    decoder,
    out + decoder.decode(value, { stream: true })
  );
};

test("scrubRpcJson strips Defect and restores request id", () => {
  const raw = JSON.stringify({
    error: {
      _tag: "Defect",
      code: 1,
      data: { message: "secret", name: "Error" },
      message: "A defect occurred",
    },
    id: -32_603,
    jsonrpc: "2.0",
  });
  expect(JSON.parse(scrubRpcJson(raw, [42]))).toEqual({
    error: { code: -32_603, message: "Internal error" },
    id: 42,
    jsonrpc: "2.0",
  });
});

test("scrubRpcJson maps Cause unknown-method and invalid-params", () => {
  expect(
    JSON.parse(
      scrubRpcJson(
        JSON.stringify({
          error: {
            _tag: "Cause",
            data: [{ _tag: "Die", defect: "Unknown request tag: x" }],
            message: '[{"_tag":"Die","defect":"Unknown request tag: x"}]',
          },
          id: 1,
          jsonrpc: "2.0",
        })
      )
    )
  ).toEqual({
    error: { code: -32_601, message: "Method not found" },
    id: 1,
    jsonrpc: "2.0",
  });

  expect(
    JSON.parse(
      scrubRpcJson(
        JSON.stringify({
          error: {
            _tag: "Cause",
            data: [],
            message: 'Missing key\n  at ["args"]',
          },
          id: 1,
          jsonrpc: "2.0",
        })
      )
    )
  ).toEqual({
    error: { code: -32_602, message: "Invalid params" },
    id: 1,
    jsonrpc: "2.0",
  });

  expect(
    JSON.parse(
      scrubRpcJson(
        JSON.stringify({
          error: {
            _tag: "Cause",
            data: [],
            message:
              '[{"_tag":"Die","defect":"Expected never\\n  at [\\"cause\\"]"}]',
          },
          id: 1,
          jsonrpc: "2.0",
        })
      )
    )
  ).toEqual({
    error: { code: -32_603, message: "Internal error" },
    id: 1,
    jsonrpc: "2.0",
  });

  expect(
    JSON.parse(
      scrubRpcJson(
        JSON.stringify({
          error: {
            _tag: "Cause",
            data: [{ _tag: "Interrupt" }],
            message: '[{"_tag":"Interrupt"}]',
          },
          id: 1,
          jsonrpc: "2.0",
        })
      )
    )
  ).toEqual({
    error: { code: -32_603, message: "Internal error" },
    id: 1,
    jsonrpc: "2.0",
  });
});

test("scrubRpcJson keeps plain Forbidden errors (no data)", () => {
  expect(
    JSON.parse(
      scrubRpcJson(
        JSON.stringify({
          error: { code: -32_600, data: { sneak: true }, message: "Forbidden" },
          id: null,
          jsonrpc: "2.0",
        })
      )
    )
  ).toEqual({
    error: { code: -32_600, message: "Forbidden" },
    id: null,
    jsonrpc: "2.0",
  });
});

test("scrubRpcJson rewrites each NDJSON frame independently", () => {
  const raw = `${JSON.stringify({
    chunk: true,
    id: 1,
    jsonrpc: "2.0",
    result: [0],
  })}\n${JSON.stringify({
    error: { _tag: "Defect", data: { message: "secret" } },
    id: -32_603,
    jsonrpc: "2.0",
  })}\n`;
  expect(scrubRpcJson(raw, [1])).toBe(
    `${JSON.stringify({
      chunk: true,
      id: 1,
      jsonrpc: "2.0",
      result: [0],
    })}\n${JSON.stringify({
      error: { code: -32_603, message: "Internal error" },
      id: 1,
      jsonrpc: "2.0",
    })}\n`
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
          `${JSON.stringify({
            error: { _tag: "Defect", data: { message: "secret" } },
            id: -32_603,
            jsonrpc: "2.0",
          })}\n`
        )
      );
      // Leave the stream open briefly so flush is not required for the first frame.
    },
  });

  const reader = input.pipeThrough(transform).getReader();
  const { value } = await reader.read();
  expect(decoder.decode(value)).toBe(
    `${JSON.stringify({
      error: { code: -32_603, message: "Internal error" },
      id: 9,
      jsonrpc: "2.0",
    })}\n`
  );
  await reader.cancel();
});

test("scrubNdjsonTransform reassembles a line split across multi-byte UTF-8", async () => {
  const transform = scrubNdjsonTransform([3]);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const line = `${JSON.stringify({
    error: { _tag: "Defect", data: { message: "sécret-café" } },
    id: -32_603,
    jsonrpc: "2.0",
  })}\n`;
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
  const out = await readAll(reader, decoder);
  expect(out).toBe(
    `${JSON.stringify({
      error: { code: -32_603, message: "Internal error" },
      id: 3,
      jsonrpc: "2.0",
    })}\n`
  );
  expect(out).not.toContain("sécret");
});

test("scrubRpcJson repairs distinct Defect ids for multi-request batches", () => {
  const batch = JSON.stringify([
    {
      error: { _tag: "Defect", data: { message: "first" } },
      id: -32_603,
      jsonrpc: "2.0",
    },
    {
      error: { _tag: "Defect", data: { message: "second" } },
      id: -32_603,
      jsonrpc: "2.0",
    },
  ]);
  expect(JSON.parse(scrubRpcJson(batch, [10, 20]))).toEqual([
    {
      error: { code: -32_603, message: "Internal error" },
      id: 10,
      jsonrpc: "2.0",
    },
    {
      error: { code: -32_603, message: "Internal error" },
      id: 20,
      jsonrpc: "2.0",
    },
  ]);

  const ndjson = `${JSON.stringify({
    id: 10,
    jsonrpc: "2.0",
    result: "ok",
  })}\n${JSON.stringify({
    error: { _tag: "Defect", data: { message: "boom" } },
    id: -32_603,
    jsonrpc: "2.0",
  })}\n`;
  expect(scrubRpcJson(ndjson, [10, 20])).toBe(
    `${JSON.stringify({
      id: 10,
      jsonrpc: "2.0",
      result: "ok",
    })}\n${JSON.stringify({
      error: { code: -32_603, message: "Internal error" },
      id: 20,
      jsonrpc: "2.0",
    })}\n`
  );
});

test("extractJsonRpcRequestIds reads unary, batch array, and NDJSON ids", () => {
  expect(
    extractJsonRpcRequestIds('{"jsonrpc":"2.0","id":7,"method":"x"}')
  ).toEqual([7]);
  expect(
    extractJsonRpcRequestIds(
      '[{"jsonrpc":"2.0","id":3,"method":"a"},{"jsonrpc":"2.0","id":4,"method":"b"}]'
    )
  ).toEqual([3, 4]);
  expect(
    extractJsonRpcRequestIds(
      '{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n'
    )
  ).toEqual([1, 2]);
});
