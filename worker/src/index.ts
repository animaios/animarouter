export interface Env {
  PROXY_AUTH_KEY: string;
  /** Comma-separated host allowlist. "*" allows any HTTPS host. */
  ALLOWED_HOSTS?: string;
}

const VERSION = "1";
const DEFAULT_ALLOWED_HOSTS = "*";

const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "retry-after",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-tokens",
];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return handleRequest(req, env);
  },
};

export async function handleRequest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/healthz") {
    return json({ ok: true });
  }

  if (req.method !== "POST") {
    return text("Method Not Allowed", 405);
  }

  const route = parseProxyPath(url.pathname);
  if (!route) {
    return text("Bad proxy URL", 400);
  }

  if (!env.PROXY_AUTH_KEY || route.authKey !== env.PROXY_AUTH_KEY) {
    return text("Unauthorized", 401);
  }

  if (route.version !== VERSION) {
    return text("Unsupported proxy version", 400);
  }

  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(base64urlDecode(route.encodedUpstream));
  } catch {
    return text("Invalid upstream URL", 400);
  }

  if (upstreamUrl.protocol !== "https:") {
    return text("Upstream must use HTTPS", 400);
  }

  if (
    !isAllowedHost(
      upstreamUrl.hostname,
      env.ALLOWED_HOSTS ?? DEFAULT_ALLOWED_HOSTS,
    )
  ) {
    return text("Upstream host not allowed", 403);
  }

  const providerAuth = req.headers.get("authorization");
  if (!providerAuth) {
    return text("Missing provider authorization", 400);
  }

  const upstreamRes = await fetch(upstreamUrl.toString(), {
    method: "POST",
    headers: buildUpstreamHeaders(req.headers, providerAuth),
    body: req.body,
    redirect: "manual",
  });

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: filterResponseHeaders(upstreamRes.headers),
  });
}

function parseProxyPath(
  pathname: string,
): { authKey: string; version: string; encodedUpstream: string } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 3) return null;
  const [authKey, version, encodedUpstream] = parts;
  if (!authKey || !version || !encodedUpstream) return null;
  return { authKey, version, encodedUpstream };
}

function buildUpstreamHeaders(inbound: Headers, providerAuth: string): Headers {
  const headers = new Headers();
  headers.set("authorization", providerAuth);
  headers.set(
    "content-type",
    inbound.get("content-type") ?? "application/json",
  );

  const accept = inbound.get("accept");
  if (accept) headers.set("accept", accept);

  return headers;
}

export function isAllowedHost(hostname: string, allowedHosts: string): boolean {
  const rules = allowedHosts
    .split(",")
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean);

  if (rules.length === 0 || rules.includes("*")) return true;

  const normalized = hostname.toLowerCase();
  return rules.some((rule) => {
    if (rule === normalized) return true;
    if (!rule.startsWith("*.")) return false;
    const suffix = rule.slice(1);
    return normalized.endsWith(suffix) && normalized.length > suffix.length;
  });
}

export function base64urlDecode(value: string): string {
  const padded = value.padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    "=",
  );
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64);
}

function filterResponseHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value) out.set(name, value);
  }
  out.set("cache-control", "no-store");
  return out;
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
