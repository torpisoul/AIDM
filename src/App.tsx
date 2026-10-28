import { useCallback, useEffect, useRef, useState } from "react";

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

function nowLabel() {
  return new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date());
}

function App() {
  const [players, setPlayers] = useState(initialPlayers);
  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [messages, setMessages] = useState(initialMessages);
  const [notice, setNotice] = useState("");
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
  const captureId = useRef(0);
  const pressStartedAt = useRef(0);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const messageId = useRef(5);
  const timers = useRef<number[]>([]);

  const addMessage = useCallback((message: Omit<Message, "id" | "time">) => {
    setMessages((current) => [...current, { ...message, id: messageId.current++, time: nowLabel() }]);
  }, []);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => () => {
    timers.current.forEach(window.clearTimeout);
    audioRef.current?.pause();
    ttsRequestRef.current?.abort();
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    recorderRef.current?.state !== "inactive" && recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
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
    const currentCaptureId = ++captureId.current;
    setActivePlayerId(playerId);
    setPhase("recording");
    setNotice("");
    pressStartedAt.current = performance.now();

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setIsMicReady(false);
        setNotice("Microphone access is not available in this browser. You can still use text input.");
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (captureId.current !== currentCaptureId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      if (typeof MediaRecorder === "undefined") {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        throw new Error("MediaRecorder is not supported");
      }
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
        .find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) {
          setNotice("Audio captured locally. Connect the audio relay to transcribe and respond.");
        }
      };
      recorder.onerror = () => {
        setNotice("The browser could not record audio. Check microphone permissions and try again.");
      };
      recorder.start(100);
      setIsMicReady(true);
    } catch (error) {
      if (captureId.current !== currentCaptureId) return;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setIsMicReady(false);
      setNotice(error instanceof DOMException && error.name === "NotAllowedError"
        ? "Microphone permission was denied. Allow microphone access or switch to text input."
        : "Could not start the microphone. Check that it is connected and try again.");
    }
  };

  const stopRecorder = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    recorderRef.current = null;
    streamRef.current = null;
    setIsMicReady(false);
  };

  const releaseTalk = (playerId: string) => {
    if (activePlayerId !== playerId) return;
    captureId.current += 1;
    stopRecorder();
    const player = players.find((candidate) => candidate.id === playerId);
    if (!player) return;

    addMessage({
      kind: "player",
      speaker: `${player.name} · ${player.character.split(" · ")[0]}`,
      text: "Audio captured — connect a speech-to-text provider to transcribe this turn.",
    });
    const elapsedMs = Math.round(performance.now() - pressStartedAt.current);
    setLatency(elapsedMs);
    setActivePlayerId(null);
    setPhase("idle");
    setNotice("Audio capture works in this browser. Transcription and the AI DM response need a configured backend.");
  };

  const submitTextAction = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = typedAction.trim();
    if (!text || activePlayerId || phase !== "idle") return;
    const player = players.find((candidate) => candidate.id === activePlayerIdForText);
    if (!player) {
      setNotice("Select a player before sending an action.");
      return;
    }
    addMessage({
      kind: "player",
      speaker: `${player.name} · ${player.character.split(" · ")[0]}`,
      text,
    });
    setTypedAction("");
    setPhase("thinking");
    setNotice("Text action captured. Connect a DM service to resolve the turn.");
    const timer = window.setTimeout(() => setPhase("idle"), 1200);
    timers.current.push(timer);
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

    if (isMuted) {
      setNotice("Demo narration added to the feed. Unmute DM voice playback to hear it.");
      return;
    }

    const audio = audioRef.current;
    if (!audio) {
      setNotice("The demo audio player is unavailable. Reload the page and try again.");
      return;
    }

    const request = new AbortController();
    ttsRequestRef.current?.abort();
    ttsRequestRef.current = request;
    pressStartedAt.current = performance.now();
    setPhase("thinking");
    setNotice("Generating narration with ElevenLabs…");

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
      setNotice(error instanceof Error
        ? error.message
        : "Speech generation failed. Check the TTS server and try again.");
    } finally {
      if (ttsRequestRef.current === request) ttsRequestRef.current = null;
    }
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
              <div className="scene-location"><span aria-hidden="true">⌖</span> THE OLD FOREST ROAD <span className="location-divider">·</span> DUSK</div>
              <p>Beyond the pines, a village waits in<br className="desktop-break" /> a silence that feels almost deliberate.</p>
            </div>
            <div className="scene-caption"><span className="caption-line" /> CURRENT SCENE</div>
            <div className="scene-grain" />
          </div>

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
                    onPointerLeave={() => handleTalkPointerUp(player.id)}
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
              placeholder={inputMode === "text" ? "Type an action or ask the DM…" : "Text fallback for unsupported microphones…"}
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
            <div><span className="metric-label">VOICE RELAY</span><strong><i className="offline-dot" /> DEMO MODE</strong></div>
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
            <div className="pipeline-title"><span>DEMO AUDIO</span><span className="demo-badge">LOCAL CLIP</span></div>
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
            <p>Sample narration plays locally. Player microphone audio is not transcribed or sent to a DM yet.</p>
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
