/*
 * Jawduino - ขากรรไกรหุ่นน้องมะลิ
 * Target: Arduino Nano + MG90S Servo (+ KA2284 ถ้ามี)
 *
 * รับระดับการอ้าปากได้ 2 ทาง:
 *  1) จากคอมผ่านสาย USB (หลัก): ส่งบรรทัด "J<0-100>\n" เช่น J0 = หุบ, J100 = อ้าสุด
 *     (robot_brain.py / โปรแกรมจำลองคำนวณจากเสียงพูดแล้วส่งมาให้เอง ไม่ต้องเดินสายเสียง)
 *  2) จากไฟ LED บนโมดูล KA2284 (สำรอง): ใช้เมื่อไม่มีคำสั่งจากคอมเกิน SERIAL_TIMEOUT_MS
 *     ถ้าไม่ได้ต่อ KA2284 ก็ไม่เป็นไร ขาจะถูกดึงขึ้น (INPUT_PULLUP) = ไฟดับ = หุบปาก
 *
 * คำสั่งอื่น:
 *  DEBUG     เปิด/ปิดการพิมพ์ค่าอนาล็อก KA2284 (ไว้ปรับ THRESHOLD)
 *  PING      ตอบกลับ "JAW OK"
 */

#include <Servo.h>

// ========== PIN CONFIGURATION ==========
const int PIN_LED_LOW  = A0;  // รับสัญญาณจาก LED D2 (เสียงเบา)
const int PIN_LED_MID  = A1;  // รับสัญญาณจาก LED D3 (เสียงกลาง)
const int PIN_LED_HIGH = A2;  // รับสัญญาณจาก LED D4 (เสียงดัง)
const int PIN_SERVO    = 9;   // ขาขับเซอร์โวขากรรไกร (D9)

// ========== JAW CALIBRATION (ปรับองศาตามกลไกปาก) ==========
const int JAW_CLOSED = 15;    // องศาขณะ "หุบปากสนิท"
const int JAW_OPEN   = 60;    // องศาขณะ "อ้าปากกว้างสุด" (ไม่ควรเกิน 70 เพื่อถนอมเฟือง)

// ค่าแอนะล็อก < THRESHOLD = ไฟ LED บน KA2284 ติด (ดูค่าจริงด้วยคำสั่ง DEBUG)
const int THRESHOLD = 350;
// LED ต้องติดต่อเนื่องกี่รอบ (รอบละ ~18ms) ถึงนับ กันเสียงคลิก/เสียงรบกวนสั้นๆ
const int LED_CONFIRM_LOOPS = 2;

// ค่าความนุ่มนวล (0.1 = ช้ามาก, 0.4 = เป็นธรรมชาติ, 1.0 = ทันที)
// คำสั่งจากคอมแม่นกว่า KA2284 จึงใช้ค่าที่ไวกว่าได้
const float SMOOTH_SERIAL = 0.55;
const float SMOOTH_LED    = 0.35;

// ไม่ได้รับคำสั่ง J จากคอมนานเกินนี้ -> กลับไปใช้ KA2284 (และหุบปากถ้าไม่มีเสียง)
const unsigned long SERIAL_TIMEOUT_MS = 400;

Servo jawServo;

float currentAngle = JAW_CLOSED;
int lastWritten = -1;
int serialTarget = JAW_CLOSED;
unsigned long lastSerialMs = 0;
bool hasSerial = false;
bool debugMode = false;
int ledRun[3] = {0, 0, 0};

char lineBuf[16];
byte lineLen = 0;

void handleLine(const char *line)
{
  if (line[0] == 'J' || line[0] == 'j')
  {
    int pct = constrain(atoi(line + 1), 0, 100);
    serialTarget = map(pct, 0, 100, JAW_CLOSED, JAW_OPEN);
    lastSerialMs = millis();
    hasSerial = true;
  }
  else if (strcmp(line, "DEBUG") == 0)
  {
    debugMode = !debugMode;
    Serial.println(debugMode ? F("DEBUG ON") : F("DEBUG OFF"));
  }
  else if (strcmp(line, "PING") == 0)
  {
    Serial.println(F("JAW OK"));
  }
}

void readSerial()
{
  while (Serial.available())
  {
    char c = Serial.read();
    if (c == '\n' || c == '\r')
    {
      if (lineLen)
      {
        lineBuf[lineLen] = '\0';
        handleLine(lineBuf);
        lineLen = 0;
      }
    }
    else if (lineLen < sizeof(lineBuf) - 1)
    {
      lineBuf[lineLen++] = c;
    }
  }
}

int ledTarget()
{
  const int pins[3] = {PIN_LED_LOW, PIN_LED_MID, PIN_LED_HIGH};
  int vals[3];
  int soundLevel = 0;
  for (int i = 0; i < 3; i++)
  {
    vals[i] = analogRead(pins[i]);
    ledRun[i] = vals[i] < THRESHOLD ? ledRun[i] + 1 : 0;
    if (ledRun[i] >= LED_CONFIRM_LOOPS) soundLevel++;
  }
  if (debugMode)
  {
    static unsigned long lastPrint = 0;
    if (millis() - lastPrint > 200)
    {
      lastPrint = millis();
      Serial.print(F("A0=")); Serial.print(vals[0]);
      Serial.print(F(" A1=")); Serial.print(vals[1]);
      Serial.print(F(" A2=")); Serial.print(vals[2]);
      Serial.print(F(" level=")); Serial.println(soundLevel);
    }
  }
  // 0 ดวง = หุบ, 1 = ~33%, 2 = ~66%, 3 = อ้าสุด
  return map(soundLevel, 0, 3, JAW_CLOSED, JAW_OPEN);
}

void setup()
{
  Serial.begin(115200);

  // ดึงขาขึ้นไว้ ถ้าไม่ได้ต่อ KA2284 หรือไฟดับ ค่าจะไม่ลอยไปมา
  pinMode(PIN_LED_LOW, INPUT_PULLUP);
  pinMode(PIN_LED_MID, INPUT_PULLUP);
  pinMode(PIN_LED_HIGH, INPUT_PULLUP);

  jawServo.attach(PIN_SERVO);
  jawServo.write(JAW_CLOSED);
  delay(500);

  Serial.println(F("JAW OK"));
}

void loop()
{
  readSerial();

  bool fromSerial = hasSerial && millis() - lastSerialMs < SERIAL_TIMEOUT_MS;
  int targetAngle = fromSerial ? serialTarget : ledTarget();
  float smooth = fromSerial ? SMOOTH_SERIAL : SMOOTH_LED;

  currentAngle += (targetAngle - currentAngle) * smooth;
  int angle = (int)round(currentAngle);
  // สั่งเซอร์โวเฉพาะตอนมุมเปลี่ยน ลดเสียงหึ่ง/อาการสั่นของ MG90S
  if (angle != lastWritten)
  {
    jawServo.write(angle);
    lastWritten = angle;
  }

  delay(18);
}
