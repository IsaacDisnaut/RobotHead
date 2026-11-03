# ทดสอบการขยับหัวหุ่นผ่าน Serial (ESP32-S3)
# ใช้: py test_move.py [COMx]
# ถ้า COM port ถูกโปรแกรมจำลอง (robot_sim_server.py) เปิดอยู่ จะส่งผ่าน /api/serial/send แทน
import json
import sys
import time
import urllib.request

import serial

PORT = sys.argv[1] if len(sys.argv) > 1 else "COM12"
BAUD = 115200
SIM_URL = "http://127.0.0.1:8765/api/serial/send"


def open_link():
    try:
        ser = serial.Serial()
        ser.port = PORT
        ser.baudrate = BAUD
        ser.dtr = False  # กันบอร์ดรีเซ็ตตอนเปิดพอร์ต
        ser.rts = False
        ser.open()
        time.sleep(2)
        print(f"[✓] เปิด {PORT} ตรง")
        return lambda line: ser.write((line + "\n").encode()), ser.close
    except serial.SerialException:
        print(f"[i] {PORT} ไม่ว่าง → ส่งผ่านโปรแกรมจำลอง {SIM_URL}")

        def send_http(line):
            req = urllib.request.Request(
                SIM_URL,
                data=json.dumps({"lines": [line]}).encode(),
                headers={"Content-Type": "application/json"},
            )
            if not json.load(urllib.request.urlopen(req, timeout=2)).get("ok"):
                raise RuntimeError("โปรแกรมจำลองยังไม่ได้เชื่อมต่อหุ่นจริง")

        return send_http, lambda: None


def hold(write, pan, tilt, eye_x=512, eye_y=512, seconds=1.5):
    # ต้องส่ง T ซ้ำทุก < 2.5 วิ ไม่งั้นบอร์ดกลับไปโหมด idle
    print(f">> T pan={pan} tilt={tilt} eye=({eye_x},{eye_y})")
    end = time.time() + seconds
    while time.time() < end:
        write(f"T,{pan},{tilt},{eye_x},{eye_y}")
        time.sleep(0.1)


def gesture(write, cmd, seconds=1.5):
    print(">>", cmd)
    write(cmd)
    time.sleep(seconds)


def main():
    write, close = open_link()
    try:
        print("1) ตรงกลาง")
        hold(write, 90, 90)
        print("2) หันซ้าย / ขวา")
        hold(write, 70, 90, eye_x=200)
        hold(write, 110, 90, eye_x=820)
        hold(write, 90, 90)
        print("3) ก้ม / เงย")
        hold(write, 90, 80, eye_y=300)
        hold(write, 90, 100, eye_y=720)
        hold(write, 90, 90)
        print("4) ท่าทาง")
        gesture(write, "NOD")
        gesture(write, "TILT")
        gesture(write, "THINK")
    finally:
        write("I")  # กลับโหมด idle
        close()
    print("เสร็จ")


if __name__ == "__main__":
    main()
