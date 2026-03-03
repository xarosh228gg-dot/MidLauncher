/**
 * fix-wincosign.js
 * Pre-creates the winCodeSign cache directory with dummy files
 * instead of symlinks, bypassing the Windows symlink permission error.
 * 
 * Run BEFORE electron-builder: node fix-wincosign.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const zlib = require('zlib');

const CACHE_DIR = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign');
const VERSION = 'winCodeSign-2.6.0';
const TARGET_DIR = path.join(CACHE_DIR, VERSION);

// The symlinks that cause the error - we'll create dummy files instead
const SYMLINK_STUBS = [
  'darwin/10.12/lib/libcrypto.dylib',
  'darwin/10.12/lib/libssl.dylib',
];

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function main() {
  console.log('🔧 fix-wincosign: checking cache...');

  if (fs.existsSync(TARGET_DIR)) {
    // Check if the problematic symlinks are missing (broken extract)
    const crypto = path.join(TARGET_DIR, 'darwin/10.12/lib/libcrypto.dylib');
    if (fs.existsSync(crypto)) {
      console.log('✓ winCodeSign cache OK, no fix needed.');
      return;
    }
    console.log('⚠ Cache exists but symlinks missing. Creating stubs...');
  } else {
    console.log('⚠ Cache not found. Will be created by electron-builder.');
    console.log('  If build fails, run this script again after the first failure.');
    return;
  }

  // Create stub files for the missing symlinks
  let fixed = 0;
  for (const rel of SYMLINK_STUBS) {
    const full = path.join(TARGET_DIR, rel);
    ensureDir(path.dirname(full));
    if (!fs.existsSync(full)) {
      // Write a small dummy file - electron-builder only checks existence for darwin libs
      // when building on darwin. On Windows it just needs the directory to exist.
      fs.writeFileSync(full, Buffer.alloc(0));
      console.log('  + stub: ' + rel);
      fixed++;
    }
  }

  if (fixed > 0) {
    console.log(`✓ Created ${fixed} stub file(s). Retrying build should work now.`);
  } else {
    console.log('✓ All stubs already present.');
  }
}

main();
