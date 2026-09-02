export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  // Browsers always send at least one of these for credentialed/fetch actions.
  if (!origin && !site) return false;
  if (site && site !== "same-origin" && site !== "none") return false;
  if (!origin) return site === "same-origin" || site === "none";
  try {
    return new URL(origin).host === (request.headers.get("host") ?? new URL(request.url).host);
  } catch {
    return false;
  }
}
