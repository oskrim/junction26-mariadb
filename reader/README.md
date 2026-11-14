# Wikipedia, reimagined

One page with three views of an article, switched in the top bar:

- **Article**: a calm reading view with contents on the left and images in the margin. Hover a link for a preview.
  Press Q for the query bar: type anything, and Gemini routes it to Ask, Find, Learn or Visualise in a chat.
- **Explore**: the article's related articles as a 3D map you can grow outward.
- **History**: the article's whole edit history as a 3D path you fly along, with the article as it read at
  each moment in a sidebar, and edit wars you can watch being fought.

Run it from the repo root:

```bash
python3 -m http.server 5130 -d reader
```

Then open <http://localhost:5130>. Each view has its own address: `?view=explore` and `?view=history`.

The data comes from `server/app.py` through `api.js`:

- A page served by `app.py` asks its own server: <https://65-109-75-60.sslip.io>, or `app.py` run locally on port
  8010 or 8011 (see `server/README.md`).
- A page served any other way, such as the static server above, asks the cloud at
  <https://65-109-75-60.sslip.io>. So the static server works as it is, with no database on your machine.

`fake/api.js` is the earlier stand-in for the API, with the same functions and response shapes. Nothing imports it now.
`wikitext.js` turns the article's `text` field into the page, so it works on real API responses as they are.

## Explore

The **Explore** switch in the top bar shows the article's related articles as a slowly turning 3D map
(`explore.js`, `explore.css`). Open it directly at <http://localhost:5130/?view=explore>.

- The article sits in the middle. Articles it links with are grouped by topic around it, and a fainter
  ring of articles one step further sits on the outside. The best-connected articles that have a picture show as cards.
- Clicking an article grows the map from it: its own links branch out around it, so you can keep going outward.
  With "Keep … in the middle" switched off, a click moves that article to the middle instead.
- It reads `/api/graph` through `getGraph()`. Topic names come from `getTopics()`, which `app.py`
  doesn't have yet (see the note in `fake/api.js`).
- The fake link graph is built in `fake/graph.js` from the articles the Quantum computing page links to.

## Query bar

- `cursor-menu.js` and `cursor-menu.css`: the query bar. Press Q to open it (no browser uses a bare Q); select or
  paint a passage to ask about it. POST /api/intent (`server/intent.py`) picks the path for each request.
- `chat.js`: the chats: a floating window or side panel, with a tray of tabs and a history list.
- `model3d.js`: the 3D qubit that Visualise shows, drawn on a canvas.
- `fake/assistant.js`: every canned answer and the earlier chats in History. Replace the body of `respond()` with a real call to go live.

## Learn

Learn (L in the cursor menu) opens a wide sheet at the top of the page instead of a chat.

- `learn-view.js`, `learn-view.css`: the lesson. `/api/learn` with `shape: "lesson"` reads the article's links and
  writes a title, a one-line goal, 3 or 4 sections and the terms a newcomer would not know. A term opens a card with
  what it means here; "Learn about …" makes it a lesson of its own, and the trail at the top goes back. Questions go
  under the lesson (`shape: "reply"`).
- `learn-audio.js`: Listen, the lesson as an audio book with chapters, a transcript that follows the voice, and Ask,
  which pauses it, reads the answer out where it was asked and then carries on. The voice is the browser's speech
  synthesis for now.

## History

The **History** view (`history.js`) is built from:

- `history-model.js`: finds reverts (a version whose text matches an older one exactly), groups them into edit
  wars, and picks the edits that get a card.
- `timeline3d.js`, `history-cards.js`, `minimap.js`: the 3D path, its cards and the year strip.
- `article-panel.js` and `diff.js`: the article at the current moment, with what changed marked.
- `war-replay.js`: the edit war replay, with each fighter's cursor. `censor.js` masks slurs in shown text.
- It reads `getHistory()` (every version without its text) and `/api/article` for the text at a moment.
  The prototype stores the text of about 400 of the 5,047 versions in `fake/versions/` and `fake/wars/`.
