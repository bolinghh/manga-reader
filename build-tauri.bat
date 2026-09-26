@echo off
setlocal
set CARGO_HOME=%USERPROFILE%\.cargo
set RUSTUP_HOME=%USERPROFILE%\.rustup
set PATH=%CARGO_HOME%\bin;%PATH%
rustup default stable-x86_64-pc-windows-msvc
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x64
cd /d "%~dp0"
echo [BUILD] rustc:
rustc --version
echo [BUILD] starting tauri build...
call npm run tauri -- build
echo [BUILD] tauri build exit code: %ERRORLEVEL%
endlocal
