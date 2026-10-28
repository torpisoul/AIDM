import { generateDMResponse } from "../../server/dm.mjs";

const MAX_BODY_BYTES = 32_768;
const DEFAULT_ALLOWED_ORIGINS = ["https://torpisoul.github.io"];

function jsonResponse(statusCode, payload, headers = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
    body: JSON.stringify(payload),
  };
}

function originHeaders(origin, env) {
  if (!origin) return {};
  const allowedOrigins = (env.TTS_ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(","))
    .split(",")
    .map((allowedOrigin) => allowedOrigin.trim())
    .filter(Boolean);
  if (!allowedOrigins.includes(origin)) return null;

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function createHandler({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return async function handler(event) {
    const method = event.httpMethod ?? event.requestContext?.http?.method ?? "GET";
    const origin = event.headers?.origin ?? event.headers?.Origin;
    const corsHeaders = originHeaders(origin, env);
    if (corsHeaders === null) {
      return jsonResponse(403, { error: "Requests from this origin are not allowed." });
    }
    if (method === "OPTIONS") {
      return { statusCode: 204, headers: corsHeaders ?? {}, body: "" };
    }
    if (method !== "POST") {
      return jsonResponse(405, { error: "Method not allowed." }, { Allow: "POST, OPTIONS", ...(corsHeaders ?? {}) });
    }

    const contentType = event.headers?.["content-type"] ?? event.headers?.["Content-Type"] ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return jsonResponse(415, { error: "Content-Type must be application/json." }, corsHeaders ?? {});
    }

    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64")
      : Buffer.from(event.body ?? "", "utf8");
    if (rawBody.length > MAX_BODY_BYTES) {
      return jsonResponse(413, { error: "Request body is too large." }, corsHeaders ?? {});
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return jsonResponse(400, { error: "Request body must be valid JSON." }, corsHeaders ?? {});
    }

    const result = await generateDMResponse({ payload, env, fetchImpl });
    return jsonResponse(result.status, result.body, corsHeaders ?? {});
  };
}

export const handler = createHandler();
