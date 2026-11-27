import { authorizeAdmin } from "../_shared/admin-auth.js";
import { consultationExpiry } from "../_shared/retention.js";

const path = "/admin/consultations";
const statuses = { new: "신규", review: "확인 중", booked: "예약 완료", completed: "상담 완료" };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
};

function page(title, content, status = 200) {
  return new Response('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    escape(title) + '</title><style>body{font:16px system-ui;margin:2rem auto;padding:0 1rem;max-width:72rem;color:#24151f;background:#fffafc}nav,form{display:flex;gap:.8rem;flex-wrap:wrap;align-items:end}nav{justify-content:space-between}label{display:grid;gap:.3rem}input,select,textarea,button{font:inherit;padding:.5rem}a{color:#66384f}table{border-collapse:collapse;width:100%}th,td{padding:.7rem;text-align:left;border-bottom:1px solid #ded3da}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}section{margin:1.5rem 0}.scroll{overflow:auto}textarea{width:min(80vw,44rem)}button{cursor:pointer}</style>' +
    '<nav><a href="' + path + '">상담 관리</a><a href="/cdn-cgi/access/logout">로그아웃</a></nav><main><h1>' + escape(title) + '</h1>' + content + '</main></html>',
    { status, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
}

function escape(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function options(selected) {
  return Object.entries(statuses).map(([value, label]) =>
    '<option value="' + value + '"' + (selected === value ? " selected" : "") + '>' + label + '</option>').join("");
}

function koreaDate(value) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Seoul" }).format(new Date(value));
}

async function list(db, filters, now) {
  const code = (filters.get("code") || "").trim().slice(0, 35).toUpperCase();
  const nickname = (filters.get("nickname") || "").trim().slice(0, 120);
  const plan = (filters.get("plan") || "").trim().slice(0, 120);
  const status = filters.get("status") || "";
  const date = filters.get("date") || "";
  const cursor = filters.get("before") || "";
  const dateStart = dayPattern.test(date) ? Date.parse(date + "T00:00:00+09:00") : NaN;
  const where = ["expires_at > ?"];
  const args = [now];
  if (code) { where.push("consultation_code = ?"); args.push(code); }
  if (nickname) { where.push("instr(lower(json_extract(payload, '$.nickname')), lower(?)) > 0"); args.push(nickname); }
  if (plan) { where.push("instr(json_extract(payload, '$.plan'), ?) > 0"); args.push(plan); }
  if (Object.hasOwn(statuses, status)) { where.push("status = ?"); args.push(status); }
  if (Number.isFinite(dateStart)) {
    where.push("received_at >= ? AND received_at < ?");
    args.push(new Date(dateStart).toISOString(), new Date(dateStart + 86400000).toISOString());
  }
  const [before, beforeId] = cursor.split("|");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(before) && uuid.test(beforeId)) {
    where.push("(received_at, id) < (?, ?)");
    args.push(before, beforeId);
  }
  const query = "SELECT id, consultation_code, received_at, status, json_extract(payload, '$.nickname') AS nickname, " +
    "json_extract(payload, '$.plan') AS plan, json_extract(payload, '$.contact_type') AS contact_type, " +
    "json_extract(payload, '$.when') AS schedule FROM consultations WHERE " +
    where.join(" AND ") + " ORDER BY received_at DESC, id DESC LIMIT 51";
  const { results } = await db.prepare(query).bind(...args).all();
  const rows = results.slice(0, 50).map(row =>
    '<tr><td><a href="?id=' + encodeURIComponent(row.id) + '">' + escape(row.consultation_code) +
    '</a></td><td>' + [koreaDate(row.received_at), row.nickname, row.plan, row.contact_type, row.schedule, statuses[row.status]]
      .map(escape).join("</td><td>") + "</td></tr>").join("");
  const last = results[49];
  return page("상담 신청 목록", '<form id="filters" method="post">' +
    '<label>접수번호<input name="code" maxlength="35" value="' + escape(code) + '"></label>' +
    '<label>닉네임<input name="nickname" maxlength="120" value="' + escape(nickname) + '"></label>' +
    '<label>신청 날짜<input type="date" name="date" value="' + escape(date) + '"></label>' +
    '<label>상담 유형<input name="plan" maxlength="120" value="' + escape(plan) + '"></label>' +
    '<label>진행 상태<select name="status"><option value="">전체</option>' + options(status) +
    '</select></label><button>검색</button></form><section class="scroll"><table><thead><tr>' +
    ["접수번호", "신청 날짜 (한국시간)", "닉네임", "상담 유형", "연락 방식", "희망 일정", "상태"].map(label => "<th>" + label + "</th>").join("") +
    "</tr></thead><tbody>" + (rows || '<tr><td colspan="7">신청 내역이 없습니다.</td></tr>') +
    '</tbody></table></section>' + (results.length > 50 ? '<button type="submit" form="filters" name="before" value="' + escape(last.received_at + '|' + last.id) + '">다음 50건</button>' : ''));
}

async function detail(db, id, now, download) {
  if (download) {
    const row = await db.prepare("SELECT mime, capture FROM consultations WHERE id = ? AND expires_at > ?")
      .bind(id, now).first();
    if (!row?.capture || !Object.hasOwn(extensions, row.mime)) return page("첨부 파일을 찾을 수 없습니다.", "", 404);
    return new Response(Uint8Array.from(row.capture), {
      headers: { ...headers, "Content-Type": row.mime, "Content-Disposition": 'attachment; filename="capture.' + extensions[row.mime] + '"' }
    });
  }
  const row = await db.prepare(
    "SELECT consultation_code, received_at, expires_at, payload, mime, status, admin_note, consent_version FROM consultations WHERE id = ? AND expires_at > ?"
  ).bind(id, now).first();
  if (!row) return page("신청을 찾을 수 없습니다.", "", 404);
  const data = JSON.parse(row.payload);
  const fields = [["신청 날짜", koreaDate(row.received_at)], ["보유 만료", koreaDate(row.expires_at)], ["닉네임", data.nickname],
    ["상담 유형", data.plan], ["상담 스타일", data.style], ["고민 유형", data.topic],
    ["연락 방식", data.contact_type], ["연락처", data.contact], ["희망 일정", data.when], ["동의 기록", row.consent_version || "이전 버전"]];
  const target = path + "?id=" + encodeURIComponent(id);
  return page(row.consultation_code, "<dl>" +
    fields.map(([key, value]) => "<dt>" + key + "</dt><dd>" + escape(value) + "</dd>").join("") +
    '</dl><h2>사연</h2><pre>' + escape(data.story) + '</pre>' +
    (row.mime ? '<p><a href="' + target + '&amp;download=1">첨부 이미지 다운로드</a></p>' : '') +
    '<section><h2>상태 및 내부 메모</h2><form method="post" action="' + target + '">' +
    '<label>진행 상태<select name="status">' + options(row.status) + '</select></label>' +
    '<label>내부 메모<textarea name="note" rows="5" maxlength="4000">' + escape(row.admin_note) +
    '</textarea></label><button name="action" value="update">변경 저장</button></form></section>' +
    '<section><h2>신청 삭제</h2><p>사연과 첨부 이미지가 함께 삭제됩니다.</p><form method="post" action="' + target +
    '"><label><span><input type="checkbox" name="confirm" value="yes" required> 삭제 확인</span></label>' +
    '<button name="action" value="delete">신청 삭제</button></form></section>');
}

async function readForm(request) {
  if (request.headers.get("Origin") !== new URL(request.url).origin) return page("요청이 거부되었습니다.", "", 403);
  if (!(request.headers.get("Content-Type") || "").startsWith("application/x-www-form-urlencoded") ||
      Number(request.headers.get("Content-Length")) > 60000) return page("잘못된 요청입니다.", "", 400);
  const reader = request.body?.getReader();
  if (!reader) return page("잘못된 요청입니다.", "", 400);
  const decoder = new TextDecoder();
  let body = "", bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 60000) {
      await reader.cancel();
      return page("요청이 너무 큽니다.", "", 413);
    }
    body += decoder.decode(value, { stream: true });
  }
  return new URLSearchParams(body + decoder.decode());
}

async function mutate(input, db, id, now, env) {
  const action = input.get("action");
  let result;
  let location = path;
  if (action === "delete" && input.get("confirm") === "yes") {
    result = await db.prepare("DELETE FROM consultations WHERE id = ? AND expires_at > ?").bind(id, now).run();
  } else if (action === "update") {
    const status = input.get("status"), note = input.get("note");
    if (!Object.hasOwn(statuses, status) || note === null || note.length > 4000) return page("입력값을 확인해 주세요.", "", 400);
    const expires = status === "completed" ? consultationExpiry(new Date(now), env.CONSULT_RETENTION_DAYS) : null;
    result = await db.prepare(
      "UPDATE consultations SET status = ?, admin_note = ?, updated_at = ?, expires_at = " +
      "CASE WHEN status <> 'completed' AND ? = 'completed' THEN ? ELSE expires_at END WHERE id = ? AND expires_at > ?"
    ).bind(status, note, now, status, expires, id, now).run();
    location += "?id=" + encodeURIComponent(id);
  } else {
    return page("잘못된 요청입니다.", "", 400);
  }
  if (!result.meta.changes) return page("신청을 찾을 수 없습니다.", "", 404);
  return new Response(null, { status: 303, headers: { ...headers, Location: location } });
}

export async function onRequest({ request, env }) {
  if (!await authorizeAdmin(request, env)) return new Response("Not found", { status: 404, headers });
  if (!env.CONSULT_DB) return page("일시적으로 사용할 수 없습니다.", "", 503);
  const url = new URL(request.url), id = url.searchParams.get("id");
  if (id !== null && !uuid.test(id)) return page("신청을 찾을 수 없습니다.", "", 404);
  const now = new Date().toISOString();
  try {
    const db = env.CONSULT_DB.withSession("first-primary");
    if (request.method === "GET") return id ? await detail(db, id, now, url.searchParams.get("download") === "1") : await list(db, new URLSearchParams(), now);
    if (request.method === "POST") {
      const form = await readForm(request);
      if (form instanceof Response) return form;
      return id ? await mutate(form, db, id, now, env) : await list(db, form, now);
    }
    return page("지원하지 않는 요청입니다.", "", 405);
  } catch {
    return page("일시적으로 사용할 수 없습니다.", "", 503);
  }
}
