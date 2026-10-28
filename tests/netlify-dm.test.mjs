import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandler } from "../netlify/functions/dm.mjs";

const env = {
  GEMINI_API_KEY: "test-gemini-key",
  GEMINI_MODEL_ID: "gemini-3.5-flash-lite",
  TTS_ALLOWED_ORIGINS: "https://torpisoul.github.io",
};

const payload = {
  action: "I open the brass door.",
  player: { name: "Mira", character: "Pip · Halfling Bard" },
  story: {
    premise: "A lost observatory moves through the woods.",
    scene: "The party stands at a brass door.",
    style: "Whimsical and mysterious.",
    notes: "The door has three rotating rings.",
  },
  history: [{ role: "player", text: "I inspect the rings." }, { role: "dm", text: "They turn beneath your fingers." }],
};

test("Netlify DM function generates a response and keeps its API key server-side", async () => {
  let upstreamRequest;
  const handler = createHandler({
    env,
    fetchImpl: async (url, options) => {
      upstreamRequest = { url, options };
      return Response.json({
        candidates: [{ content: { parts: [{ text: "The door opens onto a night sky full of stars. Where do you go?" }] } }],
      });
    },
  });
  const response = await handler({
    httpMethod: "POST",
    headers: {
      origin: "https://torpisoul.github.io",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Access-Control-Allow-Origin"], "https://torpisoul.github.io");
  assert.deepEqual(JSON.parse(response.body), {
    text: "The door opens onto a night sky full of stars. Where do you go?",
  });
  assert.equal(upstreamRequest.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
  assert.equal(upstreamRequest.options.headers["x-goog-api-key"], "test-gemini-key");
  const upstreamBody = JSON.parse(upstreamRequest.options.body);
  assert.match(upstreamBody.systemInstruction.parts[0].text, /A lost observatory moves through the woods/);
  assert.equal(upstreamBody.generationConfig.maxOutputTokens, 300);
});

test("Netlify DM function combines party actions and passes into one Gemini turn", async () => {
  let upstreamRequest;
  const handler = createHandler({
    env,
    fetchImpl: async (_url, options) => {
      upstreamRequest = options;
      return Response.json({
        candidates: [{ content: { parts: [{ text: "The party approaches the door together." }] } }],
      });
    },
  });
  const response = await handler({
    httpMethod: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      responses: [
        { player: { name: "Aria", character: "Liora · Elf Ranger" }, action: "I inspect the tracks." },
        { player: { name: "Bren", character: "Thorne · Human Fighter" }, action: null },
        { player: { name: "Mira", character: "Pip · Halfling Bard" }, action: "I listen at the door." },
        { player: { name: "Rowan", character: "Kael · Tiefling Warlock" }, action: null },
      ],
      story: payload.story,
      history: payload.history,
    }),
  });

  assert.equal(response.statusCode, 200);
  const finalPrompt = JSON.parse(upstreamRequest.body).contents.at(-1).parts[0].text;
  assert.match(finalPrompt, /Aria \(Liora · Elf Ranger\): I inspect the tracks\./);
  assert.match(finalPrompt, /Bren \(Thorne · Human Fighter\): does nothing this turn\./);
  assert.match(finalPrompt, /Mira \(Pip · Halfling Bard\): I listen at the door\./);
  assert.match(finalPrompt, /Rowan \(Kael · Tiefling Warlock\): does nothing this turn\./);
  assert.match(finalPrompt, /combined choices/);
});

test("Netlify DM function includes a single shared intention after unanimous group choices", async () => {
  let upstreamRequest;
  const handler = createHandler({
    env,
    fetchImpl: async (_url, options) => {
      upstreamRequest = options;
      return Response.json({
        candidates: [{ content: { parts: [{ text: "The party follows the lantern together." }] } }],
      });
    },
  });
  const response = await handler({
    httpMethod: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      responses: ["Aria", "Bren", "Mira", "Rowan"].map((name) => ({
        player: { name, character: "Adventurer" },
        action: null,
        choice: "group",
      })),
      groupAction: "We follow the lantern north.",
      story: payload.story,
      history: payload.history,
    }),
  });

  assert.equal(response.statusCode, 200);
  const finalPrompt = JSON.parse(upstreamRequest.body).contents.at(-1).parts[0].text;
  assert.equal((finalPrompt.match(/joins the group's shared intention/g) ?? []).length, 4);
  assert.match(finalPrompt, /Speaking for the party, one player says:\nWe follow the lantern north\./);
});

test("Netlify DM function handles CORS, invalid payloads, and missing configuration", async () => {
  const handler = createHandler({ env });
  const preflight = await handler({
    httpMethod: "OPTIONS",
    headers: { origin: "https://torpisoul.github.io" },
  });
  assert.equal(preflight.statusCode, 204);

  const wrongOrigin = await handler({
    httpMethod: "POST",
    headers: { origin: "https://attacker.example", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(wrongOrigin.statusCode, 403);

  const invalid = await handler({
    httpMethod: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, action: "" }),
  });
  assert.equal(invalid.statusCode, 400);

  const invalidPartyResponse = await handler({
    httpMethod: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...payload,
      responses: [
        { player: { name: "Aria", character: "Ranger" }, action: "x".repeat(501) },
        { player: { name: "Bren", character: "Fighter" }, action: null },
        { player: { name: "Mira", character: "Bard" }, action: null },
        { player: { name: "Rowan", character: "Warlock" }, action: null },
      ],
    }),
  });
  assert.equal(invalidPartyResponse.statusCode, 400);

  const incompletePartyRound = await handler({
    httpMethod: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...payload,
      responses: [{ player: { name: "Aria", character: "Ranger" }, action: "I look around." }],
    }),
  });
  assert.equal(incompletePartyRound.statusCode, 400);
  assert.match(JSON.parse(incompletePartyRound.body).error, /exactly 4 responses/);

  const missingGroupAction = await handler({
    httpMethod: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...payload,
      responses: ["Aria", "Bren", "Mira", "Rowan"].map((name) => ({
        player: { name, character: "Adventurer" },
        action: null,
        choice: "group",
      })),
    }),
  });
  assert.equal(missingGroupAction.statusCode, 400);
  assert.match(JSON.parse(missingGroupAction.body).error, /group action is required/);

  const unconfigured = createHandler({ env: {} });
  const missingKey = await unconfigured({
    httpMethod: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(missingKey.statusCode, 503);
  assert.match(JSON.parse(missingKey.body).error, /GEMINI_API_KEY/);
});
