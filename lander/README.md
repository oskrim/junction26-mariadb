# Lander

The landing page: the Wikipedia wordmark, a 3D puzzle globe, and an "ask anything" box.

Run it from the repo root:

    python3 -m http.server 5140 -d lander

then open http://localhost:5140.

- `api.js` searches the real articles through the app's API (`/api/search`, `/api/previews`) and opens results in the reader (`/?id=…`). If the API can't be reached it falls back to `fake/api.js`.
- `fake/api.js` holds the sample pages used as that fallback, plus the drifting background text.
- `globe.js` is the puzzle globe (three.js, bundled in `vendor/` so it works offline).
- `backdrop.js` is the drifting background text with live "edits".
