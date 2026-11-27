import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { onRequestPost } from "../functions/api/consult.js";
import { onRequest } from "../functions/admin/consultations.js";
import retention from "../ops/retention-worker.js";

const origin = "https://example.test";
const path = "/admin/consultations";
const legacyId = "aaaaaaaa-0000-4000-8000-000000000001";
const defaultData = {
  plan: "사연 리포트 15,000원", style: "공감 상담", topic: "기타", contact_type: "카카오톡 ID",
  when: "평일 낮", consent: "동의", story: "가상의 사연입니다. <script>fictional marker only</script>",
  nickname: "테스트 <img>", contact: "fictional-test"
};
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5i0AAAAASUVORK5CYII=", "base64");

function database() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync("migrations/0001_consultations.sql", "utf8"));
  const legacyInsert = sql.prepare("INSERT INTO consultations (id,fingerprint,received_at,expires_at,payload) VALUES (?,?,?,?,?)");
  legacyInsert.run(legacyId, "legacy", "2026-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", JSON.stringify(defaultData));
  sql.exec(readFileSync("migrations/0002_consultation_management.sql", "utf8"));
  const DB = {
    withSession() { return this; },
    prepare(query) {
      return { bind(...args) {
        const stmt = sql.prepare(query), values = args.map(arg => arg instanceof ArrayBuffer ? new Uint8Array(arg) : arg);
        return {
          first: () => stmt.get(...values),
          all: () => ({ results: stmt.all(...values) }),
          run: () => ({ meta: stmt.run(...values) })
        };
      } };
    }
  };
  return { sql, DB, legacyInsert };
}

test("migration, submission, admin boundary, data lifecycle", async t => {
  const { sql, DB, legacyInsert } = database();
  const fetchBefore = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchBefore; sql.close(); });
  const env = {
    CONSULT_DB: DB, TURNSTILE_SECRET: "local-fixture", CONSULT_ADMIN_HOST: "example.test",
    CONSULT_ACCESS_TEAM: "local-fixture", CONSULT_ACCESS_AUD: "local-audience", CONSULT_ADMIN_EMAILS: "admin@example.test"
  };
  const signing = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const key = await crypto.subtle.generateKey(signing, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", key.publicKey), kid: "current", use: "sig", alg: "RS256" };
  globalThis.fetch = async (url, opts) => {
    if (url === "https://local-fixture.cloudflareaccess.com/cdn-cgi/access/certs") return Response.json({ keys: [jwk] });
    assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    return Response.json({ success: opts.body.get("response") === "fixture-ok", hostname: "example.test", action: "consult" });
  };
  const now = Math.floor(Date.now() / 1000);
  async function jwt(overrides = {}) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    const first = encode({ alg: "RS256", kid: "current" }) + "." + encode({
      iss: "https://local-fixture.cloudflareaccess.com", aud: ["local-audience"],
      exp: now + 600, iat: now, type: "app", email: "admin@example.test", ...overrides
    });
    const signature = await crypto.subtle.sign(signing.name, key.privateKey, new TextEncoder().encode(first));
    return first + "." + Buffer.from(signature).toString("base64url");
  }
  const valid = await jwt();
  function admin({ query = "", token = valid, body, site = origin, requestOrigin = origin } = {}) {
    return onRequest({
      env, request: new Request(site + path + query, {
        method: body ? "POST" : "GET", body, headers: { Origin: requestOrigin, "Cf-Access-Jwt-Assertion": token }
      })
    });
  }
  function submit({ id = crypto.randomUUID(), fields = {}, file, mime = "image/png", token = "fixture-ok", activeEnv = env } = {}) {
    const body = new FormData();
    Object.entries({ ...defaultData, ...fields }).forEach(([k, v]) => body.append(k, v));
    if (file) body.append("capture", new Blob([file], { type: mime }), "fake.png");
    return onRequestPost({ env: activeEnv, request: new Request(origin + "/api/consult", {
      method: "POST", body, headers: { Origin: origin, "Idempotency-Key": id, "X-Turnstile-Token": token }
    }) });
  }

  await t.test("legacy data and old inserts remain compatible", () => {
    assert.equal(sql.prepare("SELECT consultation_code FROM consultations WHERE id = ?").get(legacyId).consultation_code,
      "KY-AAAAAAAA000040008000000000000001");
    const id = "aaaaaaaa-0000-4000-8000-000000000002";
    legacyInsert.run(id, "old-insert", "2026-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", JSON.stringify(defaultData));
    assert.equal(sql.prepare("SELECT status FROM consultations WHERE id = ?").get(id).status, "new");
    assert.notEqual(sql.prepare("SELECT consultation_code FROM consultations WHERE id = ?").get(id).consultation_code, null);
  });

  let id, code;
  await t.test("valid multipart, unique receipt and idempotency", async () => {
    id = crypto.randomUUID();
    const response = await submit({ id, file: png });
    assert.equal(response.status, 201);
    code = (await response.json()).consultationId;
    assert.match(code, /^KY-[A-F0-9]{16}$/);
    const retry = await submit({ id, file: png });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).consultationId, code);
    assert.equal((await submit({ id, fields: { nickname: "different" } })).status, 409);
    assert.equal((await submit()).status, 201);
    const insertDuplicate = sql.prepare("UPDATE consultations SET consultation_code = ? WHERE id = ?");
    assert.throws(() => insertDuplicate.run(code, legacyId), /UNIQUE/);
  });

  await t.test("validation, spam challenge and storage failures", async () => {
    assert.equal((await submit({ fields: { consent: "" } })).status, 400);
    assert.equal((await submit({ fields: { plan: "unknown" } })).status, 400);
    assert.equal((await submit({ file: Buffer.from("<svg/>") })).status, 415);
    assert.equal((await submit({ file: Buffer.alloc(1024 * 1024 + 1) })).status, 413);
    assert.equal((await submit({ file: png, mime: "image/jpeg" })).status, 415);
    assert.equal((await submit({ token: "invalid" })).status, 403);
    const failed = await submit({ activeEnv: { ...env, CONSULT_DB: { withSession() { throw new Error("private database detail"); } } } });
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { code: "storage_unavailable" });
  });

  await t.test("Access identity, signature, expiry, audience and host are enforced", async () => {
    assert.equal((await admin({ token: "", query: "?id=" + id })).status, 404);
    assert.equal((await admin({ token: valid.slice(0, valid.lastIndexOf(".") + 1) + "invalid" })).status, 404);
    assert.equal((await admin({ token: await jwt({ email: "other@example.test" }) })).status, 404);
    assert.equal((await admin({ token: await jwt({ aud: ["other"] }) })).status, 404);
    assert.equal((await admin({ token: await jwt({ exp: now - 1 }) })).status, 404);
    assert.equal((await admin({ token: await jwt({ iat: undefined }) })).status, 404);
    assert.equal((await admin({ site: "https://wrong.example.test" })).status, 404);
    assert.equal((await admin()).status, 200);
  });

  await t.test("filtered list, escaped detail and protected attachment", async () => {
    const list = await admin({ body: new URLSearchParams({ code }) });
    assert.match(await list.text(), new RegExp(code));
    const noMatch = await admin({ body: new URLSearchParams({ code: "' OR 1=1 --" }) });
    assert.match(await noMatch.text(), /신청 내역이 없습니다/);
    const detail = await admin({ query: "?id=" + id });
    assert.match(detail.headers.get("cache-control"), /no-store/);
    const html = await detail.text();
    assert.match(html, /&lt;script&gt;fictional/);
    assert.doesNotMatch(html, /<script>/);
    assert.equal((await admin({ query: "?id=" + code })).status, 404);
    const query = "?id=" + id + "&download=1";
    assert.equal((await admin({ query, token: "" })).status, 404);
    assert.deepEqual(Buffer.from(await (await admin({ query })).arrayBuffer()), png);
  });

  await t.test("CSRF, status validation, retention refresh and deletion", async () => {
    const query = "?id=" + id;
    const body = new URLSearchParams({ action: "update", note: "fixture", status: "completed" });
    assert.equal((await admin({ query, body, requestOrigin: "https://wrong.example" })).status, 403);
    assert.equal((await admin({ query, body: new URLSearchParams({ action: "update", note: "", status: "other" }) })).status, 400);
    assert.equal((await admin({ query, body })).status, 303);
    assert.equal(sql.prepare("SELECT status FROM consultations WHERE id = ?").get(id).status, "completed");
    assert.equal((await admin({ query, body: new URLSearchParams({ action: "delete" }) })).status, 400);
    assert.equal((await admin({ query, body: new URLSearchParams({ action: "delete", confirm: "yes" }) })).status, 303);
    assert.equal((await admin({ query: query + "&download=1" })).status, 404);
    sql.prepare("UPDATE consultations SET expires_at = '2000-01-01' WHERE id = ?").run(legacyId);
    await retention.scheduled(null, env);
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM consultations WHERE id = ?").get(legacyId).n, 0);
  });
});
