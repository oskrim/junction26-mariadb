// The Concepts view: ways of seeing an article's neighborhood in 3D, side by side. A switch at the top
// picks one; each loads the first time it is picked, with its own stylesheet, into its own pane, and
// stays mounted so switching back is instant. The open one is kept in the address as ?concept=.

const CONCEPTS = [
  { key: "cone", label: "Cone", module: "./depth.js", mount: "mountDepth" },
  { key: "archipelago", label: "Archipelago", module: "./archipelago.js", mount: "mountArchipelago", css: "archipelago.css" },
  { key: "galaxy", label: "Galaxy", module: "./galaxy.js", mount: "mountGalaxy", css: "galaxy.css" },
];

export function mountConcepts(root, { id }) {
  root.innerHTML = `
    <div class="cc-panes"></div>
    <div class="cc-switch" role="tablist" aria-label="Concept">
      ${CONCEPTS.map((c) => `<button type="button" role="tab" data-concept="${c.key}" aria-selected="false">${c.label}</button>`).join("")}
    </div>`;
  const panes = root.querySelector(".cc-panes");
  const switcher = root.querySelector(".cc-switch");
  const mounted = new Map();

  const show = (key) => {
    const concept = CONCEPTS.find((c) => c.key === key) ?? CONCEPTS[0];
    for (const b of switcher.querySelectorAll("[data-concept]")) b.setAttribute("aria-selected", String(b.dataset.concept === concept.key));
    for (const [k, pane] of mounted) pane.hidden = k !== concept.key;
    if (!mounted.has(concept.key)) {
      const pane = document.createElement("div");
      pane.className = "cc-pane";
      panes.append(pane);
      mounted.set(concept.key, pane);
      if (concept.css && !document.querySelector(`link[href="./${concept.css}"]`)) {
        document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: `./${concept.css}` }));
      }
      // The article shown follows the address, since a concept can move to another article.
      const shownId = Number(new URL(location.href).searchParams.get("id") ?? id);
      import(concept.module).then((m) => m[concept.mount](pane, { id: shownId }));
    }
    const url = new URL(location.href);
    url.searchParams.set("concept", concept.key);
    history.replaceState(null, "", url);
  };

  switcher.addEventListener("click", (event) => {
    const b = event.target.closest("[data-concept]");
    if (b) show(b.dataset.concept);
  });
  show(new URL(location.href).searchParams.get("concept") ?? "cone");
}
