// Copy Cesium static assets into public/cesium for runtime loading
// Works with Turbopack (no webpack plugins)

const fs = require('fs');
const path = require('path');

const cesiumSource = path.join(__dirname, '..', 'node_modules', 'cesium', 'Build', 'Cesium');
const dest = path.join(__dirname, '..', 'public', 'cesium');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function copyDir(src, dst) {
  ensureDir(dst);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      copyDir(s, d);
    } else if (e.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function main() {
  if (!fs.existsSync(cesiumSource)) {
    console.error('Cesium source not found:', cesiumSource);
    process.exit(1);
  }
  ensureDir(dest);
  for (const dir of ['Assets', 'Widgets', 'ThirdParty', 'Workers']) {
    const src = path.join(cesiumSource, dir);
    const dst = path.join(dest, dir);
    copyDir(src, dst);
    console.log('Copied', dir);
  }
  console.log('Cesium assets copied to', dest);
}

main();
