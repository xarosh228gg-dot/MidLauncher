/**
 * patch-builder.js
 * 1. Patches getSignVendorPath to skip winCodeSign .7z download
 * 2. Downloads rcedit-x64.exe into the fake winCodeSign cache
 */
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const https = require('https');

// ── Paths ────────────────────────────────────────────────────────────────────
const WINCOSIGN_DIR = path.join(
  os.homedir(), 'AppData', 'Local',
  'electron-builder', 'Cache', 'winCodeSign', 'winCodeSign-2.6.0'
);

const RCEDIT_URL  = 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe';
const RCEDIT_PATH = path.join(WINCOSIGN_DIR, 'rcedit-x64.exe');

const DARWIN_LIB  = path.join(WINCOSIGN_DIR, 'darwin', '10.12', 'lib');
const STUBS       = ['libcrypto.dylib', 'libssl.dylib'];

// ── Step 1: Patch windowsCodeSign.js ────────────────────────────────────────
const candidates = [
  path.join(__dirname, 'node_modules', 'app-builder-lib', 'out', 'codeSign', 'windowsCodeSign.js'),
];

for (const file of candidates) {
  if (!fs.existsSync(file)) continue;

  let src = fs.readFileSync(file, 'utf8');

  if (src.includes('/* MIDLAUNCHER_PATCHED */')) {
    console.log('[OK] Already patched:', path.basename(file));
    continue;
  }

  const INJECT = `
  /* MIDLAUNCHER_PATCHED */
  {
    const _fp = require("path").join(require("os").homedir(),"AppData","Local","electron-builder","Cache","winCodeSign","winCodeSign-2.6.0");
    require("fs").mkdirSync(require("path").join(_fp,"darwin","10.12","lib"),{recursive:true});
    ["libcrypto.dylib","libssl.dylib"].forEach(f=>{const p=require("path").join(_fp,"darwin","10.12","lib",f);if(!require("fs").existsSync(p))require("fs").writeFileSync(p,"");});
    return _fp;
  }
  /* END_MIDLAUNCHER_PATCHED */`;

  const regex = /((?:async\s+)?function\s+getSignVendorPath\s*\([^)]*\)\s*\{)/;
  const m = src.match(regex);
  if (m) {
    src = src.replace(regex, m[1] + INJECT);
    fs.writeFileSync(file, src, 'utf8');
    console.log('[OK] Patched: getSignVendorPath in', path.basename(file));
  } else {
    const idx = src.indexOf('getSignVendorPath');
    if (idx !== -1) {
      console.log('[WARN] Found getSignVendorPath but pattern did not match.');
      console.log('       Context:', JSON.stringify(src.slice(Math.max(0,idx-30), idx+120)));
    } else {
      console.log('[WARN] getSignVendorPath not found in', path.basename(file));
    }
  }
}

// ── Step 2: Ensure rcedit-x64.exe exists ────────────────────────────────────
fs.mkdirSync(DARWIN_LIB, { recursive: true });
STUBS.forEach(f => {
  const p = path.join(DARWIN_LIB, f);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
});

if (fs.existsSync(RCEDIT_PATH) && fs.statSync(RCEDIT_PATH).size > 10000) {
  console.log('[OK] rcedit-x64.exe already present (' + Math.round(fs.statSync(RCEDIT_PATH).size/1024) + ' KB)');
  process.exit(0);
}

console.log('[..] Downloading rcedit-x64.exe...');
console.log('     From:', RCEDIT_URL);

function download(url, dest, redirects) {
  redirects = redirects || 0;
  if (redirects > 5) { console.error('[ERROR] Too many redirects'); process.exit(1); }

  https.get(url, { headers: { 'User-Agent': 'midlauncher-build' } }, res => {
    if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
      console.log('[..] Redirect ->', res.headers.location);
      return download(res.headers.location, dest, redirects + 1);
    }
    if (res.statusCode !== 200) {
      console.error('[ERROR] HTTP', res.statusCode, 'downloading rcedit');
      process.exit(1);
    }
    const out = fs.createWriteStream(dest);
    let received = 0;
    res.on('data', chunk => { received += chunk.length; });
    res.pipe(out);
    out.on('finish', () => {
      out.close();
      const kb = Math.round(received / 1024);
      if (received < 10000) {
        console.error('[ERROR] rcedit download too small (' + kb + ' KB), something went wrong');
        fs.unlinkSync(dest);
        process.exit(1);
      }
      console.log('[OK] rcedit-x64.exe downloaded (' + kb + ' KB)');
      console.log('[OK] winCodeSign cache ready at:', WINCOSIGN_DIR);
    });
    out.on('error', err => {
      console.error('[ERROR] Write error:', err.message);
      process.exit(1);
    });
  }).on('error', err => {
    console.error('[ERROR] Download failed:', err.message);
    console.log('');
    console.log('Manual fix:');
    console.log('  1. Download: https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe');
    console.log('  2. Copy to:', RCEDIT_PATH);
    console.log('  3. Run BUILD.bat again');
    process.exit(1);
  });
}

download(RCEDIT_URL, RCEDIT_PATH);
