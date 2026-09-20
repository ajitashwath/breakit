// Small URL helpers used by the engine. No dependencies.

// Second-level labels that behave like a TLD in ccTLD registries (co.uk, com.au…).
const SLD = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne"]);

/**
 * Approximate "registrable domain" without shipping the public-suffix list.
 * Good enough to separate `cdn.example.com` (same site) from `analytics.io`.
 * Wrong for exotic suffixes like `github.io` — it is a heuristic, not a fact.
 */
export function siteOf(rawUrl: string): string {
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return "";
  }
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host; // IPv4 / IPv6
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const [tld, sld] = [parts[parts.length - 1], parts[parts.length - 2]];
  const take = tld.length === 2 && SLD.has(sld) ? 3 : 2;
  return parts.slice(-take).join(".");
}

export function isThirdParty(requestUrl: string, pageUrl: string): boolean {
  const a = siteOf(requestUrl);
  const b = siteOf(pageUrl);
  return a !== "" && b !== "" && a !== b;
}

/** Accepts `example.com` or a full URL; rejects anything but http(s). */
export function normalizeTargetUrl(input: string): string {
  const raw = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`Not a valid URL: ${input}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Only http(s) URLs can be tested, got ${u.protocol}`);
  }
  return u.toString();
}

/**
 * "Does this look like something worth testing?" — used by the UI to decide
 * when to reveal the controls. Deliberately loose; the engine does real validation.
 */
export function looksLikeTarget(input: string): boolean {
  const raw = input.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const host = raw.split(/[/?#]/)[0].replace(/:\d+$/, "");
  if (host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(host);
}

/** URLs Chromium never sends over the network. */
export function isNetworkUrl(u: string): boolean {
  return u.startsWith("http://") || u.startsWith("https://");
}

/** Path + query only, for compact display and stable decision keys. */
export function pathOf(u: string): string {
  try {
    const p = new URL(u);
    return p.pathname + p.search;
  } catch {
    return u;
  }
}
