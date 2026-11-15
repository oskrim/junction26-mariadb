"""Query-aware snippets: the passages of one article's plain text that best match a search query.

A search result that shows only an article's first words says what the article is, not whether it answers the
query. best() splits the text into passages of a paragraph or a few sentences and scores each against the query's
Snowball stems (bm25.py's tokeniser and stemmers, so a query word matches its inflected forms), then returns the
best one or two, in the article's order. The scoring is BM25's shape without a corpus: a stem's weight is its
rarity among this article's passages, its count saturates, and a stem that the title already has counts less,
since nearly every passage of the article repeats it. After the first pick, the stems it covers count a quarter,
so the second passage adds another side of the query instead of repeating the first.

Used by the assistant's search tool (ask.py); /api/search could show the same passages.
"""
import math
import re

import bm25

PASSAGE_MIN, PASSAGE_MAX = 300, 600  # characters: a passage closes after MIN and never passes MAX
TEXT_CHARS = 60_000  # of an article's text are read for passages
TITLE_WEIGHT = 0.3  # of a query stem that the title has
COVERED = 0.25  # weight a stem keeps once a picked passage has it
SECOND_SHARE = 0.4  # a second passage is shown when it scores at least this share of the first
SATURATION = 1.2  # BM25's k1
PREFIX = 4  # letters a word shares with its stem: only words that start like a query stem are stemmed

SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-ZÅÄÖ0-9”\"(])")
SKIPPED_LINE = re.compile(r"^(#|\||!\[|\{\{|\}\}|\[\[(?:Tiedosto|Kuva|File|Image|Luokka|Category):)", re.I)
_stems = {"fi": {}, "sv": {}, "en": {}}  # word -> stem, kept between requests


def stems(lang, text):
    """The Snowball stems of text's words, in order, for lang fi, sv or en."""
    return bm25.terms(text, _stems["fi"]) if lang == "fi" else bm25.terms_s(lang, text, _stems[lang])


def cut_at_word(text, limit):
    """text within limit characters, cut at a word's end with "…" when it is longer."""
    if len(text) <= limit:
        return text
    cut = text.rfind(" ", 0, limit)
    return text[:cut if cut > limit // 2 else limit].rstrip(" ,;:") + "…"


def passages(text):
    """text as passages of PASSAGE_MIN to PASSAGE_MAX characters that end where a paragraph or a sentence ends.
    Headings, table rows and pictures are left out; a heading always closes the passage before it."""
    out, current = [], ""
    for line in text[:TEXT_CHARS].split("\n"):
        line = " ".join(line.split())
        if not line or SKIPPED_LINE.match(line):
            if current and (line.startswith("#") or len(current) >= PASSAGE_MIN):
                out.append(current)
                current = ""
            continue
        for piece in ([line] if len(line) <= PASSAGE_MAX else SENTENCE_END.split(line)):
            piece = cut_at_word(piece, PASSAGE_MAX)
            if current and len(current) + len(piece) + 1 > PASSAGE_MAX:
                out.append(current)
                current = ""
            current = f"{current} {piece}".strip()
            if len(current) >= PASSAGE_MIN:
                out.append(current)
                current = ""
    if current:
        out.append(current)
    return out


def best(text, query, title="", lang="fi", count=2, skip=""):
    """The count passages of text that best match query, in the text's order: [] when none has a query word the
    title lacks. skip is text already shown (the opening sentence): a passage that starts with it is left out."""
    wanted = list(dict.fromkeys(stems(lang, query)))
    if not wanted or not text:
        return []
    in_title = set(stems(lang, title))
    if all(stem in in_title for stem in wanted):
        in_title = set()  # the query is the title: its words are all there is to match
    starts = {stem[:PREFIX] for stem in wanted}
    parts = [p for p in passages(text) if not (skip and p.startswith(skip[:80]))]
    counts = []
    for part in parts:
        tf = {}
        for word in bm25.words(part):
            if word[:PREFIX] in starts:
                stem = stems(lang, word)[0]
                if stem in wanted:
                    tf[stem] = tf.get(stem, 0) + 1
        counts.append(tf)
    if not any(counts):
        return []
    weight = {}
    for stem in wanted:
        df = sum(1 for tf in counts if stem in tf)
        weight[stem] = math.log(1 + len(parts) / df) * (TITLE_WEIGHT if stem in in_title else 1) if df else 0

    def score(tf):
        return sum(weight[stem] * n / (n + SATURATION) for stem, n in tf.items())

    picked, top = [], 0
    for _ in range(count):
        at = max(range(len(parts)), key=lambda i: (i not in picked) * score(counts[i]))
        value = score(counts[at])
        if at in picked or value <= 0 or (picked and value < SECOND_SHARE * top):
            break
        if not any(stem not in in_title for stem in counts[at]) and in_title:
            break  # only the title's words: the opening sentence already says as much
        picked.append(at)
        top = top or value
        for stem in counts[at]:
            weight[stem] *= COVERED
    return [parts[i] for i in sorted(picked)]
