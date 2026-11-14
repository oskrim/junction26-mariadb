# Puzzle globe model

The real Wikipedia puzzle globe, slimmed down for the web.

| file | what | size |
|---|---|---|
| `globe.bin` + `globe.json` | 51 puzzle pieces, ~22k triangles, meshopt-compressed | ~85 KB |
| `surface.png` | the carved letters and the seams between pieces, painted into one grey image wrapped around the ball (0–100 = seam, 100–255 = letter) | ~100 KB |

The original is 122 MB and 2.4 million triangles, most of them in the carved letters. To make it light,
the letters and seams are painted into `surface.png` and the carving is flattened, then each piece is simplified.

## Credits and license

"Wikipedia puzzle globe 3D render" — 3D model by Because We Can; Wikipedia puzzle globe version 1 by
Nohat (concept by Paullusmagnus); Wikimedia Foundation. CC BY-SA 3.0.
https://commons.wikimedia.org/wiki/File:Wikipedia_puzzle_globe_3D_render.stl

These derived files are shared under the same license (CC BY-SA 3.0). The globe is a trademark of the
Wikimedia Foundation.

## Rebuilding

    npm i meshoptimizer@0.21.0
    node --max-old-space-size=8000 build/surface.mjs Wikipedia_puzzle_globe_3D_render.stl surface.png 3072 1.6
    node --max-old-space-size=8000 build/build.mjs Wikipedia_puzzle_globe_3D_render.stl . 0.004
