import { consultationExpiry } from "../_shared/retention.js";

const maxFile = 1024 * 1024;
const maxBody = maxFile + 64 * 1024;
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const choices = {
  plan: ["사연 리포트 15,000원", "카톡 상담 30분 39,000원", "카톡 상담 60분 69,000원", "전화 상담 30분 59,000원", "전화 상담 60분 99,000원", "VIP 집중관리 490,000원", "VVIP 컨설팅 오픈 알림"],
  style: ["공감 상담", "현실 코칭"],
  topic: ["이별 위기", "이별·재회", "연애 중 갈등", "썸·시작 단계", "짝사랑", "관계 선택·결혼 고민", "기타"],
  contact_type: ["카카오톡 ID", "휴대폰 번호"],
  when: ["평일 낮", "평일 저녁", "주말 낮", "주말 저녁", "사연 리포트라 상관없어요", "VIP·VVIP라 따로 안내받을게요"],
  consent: ["동의"]
};

function reply(status, body) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export function onRequestGet({ env }) {
  return env.CONSULT_DB && env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET
    ? reply(200, { siteKey: env.TURNSTILE_SITE_KEY })
    : reply(503, { code: "unavailable" });
}

async function readForm(request) {
  if (!/^multipart\/form-data;\s*boundary=/i.test(request.headers.get("Content-Type") || "")) {
    return reply(415, { code: "format" });
  }
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > maxBody) return reply(413, { code: "size" });
  if (!request.body) return reply(400, { code: "invalid" });
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBody) {
      await reader.cancel();
      return reply(413, { code: "size" });
    }
    chunks.push(value);
  }
  return new Response(new Blob(chunks), {
    headers: { "Content-Type": request.headers.get("Content-Type") }
  }).formData().catch(() => reply(400, { code: "invalid" }));
}

function imageType(bytes) {
  const matches = (offset, signature) => signature.every((value, index) => bytes[offset + index] === value);
  if (matches(0, [137, 80, 78, 71, 13, 10, 26, 10]) && matches(12, [73, 72, 68, 82])) return "image/png";
  if (matches(0, [255, 216, 255]) && matches(bytes.length - 2, [255, 217])) return "image/jpeg";
  if (matches(0, [82, 73, 70, 70]) && matches(8, [87, 69, 66, 80])) return "image/webp";
  if (matches(0, [71, 73, 70, 56, 55, 97]) || matches(0, [71, 73, 70, 56, 57, 97])) return "image/gif";
  return null;
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (request.headers.get("Origin") !== url.origin) return reply(403, { code: "origin" });
  const id = request.headers.get("Idempotency-Key") || "";
  const token = request.headers.get("X-Turnstile-Token") || "";
  if (!idPattern.test(id)) return reply(400, { code: "invalid" });
  if (!token || token.length > 2048) return reply(403, { code: "challenge" });
  if (!env.CONSULT_DB || !env.TURNSTILE_SECRET) return reply(503, { code: "unavailable" });

  let failure = "upload_read";
  try {
    const form = await readForm(request);
    if (form instanceof Response) return form;
    if (form.getAll("company").some(value => value !== "")) return reply(400, { code: "invalid" });

    const fields = {};
    for (const name of [...Object.keys(choices), "story", "nickname", "contact"]) {
      const values = form.getAll(name);
      const value = typeof values[0] === "string" ? values[0].trim() : "";
      const max = name === "story" ? 10000 : 120;
      if (values.length !== 1 || !value || value.length > max ||
          (choices[name] && !choices[name].includes(value)) ||
          (name === "story" && value.length < 20)) {
        return reply(400, { code: "field", field: name });
      }
      fields[name] = value;
    }

    const uploads = form.getAll("capture");
    const file = uploads[0] === "" ? undefined : uploads[0];
    if (uploads.length > 1 || typeof file === "string") return reply(415, { code: "image" });
    if (file?.size > maxFile) return reply(413, { code: "size" });
    const bytes = file?.size ? await file.arrayBuffer() : null;
    const mime = bytes ? imageType(new Uint8Array(bytes)) : null;
    if ((file?.name && !bytes) || (bytes && (!mime || mime !== file.type))) return reply(415, { code: "image" });

    failure = "verify_unavailable";
    const verification = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token }),
      signal: AbortSignal.timeout(8000)
    });
    if (!verification.ok) return reply(503, { code: "unavailable" });
    const challenge = await verification.json();
    if (!challenge.success || challenge.hostname !== url.hostname || challenge.action !== "consult") {
      return reply(403, { code: "challenge" });
    }

    failure = "storage_unavailable";
    const payload = JSON.stringify(fields);
    const imageHash = bytes ? [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].join(",") : "";
    const fingerprint = [...new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(JSON.stringify([id, payload, mime, imageHash]))))].join(",");
    const now = new Date();
    const expires = consultationExpiry(now, env.CONSULT_RETENTION_DAYS);
    const db = env.CONSULT_DB.withSession("first-primary");
    for (let attempt = 0; attempt < 3; attempt++) {
      const random = crypto.getRandomValues(new Uint8Array(8));
      const code = "KY-" + Array.from(random, value => value.toString(16).padStart(2, "0")).join("").toUpperCase();
      const result = await db.prepare(
        "INSERT INTO consultations (id, fingerprint, received_at, expires_at, payload, mime, capture, consultation_code, consent_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING"
      ).bind(id, fingerprint, now.toISOString(), expires, payload, mime, bytes, code, "site-v1").run();
      if (result.meta.changes === 1) return reply(201, { ok: true, consultationId: code });
      const existing = await db.prepare("SELECT fingerprint, consultation_code, expires_at FROM consultations WHERE id = ?").bind(id).first();
      if (existing) {
        return existing.fingerprint === fingerprint && existing.expires_at > now.toISOString()
          ? reply(200, { ok: true, consultationId: existing.consultation_code })
          : reply(409, { code: "duplicate" });
      }
    }
    return reply(503, { code: "storage_unavailable" });
  } catch {
    return reply(503, { code: failure });
  }
}
