const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const productName = (pkg.build && pkg.build.productName) || pkg.productName || pkg.name;
const exeName = `${productName}.exe`;

const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const outDir = path.join(root, 'dist', 'win-unpacked');
const shouldPublish = process.argv.includes('--publish');

function run(cmd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: root });
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// 1. Build the UI bundle
run('npx vite build');

// 2. Let electron-builder try to assemble the unpacked app + installer normally.
//    On this machine, antivirus real-time scanning silently drops some files
//    (electron.exe, resources.pak, icudtl.dat, part of locales/, extraResources)
//    while electron-builder is copying them, causing a fatal ENOENT rename error.
//    We don't fail the build here - we repair the output afterwards instead.
let builderFailed = false;
try {
  run('npx electron-builder --dir');
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
  // aborted before it reached that step.
  const extraResources = (pkg.build && pkg.build.extraResources) || [];
  for (const res of extraResources) {
    const src = path.join(root, res.from);
    const dest = path.join(outDir, 'resources', res.to || res.from);
    if (fs.existsSync(src)) {
      copyRecursive(src, dest);
    }
  }

  if (!fs.existsSync(path.join(outDir, exeName))) {
    console.error(`[error] ${exeName} is still missing after repair. Aborting.`);
    process.exit(1);
  }

  console.log('[info] Repair complete.');
}

// 3. Build the NSIS installer from the unpacked app. This always runs (not just
//    on the AV-repair path above) since electron-builder --dir never produces
//    an installer on its own.
console.log('\nBuilding the installer...');
run(`npx electron-builder --prepackaged "${outDir}" --win nsis${shouldPublish ? ' --publish always' : ''}`);

console.log('\nBuild finished successfully.');
