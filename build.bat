@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   Soul Connection - Build to EXE
echo ============================================
echo.

echo [1/2] Installing dependencies (if needed)...
call npm install
if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)

echo.
echo [2/2] Building app and packaging EXE...
call npm run dist
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Build finished successfully!
echo   Check the "dist" folder for the installer .exe
echo ============================================
pause
