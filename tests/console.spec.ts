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

test("records a player's voice, transcribes it, resolves the action, and voices the DM reply", async ({ page }) => {
  let ttsRequestBody: { text: string } | undefined;
  let sttRequest: { contentType: string; byteLength: number } | undefined;
  let dmRequestBody: { action: string; story: { premise: string }; history: unknown[] } | undefined;
  await page.route("**/api/stt", async (route) => {
    sttRequest = {
      contentType: route.request().headers()["content-type"],
      byteLength: route.request().postDataBuffer()?.length ?? 0,
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "I follow the footprints" }) });
  });
  await page.route("**/api/dm", async (route) => {
    dmRequestBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: "The lantern bobs toward the standing stones. Do you follow it?" }),
    });
  });
  await page.route("**/api/tts", async (route) => {
    ttsRequestBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "audio/wav", body: narrationAudio });
  });
  await page.addInitScript(() => {
    class TestRecorder {
      state = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onerror: (() => void) | null = null;
      onstop: (() => void) | null = null;
      static isTypeSupported() {
        return true;
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["test voice audio"], { type: this.mimeType }) });
        this.onstop?.();
      }
    }

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
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
  await ariaButton.dispatchEvent("pointerleave", { pointerId: 1, pointerType: "mouse" });
  await expect(page.getByText("Listening to")).toBeVisible();
  await expect(brenButton).toBeDisabled();
  await ariaButton.dispatchEvent("pointerup", { pointerId: 1, pointerType: "mouse", button: 0 });
  await expect.poll(() => sttRequest?.byteLength).toBeGreaterThan(0);
  expect(sttRequest?.contentType).toContain("audio/webm");
  await expect(page.getByText("I follow the footprints", { exact: false })).toBeVisible();
  await expect(page.getByText("The lantern bobs toward the standing stones", { exact: false })).toBeVisible();
  await expect.poll(() => dmRequestBody?.action).toBe("I follow the footprints");
  expect(dmRequestBody?.story.premise).toContain("Briar Glen");
  expect(dmRequestBody?.history.length).toBeGreaterThan(0);
  await expect.poll(() => ttsRequestBody?.text).toContain("Do you follow it?");
  await expect(brenButton).toBeDisabled();
  await page.getByLabel("Dungeon Master narration audio").evaluate((element) => {
    (element as HTMLAudioElement).pause();
  });
  await expect(brenButton).toBeEnabled();
});

test("reports unavailable microphone access and preserves text input", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Push to talk as Aria" }).dispatchEvent("pointerdown", {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
  });
  await expect(page.getByText(/Microphone access is not available in this browser/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Push to talk as Aria" })).toBeEnabled();
});

test("shows transcription service errors and unlocks the player controls", async ({ page }) => {
  await page.route("**/api/stt", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "Speech transcription is not configured." }),
  }));
  await page.addInitScript(() => {
    class TestRecorder {
      state = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onerror: (() => void) | null = null;
      onstop: (() => void) | null = null;
      static isTypeSupported() {
        return true;
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["test voice audio"], { type: this.mimeType }) });
        this.onstop?.();
      }
    }

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    });
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: TestRecorder });
  });

  await page.goto("/");
  const ariaButton = page.getByRole("button", { name: "Push to talk as Aria" });
  await ariaButton.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "mouse", button: 0 });
  await expect(page.getByText("MIC ON")).toBeVisible();
  await ariaButton.dispatchEvent("pointerup", { pointerId: 1, pointerType: "mouse", button: 0 });
  await expect(page.getByText("Speech transcription is not configured.")).toBeVisible();
  await expect(ariaButton).toBeEnabled();
});

test("submits a text action to the session feed", async ({ page }) => {
  let ttsRequestBody: { text: string } | undefined;
  let dmRequestBody: { action: string; story: { scene: string; style: string } } | undefined;
  await page.route("**/api/dm", async (route) => {
    dmRequestBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: "The stones whisper your name. How do you answer?" }),
    });
  });
  await page.route("**/api/tts", async (route) => {
    ttsRequestBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "audio/wav", body: narrationAudio });
  });
  await page.goto("/");
  await page.getByRole("textbox", { name: "Current scene" }).fill("A brass observatory door stands in the forest.");
  await page.getByRole("textbox", { name: "DM style and tone" }).fill("Playful, eerie, and full of sensory detail.");
  await page.getByRole("textbox", { name: "Action or question" }).fill("I inspect the standing stones.");
  await page.getByRole("button", { name: "Send action" }).click();

  await expect(page.getByText("I inspect the standing stones.")).toBeVisible();
  await expect(page.getByText("The stones whisper your name", { exact: false })).toBeVisible();
  await expect.poll(() => dmRequestBody?.action).toBe("I inspect the standing stones.");
  expect(dmRequestBody?.story.scene).toBe("A brass observatory door stands in the forest.");
  expect(dmRequestBody?.story.style).toBe("Playful, eerie, and full of sensory detail.");
  await expect.poll(() => ttsRequestBody?.text).toContain("How do you answer?");
});

test("saves editable DM story context in browser storage", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Campaign premise" })).toBeVisible();
  await page.getByRole("textbox", { name: "Campaign premise" }).fill("A clockwork forest hides a lost observatory.");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("emberkeep.story-settings.v1")))
    .toContain("A clockwork forest hides a lost observatory.");

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Campaign premise" }))
    .toHaveValue("A clockwork forest hides a lost observatory.");
  await expect(page.getByText("A clockwork forest hides a lost observatory.")).toBeVisible();
});

test("surfaces AI DM errors without a deterministic fallback", async ({ page }) => {
  let ttsCalled = false;
  await page.route("**/api/dm", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "Set GEMINI_API_KEY in the server .env file." }),
  }));
  await page.route("**/api/tts", (route) => {
    ttsCalled = true;
    return route.fulfill({ status: 200, contentType: "audio/wav", body: narrationAudio });
  });
  await page.goto("/");
  await page.getByRole("textbox", { name: "Action or question" }).fill("I open the door.");
  await page.getByRole("button", { name: "Send action" }).click();
  await expect(page.getByText("Set GEMINI_API_KEY in the server .env file.")).toBeVisible();
  expect(ttsCalled).toBe(false);
  await expect(page.getByRole("button", { name: "Push to talk as Aria" })).toBeEnabled();
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
