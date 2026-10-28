# Emberkeep Table Console

A shared-tablet MVP for a voice-enabled tabletop RPG session. The console
provides four player-specific push-to-talk controls, browser microphone capture,
a single active-speaker lock, a session feed, party hit-point controls, and
ElevenLabs narration playback through a local server endpoint.

## Run locally

Install dependencies and make your local environment file:

```sh
npm install
cp .env.example .env
```

Open `.env` and set your ElevenLabs credentials:

```dotenv
ELEVENLABS_API_KEY=your_api_key
ELEVENLABS_VOICE_ID=your_voice_id
ELEVENLABS_MODEL_ID=eleven_flash_v2_5
TTS_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173
```

Keep `.env` private: it is ignored by git. The API key is read by the Node server
and never sent to or embedded in the browser bundle. The default model is
`eleven_flash_v2_5`; change `ELEVENLABS_MODEL_ID` if your account uses a different
model.
The allowed origins setting permits the local Vite frontend to call the API.
For a deployed frontend, replace it with that frontend's exact origin.

Start the app and TTS server together:

```sh
npm run dev
```

Open the Vite URL printed in the terminal and press **Play voice demo**. The app
sends narration text to `POST /api/tts`; the local server calls ElevenLabs with
the configured voice and returns the generated MP3 for playback. Restart the
dev server after changing `.env`.

Microphone capture requires a secure browser context (localhost is supported)
and user permission. Hold a player's **Hold to talk** button and release it to
end capture. The captured audio stays in the browser; it is not uploaded or
transcribed. Text actions can be submitted from the same tablet.

The bundled sample audio is available in the player as a fallback. Live
microphone transcription, AI DM responses, WebSocket transport, and synchronized
multi-device playback remain future work. The TTS endpoint accepts up to 5,000
characters per request and does not expose provider error details or credentials.

## Checks

```sh
npm run build
npm run test:api
npm run test:e2e
```

Install Playwright's browser once before running browser tests:

```sh
npx playwright install chromium
```
