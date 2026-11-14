# Puzzle globe model

The real Wikipedia puzzle globe, slimmed down for the web.

| file | what | size |
|---|---|---|
| `globe.bin` + `globe.json` | 51 puzzle pieces, ~22k triangles, meshopt-compressed | ~85 KB |
| `letters.png` | the carved letters, painted into one image wrapped around the ball | ~63 KB |

The original is 122 MB and 2.4 million triangles, most of them in the carved letters. To make it light,
the letters are painted into `letters.png` and the carving is flattened, then each piece is simplified.

## Credits and license

"Wikipedia puzzle globe 3D render" — 3D model by Because We Can; Wikipedia puzzle globe version 1 by
Nohat (concept by Paullusmagnus); Wikimedia Foundation. CC BY-SA 3.0.
https://commons.wikimedia.org/wiki/File:Wikipedia_puzzle_globe_3D_render.stl

These derived files are shared under the same license (CC BY-SA 3.0). The globe is a trademark of the
Wikimedia Foundation.

## Rebuilding

    npm i meshoptimizer@0.21.0
    node build/letters.mjs Wikipedia_puzzle_globe_3D_render.stl letters.png 4096
    node --max-old-space-size=8000 build/build.mjs Wikipedia_puzzle_globe_3D_render.stl . 0.004
