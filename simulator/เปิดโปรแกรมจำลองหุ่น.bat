@echo off
chcp 65001 >nul
title Nong Mali Robot Simulator
cd /d "%~dp0"
rem Use the same Python that has gTTS / pyserial installed (same as robot_brain.py)
python robot_sim_server.py
if errorlevel 1 py robot_sim_server.py
pause
