const keyCache = new Map();

function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid JWT");
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), ch => ch.charCodeAt(0));
}

function json(value) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(value)));
}

async function signingKey(issuer, kid) {
  const cached = keyCache.get(issuer);
  if (cached?.until > Date.now() && cached.keys.some(key => key.kid === kid)) {
    return cached.keys.find(key => key.kid === kid);
  }
  // Throttle refreshes for unknown key IDs, even if the caller supplies a new ID.
  if (cached?.retryAfter > Date.now()) return null;
  keyCache.set(issuer, { keys: cached?.keys || [], until: cached?.until || 0, retryAfter: Date.now() + 30000 });
  const response = await fetch(issuer + "/cdn-cgi/access/certs", {
    redirect: "error", signal: AbortSignal.timeout(4000)
  });
  if (!response.ok) return null;
  const body = await response.json();
  const keys = body.keys.filter(key => key.kty === "RSA" && key.alg === "RS256" && key.use === "sig");
  keyCache.set(issuer, { keys, until: Date.now() + 300000, retryAfter: Date.now() + 30000 });
  return keys.find(key => key.kid === kid);
}

export async function authorizeAdmin(request, env) {
  const url = new URL(request.url);
  const team = env.CONSULT_ACCESS_TEAM || "";
  const audience = env.CONSULT_ACCESS_AUD || "";
  const emails = (env.CONSULT_ADMIN_EMAILS || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  if (url.protocol !== "https:" || url.hostname !== env.CONSULT_ADMIN_HOST ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(team) || !audience || !emails.length) return null;

  const token = request.headers.get("Cf-Access-Jwt-Assertion") || "";
  if (!token || token.length > 8192) return null;
  const issuer = "https://" + team + ".cloudflareaccess.com";
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = json(parts[0]);
    const claims = json(parts[1]);
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== "RS256" || !/^[A-Za-z0-9_-]{1,128}$/.test(header.kid || "") ||
        claims.iss !== issuer || claims.type !== "app" || !Array.isArray(claims.aud) ||
        !claims.aud.includes(audience) || !Number.isInteger(claims.exp) || claims.exp <= now ||
        !Number.isInteger(claims.iat) || claims.iat > now + 30 ||
        (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > now)) ||
        typeof claims.email !== "string" || !emails.includes(claims.email.toLowerCase())) return null;
    const jwk = await signingKey(issuer, header.kid);
    if (!jwk) return null;
    const parameters = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    const key = await crypto.subtle.importKey("jwk", jwk, parameters, false, ["verify"]);
    if (!await crypto.subtle.verify(parameters, key, decode(parts[2]), new TextEncoder().encode(parts.slice(0, 2).join(".")))) return null;
    return claims.email.toLowerCase();
  } catch {
    return null;
  }
}
