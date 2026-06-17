/**
 * Build Windows-friendly icon sets from assets/*.png.
 * Every size is a proportional downscale of the same source (no per-size inset).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import toIco from 'to-ico';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const WINDOWS_SQUARES = {
  'Square30x30Logo.png': 30,
  'Square44x44Logo.png': 44,
  'Square71x71Logo.png': 71,
  'Square89x89Logo.png': 89,
  'Square107x107Logo.png': 107,
  'Square142x142Logo.png': 142,
  'Square150x150Logo.png': 150,
  'Square284x284Logo.png': 284,
  'Square310x310Logo.png': 310,
  'StoreLogo.png': 50,
};

async function renderSize(source, size) {
  return source
    .clone()
    .resize(size, size, {
      fit: 'contain',
      kernel: sharp.kernel.lanczos3,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .png()
    .toBuffer();
}

async function generateSet(sourceRel, outRel) {
  const sourcePath = path.join(root, sourceRel);
  const outDir = path.join(root, outRel);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing source icon: ${sourcePath}`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const source = sharp(sourcePath).ensureAlpha();
  const bySize = new Map();

  for (const size of ICO_SIZES) {
    bySize.set(size, await renderSize(source, size));
  }

  const ico = await toIco([...bySize.values()], { resize: false });
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);

  const write = (name, buf) => fs.writeFileSync(path.join(outDir, name), buf);
  write('icon.png', bySize.get(256));
  write('32x32.png', bySize.get(32));
  write('64x64.png', bySize.get(64));
  write('128x128.png', bySize.get(128));
  write('128x128@2x.png', bySize.get(256));

  for (const [name, size] of Object.entries(WINDOWS_SQUARES)) {
    write(name, await renderSize(source, size));
  }

  console.log(`  ${sourceRel} -> ${outRel} (ico: ${ICO_SIZES.join(', ')})`);
}

console.log('Generating icons...');
await generateSet('assets/proxy-icon.png', 'src-tauri/icons');
await generateSet('assets/server-icon.png', 'src-tauri/icons-server');
console.log('Done.');
