"""POST /api/intent: which of the assistant's paths a reader's request is for, so one query bar does it all.

In:  {prompt, context (the painted passage or null), history (the chat so far, optional)}
Out: {mode, why}: mode is "ask", "find", "learn" or "visualise"; why says in a few words, in the language of the
     request, what the reader wants. One fast Gemini call with a fixed schema; ~1 s.
"""
import json

from ask import AskError, send_json
from learn import generate_json

MAX_HISTORY = 6

RULES = """You route a reader's request about the Wikipedia article they are reading to one of four tools.
- ask: a question this article (or one version of it) can answer: what it says, who, when, why, what changed
  in it over time, what an earlier version said. The default when unsure.
- find: locate passages: where the article mentions something, which sentences say X, find/show me the parts
  about Y, when something first appeared in it.
- learn: understand something beyond this article: background, causes, context, concepts, how something works,
  "explain", "teach me", "help me understand", "go deeper", what the reader would need other articles for.
- visualise: show it as a picture: a chart, graph, timeline, map, diagram or 3D model; "show me", "plot",
  "visualise", "draw".
A follow-up in a chat keeps the earlier tool unless it clearly asks for another.
Also give "why": at most 8 words, in the language of the request, saying what the reader wants."""

SCHEMA = {
    "type": "OBJECT",
    "properties": {"mode": {"type": "STRING", "enum": ["ask", "find", "learn", "visualise"]},
                   "why": {"type": "STRING"}},
    "required": ["mode", "why"],
    "propertyOrdering": ["mode", "why"],
}


def serve(handler, database):
    """Handles one POST /api/intent on a BaseHTTPRequestHandler."""
    try:
        body = json.loads(handler.rfile.read(int(handler.headers.get("Content-Length", 0))))
        prompt = str(body["prompt"]).strip()
    except (ValueError, KeyError, TypeError) as error:
        return send_json(handler, 400, {"error": f"bad request: {error}"})
    if not prompt:
        return send_json(handler, 400, {"error": "prompt must not be empty"})
    history = [h for h in body.get("history") or [] if isinstance(h, dict) and h.get("text")][-MAX_HISTORY:]
    chat = "".join(f"{'Reader' if h.get('role') == 'user' else 'Assistant'}"
                   f"{' (' + h['mode'] + ')' if h.get('mode') else ''}: {str(h['text'])[:300]}\n" for h in history)
    passage = f"The reader painted this passage:\n<<<\n{str(body['context'])[:600]}\n>>>\n" if body.get("context") else ""
    text = f"{'Chat so far:' + chr(10) + chat if chat else ''}{passage}Request: {prompt}"
    try:
        reply = generate_json(RULES, [{"role": "user", "parts": [{"text": text}]}], SCHEMA)
    except AskError as error:
        return send_json(handler, error.status, {"error": str(error)})
    mode = reply.get("mode") if reply.get("mode") in SCHEMA["properties"]["mode"]["enum"] else "ask"
    send_json(handler, 200, {"mode": mode, "why": str(reply.get("why") or "")})
