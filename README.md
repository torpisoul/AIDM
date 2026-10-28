# Emberkeep Table Console

A shared-tablet MVP for a voice-enabled tabletop RPG session. The console
provides four player-specific push-to-talk controls, browser speech recognition,
a single active-speaker lock, a branching Briar Glen scene, a session feed,
party hit-point controls, and ElevenLabs narration through a server endpoint.

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

Open the Vite URL printed in the terminal. Hold a player's **Hold to talk**
button, speak, and release; or select a player, type an action, and send it.
Browser speech recognition transcribes voice input. The scene uses simple
authored branches to respond to player intent, then sends the DM's narration
text to `POST /api/tts`; the local server calls ElevenLabs with the configured
voice and returns the generated MP3 for playback. **Play voice demo** remains
available for a standalone narration sample. Restart the dev server after
changing `.env`.

Voice input requires a secure browser context (localhost is supported),
microphone permission, and a browser with the Web Speech API; Chromium-based
browsers are recommended. Speech recognition may process audio through the
browser's speech service. This app does not upload recordings to its backend;
the transcript is resolved in the browser and only the DM narration text is
sent to ElevenLabs. Use text input if speech recognition is unavailable.

This is a technical and player-agency prototype, not an AI DM: authored
branching rules respond to a few action intents, with a generic response for
other actions. A model-generated DM, persistent campaign state, WebSocket
transport, and synchronized multi-device playback remain future work. The TTS
endpoint accepts up to 5,000 characters per request and does not expose provider
credentials.

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

## Deploy a public demo

The TTS backend is deployed to
`https://aidm-table-console-torpisoul.netlify.app`. To activate speech
generation, add `ELEVENLABS_API_KEY` in Netlify **Site configuration →
Environment variables** and scope it to the Functions runtime. Do not put the
key in GitHub or in a `VITE_` variable. The selected voice, model, and allowed
GitHub Pages origin are already configured on the Netlify site. Redeploy after
adding the key, then verify
`https://aidm-table-console-torpisoul.netlify.app/api/health` reports
`{"ttsConfigured":true}`.

The GitHub Pages workflow builds the app at `https://torpisoul.github.io/AIDM/`
whenever `main` changes. In the repository's **Settings → Pages**, set the
source to **GitHub Actions**. Push to `main` or run the **Deploy GitHub Pages**
workflow to publish the frontend. The workflow already targets the deployed
Netlify function URL.

The Netlify site is currently deployed directly from the CLI rather than
connected to Git-based continuous deployment. To publish backend changes from
this workspace, run `netlify deploy --prod`.

Do not add the ElevenLabs key to GitHub, a `VITE_` variable, or the frontend.
The TTS endpoint is publicly reachable by design for the demo; CORS only
restricts browser origins and is not authentication. Keep the link limited to
people you trust and set usage/credit limits in ElevenLabs.
