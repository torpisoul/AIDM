import "dotenv/config";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.PORT ?? 3001);
const MAX_BODY_BYTES = 16_384;
const MAX_TEXT_LENGTH = 5_000;
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5";
const DEFAULT_ALLOWED_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];
const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim();

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
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

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

function isAllowedBrowserOrigin(request, env) {
  const origin = request.headers.origin;
  if (!origin) return true;

  try {
    const originUrl = new URL(origin);
    const allowedOrigins = (env.TTS_ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(","))
      .split(",")
      .map((allowedOrigin) => allowedOrigin.trim())
      .filter(Boolean);
    return allowedOrigins.includes(originUrl.origin);
  } catch {
    return false;
  }
}

export function createApiServer({
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  return createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");

    if (requestUrl.pathname === "/api/health" && request.method === "GET") {
      sendJson(response, 200, {
        ttsConfigured: Boolean(env.ELEVENLABS_API_KEY?.trim() && env.ELEVENLABS_VOICE_ID?.trim()),
      });
      return;
    }

    if (requestUrl.pathname !== "/api/tts") {
      sendJson(response, 404, { error: "Not found." });
      return;
    }

    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }

    if (!isAllowedBrowserOrigin(request, env)) {
      sendJson(response, 403, { error: "Requests from this origin are not allowed." });
      return;
    }

    if (!request.headers["content-type"]?.toLowerCase().includes("application/json")) {
      sendJson(response, 415, { error: "Content-Type must be application/json." });
      return;
    }

    if (!env.ELEVENLABS_API_KEY?.trim() || !env.ELEVENLABS_VOICE_ID?.trim()) {
      sendJson(response, 503, {
        error: "ElevenLabs is not configured. Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in the server .env file, then restart the app.",
      });
      return;
    }

    try {
      const payload = await readJson(request);
      if (typeof payload.text !== "string" || !payload.text.trim()) {
        sendJson(response, 400, { error: "Text must be a non-empty string." });
        return;
      }
      if (payload.text.length > MAX_TEXT_LENGTH) {
        sendJson(response, 413, { error: `Text must be ${MAX_TEXT_LENGTH} characters or fewer.` });
        return;
      }

      const voiceId = env.ELEVENLABS_VOICE_ID.trim();
      const upstream = await fetchImpl(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: {
            "xi-api-key": env.ELEVENLABS_API_KEY.trim(),
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text: payload.text.trim(),
            model_id: env.ELEVENLABS_MODEL_ID?.trim() || MODEL_ID,
          }),
          signal: AbortSignal.timeout(60_000),
        },
      );

      if (!upstream.ok) {
        const upstreamError = getProviderError(
          (await upstream.text()).slice(0, 4_096),
          env.ELEVENLABS_API_KEY.trim(),
        );
        const providerReason = `ElevenLabs returned HTTP ${upstream.status}`
          + (upstreamError.code ? ` (${upstreamError.code})` : "")
          + (upstreamError.message ? `: ${upstreamError.message}` : "");
        const status = upstream.status === 402 || upstream.status === 429 ? upstream.status : 502;
        const message = upstream.status === 402
          ? `${providerReason}. Add API credits or upgrade the account plan to use this voice through the API.`
          : upstream.status === 401 || upstream.status === 403
            ? `${providerReason}. Check the API key permissions, voice access, and account eligibility for this model.`
            : upstream.status === 429
              ? `${providerReason}. Check the account's remaining credits or rate limit.`
              : `${providerReason}. Verify the voice and model settings, then try again.`;
        console.error(`ElevenLabs TTS request returned HTTP ${upstream.status}${upstreamError.code ? ` (${upstreamError.code})` : ""}${upstreamError.message ? `: ${upstreamError.message}` : ""}`);
        sendJson(response, status, { error: message });
        return;
      }

      const audio = Buffer.from(await upstream.arrayBuffer());
      if (!audio.length) {
        sendJson(response, 502, { error: "ElevenLabs returned an empty audio response." });
        return;
      }

      response.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": audio.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(audio);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }

      if (error.status) {
        sendJson(response, error.status, { error: error.message });
      } else if (error.name === "TimeoutError" || error.name === "AbortError") {
        sendJson(response, 504, { error: "ElevenLabs took too long to generate speech. Please try again." });
      } else {
        console.error("ElevenLabs TTS request failed:", error.message);
        sendJson(response, 502, { error: "Could not reach ElevenLabs. Check the server connection and try again." });
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createApiServer();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`TTS API listening on http://127.0.0.1:${PORT}`);
    if (!apiKey || !voiceId) {
      console.warn("ElevenLabs is not configured. Add ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID to .env.");
    }
  });
}
