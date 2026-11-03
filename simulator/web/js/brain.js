// จำลอง robot_brain.py (ฝั่งคอมพิวเตอร์) ให้ทำงานเหมือนตัวจริง
//  - กล้องติดตามใบหน้า -> ส่ง T,pan,tilt,eyeX,eyeY ไป ESP32
//  - สถานะ IDLE / NOTICED / CHATTING, ทักทายเมื่อเดินเข้าใกล้, บอกลา, เงียบ 60 วิ
//  - ฟังเสียง (Whisper) -> คิด (AI) -> พูด (gTTS) + ปากขยับตามเสียง (Jawduino)

export const CONFIG = {
  REVERSE_PAN: true,
  REVERSE_TILT: true,
  REVERSE_EYE_X: false,
  REVERSE_EYE_Y: false,
  FACE_CLOSE_THRESHOLD: 0.24,
  MIC_ENERGY_THRESHOLD: 350,   // เทียบเท่า speech_recognition (ใช้กับ VAD ในเบราว์เซอร์)
  PAUSE_THRESHOLD: 0.6,
  PHRASE_TIME_LIMIT: 6,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function getNaturalGreeting() {
  const hour = new Date().getHours();
  let period, remarks;
  if (hour >= 5 && hour < 12) {
    period = 'สวัสดีตอนเช้าค่ะ';
    remarks = ['รับขนมปังอุ่นๆ เป็นมื้อเช้าไหมคะ', 'ทานข้าวเช้าแล้วหรือยังคะ'];
  } else if (hour >= 12 && hour < 17) {
    period = 'สวัสดีตอนบ่ายนะคะ';
    remarks = ['เบรกบ่ายด้วยขนมหวานสักชิ้นไหมคะ', 'วันนี้อยากทานอะไรหวานๆ ไหมคะ'];
  } else {
    period = 'สวัสดีตอนค่ำค่ะ';
    remarks = ['แวะซื้อขนมกลับไปฝากที่บ้านไหมคะ', 'เหนื่อยมาทั้งวัน ให้รางวัลตัวเองด้วยขนมสักชิ้นนะคะ'];
  }
  return pick([
    `${period} ยินดีต้อนรับสู่ร้าน Adam Society ค่ะ หนูชื่อน้องมะลินะคะ ${pick(remarks)}`,
    `${period} อยากให้หนูช่วยแนะนำเมนูขนม เรียกหนูได้เลยนะคะ`,
    `${period} ดีใจที่ได้เจอนะคะ ${pick(remarks)}`,
  ]);
}

export function isGreetingWord(text) {
  const greetings = ['สวัสดี', 'ดีครับ', 'ดีค่ะ', 'ฮัลโหล', 'หวัดดี', 'น้องหุ่น', 'หุ่นยนต์', 'ไฮ', 'hello', 'hi'];
  const t = text.toLowerCase().replace(/\s/g, '');
  return greetings.some((w) => t.includes(w)) && [...t].length <= 15;
}

export function isFarewellWord(text) {
  const farewells = ['ไปแล้วนะ', 'บ๊ายบาย', 'ลาก่อน', 'บาย', 'ไว้เจอกัน', 'ไปก่อนนะ', 'ไปละนะ', 'กลับแล้วนะ', 'ขอบคุณนะ', 'ขอบใจนะ'];
  const t = text.toLowerCase().replace(/\s/g, '');
  return farewells.some((w) => t.includes(w));
}

const BYES = [
  'บ๊ายบายค่ะ เดินทางปลอดภัยนะคะ แล้วแวะมาคุยกับหนูใหม่น้า สวัสดีค่ะ',
  'ด้วยความยินดีค่ะ ขอให้มีความสุขในวันนี้นะคะ สวัสดีค่ะ',
  'โอกาสหน้าแวะมาเที่ยวหาหนูใหม่นะคะ บ๊ายบายค่ะ',
];

export class RobotBrain {
  constructor({ serial, jaw, firmware, ui }) {
    this.serial = serial;     // (line) => void  ส่งคำสั่งไป ESP32
    this.jaw = jaw;
    this.fw = firmware;
    this.ui = ui;             // callbacks: onSay, onHeard, onState, onLog

    // RobotContext
    this.state = 'IDLE';
    this.facePresent = false;
    this.faceRatio = 0; this.normX = 0.5; this.normY = 0.5;
    this.isListening = false; this.isThinking = false; this.isSpeaking = false;
    this.lastUserSaid = '';
    this.triggerProximityGreet = false;
    this.hadGreeted = false;
    this.lastSpeechTime = 0;

    this.lastFaceSeenTime = 0;
    this.lastSerialSendTime = 0;
    this.noddedForCustomer = false;
    this.computed = { pan: 90, tilt: 90, eyeX: 512, eyeY: 512 };

    this.history = [];            // ความจำบทสนทนา (init_chat_session ล้างใหม่ทุกครั้งที่ทักทาย)
    this.autoBrain = true;        // false = ปิดสมองอัตโนมัติ (ควบคุมเองอย่างเดียว)
    this.holdUntil = 0;           // AI/ผู้ใช้สั่งท่าทาง -> พักการติดตามใบหน้าชั่วคราว
    this.camera = { present: false, normX: 0.5, normY: 0.45, ratio: 0.12 };

    this.audioCtx = null;
    this.analyser = null;
    this.currentAudio = null;
    this.speakAbort = null;
    this.busy = false;
  }

  // ---------- สถานะสำหรับ UI ----------
  get statusText() {
    if (this.isSpeaking) return ['[ SPEAKING ] กำลังพูดตอบ...', 'speaking'];
    if (this.isThinking) return ['[ THINKING ] กำลังคิดคำตอบ...', 'thinking'];
    if (this.isListening) return ['[ LISTENING ] กำลังตั้งใจฟังเสียงคุณพูด...', 'listening'];
    return [`State: ${this.state}`, 'idle'];
  }

  send(line) { this.serial(line); }

  // ---------- THREAD 1: กล้อง + ติดตามใบหน้า (เรียกทุกเฟรม) ----------
  visionTick(now) {
    if (!this.autoBrain) return;
    const cam = this.camera;
    if (cam.present) {
      this.lastFaceSeenTime = now;
      this.normX = cam.normX; this.normY = cam.normY;
      this.faceRatio = cam.ratio; this.facePresent = true;

      const panDeg = Math.trunc(CONFIG.REVERSE_PAN ? 60 + this.normX * 80 : 140 - this.normX * 80);
      const tiltDeg = Math.trunc(CONFIG.REVERSE_TILT ? 110 - this.normY * 40 : 70 + this.normY * 40);
      const eyeX = Math.trunc(CONFIG.REVERSE_EYE_X ? (1 - this.normX) * 1023 : this.normX * 1023);
      const eyeY = Math.trunc(CONFIG.REVERSE_EYE_Y ? (1 - this.normY) * 1023 : this.normY * 1023);
      this.computed = { pan: panDeg, tilt: tiltDeg, eyeX, eyeY };

      if (!this.isThinking && now > this.holdUntil && now - this.lastSerialSendTime >= 35) {
        this.send(`T,${panDeg},${tiltDeg},${eyeX},${eyeY}`);
        this.lastSerialSendTime = now;
      }

      if (this.state === 'IDLE') {
        this.setState('NOTICED');
        if (!this.noddedForCustomer) { this.send('NOD'); this.noddedForCustomer = true; }
      }
      if (this.faceRatio >= CONFIG.FACE_CLOSE_THRESHOLD && !this.hadGreeted && !this.isSpeaking) {
        this.triggerProximityGreet = true;
      }
    } else if (now - this.lastFaceSeenTime > 2500) {
      this.facePresent = false;
      this.noddedForCustomer = false;
      this.hadGreeted = false;
      if (this.state !== 'IDLE' && !this.isSpeaking) {
        this.setState('IDLE');
        if (now - this.lastSerialSendTime >= 50) { this.send('I'); this.lastSerialSendTime = now; }
      }
    }

    // ---------- THREAD 2 (ส่วนที่ไม่ต้องรอเสียง) ----------
    if (this.triggerProximityGreet && !this.isSpeaking && !this.hadGreeted && !this.busy) {
      this.triggerProximityGreet = false;
      this.proximityGreet();
    }
    if (this.state === 'CHATTING' && !this.busy && !this.isListening &&
        Date.now() - this.lastSpeechTime > 60000) {
      this.setState('NOTICED');
      this.hadGreeted = false;
      this.ui.onLog?.('เงียบเกิน 60 วินาที -> กลับไปโหมดสังเกตการณ์');
    }
  }

  setState(s) {
    if (this.state !== s) { this.state = s; this.ui.onState?.(s); }
  }

  initChatSession() {
    this.history = [];
    this.ui.onLog?.('เริ่มบทสนทนาใหม่ (init_chat_session)');
  }

  async proximityGreet() {
    this.busy = true;
    this.isSpeaking = true;
    this.setState('CHATTING');
    this.hadGreeted = true;
    this.initChatSession();
    this.send('NOD');
    await sleep(200);
    const g = getNaturalGreeting();
    this.history.push({ role: 'assistant', content: g });
    await this.speak(g);
    this.lastSpeechTime = Date.now();
    this.isSpeaking = false;
    this.busy = false;
  }

  // ---------- เมื่อได้ยิน/พิมพ์ข้อความจากลูกค้า ----------
  async handleUserText(userText) {
    userText = userText.trim();
    if (!userText || this.busy) return;
    this.busy = true;
    try {
      this.lastUserSaid = userText;
      this.ui.onHeard?.(userText);
      this.lastSpeechTime = Date.now();

      this.send('TILT');        // เอียงคอฟังทันทีที่ได้ยินเสียงพูด
      await sleep(150);
      this.isSpeaking = true;

      if (isFarewellWord(userText)) {
        this.send('NOD');
        await this.speak(pick(BYES));
        this.hadGreeted = false;
        this.setState('NOTICED');
      } else if (!this.hadGreeted) {
        this.hadGreeted = true;
        this.setState('CHATTING');
        this.initChatSession();
        if (isGreetingWord(userText)) {
          this.send('NOD');
          const g = getNaturalGreeting();
          this.history.push({ role: 'user', content: userText }, { role: 'assistant', content: g });
          await this.speak(g);
        } else {
          await this.thinkAndAnswer(userText);
        }
      } else {
        this.setState('CHATTING');
        await this.thinkAndAnswer(userText);
      }
    } catch (e) {
      this.ui.onLog?.('ผิดพลาด: ' + e.message, 'err');
    } finally {
      this.lastSpeechTime = Date.now();
      this.isSpeaking = false;
      this.isThinking = false;
      this.busy = false;
    }
  }

  async thinkAndAnswer(userText) {
    this.isThinking = true;
    this.send('THINK');
    await sleep(250);
    this.history.push({ role: 'user', content: userText });
    let result;
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          history: this.history,
          robot_state: {
            state: this.state,
            pan: this.fw.servoPan, tilt: this.fw.servoTilt,
            customer_in_front: this.facePresent,
          },
        }),
      });
      result = await r.json();
      if (result.error) throw new Error(result.error);
    } catch (e) {
      this.ui.onLog?.('AI ผิดพลาด: ' + e.message, 'err');
      result = { reply: 'ยินดีให้บริการค่ะ มีข้อมูลส่วนไหนให้หนูช่วยเหลือเพิ่มเติมไหมคะ', actions: [] };
    }
    this.isThinking = false;
    this.history.push({ role: 'assistant', content: result.reply });
    if (result.actions?.length) {
      this.ui.onLog?.('AI สั่งท่าทาง: ' + result.actions.map(fmtAction).join(' → '), 'ai');
    }
    // พูดและทำท่าไปพร้อมกัน
    let meta = result.model ? `AI: ${result.model}` : '';
    if (result.sources?.length) meta += ` · อ้างอิง: ${result.sources.join(', ')}`;
    await Promise.all([this.speak(result.reply, meta), this.runActions(result.actions || [])]);
  }

  // ---------- ทำตามคำสั่งท่าทางจาก AI ----------
  async runActions(actions) {
    for (const a of actions) {
      switch (a.cmd) {
        case 'NOD': case 'TILT': case 'THINK':
          this.send(a.cmd);
          await sleep(a.cmd === 'TILT' ? 850 : 650);
          break;
        case 'IDLE':
          this.holdUntil = 0;
          this.send('I');
          await sleep(400);
          break;
        case 'LOOK': {
          const pan = clamp(Math.round(+a.pan || 90), 30, 150);
          const tilt = clamp(Math.round(+a.tilt || 90), 50, 130);
          await this.holdPose(pan, tilt, 512, 512, a.duration ?? 2.5);
          break;
        }
        case 'EYES': {
          const x = clamp(Math.round(Number.isFinite(+a.x) ? +a.x : 512), 0, 1023);
          const y = clamp(Math.round(Number.isFinite(+a.y) ? +a.y : 512), 0, 1023);
          await this.holdPose(Math.round(this.fw.targetPan), Math.round(this.fw.targetTilt), x, y, a.duration ?? 2);
          break;
        }
        case 'WAIT':
          await sleep(clamp(+a.seconds || 0.5, 0.1, 5) * 1000);
          break;
      }
    }
  }

  // ESP32 ปล่อยท่าเองหลัง 2.5 วิ ถ้าไม่ได้รับ T ซ้ำ จึงส่งซ้ำทุก 100ms ตลอดช่วงเวลาที่สั่ง
  async holdPose(pan, tilt, ex, ey, seconds) {
    const end = performance.now() + clamp(+seconds || 2.5, 0.3, 10) * 1000;
    this.holdUntil = end;
    while (performance.now() < end) {
      this.send(`T,${pan},${tilt},${ex},${ey}`);
      await sleep(100);
    }
  }

  // ---------- เสียงพูด + ปาก ----------
  ensureAudio() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.connect(this.audioCtx.destination);
      this.analyserBuf = new Float32Array(this.analyser.fftSize);
      if (this.outputDeviceId) this.setOutputDevice(this.outputDeviceId);
    }
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
  }

  // เลือกลำโพงที่ใช้พูด ('' = ลำโพงหลักของ Windows) ใช้ได้กับเสียง gTTS เท่านั้น
  // (เสียงสำรองของเบราว์เซอร์ speechSynthesis จะออกลำโพงหลักเสมอ)
  async setOutputDevice(deviceId) {
    this.outputDeviceId = deviceId;
    if (!this.audioCtx) return true;            // ยังไม่สร้าง AudioContext ไว้ตั้งตอน ensureAudio
    if (!this.audioCtx.setSinkId) return false; // เบราว์เซอร์ไม่รองรับ (ใช้ Chrome/Edge 110 ขึ้นไป)
    try {
      await this.audioCtx.setSinkId(deviceId || '');
      return true;
    } catch (e) {
      this.ui.onLog?.('เปลี่ยนลำโพงไม่ได้: ' + e.message, 'err');
      return false;
    }
  }

  // อ่านระดับเสียงจากลำโพง -> KA2284 -> Jawduino
  audioTick() {
    if (this.currentAudio && this.analyser) {
      this.analyser.getFloatTimeDomainData(this.analyserBuf);
      let sum = 0;
      for (const v of this.analyserBuf) sum += v * v;
      this.jaw.setLevelFromRms(Math.sqrt(sum / this.analyserBuf.length));
    } else if (this.synthSpeaking) {
      // เสียงจาก speechSynthesis วัดระดับไม่ได้ -> จำลองจังหวะพยางค์
      const t = performance.now() / 1000;
      const env = Math.max(0, Math.sin(t * 13) * 0.6 + Math.sin(t * 7.3) * 0.4);
      this.jaw.setLevelFromRms(env * 0.22);
    } else {
      this.jaw.level = 0;
    }
  }

  async speak(text, meta) {
    this.ui.onSay?.(text, meta);
    this.ensureAudio();
    try {
      await this.speakGtts(text);
    } catch (e) {
      this.ui.onLog?.('gTTS ใช้ไม่ได้ ใช้เสียงของเบราว์เซอร์แทน (' + e.message + ')', 'warn');
      await this.speakSynth(text);
    }
    this.jaw.level = 0;
  }

  async speakGtts(text) {
    const r = await fetch('/api/tts?text=' + encodeURIComponent(text));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    const audio = await this.audioCtx.decodeAudioData(buf);
    await new Promise((resolve) => {
      const src = this.audioCtx.createBufferSource();
      src.buffer = audio;
      src.playbackRate.value = this.ui.speechRate?.() ?? 1.0;
      src.connect(this.analyser);
      this.currentAudio = src;
      this.speakAbort = () => { try { src.stop(); } catch {} };
      src.onended = () => { this.currentAudio = null; this.speakAbort = null; resolve(); };
      src.start();
    });
  }

  speakSynth(text) {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'th-TH';
      const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('th'));
      u.voice = voices.find((v) => /premwadee|kanya|female|achara/i.test(v.name)) || voices[0] || null;
      u.rate = 1.0; u.pitch = 1.15;
      this.synthSpeaking = true;
      const done = () => { this.synthSpeaking = false; this.speakAbort = null; resolve(); };
      u.onend = done; u.onerror = done;
      this.speakAbort = () => { speechSynthesis.cancel(); done(); };
      speechSynthesis.speak(u);
    });
  }

  stopSpeaking() { this.speakAbort?.(); }

  // ---------- ไมโครโฟน: อัดเสียงแบบมี VAD (pause 0.6 วิ, ไม่เกิน 6 วิ) แล้วส่ง Whisper ----------
  // strict=true: โหมดฟังต่อเนื่อง (กรองเข้ม) / false: ผู้ใช้กดปุ่มไมค์เอง (ไวกว่า)
  async listenOnce(strict = false) {
    if (this.isListening || this.busy) return;
    this.ensureAudio();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      this.ui.onLog?.('เปิดไมโครโฟนไม่ได้: ' + e.message, 'err');
      return;
    }
    this.isListening = true;
    this.ui.onListen?.(true);
    const src = this.audioCtx.createMediaStreamSource(stream);
    const an = this.audioCtx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const spec = new Float32Array(an.frequencyBinCount);
    const hzPerBin = this.audioCtx.sampleRate / an.fftSize;
    // สัดส่วนพลังงานในย่านเสียงพูดคน (100-4000 Hz รวมเสียงผู้ชายเสียงต่ำ) -> แยกจากเสียงฮัมไฟ/คลิกคีย์บอร์ด
    const speechBandRatio = () => {
      an.getFloatFrequencyData(spec);
      let band = 0, total = 0;
      for (let i = 1; i < spec.length; i++) {
        const hz = i * hzPerBin;
        if (hz < 40 || hz > 10000) continue;
        const p = 10 ** (spec[i] / 10);
        total += p;
        if (hz >= 100 && hz <= 4000) band += p;
      }
      return total > 0 ? band / total : 0;
    };
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.start(100);

    // แปลงค่า energy_threshold (300-700) ของ speech_recognition เป็น RMS โดยประมาณ
    const baseThr = CONFIG.MIC_ENERGY_THRESHOLD / 32768 * 1.6;
    this.noiseFloor = Math.min(this.noiseFloor ?? baseThr / 3, baseThr);
    const t0 = performance.now();
    let heard = false, lastVoice = 0, speechStart = 0, run = 0, voicedMs = 0, lastVoicePing = 0;
    this.ui.onMicNote?.(strict ? 'กำลังฟัง (ฟังต่อเนื่อง)...' : 'กำลังฟัง... พูดได้เลย');
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let s = 0; for (const v of buf) s += v * v;
        const rms = Math.sqrt(s / buf.length);
        // เกณฑ์ปรับตามเสียงรบกวนในห้องอัตโนมัติ (คล้าย adjust_for_ambient_noise)
        // แต่มีเพดาน: เกณฑ์สูงสุดไม่เกิน 2.5 เท่าของ MIC_ENERGY_THRESHOLD ไม่งั้นไมค์จะ "หูหนวก"
        const thr = Math.max(baseThr, this.noiseFloor * 2.5);
        const loud = rms > thr;
        // กดไมค์เอง: นับแค่ความดัง / ฟังต่อเนื่อง: ต้องเป็นย่านเสียงพูดคนด้วย (กันเสียงรบกวน)
        const voiced = loud && (!strict || speechBandRatio() > 0.45);
        if (!loud) {
          // เรียนรู้เสียงรบกวนจากช่วงที่เงียบเท่านั้น (ลงเร็ว ขึ้นช้า)
          const k = rms < this.noiseFloor ? 0.3 : 0.02;
          this.noiseFloor = Math.min(baseThr, this.noiseFloor * (1 - k) + rms * k);
        }
        this.ui.onMicLevel?.(rms / thr);
        const now = performance.now();
        run = voiced ? run + 1 : 0;
        if (!heard && run >= 2) { heard = true; speechStart = now; }   // ต้องดังต่อเนื่อง ≥ 100ms ถึงนับว่าเริ่มพูด
        if (voiced) { lastVoice = now; if (heard) voicedMs += 50; }
        // แจ้งเซิร์ฟเวอร์ว่ามีคนพูดอยู่ -> ใช้หาว่าใครในกล้องขยับปาก แล้วหันไปหาคนนั้น
        if (voiced && now - lastVoicePing > 250) {
          lastVoicePing = now;
          fetch('/api/camera/voice', { method: 'POST' }).catch(() => {});
        }
        const timeout = !heard && now - t0 > 5000;
        const pause = heard && now - lastVoice > CONFIG.PAUSE_THRESHOLD * 1000 + 200;
        const limit = heard && now - speechStart > CONFIG.PHRASE_TIME_LIMIT * 1000;
        if (timeout || pause || limit || this.cancelListen) { clearInterval(iv); resolve(); }
      }, 50);
    });
    const cancelled = this.cancelListen;
    this.cancelListen = false;
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    stream.getTracks().forEach((t) => t.stop());
    src.disconnect();
    this.isListening = false;
    this.ui.onListen?.(false);
    this.ui.onMicLevel?.(0);

    if (cancelled) return;
    // ไม่มีเสียงพูดจริง -> ไม่ส่งไป Whisper (ถ้าส่งไป Whisper จะเดาคำมั่ว เช่น "สวัสดีครับ")
    if (!heard) { this.ui.onMicNote?.('ไม่ได้ยินเสียงพูด'); return; }
    const minMs = strict ? 300 : 150;
    if (voicedMs < minMs) { this.ui.onMicNote?.(`เสียงสั้นเกินไป (${voicedMs}ms) ไม่นับ`); return; }
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    try {
      this.ui.onMicNote?.('กำลังแปลงเสียง...');
      const r = await fetch('/api/stt', {
        method: 'POST',
        headers: { 'Content-Type': blob.type, 'X-Voiced-Ms': String(voicedMs), 'X-Strict': strict ? '1' : '0' },
        body: blob,
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      if (!j.text) { this.ui.onMicNote?.(j.rejected || 'ฟังไม่ออก'); return; }
      this.ui.onMicNote?.('');
      await this.handleUserText(j.text);
    } catch (e) {
      this.ui.onLog?.('แปลงเสียงไม่สำเร็จ: ' + e.message, 'err');
    }
  }
}

export function fmtAction(a) {
  switch (a.cmd) {
    case 'LOOK': return `LOOK(pan ${a.pan}, tilt ${a.tilt})`;
    case 'EYES': return `EYES(${a.x}, ${a.y})`;
    case 'WAIT': return `WAIT ${a.seconds}s`;
    default: return a.cmd;
  }
}
