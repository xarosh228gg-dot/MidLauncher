#!/bin/bash
set -e

echo "===================================="
echo " MidLauncher Build Script (Linux/Mac)"
echo "===================================="
echo

if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js not found. Install from https://nodejs.org"
    exit 1
fi

echo "[1/3] Installing dependencies..."
npm install

echo ""
echo "[2/3] Building..."

if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "  Building for macOS: .dmg (x64 + arm64)"
    npx electron-builder --mac
else
    echo "  Building for Linux: .AppImage + .deb"
    npx electron-builder --linux --x64
fi

echo ""
echo "[3/3] Done! Check the 'dist' folder."
ls -lh dist/
