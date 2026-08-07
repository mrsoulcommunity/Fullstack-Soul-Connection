const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const productName = (pkg.build && pkg.build.productName) || pkg.productName || pkg.name;
const exeName = `${productName}.exe`;

const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const releaseDir = path.join(root, 'release');
const buildOutputDir = path.join(releaseDir, `.builder-${process.pid}-${Date.now()}`);
const outDir = path.join(buildOutputDir, 'win-unpacked');
const shouldPublish = process.argv.includes('--publish');
const portable = process.argv.includes('--portable');
const winTarget = portable ? 'portable' : 'nsis';
const staleBuildDirPrefix = '.builder-';

// The NSIS installer ships as ONE setup.exe carrying both the x64 and the ia32
// app payload, so a single download installs correctly on 32-bit and 64-bit
// Windows alike. The portable build stays single-arch (x64): a portable exe has
// no installer step that could pick a payload, and doubling its size to embed
// an arch that never gets used would be pure waste.
const INSTALLER_ARCHS = ['x64', 'ia32'];
const PORTABLE_ARCH = 'x64';

function run(cmd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: root });
}

// `accept(entryName)` lets a caller skip specific directory entries (used to
// keep the per-arch bin/win-* folders out of a copy of the shared payload).
function copyRecursive(src, dest, accept = () => true) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (!accept(entry)) continue;
      copyRecursive(path.join(src, entry), path.join(dest, entry), accept);
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function makeWritableRecursive(target) {
  if (!fs.existsSync(target)) return;

  const stat = fs.lstatSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      makeWritableRecursive(path.join(target, entry));
    }
  }

  try {
    fs.chmodSync(target, stat.isDirectory() ? 0o777 : 0o666);
  } catch (e) {
    if (!['EPERM', 'ENOENT'].includes(e.code)) throw e;
  }
}

function removeDirectoryIfExists(dir, label) {
  if (!fs.existsSync(dir)) return true;

  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      makeWritableRecursive(dir);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
      return true;
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(e.code) || attempt === 12) {
        console.warn(`\n[warn] Could not remove ${label}: ${dir}`);
        console.warn('[warn] Close any running Soul Connection windows, Explorer preview panes, terminals opened inside release output folders, and antivirus scans, then remove it manually if needed.');
        console.warn(`[warn] Original error: ${e.code || e.name}: ${e.message}`);
        return false;
      }

      sleep(750);
    }
  }

  return false;
}

function cleanupStaleOutputDirs() {
  if (!fs.existsSync(releaseDir)) return;

  for (const entry of fs.readdirSync(releaseDir)) {
    if (!entry.startsWith(staleBuildDirPrefix)) continue;
    removeDirectoryIfExists(path.join(releaseDir, entry), `stale build output "${entry}"`);
  }
}

function clearPreviousOutput() {
  cleanupStaleOutputDirs();
}

const buildStartedAt = Date.now();

// 1. Build the UI bundle
run('npx vite build');

// ---------------------------------------------------------------------------
// Installer path: one multi-arch NSIS installer.
//
// This can't reuse the --dir + --prepackaged flow below, because
// --prepackaged takes exactly one unpacked app directory and a dual-arch
// installer needs two. So electron-builder drives the whole pipeline here.
// The AV interference that motivated the repair path is nondeterministic
// (it drops files mid-copy), so a failed attempt is simply retried.
//
// Note: package.json sets nsis.warningsAsErrors=false. makensis emits
// "warning 9000: Insecure filename" for any artifact literally named
// setup.exe (Windows applies installer compatibility shims to it), and
// electron-builder otherwise promotes that warning to a hard build failure.
// The shims are exactly right for something that *is* an installer, and the
// setup.exe filename is a deliberate product decision, so the warning is
// downgraded rather than the name changed.
// ---------------------------------------------------------------------------
if (!portable) {
  cleanupStaleOutputDirs();
  for (const dir of ['win-unpacked', 'win-ia32-unpacked']) {
    removeDirectoryIfExists(path.join(releaseDir, dir), `previous unpacked output "${dir}"`);
  }

  const archFlags = INSTALLER_ARCHS.map((a) => `--${a}`).join(' ');
  const publishFlag = shouldPublish ? '--publish always' : '--publish never';
  const cmd = `npx electron-builder --win nsis ${archFlags} ${publishFlag}`;

  const MAX_ATTEMPTS = 3;
  let built = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !built; attempt += 1) {
    try {
      run(cmd);
      built = true;
    } catch (e) {
      if (attempt === MAX_ATTEMPTS) {
        console.error('\n[error] The installer build failed after ' + MAX_ATTEMPTS + ' attempts.');
        console.error('[error] Close any running Soul Connection windows and add this folder to your antivirus exclusions, then try again.');
        process.exit(1);
      }
      console.log(`\n[info] Attempt ${attempt} failed (commonly antivirus touching files mid-copy). Retrying…`);
      sleep(3000);
    }
  }

  const installerPath = path.join(releaseDir, 'setup.exe');
  if (!fs.existsSync(installerPath) || fs.statSync(installerPath).mtimeMs < buildStartedAt) {
    console.error(`[error] ${installerPath} is missing or predates this build run. Aborting.`);
    process.exit(1);
  }

  const sizeMb = (fs.statSync(installerPath).size / (1024 * 1024)).toFixed(1);
  console.log(`\nBuild finished successfully.\nInstaller: ${installerPath} (${sizeMb} MB, x64 + ia32)`);
  process.exit(0);
}

// 2. Build into a unique temporary output directory. Reusing
//    release/win-unpacked makes portable builds fragile on Windows because a
//    running app, Explorer preview, terminal cwd, or antivirus scan can lock
//    the previous output directory and make rmSync fail with EPERM.
clearPreviousOutput();

// 3. Let electron-builder try to assemble the unpacked app + installer normally.
//    On this machine, antivirus real-time scanning silently drops some files
//    (electron.exe, resources.pak, icudtl.dat, part of locales/, extraResources)
//    while electron-builder is copying them, causing a fatal ENOENT rename error.
//    We don't fail the build here - we repair the output afterwards instead.
let builderFailed = false;
try {
  run(`npx electron-builder --dir --config.directories.output="${buildOutputDir}"`);
} catch (e) {
  builderFailed = true;
  console.log('\n[info] electron-builder --dir hit an error (likely antivirus interference). Repairing the unpacked app folder...');
}

if (builderFailed) {
  if (!fs.existsSync(outDir)) {
    console.error(`[error] Expected output directory not found: ${outDir}`);
    process.exit(1);
  }

  // Re-copy every file from the electron distribution, skipping "resources"
  // (electron-builder already placed our app's resources/app.asar there).
  for (const entry of fs.readdirSync(electronDist)) {
    if (entry === 'resources') continue;
    const src = path.join(electronDist, entry);
    const dest = entry === 'electron.exe' ? path.join(outDir, exeName) : path.join(outDir, entry);
    copyRecursive(src, dest);
  }

  // Re-copy extraResources ("bin" -> resources/bin) since electron-builder
  // aborted before it reached that step. `${arch}` resolves to the arch this
  // portable build targets, and the per-arch source folders are excluded from
  // the shared-payload copy so exactly one xray.exe/wintun.dll pair ships.
  const binRoot = path.join(root, 'bin');
  const archDirs = new Set(
    fs.existsSync(binRoot) ? fs.readdirSync(binRoot).filter((e) => e.startsWith('win-')) : []
  );
  const extraResources = (pkg.build && pkg.build.extraResources) || [];
  for (const res of extraResources) {
    const from = String(res.from).replace(/\$\{arch\}/g, PORTABLE_ARCH);
    const src = path.join(root, from);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(outDir, 'resources', res.to || from);
    copyRecursive(src, dest, (entry) => !archDirs.has(entry));
  }

  if (!fs.existsSync(path.join(outDir, exeName))) {
    console.error(`[error] ${exeName} is still missing after repair. Aborting.`);
    process.exit(1);
  }

  // Guard against exactly the failure mode this repair path used to miss:
  // if app.asar predates this build run, electron-builder never got around
  // to (re)writing it before it crashed, and packaging would silently ship
  // stale app code. Fail loudly instead.
  const asarPath = path.join(outDir, 'resources', 'app.asar');
  if (!fs.existsSync(asarPath) || fs.statSync(asarPath).mtimeMs < buildStartedAt) {
    console.error(`[error] ${asarPath} is missing or predates this build -- electron-builder never wrote a fresh app bundle. Close any running instances of the app and try again.`);
    process.exit(1);
  }

  console.log('[info] Repair complete.');
}

// 3. Package the unpacked app into the final artifact (NSIS installer, or a
//    single portable .exe with --portable). This always runs (not just on
//    the AV-repair path above) since electron-builder --dir never produces
//    a distributable on its own.
console.log(`\nBuilding the ${portable ? 'portable executable' : 'installer'}...`);
run(`npx electron-builder --prepackaged "${outDir}" --win ${winTarget}${shouldPublish ? ' --publish always' : ''}`);

removeDirectoryIfExists(buildOutputDir, 'temporary unpacked build output');

console.log('\nBuild finished successfully.');
