@echo off
echo ===============================================
echo      REAPER Batch FX UI Launcher
echo ===============================================

REM Change directory to the app folder
cd reaper-batch-ui

REM Install/update dependencies
echo.
echo Installing/updating dependencies...
call npm install
IF %ERRORLEVEL% NEQ 0 (
    echo.
    echo ERROR: Failed to install dependencies.
    pause
    exit /b %ERRORLEVEL%
)
echo Dependencies are up to date.

REM Start the application
echo.
echo Starting the application...
call npm start

echo.
echo Application has been closed.
pause 