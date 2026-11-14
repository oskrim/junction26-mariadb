// Listen: the lesson as an audio book. Its sections are chapters on the scrubber, the transcript follows the voice,
// and Ask pauses it for a question: the answer is read out where it was asked, then the lesson picks up again.
// The voice is ElevenLabs (voice.js), one sentence at a time with the next few made ahead; when the server has no
// ElevenLabs key it is the browser's speech synthesis, and without that the player keeps time silently. Times are
// estimated from word counts, in lesson time (1.5× plays a 3:00 lesson in 2:00).

import { CITES, escape, turnHtml } from "./learn-view.js";
import { VOICES, currentVoice, setVoice, speechAvailable, speechUrl } from "./voice.js";

const WORDS_PER_S = 2.6;
const PAUSE_S = 0.35;
const SKIP_S = 15;
const RATES = [1, 1.25, 1.5, 2, 0.75];
const RESUME_S = 3;
const AHEAD = 3; // sentences made ahead of the one being said

// askBox: the chat beside the sheet, when there is one (learn-view.js); it takes the questions, so the bar has no Ask.
export function listenView({ root, bar, lesson, ask, askBox = () => null }) {
  root.innerHTML = `<div class="listen-scroll"><div class="listen-transcript"></div></div>`;
  const scroller = root.firstElementChild;
  const transcript = root.querySelector(".listen-transcript");

  let sentences = [];
  let chapters = [];
  let built = "";
  let index = 0;
  let playing = false;
  let run = 0;
  let begun = 0;
  let frame = 0;
  let rate = Number(read("learn-rate")) || 1;
  let phase = "player"; // player · typing · waiting · answering · resume
  let turn = null;
  let resumeTimer = 0;
  let scrub = null;
  let heldScroll = 0;
  let recognition = null;
  const audio = new Audio();
  audio.preservesPitch = true;
  let hush = null; // ends the sentence being said
  let voiceMenu = false;
  let held = false; // paused for a voice chat, to play on after it

  const listeners = [
    ["keydown", onKey],
    ["pointerup", () => scrub && endScrub()],
  ];
  for (const [name, fn] of listeners) addEventListener(name, fn);
  scroller.addEventListener("wheel", () => (heldScroll = performance.now()), { passive: true });
  scroller.addEventListener("touchmove", () => (heldScroll = performance.now()), { passive: true });
  transcript.addEventListener("click", (e) => {
    const say = e.target.closest("[data-i]");
    if (say && phase === "player") playFrom(Number(say.dataset.i));
  });
  bar.addEventListener("click", onBarClick);
  bar.addEventListener("submit", onAskSubmit);
  bar.addEventListener("pointerdown", onTrackDown);

  update();
  renderBar();

  return { update, destroy, ask: askFromSide, hold, release };

  // A question typed in the chat beside the sheet: the lesson stops, the answer is read out, then the lesson goes on.
  function askFromSide(question) {
    if (!lesson.done || !sentences.length || phase === "waiting" || phase === "answering") return false;
    clearTimeout(resumeTimer);
    const resuming = phase === "resume" && turn;
    turn = { wasPlaying: resuming || playing, at: resuming ? turn.at : Math.min(index, sentences.length - 1) };
    stop();
    sendAsk(question);
    return true;
  }

  // A voice chat pauses the lesson and hands it back where it was.
  function hold() {
    clearTimeout(resumeTimer);
    held = playing || phase === "resume";
    if (phase !== "player") {
      phase = "player";
      turn = null;
    }
    stop();
    renderBar();
    paint();
  }

  function release() {
    if (held) playFrom(index);
    held = false;
  }

  // The lesson grew or a question got more of its answer.
  function update() {
    if (lesson.text !== built) {
      built = lesson.text;
      timeline();
    }
    renderTranscript();
    if (phase === "player") renderBar();
    else if (phase === "waiting" && turn?.done) answerAloud();
    paint();
  }

  function destroy() {
    stop();
    audio.removeAttribute("src");
    clearTimeout(resumeTimer);
    recognition?.abort();
    cancelAnimationFrame(frame);
    for (const [name, fn] of listeners) removeEventListener(name, fn);
    bar.removeEventListener("click", onBarClick);
    bar.removeEventListener("submit", onAskSubmit);
    bar.removeEventListener("pointerdown", onTrackDown);
    root.replaceChildren();
    bar.replaceChildren();
  }

  // Chapters: the title and goal, each section, and the key terms; each sentence gets its place in time.
  function timeline() {
    const { title, goal, sections, terms } = lesson.parsed;
    const parts = [{ heading: "Introduction", intro: true, paras: [title ? [{ text: title, kind: "title" }] : [], goal ? split(goal) : []] }];
    for (const s of sections) parts.push({ heading: plain(s.heading ?? "") || "The lesson", paras: s.paras.map(split) });
    if (lesson.done && terms.size) parts.push({ heading: "Key terms", paras: [...terms.values()].map((t) => split(`${t.name}. ${t.text}`)) });

    sentences = [];
    chapters = [];
    let t = 0;
    for (const [c, part] of parts.entries()) {
      const chapter = { heading: part.heading, intro: part.intro, start: t, dur: 0, paras: [] };
      for (const para of part.paras) {
        const ids = [];
        for (const s of para) {
          const dur = words(s.text) / WORDS_PER_S + PAUSE_S;
          ids.push(sentences.length);
          sentences.push({ ...s, chapter: c, start: t, dur });
          t += dur;
        }
        if (ids.length) chapter.paras.push(ids);
      }
      chapter.dur = t - chapter.start;
      if (chapter.paras.length) chapters.push(chapter);
    }
    for (const s of sentences) s.chapter = chapters.findIndex((c) => s.start >= c.start && s.start < c.start + c.dur);
    index = Math.min(index, Math.max(sentences.length - 1, 0));
  }

  function renderTranscript() {
    // With the chat beside the sheet the questions are there; otherwise each sits after the sentence it interrupted.
    const turnsAfter = (ids) => (askBox() ? [] : lesson.followups.filter((t) => t.at !== null && ids.includes(t.at)));
    transcript.innerHTML = `
      <p class="listen-eyebrow">${lesson.done ? `Audio lesson · ${Math.max(1, Math.round(total() / 60))} min · ${chapters.length} chapters` : "Preparing the audio…"}</p>
      ${chapters
        .map(
          (c) => `<section class="listen-chapter">
            ${c.intro ? "" : `<h2><span>${number(c)}</span>${escape(c.heading)}</h2>`}
            ${c.paras
              .map((ids) => {
                const said = ids.map((i) => sayHtml(i)).join(" ");
                const body = sentences[ids[0]].kind === "title" ? `<h1 class="listen-title">${said}</h1>` : `<p>${said}</p>`;
                return body + turnsAfter(ids).map((t) => turnHtml(t, lesson).replace("lesson-turn", `lesson-turn${t === turn && phase === "answering" ? " is-speaking" : ""}`)).join("");
              })
              .join("")}
          </section>`,
        )
        .join("")}
      ${lesson.done ? "" : `<span class="dots"><i></i><i></i><i></i></span>`}`;
  }

  function sayHtml(i) {
    const html = escape(sentences[i].text.replace(CITES, "")).replace(/\{([^{}]+)\}/g, `<em class="say-term">$1</em>`);
    return `<span class="say" data-i="${i}">${html}</span>`;
  }

  // Playing.

  function playFrom(i) {
    if (!lesson.done || !sentences.length) return;
    stop();
    phase = "player";
    if (i >= sentences.length) i = 0;
    playing = true;
    speakFrom(i, ++run);
    renderBar();
    loop();
  }

  async function speakFrom(i, token) {
    for (; i < sentences.length; i++) {
      for (let j = i + 1; j <= i + AHEAD && j < sentences.length && speechAvailable(); j++) speechUrl(plain(sentences[j].text)).catch(() => {});
      index = i;
      begun = performance.now();
      markNow(true);
      await say(plain(sentences[i].text));
      if (token !== run) return;
    }
    playing = false;
    index = sentences.length;
    markNow();
    renderBar();
  }

  function stop() {
    run++;
    playing = false;
    audio.pause();
    hush?.();
    globalThis.speechSynthesis?.cancel();
  }

  function pause() {
    stop();
    renderBar();
    paint();
  }

  function seek(t) {
    const i = Math.max(0, sentences.findLastIndex((s) => s.start <= t + 0.01));
    if (playing) playFrom(i);
    else {
      index = i;
      markNow(true);
      paint();
    }
  }

  // Resolves when the sentence has been said, or at once when speech is cancelled.
  async function say(text, voiceRate = rate) {
    if (speechAvailable()) {
      const token = run;
      try {
        const url = await speechUrl(text);
        if (token !== run) return;
        return await new Promise((resolve) => {
          hush = audio.onended = audio.onerror = () => {
            hush = null;
            resolve();
          };
          audio.src = url;
          audio.playbackRate = voiceRate;
          audio.play().catch(hush);
        });
      } catch {
        if (token !== run) return; // otherwise this sentence falls back to the browser's voice
      }
    }
    return sayInBrowser(text, voiceRate);
  }

  function sayInBrowser(text, voiceRate) {
    return new Promise((resolve) => {
      const synth = globalThis.speechSynthesis;
      if (!synth) return void setTimeout(resolve, ((words(text) / WORDS_PER_S + PAUSE_S) * 1000) / voiceRate);
      const u = new SpeechSynthesisUtterance(text);
      u.lang = language();
      u.voice = pickVoice(u.lang);
      u.rate = voiceRate;
      u.onend = u.onerror = () => resolve();
      synth.speak(u);
    });
  }

  function language() {
    return (built.match(/[äöå]/gi)?.length ?? 0) > built.length / 200 ? "fi-FI" : "en-US";
  }

  // Lesson time now: the start of the sentence being said, plus how far into it the voice is.
  function now() {
    if (scrub) return scrub.t;
    if (index >= sentences.length) return total();
    const s = sentences[index];
    if (!s) return 0;
    if (!playing) return s.start;
    // While ElevenLabs speaks, its clip says how far into the sentence the voice is.
    const into = !audio.paused && audio.duration > 0 ? audio.currentTime / audio.duration : ((performance.now() - begun) / 1000 / s.dur) * rate;
    return s.start + Math.min(into, 1) * s.dur;
  }

  function number(chapter) {
    return chapters.filter((c) => !c.intro).indexOf(chapter) + 1;
  }

  function total() {
    const last = sentences.at(-1);
    return last ? last.start + last.dur : 0;
  }

  function loop() {
    cancelAnimationFrame(frame);
    const tick = () => {
      paint();
      if (playing || scrub) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  // The scrubber, the times and the chapter label.
  function paint() {
    const t = now();
    for (const [i, seg] of bar.querySelectorAll(".player-seg i").entries()) {
      const c = chapters[i];
      seg.style.transform = `scaleX(${c ? clamp((t - c.start) / c.dur, 0, 1) : 0})`;
    }
    const track = bar.querySelector(".player-track");
    if (!track) return;
    track.setAttribute("aria-valuenow", String(Math.round(t)));
    track.setAttribute("aria-valuetext", `${clock(t)} of ${clock(total())}`);
    bar.querySelector(".player-now").textContent = clock(t);
    bar.querySelector(".player-left").textContent = `−${clock(total() - t)}`;
    const ci = Math.max(0, chapters.findLastIndex((c) => c.start <= t + 0.01));
    const label = bar.querySelector(".player-chapter");
    const c = chapters[ci];
    const text = c ? `${c.intro ? "" : `${number(c)} of ${chapters.filter((x) => !x.intro).length} · `}${c.heading}` : "";
    if (label.textContent !== text) label.textContent = text;
  }

  // The sentence being said is marked, and the transcript keeps it in view unless the reader scrolled lately.
  function markNow(follow = false) {
    for (const el of transcript.querySelectorAll(".say")) {
      const i = Number(el.dataset.i);
      el.classList.toggle("is-now", i === index && (playing || phase === "player"));
      el.classList.toggle("is-said", i < index);
    }
    const el = transcript.querySelector(`.say[data-i="${index}"]`);
    if (!follow || !el || performance.now() - heldScroll < 3000) return;
    const box = scroller.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    scroller.scrollTo({ top: scroller.scrollTop + r.top - box.top - box.height * 0.38, behavior: "smooth" });
  }

  // Asking in the middle.

  function startAsk() {
    turn = { wasPlaying: playing, at: Math.min(index, sentences.length - 1) };
    stop();
    phase = "typing";
    renderBar();
    bar.querySelector(".player-ask-input").focus();
  }

  function cancelAsk() {
    recognition?.abort();
    const { wasPlaying, at } = turn ?? {};
    turn = null;
    phase = "player";
    renderBar();
    if (wasPlaying) playFrom(at);
  }

  async function sendAsk(question) {
    recognition?.abort();
    const { at, wasPlaying } = turn;
    phase = "waiting";
    renderBar();
    const pending = ask(question, at);
    turn = lesson.followups.at(-1);
    Object.assign(turn, { wasPlaying });
    renderTranscript();
    markNow();
    transcript.querySelector(".lesson-turn:last-of-type")?.scrollIntoView({ behavior: "smooth", block: "center" });
    await pending;
    if (phase === "waiting") answerAloud();
  }

  async function answerAloud() {
    if (phase !== "waiting") return;
    phase = "answering";
    renderBar();
    renderTranscript();
    markNow();
    const token = ++run;
    playing = false;
    await say(plain(turn.text));
    if (token !== run) return;
    offerResume();
  }

  function offerResume() {
    phase = "resume";
    renderTranscript();
    markNow();
    let left = RESUME_S;
    renderBar(left);
    const step = () => {
      left--;
      if (left <= 0) return resume();
      renderBar(left);
      resumeTimer = setTimeout(step, 1000);
    };
    resumeTimer = setTimeout(step, 1000);
  }

  function resume() {
    clearTimeout(resumeTimer);
    const at = turn?.at ?? index;
    turn = null;
    playFrom(at);
  }

  function listenForQuestion(button) {
    const Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
    const input = bar.querySelector(".player-ask-input");
    if (recognition) return recognition.stop();
    recognition = new Recognition();
    recognition.lang = language();
    recognition.interimResults = true;
    recognition.onresult = (e) => {
      input.value = [...e.results].map((r) => r[0].transcript).join("");
      if (e.results[e.results.length - 1].isFinal) bar.querySelector(".player-ask-row").requestSubmit();
    };
    recognition.onerror = (e) => {
      input.placeholder = e.error === "not-allowed" ? "The microphone is blocked. Type your question." : "Didn't catch that. Type your question.";
    };
    recognition.onend = () => {
      recognition = null;
      button.classList.remove("is-listening");
    };
    button.classList.add("is-listening");
    recognition.start();
  }

  // The bar: the player, or the steps of a question.

  function renderBar(countdown = RESUME_S) {
    const ready = lesson.done && sentences.length > 0;
    if (phase === "typing") {
      const mic = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
      bar.innerHTML = `<form class="player-ask-row" autocomplete="off">
        ${mic ? `<button type="button" class="player-mic" data-act="mic" aria-label="Ask out loud">${ICONS.mic}</button>` : ""}
        <input class="player-ask-input" type="text" placeholder="Ask anything. The lesson waits for you." aria-label="Question" />
        <button type="button" class="player-text-btn" data-act="cancel">Back</button>
        <button type="submit" class="chat-send" aria-label="Ask"><svg viewBox="0 0 16 16"><path d="M8 13V3.5M4 7.5l4-4 4 4" /></svg></button>
      </form>`;
      return;
    }
    if (phase === "waiting" || phase === "answering" || phase === "resume") {
      const status = {
        waiting: `<span class="dots"><i></i><i></i><i></i></span>Thinking about your question…`,
        answering: `<span class="player-wave" aria-hidden="true"><i></i><i></i><i></i><i></i></span>Answering your question`,
        resume: `Back to the lesson in ${countdown}…`,
      }[phase];
      const actions = {
        waiting: `<button type="button" class="player-text-btn" data-act="resume">Skip</button>`,
        answering: `<button type="button" class="player-text-btn" data-act="resume">Skip answer</button>`,
        resume: `<button type="button" class="player-text-btn" data-act="ask">Ask another</button><button type="button" class="player-pill" data-act="resume">${ICONS.play}Resume now</button>`,
      }[phase];
      bar.innerHTML = `<div class="player-status" role="status"><p>${status}</p><div class="player-status-acts">${actions}</div></div>`;
      return;
    }
    const finished = index >= sentences.length && sentences.length > 0;
    bar.innerHTML = `
      <div class="player${ready ? "" : " is-waiting"}">
        <div class="player-track" role="slider" tabindex="0" aria-label="Position in the lesson" aria-valuemin="0" aria-valuemax="${Math.round(total())}">
          ${chapters.map((c) => `<span class="player-seg" style="flex: ${c.dur.toFixed(2)}" title="${escape(c.heading)}"><i></i></span>`).join("") || `<span class="player-seg"><i></i></span>`}
        </div>
        <div class="player-times"><span class="player-now">0:00</span><span class="player-chapter"></span><span class="player-left"></span></div>
        <div class="player-controls">
          <div class="player-side">
            <button type="button" class="player-rate" data-act="rate" aria-label="Speed">${rate}×</button>
            ${speechAvailable() ? voiceButton() : ""}
          </div>
          <div class="player-main">
            <button type="button" class="player-skip" data-act="back" aria-label="Back ${SKIP_S} seconds" ${ready ? "" : "disabled"}>${ICONS.back}</button>
            <button type="button" class="player-play" data-act="play" aria-label="${playing ? "Pause" : finished ? "Play again" : "Play"}" ${ready ? "" : "disabled"}>${playing ? ICONS.pause : ICONS.play}</button>
            <button type="button" class="player-skip" data-act="forward" aria-label="Forward ${SKIP_S} seconds" ${ready ? "" : "disabled"}>${ICONS.forward}</button>
          </div>
          ${askBox() ? "<span></span>" : `<button type="button" class="player-pill player-ask" data-act="ask" ${ready ? "" : "disabled"}>${ICONS.mic}Ask</button>`}
        </div>
      </div>`;
    paint();
  }

  // The voice picker: the voice's name, and a menu of the others above it.
  function voiceButton() {
    const now = currentVoice();
    return `<button type="button" class="player-voice" data-act="voices" aria-haspopup="menu" aria-expanded="${voiceMenu}" title="Voice">${ICONS.voice}<span>${escape(now.name)}</span></button>
      ${
        voiceMenu
          ? `<div class="player-voices" role="menu" aria-label="Voice">${VOICES.map(
              (v) => `<button type="button" role="menuitemradio" aria-checked="${v.id === now.id}" data-act="voice" data-voice="${v.id}">
                <span class="player-voice-name">${escape(v.name)}</span><span class="player-voice-note">${escape(v.note)}</span>
              </button>`,
            ).join("")}</div>`
          : ""
      }`;
  }

  function onBarClick(e) {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (voiceMenu && act !== "voices" && act !== "voice") {
      voiceMenu = false;
      renderBar();
    }
    if (act === "voices") {
      voiceMenu = !voiceMenu;
      renderBar();
    } else if (act === "voice") {
      voiceMenu = false;
      setVoice(e.target.closest("[data-voice]").dataset.voice);
      if (playing) playFrom(index); // the sentence again, in the new voice
      else renderBar();
    } else if (act === "play") playing ? pause() : playFrom(index);
    else if (act === "back" || act === "forward") seek(clamp(now() + (act === "back" ? -SKIP_S : SKIP_S), 0, total() - 0.01));
    else if (act === "rate") {
      rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
      write("learn-rate", rate);
      if (playing) playFrom(index);
      else renderBar();
    } else if (act === "ask") {
      clearTimeout(resumeTimer);
      if (phase === "resume") turn = { wasPlaying: true, at: turn.at };
      if (phase === "resume") {
        phase = "typing";
        renderBar();
        bar.querySelector(".player-ask-input").focus();
      } else startAsk();
    } else if (act === "cancel") cancelAsk();
    else if (act === "resume") {
      stop();
      resume();
    } else if (act === "mic") listenForQuestion(e.target.closest("[data-act]"));
  }

  function onAskSubmit(e) {
    e.preventDefault();
    const question = bar.querySelector(".player-ask-input")?.value.trim();
    if (question) sendAsk(question);
  }

  // Dragging the scrubber previews the time; letting go plays from there.
  function onTrackDown(e) {
    const track = e.target.closest(".player-track");
    if (!track || !lesson.done) return;
    const at = (x) => {
      const box = track.getBoundingClientRect();
      return clamp((x - box.left) / box.width, 0, 1) * total();
    };
    scrub = { t: at(e.clientX), track };
    track.setPointerCapture(e.pointerId);
    const move = (m) => (scrub.t = at(m.clientX));
    track.addEventListener("pointermove", move);
    scrub.cleanup = () => track.removeEventListener("pointermove", move);
    loop();
  }

  function endScrub() {
    const { t, cleanup } = scrub;
    cleanup();
    scrub = null;
    seek(t);
  }

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || !root.isConnected || root.closest("[hidden]")) return;
    if (!document.querySelector(".qm")?.hidden) return;
    if (e.key === "Escape" && voiceMenu) {
      e.preventDefault();
      voiceMenu = false;
      return renderBar();
    }
    if (e.key === " " && phase === "player" && !e.target.closest?.("button")) {
      e.preventDefault();
      playing ? pause() : playFrom(index);
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && phase === "player" && lesson.done) {
      e.preventDefault();
      seek(clamp(now() + (e.key === "ArrowLeft" ? -SKIP_S : SKIP_S), 0, total() - 0.01));
    } else if (e.key === "/" && phase === "player" && lesson.done) {
      e.preventDefault();
      const box = askBox();
      if (box) box.focus();
      else startAsk();
    }
  }
}

// Sentences of a paragraph, as written (citation markers and term braces are dropped when spoken).
function split(text) {
  const segmenter = globalThis.Intl?.Segmenter && new Intl.Segmenter(undefined, { granularity: "sentence" });
  const parts = segmenter ? [...segmenter.segment(text)].map((s) => s.segment) : text.match(/[^.!?]+[.!?]+["”)]*\s*|.+$/g) ?? [];
  return parts.map((s) => s.trim()).filter((s) => plain(s)).map((s) => ({ text: s, kind: "text" }));
}

let voices = [];
globalThis.speechSynthesis?.addEventListener?.("voiceschanged", () => (voices = speechSynthesis.getVoices()));

// The best-sounding voice for the language, when the system has one.
function pickVoice(lang) {
  if (!voices.length) voices = globalThis.speechSynthesis?.getVoices() ?? [];
  const fitting = voices.filter((v) => v.lang.replace("_", "-").startsWith(lang.slice(0, 2)));
  return fitting.find((v) => /premium|enhanced|natural|neural/i.test(v.name)) ?? fitting.find((v) => /google|samantha|satu/i.test(v.name)) ?? fitting[0] ?? null;
}

const ICONS = {
  play: `<svg viewBox="0 0 16 16" aria-hidden="true"><path class="fill" d="M5 3.2v9.6L12.6 8z" /></svg>`,
  pause: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect class="fill" x="4" y="3" width="2.8" height="10" rx="0.8" /><rect class="fill" x="9.2" y="3" width="2.8" height="10" rx="0.8" /></svg>`,
  back: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10a5.5 5.5 0 1 0 1.7-4M4 3v3.4h3.4" /><text x="10" y="12.4" text-anchor="middle">15</text></svg>`,
  forward: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.5 10a5.5 5.5 0 1 1-1.7-4M16 3v3.4h-3.4" /><text x="10" y="12.4" text-anchor="middle">15</text></svg>`,
  voice: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6.5v3M5.5 4.5v7M8 2.5v11M10.5 5v6M13 7v2" /></svg>`,
  mic: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="2" width="5" height="8" rx="2.5" /><path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14" /></svg>`,
};

const plain = (text) => text.replace(CITES, "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
const words = (text) => plain(text).split(" ").filter(Boolean).length;
const clock = (s) => `${Math.floor(Math.max(s, 0) / 60)}:${String(Math.floor(Math.max(s, 0) % 60)).padStart(2, "0")}`;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const isTyping = (target) => target.closest?.("input, textarea, select, [contenteditable='true']");
const read = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, String(v));
  } catch {}
};
