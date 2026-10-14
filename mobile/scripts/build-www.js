const fs = require('node:fs/promises');
const path = require('node:path');

const mobileDir = path.resolve(__dirname, '..');
const rootDir = path.resolve(mobileDir, '..');
const webDir = path.join(mobileDir, 'www');
const rendererDir = path.join(rootDir, 'src', 'renderer');
const bridgeDir = path.join(mobileDir, 'bridge');

async function build() {
  await fs.rm(webDir, { recursive: true, force: true });
  await fs.mkdir(webDir, { recursive: true });
  await fs.cp(rendererDir, webDir, { recursive: true });
  await fs.copyFile(path.join(bridgeDir, 'android-bridge.js'), path.join(webDir, 'android-bridge.js'));
  await fs.copyFile(path.join(bridgeDir, 'fnv1a.js'), path.join(webDir, 'fnv1a.js'));

  const indexPath = path.join(webDir, 'index.html');
  let index = await fs.readFile(indexPath, 'utf8');
  if (!/<meta\s+name=["']viewport["']/i.test(index)) {
    index = index.replace('<meta charset="UTF-8" />', '<meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />');
  }
  index = index.replace(
    '<script src="app.js"></script>',
    '<script src="fnv1a.js"></script>\n  <script src="android-bridge.js"></script>\n  <script src="app.js"></script>',
  );
  await fs.writeFile(indexPath, index);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
