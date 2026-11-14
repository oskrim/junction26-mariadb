# Reader

A calm reading view for one article: contents on the left, text in the middle, images in the right margin.

Run it from the repo root:

```bash
python3 -m http.server 5100 -d reader
```

Then open <http://localhost:5100>.

All fake data lives in `fake/`. `fake/api.js` has the same three requests and response shapes as `app.py`.
To use real data, replace each function body with the `fetch` call written above it.
`wikitext.js` turns the article's `text` field into the page, so it works on real API responses as they are.

## Explore

The **Explore** switch in the top bar shows the article's related articles as a slowly turning 3D map
(`explore.js`, `explore.css`). Open it directly at <http://localhost:5100/?view=explore>.

- The article sits in the middle. Articles it links with are grouped by topic around it, and a fainter
  ring of articles one step further sits on the outside. The best-connected articles that have a picture show as cards.
- It reads `/api/graph` through `getGraph()`. Topic names come from `getTopics()`, which `app.py`
  doesn't have yet (see the note in `fake/api.js`).
- The fake link graph is built in `fake/graph.js` from the articles the Quantum computing page links to.
