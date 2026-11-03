// DualEye Robot Head Controller - 2x GC9A01 + Servo Pan/Tilt (smooth motion)
// ESP32-S3 N16R8  — optimized
//
// บอร์ด: ESP32S3 Dev Module — คุยกับคอมผ่านพอร์ต USB (COM) เสมอ ไม่ว่า USB CDC On Boot จะตั้งค่าอะไร
//
// คำสั่งทาง Serial (115200, จบด้วย \n):
//   T,pan,tilt,eyeX,eyeY  ติดตามใบหน้า (ต้องส่งซ้ำภายใน 2.5 วิ)  pan 30-150, tilt 50-130, eye 0-1023
//   NOD | TILT | THINK    ท่าทาง
//   I                     กลับโหมด idle
//   STATUS                พิมพ์ตำแหน่งปัจจุบัน

#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <ESP32Servo.h>
#include <pgmspace.h>

#include "data/defaultEye.h"

// พอร์ต USB ของ ESP32-S3 (COM port บนคอม)
#if !CONFIG_IDF_TARGET_ESP32S3
#error "เลือกบอร์ด Tools > Board > esp32 > ESP32S3 Dev Module"
#elif ARDUINO_USB_CDC_ON_BOOT
#define PcSerial Serial
#elif ARDUINO_USB_MODE
HWCDC PcSerial;              // USB CDC On Boot = Disabled → ใช้ USB โดยตรง
#else
#error "ตั้งค่า Tools > USB Mode = Hardware CDC and JTAG"
#endif

namespace Pins
{
constexpr int8_t kDin = 11;
constexpr int8_t kSclk = 12;
constexpr int8_t kDc = 8;
constexpr int8_t kLeftCs = 10;
constexpr int8_t kRightCs = 14;
constexpr int8_t kLeftReset = -1;
constexpr int8_t kRightReset = -1;

constexpr int8_t kServoPan = 17;      // คอหันซ้าย-ขวา
constexpr int8_t kServoTilt = 18;     // คอก้ม-เงย
}

namespace DisplayConfig
{
constexpr uint16_t kPanelWidth = 240;
constexpr uint16_t kPanelHeight = 240;
constexpr uint16_t kEyeSize = 160;

// จอแนวตั้ง พินชี้ลงด้านล่างคอทั้งสองจอ
constexpr uint8_t kLeftRotation = 0;
constexpr uint8_t kRightRotation = 0;

// 20MHz ป้องกันเสียงกวน — ถ้าสายสั้นและภาพไม่เพี้ยน ลอง 40MHz จะได้เฟรมเรตเพิ่มเกือบเท่าตัว
constexpr uint32_t kSpiFrequency = 20000000;
constexpr uint16_t kPanelBackground = 0x0000;
}

// การเคลื่อนที่ของ Servo: จำกัดความเร็ว + ความเร่ง เพื่อไม่ให้กระชาก
namespace Motion
{
constexpr uint32_t kUpdateHz = 100;         // อัปเดตตำแหน่ง 100 ครั้ง/วินาที (task แยก ไม่ขึ้นกับการวาดตา)
constexpr float kMaxSpeed = 90.0f;          // องศา/วินาที
constexpr float kMaxAccel = 300.0f;         // องศา/วินาที²
constexpr float kApproachGain = 4.0f;       // ช่วงเข้าใกล้เป้า ชะลอแบบนุ่ม (1/วินาที)
constexpr float kTargetSmoothing = 0.12f;   // วินาที: กรองเป้าหมายที่สั่นจากการ track ใบหน้า
constexpr float kDeadband = 0.15f;          // องศา: ใกล้พอแล้วหยุด ลดอาการสั่นค้าง

constexpr float kPanMin = 30.0f, kPanMax = 150.0f;
constexpr float kTiltMin = 50.0f, kTiltMax = 130.0f;
constexpr float kCenter = 90.0f;

constexpr uint16_t kPulseMinUs = 500;
constexpr uint16_t kPulseMaxUs = 2400;
constexpr float kUsPerDeg = (kPulseMaxUs - kPulseMinUs) / 180.0f;
}

constexpr uint16_t kRenderWidth = DisplayConfig::kEyeSize;
constexpr uint16_t kRenderHeight = DisplayConfig::kEyeSize;
constexpr int16_t kRenderXOffset = (DisplayConfig::kPanelWidth - DisplayConfig::kEyeSize) / 2;
constexpr int16_t kRenderYOffset = (DisplayConfig::kPanelHeight - DisplayConfig::kEyeSize) / 2;

constexpr uint8_t NUM_EYES = 2;
constexpr uint32_t SERIAL_BAUD = 115200;
constexpr size_t LINES_PER_FLUSH = 8;                              // ส่ง SPI ครั้งละ 8 บรรทัด
constexpr size_t PIXEL_BUFFER_SIZE = kRenderWidth * LINES_PER_FLUSH;
constexpr uint32_t BLINK_MIN_US = 36000;
constexpr uint32_t BLINK_MAX_US = 72000;
constexpr uint32_t IRIS_TRANSITION_US = 10000000;
constexpr uint32_t PC_TIMEOUT_MS = 2500;
constexpr size_t RX_BUFFER_LEN = 64;

struct MoodPreset
{
  const char *name;
  uint8_t irisMinPercent;
  uint8_t irisMaxPercent;
  uint32_t blinkMinUs;
  uint32_t blinkMaxUs;
  uint32_t blinkGapMinUs;
  uint32_t blinkGapMaxUs;
  uint32_t movePauseMinUs;
  uint32_t movePauseMaxUs;
  uint32_t moveTimeMinUs;
  uint32_t moveTimeMaxUs;
  uint32_t irisTransitionUs;
  int16_t upperLidOffset;
  int16_t lowerLidOffset;
};

constexpr MoodPreset kActiveMood = {"natural", 30, 75, BLINK_MIN_US, BLINK_MAX_US, 2500000, 6000000, 1500000, 4500000, 180000, 320000, IRIS_TRANSITION_US, 0, 0};

enum BlinkState : uint8_t { NOBLINK = 0, ENBLINK = 1, DEBLINK = 2 };

struct EyeBlink
{
  BlinkState state;
  uint32_t duration;
  uint32_t startTime;
};

struct EyeState
{
  Arduino_GC9A01 *panel;
  EyeBlink blink;
  int16_t xposition;
};

// ต้องประกาศก่อนฟังก์ชันแรก เพราะ Arduino IDE สร้าง prototype ไว้ตรงนั้น
struct Axis
{
  Servo *servo;
  float minDeg;
  float maxDeg;
  float filteredTarget;
  float pos;
  float vel;
  int lastPulse;
};

Arduino_DataBus* sharedBus = nullptr;
Arduino_GC9A01* leftPanel = nullptr;
Arduino_GC9A01* rightPanel = nullptr;
bool displaysOk = false;

EyeState eyes[NUM_EYES] = {
    {nullptr, {NOBLINK, 0, 0}, kRenderXOffset},
    {nullptr, {NOBLINK, 0, 0}, kRenderXOffset},
};

// ตารางภาพตา: ใช้ pointer ตรง (บน ESP32 PROGMEM อ่านได้เหมือนหน่วยความจำปกติ)
// reinterpret_cast ใช้ได้ทั้งกรณี defaultEye.h ประกาศเป็น array 1 มิติหรือ 2 มิติ
static const uint16_t *const kSclera = reinterpret_cast<const uint16_t *>(sclera);
static const uint16_t *const kIris   = reinterpret_cast<const uint16_t *>(iris);
static const uint16_t *const kPolar  = reinterpret_cast<const uint16_t *>(polar);
static const uint8_t  *const kUpper  = reinterpret_cast<const uint8_t *>(upper);
static const uint8_t  *const kLower  = reinterpret_cast<const uint8_t *>(lower);

// Lookup table สำหรับขยายภาพ SCREEN_WIDTH x SCREEN_HEIGHT → kRenderWidth x kRenderHeight
// (เดิมคำนวณหารทุกพิกเซล ตอนนี้คำนวณครั้งเดียวตอน setup)
uint16_t srcXLut[kRenderWidth];
uint16_t srcYLut[kRenderHeight];

uint16_t srcLine[SCREEN_WIDTH];           // บรรทัดต้นฉบับที่คำนวณแล้ว
uint16_t pixelBuffer[PIXEL_BUFFER_SIZE];  // บรรทัดที่ขยายแล้ว รอส่ง SPI

uint16_t oldIris = 110;
uint16_t newIris = 110;
uint32_t timeOfLastBlink = 0;
uint32_t timeToNextBlink = 0;

Servo servoPan;
Servo servoTilt;

// ค่าที่แชร์ระหว่าง loop (รับคำสั่ง, core 1) กับ servoTask (core 0)
volatile bool pcTrackingMode = false;
volatile uint32_t lastPcMessageTime = 0;
volatile float targetPan = Motion::kCenter;
volatile float targetTilt = Motion::kCenter;
volatile float currentPan = Motion::kCenter;
volatile float currentTilt = Motion::kCenter;
volatile int16_t pcEyeX = 512;
volatile int16_t pcEyeY = 512;

// แอนิเมชันภาษากาย (ผงกหัว / เอียงคอฟัง / นึกคิด) — 0 = ไม่ทำงาน
volatile uint32_t nodStartTime = 0;
volatile uint32_t tiltStartTime = 0;
volatile uint32_t thinkStartTime = 0;
constexpr uint32_t NOD_MS = 900;
constexpr uint32_t TILT_MS = 1600;
constexpr uint32_t THINK_MS = 2000;

const uint8_t ease[] PROGMEM = {
    0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 3,
    3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 7, 8, 9, 9, 10, 10,
    11, 12, 12, 13, 14, 15, 15, 16, 17, 18, 18, 19, 20, 21, 22, 23,
    24, 25, 26, 27, 27, 28, 29, 30, 31, 33, 34, 35, 36, 37, 38, 39,
    40, 41, 42, 44, 45, 46, 47, 48, 50, 51, 52, 53, 54, 56, 57, 58,
    60, 61, 62, 63, 65, 66, 67, 69, 70, 72, 73, 74, 76, 77, 78, 80,
    81, 83, 84, 85, 87, 88, 90, 91, 93, 94, 96, 97, 98, 100, 101, 103,
    104, 106, 107, 109, 110, 112, 113, 115, 116, 118, 119, 121, 122, 124, 125, 127,
    128, 130, 131, 133, 134, 136, 137, 139, 140, 142, 143, 145, 146, 148, 149, 151,
    152, 154, 155, 157, 158, 159, 161, 162, 164, 165, 167, 168, 170, 171, 172, 174,
    175, 177, 178, 179, 181, 182, 183, 185, 186, 188, 189, 190, 192, 193, 194, 195,
    197, 198, 199, 201, 202, 203, 204, 205, 207, 208, 209, 210, 211, 213, 214, 215,
    216, 217, 218, 219, 220, 221, 222, 224, 225, 226, 227, 228, 228, 229, 230, 231,
    232, 233, 234, 235, 236, 237, 237, 238, 239, 240, 240, 241, 242, 243, 243, 244,
    245, 245, 246, 246, 247, 248, 248, 249, 249, 250, 250, 251, 251, 251, 252, 252,
    252, 253, 253, 253, 254, 254, 254, 254, 254, 255, 255, 255, 255, 255, 255, 255};

static inline uint8_t clampThreshold(int16_t value)
{
  if (value < 0) return 0;
  if (value > 254) return 254;
  return static_cast<uint8_t>(value);
}

// ==================== SERVO (smooth motion) ====================
Axis panAxis = {&servoPan, Motion::kPanMin, Motion::kPanMax, Motion::kCenter, Motion::kCenter, 0, -1};
Axis tiltAxis = {&servoTilt, Motion::kTiltMin, Motion::kTiltMax, Motion::kCenter, Motion::kCenter, 0, -1};

// โปรไฟล์ความเร็วแบบ "เร่งนุ่ม-เบรกนุ่ม": ความเร็วที่ต้องการถูกจำกัดด้วย
//  - ความเร็วสูงสุด, - ระยะเบรกที่ความเร่งสูงสุดยังหยุดทัน (ไม่ overshoot), - การชะลอตามระยะใกล้เป้า
// แล้วความเร็วจริงค่อย ๆ ไล่ตามด้วยความเร่งไม่เกิน kMaxAccel
void stepAxis(Axis &a, float target, float dt)
{
  constexpr float kBrakeK = 2.0f * Motion::kMaxAccel * 0.8f;
  const float alpha = dt / (Motion::kTargetSmoothing + dt);
  const float maxDv = Motion::kMaxAccel * dt;

  target = constrain(target, a.minDeg, a.maxDeg);
  a.filteredTarget += (target - a.filteredTarget) * alpha;

  const float err = a.filteredTarget - a.pos;
  const float dist = fabsf(err);
  float desiredVel = 0.0f;
  if (dist > Motion::kDeadband || fabsf(a.vel) > 1.0f) {
    const float vBrake = sqrtf(kBrakeK * dist);
    const float vApproach = Motion::kApproachGain * dist;
    desiredVel = copysignf(fminf(Motion::kMaxSpeed, fminf(vBrake, vApproach)), err);
  }

  a.vel += constrain(desiredVel - a.vel, -maxDv, maxDv);
  a.pos = constrain(a.pos + a.vel * dt, a.minDeg, a.maxDeg);

  const int pulse = lroundf(Motion::kPulseMinUs + a.pos * Motion::kUsPerDeg);
  if (pulse != a.lastPulse) {
    a.servo->writeMicroseconds(pulse);
    a.lastPulse = pulse;
  }
}

// เส้นโค้งขึ้น-ลงนุ่ม ๆ 0 → 1 → 0 ภายในช่วงเวลา
static inline float bump(uint32_t elapsed, uint32_t duration)
{
  const float s = sinf(PI * static_cast<float>(elapsed) / duration);
  return s * s;
}

void servoTask(void *)
{
  const TickType_t period = pdMS_TO_TICKS(1000 / Motion::kUpdateHz);
  const float dt = 1.0f / Motion::kUpdateHz;
  TickType_t lastWake = xTaskGetTickCount();
  uint32_t lastIdleHeadMove = 0;

  for (;;) {
    const uint32_t nowMs = millis();

    if (pcTrackingMode && (nowMs - lastPcMessageTime > PC_TIMEOUT_MS)) {
      pcTrackingMode = false;
      targetPan = Motion::kCenter;
      targetTilt = Motion::kCenter;
    }

    // โหมด idle: ขยับคอเล็กน้อยแบบสุ่มเหมือนมีชีวิต
    if (!pcTrackingMode && nowMs - lastIdleHeadMove > 4000) {
      lastIdleHeadMove = nowMs;
      targetPan = Motion::kCenter + random(-10, 11);
      targetTilt = Motion::kCenter + random(-5, 6);
    }

    float panGoal = targetPan;
    float tiltGoal = targetTilt;

    // อ่านค่า volatile ครั้งเดียวต่อรอบ กันค่าเปลี่ยนกลางคัน
    const uint32_t nodT0 = nodStartTime;
    if (nodT0) {
      const uint32_t t = nowMs - nodT0;
      if (t < NOD_MS) {
        // ก้มลง 12° แล้วเงยกลับเลยนิดหน่อย 4°
        const float phase = static_cast<float>(t) / NOD_MS;
        tiltGoal += (phase < 0.5f ? 12.0f : 4.0f) * sinf(2.0f * PI * phase);
      } else {
        nodStartTime = 0;
      }
    }
    const uint32_t tiltT0 = tiltStartTime;
    if (tiltT0) {
      const uint32_t t = nowMs - tiltT0;
      if (t < TILT_MS) {
        const float k = bump(t, TILT_MS);
        panGoal += 6.0f * k;
        tiltGoal += 4.0f * k;
      } else {
        tiltStartTime = 0;
      }
    }
    const uint32_t thinkT0 = thinkStartTime;
    if (thinkT0) {
      const uint32_t t = nowMs - thinkT0;
      if (t < THINK_MS) {
        const float k = bump(t, THINK_MS);
        panGoal -= 5.0f * k;
        tiltGoal -= 4.0f * k;  // เงยหน้าขึ้นเล็กน้อย
      } else {
        thinkStartTime = 0;
      }
    }

    stepAxis(panAxis, panGoal, dt);
    stepAxis(tiltAxis, tiltGoal, dt);
    currentPan = panAxis.pos;
    currentTilt = tiltAxis.pos;

    vTaskDelayUntil(&lastWake, period);
  }
}

// ==================== DISPLAYS ====================
static inline void selectPanel(uint8_t eyeIndex)
{
  // ปลด CS ตัวหนึ่งก่อนเลือกอีกตัวเสมอ ไม่ให้ทั้งสองจอ active พร้อมกัน
  if (eyeIndex == 0) {
    digitalWrite(Pins::kRightCs, HIGH);
    digitalWrite(Pins::kLeftCs, LOW);
  } else {
    digitalWrite(Pins::kLeftCs, HIGH);
    digitalWrite(Pins::kRightCs, LOW);
  }
}

static inline void deselectPanels()
{
  digitalWrite(Pins::kLeftCs, HIGH);
  digitalWrite(Pins::kRightCs, HIGH);
}

void buildScaleLuts()
{
  for (uint16_t x = 0; x < kRenderWidth; ++x) srcXLut[x] = (static_cast<uint32_t>(x) * SCREEN_WIDTH) / kRenderWidth;
  for (uint16_t y = 0; y < kRenderHeight; ++y) srcYLut[y] = (static_cast<uint32_t>(y) * SCREEN_HEIGHT) / kRenderHeight;
}

bool beginPanels()
{
  pinMode(Pins::kLeftCs, OUTPUT);
  pinMode(Pins::kRightCs, OUTPUT);
  deselectPanels();

  sharedBus = new Arduino_ESP32SPI(Pins::kDc, GFX_NOT_DEFINED, Pins::kSclk, Pins::kDin);
  if (!sharedBus) return false;

  leftPanel = new Arduino_GC9A01(sharedBus, Pins::kLeftReset, DisplayConfig::kLeftRotation, true /* IPS */);
  rightPanel = new Arduino_GC9A01(sharedBus, Pins::kRightReset, DisplayConfig::kRightRotation, true /* IPS */);
  if (!leftPanel || !rightPanel) return false;

  Arduino_GC9A01 *panels[NUM_EYES] = {leftPanel, rightPanel};
  for (uint8_t e = 0; e < NUM_EYES; ++e) {
    selectPanel(e);
    if (!panels[e]->begin(DisplayConfig::kSpiFrequency)) {
      deselectPanels();
      return false;
    }
    panels[e]->fillScreen(DisplayConfig::kPanelBackground);
    deselectPanels();
    delay(100);
    eyes[e].panel = panels[e];
  }
  return true;
}

// คำนวณพิกเซลหนึ่งบรรทัดของภาพต้นฉบับ (SCREEN_WIDTH จุด) ลงใน srcLine
// บรรทัดที่ขยายซ้ำ (160/128) จะไม่ถูกคำนวณใหม่ → คำนวณแค่ SCREEN_WIDTH x SCREEN_HEIGHT จุดต่อเฟรม
static void IRAM_ATTR renderSourceLine(
    uint16_t sy, bool mirrorLid, uint32_t iScale,
    uint32_t scleraX, uint32_t scleraY,
    int32_t irisXStart, int32_t irisYStart,
    int32_t irisColStart, int32_t irisColEnd,
    uint8_t upperThreshold, uint8_t lowerThreshold)
{
  const uint16_t *scleraRow = kSclera + (scleraY + sy) * SCLERA_WIDTH + scleraX;
  const uint8_t *upperRow = kUpper + sy * SCREEN_WIDTH;
  const uint8_t *lowerRow = kLower + sy * SCREEN_WIDTH;

  const int32_t iy = irisYStart + static_cast<int32_t>(sy);
  const bool rowHasIris = (iy >= 0) && (iy < IRIS_HEIGHT) && (irisColStart < irisColEnd);
  const int32_t polarRowBase = iy * IRIS_WIDTH + irisXStart;   // ใช้เฉพาะเมื่อ rowHasIris

  for (int32_t sx = 0; sx < SCREEN_WIDTH; ++sx) {
    const int32_t lidX = mirrorLid ? (SCREEN_WIDTH - 1 - sx) : sx;
    uint16_t pixel;

    if (lowerRow[lidX] <= lowerThreshold || upperRow[lidX] <= upperThreshold) {
      pixel = 0x0000;  // เปลือกตาปิด
    } else if (rowHasIris && sx >= irisColStart && sx < irisColEnd) {
      const uint16_t polarValue = kPolar[polarRowBase + sx];
      const uint32_t distance = (iScale * (polarValue & 0x7F)) >> 7;
      if (distance < IRIS_MAP_HEIGHT) {
        const uint32_t angle = (static_cast<uint32_t>(IRIS_MAP_WIDTH) * (polarValue >> 7)) >> 9;
        pixel = kIris[distance * IRIS_MAP_WIDTH + angle];
      } else {
        pixel = scleraRow[sx];
      }
    } else {
      pixel = scleraRow[sx];
    }
    srcLine[sx] = pixel;
  }
}

// scleraX/scleraY ถูก clamp ใน frame() แล้ว จึงไม่ต้องเช็กขอบทุกพิกเซลเหมือนเดิม
void drawEye(uint8_t eyeIndex, uint32_t iScale, uint32_t scleraX, uint32_t scleraY,
             uint8_t upperThreshold, uint8_t lowerThreshold)
{
  Arduino_GC9A01 *panel = eyes[eyeIndex].panel;
  if (!panel) return;

  const int32_t irisXStart = static_cast<int32_t>(scleraX) - ((SCLERA_WIDTH - IRIS_WIDTH) / 2);
  const int32_t irisYStart = static_cast<int32_t>(scleraY) - ((SCLERA_HEIGHT - IRIS_HEIGHT) / 2);
  // ช่วงคอลัมน์ที่ตกในม่านตา คำนวณครั้งเดียวต่อเฟรม แทนการเช็กทุกพิกเซล
  const int32_t irisColStart = max<int32_t>(0, -irisXStart);
  const int32_t irisColEnd = min<int32_t>(SCREEN_WIDTH, IRIS_WIDTH - irisXStart);
  const bool mirrorLid = (eyeIndex == 0);

  selectPanel(eyeIndex);
  panel->startWrite();
  panel->writeAddrWindow(kRenderXOffset, kRenderYOffset, kRenderWidth, kRenderHeight);

  int32_t lastSy = -1;
  size_t pixels = 0;

  for (uint16_t y = 0; y < kRenderHeight; ++y) {
    const uint16_t sy = srcYLut[y];
    if (sy != lastSy) {
      renderSourceLine(sy, mirrorLid, iScale, scleraX, scleraY,
                       irisXStart, irisYStart, irisColStart, irisColEnd,
                       upperThreshold, lowerThreshold);
      lastSy = sy;
    }

    // ขยายแนวนอนด้วย LUT
    uint16_t *dst = pixelBuffer + pixels;
    for (uint16_t x = 0; x < kRenderWidth; ++x) {
      dst[x] = srcLine[srcXLut[x]];
    }
    pixels += kRenderWidth;

    if (pixels >= PIXEL_BUFFER_SIZE) {
      panel->writePixels(pixelBuffer, pixels);
      pixels = 0;
    }
  }

  if (pixels != 0) {
    panel->writePixels(pixelBuffer, pixels);
  }

  panel->endWrite();
  deselectPanels();
}

// ==================== SERIAL COMMANDS ====================
// ใช้ char buffer แทน String → ไม่มี malloc/free ทุกตัวอักษร ไม่เกิด heap fragmentation
void handleCommand(const char *cmd)
{
  if (cmd[0] == 'T' && cmd[1] == ',') {
    float pan, tilt;
    int ex, ey;
    if (sscanf(cmd + 2, "%f,%f,%d,%d", &pan, &tilt, &ex, &ey) == 4) {
      targetPan = pan;    // stepAxis จะ clamp ตามช่วงของแกนเอง
      targetTilt = tilt;
      pcEyeX = constrain(ex, 0, 1023);
      pcEyeY = constrain(ey, 0, 1023);
      // อัปเดตเวลาก่อนเปิดโหมด ไม่ให้ servoTask (อีก core) เห็น tracking=true คู่กับเวลาเก่าแล้วรีเซ็ตกลางทันที
      lastPcMessageTime = millis();
      pcTrackingMode = true;
    }
  } else if (strcmp(cmd, "NOD") == 0) {
    nodStartTime = millis() | 1;
  } else if (strcmp(cmd, "TILT") == 0) {
    tiltStartTime = millis() | 1;
  } else if (strcmp(cmd, "THINK") == 0) {
    thinkStartTime = millis() | 1;
  } else if (strcmp(cmd, "STATUS") == 0) {
    PcSerial.printf("STATUS pan=%.1f tilt=%.1f target=%.1f,%.1f tracking=%d displays=%d servo=%d,%d us=%d,%d\n",
                    (float)currentPan, (float)currentTilt, (float)targetPan, (float)targetTilt,
                    pcTrackingMode ? 1 : 0, displaysOk ? 1 : 0,
                    servoPan.attached() ? 1 : 0, servoTilt.attached() ? 1 : 0,
                    panAxis.lastPulse, tiltAxis.lastPulse);
  } else if (cmd[0] == 'I') {
    pcTrackingMode = false;
    targetPan = Motion::kCenter;
    targetTilt = Motion::kCenter;
  }
}

void checkSerialCommand()
{
  static char rxBuffer[RX_BUFFER_LEN];
  static size_t rxLen = 0;
  static bool overflow = false;

  int c;
  while ((c = PcSerial.read()) >= 0) {
    if (c == '\n') {
      if (!overflow) {
        // ตัดช่องว่างท้าย
        while (rxLen > 0 && (rxBuffer[rxLen - 1] == ' ' || rxBuffer[rxLen - 1] == '\t')) --rxLen;
        rxBuffer[rxLen] = '\0';
        // ตัดช่องว่างหน้า
        const char *start = rxBuffer;
        while (*start == ' ' || *start == '\t') ++start;
        if (*start) handleCommand(start);
      }
      rxLen = 0;
      overflow = false;
    } else if (c != '\r') {
      if (rxLen < RX_BUFFER_LEN - 1) rxBuffer[rxLen++] = static_cast<char>(c);
      else overflow = true;   // บรรทัดยาวเกิน ทิ้งทั้งบรรทัด
    }
  }
}

// ==================== EYES ====================
void frame(uint16_t iScale)
{
  static uint8_t eyeIndex = NUM_EYES - 1;
  static bool eyeInMotion = false;
  static int16_t eyeOldX = 512, eyeOldY = 512;
  static int16_t eyeNewX = 512, eyeNewY = 512;
  static uint32_t eyeMoveStartTime = 0;
  static int32_t eyeMoveDuration = 0;
  static uint8_t upperThreshold = 128;

  int16_t eyeX, eyeY;
  const uint32_t now = micros();

  checkSerialCommand();

  if (++eyeIndex >= NUM_EYES) {
    eyeIndex = 0;
  }

  if (thinkStartTime) {
    eyeX = 512;
    eyeY = 250; // เหลือบตามองบนนึกคิด
  } else if (pcTrackingMode) {
    eyeX = pcEyeX;
    eyeY = pcEyeY;
  } else {
    const int32_t dt = static_cast<int32_t>(now - eyeMoveStartTime);
    if (eyeInMotion) {
      if (dt >= eyeMoveDuration) {
        eyeInMotion = false;
        eyeMoveDuration = random(kActiveMood.movePauseMinUs, kActiveMood.movePauseMaxUs);
        eyeMoveStartTime = now;
        eyeX = eyeOldX = eyeNewX;
        eyeY = eyeOldY = eyeNewY;
      } else {
        int32_t easeIndex = (255 * dt) / eyeMoveDuration;
        easeIndex = constrain(easeIndex, 0, 255);
        const int16_t e = ease[easeIndex] + 1;
        eyeX = eyeOldX + (((eyeNewX - eyeOldX) * e) >> 8);
        eyeY = eyeOldY + (((eyeNewY - eyeOldY) * e) >> 8);
      }
    } else {
      eyeX = eyeOldX;
      eyeY = eyeOldY;
      if (dt > eyeMoveDuration) {
        int32_t dx, dy;
        do {
          eyeNewX = random(1024);
          eyeNewY = random(1024);
          dx = (eyeNewX * 2) - 1023;
          dy = (eyeNewY * 2) - 1023;
        } while (static_cast<uint32_t>(dx * dx + dy * dy) > (1023UL * 1023UL));
        eyeMoveDuration = random(kActiveMood.moveTimeMinUs, kActiveMood.moveTimeMaxUs);
        eyeMoveStartTime = now;
        eyeInMotion = true;
      }
    }
  }

  // กะพริบตา: เริ่มพร้อมกันทั้งสองตา
  if ((now - timeOfLastBlink) >= timeToNextBlink) {
    timeOfLastBlink = now;
    const uint32_t blinkDuration = random(kActiveMood.blinkMinUs, kActiveMood.blinkMaxUs);
    for (uint8_t e = 0; e < NUM_EYES; ++e) {
      if (eyes[e].blink.state == NOBLINK) {
        eyes[e].blink.state = ENBLINK;
        eyes[e].blink.startTime = now;
        eyes[e].blink.duration = blinkDuration;
      }
    }
    timeToNextBlink = random(kActiveMood.blinkGapMinUs, kActiveMood.blinkGapMaxUs);
  }

  EyeBlink &blink = eyes[eyeIndex].blink;
  if (blink.state != NOBLINK && (now - blink.startTime) >= blink.duration) {
    if (blink.state == ENBLINK) {
      blink.state = DEBLINK;
      blink.duration *= 2;
      blink.startTime = now;
    } else {
      blink.state = NOBLINK;
    }
  }

  eyeX = map(eyeX, 0, 1023, 0, SCLERA_WIDTH - SCREEN_WIDTH);
  eyeY = map(eyeY, 0, 1023, 0, SCLERA_HEIGHT - SCREEN_HEIGHT);
  eyeX = constrain(eyeX, 0, SCLERA_WIDTH - SCREEN_WIDTH);
  eyeY = constrain(eyeY, 0, SCLERA_HEIGHT - SCREEN_HEIGHT);

  // เปลือกตาบนเลื่อนตามตำแหน่งตาดำ
  const int16_t sampleX = (SCLERA_WIDTH / 2) - (eyeX / 2);
  const int16_t sampleY = (SCLERA_HEIGHT / 2) - (eyeY + (IRIS_HEIGHT / 4));
  const uint8_t eyelidSample = (sampleY < 0) ? 0 :
      (kUpper[sampleY * SCREEN_WIDTH + sampleX] +
       kUpper[sampleY * SCREEN_WIDTH + (SCREEN_WIDTH - 1 - sampleX)]) / 2;
  upperThreshold = (upperThreshold * 3 + eyelidSample) / 4;
  uint8_t currentUpperThreshold = clampThreshold(static_cast<int16_t>(upperThreshold) + kActiveMood.upperLidOffset);
  uint8_t lowerThreshold = clampThreshold(static_cast<int16_t>(254 - upperThreshold) + kActiveMood.lowerLidOffset);

  if (blink.state != NOBLINK) {
    uint32_t blinkProgress = now - blink.startTime;
    blinkProgress = (blinkProgress >= blink.duration) ? 255 : (255 * blinkProgress) / blink.duration;
    blinkProgress = (blink.state == DEBLINK) ? (1 + blinkProgress) : (256 - blinkProgress);
    currentUpperThreshold = (currentUpperThreshold * blinkProgress + 254 * (257 - blinkProgress)) >> 8;
    lowerThreshold = (lowerThreshold * blinkProgress + 254 * (257 - blinkProgress)) >> 8;
  }

  drawEye(eyeIndex, iScale, eyeX, eyeY, currentUpperThreshold, lowerThreshold);
}

void split(int16_t startValue, int16_t endValue, uint32_t startTime, int32_t duration, int16_t range)
{
  if (range >= 8) {
    range /= 2; duration /= 2;
    const int16_t midValue = (startValue + endValue - range) / 2 + random(range);
    split(startValue, midValue, startTime, duration, range);
    split(midValue, endValue, startTime + duration, duration, range);
  } else {
    int32_t dt;
    while ((dt = static_cast<int32_t>(micros() - startTime)) < duration) {
      const int16_t value = startValue + (((endValue - startValue) * dt) / duration);
      frame(value);
    }
  }
}

void updateEye()
{
  newIris = random(95, 125);
  split(oldIris, newIris, micros(), kActiveMood.irisTransitionUs, 30);
  oldIris = newIris;
}

void setup()
{
  PcSerial.begin(SERIAL_BAUD);
  PcSerial.setTxTimeoutMs(0);  // ไม่ค้างถ้าไม่มีคอมเปิดพอร์ตอ่าน
  delay(500);

  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  servoPan.setPeriodHertz(50);
  servoTilt.setPeriodHertz(50);
  servoPan.attach(Pins::kServoPan, Motion::kPulseMinUs, Motion::kPulseMaxUs);
  servoTilt.attach(Pins::kServoTilt, Motion::kPulseMinUs, Motion::kPulseMaxUs);

  randomSeed(esp_random());   // seed จาก hardware RNG แทน micros() ที่ค่าใกล้เดิมทุกครั้งที่บูต
  xTaskCreatePinnedToCore(servoTask, "servo", 4096, nullptr, 2, nullptr, 0);

  buildScaleLuts();

  displaysOk = beginPanels();
  PcSerial.println(displaysOk ? "READY displays=ok" : "READY displays=FAIL (servo ยังทำงาน)");

  timeOfLastBlink = micros();
  timeToNextBlink = random(kActiveMood.blinkGapMinUs, kActiveMood.blinkGapMaxUs);
}

void loop()
{
  if (displaysOk) {
    updateEye();
  } else {
    // จอเสียก็ยังรับคำสั่งและขยับคอได้
    checkSerialCommand();
    delay(5);
  }
}
