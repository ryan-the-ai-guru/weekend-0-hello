/**
 * Tests for the contact handler paths that short-circuit before any AWS call:
 * CORS preflight, method guard, origin allow list, malformed bodies, validation
 * and the honeypot. Run: npm test (from infrastructure/)
 */

import test from "node:test";
import assert from "node:assert/strict";

process.env.TABLE_NAME = "test-table";
process.env.ALLOWED_ORIGINS = "https://kroonenburg.capital";
process.env.SENDER_EMAIL = "no-reply@kroonenburg.capital";
process.env.RECIPIENT_EMAIL = "office@kroonenburg.capital";

const { handler } = await import("./index.mjs");

const ORIGIN = "https://kroonenburg.capital";

function request(body, { method = "POST", origin = ORIGIN } = {}) {
  return {
    headers: { origin, "content-type": "application/json" },
    requestContext: { http: { method, sourceIp: "203.0.113.10" } },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

const validBody = {
  name: "Jordan Vale",
  email: "Jordan.Vale@Example.com",
  organisation: "Vale Advisory",
  topic: "cfo",
  message: "We would like to discuss a co-investment opportunity.",
};

test("preflight returns 204 and echoes an allowed origin", async () => {
  const result = await handler(request(null, { method: "OPTIONS" }));
  assert.equal(result.statusCode, 204);
  assert.equal(result.headers["Access-Control-Allow-Origin"], ORIGIN);
});

test("an origin outside the allow list is rejected without echoing it", async () => {
  const result = await handler(request(validBody, { origin: "https://evil.test" }));
  assert.equal(result.statusCode, 403);
  assert.equal(result.headers["Access-Control-Allow-Origin"], undefined);
});

test("non-POST methods are refused", async () => {
  const result = await handler(request(null, { method: "GET" }));
  assert.equal(result.statusCode, 405);
});

test("malformed JSON returns 400", async () => {
  const result = await handler(request("{not json"));
  assert.equal(result.statusCode, 400);
  assert.match(JSON.parse(result.body).message, /Malformed/);
});

test("missing and invalid fields are reported", async () => {
  const result = await handler(
    request({ name: "", email: "not-an-email", message: "short" }),
  );
  assert.equal(result.statusCode, 400);
  const { errors } = JSON.parse(result.body);
  assert.deepEqual(errors, [
    "name is required",
    "email is not a valid address",
    "message is too short",
  ]);
});

test("a filled honeypot is accepted silently and never stored", async () => {
  const result = await handler(
    request({ ...validBody, company_website: "https://spam.test" }),
  );
  // 200, not the 201 a real submission returns: nothing was written.
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).id, undefined);
});

test("responses are never cached", async () => {
  const result = await handler(request("{bad"));
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(result.headers.Vary, "Origin");
});
