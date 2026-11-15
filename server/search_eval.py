"""Search quality of /api/search: hit@1, hit@5 and MRR over a small set of queries with known answers.

    python search_eval.py [http://127.0.0.1:8010] [-v]

Each query lists the titles that are a right first answer; its rank is that of the first one of them among the
top 10 results. Latency is of the requests as made here (p50 and p95), question vectors included.
"""
import json
import sys
import time
import urllib.parse
import urllib.request

# (lang, query, right titles)
QUERIES = [
    # Finnish titles and names
    ("fi", "Mannerheim", ["Carl Gustaf Emil Mannerheim"]),
    ("fi", "Kekkonen", ["Urho Kekkonen"]),
    ("fi", "Sibelius", ["Jean Sibelius"]),
    ("fi", "Kalevala", ["Kalevala"]),
    ("fi", "Lapuan liike", ["Lapuanliike"]),
    ("fi", "talvisota", ["Talvisota"]),
    ("fi", "Helsinki", ["Helsinki"]),
    ("fi", "Lönnrot", ["Elias Lönnrot"]),
    ("fi", "tove jansson", ["Tove Jansson"]),
    ("fi", "Nokia", ["Nokia (yritys)", "Nokia"]),
    ("fi", "jatkosota", ["Jatkosota"]),
    ("fi", "sisällissota", ["Suomen sisällissota"]),
    ("fi", "Aalto", ["Alvar Aalto", "Aalto-yliopisto", "Aalto"]),
    ("fi", "sauna", ["Sauna", "Suomalainen sauna"]),
    ("fi", "muumit", ["Muumi", "Muumit"]),
    ("fi", "Väinämöinen", ["Väinämöinen"]),
    ("fi", "Torvalds", ["Linus Torvalds"]),
    ("fi", "Ståhlberg", ["K. J. Ståhlberg"]),
    ("fi", "Gallen-Kallela", ["Akseli Gallen-Kallela"]),
    # Finnish topics and questions
    ("fi", "kuka kokosi Kalevalan", ["Elias Lönnrot", "Kalevala"]),
    ("fi", "Suomen ensimmäinen presidentti", ["K. J. Ståhlberg", "Suomen tasavallan presidentti"]),
    ("fi", "milloin Suomi itsenäistyi", ["Suomen itsenäistyminen", "Suomen itsenäisyysjulistus"]),
    ("fi", "Suomen pisin joki", ["Kemijoki"]),
    ("fi", "Suomen korkein kohta", ["Halti"]),
    ("fi", "Suomen kansalliseepos", ["Kalevala"]),
    ("fi", "kalevalainen runomitta", ["Kalevalamitta", "Kalevalainen runous"]),
    ("fi", "kansanrunouden keruu", ["Suomalainen kansanrunous", "Kansanrunous", "Suomalaisen Kirjallisuuden Seura",
                                    "Kalevalainen runous", "Suomen Kansan Vanhat Runot"]),
    ("fi", "punaisten johtaja sisällissodassa", ["Kullervo Manner", "Suomen sisällissota", "Punakaarti", "Suomen punakaarti"]),
    ("fi", "Seitsemän veljeksen kirjoittaja", ["Aleksis Kivi", "Seitsemän veljestä"]),
    # English over the Finnish articles
    ("fi", "Finnish national epic", ["Kalevala"]),
    ("fi", "winter war", ["Talvisota"]),
    ("fi", "who led the Reds in the Finnish civil war", ["Kullervo Manner", "Suomen sisällissota", "Punakaarti", "Suomen punakaarti"]),
    ("fi", "composer of Finlandia", ["Jean Sibelius", "Finlandia", "Finlandia (sävelruno)", "Finlandia-hymni"]),
    ("fi", "capital of Finland", ["Helsinki"]),
    ("fi", "longest serving president of Finland", ["Urho Kekkonen"]),
    ("fi", "creator of the Moomins", ["Tove Jansson"]),
    ("fi", "northern lights", ["Revontulet"]),
    ("fi", "fascist movement in 1930s Finland", ["Lapuanliike", "Isänmaallinen kansanliike"]),
    ("fi", "author of Seven Brothers", ["Aleksis Kivi", "Seitsemän veljestä"]),
    ("fi", "inventor of Linux", ["Linus Torvalds"]),
    ("fi", "epic poems", ["Eepos", "Kalevala", "Kansalliseepos"]),
    ("fi", "Finnish steam bath", ["Sauna", "Suomalainen sauna"]),
    # Swedish and English articles
    ("sv", "Mannerheim", ["Gustaf Mannerheim"]),
    ("sv", "Kalevala", ["Kalevala"]),
    ("sv", "vinterkriget", ["Vinterkriget"]),
    ("sv", "Kekkonen", ["Urho Kekkonen"]),
    ("sv", "inbördeskriget", ["Finska inbördeskriget"]),
    ("sv", "Finlands nationalepos", ["Kalevala"]),
    ("sv", "Lönnrot", ["Elias Lönnrot"]),
    ("en", "Mannerheim", ["Carl Gustaf Emil Mannerheim"]),
    ("en", "Kalevala", ["Kalevala"]),
    ("en", "winter war", ["Winter War"]),
    ("en", "Finnish civil war", ["Finnish Civil War"]),
    ("en", "who compiled the Finnish national epic", ["Elias Lönnrot", "Kalevala"]),
    ("en", "Kekkonen", ["Urho Kekkonen"]),
    ("en", "far-right movement in Finland in the 1930s", ["Lapua Movement"]),
]
TOP = 10


def rank(titles, right):
    """The 1-based rank of the first right title in titles, or None."""
    right = {t.lower() for t in right}
    return next((i for i, title in enumerate(titles, 1) if title.lower() in right), None)


def report(label, ranks):
    """One line: hit@1, hit@5 and MRR of ranks (None = not found)."""
    n = len(ranks)
    hit = lambda k: sum(1 for r in ranks if r and r <= k) / n
    mrr = sum(1 / r for r in ranks if r) / n
    print(f"{label:<12} n={n:<3} hit@1 {hit(1):.2f}  hit@5 {hit(5):.2f}  MRR {mrr:.3f}")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    base, verbose = (args[0] if args else "http://127.0.0.1:8010"), "-v" in sys.argv
    ranks, times = [], []
    for lang, q, right in QUERIES:
        url = f"{base}/api/search?" + urllib.parse.urlencode({"q": q, "lang": lang, "limit": TOP})
        started = time.perf_counter()
        with urllib.request.urlopen(url, timeout=60) as response:
            titles = [r["title"] for r in json.load(response)]
        times.append(time.perf_counter() - started)
        ranks.append((lang, rank(titles, right)))
        if verbose or ranks[-1][1] != 1:
            print(f"{ranks[-1][1] or '-':>2}  [{lang}] {q}  ->  {'; '.join(titles[:5])}")
    report("all", [r for _, r in ranks])
    for lang in ("fi", "sv", "en"):
        report(lang, [r for l, r in ranks if l == lang])
    times.sort()
    print(f"latency      p50 {times[len(times) // 2] * 1000:.0f} ms  p95 {times[int(len(times) * 0.95)] * 1000:.0f} ms  "
          f"max {times[-1] * 1000:.0f} ms")


if __name__ == "__main__":
    main()
