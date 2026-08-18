type Path = (string | number)[];

export type FileRef = { path: Path; file: Blob };

const isBlob = (value: unknown): value is Blob =>
  typeof Blob !== "undefined" && value instanceof Blob;

export function extractFiles(value: unknown): { json: unknown; files: FileRef[] } {
  const files: FileRef[] = [];
  const walk = (node: unknown, path: Path): unknown => {
    if (isBlob(node)) {
      files.push({ path, file: node });
      return null;
    }
    if (Array.isArray(node)) return node.map((item, i) => walk(item, [...path, i]));
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) out[key] = walk(item, [...path, key]);
      return out;
    }
    return node;
  };
  return { json: walk(value, []), files };
}

const DANGEROUS_KEY = /^(?:__proto__|prototype|constructor)$/;

function own(node: unknown, key: string | number): Record<string | number, unknown> | undefined {
  if (!node || typeof node !== "object") return;
  if (typeof key === "string" && DANGEROUS_KEY.test(key)) return;
  if (!Object.hasOwn(node, key)) return;
  const next = (node as Record<string | number, unknown>)[key];
  return next && typeof next === "object" ? (next as Record<string | number, unknown>) : undefined;
}

export function injectFiles(json: unknown, files: FileRef[]): unknown {
  const first = files[0];
  if (files.length === 1 && first && first.path.length === 0) return first.file;
  if (!json || typeof json !== "object") return json;
  for (const { path, file } of files) {
    if (!Array.isArray(path) || path.length === 0) continue;
    let cur = json as Record<string | number, unknown>;
    let ok = true;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (key === undefined) {
        ok = false;
        break;
      }
      const next = own(cur, key);
      if (!next) {
        ok = false;
        break;
      }
      cur = next;
    }
    const last = path[path.length - 1];
    if (!ok || last === undefined) continue;
    if (typeof last === "string" && DANGEROUS_KEY.test(last)) continue;
    if (!Object.hasOwn(cur, last)) continue;
    cur[last] = file;
  }
  return json;
}

export function toForm(
  rpc: unknown,
  files: FileRef[],
  stringify: (val: any) => any = JSON.stringify,
): FormData {
  const form = new FormData();
  const serialized = stringify(rpc);
  form.set("rpc", typeof serialized === "string" ? serialized : new Blob([serialized]));
  form.set("maps", JSON.stringify(files.map((item) => item.path)));
  files.forEach((item, i) => form.set(String(i), item.file));
  return form;
}

export async function fromForm(
  form: FormData,
  parse: (val: any) => any = JSON.parse,
): Promise<{ rpc: unknown; files: FileRef[] }> {
  try {
    const rpcField = form.get("rpc");
    const rawRpc =
      rpcField instanceof Blob ? new Uint8Array(await rpcField.arrayBuffer()) : String(rpcField);
    const rpc = parse(rawRpc);
    const raw = JSON.parse(String(form.get("maps") ?? "[]"));
    if (!Array.isArray(raw)) throw new SyntaxError("maps must be an array");
    const maps = raw.filter(
      (p): p is Path =>
        Array.isArray(p) && p.every((s) => typeof s === "string" || typeof s === "number"),
    );
    const files = maps.map((path, i) => ({ path, file: form.get(String(i)) as Blob }));
    return { rpc, files };
  } catch {
    throw new SyntaxError("Invalid multipart RPC");
  }
}

export function safeFileName(name: string) {
  const base = name.replace(/[\r\n"\\]/g, "_").replace(/^.*[/\\]/, "");
  return base || "download";
}

export function fileHeaders(file: Blob) {
  const name = safeFileName(file instanceof File && file.name ? file.name : "download");
  return {
    "content-type": file.type || "application/octet-stream",
    "content-disposition": `attachment; filename="${name}"`,
    "x-rpc-result": "file",
  };
}

export function filenameFrom(disposition: string | null) {
  const match = disposition?.match(/filename="([^"]+)"/);
  return match?.[1] ?? "download";
}
