import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApiServer } from "../server/index.mjs";

let server;
let baseUrl;
let fetchCalls;
let env;

before(async () => {
  fetchCalls = [];
  env = {
    ELEVENLABS_API_KEY: "test-secret-key",
    ELEVENLABS_VOICE_ID: "voice/test-id",
    ELEVENLABS_MODEL_ID: "eleven_flash_v2_5",
    TTS_ALLOWED_ORIGINS: "http://127.0.0.1:5173,http://localhost:5173",
  };
  server = createApiServer({
    env,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return new Response(Buffer.from("fake-mp3"), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("reports whether the server has ElevenLabs credentials", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ttsConfigured: true });
});

test("converts text to audio using only server-side voice and key configuration", async () => {
  const response = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ text: "A test line.", voiceId: "attacker-selected-voice" }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "fake-mp3");
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://api.elevenlabs.io/v1/text-to-speech/voice%2Ftest-id?output_format=mp3_44100_128");
  assert.equal(fetchCalls[0].options.headers["xi-api-key"], "test-secret-key");
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    text: "A test line.",
    model_id: "eleven_flash_v2_5",
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("rejects empty or oversized narration before contacting ElevenLabs", async () => {
  const beforeCalls = fetchCalls.length;
  const empty = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "  " }),
  });
  assert.equal(empty.status, 400);

  const tooLong = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "x".repeat(5_001) }),
  });
  assert.equal(tooLong.status, 413);
  assert.equal(fetchCalls.length, beforeCalls);
});

test("returns a clear configuration error without exposing credentials", async () => {
  env.ELEVENLABS_API_KEY = "";
  const response = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Hello." }),
  });
  const body = await response.text();

  assert.equal(response.status, 503);
  assert.match(body, /ELEVENLABS_API_KEY/);
  assert.doesNotMatch(body, /test-secret-key/);
  env.ELEVENLABS_API_KEY = "test-secret-key";
});

test("rejects cross-origin calls", async () => {
  const response = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://attacker.example",
    },
    body: JSON.stringify({ text: "Hello." }),
  });

  assert.equal(response.status, 403);
});

test("rejects unconfigured origins, including other local dev ports", async () => {
  const response = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:5174",
    },
    body: JSON.stringify({ text: "Hello." }),
  });

  assert.equal(response.status, 403);
});

test("allows the configured localhost Vite origin", async () => {
  const response = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:5173",
    },
    body: JSON.stringify({ text: "Hello from Vite." }),
  });

  assert.equal(response.status, 200);
});

test("returns sanitized provider error details without exposing credentials", async () => {
  const serverWithError = createApiServer({
    env: {
      ELEVENLABS_API_KEY: "private-key",
      ELEVENLABS_VOICE_ID: "test-voice",
    },
    fetchImpl: async () => new Response(JSON.stringify({
      detail: {
        status: "voice_not_found",
        message: "Voice unavailable for this account; secret private-key",
      },
    }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }),
  });
  await new Promise((resolve) => serverWithError.listen(0, "127.0.0.1", resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${serverWithError.address().port}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello." }),
    });
    const body = await response.text();

    assert.equal(response.status, 502);
    assert.match(body, /HTTP 403/);
    assert.match(body, /voice_not_found/);
    assert.match(body, /Voice unavailable for this account/);
    assert.match(body, /redacted/);
    assert.doesNotMatch(body, /private-key/);
  } finally {
    await new Promise((resolve, reject) => serverWithError.close((error) => error ? reject(error) : resolve()));
  }
});

test("preserves ElevenLabs payment-required status and guidance", async () => {
  const paymentServer = createApiServer({
    env: {
      ELEVENLABS_API_KEY: "private-key",
      ELEVENLABS_VOICE_ID: "library-voice",
    },
    fetchImpl: async () => new Response(JSON.stringify({
      detail: {
        status: "payment_required",
        message: "Free users cannot use library voices via the API.",
      },
    }), {
      status: 402,
      headers: { "Content-Type": "application/json" },
    }),
  });
  await new Promise((resolve) => paymentServer.listen(0, "127.0.0.1", resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${paymentServer.address().port}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello." }),
    });
    const body = await response.json();

    assert.equal(response.status, 402);
    assert.match(body.error, /payment_required/);
    assert.match(body.error, /Free users cannot use library voices/);
    assert.match(body.error, /Add API credits or upgrade/);
  } finally {
    await new Promise((resolve, reject) => paymentServer.close((error) => error ? reject(error) : resolve()));
  }
});
