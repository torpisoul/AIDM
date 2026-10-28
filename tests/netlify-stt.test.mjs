import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandler } from "../netlify/functions/stt.mjs";

const env = {
  ELEVENLABS_API_KEY: "test-secret-key",
  TTS_ALLOWED_ORIGINS: "https://torpisoul.github.io",
};

test("Netlify STT function transcribes audio and keeps credentials server-side", async () => {
  let upstreamRequest;
  const handler = createHandler({
    env,
    fetchImpl: async (url, options) => {
      upstreamRequest = { url, options };
      return Response.json({ text: "I follow the footprints" });
    },
  });
  const audio = Buffer.from("sample-audio");
  const response = await handler({
    httpMethod: "POST",
    headers: {
      origin: "https://torpisoul.github.io",
      "content-type": "audio/webm",
    },
    body: audio.toString("base64"),
    isBase64Encoded: true,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Access-Control-Allow-Origin"], "https://torpisoul.github.io");
  assert.deepEqual(JSON.parse(response.body), { text: "I follow the footprints" });
  assert.equal(upstreamRequest.url, "https://api.elevenlabs.io/v1/speech-to-text");
  assert.equal(upstreamRequest.options.headers["xi-api-key"], "test-secret-key");
  assert.ok(upstreamRequest.options.body instanceof FormData);
  assert.equal(upstreamRequest.options.body.get("model_id"), "scribe_v1");
  assert.equal(await upstreamRequest.options.body.get("file").text(), "sample-audio");
});

test("Netlify STT function handles CORS and rejects invalid audio", async () => {
  const handler = createHandler({ env });
  const preflight = await handler({
    httpMethod: "OPTIONS",
    headers: { origin: "https://torpisoul.github.io" },
  });
  assert.equal(preflight.statusCode, 204);

  const wrongOrigin = await handler({
    httpMethod: "POST",
    headers: { origin: "https://attacker.example", "content-type": "audio/webm" },
    body: Buffer.from("audio").toString("base64"),
    isBase64Encoded: true,
  });
  assert.equal(wrongOrigin.statusCode, 403);

  const empty = await handler({
    httpMethod: "POST",
    headers: { origin: "https://torpisoul.github.io", "content-type": "audio/webm" },
    body: "",
    isBase64Encoded: true,
  });
  assert.equal(empty.statusCode, 400);

  const tooLarge = await handler({
    httpMethod: "POST",
    headers: { origin: "https://torpisoul.github.io", "content-type": "audio/webm" },
    body: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64"),
    isBase64Encoded: true,
  });
  assert.equal(tooLarge.statusCode, 413);
});
