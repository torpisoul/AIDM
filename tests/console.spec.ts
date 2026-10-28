import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const narrationAudio = readFileSync(fileURLToPath(new URL("../public/audio/demo-narration.wav", import.meta.url)));

test("plays real narration audio in the browser", async ({ page }) => {
  let ttsRequestBody: { text: string } | undefined;
  await page.route("**/api/tts", async (route) => {
    ttsRequestBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "audio/wav", body: narrationAudio });
  });
  await page.goto("/");
  const audio = page.getByLabel("Dungeon Master narration audio");
  await expect(audio).toHaveAttribute("src", "/audio/demo-narration.wav");
  await page.getByRole("button", { name: "Play voice demo" }).click();

  await expect.poll(() => ttsRequestBody?.text).toContain("small, hurried footprints");
  await expect(audio).toHaveAttribute("src", /^blob:/);
  await expect(audio).toHaveJSProperty("paused", false);
  await expect.poll(() => audio.evaluate((element) => (element as HTMLAudioElement).currentTime))
    .toBeGreaterThan(0.1);
  await expect(page.getByText("THE DUNGEON MASTER").last()).toBeVisible();
  await expect(page.getByText("You find a set of small, hurried footprints", { exact: false })).toBeVisible();
  await expect(page.getByText("The DM is speaking")).toBeVisible();
  await audio.evaluate((element) => (element as HTMLAudioElement).pause());
  await expect(page.getByText("Ready when you are")).toBeVisible();
});

test("keeps the active speaker locked to a single player", async ({ page }) => {
  await page.addInitScript(() => {
    class TestRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onerror: (() => void) | null = null;

      static isTypeSupported() {
        return false;
      }

      start() {
        this.state = "recording";
      }

      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"]) });
      }
    }

    const fakeTrack = { stop() {} };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [fakeTrack] }) },
    });
    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      value: TestRecorder,
    });
  });

  await page.goto("/");
  const ariaButton = page.getByRole("button", { name: "Push to talk as Aria" });
  const brenButton = page.getByRole("button", { name: "Push to talk as Bren" });

  await ariaButton.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "mouse", button: 0 });
  await expect(page.getByText("Listening to")).toBeVisible();
  await expect(brenButton).toBeDisabled();
  await ariaButton.dispatchEvent("pointerup", { pointerId: 1, pointerType: "mouse", button: 0 });
  await expect(brenButton).toBeEnabled();
  await expect(page.getByText("Transcription and the AI DM response need a configured backend.", { exact: false })).toBeVisible();
});

test("submits a text action to the session feed", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Action or question" }).fill("I inspect the standing stones.");
  await page.getByRole("button", { name: "Send action" }).click();

  await expect(page.getByText("I inspect the standing stones.")).toBeVisible();
  await expect(page.getByText("Connect a DM service to resolve the turn.", { exact: false })).toBeVisible();
});

test("mute prevents narration audio from playing", async ({ page }) => {
  await page.route("**/api/tts", (route) => route.fulfill({ status: 500, body: "Muted playback should not call TTS." }));
  await page.goto("/");
  await page.getByRole("button", { name: "Mute DM voice playback" }).click();
  const audio = page.getByLabel("Dungeon Master narration audio");
  await page.getByRole("button", { name: "Play voice demo" }).click();
  await expect(page.getByText("You find a set of small, hurried footprints", { exact: false })).toBeVisible();
  await expect(audio).toHaveJSProperty("paused", true);
  await expect(page.getByText("Unmute DM voice playback to hear it.", { exact: false })).toBeVisible();
});

test("shows backend configuration errors instead of silently playing the fallback clip", async ({ page }) => {
  await page.route("**/api/tts", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in .env." }),
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "Play voice demo" }).click();
  await expect(page.getByText("Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in .env.")).toBeVisible();
  await expect(page.getByLabel("Dungeon Master narration audio")).toHaveJSProperty("paused", true);
});

test("shows ElevenLabs account restrictions when speech generation is rejected", async ({ page }) => {
  await page.route("**/api/tts", (route) => route.fulfill({
    status: 402,
    contentType: "application/json",
    body: JSON.stringify({
      error: "ElevenLabs returned HTTP 402 (payment_required): Free users cannot use library voices via the API. Add API credits or upgrade the account plan.",
    }),
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "Play voice demo" }).click();
  await expect(page.getByText(/Free users cannot use library voices via the API/)).toBeVisible();
  await expect(page.getByLabel("Dungeon Master narration audio")).toHaveJSProperty("paused", true);
});

test("Vite proxy accepts the browser's local origin", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    return { status: response.status, body: await response.json() };
  });

  expect(result.status).toBe(400);
  expect(result.body.error).toBe("Text must be a non-empty string.");
});
