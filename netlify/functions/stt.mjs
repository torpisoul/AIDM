const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const DEFAULT_MODEL_ID = "scribe_v1";
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

function providerMessage(responseText, apiKey) {
  try {
    const body = JSON.parse(responseText);
    const detail = body?.detail;
    const code = typeof detail?.status === "string" ? detail.status : "";
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

function audioExtension(contentType) {
  if (contentType.includes("mp4")) return "mp4";
  if (contentType.includes("ogg")) return "ogg";
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return "mp3";
  return "webm";
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

    const contentType = (event.headers?.["content-type"] ?? event.headers?.["Content-Type"] ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!contentType.startsWith("audio/")) {
      return jsonResponse(415, { error: "Content-Type must be an audio format recorded by the browser." }, corsHeaders ?? {});
    }

    const apiKey = env.ELEVENLABS_API_KEY?.trim();
    if (!apiKey) {
      return jsonResponse(503, { error: "Speech transcription is not configured. Add ELEVENLABS_API_KEY to the Netlify environment variables." }, corsHeaders ?? {});
    }

    const audio = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64")
      : Buffer.from(event.body ?? "", "binary");
    if (audio.length > MAX_AUDIO_BYTES) {
      return jsonResponse(413, { error: "Audio must be 4 MB or smaller." }, corsHeaders ?? {});
    }
    if (!audio.length) {
      return jsonResponse(400, { error: "Audio is empty. Hold the button while speaking, then release to send." }, corsHeaders ?? {});
    }

    try {
      const form = new FormData();
      form.append("file", new Blob([audio], { type: contentType }), `player-turn.${audioExtension(contentType)}`);
      form.append("model_id", env.ELEVENLABS_STT_MODEL_ID?.trim() || DEFAULT_MODEL_ID);

      const upstream = await fetchImpl("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });

      if (!upstream.ok) {
        const detail = providerMessage((await upstream.text()).slice(0, 4_096), apiKey);
        const reason = `ElevenLabs transcription returned HTTP ${upstream.status}`
          + (detail.code ? ` (${detail.code})` : "")
          + (detail.message ? `: ${detail.message}` : "");
        const statusCode = upstream.status === 402 || upstream.status === 429 ? upstream.status : 502;
        console.error(`ElevenLabs transcription returned HTTP ${upstream.status}${detail.code ? ` (${detail.code})` : ""}`);
        return jsonResponse(statusCode, {
          error: upstream.status === 402
            ? `${reason}. Check your account's speech-to-text access and credits.`
            : upstream.status === 429
              ? `${reason}. Check the account's remaining credits or rate limit.`
              : `${reason}. Check the API key and transcription model settings.`,
        }, corsHeaders ?? {});
      }

      const result = await upstream.json();
      if (typeof result.text !== "string" || !result.text.trim()) {
        return jsonResponse(422, { error: "No speech was recognized. Speak clearly and try again." }, corsHeaders ?? {});
      }
      return jsonResponse(200, { text: result.text.trim() }, corsHeaders ?? {});
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        return jsonResponse(504, { error: "Speech transcription took too long. Please try again." }, corsHeaders ?? {});
      }
      console.error("ElevenLabs transcription request failed:", error.message);
      return jsonResponse(502, { error: "Could not reach the speech transcription service. Check the service connection and try again." }, corsHeaders ?? {});
    }
  };
}

export const handler = createHandler();
