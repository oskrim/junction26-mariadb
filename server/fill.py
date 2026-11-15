"""Written in from other languages: the paragraphs the Swedish or English Wikipedia has that the Finnish one doesn't,
translated into Finnish and placed under the Finnish section they belong to.

    uv run -q --with pymysql --with snowballstemmer python server/fill.py build 498 1234   # embed, match, translate
    uv run -q --with pymysql python server/fill.py show 498           # every sv/en paragraph's distance to Finnish
    GET /api/fill?id=498                                              # builds on first request, then cached

1. The Finnish article (m_article's current text, wikitext or Markdown) and its Swedish and English S articles
   (s_article, linked through article_language) are cut into paragraphs, each remembering its section heading.
2. Every paragraph is embedded with Voyage (voyage-4-lite: one multilingual space, so an English paragraph lands
   next to the Finnish paragraph that says the same) into passage_voyage, a VECTOR(2048) column with a VECTOR INDEX.
   A paragraph is embedded once: a rebuild only embeds paragraphs whose text is new.
3. In MariaDB, VEC_DISTANCE_COSINE gives each sv/en paragraph its nearest Finnish paragraph of the same article. One
   that is far from all of them (MISSING) is something only that language tells. It goes under the Finnish section
   whose paragraphs are, on average, closest to it.
4. The best few are translated with Gemini (translation only) and cached in fill_translation; the finished answer is
   cached per Finnish revision in fill_result, so a repeated request is one row read.
"""
import hashlib
import html
import json
import os
import re
import sys
import time

MISSING = 0.50        # nearest Finnish paragraph further than this: Finnish does not say it. On Kalevala the median
                      # is 0.39 (same content across languages sits at 0.25-0.40); above 0.50 a grep of the Finnish
                      # text finds none of the names; 0.45-0.50 is mixed (Tolkien, Petaja: present)
SAME = 0.36           # a Swedish and an English paragraph this close tell the same thing: only one is kept
MIN_WORDS = 12        # shorter pieces are captions or fragments: not embedded
FILL_MIN_WORDS = 35   # a paragraph worth writing in is real prose of at least this many words
MAX_SECTIONS, MAX_PARAGRAPHS = 3, 3
VERSION = 2           # bump to drop every cached answer (fill_result) after a change to the method
TRANSLATE_MODEL = "gemini-3.5-flash"

PASSAGE_SQL = """
CREATE TABLE IF NOT EXISTS passage_voyage (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  wikidata_id VARCHAR(20)  NOT NULL,
  lang        CHAR(2)      NOT NULL,
  page_id     INT UNSIGNED NOT NULL,
  position    SMALLINT UNSIGNED NOT NULL,  -- order in the article
  section     VARCHAR(255) NOT NULL,       -- the heading it is under, as the reader renders it ('' for the lead)
  parent      VARCHAR(255) NOT NULL,       -- the level-2 heading above it ('' for the lead)
  kind        ENUM('prose', 'list', 'heading') NOT NULL,
  words       SMALLINT UNSIGNED NOT NULL,
  hash        CHAR(40)     NOT NULL,       -- sha1 of text: a paragraph is embedded once
  text        TEXT         NOT NULL,
  embedding   VECTOR(2048) NOT NULL,       -- voyage-4-lite, input_type document
  PRIMARY KEY (id),
  KEY article (wikidata_id, lang, position),
  VECTOR INDEX (embedding) M=16 DISTANCE=cosine
) CHARACTER SET utf8mb4
"""

TRANSLATION_SQL = """
CREATE TABLE IF NOT EXISTS fill_translation (
  hash        CHAR(40)    NOT NULL,  -- sha1 of lang + text
  lang        CHAR(2)     NOT NULL,
  model       VARCHAR(40) NOT NULL,
  text        TEXT        NOT NULL,
  translation TEXT        NOT NULL,
  PRIMARY KEY (hash)
) CHARACTER SET utf8mb4
"""

RESULT_SQL = """
CREATE TABLE IF NOT EXISTS fill_result (
  page_id  INT UNSIGNED NOT NULL,  -- Finnish page id
  rev_id   INT UNSIGNED NOT NULL,  -- the Finnish revision it was built from
  version  SMALLINT UNSIGNED NOT NULL,
  built_ms INT UNSIGNED NOT NULL,
  built_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  result   MEDIUMTEXT NOT NULL,     -- the JSON /api/fill returns
  PRIMARY KEY (page_id)
) CHARACTER SET utf8mb4
"""

# Sections that hold no prose: nothing is matched against them or written into them.
SKIP_FI = {"lähteet", "viitteet", "kirjallisuutta", "aiheesta muualla", "katso myös", "huomautukset", "lisätietoa",
           "lähdeluettelo", "lähdekirjallisuus", "aiheesta muualla", "ulkoiset linkit"}
SKIP_OTHER = {"references", "notes", "see also", "external links", "further reading", "bibliography", "sources",
              "citations", "footnotes", "works cited", "general references", "notes and references",
              "referenser", "noter", "källor", "se även", "externa länkar", "litteratur", "vidare läsning",
              "fotnoter", "tryckta källor", "webbkällor"}


# --- Paragraphs ------------------------------------------------------------------------------------------

INNERMOST = re.compile(r"\{\{[^{}]*\}\}|\{\|(?:(?!\{\||\|\}).)*\|\}", re.S)
FILE_LINK = re.compile(r"\[\[\s*(?:File|Image|Tiedosto|Kuva|Luokka|Category)\s*:[^\[\]]*(?:\[\[[^\[\]]*\]\][^\[\]]*)*\]\]", re.I)
LIST_LINE = ("*", "#", ":", ";", "- ", "• ")


def inline_wiki(text):
    """One line of wikitext as the words it shows."""
    text = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", text)
    text = re.sub(r"\[(?:https?:)?//[^\s\]]*\s*([^\]]*)\]", r"\1", text)
    text = re.sub(r"'{2,}|<[^>]+>", "", text)
    return " ".join(html.unescape(text).split())


def inline_md(text):
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[\d+\]|\[[a-z]\]|\[citation needed\]|\*\*|__", "", text)
    return " ".join(text.split())


def wikitext_paragraphs(wikitext):
    """[(section, parent, kind, text)] of a wikitext article: blank lines part paragraphs, list lines join up."""
    text = re.sub(r"<!--.*?-->|<(timeline|gallery|math|score|syntaxhighlight)[^>]*>.*?</\1>|<ref[^>]*/>|<ref[^>]*>.*?</ref>",
                  "", wikitext, flags=re.S | re.I)
    for _ in range(100):  # templates and tables nest: innermost first
        text, removed = INNERMOST.subn("", text)
        if not removed:
            break
    text = FILE_LINK.sub("", text)
    return split(text.splitlines(), heading=r"^(={2,6})\s*(.*?)\s*\1\s*$", level=lambda m: len(m[1]), inline=inline_wiki)


def markdown_paragraphs(markdown):
    """[(section, parent, kind, text)] of a Markdown article ("# Title" is the article itself)."""
    lines = [l for l in markdown.splitlines() if not l.lstrip().startswith(("|", "!["))]
    return split(lines, heading=r"^(#{1,6})\s*(.*?)\s*#*\s*$", level=lambda m: len(m[1]), inline=inline_md)


def split(lines, heading, level, inline):
    section = parent = ""
    pieces, buffer, kind = [], [], "prose"

    def flush():
        joined = " ".join(buffer).strip()
        if len(joined.split()) >= MIN_WORDS:
            pieces.append((section, parent, kind, joined))
        buffer.clear()

    for line in lines:
        line = line.strip()
        m = re.match(heading, line)
        if m:
            flush()
            if level(m) == 1:
                continue
            section = inline(m[2])
            if level(m) == 2:
                parent = section
            if section:
                pieces.append((section, parent, "heading", section))  # embedded too: headings place paragraphs
            continue
        if not line:
            flush()
            continue
        is_list = line.startswith(LIST_LINE)
        if buffer and (kind == "list") != is_list:
            flush()
        kind = "list" if is_list else "prose"
        line = inline(line.lstrip("*#:;-• "))
        if line:
            buffer.append(line)
        if kind == "prose" and len(" ".join(buffer).split()) >= 40 and line.endswith((".", "!", "?", '."', ".”")):
            flush()  # Markdown has no blank lines between paragraphs: a sentence end after 40 words closes one
    flush()
    return pieces


def skipped(section, parent, names):
    return section.lower() in names or parent.lower() in names


# --- Embedding -------------------------------------------------------------------------------------------

def sha1(text):
    return hashlib.sha1(text.encode()).hexdigest()


def store(cur, wd, lang, page_id, pieces):
    """passage_voyage holds exactly these pieces for (wd, lang); only text not embedded before goes to Voyage."""
    import voyage
    cur.execute("SELECT id, hash, embedding FROM passage_voyage WHERE wikidata_id = %s AND lang = %s", (wd, lang))
    have = {r["hash"]: r["embedding"] for r in cur.fetchall()}
    rows = [(s[:255], p[:255], k, t, sha1(t)) for s, p, k, t in pieces]
    new = list(dict.fromkeys(h for *_, h in rows if h not in have))
    if not new and len(have) == len(rows):
        cur.execute("SELECT COUNT(*) AS n FROM passage_voyage WHERE wikidata_id = %s AND lang = %s AND position < %s",
                    (wd, lang, len(rows)))
        if cur.fetchone()["n"] == len(rows):
            return 0  # nothing changed
    texts = {h: t for *_, t, h in rows}
    limit = voyage.RateLimit(50_000_000)
    for i in range(0, len(new), 128):
        batch = new[i:i + 128]
        vectors, _ = voyage.call_with_retries(limit, [texts[h] for h in batch])
        have.update(zip(batch, vectors))
    cur.execute("DELETE FROM passage_voyage WHERE wikidata_id = %s AND lang = %s", (wd, lang))
    cur.executemany("""INSERT INTO passage_voyage (wikidata_id, lang, page_id, position, section, parent, kind, words,
                                                   hash, text, embedding)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    [(wd, lang, page_id, n, s, p, k, min(len(t.split()), 65535), h, t, have[h])
                     for n, (s, p, k, t, h) in enumerate(rows)])
    cur.connection.commit()
    return len(new)


# --- Matching --------------------------------------------------------------------------------------------

def article(cur, page_id):
    """The Finnish article's current revision and its sv/en relatives, or None when it has none."""
    cur.execute("SELECT rev_id, title, text, format FROM m_article WHERE page_id = %s", (page_id,))
    fi = cur.fetchone()
    if not fi:
        return None
    cur.execute("""SELECT o.wikidata_id, o.lang, o.page_id, o.title, o.url FROM article_language f
                   JOIN article_language o ON o.wikidata_id = f.wikidata_id AND o.lang IN ('sv', 'en')
                   WHERE f.lang = 'fi' AND f.page_id = %s""", (page_id,))
    return fi, cur.fetchall()


def nearest(cur, wd):
    """Every sv/en paragraph of the article with its nearest Finnish paragraph, computed in MariaDB.

    Within one article the Finnish paragraphs number at most a few hundred, so every pair is compared
    (VEC_DISTANCE_COSINE over the rows the `article` key finds) instead of asking the vector index, which would
    search all articles and filter afterwards."""
    cur.execute("""
        WITH fi AS (SELECT id, section, parent, embedding FROM passage_voyage
                    WHERE wikidata_id = %(wd)s AND lang = 'fi' AND kind <> 'heading'),
             pair AS (SELECT o.id, o.lang, o.position, o.section, o.parent, o.kind, o.words, o.text,
                             f.id AS fi_id, f.section AS fi_section, VEC_DISTANCE_COSINE(o.embedding, f.embedding) AS d,
                             ROW_NUMBER() OVER (PARTITION BY o.id ORDER BY VEC_DISTANCE_COSINE(o.embedding, f.embedding)) AS r
                      FROM passage_voyage o JOIN fi f
                      WHERE o.wikidata_id = %(wd)s AND o.lang IN ('sv', 'en') AND o.kind <> 'heading')
        SELECT id, lang, position, section, parent, kind, words, text, fi_id, fi_section, d FROM pair WHERE r = 1
        ORDER BY lang, position""", {"wd": wd})
    return cur.fetchall()


def place(cur, wd, ids, explain=False):
    """{paragraph id: Finnish section} for the missing paragraphs ids, from three signals, all VEC_DISTANCE_COSINE:

    - neighbours: the other paragraphs of its source section ("Film and television") that Finnish does tell found
      their counterparts in some Finnish section ("Televisio ja elokuvat"); each votes, the closer the stronger
      (a section with no matches borrows its level-2 parent's votes);
    - headings: its source heading against the Finnish headings (embedded too: "Film and television" is 0.06 from
      "Televisio ja elokuvat", "Military" 0.15 from "Armeija");
    - itself: its own closest paragraph in each Finnish section, far as they all are.
    Only Finnish sections with a heading and prose take part (so the lead and Lähteet never get one)."""
    ids = set(ids)
    if not ids:
        return {}
    skip = tuple(SKIP_FI)
    allowed = """SELECT section, kind, embedding FROM passage_voyage
                 WHERE wikidata_id = %(wd)s AND lang = 'fi' AND section <> ''
                   AND LOWER(section) NOT IN %(skip)s AND LOWER(parent) NOT IN %(skip)s"""
    args = {"wd": wd, "skip": skip}
    # Every sv/en paragraph's nearest Finnish paragraph among the sections that can be written into.
    cur.execute(f"""
        WITH fi AS ({allowed}),
             pair AS (SELECT o.id, o.lang, o.section, o.parent, f.section AS fi_section,
                             VEC_DISTANCE_COSINE(o.embedding, f.embedding) AS d,
                             ROW_NUMBER() OVER (PARTITION BY o.id ORDER BY VEC_DISTANCE_COSINE(o.embedding, f.embedding)) AS r
                      FROM passage_voyage o JOIN fi f ON f.kind <> 'heading'
                      WHERE o.wikidata_id = %(wd)s AND o.lang IN ('sv', 'en') AND o.kind <> 'heading')
        SELECT id, lang, section, parent, fi_section, d FROM pair WHERE r = 1""", args)
    votes = {}
    for r in cur.fetchall():
        if r["d"] < MISSING:
            for key in ((r["lang"], "s", r["section"]), (r["lang"], "p", r["parent"])):
                tally = votes.setdefault(key, {})
                tally[r["fi_section"]] = tally.get(r["fi_section"], 0) + (MISSING - r["d"])
    # Per missing paragraph and Finnish section: its own closest paragraph there, and the two headings' distance.
    cur.execute(f"""
        WITH fi AS ({allowed}),
             c AS (SELECT id, lang, section, parent, embedding FROM passage_voyage WHERE id IN %(ids)s),
             own AS (SELECT c.id, f.section, MIN(VEC_DISTANCE_COSINE(c.embedding, f.embedding)) AS d
                     FROM c JOIN fi f ON f.kind <> 'heading' GROUP BY c.id, f.section),
             head AS (SELECT c.id, f.section, MIN(VEC_DISTANCE_COSINE(h.embedding, f.embedding)) AS d
                      FROM c JOIN passage_voyage h ON h.wikidata_id = %(wd)s AND h.lang = c.lang AND h.kind = 'heading'
                                                  AND h.section = c.section
                             JOIN fi f ON f.kind = 'heading' GROUP BY c.id, f.section)
        SELECT c.id, c.lang, c.section, c.parent, s.section AS fi_section, own.d AS own, head.d AS head
        FROM c JOIN (SELECT DISTINCT section FROM fi) s  -- a section with only a heading (Armeija) can take one too
             LEFT JOIN own ON own.id = c.id AND own.section = s.section
             LEFT JOIN head ON head.id = c.id AND head.section = s.section""", {**args, "ids": tuple(ids)})
    scores = {}
    for r in cur.fetchall():
        own_votes = votes.get((r["lang"], "s", r["section"]))
        tally = own_votes or votes.get((r["lang"], "p", r["parent"])) or {}
        # A vote's share of its section's votes, trusted less when the section matched only faintly, and half as
        # much when the votes are its parent section's.
        share = tally.get(r["fi_section"], 0) / sum(tally.values()) * min(1.0, sum(tally.values()) / 0.25) if tally else 0
        share *= 1 if own_votes else 0.5
        head = 3 * max(0.0, 0.40 - r["head"]) if r["head"] is not None else 0
        own = 2 * max(0.0, 0.65 - r["own"]) if r["own"] is not None else 0
        scores.setdefault(r["id"], {})[r["fi_section"]] = (share + head + own, round(share, 2), round(head, 2), round(own, 2))
    if explain:
        return scores
    return {i: max(s, key=lambda k: s[k][0]) for i, s in scores.items()}


def same_pairs(cur, ids):
    """Pairs of candidate paragraphs (one sv, one en) that say the same thing."""
    if len(ids) < 2:
        return []
    marks = ",".join(["%s"] * len(ids))
    cur.execute(f"""SELECT a.id AS a, b.id AS b FROM passage_voyage a JOIN passage_voyage b ON a.lang < b.lang
                    WHERE a.id IN ({marks}) AND b.id IN ({marks}) AND VEC_DISTANCE_COSINE(a.embedding, b.embedding) < %s""",
                (*ids, *ids, SAME))
    return [(r["a"], r["b"]) for r in cur.fetchall()]


def choose(cur, wd, rows):
    """The best few missing paragraphs: [(fi section, lang, [rows])]."""
    candidates = [r for r in rows if r["d"] > MISSING and r["kind"] == "prose" and r["words"] >= FILL_MIN_WORDS
                  and not skipped(r["section"], r["parent"], SKIP_OTHER)
                  and r["text"].count("/") < 3]  # scansion (Miele/ni mi/nun) is an example, not prose
    by_id = {r["id"]: r for r in candidates}
    for a, b in same_pairs(cur, list(by_id)):  # Swedish and English both lack it in Finnish: keep the farther one
        if a in by_id and b in by_id:
            del by_id[min((a, b), key=lambda i: by_id[i]["d"])]
    sections = place(cur, wd, list(by_id))
    groups = {}
    for r in by_id.values():
        if r["id"] in sections:
            groups.setdefault(sections[r["id"]], {}).setdefault(r["lang"], []).append(r)
    chosen = []
    for section, langs in groups.items():
        # One language per section (a heading gets one chip): the one with the most to add.
        lang, paragraphs = max(langs.items(), key=lambda kv: sum(score(r) for r in kv[1]))
        best = sorted(paragraphs, key=score, reverse=True)[:MAX_PARAGRAPHS]
        chosen.append((section, lang, sorted(best, key=lambda r: r["position"])))
    chosen.sort(key=lambda c: sum(score(r) for r in c[2]), reverse=True)
    return chosen[:MAX_SECTIONS]


def score(r):
    """How much a paragraph adds: how far it is from anything Finnish says, more for a fuller paragraph."""
    return (r["d"] - MISSING + 0.02) * min(r["words"], 150) ** 0.5


# --- Translation -----------------------------------------------------------------------------------------

TRANSLATE_RULES = """You translate paragraphs of Wikipedia into Finnish for the Finnish Wikipedia.
Translate each paragraph exactly: say what it says and nothing more. Do not add, explain, summarize or leave out
anything. Keep names of people, places, works and organisations as they are, using the established Finnish form
only where one exists (Helsinki, not Helsingfors); titles of books, films, songs and episodes stay as written. Write natural encyclopedic Finnish. Return the translations in
the same order as the paragraphs, one per paragraph."""
TRANSLATE_SCHEMA = {"type": "OBJECT", "properties": {"translations": {"type": "ARRAY", "items": {"type": "STRING"}}},
                    "required": ["translations"]}
NAMES = {"sv": "Swedish", "en": "English"}


def translate(cur, lang, texts):
    """Finnish translations of texts, from fill_translation where done before, else from Gemini in one call."""
    import learn
    keys = [sha1(lang + "\n" + t) for t in texts]
    cur.execute(f"SELECT hash, translation FROM fill_translation WHERE hash IN ({','.join(['%s'] * len(keys))})", keys)
    done = {r["hash"]: r["translation"] for r in cur.fetchall()}
    todo = [(k, t) for k, t in zip(keys, texts) if k not in done]
    if todo:
        prompt = "\n\n".join(f"Paragraph {n + 1} ({NAMES[lang]}):\n{t}" for n, (_, t) in enumerate(todo))
        config = {"thinkingConfig": {"thinkingLevel": "low"}, "responseMimeType": "application/json",
                  "responseSchema": TRANSLATE_SCHEMA, "temperature": 0.2}
        with learn.gemini(TRANSLATE_MODEL, "generateContent", TRANSLATE_RULES,
                          [{"role": "user", "parts": [{"text": prompt}]}], config) as response:
            reply = json.loads(response.read())
        out = json.loads("".join(learn.texts(reply)))["translations"]
        if len(out) != len(todo):
            raise RuntimeError(f"Gemini returned {len(out)} translations for {len(todo)} paragraphs")
        cur.executemany("REPLACE INTO fill_translation VALUES (%s, %s, %s, %s, %s)",
                        [(k, lang, TRANSLATE_MODEL, t, " ".join(f.split())) for (k, t), f in zip(todo, out)])
        cur.connection.commit()
        done.update((k, " ".join(f.split())) for (k, _), f in zip(todo, out))
    return [done[k] for k in keys]


# --- Building and serving --------------------------------------------------------------------------------

def tables(cur):
    for sql in (PASSAGE_SQL, TRANSLATION_SQL, RESULT_SQL):
        cur.execute(sql)


def build(cur, page_id, log=print):
    """The /api/fill answer for a Finnish page id, built from scratch (embeddings and translations reused)."""
    started = time.perf_counter()
    tables(cur)
    found = article(cur, page_id)
    if not found:
        return {"sections": []}, 0
    fi, others = found
    if others:
        wd = others[0]["wikidata_id"]
        pieces = wikitext_paragraphs(fi["text"]) if fi["format"] == "wikitext" else markdown_paragraphs(fi["text"])
        embedded = store(cur, wd, "fi", page_id, pieces)
        sources = {}
        for o in others:
            cur.execute("SELECT text FROM s_article WHERE lang = %s AND page_id = %s", (o["lang"], o["page_id"]))
            row = cur.fetchone()
            if row:
                embedded += store(cur, wd, o["lang"], o["page_id"], markdown_paragraphs(row["text"]))
                sources[o["lang"]] = o
        chosen = choose(cur, wd, nearest(cur, wd))
        sections = []
        for section, lang, paragraphs in chosen:
            translations = translate(cur, lang, [r["text"] for r in paragraphs])
            source = sources[lang]
            anchor = paragraphs[0]["section"]
            sections.append({"section": section, "lang": lang, "source_title": source["title"],
                             "source_url": source["url"] + ("#" + anchor.replace(" ", "_") if anchor else ""),
                             "paragraphs": [{"text": r["text"], "translation": t, "distance": round(r["d"], 3),
                                             "source_section": r["section"]}
                                            for r, t in zip(paragraphs, translations)]})
        log(f"{page_id} {fi['title']}: {embedded} paragraphs embedded, {len(sections)} sections filled")
    else:
        sections = []
    result = {"sections": sections}
    ms = round((time.perf_counter() - started) * 1000)
    cur.execute("REPLACE INTO fill_result (page_id, rev_id, version, built_ms, result) VALUES (%s, %s, %s, %s, %s)",
                (page_id, fi["rev_id"], VERSION, ms, json.dumps(result, ensure_ascii=False)))
    cur.connection.commit()
    return result, ms


def serve(cur, params):
    """GET /api/fill?id=<Finnish page id>: the cached answer for the current revision, else built now."""
    try:
        page_id = int(params["id"][0])
    except (KeyError, ValueError):
        return {"error": "id must be a number", "sections": []}
    try:
        cur.execute("""SELECT r.result FROM fill_result r JOIN m_article m ON m.page_id = r.page_id AND m.rev_id = r.rev_id
                       WHERE r.page_id = %s AND r.version = %s""", (page_id, VERSION))
        row = cur.fetchone()
        if row:
            return json.loads(row["result"])
    except Exception as error:  # the tables are not there yet: build makes them
        if getattr(error, "args", [None])[0] != 1146:
            raise
    try:
        return build(cur, page_id, log=lambda *a: print(*a, file=sys.stderr, flush=True))[0]
    except Exception as error:  # Voyage or Gemini down: nothing to write in, the article still reads
        print(f"fill {page_id}: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        return {"sections": [], "error": str(error)[:300]}


def show(cur, page_id):
    """Each sv/en paragraph's distance to the nearest Finnish one, for calibrating MISSING."""
    found = article(cur, page_id)
    if not found or not found[1]:
        return print(f"{page_id}: no other languages")
    wd = found[1][0]["wikidata_id"]
    rows = nearest(cur, wd)
    for r in sorted(rows, key=lambda r: r["d"]):
        mark = "MISS" if r["d"] > MISSING else "    "
        print(f"{mark} {r['d']:.3f} {r['lang']} {r['kind'][:1]} {r['words']:4} [{r['section'][:24]}] -> "
              f"[{r['fi_section'][:24]}] {r['text'][:110]}")
    ds = sorted(r["d"] for r in rows)
    if ds:
        print(f"{len(ds)} paragraphs; quartiles {[round(ds[int(len(ds) * q)], 3) for q in (0.25, 0.5, 0.75, 0.9)]}; "
              f"> {MISSING}: {sum(d > MISSING for d in ds)}")
    missing = {r["id"]: r for r in rows if r["d"] > MISSING and r["kind"] == "prose"}
    for i, s in place(cur, wd, missing, explain=True).items():
        top = sorted(s.items(), key=lambda kv: -kv[1][0])[:3]
        print(f"[{missing[i]['section'][:24]}] {missing[i]['text'][:60]}\n    " +
              "  ".join(f"{k[:22]} {v[0]:.2f}={v[1]}+{v[2]}+{v[3]}" for k, v in top))


def connect():
    import pymysql
    return pymysql.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"), port=int(os.environ.get("DB_PORT", 3309)),
        user=os.environ.get("DB_USER", "wiki"), password=os.environ.get("DB_PASSWORD", "wiki"),
        database=os.environ.get("DB_NAME", "wiki"), charset="utf8mb4", max_allowed_packet=64 << 20,
        cursorclass=pymysql.cursors.DictCursor, autocommit=False)


def main():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    if len(sys.argv) < 3 or sys.argv[1] not in ("build", "show", "embed"):
        sys.exit(__doc__)
    cur = connect().cursor()
    for page_id in map(int, sys.argv[2:]):
        if sys.argv[1] == "build":
            result, ms = build(cur, page_id)
            print(json.dumps(result, ensure_ascii=False, indent=1)[:4000], f"\n{ms} ms")
        elif sys.argv[1] == "embed":  # only steps 1-2, for calibrating with show
            tables(cur)
            fi, others = article(cur, page_id)
            wd = others[0]["wikidata_id"]
            pieces = wikitext_paragraphs(fi["text"]) if fi["format"] == "wikitext" else markdown_paragraphs(fi["text"])
            print("fi", store(cur, wd, "fi", page_id, pieces), "embedded")
            for o in others:
                cur.execute("SELECT text FROM s_article WHERE lang = %s AND page_id = %s", (o["lang"], o["page_id"]))
                print(o["lang"], store(cur, wd, o["lang"], o["page_id"], markdown_paragraphs(cur.fetchone()["text"])), "embedded")
        else:
            show(cur, page_id)


if __name__ == "__main__":
    main()
