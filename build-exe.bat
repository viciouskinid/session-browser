@echo off
cd /d "%~dp0"
call npm install
if errorlevel 1 goto :fail
call npx --yes @electron/packager . SessionBrowser --platform=win32 --arch=x64 --icon=assets\icon.ico --out=dist --overwrite --prune=true --ignore="^/build-exe\.bat$" --ignore="^/run\.bat$" --ignore="^/tests" --ignore="^/dist"
if errorlevel 1 goto :fail
set "EXE=dist\SessionBrowser-win32-x64\SessionBrowser.exe"
if exist "%EXE%" (
  echo Build complete. Launching SessionBrowser.exe ...
  start "" "%EXE%"
  exit /b 0
)
echo Build finished but "%EXE%" was not found.
:fail
echo Build failed.
pause
exit /b 1
