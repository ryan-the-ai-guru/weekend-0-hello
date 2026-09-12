/**
 * Contact form handler for the Kroonenburg Family Office site.
 *
 * POST /contact  { name, email, organisation?, topic?, message, company_website? }
 *
 * Validates the submission, drops honeypot hits, applies a per-IP rate limit,
 * persists the enquiry to DynamoDB and notifies the office by email via SES.
 *
 * The AWS SDK v3 is provided by the managed Node.js runtime, so this function
 * needs no bundling step.
 */

import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { randomUUID, createHash } from "node:crypto";

const dynamo = new DynamoDBClient({});
const ses = new SESv2Client({});

const TABLE = process.env.TABLE_NAME;
const SENDER = process.env.SENDER_EMAIL;
const RECIPIENT = process.env.RECIPIENT_EMAIL;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || "365");
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || "5");
const RATE_LIMIT_WINDOW_SECONDS = Number(
  process.env.RATE_LIMIT_WINDOW_SECONDS || "3600",
);

const LIMITS = {
  name: 120,
  email: 254,
  organisation: 160,
  topic: 40,
  message: 5000,
};

const TOPIC_LABELS = {
  general: "General enquiry",
  "executive-assistant": "Executive Assistant",
  cfo: "Chief Financial Officer",
  "chief-counsel": "Chief Counsel",
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Control characters to strip from user input (keeps tab and newline). */
const CONTROL_CHARS = new RegExp(
  "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]",
  "g",
);

function corsHeaders(origin) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "3600",
  };
  // Echo the origin only when it is on the allow list; "*" opts out of the check.
  if (ALLOWED_ORIGINS.includes("*")) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function respond(statusCode, body, origin) {
  return {
    statusCode,
    headers: corsHeaders(origin),
    body: JSON.stringify(body),
  };
}

/** Trim, drop control characters and cap length. */
function clean(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_CHARS, "").trim().slice(0, maxLength);
}

/** Strip CR/LF so user input can never inject extra email headers. */
function headerSafe(value) {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function validate(input) {
  const errors = [];
  if (!input.name) errors.push("name is required");
  if (!input.email) {
    errors.push("email is required");
  } else if (!EMAIL_PATTERN.test(input.email)) {
    errors.push("email is not a valid address");
  }
  if (!input.message) {
    errors.push("message is required");
  } else if (input.message.length < 10) {
    errors.push("message is too short");
  }
  return errors;
}

/**
 * Per-IP fixed-window counter. The counter item carries a TTL so windows expire
 * without a cleanup job; the conditional update rejects the write once the cap
 * is reached.
 */
async function withinRateLimit(clientIp) {
  if (!clientIp || RATE_LIMIT_MAX <= 0) return true;

  const bucket = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS);
  // Hash the address: the limiter needs a stable key, not the IP itself.
  const key = createHash("sha256").update(clientIp).digest("hex").slice(0, 32);
  const expiresAt = (bucket + 2) * RATE_LIMIT_WINDOW_SECONDS;

  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: { pk: { S: `rate#${key}#${bucket}` } },
        UpdateExpression: "ADD #count :one SET #ttl = :ttl",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
        ExpressionAttributeNames: { "#count": "count", "#ttl": "expiresAt" },
        ExpressionAttributeValues: {
          ":one": { N: "1" },
          ":max": { N: String(RATE_LIMIT_MAX) },
          ":ttl": { N: String(expiresAt) },
        },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    // A limiter failure must not take the form down.
    console.error("rate limit check failed", error);
    return true;
  }
}

async function notifyOffice(submission) {
  if (!SENDER || !RECIPIENT) {
    console.warn("SENDER_EMAIL or RECIPIENT_EMAIL unset - skipping email");
    return;
  }

  const topicLabel = TOPIC_LABELS[submission.topic] || TOPIC_LABELS.general;
  const rows = [
    ["Name", submission.name],
    ["Email", submission.email],
    ["Organisation", submission.organisation || "-"],
    ["For", topicLabel],
    ["Received", submission.receivedAt],
    ["Reference", submission.id],
  ];

  const text = [
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    "Message:",
    submission.message,
  ].join("\n");

  const html = `<!doctype html><html><body style="font-family:Georgia,serif;color:#1c1710">
<h2 style="margin:0 0 1rem">Website enquiry - ${escapeHtml(topicLabel)}</h2>
<table cellpadding="6" style="border-collapse:collapse;font-size:14px">
${rows
  .map(
    ([label, value]) =>
      `<tr><td style="color:#6a5d4a">${escapeHtml(label)}</td><td>${escapeHtml(
        value,
      )}</td></tr>`,
  )
  .join("\n")}
</table>
<p style="white-space:pre-wrap;margin-top:1.25rem">${escapeHtml(
    submission.message,
  )}</p>
</body></html>`;

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: SENDER,
      Destination: { ToAddresses: [RECIPIENT] },
      // Replying to the notification reaches the enquirer directly.
      ReplyToAddresses: [headerSafe(submission.email)],
      Content: {
        Simple: {
          Subject: {
            Data: headerSafe(
              `Website enquiry - ${topicLabel} - ${submission.name}`,
            ).slice(0, 200),
            Charset: "UTF-8",
          },
          Body: {
            Text: { Data: text, Charset: "UTF-8" },
            Html: { Data: html, Charset: "UTF-8" },
          },
        },
      },
    }),
  );
}

export const handler = async (event) => {
  const headers = event?.headers || {};
  const origin = headers.origin || headers.Origin || "";
  const method =
    event?.requestContext?.http?.method || event?.httpMethod || "POST";

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }

  if (method !== "POST") {
    return respond(405, { message: "Method not allowed." }, origin);
  }

  const originEnforced = ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes("*");
  if (originEnforced && origin && !ALLOWED_ORIGINS.includes(origin)) {
    return respond(403, { message: "Origin not allowed." }, origin);
  }

  let body;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "{}";
    body = JSON.parse(raw);
  } catch {
    return respond(400, { message: "Malformed request body." }, origin);
  }

  // Honeypot: a real browser leaves this empty. Answer 200 so bots learn nothing.
  if (clean(body.company_website, 200)) {
    return respond(
      200,
      { message: "Thank you - your message has been received." },
      origin,
    );
  }

  const topic = clean(body.topic, LIMITS.topic);
  const input = {
    name: clean(body.name, LIMITS.name),
    email: clean(body.email, LIMITS.email).toLowerCase(),
    organisation: clean(body.organisation, LIMITS.organisation),
    topic: Object.hasOwn(TOPIC_LABELS, topic) ? topic : "general",
    message: clean(body.message, LIMITS.message),
  };

  const errors = validate(input);
  if (errors.length) {
    return respond(
      400,
      { message: "Please check the form and try again.", errors },
      origin,
    );
  }

  const clientIp = event?.requestContext?.http?.sourceIp || "";
  if (!(await withinRateLimit(clientIp))) {
    return respond(
      429,
      { message: "Too many messages from this address. Please try again later." },
      origin,
    );
  }

  const submission = {
    ...input,
    id: randomUUID(),
    receivedAt: new Date().toISOString(),
  };

  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: {
          pk: { S: `enquiry#${submission.id}` },
          id: { S: submission.id },
          receivedAt: { S: submission.receivedAt },
          name: { S: submission.name },
          email: { S: submission.email },
          organisation: { S: submission.organisation || "" },
          topic: { S: submission.topic },
          message: { S: submission.message },
          userAgent: {
            S: clean(headers["user-agent"] || headers["User-Agent"], 400),
          },
          expiresAt: {
            N: String(
              Math.floor(Date.now() / 1000) + RETENTION_DAYS * 24 * 60 * 60,
            ),
          },
        },
      }),
    );
  } catch (error) {
    console.error("failed to persist enquiry", error);
    return respond(
      502,
      { message: "Your message could not be recorded. Please email the office." },
      origin,
    );
  }

  try {
    await notifyOffice(submission);
  } catch (error) {
    // The enquiry is already stored, so this is degraded, not failed.
    console.error("failed to send notification email", error);
  }

  return respond(
    201,
    {
      message: "Thank you - your message has reached the office.",
      id: submission.id,
    },
    origin,
  );
};
