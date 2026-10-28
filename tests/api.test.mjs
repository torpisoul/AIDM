import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApiServer } from "../server/index.mjs";

const validDMRequest = {
  action: "I follow the lantern into the woods.",
  player: { name: "Aria", character: "Liora · Elf Ranger" },
  story: {
    premise: "A silent village and a missing child.",
    scene: "The forest road at dusk.",
    style: "Atmospheric and concise.",
    notes: "A lantern flickered near the old stones.",
  },
  history: [{ role: "player", text: "I look for tracks." }, { role: "dm", text: "Small prints head north." }],
};

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
    GEMINI_API_KEY: "test-gemini-key",
    GEMINI_MODEL_ID: "gemini-3.5-flash-lite",
    TTS_ALLOWED_ORIGINS: "http://127.0.0.1:5173,http://localhost:5173",
  };
  server = createApiServer({
    env,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      if (url === "https://api.elevenlabs.io/v1/speech-to-text") {
        return Response.json({ text: "I follow the footprints" });
      }
      if (url.includes(":generateContent")) {
        return Response.json({ candidates: [{ content: { parts: [{ text: "The lantern drifts between the trees. What do you do?" }] } }] });
      }
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
  assert.deepEqual(await response.json(), { ttsConfigured: true, sttConfigured: true, dmConfigured: true });
});

test("generates a dynamic DM response with authored context and recent story history", async () => {
  const response = await fetch(`${baseUrl}/api/dm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify(validDMRequest),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    text: "The lantern drifts between the trees. What do you do?",
  });
  const request = fetchCalls.find((call) => call.url.includes(":generateContent"));
  assert.ok(request);
  assert.equal(request.options.headers["x-goog-api-key"], "test-gemini-key");
  assert.equal(request.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
  const body = JSON.parse(request.options.body);
  assert.match(body.systemInstruction.parts[0].text, /A silent village and a missing child/);
  assert.match(body.systemInstruction.parts[0].text, /Atmospheric and concise/);
  assert.deepEqual(body.contents, [
    { role: "user", parts: [{ text: "I look for tracks." }] },
    { role: "model", parts: [{ text: "Small prints head north." }] },
    {
      role: "user",
      parts: [{ text: "Aria (Liora · Elf Ranger) takes this action:\nI follow the lantern into the woods.\n\nContinue the adventure in response." }],
    },
  ]);
});

test("validates DM turns before calling Gemini", async () => {
  const beforeCalls = fetchCalls.length;
  const missingAction = await fetch(`${baseUrl}/api/dm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...validDMRequest, action: " " }),
  });
  assert.equal(missingAction.status, 400);
  assert.match((await missingAction.json()).error, /Action must be a non-empty string/);

  const longHistory = await fetch(`${baseUrl}/api/dm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...validDMRequest, history: Array(17).fill({ role: "player", text: "Action." }) }),
  });
  assert.equal(longHistory.status, 400);
  assert.equal(fetchCalls.length, beforeCalls);
});

test("reports missing Gemini configuration without contacting the provider", async () => {
  const unconfiguredServer = createApiServer({
    env: {},
    fetchImpl: async () => {
      throw new Error("Gemini must not be called without a configured key.");
    },
  });
  await new Promise((resolve) => unconfiguredServer.listen(0, "127.0.0.1", resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${unconfiguredServer.address().port}/api/dm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validDMRequest),
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.match(body.error, /GEMINI_API_KEY/);
  } finally {
    await new Promise((resolve, reject) => unconfiguredServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("transcribes recorded audio through ElevenLabs using server-side credentials", async () => {
  const response = await fetch(`${baseUrl}/api/stt`, {
    method: "POST",
    headers: {
      "Content-Type": "audio/webm",
      Origin: "http://127.0.0.1:5173",
    },
    body: Buffer.from("sample-audio"),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "I follow the footprints" });
  const request = fetchCalls.find((call) => call.url === "https://api.elevenlabs.io/v1/speech-to-text");
  assert.ok(request);
  assert.equal(request.options.headers["xi-api-key"], "test-secret-key");
  assert.ok(request.options.body instanceof FormData);
  assert.equal(request.options.body.get("model_id"), "scribe_v1");
  assert.equal(request.options.body.get("file").type, "audio/webm");
  assert.equal(await request.options.body.get("file").text(), "sample-audio");
});

test("rejects invalid and oversized audio before contacting ElevenLabs", async () => {
  const beforeCalls = fetchCalls.length;
  const wrongType = await fetch(`${baseUrl}/api/stt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);

  const empty = await fetch(`${baseUrl}/api/stt`, {
    method: "POST",
    headers: { "Content-Type": "audio/webm" },
  });
  assert.equal(empty.status, 400);

  const tooLarge = await fetch(`${baseUrl}/api/stt`, {
    method: "POST",
    headers: { "Content-Type": "audio/webm" },
    body: Buffer.alloc(4 * 1024 * 1024 + 1),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(fetchCalls.length, beforeCalls);
});

test("converts text to audio using only server-side voice and key configuration", async () => {
  const beforeCalls = fetchCalls.length;
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
  assert.equal(fetchCalls.length, beforeCalls + 1);
  const ttsRequest = fetchCalls.at(-1);
  assert.equal(ttsRequest.url, "https://api.elevenlabs.io/v1/text-to-speech/voice%2Ftest-id?output_format=mp3_44100_128");
  assert.equal(ttsRequest.options.headers["xi-api-key"], "test-secret-key");
  assert.deepEqual(JSON.parse(ttsRequest.options.body), {
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
