const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" };
function response(status, payload) {
  return Response.json(payload, { status, headers });
}

export async function onRequestGet({ request, env }) {
  const secret = env.CONSULT_ADMIN_TOKEN;
  const authorization = request.headers.get("Authorization") || "";
  if (!secret || secret.length < 43 || authorization.length !== secret.length + 7) return response(404, {});
  const encoder = new TextEncoder();
  const expected = encoder.encode("Bearer " + secret);
  const supplied = encoder.encode(authorization);
  if (supplied.byteLength !== expected.byteLength ||
      !crypto.subtle.timingSafeEqual(expected, supplied)) return response(404, {});
  if (!env.CONSULT_DB) return response(503, {});

  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) return response(400, {});
  try {
    const row = await env.CONSULT_DB.withSession("first-primary")
      .prepare("SELECT mime, capture FROM consultations WHERE id = ? AND expires_at > ?")
      .bind(id, new Date().toISOString()).first();
    const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
    if (!row?.capture || !extensions[row.mime]) return response(404, {});
    return new Response(Uint8Array.from(row.capture), {
      headers: { ...headers, "Content-Type": row.mime, "Content-Disposition": 'attachment; filename="capture.' + extensions[row.mime] + '"' }
    });
  } catch {
    return response(503, {});
  }
}
