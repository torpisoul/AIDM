const MAX_BODY_BYTES = 16_384;
const MAX_TEXT_LENGTH = 5_000;
const DEFAULT_MODEL_ID = "eleven_flash_v2_5";
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

function getProviderError(responseText, apiKey) {
  try {
    const body = JSON.parse(responseText);
    const detail = body?.detail;
    const code = typeof detail?.status === "string"
      ? detail.status
      : typeof body?.code === "string"
        ? body.code
        : "";
    const rawMessage = typeof detail?.message === "string"
      ? detail.message
      : typeof detail === "string"
        ? detail
        : typeof body?.message === "string"
          ? body.message
          : "";
    const message = rawMessage
      .replaceAll(apiKey, "[redacted]")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    return { code, message };
  } catch {
    return { code: "", message: "" };
  }
}

async function generateSpeech({ text, env = process.env, fetchImpl = globalThis.fetch }) {
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  const voiceId = env.ELEVENLABS_VOICE_ID?.trim();
  if (!apiKey || !voiceId) {
    return {
      statusCode: 503,
      body: { error: "ElevenLabs is not configured. Add ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID to the Netlify environment variables." },
    };
  }

  if (typeof text !== "string" || !text.trim()) {
    return { statusCode: 400, body: { error: "Text must be a non-empty string." } };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES || text.length > MAX_TEXT_LENGTH) {
    return { statusCode: 413, body: { error: `Text must be ${MAX_TEXT_LENGTH} characters or fewer.` } };
  }

  try {
    const upstream = await fetchImpl(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: text.trim(),
          model_id: env.ELEVENLABS_MODEL_ID?.trim() || DEFAULT_MODEL_ID,
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );

    if (!upstream.ok) {
      const providerError = getProviderError((await upstream.text()).slice(0, 4_096), apiKey);
      const reason = `ElevenLabs returned HTTP ${upstream.status}`
        + (providerError.code ? ` (${providerError.code})` : "")
        + (providerError.message ? `: ${providerError.message}` : "");
      const status = upstream.status === 402 || upstream.status === 429 ? upstream.status : 502;
      const guidance = upstream.status === 402
        ? " Add API credits or upgrade the account plan to use this voice through the API."
        : upstream.status === 401 || upstream.status === 403
          ? " Check API key permissions, voice access, and account eligibility for this model."
          : upstream.status === 429
            ? " Check remaining credits or rate limits."
            : " Verify the voice and model settings, then try again.";
      console.error(`ElevenLabs TTS request returned HTTP ${upstream.status}${providerError.code ? ` (${providerError.code})` : ""}`);
      return { statusCode: status, body: { error: `${reason}.${guidance}` } };
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    if (!audio.length) {
      return { statusCode: 502, body: { error: "ElevenLabs returned an empty audio response." } };
    }
    return { statusCode: 200, body: audio.toString("base64"), isBase64Encoded: true };
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return { statusCode: 504, body: { error: "ElevenLabs took too long to generate speech. Please try again." } };
    }
    console.error("ElevenLabs TTS request failed:", error.message);
    return { statusCode: 502, body: { error: "Could not reach ElevenLabs. Check the service connection and try again." } };
  }
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

    let payload;
    try {
      const body = event.isBase64Encoded
        ? Buffer.from(event.body ?? "", "base64").toString("utf8")
        : event.body ?? "";
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        return jsonResponse(413, { error: "Request body is too large." }, corsHeaders ?? {});
      }
      payload = JSON.parse(body);
    } catch {
      return jsonResponse(400, { error: "Request body must be valid JSON." }, corsHeaders ?? {});
    }

    const result = await generateSpeech({ text: payload.text, env, fetchImpl });
    if (result.isBase64Encoded) {
      return {
        statusCode: result.statusCode,
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          ...(corsHeaders ?? {}),
        },
        body: result.body,
        isBase64Encoded: true,
      };
    }
    return jsonResponse(result.statusCode, result.body, corsHeaders ?? {});
  };
}

export const handler = createHandler();
export const _test = { generateSpeech, originHeaders, createHandler };
