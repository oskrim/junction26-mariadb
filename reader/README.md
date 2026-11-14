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

## Cursor menu

This branch adds a liquid menu that rides on the pointer. Run it on its own port:

```bash
python3 -m http.server 5120 -d reader
```

- `cursor-menu.js` and `cursor-menu.css`: the menu and its prompt bar. Press Q to open it (no browser uses a bare Q).
- `chat.js`: the chats: a floating window or side panel, with a tray of tabs and a history list.
- `model3d.js`: the 3D qubit that Visualise shows, drawn on a canvas.
- `fake/assistant.js`: every canned answer and the earlier chats in History. Replace the body of `respond()` with a real call to go live.
