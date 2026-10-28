# Emberkeep Table Console

A shared-tablet MVP for a voice-enabled tabletop RPG session. The console
provides four player-specific push-to-talk controls, audio recording and speech
transcription, a single active-speaker lock, editable story context, dynamic
Gemini DM responses, a session feed, party hit-point controls, and ElevenLabs
narration through server endpoints.

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
ELEVENLABS_STT_MODEL_ID=scribe_v1
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL_ID=gemini-3.5-flash-lite
TTS_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173
```

Keep `.env` private: it is ignored by git. Provider API keys are read by the
Node server and never sent to or embedded in the browser bundle. The TTS model
defaults to `eleven_flash_v2_5`; the DM model defaults to
`gemini-3.5-flash-lite`. Change the model IDs if your accounts use different
models.
The allowed origins setting permits the local Vite frontend to call the API.
For a deployed frontend, replace it with that frontend's exact origin.

Start the app and TTS server together:

```sh
npm run dev
```

Open the Vite URL printed in the terminal. Hold a player's **Hold to talk**
button, speak, and release; or select a player, type an action, and send it.
The browser records audio while the button is held. Releasing it sends the
recording to `POST /api/stt`; the local server transcribes it with ElevenLabs
using `ELEVENLABS_STT_MODEL_ID`. Each transcript or text action, recent turns,
and authored story context are sent to `POST /api/dm`; the local server asks
Gemini to continue the adventure. The resulting DM narration is then sent to
`POST /api/tts` and voiced by ElevenLabs. **Play voice demo** remains available
for a standalone narration sample. Restart the dev server after changing `.env`.

The **DM Authoring** fields let you edit the campaign premise, current scene,
DM style, and story-so-far notes. Settings save to this browser's local storage
and apply to the next DM turn. Recent player/DM turns are supplied as
conversation history. Restore defaults at any time. The DM is instructed to
respect player intent, preserve continuity, and keep spoken replies concise;
game rules and 5e adjudication are intentionally out of scope.

Voice input requires a secure browser context (localhost is supported),
microphone permission, and browser support for `getUserMedia` and
`MediaRecorder`. Player audio is sent to the app backend and forwarded to
ElevenLabs for transcription; the app does not persist recordings. Provider-side
retention is subject to the ElevenLabs account and API settings. Audio requests
are limited to 4 MB. Use text input if microphone capture is unavailable.

This is a narrative prototype, not a rules engine. Gemini and ElevenLabs API
keys stay server-side; model and provider errors are surfaced in the app. The
DM model is configurable with `GEMINI_MODEL_ID` and defaults to
`gemini-3.5-flash-lite`. Persistent campaign history, WebSocket transport, and
synchronized multi-device playback remain future work. The TTS endpoint
accepts up to 5,000 characters per request. The API health check reports
`sttConfigured` and `dmConfigured` based on server-side API key configuration.

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
generation and transcription, add `ELEVENLABS_API_KEY` in Netlify **Site
configuration → Environment variables** and scope it to the Functions runtime.
For dynamic DM responses, also add `GEMINI_API_KEY`; optionally configure
`GEMINI_MODEL_ID`. Do not put either key in GitHub or in a `VITE_` variable.
The selected ElevenLabs voice, model, and allowed GitHub Pages origin are
already configured on the Netlify site. Redeploy after changing variables, then
verify `https://aidm-table-console-torpisoul.netlify.app/api/health` reports
`{"ttsConfigured":true,"sttConfigured":true,"dmConfigured":true}`.

The GitHub Pages workflow builds the app at `https://torpisoul.github.io/AIDM/`
whenever `main` changes. In the repository's **Settings → Pages**, set the
source to **GitHub Actions**. Push to `main` or run the **Deploy GitHub Pages**
workflow to publish the frontend. The workflow targets the deployed Netlify
TTS, STT, and DM function URLs.

The Netlify site is currently deployed directly from the CLI rather than
connected to Git-based continuous deployment. To publish backend changes from
this workspace, run `netlify deploy --prod`.

Do not add the ElevenLabs key to GitHub, a `VITE_` variable, or the frontend.
The TTS endpoint is publicly reachable by design for the demo; CORS only
restricts browser origins and is not authentication. Keep the link limited to
people you trust and set usage/credit limits in ElevenLabs.
