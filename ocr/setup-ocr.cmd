@echo off
cd /d "%~dp0"
set "OCR_RUNTIME=%~dp0"
if not exist "..\src-tauri\Cargo.toml" set "OCR_RUNTIME=%APPDATA%\com.mangareader.reader\ocr"
set "MANGAREADER_OCR_MODELS=%OCR_RUNTIME%\models"
if not exist "%OCR_RUNTIME%\.venv\Scripts\python.exe" python -m venv "%OCR_RUNTIME%\.venv"
if errorlevel 1 goto failed
"%OCR_RUNTIME%\.venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto failed
"%OCR_RUNTIME%\.venv\Scripts\python.exe" ocr_server.py --setup ja,en,zh-Hans
if errorlevel 1 goto failed
echo Local OCR is ready. Run start-ocr.cmd to start it.
pause
exit /b 0
:failed
echo Setup failed. Check Python and the network connection, then try again.
pause
exit /b 1
