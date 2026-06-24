@echo off
cd /d "%~dp0"

echo.
echo ======================================
echo   Video Watermark Remover
echo ======================================
echo.
echo DO NOT CLOSE THIS WINDOW!
echo.

echo Checking Node.js...
if not exist "E:\tools\nodejs\node-v24.14.0-win-x64\node.exe" (
    echo ERROR: Node.js not found!
    echo Path: E:\tools\nodejs\node-v24.14.0-win-x64\node.exe
    echo.
    pause
    exit /b 1
)
echo OK.
echo.

echo Checking server file...
if not exist "server_fast.js" (
    echo ERROR: server_fast.js not found!
    echo.
    pause
    exit /b 1
)
echo OK.
echo.

echo Checking port...
netstat -ano | findstr ":3000" >nul
if %errorlevel% equ 0 (
    echo Port 3000 in use, trying to free...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000"') do (
        taskkill /F /PID %%a >nul 2>&1
    )
    timeout /t 2 /nobreak >nul
    echo Port freed.
) else (
    echo Port 3000 is free.
)
echo.

echo Starting server...
echo.
echo ======================================
echo   Server starting...
echo ======================================
echo   Open your browser and visit:
echo   http://localhost:3000
echo ======================================
echo.

E:\tools\nodejs\node-v24.14.0-win-x64\node.exe server_fast.js

echo.
echo ======================================
echo   Server stopped
echo ======================================
pause
