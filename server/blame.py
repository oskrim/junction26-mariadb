"""Who wrote this: today's paragraphs of a Finnish article, each with the edit that first wrote its words.

A replay of every version in m_article FOR SYSTEM_TIME ALL, oldest first. Each version's wikitext is cut into
paragraphs (blank lines; headings and list items stand alone; templates, tables and refs drop out), reduced to
plain text. A paragraph's origin is the first version whose text held it word for word: an unchanged paragraph
keeps its origin, a new or edited one gets that version's, and one a revert brings back gets its first origin
back, so a vandal whose edit was undone never owns it.

    GET /api/blame?id=498  ->  {"paragraphs": [{"text", "origin": {"rev_id", "user", "at", "comment"}}], "versions"}
"""
import html
import re
import threading

import pymysql

COMMENTS_REFS = re.compile(r"<!--.*?(?:-->|$)|<(timeline|gallery|math|score|syntaxhighlight)[^>]*>.*?</\1>"
                           r"|<ref[^>]*/>|<ref[^>]*>.*?(?:</ref>|$)", re.S | re.I)
INNERMOST_BLOCK = re.compile(r"\{\{[^{}]*\}\}|\{\|(?:(?!\{\||\|\}).)*\|\}", re.S)
FILE_LINK = re.compile(r"\[\[\s*(?:File|Image|Tiedosto|Kuva|Luokka|Category)\s*:[^\[\]]*(?:\[\[[^\[\]]*\]\][^\[\]]*)*\]\]", re.I)
LANGUAGE_LINK = re.compile(r"\[\[[a-z]{2,3}(?:-[a-z]+)*:[^\]]*\]\]")
HEADING = re.compile(r"^(=+)\s*(.*?)\s*\1\s*$")
ITEM = re.compile(r"^[*#:;]+\s*")

cache = {}  # (page_id, newest rev_id) -> answer, per worker process
cache_lock = threading.Lock()


def raw_blocks(wikitext):
    """The wikitext cut on blank lines, a block kept whole while a template or table in it is still open."""
    blocks, open_block, depth = [], [], 0
    for chunk in re.split(r"\n[ \t]*\n", wikitext):
        open_block.append(chunk)
        depth += chunk.count("{{") - chunk.count("}}") + chunk.count("{|") - chunk.count("|}")
        if depth <= 0:
            blocks.append("\n\n".join(open_block))
            open_block, depth = [], 0
    if open_block:
        blocks.append("\n\n".join(open_block))
    return blocks


def plain(markup):
    """One paragraph's wiki markup as the reader shows its text: link labels, no formatting, on one line."""
    text = FILE_LINK.sub("", markup)
    text = LANGUAGE_LINK.sub("", text)
    text = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", text)
    text = re.sub(r"\[(?:https?:)?//[^\s\]]*\s*([^\]]*)\]", r"\1", text)
    text = re.sub(r"'{2,}|<[^>]+>|__[A-Z]+__", "", text)
    return " ".join(html.unescape(text).split())


def paragraphs(block):
    """A raw block's paragraphs as plain text: headings and list items each their own."""
    text = COMMENTS_REFS.sub("", block)
    for _ in range(100):  # templates and tables nest; each pass removes the innermost ones
        text, removed = INNERMOST_BLOCK.subn("", text)
        if not removed:
            break
    out, running = [], []

    def flush():
        if running:
            out.append(plain(" ".join(running)))
            running.clear()

    for line in text.split("\n"):
        line = line.strip()
        heading = HEADING.match(line)
        if heading or ITEM.match(line):
            flush()
            out.append(plain(heading.group(2) if heading else ITEM.sub("", line)))
        elif not line:
            flush()
        else:
            running.append(line)
    flush()
    # Leftovers of markup (a stray "}}", "|-") or a lone punctuation mark are no paragraph.
    return [p for p in out if re.search(r"\w\w", p)]


def replay(versions):
    """[(origin, wikitext)] oldest first -> today's [(text, origin)], each text with its first origin."""
    seen_blocks = {}  # raw block -> its paragraphs: most blocks recur in the next version unchanged
    first = {}  # paragraph text -> origin of the first version that had it
    seen_texts = set()  # a revert to a text already replayed adds nothing new
    today = []
    for origin, wikitext in versions:
        if wikitext in seen_texts:
            today = [p for block in raw_blocks(wikitext) for p in seen_blocks[block]]
            continue
        seen_texts.add(wikitext)
        today = []
        for block in raw_blocks(wikitext):
            paras = seen_blocks.get(block)
            if paras is None:
                paras = seen_blocks[block] = paragraphs(block)
            for p in paras:
                first.setdefault(p, origin)
                today.append(p)
    return [(p, first[p]) for p in today]


def blame(page_id, cur):
    cur.execute("""SELECT rev_id FROM m_article FOR SYSTEM_TIME ALL WHERE page_id = %s
                   ORDER BY row_start DESC LIMIT 1""", (page_id,))
    newest = cur.fetchone()
    if not newest:
        return None
    key = (page_id, newest["rev_id"])
    with cache_lock:
        if key in cache:
            return cache[key]

    # Streamed, so the 1,400 texts of a long-lived article are never all in memory at once.
    stream = cur.connection.cursor(pymysql.cursors.SSDictCursor)
    stream.execute("""SELECT rev_id, IFNULL(user, '') AS user, IFNULL(comment, '') AS comment, row_start, text
                      FROM m_article FOR SYSTEM_TIME ALL WHERE page_id = %s ORDER BY row_start""", (page_id,))
    count = 0

    def versions():
        nonlocal count
        for row in stream:
            count += 1
            origin = {"rev_id": row["rev_id"], "user": row["user"],
                      "at": row["row_start"].strftime("%Y-%m-%d %H:%M:%S.%f"), "comment": row["comment"]}
            yield origin, row["text"] or ""

    try:
        result = replay(versions())
    finally:
        stream.close()
    answer = {"paragraphs": [{"text": text, "origin": origin} for text, origin in result], "versions": count}
    with cache_lock:
        if len(cache) > 64:
            cache.clear()
        cache[key] = answer
    return answer

