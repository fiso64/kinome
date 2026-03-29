@echo off
set SERVER=odroid

:: Find the most recent .deb file in dist folder
for %%f in (dist\*.deb) do set DEB_FILE=%%f

if "%DEB_FILE%"=="" (
    echo [ERROR] No .deb file found in dist/ directory.
    echo Please run 'bun run publish:linux-arm' first.
    pause
    exit /b 1
)

echo ==========================================
echo  Deploying: %DEB_FILE%
echo  Target:    %SERVER%
echo ==========================================

:: 1. Upload
echo [1/2] Uploading to /tmp/kinome.deb...
scp "%DEB_FILE%" %SERVER%:/tmp/kinome.deb
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Upload failed.
    pause
    exit /b 1
)

:: 2. Install
echo [2/2] Installing and restarting service...
ssh -t %SERVER% "sudo dpkg -i /tmp/kinome.deb && sudo systemctl restart kinome"
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Installation failed.
    pause
    exit /b 1
)

echo.
echo [SUCCESS] Deployed successfully.