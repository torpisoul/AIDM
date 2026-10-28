# Emberkeep Table Console

A shared-tablet MVP for a voice-enabled tabletop RPG session. The console
provides four player-specific push-to-talk controls, audio recording and speech
transcription, a single active-speaker lock, editable story context, dynamic
Gemini DM responses, a session feed, party hit-point controls, and ElevenLabs
narration through server endpoints.

## Current prototype progress

The end-to-end single-tablet loop is now working:

1. Each player submits a voice or typed action, chooses **Do nothing**, or
   chooses **Go with the group**. Voice recordings are transcribed by
   ElevenLabs as they are submitted.
2. The app waits until all four players have responded, then sends their
   combined choices, recent dialogue, and authored story settings to Gemini.
   If everyone chose **Go with the group**, one player can submit a single
   shared party intention by voice or text.
3. The generated response appears in the session feed and can be spoken using
   ElevenLabs text-to-speech.

The DM author can edit the premise, current scene, narration style, and
story-so-far notes in the browser. The player-reported audio-to-response delay
has been negligible in testing. This validates the basic voice and narrative
loop, but not reliability across browsers, network conditions, or long sessions.

## Current scope and next work

- **Working:** shared-tablet player controls, one response per player per
  round, explicit **Do nothing** and **Go with the group** responses, a shared
  party voice/text action after unanimous group agreement, voice transcription,
  typed actions, dynamic Gemini story responses, editable local story context,
  and optional ElevenLabs narration.
- **Not implemented yet:** D&D/5e rules adjudication, automatically maintained
  campaign notes, saved session transcripts, character-sheet integration,
  accounts, multi-device sessions, and synchronized playback.
- Story settings persist in this browser; the conversation feed and turn
  history currently live only for the open page. Refreshing starts a new
  conversation while keeping the saved story settings.

## Post-MVP ideas

- **Player targeting and reactive turn order:** let the DM address a specific
  player, and optionally use character skills, ancestry, or situational checks
  to determine speaking order or how much a response influences the scene.
  Explore whether checks are visible or hidden from players.

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

Open the Vite URL printed in the terminal. Each player can hold their **Hold
to talk** button and release to submit, select a player and send a typed action,
choose **Do nothing**, or choose **Go with the group**. If all four players
choose to go with the group, one player can hold the party microphone button
and speak a single shared intention; text entry for the party is also available.
Voice recordings are sent to `POST /api/stt` and transcribed by ElevenLabs
using `ELEVENLABS_STT_MODEL_ID`. The app waits until the group intention (when
needed) and all four player responses are ready before sending them, recent
turns, and authored story context to `POST /api/dm`; the local server asks
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
`gemini-3.5-flash-lite`. The TTS endpoint accepts up to 5,000 characters per
request. The API health check reports `sttConfigured` and `dmConfigured` based
on server-side API key configuration.

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
