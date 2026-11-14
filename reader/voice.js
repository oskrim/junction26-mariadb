// Learn, out loud (server/voice.py). Each Learn answer gets a bar with two buttons:
//   Listen: the answer read aloud by ElevenLabs, streamed so it starts within a moment. It starts by itself
//           when the answer is done.
//   Talk:   a live voice conversation with the ElevenLabs Learn agent, which knows the article, the answer
//           and the linked articles it rests on. What is said shows up in the chat as it is said.
// One sound at a time: starting one stops the others.

import { BASE } from "./api.js";

const CLIENT = "./vendor/elevenlabs-client-1.36.1.js";

let playing = null; // { stop } of whatever is making sound now

function claim(owner) {
  if (playing && playing !== owner) playing.stop();
  playing = owner;
}

// Plays the speech for `text`. Calls onState("loading" | "playing" | "ended" | "error", detail).
function play(text, onState) {
  const audio = new Audio();
  const abort = new AbortController();
  let url = null;
  const owner = {
    stop() {
      abort.abort();
      audio.pause();
      audio.removeAttribute("src");
      if (url) URL.revokeObjectURL(url);
      if (playing === owner) playing = null;
      onState("ended");
    },
  };
  claim(owner);
  onState("loading");
  audio.addEventListener("playing", () => onState("playing"));
  audio.addEventListener("ended", () => owner.stop());

  (async () => {
    const response = await fetch(BASE + "/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: abort.signal,
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
    const Source = window.ManagedMediaSource ?? window.MediaSource;
    if (Source?.isTypeSupported?.("audio/mpeg")) {
      // Streamed: the first sentence plays while the rest is still being made.
      const source = new Source();
      url = URL.createObjectURL(source);
      audio.disableRemotePlayback = true; // ManagedMediaSource needs it
      audio.src = url;
      await new Promise((resolve) => source.addEventListener("sourceopen", resolve, { once: true }));
      const buffer = source.addSourceBuffer("audio/mpeg");
      const reader = response.body.getReader();
      let started = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (buffer.updating) await new Promise((r) => buffer.addEventListener("updateend", r, { once: true }));
        buffer.appendBuffer(value);
        if (!started) {
          started = true;
          audio.play().catch(() => {});
        }
      }
      if (buffer.updating) await new Promise((r) => buffer.addEventListener("updateend", r, { once: true }));
      if (source.readyState === "open") source.endOfStream();
    } else {
      url = URL.createObjectURL(await response.blob());
      audio.src = url;
      await audio.play();
    }
  })().catch((error) => {
    if (abort.signal.aborted) return;
    owner.stop();
    onState("error", error.message);
  });
  return owner;
}

// The bar under a Learn answer. `context` is { article, answer, sources }; `say(role, text)` puts a spoken
// turn in the chat; `autoplay` reads the answer aloud right away.
export function voiceBar(reply, { article, context, say, autoplay = false }) {
  reply.insertAdjacentHTML(
    "beforeend",
    `<div class="voice-bar">
      <button type="button" class="voice-btn voice-listen" aria-pressed="false">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path class="i-play" d="M5 3.5v9l7-4.5Z" /><path class="i-stop" d="M5 4h2v8H5zM9 4h2v8H9z" /></svg>
        <span>Listen</span>
      </button>
      <button type="button" class="voice-btn voice-talk" aria-pressed="false">
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="2" width="5" height="8" rx="2.5" /><path d="M3 8a5 5 0 0 0 10 0M8 13v1.5" /></svg>
        <span>Talk</span>
        <i class="voice-level" aria-hidden="true"></i>
      </button>
      <span class="voice-status" role="status"></span>
    </div>`,
  );
  const bar = reply.lastElementChild;
  const listen = bar.querySelector(".voice-listen");
  const talk = bar.querySelector(".voice-talk");
  const status = bar.querySelector(".voice-status");
  let speech = null;
  let call = null;

  const setListen = (state, detail) => {
    const on = state === "loading" || state === "playing";
    listen.setAttribute("aria-pressed", String(on));
    listen.classList.toggle("is-loading", state === "loading");
    listen.querySelector("span").textContent = on ? "Stop" : "Listen";
    status.textContent = state === "error" ? `Couldn't read it aloud: ${detail}` : "";
    if (!on) speech = null;
  };
  listen.addEventListener("click", () => {
    if (speech) speech.stop();
    else speech = play(context.answer, setListen);
  });

  talk.addEventListener("click", () => (call ? call.stop() : (call = conversation())));

  function conversation() {
    let session = null;
    let ended = false;
    let frame = 0;
    const owner = {
      stop() {
        if (ended) return;
        ended = true;
        cancelAnimationFrame(frame);
        session?.endSession().catch(() => {});
        if (playing === owner) playing = null;
        call = null;
        talk.setAttribute("aria-pressed", "false");
        talk.classList.remove("is-live", "is-speaking", "is-loading");
        talk.querySelector("span").textContent = "Talk";
        talk.style.removeProperty("--level");
        if (!status.dataset.error) status.textContent = "";
      },
    };
    claim(owner);
    delete status.dataset.error;
    talk.setAttribute("aria-pressed", "true");
    talk.classList.add("is-loading");
    talk.querySelector("span").textContent = "Connecting…";

    const fail = (message) => {
      status.dataset.error = "1";
      status.textContent = `Voice chat stopped: ${message}`;
      owner.stop();
    };

    (async () => {
      // Asked first, so the browser's microphone prompt comes up right after the click.
      const mic = navigator.mediaDevices?.getUserMedia?.({ audio: true });
      if (!mic) throw new Error("this browser has no microphone access");
      (await mic).getTracks().forEach((t) => t.stop());
      const [{ VoiceConversation }, started] = await Promise.all([
        import(CLIENT),
        fetch(BASE + "/api/voice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page_id: article?.page_id, title: article?.title, ...context }),
        }).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)))),
      ]);
      if (ended) return;
      session = await VoiceConversation.startSession({
        signedUrl: started.signed_url,
        connectionType: "websocket",
        dynamicVariables: started.dynamic_variables,
        onConnect: () => {
          talk.classList.remove("is-loading");
          talk.classList.add("is-live");
          talk.querySelector("span").textContent = "End";
          status.textContent = "Listening — just talk";
          meter();
        },
        onModeChange: ({ mode }) => {
          talk.classList.toggle("is-speaking", mode === "speaking");
          if (!ended) status.textContent = mode === "speaking" ? "Speaking — talk to interrupt" : "Listening — just talk";
        },
        onMessage: ({ source, message }) => message && say(source === "user" ? "user" : "ai", message),
        onError: (message) => fail(String(message)),
        onDisconnect: (details) => (details?.reason === "error" ? fail(details.message) : owner.stop()),
      });
      if (ended) session.endSession().catch(() => {});
    })().catch((error) => !ended && fail(error.message));

    // The button's ring follows the voice: the agent's while it speaks, yours while it listens.
    function meter() {
      if (ended || !session) return;
      const speaking = talk.classList.contains("is-speaking");
      const level = speaking ? session.getOutputVolume() : session.getInputVolume();
      talk.style.setProperty("--level", Math.min(1, level * 2.5).toFixed(3));
      frame = requestAnimationFrame(meter);
    }
    return owner;
  }

  if (autoplay) speech = play(context.answer, setListen);
}

// Stops whatever is speaking, e.g. when its chat closes.
export function stopVoice() {
  playing?.stop();
}
