// ElevenLabs voices (server/voice.py; the key stays on the server).
//   speechUrl(text): an object URL of the text spoken, made once per text. The lesson player (learn-audio.js)
//                    asks for each sentence a few ahead, so the next one is ready when the current one ends.
//   startTalk(...):  a live voice conversation with the ElevenLabs Learn agent about the article and lesson.

import { BASE } from "./api.js";

const CLIENT = "./vendor/elevenlabs-client-1.36.1.js";
const KEEP = 200; // clips kept for replays and seeking back

// The voices to pick from; server/voice.py accepts only these.
export const VOICES = [
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", note: "Warm storyteller · British" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", note: "Clear educator · British" },
  { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", note: "Steady broadcaster · British" },
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda", note: "Knowledgeable · American" },
  { id: "SAz9YHcvj6GT2YYXdXww", name: "River", note: "Relaxed, neutral · American" },
  { id: "nPczCjzI2devNBz1zQrb", name: "Brian", note: "Deep, comforting · American" },
];

let voice = VOICES.find((v) => v.id === remembered("learn-voice"))?.id ?? VOICES[0].id;

export function currentVoice() {
  return VOICES.find((v) => v.id === voice);
}

export function setVoice(id) {
  if (!VOICES.some((v) => v.id === id)) return;
  voice = id;
  try {
    localStorage.setItem("learn-voice", id);
  } catch {}
}

const clips = new Map(); // voice + text → Promise<object URL>
let unavailable = false; // the server has no ElevenLabs key: callers fall back to the browser's voice

export function speechAvailable() {
  return !unavailable;
}

export function speechUrl(text) {
  if (unavailable) return Promise.reject(new Error("ElevenLabs is not set up on this server"));
  const key = `${voice} ${text}`;
  if (clips.has(key)) {
    const clip = clips.get(key);
    clips.delete(key); // most recently used last
    clips.set(key, clip);
    return clip;
  }
  const clip = fetch(BASE + "/api/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice }),
  }).then(async (response) => {
    if (!response.ok) {
      if (response.status === 503 || response.status === 404) unavailable = true;
      throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
    }
    return URL.createObjectURL(await response.blob());
  });
  clip.catch(() => clips.delete(key));
  clips.set(key, clip);
  while (clips.size > KEEP) {
    const [oldest, url] = clips.entries().next().value;
    clips.delete(oldest);
    url.then((u) => URL.revokeObjectURL(u), () => {});
  }
  return clip;
}

// Starts a conversation with the Learn agent. context: { title, article, answer, sources: [{ title, text }] }.
// Callbacks: onStatus("connecting" | "listening" | "speaking" | "ended", detail), onMessage(role, text); while
// connecting, detail names the step. Each step has CONNECT_S to finish, and is logged as [voice] in the console.
// Resolves to { stop(), volume() }.
const CONNECT_S = 20;
const MIC_BLOCKED = "the microphone is blocked. Allow it for this site, and on a Mac for the browser too (System Settings › Privacy & Security › Microphone), then reload";

export async function startTalk({ context, onStatus, onMessage }) {
  const step = async (label, work) => {
    onStatus("connecting", label);
    console.info(`[voice] ${label}`);
    let timer;
    const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${label.replace(/…$/, "")} took over ${CONNECT_S} s`)), CONNECT_S * 1000)));
    try {
      return await Promise.race([work(), late]);
    } catch (error) {
      console.error(`[voice] ${label} failed`, error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  await step("Starting the microphone…", async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("this browser has no microphone access");
    let mic;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      // macOS can deny Chrome the microphone while the site itself is allowed.
      throw new Error(error.name === "NotAllowedError" ? MIC_BLOCKED : `the microphone didn't start (${error.message})`);
    }
    const tracks = mic.getAudioTracks();
    const dead = !tracks.length || tracks.every((t) => t.muted || t.readyState !== "live");
    tracks.forEach((t) => t.stop());
    if (dead) throw new Error(MIC_BLOCKED);
  });
  const [{ VoiceConversation }, started] = await step("Loading the voice…", () =>
    Promise.all([
      import(CLIENT),
      fetch(BASE + "/api/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(context),
      }).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)))),
    ]),
  );
  let mode = "listening";
  let connected = false;
  const callbacks = {
    dynamicVariables: started.dynamic_variables,
    onConnect: () => {
      connected = true;
      console.info("[voice] connected");
      onStatus("listening");
    },
    onModeChange: ({ mode: m }) => onStatus((mode = m === "speaking" ? "speaking" : "listening")),
    onMessage: ({ source, message }) => message && onMessage(source === "user" ? "user" : "ai", message),
    onError: (message, context) => {
      console.error("[voice] error", message, context);
      if (connected) onStatus("ended", String(message));
    },
    onDisconnect: (details) => {
      console.info("[voice] disconnected", details);
      if (connected) onStatus("ended", details?.reason === "error" ? details.message : "");
    },
  };
  // WebRTC first: the browser's own call audio, which works where the WebSocket route's 16 kHz audio setup hangs
  // (seen on a Mac); the WebSocket only when WebRTC fails.
  let session;
  try {
    session = await step("Connecting to ElevenLabs…", () =>
      VoiceConversation.startSession({ conversationToken: started.conversation_token, connectionType: "webrtc", ...callbacks }),
    );
  } catch (error) {
    console.warn("[voice] WebRTC failed, trying the WebSocket", error);
    session = await step("Connecting to ElevenLabs again…", () =>
      VoiceConversation.startSession({ signedUrl: started.signed_url, connectionType: "websocket", ...callbacks }),
    );
  }
  if (!connected) onStatus("listening"); // the session is up even if onConnect came before we listened
  return {
    stop: () => session.endSession().catch(() => {}),
    volume: () => (mode === "speaking" ? session.getOutputVolume() : session.getInputVolume()),
  };
}

function remembered(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
