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

export function injectFiles(json: unknown, files: FileRef[]): unknown {
  const first = files[0];
  if (files.length === 1 && first && first.path.length === 0) return first.file;
  const root = json;
  for (const { path, file } of files) {
    if (path.length === 0) return file;
    let cur = root as Record<string | number, unknown>;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (key === undefined) break;
      cur = cur[key] as Record<string | number, unknown>;
    }
    const last = path[path.length - 1];
    if (last !== undefined) cur[last] = file;
  }
  return root;
}

export function toForm(rpc: unknown, files: FileRef[]): FormData {
  const form = new FormData();
  form.set("rpc", JSON.stringify(rpc));
  form.set("maps", JSON.stringify(files.map((item) => item.path)));
  files.forEach((item, i) => form.set(String(i), item.file));
  return form;
}

export async function fromForm(form: FormData): Promise<{ rpc: unknown; files: FileRef[] }> {
  try {
    const rpc = JSON.parse(String(form.get("rpc")));
    const maps = JSON.parse(String(form.get("maps") ?? "[]")) as Path[];
    const files = maps.map((path, i) => ({ path, file: form.get(String(i)) as Blob }));
    return { rpc, files };
  } catch {
    throw new SyntaxError("Invalid multipart RPC");
  }
}

export function fileHeaders(file: Blob) {
  const name = file instanceof File && file.name ? file.name : "download";
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
