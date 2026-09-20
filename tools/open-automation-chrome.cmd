@echo off
rem One-time setup for unattended Drive uploads: opens a dedicated Chrome profile.
rem Sign in to your Google account in the window that appears, then close it.
rem After that, uploads run with:
rem   set CHROME_PROFILE_DIR=%LOCALAPPDATA%\chrome-automation-profile
rem   node tools\upload_drive_profile.mjs out\jezero-ops.mp4
"C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="%LOCALAPPDATA%\chrome-automation-profile" --no-first-run https://drive.google.com/
