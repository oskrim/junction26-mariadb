"""Other tellings: the same article in Finnish, Swedish and English Wikipedia, paragraph by paragraph.

    DB_NAME=wiki uv run --with torch --with transformers --with pymysql python server/tellings.py build Q152486 Q211855
    DB_NAME=wiki uv run --with pymysql python server/tellings.py show Q152486
    DB_NAME=wiki uv run --with pymysql python server/tellings.py languages   # every S article's length per language

languages fills `article_language`: one row per S article with its title, address and words, so the reader can
say "Swedish Wikipedia has 5x more on this" for any article without reading three texts.

build splits each language's S text (s_article, linked by wikidata_id) into paragraphs, embeds each with bge-m3
(the model of article_vector, so an English paragraph lands next to its Finnish counterpart) and stores them in
`passage`. Then it pairs every Swedish and English paragraph with its closest Finnish one in `passage_match`.
A paragraph with no close Finnish one is something only that language tells.

It only adds these two tables and only reads s_article; running it again rebuilds the articles it is given.
"""
import re
import sys

PASSAGE_SQL = """
CREATE TABLE IF NOT EXISTS passage (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  wikidata_id VARCHAR(20)  NOT NULL,
  lang        CHAR(2)      NOT NULL,
  page_id     INT UNSIGNED NOT NULL,
  position    SMALLINT UNSIGNED NOT NULL,  -- order in the article
  section     VARCHAR(255) NOT NULL,       -- the heading it is under ('' for the introduction)
  words       SMALLINT UNSIGNED NOT NULL,
  text        TEXT         NOT NULL,
  embedding   VECTOR(1024) NOT NULL,
  PRIMARY KEY (id),
  KEY article (wikidata_id, lang, position),
  VECTOR INDEX (embedding) M=16 DISTANCE=cosine
) CHARACTER SET utf8mb4
"""

# One row per Swedish or English paragraph: the Finnish paragraph closest in meaning, and how close.
MATCH_SQL = """
CREATE TABLE IF NOT EXISTS passage_match (
  passage_id INT UNSIGNED NOT NULL,
  fi_id      INT UNSIGNED NOT NULL,
  distance   FLOAT        NOT NULL,  -- cosine distance: 0 is the same meaning
  PRIMARY KEY (passage_id),
  KEY (fi_id)
)
"""

LANGUAGE_SQL = """
CREATE TABLE IF NOT EXISTS article_language (
  wikidata_id VARCHAR(20)  NOT NULL,
  lang        CHAR(2)      NOT NULL,
  page_id     INT UNSIGNED NOT NULL,
  title       VARCHAR(255) NOT NULL,
  url         VARCHAR(500) NOT NULL,
  words       INT UNSIGNED NOT NULL,  -- in its paragraphs(): tables and captions left out
  PRIMARY KEY (wikidata_id, lang),
  KEY page (lang, page_id)
) CHARACTER SET utf8mb4
"""

LANGUAGE_NAMES = {"fi": "Finnish", "sv": "Swedish", "en": "English"}

MIN_WORDS = 12  # shorter lines are captions, list fragments or headings in disguise
MAX_WORDS = 220  # short lines are joined up to this, so a list becomes one passage
LOOSE = 0.35     # above this distance no Finnish paragraph says the same thing (tuned by eye; see show)


def paragraphs(text):
    """(section, text) pieces of a Markdown article: tables, images and stray short lines left out."""
    section, pieces, buffer = "", [], []

    def flush():
        joined = " ".join(buffer).strip()
        if len(joined.split()) >= MIN_WORDS:
            pieces.append((section, joined))
        buffer.clear()

    for line in text.splitlines():
        line = line.strip()
        heading = re.match(r"(#+)\s*(.*)", line)
        if heading:
            flush()
            section = heading[2].strip() if len(heading[1]) > 1 else ""  # "# Title" is the article itself
            continue
        if not line or line.startswith(("|", "![")):
            flush()
            continue
        line = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", line).lstrip("*-• ").strip()  # links to their words
        buffer.append(line)
        if len(line.split()) >= MIN_WORDS * 3 or len(" ".join(buffer).split()) >= MAX_WORDS:
            flush()  # a real paragraph stands alone; short lines collect until they make one
    flush()
    return pieces


def build(cur, wikidata_ids):
    from embed import Encoder, packed
    cur.execute(PASSAGE_SQL)
    cur.execute(MATCH_SQL)
    encoder = Encoder()
    print(f"bge-m3 on {encoder.device}")
    for wd in wikidata_ids:
        cur.execute("SELECT lang, page_id, title, text FROM s_article WHERE wikidata_id = %s ORDER BY lang", (wd,))
        rows = cur.fetchall()
        if not any(r[0] == "fi" for r in rows):
            print(f"{wd}: no Finnish article, skipped")
            continue
        cur.execute("DELETE m FROM passage_match m JOIN passage p ON p.id = m.passage_id WHERE p.wikidata_id = %s", (wd,))
        cur.execute("DELETE FROM passage WHERE wikidata_id = %s", (wd,))
        for lang, page_id, title, text in rows:
            pieces = paragraphs(text)
            vectors = []
            for i in range(0, len(pieces), 16):  # small batches: a laptop's memory, not a GPU's
                vectors += encoder.encode([t for _, t in pieces[i:i + 16]])[0]
            cur.executemany("""INSERT INTO passage (wikidata_id, lang, page_id, position, section, words, text, embedding)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                            [(wd, lang, page_id, n, s[:255], min(len(t.split()), 65535), t, packed(v))
                             for n, ((s, t), v) in enumerate(zip(pieces, vectors))])
            print(f"{wd} {lang} {title}: {len(pieces)} paragraphs")
        match(cur, wd)
        cur.connection.commit()


def match(cur, wd):
    """Each Swedish and English paragraph's closest Finnish paragraph of the same article.

    Within one article there are at most a few hundred Finnish paragraphs, so this compares them all
    (VEC_DISTANCE_COSINE over the article's rows, found by the `article` key) instead of asking the vector
    index, which searches every article and would need the filter afterwards."""
    cur.execute("""INSERT INTO passage_match (passage_id, fi_id, distance)
                   SELECT o.id, (SELECT f.id FROM passage f WHERE f.wikidata_id = o.wikidata_id AND f.lang = 'fi'
                                 ORDER BY VEC_DISTANCE_COSINE(f.embedding, o.embedding) LIMIT 1),
                          (SELECT MIN(VEC_DISTANCE_COSINE(f.embedding, o.embedding)) FROM passage f
                           WHERE f.wikidata_id = o.wikidata_id AND f.lang = 'fi')
                   FROM passage o WHERE o.wikidata_id = %s AND o.lang <> 'fi'""", (wd,))


def languages(cur):
    cur.execute(LANGUAGE_SQL)
    cur.execute("SELECT wikidata_id, lang, page_id, title, url, text FROM s_article WHERE wikidata_id IS NOT NULL")
    rows = [(wd, lang, page_id, title, url, sum(len(t.split()) for _, t in paragraphs(text)))
            for wd, lang, page_id, title, url, text in cur.fetchall()]
    cur.executemany("REPLACE INTO article_language VALUES (%s, %s, %s, %s, %s, %s)", rows)
    cur.connection.commit()
    print(f"{len(rows)} articles")


def serve(cur, params):
    """GET /api/tellings?id=<Finnish page id>: how long the article is in each language (with each one's page
    id in its own wiki), and per Finnish section the Swedish and English paragraphs closest to it (only for
    articles `build` has done). Empty when the tables are not there yet. With lang=sv|en, id is that wiki's page
    id and only the languages come back: the sections are told from the Finnish side."""
    import pymysql
    page_id = int(params["id"][0])
    lang = params.get("lang", ["fi"])[0]
    if lang not in LANGUAGE_NAMES:
        lang = "fi"
    found = []
    try:
        cur.execute("""SELECT o.lang, o.page_id, o.title, o.url, o.words FROM article_language f
                       JOIN article_language o ON o.wikidata_id = f.wikidata_id
                       WHERE f.lang = %s AND f.page_id = %s ORDER BY o.lang = 'fi' DESC, o.words DESC""", (lang, page_id))
        found = [{**r, "name": LANGUAGE_NAMES[r["lang"]]} for r in cur.fetchall()]
        if len(found) < 2 or lang != "fi":
            return {"languages": found, "sections": []}
        cur.execute("""SELECT f.section, f.position, f.words AS fi_words, o.lang, o.section AS their_section,
                              o.position AS their_position, o.words, o.text
                       FROM passage f LEFT JOIN passage_match m ON m.fi_id = f.id LEFT JOIN passage o ON o.id = m.passage_id
                       WHERE f.wikidata_id = (SELECT wikidata_id FROM article_language WHERE lang = 'fi' AND page_id = %s)
                         AND f.lang = 'fi'
                       ORDER BY f.position, o.lang, o.position""", (page_id,))
        rows = cur.fetchall()
    except pymysql.err.ProgrammingError as error:
        if error.args[0] == 1146:  # a table is missing: the lengths without paragraphs, or nothing at all
            return {"languages": found, "sections": []}
        raise
    sections, seen = {}, set()
    for r in rows:
        s = sections.setdefault(r["section"], {"section": r["section"], "fi_words": 0, "others": {}})
        if (r["section"], r["position"]) not in seen:
            seen.add((r["section"], r["position"]))
            s["fi_words"] += r["fi_words"]
        if r["lang"]:
            other = s["others"].setdefault(r["lang"], {"words": 0, "paragraphs": []})
            other["words"] += r["words"]
            other["paragraphs"].append({"section": r["their_section"], "text": r["text"], "position": r["their_position"]})
    for s in sections.values():
        for other in s["others"].values():
            other["paragraphs"].sort(key=lambda p: p["position"])
    return {"languages": found, "sections": list(sections.values())}


def show(cur, wd):
    """How the article's languages line up: words per language, and the paragraphs only one language has."""
    cur.execute("""SELECT lang, COUNT(*), SUM(words) FROM passage WHERE wikidata_id = %s GROUP BY lang""", (wd,))
    print(wd, {lang: f"{n} paragraphs, {w} words" for lang, n, w in cur.fetchall()})
    cur.execute("""SELECT o.lang, ROUND(m.distance, 3), o.section, LEFT(o.text, 110), f.section, LEFT(f.text, 80)
                   FROM passage_match m JOIN passage o ON o.id = m.passage_id JOIN passage f ON f.id = m.fi_id
                   WHERE o.wikidata_id = %s ORDER BY o.lang, o.position""", (wd,))
    for lang, d, section, text, fi_section, fi_text in cur.fetchall():
        mark = "ONLY" if d > LOOSE else "    "
        print(f"{mark} {lang} {d:.3f} [{section[:30]}] {text}\n{'':16}~ fi [{fi_section[:30]}] {fi_text}")


def connect():
    """The same database settings as embed.py and app.py; without importing embed, which needs torch."""
    import os
    import pymysql
    return pymysql.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"), port=int(os.environ.get("DB_PORT", 3309)),
        user=os.environ.get("DB_USER", "wiki"), password=os.environ.get("DB_PASSWORD", "wiki"),
        database=os.environ["DB_NAME"], charset="utf8mb4", max_allowed_packet=64 << 20, autocommit=False,
    )


def main():
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    command, ids = sys.argv[1], sys.argv[2:]
    cur = connect().cursor()
    if command == "build":
        build(cur, ids)
    elif command == "languages":
        languages(cur)
    elif command == "show":
        for wd in ids:
            show(cur, wd)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
