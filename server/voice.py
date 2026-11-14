"""Learn, out loud, with ElevenLabs. The API key stays on the server.

POST /api/speak  {text, voice?}  →  audio/mpeg, streamed from ElevenLabs text to speech as it is made.
POST /api/voice  {page_id, title, article, answer, sources}  →  {signed_url, dynamic_variables}: a one-time
    URL for a live voice conversation with the Learn agent (ELEVENLABS_AGENT_ID), and the values that fill in
    its prompt: the article, the Learn answer and the linked articles it rests on.

`python server/voice.py create-agent` makes that agent in the ElevenLabs account and prints its id.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

API = "https://api.elevenlabs.io/v1"
TIMEOUT_S = 30
VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")  # George, a premade voice every account has
# The voices the reader can pick from (VOICES in reader/voice.js); premade, so every account has them.
VOICES = {VOICE_ID, "JBFqnCBsd6RMkjVDRZzb", "Xb7hH8MSUJpSbSDYk0k2", "onwK4e9ZLuTAKqWW03F9", "XrExE9yKIg1WjnnlVkGX",
          "SAz9YHcvj6GT2YYXdXww", "nPczCjzI2devNBz1zQrb"}
# Flash v2.5: ~75 ms model latency and 32 languages, Finnish among them.
TTS_MODEL = os.environ.get("ELEVENLABS_TTS_MODEL", "eleven_flash_v2_5")
MAX_SPEAK_CHARS = 5_000
MAX_BODY = 200_000
CHUNK = 4_096
# What the agent gets to read: enough for the article's start and each source's relevant part.
ARTICLE_CHARS, ANSWER_CHARS, SOURCES_CHARS = 6_000, 4_000, 12_000

AGENT_PROMPT = """You are the voice of Learn, inside a reader for Finnish Wikipedia and its history.
The reader just asked Learn about the article "{{article_title}}" and heard this answer:
<<<
{{answer}}
>>>
The answer rests on these linked articles:
<<<
{{sources}}
>>>
The start of the article they are reading:
<<<
{{article}}
>>>
Now they talk with you to ask more.
- Speak like a good teacher: short, plain sentences, two to four at a time, then let them ask.
- Answer in the language they speak to you, even though the sources are in Finnish.
- Rest your answers on the text above and say which article a fact comes from when it helps.
  When the text does not cover something, say so briefly, then give general background and say it is general.
- This is speech: no lists, no Markdown, no citation numbers, no URLs."""

FIRST_MESSAGE = "Want to dig further into {{article_title}}? Ask me anything."


class VoiceError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def speak(handler, database=None):
    """Streams speech for the text in the request body."""
    try:
        request = body(handler)
        text = spoken(str(request.get("text") or ""))[:MAX_SPEAK_CHARS]
        if not text:
            raise VoiceError(400, "text must not be empty")
        voice_id = request.get("voice") or VOICE_ID
        if voice_id not in VOICES:
            raise VoiceError(400, "unknown voice")
        response = elevenlabs(f"/text-to-speech/{voice_id}/stream?output_format=mp3_44100_128",
                              {"text": text, "model_id": TTS_MODEL})
    except VoiceError as error:
        return reply(handler, error.status, {"error": str(error)})
    with response:
        handler.send_response(200)
        handler.send_header("Content-Type", "audio/mpeg")
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("X-Accel-Buffering", "no")
        handler.end_headers()
        try:
            while chunk := response.read1(CHUNK):
                handler.wfile.write(chunk)
                handler.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # the reader pressed stop


def voice(handler, database=None):
    """A signed URL for one conversation with the Learn agent, and the values for its prompt."""
    try:
        agent = os.environ.get("ELEVENLABS_AGENT_ID")
        if not agent:
            raise VoiceError(503, "ELEVENLABS_AGENT_ID is not set on the server")
        request = body(handler)
        sources = request.get("sources") or []
        variables = {
            "article_title": str(request.get("title") or "this article")[:300],
            "article": str(request.get("article") or "")[:ARTICLE_CHARS] or "(not available)",
            "answer": spoken(str(request.get("answer") or ""))[:ANSWER_CHARS] or "(no answer yet)",
            "sources": "\n\n".join(f"{s.get('title')}: {s.get('text') or s.get('why') or ''}"
                                   for s in sources if isinstance(s, dict))[:SOURCES_CHARS] or "(none)",
        }
        signed = elevenlabs(f"/convai/conversation/get-signed-url?agent_id={agent}")
        with signed:
            url = json.loads(signed.read())["signed_url"]
    except VoiceError as error:
        return reply(handler, error.status, {"error": str(error)})
    except (KeyError, ValueError) as error:
        return reply(handler, 502, {"error": f"ElevenLabs gave no signed URL: {error}"})
    reply(handler, 200, {"signed_url": url, "dynamic_variables": variables})


def spoken(text):
    """Answer text as it should be read aloud: no citation markers, bullets or extra blank lines."""
    text = re.sub(r"\s*\[\d+(?:\s*,\s*\d+)*\]", "", text)
    text = re.sub(r"^\s*[•*-]\s*", "", text, flags=re.M)
    return re.sub(r"\n{2,}", "\n", text).strip()


def body(handler):
    length = int(handler.headers.get("Content-Length", 0))
    if length > MAX_BODY:
        raise VoiceError(413, "request too large")
    try:
        parsed = json.loads(handler.rfile.read(length) or b"{}")
    except ValueError as error:
        raise VoiceError(400, f"bad request: {error}")
    if not isinstance(parsed, dict):
        raise VoiceError(400, "bad request: expected an object")
    return parsed


def elevenlabs(path, payload=None, method=None):
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        raise VoiceError(503, "ELEVENLABS_API_KEY is not set on the server")
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(API + path, data=data, method=method,
                                     headers={"xi-api-key": key, "Content-Type": "application/json"})
    try:
        return urllib.request.urlopen(request, timeout=TIMEOUT_S)
    except urllib.error.HTTPError as error:
        raise VoiceError(502, f"ElevenLabs returned {error.code}: {error.read()[:300].decode(errors='replace')}")
    except OSError as error:
        raise VoiceError(502, f"ElevenLabs is unreachable: {error}")


def reply(handler, status, result):
    data = json.dumps(result, ensure_ascii=False).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def create_agent():
    """Makes the Learn voice agent and prints its id, for ELEVENLABS_AGENT_ID."""
    config = {
        "name": "Wiki reader · Learn",
        "conversation_config": {
            "agent": {"first_message": FIRST_MESSAGE, "language": "en",
                      "prompt": {"prompt": AGENT_PROMPT, "llm": os.environ.get("ELEVENLABS_LLM", "gemini-2.5-flash"),
                                 "temperature": 0.4}},
            "tts": {"voice_id": VOICE_ID, "model_id": "eleven_flash_v2"},
            "conversation": {"max_duration_seconds": 900},
        },
    }
    with elevenlabs("/convai/agents/create", config) as response:
        print(json.loads(response.read())["agent_id"])


if __name__ == "__main__":
    if sys.argv[1:] != ["create-agent"]:
        sys.exit("usage: python server/voice.py create-agent")
    try:
        create_agent()
    except VoiceError as error:
        sys.exit(str(error))
