@echo off
chcp 65001 >nul
title Nong Mali Robot Simulator
cd /d "%~dp0"
rem ใช้ python ตัวที่ติดตั้ง gTTS / pyserial ไว้แล้ว (ตัวเดียวกับ robot_brain.py)
python robot_sim_server.py
if errorlevel 1 py robot_sim_server.py
pause
