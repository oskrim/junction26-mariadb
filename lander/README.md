# Lander

The landing page: the Wikipedia wordmark, a 3D puzzle globe, and an "ask anything" box.

Run it from the repo root:

    python3 -m http.server 5140 -d lander

then open http://localhost:5140.

- `fake/api.js` holds every fake piece of data and behaviour (same shapes as `app.py`, plus a canned chat reply).
- `globe.js` is the puzzle globe (three.js, bundled in `vendor/` so it works offline).
- `backdrop.js` is the drifting background text with live "edits".
