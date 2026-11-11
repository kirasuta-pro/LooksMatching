@echo off
setlocal
title Install Look Match for Premiere Pro
set "CCX=%~dp0LookMatch.ccx"
set "UPIA=C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"

if not exist "%CCX%" (
  echo Can't find LookMatch.ccx next to this file. Unzip the whole folder first, then run again.
  pause & exit /b 1
)
echo Close Premiere Pro first if it is open.
echo.
if exist "%UPIA%" (
  echo Installing with Adobe's Unified Plugin Installer Agent...
  "%UPIA%" /install "%CCX%"
  echo.
  echo Exit code: %ERRORLEVEL%   (0 = installed)
  echo Open Premiere Pro, then Window ^> Extensions ^(or Plugins^) ^> Look Match.
) else (
  echo Adobe's installer agent wasn't found. Opening the .ccx with Creative Cloud instead...
  start "" "%CCX%"
)
echo.
pause
