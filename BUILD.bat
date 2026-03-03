@echo off
setlocal enabledelayedexpansion

echo.
echo  ==========================================
echo   MidLauncher Build Script - Windows x64
echo  ==========================================
echo.

set CSC_IDENTITY_AUTO_DISCOVERY=false
set WIN_CSC_LINK=
set CSC_LINK=

where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js not found. Download: https://nodejs.org
    echo.
    pause & exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo [OK] Node.js %%v
for /f "tokens=*" %%v in ('npm -v')  do echo [OK] npm %%v

echo.
echo [1/4] Installing dependencies...
echo ------------------------------------------
call npm install
echo ------------------------------------------
echo npm exit code: %ERRORLEVEL%
if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm install failed
    pause & exit /b 1
)
echo [OK] Dependencies ready
pause

echo.
echo [2/4] Patching electron-builder + downloading rcedit...
echo ------------------------------------------
:: Remove old patch marker so rcedit download step also runs
node -e "const f=require('path').join(__dirname,'node_modules','app-builder-lib','out','codeSign','windowsCodeSign.js');if(require('fs').existsSync(f)){let s=require('fs').readFileSync(f,'utf8');if(s.includes('MIDLAUNCHER_PATCHED')){s=s.replace(/\/\* MIDLAUNCHER_PATCHED \*\/[\s\S]*?\/\* END_MIDLAUNCHER_PATCHED \*\//,'');require('fs').writeFileSync(f,s);console.log('[OK] Removed old patch, re-patching fresh');}}"
node patch-builder.js
set PATCH_ERR=%ERRORLEVEL%
echo ------------------------------------------
echo patch exit code: %PATCH_ERR%
if %PATCH_ERR% neq 0 (
    echo [ERROR] Patch/download failed - check internet connection
    pause & exit /b 1
)
pause

echo.
echo [3/4] Checking winCodeSign cache...
echo ------------------------------------------
set "WCSDIR=%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0"
echo Cache: %WCSDIR%
if exist "%WCSDIR%\rcedit-x64.exe" (
    for %%f in ("%WCSDIR%\rcedit-x64.exe") do echo [OK] rcedit-x64.exe found - %%~zf bytes
    echo [OK] Cache ready
) else (
    echo [ERROR] rcedit-x64.exe NOT found - patch step failed
    pause & exit /b 1
)
echo ------------------------------------------
pause

echo.
echo [4/4] Building installers...
echo ------------------------------------------
call npx electron-builder --win --x64
set BUILD_ERR=%ERRORLEVEL%
echo ------------------------------------------
echo Build exit code: %BUILD_ERR%

if %BUILD_ERR% neq 0 (
    echo.
    echo [ERROR] Build failed - see output above
    pause & exit /b 1
)

echo.
echo  ==========================================
echo   SUCCESS! Files in dist\
echo  ==========================================
echo.
if exist "dist\MidLauncher-Setup-1.0.0.exe"    echo [+] MidLauncher-Setup-1.0.0.exe
if exist "dist\MidLauncher-1.0.0-Portable.exe" echo [+] MidLauncher-1.0.0-Portable.exe
echo.
pause
start explorer dist
