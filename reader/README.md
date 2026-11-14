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
