/* eslint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- OpenRPC / JSON Schema bags are untyped at the discovery boundary */
import * as Schema from "effect/Schema";

import type { ActionMeta } from "./action";
import type { OxidejsJson } from "./types";

export const OPENRPC_PATH = "/__oxide/openrpc";

export interface OpenRpcActionEntry {
  meta: ActionMeta;
  name: string;
}

export interface BuildOpenRpcDocumentOptions {
  /** Absolute or path-only URL of the JSON-RPC action endpoint. */
  actionUrl: string;
  title?: string;
  version?: string;
}

interface JsonSchemaObject {
  [key: string]: OxidejsJson | undefined;
}

interface CodecJsonSchema {
  definitions: { [key: string]: JsonSchemaObject };
  schema: JsonSchemaObject;
}

const emptySchema: JsonSchemaObject = {};

const rewriteSchemaRefs = function rewriteSchemaRefs(
  value: OxidejsJson
): OxidejsJson {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteSchemaRefs(item));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const out: { [key: string]: OxidejsJson } = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") {
      out[key] = child
        .replace(/^#\/\$defs\//u, "#/components/schemas/")
        .replace(/^#\/definitions\//u, "#/components/schemas/");
      continue;
    }
    // SAFETY: JSON Schema child values stay JSON-compatible after rewrite.
    out[key] = rewriteSchemaRefs(child as OxidejsJson);
  }
  return out;
};

/** Convert an Effect Schema codec to a JSON Schema object (+ optional $defs). */
export const codecToJsonSchema = function codecToJsonSchema(
  codec?: Schema.Codec<unknown, unknown, never, never>
): CodecJsonSchema {
  if (codec === undefined) {
    return { definitions: {}, schema: emptySchema };
  }
  const document = Schema.toJsonSchemaDocument(codec);
  // SAFETY: Effect returns a JSON-Schema-shaped bag; rewrite $defs refs for OpenRPC components.
  const rawSchema = document.schema as OxidejsJson;
  // SAFETY: definitions is a string-keyed JSON Schema map when present.
  const rawDefs = (document.definitions ?? {}) as {
    [key: string]: OxidejsJson;
  };
  const definitions: { [key: string]: JsonSchemaObject } = {};
  for (const [name, def] of Object.entries(rawDefs)) {
    // SAFETY: each definition is a JSON Schema object after rewrite.
    definitions[name] = rewriteSchemaRefs(def) as JsonSchemaObject;
  }
  return {
    definitions,
    // SAFETY: rewritten schema remains a JSON Schema object.
    schema: rewriteSchemaRefs(rawSchema) as JsonSchemaObject,
  };
};

const mergeDefinitions = function mergeDefinitions(
  target: { [key: string]: JsonSchemaObject },
  source: { [key: string]: JsonSchemaObject }
) {
  for (const [name, schema] of Object.entries(source)) {
    target[name] ??= schema;
  }
};

interface OpenRpcError {
  code: number;
  data?: JsonSchemaObject;
  message: string;
}

interface OpenRpcMethod {
  description?: string;
  errors?: OpenRpcError[];
  name: string;
  paramStructure: "by-name";
  params: {
    name: string;
    required: boolean;
    schema: JsonSchemaObject;
  }[];
  result: { name: string; schema: JsonSchemaObject };
  summary?: string;
  ["x-oxide-stream"]?: boolean;
}

/**
 * Build an OpenRPC 1.3 document for oxide `action()` RPC methods.
 * Payload shape matches Effect Rpc: by-name `{ args: [...] }`.
 */
export const buildOpenRpcDocument = function buildOpenRpcDocument(
  entries: OpenRpcActionEntry[],
  opts: BuildOpenRpcDocumentOptions
) {
  const componentsSchemas: { [key: string]: JsonSchemaObject } = {};
  const methods = entries.map((entry) => {
    const payloadCodec = entry.meta.payload
      ? Schema.Struct({ args: Schema.Tuple([entry.meta.payload]) })
      : Schema.Struct({ args: Schema.Array(Schema.Unknown) });
    // SAFETY: Struct/Tuple schemas are accepted by toJsonSchemaDocument.
    const paramsSchema = codecToJsonSchema(
      payloadCodec as Schema.Codec<unknown, unknown, never, never>
    );
    mergeDefinitions(componentsSchemas, paramsSchema.definitions);

    const resultSchema = codecToJsonSchema(entry.meta.success);
    mergeDefinitions(componentsSchemas, resultSchema.definitions);

    const errors: OpenRpcError[] = [];
    if (entry.meta.error) {
      const errorSchema = codecToJsonSchema(entry.meta.error);
      mergeDefinitions(componentsSchemas, errorSchema.definitions);
      errors.push({
        code: -32_000,
        data: errorSchema.schema,
        message: "Application error",
      });
    }

    const { properties } = paramsSchema.schema;
    let argsSchema = emptySchema;
    if (
      properties &&
      typeof properties === "object" &&
      !Array.isArray(properties)
    ) {
      // SAFETY: Effect Struct emit puts `args` under properties.
      const props = properties as { [key: string]: JsonSchemaObject };
      argsSchema = props["args"] ?? emptySchema;
    }

    const method: OpenRpcMethod = {
      name: entry.name,
      paramStructure: "by-name",
      params: [
        {
          name: "args",
          required: true,
          schema: argsSchema,
        },
      ],
      result: {
        name: "result",
        schema: resultSchema.schema,
      },
    };
    if (entry.meta.stream) {
      method.description =
        "Streaming action — results are NDJSON JSON-RPC notifications/chunks over the action endpoint.";
      method.summary = "stream";
      method["x-oxide-stream"] = true;
    }
    if (errors.length > 0) {
      method.errors = errors;
    }
    return method;
  });

  return {
    components: {
      schemas: componentsSchemas,
    },
    info: {
      title: opts.title ?? "Oxide Actions",
      version: opts.version ?? "1.0.0",
    },
    methods,
    openrpc: "1.3.2",
    servers: [
      {
        name: "actions",
        url: opts.actionUrl,
      },
    ],
  };
};

export const matchesOpenRpcPath = function matchesOpenRpcPath(
  pathname: string,
  openRpcPath: string = OPENRPC_PATH
) {
  return pathname === openRpcPath || pathname === `${openRpcPath}/`;
};

/** `GET`/`HEAD` OpenRPC document for stamped `action()` handlers. */
export const createOpenRpcResponse = function createOpenRpcResponse(
  entries: OpenRpcActionEntry[],
  request: Request,
  opts: { actionPath: string; title?: string; version?: string }
) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      headers: { Allow: "GET, HEAD" },
      status: 405,
    });
  }
  const actionUrl = new URL(opts.actionPath, request.url).href;
  const documentOpts: BuildOpenRpcDocumentOptions = { actionUrl };
  if (opts.title !== undefined) {
    documentOpts.title = opts.title;
  }
  if (opts.version !== undefined) {
    documentOpts.version = opts.version;
  }
  const document = buildOpenRpcDocument(entries, documentOpts);
  const body = request.method === "HEAD" ? null : JSON.stringify(document);
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status: 200,
  });
};
