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
// Callbacks: onStatus("connecting" | "listening" | "speaking" | "ended", detail), onMessage(role, text).
// Resolves to { stop(), volume() }.
export async function startTalk({ context, onStatus, onMessage }) {
  onStatus("connecting");
  const mic = navigator.mediaDevices?.getUserMedia?.({ audio: true });
  if (!mic) throw new Error("this browser has no microphone access");
  (await mic).getTracks().forEach((t) => t.stop()); // asks for the microphone right after the click
  const [{ VoiceConversation }, started] = await Promise.all([
    import(CLIENT),
    fetch(BASE + "/api/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(context),
    }).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)))),
  ]);
  let mode = "listening";
  const session = await VoiceConversation.startSession({
    signedUrl: started.signed_url,
    connectionType: "websocket",
    dynamicVariables: started.dynamic_variables,
    onConnect: () => onStatus("listening"),
    onModeChange: ({ mode: m }) => onStatus((mode = m === "speaking" ? "speaking" : "listening")),
    onMessage: ({ source, message }) => message && onMessage(source === "user" ? "user" : "ai", message),
    onError: (message) => onStatus("ended", String(message)),
    onDisconnect: (details) => onStatus("ended", details?.reason === "error" ? details.message : ""),
  });
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
