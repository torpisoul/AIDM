import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_STORY_SETTINGS,
  isStorySettings,
  STORY_SETTINGS_KEY,
  type StorySettings,
  type StoryTurn,
} from "./story";

type Player = {
  id: string;
  name: string;
  character: string;
  initials: string;
  color: string;
  hp: number;
  maxHp: number;
};

type Phase = "idle" | "recording" | "transcribing" | "thinking" | "speaking";
type MessageKind = "narration" | "player" | "npc" | "system";

type Message = {
  id: number;
  kind: MessageKind;
  speaker: string;
  text: string;
  time: string;
  voiceId?: string;
};

type VoiceProfile = {
  id: string;
  speaker: string;
  emotion: string;
  text: string;
};

const initialPlayers: Player[] = [
  { id: "aria", name: "Aria", character: "Liora · Elf Ranger", initials: "AR", color: "lilac", hp: 24, maxHp: 28 },
  { id: "bren", name: "Bren", character: "Thorne · Human Fighter", initials: "BR", color: "rust", hp: 31, maxHp: 36 },
  { id: "mira", name: "Mira", character: "Pip · Halfling Bard", initials: "MI", color: "sage", hp: 19, maxHp: 22 },
  { id: "rowan", name: "Rowan", character: "Kael · Tiefling Warlock", initials: "RO", color: "blue", hp: 17, maxHp: 24 },
];

const initialMessages: Message[] = [
  {
    id: 1,
    kind: "system",
    speaker: "SESSION NOTE",
    text: "The party follows the old forest road toward a village that has gone silent.",
    time: "8:41 PM",
  },
  {
    id: 2,
    kind: "narration",
    speaker: "THE DUNGEON MASTER",
    text: "The last of the daylight slips between the pines. Ahead, a crooked sign swings over the road: Briar Glen, one mile. Beyond it, not a single lantern burns.",
    time: "8:42 PM",
    voiceId: "dm-narrator",
  },
  {
    id: 3,
    kind: "player",
    speaker: "Aria · Liora",
    text: "I want to look for fresh tracks leading away from the village.",
    time: "8:43 PM",
  },
  {
    id: 4,
    kind: "system",
    speaker: "GAME LOG",
    text: "Liora checks the roadside for tracks · Survival check pending",
    time: "8:43 PM",
  },
];

const phaseLabels: Record<Phase, string> = {
  idle: "Ready when you are",
  recording: "Listening to player",
  transcribing: "Transcribing audio",
  thinking: "The DM is thinking",
  speaking: "The DM is speaking",
};

const ttsEndpoint = import.meta.env.VITE_TTS_API_URL || "/api/tts";
const sttEndpoint = import.meta.env.VITE_STT_API_URL || "/api/stt";
const dmEndpoint = import.meta.env.VITE_DM_API_URL || "/api/dm";

function nowLabel() {
  return new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date());
}

function App() {
  const [players, setPlayers] = useState(initialPlayers);
  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [messages, setMessages] = useState(initialMessages);
  const [notice, setNotice] = useState("");
  const [storySettings, setStorySettings] = useState<StorySettings>(DEFAULT_STORY_SETTINGS);
  const [storySettingsLoaded, setStorySettingsLoaded] = useState(false);
  const [isStoryEditorOpen, setIsStoryEditorOpen] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [latency, setLatency] = useState<number | null>(null);
  const [voicePreview, setVoicePreview] = useState<VoiceProfile | null>(null);
  const [isMicReady, setIsMicReady] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [inputMode, setInputMode] = useState<"voice" | "text">("voice");
  const [typedAction, setTypedAction] = useState("");
  const [activePlayerIdForText, setActivePlayerIdForText] = useState<string | null>("aria");
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioUrlRef = useRef<string | null>(null);
  const ttsRequestRef = useRef<AbortController | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const captureId = useRef(0);
  const captureReleasedRef = useRef(false);
  const pressStartedAt = useRef(0);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const messageId = useRef(5);

  const addMessage = useCallback((message: Omit<Message, "id" | "time">) => {
    setMessages((current) => [...current, { ...message, id: messageId.current++, time: nowLabel() }]);
  }, []);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORY_SETTINGS_KEY);
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (!isStorySettings(parsed)) {
          throw new Error("Saved adventure settings have an unexpected format.");
        }
        setStorySettings(parsed);
      }
    } catch (error) {
      setNotice(error instanceof Error
        ? `Could not load saved adventure settings: ${error.message}`
        : "Could not load saved adventure settings.");
    } finally {
      setStorySettingsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!storySettingsLoaded) return;
    try {
      window.localStorage.setItem(STORY_SETTINGS_KEY, JSON.stringify(storySettings));
    } catch (error) {
      setNotice(error instanceof Error
        ? `Could not save adventure settings in this browser: ${error.message}`
        : "Could not save adventure settings in this browser.");
    }
  }, [storySettings, storySettingsLoaded]);

  useEffect(() => () => {
    audioRef.current?.pause();
    ttsRequestRef.current?.abort();
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    captureId.current += 1;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (phase !== "recording") {
      setElapsed(0);
      return;
    }

    const interval = window.setInterval(() => {
      setElapsed((value) => value + 1);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [phase]);

  const startTalk = async (playerId: string) => {
    if (activePlayerId || phase !== "idle") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice("Microphone access is not available in this browser. Use text input or open the app in a secure context.");
      return;
    }

    const currentCaptureId = ++captureId.current;
    setActivePlayerId(playerId);
    setPhase("recording");
    setNotice("");
    pressStartedAt.current = performance.now();
    captureReleasedRef.current = false;
    audioChunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (captureId.current !== currentCaptureId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      if (captureReleasedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        setActivePlayerId(null);
        setPhase("idle");
        setNotice("Microphone is ready. Press and hold the player button again to record your turn.");
        return;
      }
      if (typeof MediaRecorder === "undefined") {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        throw new Error("Audio recording is not supported in this browser. Use text input instead.");
      }

      const mimeType = typeof MediaRecorder.isTypeSupported === "function"
        ? ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]
          .find((candidate) => MediaRecorder.isTypeSupported(candidate))
        : undefined;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) audioChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        if (captureId.current !== currentCaptureId) return;
        captureId.current += 1;
        recorderRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        setIsMicReady(false);
        setActivePlayerId(null);
        setPhase("idle");
        pressStartedAt.current = 0;
        setNotice("The browser could not record audio. Check microphone permissions and try again.");
      };
      recorder.onstop = () => {
        if (captureId.current !== currentCaptureId) return;
        recorderRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        setIsMicReady(false);
        const audio = new Blob(audioChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        audioChunksRef.current = [];
        if (!audio.size) {
          setActivePlayerId(null);
          setPhase("idle");
          pressStartedAt.current = 0;
          setNotice("No audio was recorded. Hold the button while speaking, then release to send.");
          return;
        }
        void transcribePlayerAudio(playerId, audio);
      };
      recorder.start();
      setIsMicReady(true);
    } catch (error) {
      if (captureId.current !== currentCaptureId) return;
      setIsMicReady(false);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
      setActivePlayerId(null);
      setPhase("idle");
      pressStartedAt.current = 0;
      setNotice(error instanceof DOMException && error.name === "NotAllowedError"
        ? "Microphone permission was denied. Allow microphone access or switch to text input."
        : error instanceof Error
          ? error.message
          : "Could not start the microphone. Check that it is connected and try again.");
    }
  };

  const releaseTalk = (playerId: string) => {
    if (activePlayerId !== playerId) return;
    captureReleasedRef.current = true;
    setPhase("transcribing");
    setNotice("Uploading audio for transcription…");
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
  };

  const transcribePlayerAudio = async (playerId: string, audio: Blob) => {
    setPhase("transcribing");
    setNotice("Transcribing your turn…");
    try {
      const response = await fetch(sttEndpoint, {
        method: "POST",
        headers: { "Content-Type": audio.type || "audio/webm" },
        body: audio,
      });
      const result = await response.json().catch(() => null) as { text?: string; error?: string } | null;
      if (!response.ok) {
        throw new Error(result?.error || `Transcription failed (${response.status}).`);
      }
      if (typeof result?.text !== "string" || !result.text.trim()) {
        throw new Error("No speech was recognized. Speak clearly and try again.");
      }
      await submitPlayerAction(playerId, result.text);
    } catch (error) {
      setActivePlayerId(null);
      setPhase("idle");
      pressStartedAt.current = 0;
      setNotice(error instanceof Error
        ? error.message
        : "Transcription failed. Check the speech service connection and try again.");
    }
  };

  const playNarration = async (narration: string) => {
    if (isMuted) {
      if (pressStartedAt.current) {
        setLatency(Math.round(performance.now() - pressStartedAt.current));
        pressStartedAt.current = 0;
      }
      setPhase("idle");
      setNotice("DM response added to the feed. Unmute DM voice playback to hear it.");
      return;
    }

    const audio = audioRef.current;
    if (!audio) {
      setPhase("idle");
      pressStartedAt.current = 0;
      setNotice("The DM audio player is unavailable. Reload the page and try again.");
      return;
    }

    const request = new AbortController();
    ttsRequestRef.current?.abort();
    ttsRequestRef.current = request;
    setPhase("thinking");
    setNotice("Generating the Dungeon Master’s response…");

    try {
      const response = await fetch(ttsEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: narration }),
        signal: request.signal,
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(errorBody?.error || `Speech generation failed (${response.status}).`);
      }

      const audioBlob = await response.blob();
      if (!audioBlob.size || !audioBlob.type.startsWith("audio/")) {
        throw new Error("ElevenLabs returned an invalid audio response.");
      }

      if (request.signal.aborted) return;
      const audioUrl = URL.createObjectURL(audioBlob);
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = audioUrl;
      audio.src = audioUrl;
      audio.currentTime = 0;
      setNotice("");
      await audio.play();
    } catch (error) {
      if (request.signal.aborted) return;
      setPhase("idle");
      pressStartedAt.current = 0;
      setNotice(error instanceof Error
        ? error.message
        : "Speech generation failed. Check the TTS server and try again.");
    } finally {
      if (ttsRequestRef.current === request) ttsRequestRef.current = null;
    }
  };

  const submitPlayerAction = async (playerId: string, action: string) => {
    const player = players.find((candidate) => candidate.id === playerId);
    if (!player) {
      setActivePlayerId(null);
      setPhase("idle");
      setNotice("Select a player before sending an action.");
      return;
    }
    const text = action.trim();
    if (!text) {
      setActivePlayerId(null);
      setPhase("idle");
      pressStartedAt.current = 0;
      setNotice("No action was provided. Try again or use text input.");
      return;
    }
    if (text.length > 500) {
      setActivePlayerId(null);
      setPhase("idle");
      pressStartedAt.current = 0;
      setNotice("Actions must be 500 characters or fewer.");
      return;
    }

    if (!pressStartedAt.current) pressStartedAt.current = performance.now();
    addMessage({
      kind: "player",
      speaker: `${player.name} · ${player.character.split(" · ")[0]}`,
      text,
    });
    setActivePlayerId(null);
    setTypedAction("");
    const history: StoryTurn[] = messages
      .filter((message) => message.kind === "player" || message.kind === "narration")
      .slice(-12)
      .map((message) => ({
        role: message.kind === "player" ? "player" : "dm",
        text: (message.kind === "player" ? `${message.speaker}: ${message.text}` : message.text).slice(0, 500),
      }));
    while (history[0]?.role === "dm") history.shift();

    setPhase("thinking");
    setNotice("The Dungeon Master is weaving the next moment…");
    try {
      const response = await fetch(dmEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: text,
          player: { name: player.name, character: player.character },
          story: storySettings,
          history,
        }),
      });
      const result = await response.json().catch(() => null) as { text?: string; error?: string } | null;
      if (!response.ok) {
        throw new Error(result?.error || `The Dungeon Master could not respond (${response.status}).`);
      }
      if (typeof result?.text !== "string" || !result.text.trim()) {
        throw new Error("The Dungeon Master returned an empty response. Try again.");
      }

      const narration = result.text.trim();
      addMessage({
        kind: "narration",
        speaker: "THE DUNGEON MASTER",
        text: narration,
        voiceId: "dm-narrator",
      });
      await playNarration(narration);
    } catch (error) {
      setPhase("idle");
      pressStartedAt.current = 0;
      setNotice(error instanceof Error
        ? error.message
        : "The Dungeon Master could not respond. Check the AI service and try again.");
    }
  };

  const submitTextAction = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!typedAction.trim() || activePlayerId || phase !== "idle") return;
    if (!activePlayerIdForText) {
      setNotice("Select a player before sending an action.");
      return;
    }
    void submitPlayerAction(activePlayerIdForText, typedAction);
  };

  const updateHp = (playerId: string, delta: number) => {
    setPlayers((current) => current.map((player) => player.id === playerId
      ? { ...player, hp: Math.max(0, Math.min(player.maxHp, player.hp + delta)) }
      : player));
  };

  const playVoiceDemo = async () => {
    if (phase !== "idle" || activePlayerId) return;
    setLatency(null);
    const narration = "You find a set of small, hurried footprints in the mud. They leave the road and disappear into the bracken, heading north — toward a low hill crowned with old standing stones.";
    addMessage({
      kind: "narration",
      speaker: "THE DUNGEON MASTER",
      text: narration,
      voiceId: "dm-narrator",
    });
    pressStartedAt.current = performance.now();
    await playNarration(narration);
  };

  const toggleMute = () => {
    setIsMuted((muted) => {
      const nextMuted = !muted;
      if (nextMuted) {
        ttsRequestRef.current?.abort();
        audioRef.current?.pause();
        setPhase("idle");
        setNotice("DM voice playback muted.");
      } else {
        setNotice("");
      }
      return nextMuted;
    });
  };

  const handleAudioPlay = () => {
    setPhase("speaking");
    if (pressStartedAt.current) {
      setLatency(Math.round(performance.now() - pressStartedAt.current));
      pressStartedAt.current = 0;
    }
  };

  const openVoicePreview = () => setVoicePreview({
    id: "dm-narrator",
    speaker: "The Dungeon Master",
    emotion: "Wary · atmospheric",
    text: "The last of the daylight slips between the pines.",
  });

  const handleTalkPointerDown = (playerId: string) => {
    void startTalk(playerId);
  };

  const handleTalkPointerUp = (playerId: string) => releaseTalk(playerId);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Emberkeep home">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span>EMBERKEEP</span>
        </a>
        <div className="campaign-switcher">
          <span className="campaign-kicker">CAMPAIGN</span>
          <span>The Briar Glen Mystery</span>
          <span className="chevron">⌄</span>
        </div>
        <div className="topbar-right">
          <span className="session-live"><i /> SESSION LIVE</span>
          <button className="icon-button" aria-label={isMuted ? "Unmute DM voice playback" : "Mute DM voice playback"} onClick={toggleMute}>
            {isMuted ? "◌" : "◖"}
          </button>
          <button className="avatar-button" aria-label="Open session menu">DM</button>
        </div>
      </header>

      <main className="dashboard">
        <section className="story-column" aria-label="Session story and voice console">
          <div className="section-heading scene-heading">
            <div>
              <span className="eyebrow"><span className="eyebrow-dot" /> CHAPTER 02 <span className="eyebrow-separator">/</span> THE SILENT VILLAGE</span>
              <h1>The road to Briar Glen</h1>
            </div>
            <button className="outline-button" onClick={playVoiceDemo} disabled={phase !== "idle"}>
              <span aria-hidden="true">▷</span> Play voice demo
            </button>
          </div>

          <div className="scene-card">
            <div className="scene-sky" />
            <div className="scene-content">
              <div className="scene-location"><span aria-hidden="true">⌖</span> CURRENT SCENE <span className="location-divider">·</span> STORY SETUP</div>
              <p>{storySettings.scene}</p>
            </div>
            <div className="scene-caption"><span className="caption-line" /> CURRENT SCENE</div>
            <div className="scene-grain" />
          </div>

          <section className="story-editor" aria-label="DM story authoring">
            <div className="story-editor-heading">
              <div>
                <span className="eyebrow">DM AUTHORING</span>
                <p>Shape the story context used for the next response.</p>
              </div>
              <button
                className="outline-button"
                type="button"
                aria-expanded={isStoryEditorOpen}
                onClick={() => setIsStoryEditorOpen((open) => !open)}
              >
                {isStoryEditorOpen ? "Hide story settings" : "Edit story"}
              </button>
            </div>
            {isStoryEditorOpen && (
              <div className="story-editor-fields">
                <label>
                  Campaign premise
                  <textarea
                    value={storySettings.premise}
                    maxLength={2_000}
                    onChange={(event) => setStorySettings((current) => ({ ...current, premise: event.target.value }))}
                  />
                </label>
                <label>
                  Current scene
                  <textarea
                    value={storySettings.scene}
                    maxLength={1_000}
                    onChange={(event) => setStorySettings((current) => ({ ...current, scene: event.target.value }))}
                  />
                </label>
                <label>
                  DM style and tone
                  <textarea
                    value={storySettings.style}
                    maxLength={1_000}
                    onChange={(event) => setStorySettings((current) => ({ ...current, style: event.target.value }))}
                  />
                </label>
                <label>
                  Story so far / author notes
                  <textarea
                    value={storySettings.notes}
                    maxLength={2_000}
                    onChange={(event) => setStorySettings((current) => ({ ...current, notes: event.target.value }))}
                  />
                </label>
                <div className="story-editor-footer">
                  <span>Saved in this browser · applied to the next DM turn</span>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => setStorySettings(DEFAULT_STORY_SETTINGS)}
                  >
                    Restore defaults
                  </button>
                </div>
              </div>
            )}
          </section>

          <div className="party-header">
            <div>
              <span className="eyebrow">YOUR PARTY</span>
              <span className="party-count"> · 4 adventurers</span>
            </div>
            <button className="text-button" onClick={() => setNotice("Party details are ready for a connected character-sheet backend.")}>View party sheet <span>↗</span></button>
          </div>

          <div className="player-grid">
            {players.map((player) => {
              const isActive = activePlayerId === player.id;
              const isLocked = Boolean(activePlayerId && !isActive) || phase !== "idle" && !isActive;
              const hpPercent = (player.hp / player.maxHp) * 100;
              return (
                <article className={`player-card ${isActive ? "player-active" : ""} ${isLocked ? "player-locked" : ""}`} key={player.id}>
                  <div className="player-card-top">
                    <div className={`player-avatar avatar-${player.color}`}>{player.initials}</div>
                    <div className="player-info">
                      <strong>{player.name}</strong>
                      <span>{player.character}</span>
                    </div>
                    <button className="player-menu" aria-label={`Adjust ${player.name}'s hit points`} onClick={() => updateHp(player.id, -1)}>···</button>
                  </div>
                  <div className="player-stats">
                    <span><span className="heart">♥</span> {player.hp}<span className="stat-muted">/{player.maxHp} HP</span></span>
                    <div className="hp-track"><span style={{ width: `${hpPercent}%` }} /></div>
                  </div>
                  <button
                    className={`talk-button ${isActive ? "talk-active" : ""}`}
                    disabled={isLocked}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      handleTalkPointerDown(player.id);
                    }}
                    onPointerUp={() => handleTalkPointerUp(player.id)}
                    onPointerCancel={() => handleTalkPointerUp(player.id)}
                    onKeyDown={(event) => {
                      if ((event.key === " " || event.key === "Enter") && !event.repeat) {
                        event.preventDefault();
                        handleTalkPointerDown(player.id);
                      }
                    }}
                    onKeyUp={(event) => {
                      if (event.key === " " || event.key === "Enter") {
                        event.preventDefault();
                        handleTalkPointerUp(player.id);
                      }
                    }}
                    onContextMenu={(event) => event.preventDefault()}
                    aria-label={`Push to talk as ${player.name}`}
                  >
                    <span className="mic-icon" aria-hidden="true">●</span>
                    {isActive ? "RELEASE TO SEND" : "HOLD TO TALK"}
                    {isActive && <span className="recording-dot" />}
                  </button>
                </article>
              );
            })}
          </div>

          <div className={`capture-status ${phase !== "idle" ? "capture-busy" : ""}`} aria-live="polite">
            <span className={`status-pulse ${phase}`} />
            <span className="capture-copy">{phase === "recording" ? "Listening to" : phaseLabels[phase]}</span>
            {activePlayerId && <strong>{players.find((player) => player.id === activePlayerId)?.name}</strong>}
            {phase === "recording" && <span className="recording-timer">{String(Math.floor(elapsed / 60)).padStart(2, "0")}:{String(elapsed % 60).padStart(2, "0")}</span>}
            {phase === "recording" && isMicReady && <span className="mic-ready"><i /> MIC ON</span>}
            <span className="status-hint">{activePlayerId ? "Other players are locked until the turn is released." : isMuted ? "DM voice playback muted · microphone capture remains available" : "One speaker at a time · Hold a player button to speak"}</span>
          </div>

          <form className="text-action" onSubmit={submitTextAction}>
            <div className="mode-toggle" role="group" aria-label="Input mode">
              <button type="button" className={inputMode === "voice" ? "mode-selected" : ""} onClick={() => setInputMode("voice")}>Voice</button>
              <button type="button" className={inputMode === "text" ? "mode-selected" : ""} onClick={() => setInputMode("text")}>Text</button>
            </div>
            <select
              aria-label="Choose player"
              value={activePlayerIdForText ?? ""}
              onChange={(event) => setActivePlayerIdForText(event.target.value || null)}
            >
              <option value="">Player…</option>
              {players.map((player) => <option value={player.id} key={player.id}>{player.name}</option>)}
            </select>
            <input
              value={typedAction}
              onChange={(event) => setTypedAction(event.target.value)}
              maxLength={500}
              placeholder={inputMode === "text" ? "Type an action or ask the DM…" : "Text fallback for unsupported browsers…"}
              aria-label="Action or question"
            />
            <button type="submit" className="send-button" disabled={!typedAction.trim() || Boolean(activePlayerId) || phase !== "idle"} aria-label="Send action">↑</button>
          </form>

          {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="Dismiss message">×</button></div>}
        </section>

        <aside className="log-column" aria-label="Session log and diagnostics">
          <div className="log-heading">
            <div>
              <span className="eyebrow">TABLE FEED</span>
              <h2>Session log</h2>
            </div>
            <button className="icon-button log-menu" aria-label="Session log options">···</button>
          </div>
          <div className="session-metrics">
            <div><span className="metric-label">VOICE INPUT</span><strong><i className="offline-dot" /> ELEVEN STT</strong></div>
            <div><span className="metric-label">LAST TURN</span><strong>{latency !== null ? `${latency}ms` : "—"}</strong></div>
          </div>
          <div className="feed-list" aria-live="polite">
            {messages.map((message) => (
              <article className={`feed-item feed-${message.kind}`} key={message.id}>
                <div className="feed-marker">{message.kind === "player" ? "↗" : message.kind === "npc" ? "◈" : message.kind === "system" ? "·" : "✳"}</div>
                <div className="feed-body">
                  <div className="feed-meta"><strong>{message.speaker}</strong><time>{message.time}</time></div>
                  <p>{message.text}</p>
                  {message.voiceId && <button className="voice-tag" onClick={openVoicePreview}><span>♫</span> Voice profile <code>{message.voiceId}</code><span>↗</span></button>}
                </div>
              </article>
            ))}
            <div ref={messageEndRef} />
          </div>
          <div className="pipeline-panel">
            <div className="pipeline-title"><span>DM VOICE LOOP</span><span className="demo-badge">BRANCHING DEMO</span></div>
            <audio
              ref={audioRef}
              className="demo-audio"
              controls
              preload="auto"
              src={`${import.meta.env.BASE_URL}audio/demo-narration.wav`}
              aria-label="Dungeon Master narration audio"
              onPlay={handleAudioPlay}
              onEnded={() => setPhase("idle")}
              onPause={() => {
                if (phase === "speaking") setPhase("idle");
              }}
              onError={() => {
                setPhase("idle");
                setNotice("Could not load the sample narration. Refresh the page and try again.");
              }}
            />
            <p>Player audio is transcribed by ElevenLabs, then an authored branching scene generates the DM reply.</p>
          </div>
          <footer className="log-footer"><span>SESSION 01</span><span>Autosaved just now</span></footer>
        </aside>
      </main>

      {voicePreview && (
        <div className="modal-backdrop" role="presentation" onClick={() => setVoicePreview(null)}>
          <section className="voice-modal" role="dialog" aria-modal="true" aria-labelledby="voice-title" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close" aria-label="Close voice profile" onClick={() => setVoicePreview(null)}>×</button>
            <span className="eyebrow">VOICE PROFILE</span>
            <h2 id="voice-title">{voicePreview.speaker}</h2>
            <p>{voicePreview.emotion}</p>
            <blockquote>“{voicePreview.text}”</blockquote>
            <div className="profile-contract">
              <span>speaker <code>{voicePreview.speaker}</code></span>
              <span>voiceId <code>{voicePreview.id}</code></span>
              <span>emotion <code>{voicePreview.emotion}</code></span>
            </div>
            <p className="modal-note">A stable voice profile contract keeps future TTS providers pluggable. No custom voice service is connected in this MVP.</p>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
