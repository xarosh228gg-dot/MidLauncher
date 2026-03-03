@echo off
echo ==========================================
echo  MidLauncher - Diagnostics
echo ==========================================
echo.

echo --- Node.js ---
where node 2>nul && node -v || echo NOT FOUND
echo.

echo --- npm ---
where npm 2>nul && npm -v || echo NOT FOUND
echo.

echo --- electron-builder ---
if exist "node_modules\.bin\electron-builder.cmd" (
    echo FOUND in node_modules
) else (
    echo NOT FOUND - run npm install first
)
echo.

echo --- node_modules ---
if exist "node_modules" (
    echo EXISTS
    dir /b node_modules | find /c /v "" > tmp_count.txt
    set /p MODCOUNT=<tmp_count.txt
    del tmp_count.txt
    echo Packages: %MODCOUNT%
) else (
    echo MISSING - run npm install
)
echo.

echo --- icon.ico ---
if exist "icon.ico" (
    for %%f in (icon.ico) do echo EXISTS, size: %%~zf bytes
) else (
    echo MISSING
)
echo.

echo --- winCodeSign cache ---
set "WCSDIR=%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"
if exist "%WCSDIR%" (
    echo Cache folder exists: %WCSDIR%
    dir /b "%WCSDIR%" 2>nul
) else (
    echo Cache folder does not exist yet
)
echo.

echo --- dist folder ---
if exist "dist" (
    dir /b dist
) else (
    echo dist folder does not exist yet
)
echo.
echo ==========================================
pause
