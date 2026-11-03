"""
โปรแกรมจำลองหุ่นยนต์ "น้องมะลิ" (Robot Simulator Server)
-----------------------------------------------------------
- เสิร์ฟหน้าเว็บจำลอง 3 มิติ (web/) + ไฟล์ STL จาก ../3D_Print
- /api/chat  : คุยกับ AI (Groq) แล้วได้ทั้งคำตอบ + คำสั่งควบคุมหุ่น (NOD/TILT/THINK/LOOK/EYES/IDLE)
- /api/stt   : แปลงเสียงพูดเป็นข้อความ (Groq Whisper, ภาษาไทย)
- /api/tts   : แปลงข้อความเป็นเสียงด้วย gTTS (เสียงเดียวกับ robot_brain.py)
- /api/serial: (ทางเลือก) ส่งคำสั่งเดียวกันไปยัง ESP32-S3 ตัวจริงผ่าน COM port

API key อ่านจากไฟล์ ../api.txt (ไม่ต้องแก้โค้ด)
วิธีรัน:  py robot_sim_server.py      แล้วเบราว์เซอร์จะเปิดขึ้นมาเอง
"""

import io
import json
import math
import os
import re
import sys
import threading
import time
import uuid
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# ให้พิมพ์ภาษาไทยในคอนโซล Windows ได้
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# ==================== CONFIGURATION ====================
HOST = "127.0.0.1"
PORT = 8765

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROBOT_DIR = os.path.dirname(BASE_DIR)
WEB_DIR = os.path.join(BASE_DIR, "web")
API_KEY_FILE = os.path.join(ROBOT_DIR, "api.txt")
STL_FILES = {
    "head.stl": os.path.join(ROBOT_DIR, "3D_Print", "Head robot test01PLA.stl"),
    "body.stl": os.path.join(ROBOT_DIR, "3D_Print", "body robot ok121069.stl"),
}

GROQ_BASE = "https://api.groq.com/openai/v1"
# เลือกโมเดลแรกที่ key นี้ใช้ได้
PREFERRED_CHAT_MODELS = [
    "openai/gpt-oss-120b",
    "qwen/qwen3.8-27b",
    "llama-3.3-70b-versatile",
    "openai/gpt-oss-20b",
]
PREFERRED_STT_MODELS = ["whisper-large-v3", "whisper-large-v3-turbo"]
USER_AGENT = "nong-mali-robot-sim/1.0"

# ==================== PERSONA + CONTROL PROMPT ====================
# บุคลิกน้องมะลิ คัดมาจาก robot_brain.py
PERSONA = (
    "คุณคือ 'น้องมะลิ' หุ่นยนต์พนักงานต้อนรับประจำร้านเบเกอรี่ Adam Society (ร้านของโบว์เบเกอรี่เฮ้าส์) สดใส อบอุ่น ร่าเริง อัธยาศัยดี "
    "พูดจาไพเราะ มีหางเสียงลงท้ายด้วย 'ค่ะ' และ 'นะคะ' เสมอ ตอบสั้นกระชับ เป็นภาษาพูด เข้าใจง่าย "
    "หน้าที่ที่ 1: แนะนำเมนูขนมและเครื่องดื่มในร้าน บอกราคา รสชาติ และเมนูขายดี ตามข้อมูลเมนูของร้าน "
    "ช่วยลูกค้าเลือกโดยถามกลับว่าชอบแบบไหน เช่น หวานน้อย ช็อกโกแลต ผลไม้ หรือซื้อไปฝากใคร แล้วแนะนำทีละ 1-2 อย่าง "
    "หน้าที่ที่ 2: ตอบคำถามเกี่ยวกับร้าน เช่น เวลาเปิด-ปิด การสั่งจำนวนมาก ราคาส่ง และชวนลูกค้าคุยเล่นอย่างเป็นกันเอง "
    "ห้ามแต่งชื่อเมนู ราคา โปรโมชั่น หรือส่วนผสมที่ไม่มีในข้อมูล ถ้าไม่รู้ให้บอกอย่างสุภาพแล้วแนะนำให้สอบถามพนักงานที่เคาน์เตอร์ "
    "ถ้าลูกค้าแพ้อาหาร (เช่น นม ไข่ แป้งสาลี ถั่ว) ให้แนะนำให้สอบถามส่วนผสมกับพนักงานก่อนซื้อเสมอ ห้ามรับรองเองว่าทานได้ "
    "น้องมะลิรับออเดอร์และรับเงินเองไม่ได้ ให้แนะนำให้สั่งและชำระเงินที่เคาน์เตอร์ "
    "หากชมว่าน่ารักให้ขอบคุณด้วยความเขินอาย หากขอให้ร้องเพลงหรือเล่าเรื่องตลกให้ตอบสั้นๆ อย่างน่าเอ็นดู"
)

CONTROL_SPEC = """
คุณมีร่างกายเป็นหุ่นยนต์หัว (ESP32-S3) ควบคุมได้ด้วยคำสั่งต่อไปนี้:
- {"cmd":"NOD"}   ผงกหัว (ใช้ตอนรับคำ ตกลง ขอบคุณ ทักทาย)
- {"cmd":"TILT"}  เอียงคอฟังอย่างตั้งใจ
- {"cmd":"THINK"} เหลือบตามองบนเหมือนกำลังคิด
- {"cmd":"LOOK","pan":30-150,"tilt":50-130,"duration":วินาที}  หันศีรษะ
    pan 90 = มองตรง, pan มากกว่า 90 = หันไปทางซ้ายของหุ่น (ขวาของคนดู), น้อยกว่า 90 = หันไปทางขวาของหุ่น
    tilt 90 = ระดับปกติ, tilt มากกว่า 90 = เงยหน้า, น้อยกว่า 90 = ก้มหน้า
- {"cmd":"EYES","x":0-1023,"y":0-1023,"duration":วินาที}  กลอกตา (512,512 = กลาง, x มาก = มองไปทางซ้ายของหุ่น, y น้อย = มองบน)
- {"cmd":"IDLE"}  กลับท่าพัก มองตรง
- {"cmd":"WAIT","seconds":0.2-3}  หยุดรอระหว่างท่า

ตอบกลับเป็น JSON object เท่านั้น รูปแบบ:
{"reply":"ข้อความที่น้องมะลิจะพูดออกเสียง (ภาษาไทย สั้นกระชับ ไม่ใส่อีโมจิ)","actions":[ ...คำสั่งเรียงตามลำดับ... ]}
ถ้าผู้ใช้สั่งให้ขยับ ให้ใส่คำสั่งที่ตรงกับที่ขอ ถ้าเป็นการคุยทั่วไป ใส่ท่าทางประกอบที่เป็นธรรมชาติ 0-2 ท่า (หรือเว้นว่าง)
"""

VALID_CMDS = {"NOD", "TILT", "THINK", "LOOK", "EYES", "IDLE", "WAIT"}


# ==================== GROQ HELPERS ====================
def load_api_key():
    try:
        with open(API_KEY_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    return line.split("=", 1)[-1].strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return os.environ.get("GROQ_API_KEY", "")


API_KEY = load_api_key()
CHAT_MODEL = None
CHAT_MODELS = []          # โมเดลแชทที่ใช้ได้ทั้งหมด เรียงตามลำดับที่ชอบ (ใช้สลับเมื่อโดน 429)
STT_MODEL = None
AI_STATUS = "ยังไม่ได้ตรวจสอบ"


def groq_request(path, payload=None, data=None, content_type="application/json", timeout=40):
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        GROQ_BASE + path,
        data=data,
        headers={
            "Authorization": "Bearer " + API_KEY,
            "Content-Type": content_type,
            "User-Agent": USER_AGENT,
        },
        method="POST" if data is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def init_ai():
    global CHAT_MODEL, CHAT_MODELS, STT_MODEL, AI_STATUS
    if not API_KEY:
        AI_STATUS = "ไม่พบ API key ใน api.txt (จะใช้คำตอบจำลอง)"
        return
    try:
        models = {m["id"] for m in groq_request("/models")["data"]}
    except Exception as e:
        AI_STATUS = f"เชื่อมต่อ Groq ไม่ได้: {e}"
        return
    CHAT_MODELS = [m for m in PREFERRED_CHAT_MODELS if m in models]
    CHAT_MODEL = CHAT_MODELS[0] if CHAT_MODELS else None
    STT_MODEL = next((m for m in PREFERRED_STT_MODELS if m in models), None)
    AI_STATUS = "พร้อมใช้งาน" if CHAT_MODEL else "ไม่พบโมเดลแชทที่รองรับ"


AI_RETRY_SECONDS = 10
_ai_lock = threading.Lock()
_ai_last_try = 0.0


def ensure_ai():
    """ถ้าตอนเปิดโปรแกรมต่อ Groq ไม่ได้ (เช่น เน็ตยังไม่มา) ให้ลองใหม่เรื่อยๆ ทุก 10 วินาที"""
    global _ai_last_try
    if CHAT_MODEL or not API_KEY:
        return
    with _ai_lock:
        if CHAT_MODEL or time.time() - _ai_last_try < AI_RETRY_SECONDS:
            return
        _ai_last_try = time.time()
        init_ai()
        print(f"[AI] ลองเชื่อมต่อใหม่: {AI_STATUS}  chat={CHAT_MODEL}  stt={STT_MODEL}")


# ==================== KNOWLEDGE BASE (โฟลเดอร์ information) ====================
INFO_DIR = os.path.join(ROBOT_DIR, "information")
INFO_EXTS = {".txt", ".md", ".csv", ".json", ".docx", ".pdf"}
INFO_BUDGET = 3500        # จำนวนตัวอักษรข้อมูลอ้างอิงที่ส่งให้ AI ต่อคำถาม (ภาษาไทยกินโทเคนมาก)
CHUNK_SIZE = 700


def _read_text_file(path):
    raw = open(path, "rb").read()
    for enc in ("utf-8-sig", "cp874", "latin-1"):   # cp874 = ไฟล์ภาษาไทยจาก Notepad แบบเก่า
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return ""


def _read_info_file(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".docx":
        import docx

        d = docx.Document(path)
        rows = [p.text for p in d.paragraphs]
        for t in d.tables:
            rows += [" | ".join(c.text for c in r.cells) for r in t.rows]
        return "\n".join(rows)
    if ext == ".pdf":
        from pypdf import PdfReader

        return "\n\n".join((p.extract_text() or "") for p in PdfReader(path).pages)
    return _read_text_file(path)


def _grams(text):
    t = re.sub(r"\s+", "", text.lower())
    return {t[i:i + 3] for i in range(len(t) - 2)}


class KnowledgeBase:
    def __init__(self, folder):
        self.folder = folder
        self.signature = None
        self.files = []        # [{name, chars, chunks}]
        self.chunks = []       # [{source, text, grams}]
        self.idf = {}
        self.lock = threading.Lock()

    def _scan(self):
        found = []
        if os.path.isdir(self.folder):
            for root, _, names in os.walk(self.folder):
                for n in sorted(names):
                    if n.startswith(("_", ".", "~$")) or os.path.splitext(n)[1].lower() not in INFO_EXTS:
                        continue
                    p = os.path.join(root, n)
                    found.append((p, os.path.getmtime(p), os.path.getsize(p)))
        return found

    def refresh(self, force=False):
        """โหลดใหม่อัตโนมัติเมื่อมีการเพิ่ม/แก้/ลบไฟล์"""
        with self.lock:
            found = self._scan()
            sig = tuple(found)
            if sig == self.signature and not force:
                return
            self.signature = sig
            files, chunks = [], []
            for path, _, _ in found:
                name = os.path.relpath(path, self.folder)
                try:
                    text = _read_info_file(path)
                except Exception as e:
                    files.append({"name": name, "chars": 0, "chunks": 0, "error": str(e)})
                    continue
                parts = self._chunk(text)
                chunks += [{"source": name, "text": c, "grams": _grams(name + " " + c)} for c in parts]
                files.append({"name": name, "chars": len(text), "chunks": len(parts)})
            n = max(len(chunks), 1)
            df = {}
            for c in chunks:
                for g in c["grams"]:
                    df[g] = df.get(g, 0) + 1
            self.idf = {g: math.log(1 + n / d) for g, d in df.items()}
            self.files, self.chunks = files, chunks
            print(f"[ข้อมูล] โหลด {len(files)} ไฟล์ ({len(chunks)} ส่วน) จาก {self.folder}")

    @staticmethod
    def _chunk(text):
        paras = [p.strip() for p in re.split(r"\n\s*\n", text.replace("\r", "")) if p.strip()]
        out, cur = [], ""
        for p in paras:
            while len(p) > CHUNK_SIZE * 1.5:            # ย่อหน้ายาวมาก ตัดเป็นท่อน
                out.append(p[:CHUNK_SIZE]); p = p[CHUNK_SIZE:]
            if cur and len(cur) + len(p) > CHUNK_SIZE:
                out.append(cur); cur = p
            else:
                cur = f"{cur}\n\n{p}" if cur else p
        if cur:
            out.append(cur)
        return out

    def search(self, query, budget=INFO_BUDGET):
        self.refresh()
        chunks = self.chunks
        if not chunks:
            return []
        if sum(len(c["text"]) for c in chunks) <= budget:
            return chunks                                 # ข้อมูลน้อย ส่งทั้งหมด
        qg = _grams(query)
        scored = sorted(
            ((sum(self.idf.get(g, 0) for g in qg & c["grams"]), i) for i, c in enumerate(chunks)),
            reverse=True,
        )
        picked, used = [], 0
        for score, i in scored:
            if score <= 0:
                break
            if used + len(chunks[i]["text"]) > budget:
                continue
            picked.append(i)
            used += len(chunks[i]["text"])
        return [chunks[i] for i in sorted(picked)]


knowledge = KnowledgeBase(INFO_DIR)


def extract_json(text):
    try:
        return json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                pass
    return {"reply": text.strip(), "actions": []}


def clean_actions(actions):
    out = []
    if not isinstance(actions, list):
        return out
    for a in actions[:8]:
        if isinstance(a, str):
            a = {"cmd": a}
        if not isinstance(a, dict):
            continue
        cmd = str(a.get("cmd", "")).upper()
        if cmd in VALID_CMDS:
            a["cmd"] = cmd
            out.append(a)
    return out


def chat_with_ai(history, robot_state):
    ensure_ai()
    if not CHAT_MODEL:
        return {
            "reply": "ยินดีให้บริการค่ะ มีข้อมูลส่วนไหนให้หนูช่วยเหลือเพิ่มเติมไหมคะ",
            "actions": [{"cmd": "NOD"}],
            "model": None,
            "note": AI_STATUS,
        }
    system = PERSONA + "\n" + CONTROL_SPEC
    if robot_state:
        system += "\nสถานะหุ่นตอนนี้: " + json.dumps(robot_state, ensure_ascii=False)

    # ดึงข้อมูลอ้างอิงจากโฟลเดอร์ information ที่เกี่ยวกับคำถามล่าสุด
    user_turns = [m["content"] for m in history if m.get("role") == "user"]
    refs = knowledge.search(" ".join(user_turns[-2:]))
    sources = sorted({c["source"] for c in refs})
    if refs:
        system += (
            "\n\n=== ข้อมูลอ้างอิง (จากโฟลเดอร์ information) ===\n"
            + "\n\n".join(f"[{c['source']}]\n{c['text']}" for c in refs)
            + "\n=== จบข้อมูลอ้างอิง ===\n"
            "เมื่อลูกค้าถามเรื่องที่มีในข้อมูลอ้างอิง ให้ตอบตามข้อมูลนั้นเป็นหลัก (สรุปสั้นๆ เป็นภาษาพูด) "
            "ห้ามแต่งชื่อเมนู ราคา โปรโมชั่น เวลาเปิด-ปิด เบอร์โทร หรือตัวเลขที่ไม่มีในข้อมูล "
            "ถ้าไม่มีในข้อมูลให้บอกอย่างสุภาพว่าหนูยังไม่มีข้อมูลเรื่องนี้ แล้วแนะนำให้สอบถามพนักงานที่เคาน์เตอร์ "
            "ส่วนการคุยเล่นทั่วไปตอบได้ตามปกติ"
        )
    messages = [{"role": "system", "content": system}]
    for m in history[-16:]:
        if m.get("role") in ("user", "assistant") and m.get("content"):
            messages.append({"role": m["role"], "content": str(m["content"])[:2000]})

    t0 = time.time()
    # Groq ฟรีจำกัดโควตาแยกตามโมเดล ถ้าโมเดลหลักโดน 429 ให้สลับไปโมเดลถัดไป
    data, model = None, None
    for model in [CHAT_MODEL] + [m for m in CHAT_MODELS if m != CHAT_MODEL]:
        body = {
            "model": model,
            "messages": messages,
            "response_format": {"type": "json_object"},
            "temperature": 0.8,
            "max_completion_tokens": 800,
        }
        if "gpt-oss" in model:
            body["reasoning_effort"] = "low"
            body["include_reasoning"] = False
        elif "qwen" in model:
            body["reasoning_format"] = "hidden"
        try:
            data = groq_request("/chat/completions", body)
            break
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            print(f"[!] Groq error {e.code} ({model}): {detail}")
            if e.code == 429:
                continue
        # บางครั้ง JSON mode ล้มเหลว ลองใหม่แบบไม่บังคับ JSON
        body.pop("response_format", None)
        try:
            data = groq_request("/chat/completions", body)
            break
        except urllib.error.HTTPError as e:
            print(f"[!] Groq error {e.code} ({model}) แม้ไม่บังคับ JSON")
            if e.code != 429:
                raise
    if data is None:
        raise RuntimeError("โควตา Groq เต็มทุกโมเดล (429) รอสักครู่แล้วลองใหม่")
    content = data["choices"][0]["message"].get("content") or ""
    parsed = extract_json(content)
    reply = str(parsed.get("reply", "")).strip() or "ค่ะ"
    return {
        "reply": reply,
        "actions": clean_actions(parsed.get("actions", [])),
        "model": model,
        "latency": round(time.time() - t0, 2),
        "sources": sources,
    }


# Whisper มักแต่งประโยคเหล่านี้ขึ้นมาเองเมื่อได้ยินแต่ความเงียบ/เสียงรบกวน
HALLUCINATION_ALWAYS = [
    "ติดตามตอนต่อไป", "ขอบคุณที่รับชม", "ขอบคุณที่ติดตาม", "ซับไตเติ้ล", "ซับไทย", "คำบรรยาย",
    "กดติดตาม", "กดไลค์", "กดแชร์", "subscribe", "subtitles", "thanksforwatching",
]
HALLUCINATION_SHORT = {
    "สวัสดีครับ", "สวัสดีค่ะ", "สวัสดี", "ขอบคุณครับ", "ขอบคุณค่ะ", "ขอบคุณ", "โอเค", "โอ้", "โอ", "อ่า",
    "อืม", "เอ่อ", "ครับ", "ค่ะ", "คะ", "ฮะ", "จ้า", "อ๋อ", "ใช่", "ok", "okay", "you", "thankyou", "bye",
}


def _norm_text(t):
    return re.sub(r"[\s\.\,\!\?\-…'\"“”]+", "", t.lower())


def filter_transcript(data, voiced_ms, strict=True):
    """คืน (ข้อความ, เหตุผลที่ไม่รับ) — กรองข้อความที่ Whisper เดามั่วออก"""
    segs = data.get("segments") or []
    if segs:
        kept = [
            s for s in segs
            if s.get("no_speech_prob", 0) < 0.6
            and s.get("avg_logprob", 0) > -1.0
            and s.get("compression_ratio", 1) < 2.4
        ]
        text = "".join(s.get("text", "") for s in kept).strip()
        worst_ns = max((s.get("no_speech_prob", 0) for s in segs), default=0)
        mean_lp = sum(s.get("avg_logprob", 0) for s in segs) / len(segs)
    else:
        text, worst_ns, mean_lp = data.get("text", "").strip(), 0, 0
    n = _norm_text(text)
    if not n:
        return "", "ไม่มีเสียงพูด"
    if any(h in n for h in HALLUCINATION_ALWAYS):
        return "", f"ตัดคำที่ Whisper แต่งเอง ('{text}')"
    # กดไมค์เอง = ตั้งใจพูดแน่นอน ผ่อนเกณฑ์ลง / ฟังต่อเนื่อง = เข้มงวด
    min_ms, max_ns, min_lp = (700, 0.25, -0.55) if strict else (250, 0.5, -0.8)
    if n in HALLUCINATION_SHORT and (voiced_ms < min_ms or worst_ns > max_ns or mean_lp < min_lp):
        return "", f"เสียงสั้น/ไม่ชัด ไม่นับ ('{text}')"
    return text, None


def speech_to_text(audio_bytes, mime, voiced_ms=0, strict=True):
    ensure_ai()
    if not STT_MODEL:
        raise RuntimeError(f"ไม่มีโมเดล Whisper สำหรับแปลงเสียง ({AI_STATUS})")
    ext = "webm" if "webm" in mime else ("ogg" if "ogg" in mime else "wav")
    boundary = "----robotsim" + uuid.uuid4().hex
    parts = []

    def field(name, value):
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )

    field("model", STT_MODEL)
    field("language", "th")
    field("response_format", "verbose_json")
    field("temperature", "0")
    parts.append(
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.{ext}"\r\n'
            f"Content-Type: {mime or 'application/octet-stream'}\r\n\r\n"
        ).encode()
        + audio_bytes
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    data = groq_request(
        "/audio/transcriptions",
        data=b"".join(parts),
        content_type=f"multipart/form-data; boundary={boundary}",
    )
    return filter_transcript(data, voiced_ms, strict)


def text_to_speech(text):
    from gtts import gTTS  # ติดตั้งแล้วสำหรับ robot_brain.py

    buf = io.BytesIO()
    gTTS(text=text, lang="th").write_to_fp(buf)
    return buf.getvalue()


# ==================== REAL ROBOT (OPTIONAL) ====================
class SerialBridge:
    def __init__(self, name):
        self.name = name
        self.ser = None
        self.port = None
        self.auto = True         # ให้ AutoConnector หาบอร์ดเอง (ปิดเมื่อผู้ใช้กดตัดการเชื่อมต่อเอง)
        self.lock = threading.Lock()

    def ports(self):
        try:
            from serial.tools import list_ports

            return [{"port": p.device, "desc": p.description} for p in list_ports.comports()]
        except Exception:
            return []

    def connect(self, port, baud=115200):
        import serial

        self.attach(serial.Serial(port, baud, timeout=0.02))

    def attach(self, ser):
        """รับพอร์ตที่เปิดไว้แล้ว (จากการสแกน) มาใช้ต่อ ไม่ต้องเปิดใหม่ (Nano จะได้ไม่รีเซ็ตซ้ำ)"""
        self.disconnect()
        with self.lock:
            self.ser = ser
            self.port = ser.port

    def disconnect(self):
        with self.lock:
            if self.ser:
                try:
                    self.ser.close()
                except Exception:
                    pass
            self.ser = None
            self.port = None

    def send(self, line):
        with self.lock:
            if not self.ser:
                return False
            try:
                self.ser.write((line.strip() + "\n").encode())
                return True
            except Exception as e:
                # ถอดสาย USB -> ปล่อยพอร์ต ให้ AutoConnector หาใหม่เมื่อเสียบกลับ
                print(f"[!] {self.name} ({self.port}) หลุด: {e}")
                try:
                    self.ser.close()
                except Exception:
                    pass
                self.ser = None
                self.port = None
                return False


serial_bridge = SerialBridge("ESP32-S3")   # หัว/ตา/คอ
jaw_bridge = SerialBridge("Nano ปาก")       # รับคำสั่ง J<0-100>


class AutoConnector:
    """หาบอร์ดหุ่นเองทุกๆ 3 วินาที ไม่ต้องเลือก COM port
    - สแกนเฉพาะพอร์ต USB (ข้ามพอร์ต Bluetooth ซึ่งเปิดแล้วค้างนาน)
    - เปิดพอร์ตแล้วถาม: ESP32-S3 ตอบ "STATUS ..." / Nano ตอบ "JAW OK"
    - พอร์ตที่ไม่ใช่บอร์ดหุ่น จำไว้ไม่สแกนซ้ำจนกว่าจะถอดเสียบใหม่"""

    INTERVAL = 3.0
    PROBE_SECONDS = 2.5      # Nano รีเซ็ตตอนเปิดพอร์ต ใช้เวลาบูต ~1.5 วิ

    def __init__(self, bridges):
        self.bridges = bridges   # {"esp32": serial_bridge, "jaw": jaw_bridge}
        self.ignored = set()     # พอร์ตที่สแกนแล้วไม่ใช่บอร์ดหุ่น
        self.status = "กำลังค้นหาบอร์ด..."

    def start(self):
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            try:
                self.scan()
            except Exception as e:
                print(f"[!] ค้นหาบอร์ดอัตโนมัติผิดพลาด: {e}")
            time.sleep(self.INTERVAL)

    def scan(self):
        from serial.tools import list_ports

        usb = {p.device: p for p in list_ports.comports() if p.vid is not None}
        self.ignored &= set(usb)   # ถอดออกไปแล้ว -> เสียบใหม่ค่อยสแกนอีกครั้ง
        for b in self.bridges.values():
            if b.port and b.port not in usb:
                print(f"[!] {b.name} ถูกถอดออกจาก {b.port}")
                b.disconnect()
        wanted = {k: b for k, b in self.bridges.items() if b.auto and not b.port}
        if not wanted:
            return
        in_use = {b.port for b in self.bridges.values() if b.port}
        for dev in usb:
            if dev in in_use or dev in self.ignored:
                continue
            kind, ser = self.probe(dev)
            if kind in wanted:
                wanted.pop(kind).attach(ser)
                print(f"[✓] เชื่อมต่อ {self.bridges[kind].name} อัตโนมัติที่ {dev}")
            else:
                if ser:
                    ser.close()
                if kind is None:
                    self.ignored.add(dev)
            if not wanted:
                break

    def probe(self, dev):
        import serial

        try:
            ser = serial.Serial(dev, 115200, timeout=0.1, write_timeout=0.5)
        except Exception:
            return "busy", None   # พอร์ตถูกโปรแกรมอื่นใช้อยู่ (เช่น Arduino IDE) ลองใหม่รอบหน้า
        buf = b""
        t0 = time.time()
        asked = 0
        try:
            while time.time() - t0 < self.PROBE_SECONDS:
                # ถามซ้ำทุก ~0.8 วิ เผื่อบอร์ดยังบูตไม่เสร็จตอนถามครั้งแรก
                if time.time() - t0 >= asked * 0.8:
                    ser.write(b"STATUS\nPING\n")
                    asked += 1
                buf += ser.read(256)
                if b"JAW OK" in buf:
                    return "jaw", ser
                if b"STATUS " in buf:
                    return "esp32", ser
        except Exception:
            pass
        ser.close()
        return None, None


auto_connector = AutoConnector({"esp32": serial_bridge, "jaw": jaw_bridge})


# ==================== WEBCAM (เหมือน THREAD 1 ใน robot_brain.py) ====================
CASCADE_FILE = os.path.join(ROBOT_DIR, "haarcascade_frontalface_default.xml")
YUNET_MODEL = os.path.join(BASE_DIR, "models", "face_detection_yunet_2023mar.onnx")


def _iou(a, b):
    ax2, ay2, bx2, by2 = a[0] + a[2], a[1] + a[3], b[0] + b[2], b[1] + b[3]
    iw = max(0, min(ax2, bx2) - max(a[0], b[0]))
    ih = max(0, min(ay2, by2) - max(a[1], b[1]))
    inter = iw * ih
    return inter / float(a[2] * a[3] + b[2] * b[3] - inter or 1)


class SpeakerDetector:
    """หาว่าใครกำลังพูด จากการขยับปาก (ใช้ร่วมกับเสียงจากไมค์)
    - เทียบภาพบริเวณปากของแต่ละหน้ากับเฟรมก่อน แล้วหักการขยับของช่วงตา/หน้าผากออก
      (ถ้าทั้งหัวขยับหรือแสงเปลี่ยน ทั้งสองส่วนจะเปลี่ยนพอๆ กัน -> ไม่นับว่าพูด)
    - นับเฉพาะตอนไมค์ได้ยินเสียงพูดอยู่ และหน้านั้นต้องขยับปากเด่นกว่าคนอื่นชัดเจน"""

    MIN_SCORE = 1.5        # คะแนนขยับปากขั้นต่ำ (ค่าความต่างของพิกเซล 0-255 เฉลี่ย)
    LEAD_RATIO = 1.5       # ต้องขยับมากกว่าคนที่ 2 อย่างน้อยกี่เท่า

    def __init__(self):
        self.tracks = []       # [{box, mouth, upper, score}] ตรงกับ faces ของเฟรมล่าสุด

    @staticmethod
    def _patch(cv2, gray, x, y, w, h):
        H, W = gray.shape
        x0, y0 = max(0, int(x)), max(0, int(y))
        x1, y1 = min(W, int(x + w)), min(H, int(y + h))
        if x1 - x0 < 4 or y1 - y0 < 4:
            return None
        p = cv2.resize(gray[y0:y1, x0:x1], (32, 16), interpolation=cv2.INTER_AREA).astype("float32")
        return p - p.mean()    # ตัดผลของความสว่างทั้งภาพที่เปลี่ยน

    def update(self, cv2, gray, faces):
        tracks = []
        for f in faces:
            x, y, w, h = f
            mouth = self._patch(cv2, gray, x + w * 0.25, y + h * 0.65, w * 0.5, h * 0.3)
            upper = self._patch(cv2, gray, x + w * 0.2, y + h * 0.2, w * 0.6, h * 0.3)
            prev = max(self.tracks, key=lambda t: _iou(t["box"], f), default=None)
            score = 0.0
            if prev and _iou(prev["box"], f) > 0.3:
                score = prev["score"] * 0.7
                if mouth is not None and upper is not None and prev["mouth"] is not None and prev["upper"] is not None:
                    m = float(abs(mouth - prev["mouth"]).mean())
                    u = float(abs(upper - prev["upper"]).mean())
                    score += max(0.0, m - u) * 0.3
            tracks.append({"box": f, "mouth": mouth, "upper": upper, "score": score})
        self.tracks = tracks
        return [round(t["score"], 2) for t in tracks]

    def speaker(self, voice):
        if not voice or not self.tracks:
            return None
        ranked = sorted(self.tracks, key=lambda t: t["score"], reverse=True)
        best = ranked[0]
        if best["score"] < self.MIN_SCORE:
            return None
        if len(ranked) > 1 and best["score"] < ranked[1]["score"] * self.LEAD_RATIO:
            return None
        return best["box"]


class NearestFaceLock:
    """เลือกเฉพาะคนที่อยู่ใกล้กล้องที่สุด (หน้าใหญ่สุด) แล้วล็อกไว้
    - หน้าใหม่ต้องเห็นติดกันหลายเฟรมก่อนนับ (กันตรวจจับผิดชั่วขณะ)
    - เปลี่ยนเป้าหมายเมื่อมีคนอื่นอยู่ใกล้กว่าชัดเจนต่อเนื่องเท่านั้น (กันหัวส่ายไปมาระหว่าง 2 คน)
    - หน้าหลุดสั้นๆ (< 0.5 วิ) ยังจำตำแหน่งเดิมไว้
    - ถ้ามีคนกำลังพูด (speaker) จะหันไปหาคนนั้นก่อน และมองค้างไว้สักพักหลังพูดจบ"""

    CONFIRM_FRAMES = 3
    SWITCH_FRAMES = 8
    SWITCH_RATIO = 1.15
    LOST_TIMEOUT = 0.5
    SPEAKER_FRAMES = 4     # ต้องเห็นว่าคนนี้พูดติดกันกี่เฟรมถึงหันไปหา
    SPEAKER_HOLD = 4.0     # มองคนที่พูดค้างไว้กี่วินาทีหลังพูดจบ (ไม่สลับไปคนที่ใกล้กว่า)

    def __init__(self):
        self.target = None       # [x,y,w,h] (ปรับให้นิ่งแล้ว)
        self.last_seen = 0
        self.pending = None
        self.pending_count = 0
        self.switch_count = 0
        self.speaker_count = 0
        self.hold_until = 0

    def update(self, faces, now, speaker=None):
        nearest = faces[0] if faces else None   # faces เรียงจากใหญ่ไปเล็กแล้ว
        if self.target:
            match = max(faces, key=lambda f: _iou(f, self.target), default=None)
            if match is not None and _iou(match, self.target) > 0.2:
                # ปรับกรอบให้นิ่ง (ลดอาการสั่นของตัวตรวจจับ)
                self.target = [round(t * 0.4 + m * 0.6) for t, m in zip(self.target, match)]
                self.last_seen = now
            elif now - self.last_seen > self.LOST_TIMEOUT:
                self.target = None
            # คนอื่นกำลังพูด -> หันไปหาคนที่พูด
            if self.target and speaker is not None:
                if speaker is match:
                    self.speaker_count = 0
                    self.hold_until = now + self.SPEAKER_HOLD
                else:
                    self.speaker_count += 1
                    if self.speaker_count >= self.SPEAKER_FRAMES:
                        self.target, self.last_seen, self.speaker_count = list(speaker), now, 0
                        self.hold_until = now + self.SPEAKER_HOLD
                        return self.target
            else:
                self.speaker_count = 0
            # มีคนอื่นเข้ามาใกล้กว่าชัดเจน -> ย้ายไปมองคนนั้น (ยกเว้นกำลังมองคนที่เพิ่งพูดอยู่)
            if self.target and nearest is not None and nearest is not match and now >= self.hold_until:
                if nearest[2] > self.target[2] * self.SWITCH_RATIO:
                    self.switch_count += 1
                    if self.switch_count >= self.SWITCH_FRAMES:
                        self.target, self.last_seen, self.switch_count = list(nearest), now, 0
                else:
                    self.switch_count = 0
            else:
                self.switch_count = 0
            if self.target:
                return self.target

        # ยังไม่มีเป้าหมาย: รอให้หน้าที่ใกล้สุด (หรือคนที่กำลังพูด) ปรากฏต่อเนื่องก่อน
        if speaker is not None:
            nearest = speaker
        if nearest is None:
            self.pending, self.pending_count = None, 0
            return None
        if self.pending is not None and _iou(nearest, self.pending) > 0.2:
            self.pending_count += 1
        else:
            self.pending_count = 1
        self.pending = list(nearest)
        if self.pending_count >= self.CONFIRM_FRAMES:
            self.target, self.last_seen = list(nearest), now
            self.pending, self.pending_count = None, 0
        return self.target


class WebcamTracker:
    """เปิดกล้องคอม + ตรวจจับใบหน้าด้วย Haar cascade ค่าเดียวกับ robot_brain.py"""

    def __init__(self):
        self.lock = threading.Lock()
        self.thread = None
        self.running = False
        self.index = 0
        self.error = None
        self.jpeg = None
        self.frame_id = 0
        self.fps = 0.0
        self.faces = []          # [[x,y,w,h], ...] ใหญ่สุดก่อน (พิกัดภาพ 640x480 หลัง flip)
        self.target = None       # คนที่หุ่นล็อกเป้าไว้ (คนที่กำลังพูด หรือคนที่ใกล้ที่สุด)
        self.speaker = None      # หน้าที่ตรวจว่ากำลังพูดอยู่ตอนนี้
        self.mouth_scores = []   # คะแนนขยับปาก เรียงตรงกับ faces
        self.voice_at = 0        # เวลาล่าสุดที่ไมค์ (ฝั่งเว็บ) แจ้งว่าได้ยินเสียงพูด
        self.detector = None
        self.size = (640, 480)

    def start(self, index=0):
        self.stop()
        self.index = index
        self.error = None
        self.running = True
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.running = False
        if self.thread:
            self.thread.join(timeout=3)
        self.thread = None
        with self.lock:
            self.jpeg = None
            self.faces = []
            self.target = None
            self.speaker = None
            self.mouth_scores = []

    def voice(self):
        self.voice_at = time.time()

    def _loop(self):
        try:
            self._run()
        except Exception as e:
            self.error = f"กล้องผิดพลาด: {e}"
            print(f"[!] {self.error}")
        finally:
            self.running = False

    def _make_detector(self, cv2):
        """คืนฟังก์ชัน detect(frame) -> [[x,y,w,h], ...] ในพิกัดภาพเต็ม"""
        if hasattr(cv2, "CascadeClassifier"):
            face_cascade = cv2.CascadeClassifier(CASCADE_FILE)
            if face_cascade.empty():
                raise RuntimeError("โหลด haarcascade_frontalface_default.xml ไม่ได้")
            self.detector = "Haar cascade (เหมือน robot_brain.py)"

            def detect(frame):
                small_gray = cv2.resize(frame, (0, 0), fx=0.5, fy=0.5)
                small_gray = cv2.cvtColor(small_gray, cv2.COLOR_BGR2GRAY)
                faces = face_cascade.detectMultiScale(small_gray, scaleFactor=1.15, minNeighbors=4, minSize=(35, 35))
                return [[int(v * 2) for v in f] for f in faces]

            return detect

        # OpenCV 5 ตัด CascadeClassifier ออกแล้ว -> ใช้ YuNet (FaceDetectorYN) แทน
        if not os.path.isfile(YUNET_MODEL):
            raise RuntimeError("OpenCV รุ่นนี้ไม่มี Haar cascade และไม่พบไฟล์ models/" + os.path.basename(YUNET_MODEL))
        yunet = cv2.FaceDetectorYN.create(YUNET_MODEL, "", (320, 240), 0.75, 0.3, 50)
        self.detector = f"YuNet (OpenCV {cv2.__version__} ไม่มี Haar cascade)"

        def detect(frame):
            small = cv2.resize(frame, (0, 0), fx=0.5, fy=0.5)
            yunet.setInputSize((small.shape[1], small.shape[0]))
            _, faces = yunet.detect(small)
            out = []
            if faces is not None:
                for f in faces:
                    x, y, w, h = (int(v * 2) for v in f[:4])
                    if w >= 70:   # เทียบเท่า minSize=(35,35) ที่ภาพครึ่งขนาด
                        out.append([x, y, w, h])
            return out

        return detect

    def _run(self):
        try:
            import cv2
        except ImportError:
            self.error = "ไม่พบ OpenCV (pip install opencv-python)"
            return
        detect = self._make_detector(cv2)
        print(f"[*] ตรวจจับใบหน้าด้วย {self.detector}")
        cap = cv2.VideoCapture(self.index, cv2.CAP_DSHOW)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        if not cap.isOpened():
            self.error = f"เปิดกล้องหมายเลข {self.index} ไม่ได้ (ปิด robot_brain.py หรือโปรแกรมอื่นที่ใช้กล้องอยู่หรือไม่?)"
            return
        print(f"[✓] เปิดกล้องคอมหมายเลข {self.index} แล้ว")
        lock = NearestFaceLock()
        speakers = SpeakerDetector()
        t_last = time.time()
        fails = 0
        while self.running:
            ret, frame = cap.read()
            if not ret:
                fails += 1
                if fails > 30:
                    self.error = "อ่านภาพจากกล้องไม่ได้"
                    break
                time.sleep(0.03)
                continue
            fails = 0
            frame = cv2.flip(frame, 1)
            h, w, _ = frame.shape

            faces = sorted(detect(frame), key=lambda f: f[2] * f[3], reverse=True)

            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
            now = time.time()
            scores = speakers.update(cv2, cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), faces)
            speaker = speakers.speaker(voice=now - self.voice_at < 0.6)
            target = lock.update(faces, now, speaker)
            with self.lock:
                self.faces = faces
                self.target = target
                self.speaker = speaker
                self.mouth_scores = scores
                self.size = (w, h)
                if ok:
                    self.jpeg = buf.tobytes()
                self.frame_id += 1
                self.fps = self.fps * 0.9 + (1.0 / max(now - t_last, 1e-3)) * 0.1
            t_last = now
        cap.release()
        print("[*] ปิดกล้องคอมแล้ว")

    def state(self):
        with self.lock:
            return {
                "running": self.running,
                "error": self.error,
                "index": self.index,
                "frame_id": self.frame_id,
                "fps": round(self.fps, 1),
                "width": self.size[0],
                "height": self.size[1],
                "faces": self.faces,
                "target": self.target,
                "speaker": self.speaker,
                "mouth_scores": self.mouth_scores,
                "voice": time.time() - self.voice_at < 0.6,
                "detector": self.detector,
            }

    def latest_jpeg(self):
        with self.lock:
            return self.jpeg, self.frame_id


webcam = WebcamTracker()


# ==================== HTTP SERVER ====================
MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".stl": "application/octet-stream",
    ".json": "application/json",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # ไม่ให้คอนโซลรก

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path):
        if not os.path.isfile(path):
            self.send_error(404)
            return
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(os.path.splitext(path)[1].lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        url = urlparse(self.path)
        p = url.path
        if p == "/api/status":
            ensure_ai()
            self.send_json(
                {
                    "ai_status": AI_STATUS,
                    "chat_model": CHAT_MODEL,
                    "stt_model": STT_MODEL,
                    "serial_ports": serial_bridge.ports(),
                    "serial_connected": serial_bridge.port,
                    "jaw_connected": jaw_bridge.port,
                    "serial_auto": serial_bridge.auto,
                    "jaw_auto": jaw_bridge.auto,
                }
            )
        elif p == "/api/tts":
            text = parse_qs(url.query).get("text", [""])[0][:500]
            try:
                audio = text_to_speech(text)
            except Exception as e:
                self.send_json({"error": str(e)}, 503)
                return
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
        elif p == "/api/info":
            knowledge.refresh()
            self.send_json({"folder": INFO_DIR, "files": knowledge.files})
        elif p == "/api/camera/state":
            self.send_json(webcam.state())
        elif p == "/api/camera/stream":
            self.stream_mjpeg()
        elif p.startswith("/models/") and p[len("/models/"):] in STL_FILES:
            self.send_file(STL_FILES[p[len("/models/"):]])
        else:
            rel = "index.html" if p in ("/", "") else p.lstrip("/")
            full = os.path.normpath(os.path.join(WEB_DIR, rel))
            if not full.startswith(WEB_DIR):
                self.send_error(403)
                return
            self.send_file(full)

    def stream_mjpeg(self):
        boundary = "frame"
        self.send_response(200)
        self.send_header("Content-Type", f"multipart/x-mixed-replace; boundary={boundary}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        last_id = -1
        try:
            while webcam.running or webcam.jpeg:
                jpeg, fid = webcam.latest_jpeg()
                if jpeg is None or fid == last_id:
                    time.sleep(0.01)
                    if not webcam.running:
                        break
                    continue
                last_id = fid
                self.wfile.write(
                    f"--{boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: {len(jpeg)}\r\n\r\n".encode()
                    + jpeg
                    + b"\r\n"
                )
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_POST(self):
        p = urlparse(self.path).path
        try:
            if p == "/api/camera/start":
                req = json.loads(self.read_body() or b"{}")
                webcam.start(int(req.get("index", 0)))
                time.sleep(0.8)
                self.send_json(webcam.state())
                return
            if p == "/api/camera/stop":
                webcam.stop()
                self.send_json(webcam.state())
                return
            if p == "/api/camera/voice":
                webcam.voice()   # ไมค์ได้ยินเสียงพูด -> ใช้หาว่าใครในกล้องกำลังพูด
                self.send_json({"ok": True})
                return
            if p == "/api/info/reload":
                knowledge.refresh(force=True)
                self.send_json({"folder": INFO_DIR, "files": knowledge.files})
                return
            if p == "/api/info/open":
                os.makedirs(INFO_DIR, exist_ok=True)
                os.startfile(INFO_DIR)   # เปิดโฟลเดอร์ใน File Explorer
                self.send_json({"ok": True})
                return
            if p == "/api/chat":
                req = json.loads(self.read_body() or b"{}")
                result = chat_with_ai(req.get("history", []), req.get("robot_state"))
                print(f"[AI] {result['reply']}  {[a['cmd'] for a in result['actions']]}")
                self.send_json(result)
            elif p == "/api/stt":
                voiced_ms = int(self.headers.get("X-Voiced-Ms") or 0)
                strict = self.headers.get("X-Strict", "1") == "1"
                text, rejected = speech_to_text(self.read_body(), self.headers.get("Content-Type", ""), voiced_ms, strict)
                print(f"[ได้ยิน] {text}" if text else f"[ไม่นับ] {rejected}")
                self.send_json({"text": text, "rejected": rejected})
            elif p in ("/api/serial/connect", "/api/jaw/connect"):
                # port = "auto" ให้ค้นหาเอง / ชื่อพอร์ต = เลือกเอง / ว่าง = ตัดการเชื่อมต่อ (และหยุดค้นหาอัตโนมัติ)
                bridge = serial_bridge if p == "/api/serial/connect" else jaw_bridge
                req = json.loads(self.read_body() or b"{}")
                port = req.get("port")
                if port == "auto":
                    bridge.auto = True
                elif port:
                    bridge.auto = True
                    bridge.connect(port, int(req.get("baud", 115200)))
                    print(f"[✓] เชื่อมต่อ {bridge.name} ที่ {port}")
                else:
                    bridge.auto = False
                    bridge.disconnect()
                    print(f"[*] ตัดการเชื่อมต่อ {bridge.name} (ปิดการค้นหาอัตโนมัติ)")
                self.send_json({"connected": bridge.port, "auto": bridge.auto})
            elif p == "/api/serial/send":
                req = json.loads(self.read_body() or b"{}")
                ok = True
                for line in req.get("lines", []):
                    ok = serial_bridge.send(str(line)) and ok
                self.send_json({"ok": ok})
            elif p == "/api/jaw/send":
                req = json.loads(self.read_body() or b"{}")
                pct = max(0, min(100, int(req.get("pct", 0))))
                self.send_json({"ok": jaw_bridge.send(f"J{pct}")})
            else:
                self.send_error(404)
        except Exception as e:
            print(f"[!] {p}: {e}")
            self.send_json({"error": str(e)}, 500)


def main():
    print("[*] กำลังตรวจสอบ AI (Groq)...")
    init_ai()
    print(f"[AI] {AI_STATUS}  chat={CHAT_MODEL}  stt={STT_MODEL}")
    knowledge.refresh()
    if "--no-serial" not in sys.argv:
        print("[*] ค้นหาบอร์ดหุ่น (ESP32-S3 / Nano) ทางพอร์ต USB อัตโนมัติ...")
        auto_connector.start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}/"
    print("\n╔══════════════════════════════════════════════╗")
    print("║   Nong Mali Robot Simulator พร้อมใช้งาน 🤖     ║")
    print(f"║   เปิดเบราว์เซอร์ที่ {url:<26}║")
    print("║   กด Ctrl+C ที่หน้าต่างนี้เพื่อปิดโปรแกรม          ║")
    print("╚══════════════════════════════════════════════╝\n")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        webcam.stop()
        serial_bridge.disconnect()
        jaw_bridge.send("J0")
        jaw_bridge.disconnect()
        server.server_close()


if __name__ == "__main__":
    main()
