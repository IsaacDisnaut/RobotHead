// จำลองเฟิร์มแวร์ฝั่งฮาร์ดแวร์ ให้ตรงกับโค้ดจริงในโฟลเดอร์ "โค้ดทั้ง2ฝั่ง"
//  - Esp32 s3.txt : เซอร์โวคอ Pan/Tilt + ตา GC9A01 2 จอ + คำสั่ง Serial (T, NOD, TILT, THINK, I)
//  - โค้ดปาก Arduino Nano (Jawduino) : ขยับปากตามระดับเสียงจาก KA2284 (0-3 ดวง)

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ตาราง ease แบบเดียวกับ PROGMEM ease[] (smoothstep)
const ease = (t) => t * t * (3 - 2 * t);

// ค่าจาก kActiveMood = "natural"
const MOOD = {
  blinkMinMs: 36, blinkMaxMs: 72,
  blinkGapMinMs: 2500, blinkGapMaxMs: 6000,
  movePauseMinMs: 1500, movePauseMaxMs: 4500,
  moveTimeMinMs: 180, moveTimeMaxMs: 320,
  irisTransitionMs: 10000,
};

// เฟิร์มแวร์จริงวาดตาครั้งละ 1 จอ (160x160 @ SPI 20MHz) ≈ 25ms ต่อรอบ frame()
export const ESP32_FRAME_MS = 25;

export class Esp32Firmware {
  constructor() {
    this.targetPan = 90; this.targetTilt = 90;
    this.currentPan = 90; this.currentTilt = 90;
    this.servoPan = 90; this.servoTilt = 90;
    this.pcTrackingMode = false;
    this.lastPcMessageTime = 0;
    this.pcEyeX = 512; this.pcEyeY = 512;
    this.isNodding = false; this.nodStartTime = 0;
    this.isTilting = false; this.tiltStartTime = 0;
    this.lastIdleHeadMove = 0;

    // ตา (ใช้ร่วมกันทั้งสองจอ เหมือนตัวจริง)
    this.eyeX = 512; this.eyeY = 512;
    this.eyeInMotion = false;
    this.eyeOld = { x: 512, y: 512 }; this.eyeNew = { x: 512, y: 512 };
    this.eyeMoveStart = 0; this.eyeMoveDuration = 0;
    this.upperThreshold = 128;
    this.blink = [{ state: 0, start: 0, dur: 0 }, { state: 0, start: 0, dur: 0 }]; // 0=NOBLINK 1=ENBLINK 2=DEBLINK
    this.timeOfLastBlink = 0; this.timeToNextBlink = rand(MOOD.blinkGapMinMs, MOOD.blinkGapMaxMs);
    this.iris = { old: 110, target: 110, start: 0 };
    this.iScale = 110;
    this.eyeOpen = [1, 1];     // 1 = ลืมเต็มที่, 0 = หลับ
    this.lidBias = 0;          // เปลือกตาบนตามการมองขึ้นลง

    this.rx = [];              // log คำสั่งที่รับ
    this.acc = 0;
  }

  // ===== checkSerialCommand() =====
  receive(line, now = performance.now()) {
    const s = line.trim();
    if (s.startsWith('T,')) {
      const p = s.split(',');
      if (p.length >= 5) {
        this.targetPan = parseFloat(p[1]) || 0;
        this.targetTilt = parseFloat(p[2]) || 0;
        this.pcEyeX = parseInt(p[3]) || 0;
        this.pcEyeY = parseInt(p[4]) || 0;
        this.pcTrackingMode = true;
        this.lastPcMessageTime = now;
      }
    } else if (s === 'NOD') {
      this.isNodding = true; this.nodStartTime = now;
    } else if (s === 'TILT') {
      this.isTilting = true; this.tiltStartTime = now;
    } else if (s === 'THINK') {
      this.pcEyeX = 512; this.pcEyeY = 250;
    } else if (s.startsWith('I')) {
      this.pcTrackingMode = false;
      this.targetPan = 90; this.targetTilt = 90;
    }
  }

  update(dtMs, now = performance.now()) {
    this.acc += dtMs;
    let steps = 0;
    while (this.acc >= ESP32_FRAME_MS && steps < 8) {
      this.acc -= ESP32_FRAME_MS;
      this.frame(now);
      steps++;
    }
    if (steps >= 8) this.acc = 0;
  }

  // ===== frame() =====
  frame(now) {
    if (this.pcTrackingMode && now - this.lastPcMessageTime > 2500) {
      this.pcTrackingMode = false;
      this.targetPan = 90; this.targetTilt = 90;
    }

    let effTilt = this.targetTilt, effPan = this.targetPan;
    if (this.isNodding) {
      const e = now - this.nodStartTime;
      if (e < 300) effTilt += 15;
      else if (e < 600) effTilt -= 5;
      else this.isNodding = false;
    } else if (this.isTilting) {
      const e = now - this.tiltStartTime;
      if (e < 800) { effPan += 6; effTilt += 4; }
      else this.isTilting = false;
    }

    this.currentPan += (effPan - this.currentPan) * 0.14;
    this.currentTilt += (effTilt - this.currentTilt) * 0.14;
    this.servoPan = clamp(Math.trunc(this.currentPan), 30, 150);
    this.servoTilt = clamp(Math.trunc(this.currentTilt), 50, 130);

    if (this.pcTrackingMode) {
      this.eyeX = this.pcEyeX; this.eyeY = this.pcEyeY;
    } else {
      if (now - this.lastIdleHeadMove > 4000) {
        this.lastIdleHeadMove = now;
        this.targetPan = 90 + randInt(-10, 11);
        this.targetTilt = 90 + randInt(-5, 6);
      }
      const dt = now - this.eyeMoveStart;
      if (this.eyeInMotion) {
        if (dt >= this.eyeMoveDuration) {
          this.eyeInMotion = false;
          this.eyeMoveDuration = rand(MOOD.movePauseMinMs, MOOD.movePauseMaxMs);
          this.eyeMoveStart = now;
          this.eyeOld = { ...this.eyeNew };
          this.eyeX = this.eyeNew.x; this.eyeY = this.eyeNew.y;
        } else {
          const e = ease(clamp(dt / this.eyeMoveDuration, 0, 1));
          this.eyeX = this.eyeOld.x + (this.eyeNew.x - this.eyeOld.x) * e;
          this.eyeY = this.eyeOld.y + (this.eyeNew.y - this.eyeOld.y) * e;
        }
      } else {
        // หลังจาก PC ปล่อยการควบคุม ตาค่อยๆ เริ่มจากตำแหน่งล่าสุด
        this.eyeOld = { x: this.eyeX, y: this.eyeY };
        if (dt > this.eyeMoveDuration) {
          let nx, ny;
          do {
            nx = randInt(0, 1024); ny = randInt(0, 1024);
          } while ((nx * 2 - 1023) ** 2 + (ny * 2 - 1023) ** 2 > 1023 * 1023);
          this.eyeNew = { x: nx, y: ny };
          this.eyeMoveDuration = rand(MOOD.moveTimeMinMs, MOOD.moveTimeMaxMs);
          this.eyeMoveStart = now;
          this.eyeInMotion = true;
        }
      }
    }

    // กะพริบตา (ทั้งสองข้างพร้อมกัน)
    if (now - this.timeOfLastBlink >= this.timeToNextBlink) {
      this.timeOfLastBlink = now;
      const d = rand(MOOD.blinkMinMs, MOOD.blinkMaxMs);
      for (const b of this.blink) if (b.state === 0) { b.state = 1; b.start = now; b.dur = d; }
      this.timeToNextBlink = rand(MOOD.blinkGapMinMs, MOOD.blinkGapMaxMs);
    }
    this.blink.forEach((b, i) => {
      let open = 1;
      if (b.state !== 0) {
        const p = clamp((now - b.start) / b.dur, 0, 1);
        open = b.state === 1 ? 1 - p : p;
        if (now - b.start >= b.dur) {
          if (b.state === 1) { b.state = 2; b.dur *= 2; b.start = now; }
          else b.state = 0;
        }
      }
      this.eyeOpen[i] = open;
    });

    // เปลือกตาบนเลื่อนตามการมองขึ้น-ลง (upperThreshold = (old*3 + sample)/4)
    const lookDown = (this.eyeY - 512) / 512;  // -1 มองบน ... 1 มองล่าง
    this.lidBias = (this.lidBias * 3 + lookDown) / 4;

    // ม่านตาขยาย-หด แบบสุ่ม (updateEye(): random(95,125) ทุก 10 วินาที)
    const ip = (now - this.iris.start) / MOOD.irisTransitionMs;
    if (ip >= 1) {
      this.iris.old = this.iris.target;
      this.iris.target = randInt(95, 125);
      this.iris.start = now;
    } else {
      const jitter = Math.sin(now / 370) * 2 + Math.sin(now / 910) * 1.5;
      this.iScale = this.iris.old + (this.iris.target - this.iris.old) * ip + jitter;
    }
  }
}

// ===== Jawduino (Arduino Nano + KA2284 + MG90S) =====
export class Jawduino {
  constructor() {
    this.JAW_CLOSED = 15;
    this.JAW_OPEN = 60;
    this.SMOOTH = 0.35;
    this.level = 0;            // จำนวน LED ที่ติด 0-3
    this.current = this.JAW_CLOSED;
    this.acc = 0;
    this.thresholds = [0.035, 0.09, 0.17]; // ระดับเสียง (RMS) ที่ทำให้ LED D2/D3/D4 ติด
  }
  setLevelFromRms(rms) {
    this.level = this.thresholds.reduce((n, t) => n + (rms > t ? 1 : 0), 0);
  }
  update(dtMs) {
    this.acc += dtMs;
    while (this.acc >= 18) {   // delay(18)
      this.acc -= 18;
      const target = this.JAW_CLOSED + (this.JAW_OPEN - this.JAW_CLOSED) * (this.level / 3);
      this.current += (target - this.current) * this.SMOOTH;
    }
  }
  get openness() { return (this.current - this.JAW_CLOSED) / (this.JAW_OPEN - this.JAW_CLOSED); }
}
