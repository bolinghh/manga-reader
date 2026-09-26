@echo off
cd /d "%~dp0"
set "OCR_RUNTIME=%~dp0"
if not exist "..\src-tauri\Cargo.toml" set "OCR_RUNTIME=%APPDATA%\com.mangareader.reader\ocr"
set "MANGAREADER_OCR_MODELS=%OCR_RUNTIME%\models"
if not exist "%OCR_RUNTIME%\.venv\Scripts\python.exe" (
  echo Run setup-ocr.cmd first.
  pause
  exit /b 1
)
"%OCR_RUNTIME%\.venv\Scripts\python.exe" ocr_server.py
if errorlevel 1 pause
