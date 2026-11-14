// What the server is doing for one answer, as a live list above it. Server events: "step" {id, text, done}
// (a later event with the same id updates that step), "thinking" (a piece of Gemini's thought summary) and
// "error" (the running step failed). When the answer starts, the list folds into one line such as "5 steps · 3.2 s".

export function stepsView(reply) {
  const started = performance.now();
  const box = document.createElement("div");
  box.className = "steps";
  box.hidden = true;
  box.innerHTML = `
    <button type="button" class="steps-sum" aria-expanded="false" hidden></button>
    <ol class="steps-list"></ol>
    <details class="steps-thinking" hidden><summary>Thinking</summary><p></p></details>`;
  reply.prepend(box);
  const sum = box.querySelector(".steps-sum");
  const list = box.querySelector(".steps-list");
  const thinking = box.querySelector(".steps-thinking");
  const items = new Map();
  sum.addEventListener("click", () => {
    const open = !box.classList.contains("is-open");
    box.classList.toggle("is-open", open);
    sum.setAttribute("aria-expanded", String(open));
  });
  return { update, fold };

  function update(name, data) {
    if (name === "step") {
      const li = items.get(data.id) ?? add(data.id);
      li.className = `step ${data.done ? "is-done" : "is-running"}`;
      li.querySelector(".step-text").textContent = data.text;
    } else if (name === "thinking") {
      thinking.hidden = false;
      thinking.querySelector("p").textContent += data;
    } else if (name === "error") {
      const li = [...items.values()].findLast((s) => s.classList.contains("is-running")) ?? add(`error-${items.size}`);
      li.className = "step is-failed";
      if (!li.querySelector(".step-text").textContent) li.querySelector(".step-text").textContent = "Could not finish";
      li.insertAdjacentHTML("beforeend", `<span class="step-error"></span>`);
      li.lastElementChild.textContent = data;
      box.classList.remove("is-folded");
      sum.hidden = true;
    } else return;
    box.hidden = false;
    reply.classList.add("has-steps");
  }

  function add(id) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="step-mark" aria-hidden="true"></span><span class="step-text"></span>`;
    items.set(id, li);
    list.append(li);
    return li;
  }

  // Called when the answer text starts; a failed request stays unfolded.
  function fold() {
    if (box.hidden || box.classList.contains("is-folded") || list.querySelector(".is-failed")) return;
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    sum.textContent = `${items.size} step${items.size === 1 ? "" : "s"} · ${seconds} s`;
    sum.hidden = false;
    box.classList.add("is-folded");
  }
}
