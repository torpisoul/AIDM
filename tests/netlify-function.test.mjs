import assert from "node:assert/strict";
import { test } from "node:test";
import { _test } from "../netlify/functions/tts.mjs";

const env = {
  ELEVENLABS_API_KEY: "test-secret-key",
  ELEVENLABS_VOICE_ID: "voice/test-id",
  TTS_ALLOWED_ORIGINS: "https://torpisoul.github.io",
};

test("Netlify TTS function handles the GitHub Pages CORS preflight", async () => {
  const handler = _test.createHandler({ env });
  const response = await handler({
    httpMethod: "OPTIONS",
    headers: { origin: "https://torpisoul.github.io" },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["Access-Control-Allow-Origin"], "https://torpisoul.github.io");
  assert.equal(response.headers["Access-Control-Allow-Methods"], "POST, OPTIONS");
});

test("Netlify TTS function rejects an unapproved browser origin", async () => {
  const handler = _test.createHandler({ env });
  const response = await handler({
    httpMethod: "POST",
    headers: {
      origin: "https://attacker.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "Hello." }),
  });

  assert.equal(response.statusCode, 403);
  assert.match(JSON.parse(response.body).error, /origin are not allowed/);
});

test("Netlify TTS function returns generated audio and keeps credentials server-side", async () => {
  let upstreamRequest;
  const handler = _test.createHandler({
    env,
    fetchImpl: async (url, options) => {
      upstreamRequest = { url, options };
      return new Response(Buffer.from("fake-mp3"), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    },
  });
  const response = await handler({
    httpMethod: "POST",
    headers: {
      origin: "https://torpisoul.github.io",
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "A test line.", voiceId: "untrusted-voice" }),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Content-Type"], "audio/mpeg");
  assert.equal(response.headers["Access-Control-Allow-Origin"], "https://torpisoul.github.io");
  assert.equal(response.isBase64Encoded, true);
  assert.equal(Buffer.from(response.body, "base64").toString(), "fake-mp3");
  assert.equal(upstreamRequest.url, "https://api.elevenlabs.io/v1/text-to-speech/voice%2Ftest-id?output_format=mp3_44100_128");
  assert.equal(upstreamRequest.options.headers["xi-api-key"], "test-secret-key");
  assert.deepEqual(JSON.parse(upstreamRequest.options.body), {
    text: "A test line.",
    model_id: "eleven_flash_v2_5",
  });
});

test("Netlify TTS function rejects invalid and oversized requests before calling ElevenLabs", async () => {
  let fetchCalled = false;
  const handler = _test.createHandler({
    env,
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("Unexpected upstream request.");
    },
  });
  const request = (body) => handler({
    httpMethod: "POST",
    headers: {
      origin: "https://torpisoul.github.io",
      "content-type": "application/json",
    },
    body,
  });

  const invalid = await request("{");
  assert.equal(invalid.statusCode, 400);
  const tooLarge = await request(JSON.stringify({ text: "x".repeat(16_384) }));
  assert.equal(tooLarge.statusCode, 413);
  const empty = await request(JSON.stringify({ text: " " }));
  assert.equal(empty.statusCode, 400);
  assert.equal(fetchCalled, false);
});
