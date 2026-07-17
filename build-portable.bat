@echo off
setlocal EnableDelayedExpansion
title Soul Connection - Portable Build

rem Always run from this script's own folder, regardless of where it was
rem launched from (double-click, another cwd, etc.).
cd /d "%~dp0"

echo ================================================
echo   Soul Connection - Portable Build
echo ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found. Install it from https://nodejs.org and run this again.
    goto :fail
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm was not found. Check your Node.js installation.
    goto :fail
)

if not exist "node_modules" (
    echo [1/3] Installing project dependencies...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] Dependency installation failed.
        goto :fail
    )
) else (
    echo [1/3] Dependencies already installed - skipping this step.
)
echo.

echo [2/3] Building the portable executable ^(this can take a few minutes^)...
echo.
call node scripts\build-exe.cjs --portable
if errorlevel 1 (
    echo.
    echo [ERROR] The build process failed. See the output above for details.
    goto :fail
)
echo.

echo [3/3] Locating the output EXE in the release folder...
set "EXE_PATH="
for %%F in ("release\*Portable*.exe") do set "EXE_PATH=%%~fF"

if not defined EXE_PATH (
    echo.
    echo [ERROR] The build finished but no portable EXE was found in release.
    goto :fail
)

echo.
echo ================================================
echo   Build completed successfully
echo ================================================
echo Portable executable:
echo   !EXE_PATH!
echo.
echo This file is self-contained -- no installation needed, just run it
echo on any Windows machine.
echo ================================================
echo.
endlocal
pause
exit /b 0

:fail
echo.
echo ================================================
echo   Build stopped. Fix the error above and run this again.
echo ================================================
echo.
endlocal
pause
exit /b 1
