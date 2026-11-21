// build-icons.mjs — 自定义图标打包脚本（不改 build-preview.mjs）。
// 读取 assets/icons/ 下的 PNG（不存在时跳过并提示），逐档校验尺寸
// （readPngSize，见 js/customIcon.js：须为正方形、边长达标），
// 复制到 dist/icons/，并把 apple-touch-icon.png 同步一份到 dist 根目录
// （供 <link rel="apple-touch-icon" href="/apple-touch-icon.png"> 用），
// 生成/更新 dist/manifest.json（name、icons 含 192/512/maskable、
// display standalone），并输出需要手动确认的 index.html link 清单
// （apple-touch-icon 180、manifest 链接）。
// 不依赖任何外部包。用法：node scripts/build-icons.mjs [--name 名字]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPngSize } from '../js/customIcon.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(root, 'assets/icons');
const distIcons = resolve(root, 'dist/icons');
const manifestPath = resolve(root, 'dist/manifest.json');

const nameArg = process.argv.indexOf('--name');
const appName = nameArg !== -1 ? process.argv[nameArg + 1] : 'verweile';

const EXPECTED = [
  { file: 'apple-touch-icon.png', sizes: '180x180', type: 'image/png', purpose: 'apple-touch-icon' },
  { file: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { file: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { file: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

if (!existsSync(srcDir)) {
  console.log('assets/icons/ 不存在：跳过图标打包（先用自定义图标的“下载图标包”导出 PNG 放到 assets/icons/ 再跑本脚本）。');
  process.exit(0);
}
const present = readdirSync(srcDir).filter((f) => f.toLowerCase().endsWith('.png'));
if (!present.length) {
  console.log('assets/icons/ 下没有 PNG：跳过图标打包。');
  process.exit(0);
}

mkdirSync(distIcons, { recursive: true });
const copied = [];
const bad = [];
for (const f of present) {
  const expected = EXPECTED.find((e) => e.file === f);
  if (expected) {
    const size = readPngSize(readFileSync(join(srcDir, f)));
    const need = Number(expected.sizes.split('x')[0]);
    if (!size.ok) bad.push(`${f}：${size.reason}`);
    else if (size.width !== size.height || size.width < need) {
      bad.push(`${f}：须为 ${need}×${need} 或更大正方形，实际 ${size.width}×${size.height}`);
    }
  }
  copyFileSync(join(srcDir, f), join(distIcons, f));
  copied.push(f);
}
if (bad.length) {
  console.error(`图标校验失败（已复制文件，但 manifest 不会写入问题图标）：\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log(`已复制到 dist/icons/：${copied.join(', ')}`);
// apple-touch-icon 同步一份到 dist 根目录（iOS 只认根路径或显式 link 的文件）。
if (present.includes('apple-touch-icon.png')) {
  copyFileSync(join(srcDir, 'apple-touch-icon.png'), resolve(root, 'dist/apple-touch-icon.png'));
  console.log('已同步 dist/apple-touch-icon.png');
}

let manifest = {};
if (existsSync(manifestPath)) {
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { manifest = {}; }
}
manifest.name = appName;
manifest.short_name = manifest.short_name || appName;
manifest.display = 'standalone';
manifest.background_color = manifest.background_color || '#ececed';
manifest.theme_color = manifest.theme_color || '#ececed';
manifest.start_url = manifest.start_url || '.';
manifest.icons = EXPECTED
  .filter((e) => present.includes(e.file))
  .map((e) => ({ src: `/icons/${e.file}`, sizes: e.sizes, type: e.type, purpose: e.purpose }));
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`dist/manifest.json 已生成/更新：name=${appName}，icons=${manifest.icons.length} 个`);

const missing = EXPECTED.filter((e) => !present.includes(e.file)).map((e) => e.file);
if (missing.length) console.log(`提示：缺少 ${missing.join(', ')}，manifest 里暂不含它们；补齐后重跑本脚本。`);

console.log('\n需手动确认并加入 index.html <head> 的 link（本脚本不改 index.html）：');
console.log('  <link rel="manifest" href="/manifest.json">');
if (present.includes('apple-touch-icon.png')) {
  console.log('  <link rel="apple-touch-icon" href="/apple-touch-icon.png">');
} else {
  console.log('  （缺 apple-touch-icon.png：先导出 180×180 再加 <link rel="apple-touch-icon" href="/apple-touch-icon.png">）');
}
console.log('注意：改完需重新部署，并删除主屏幕旧图标后重新添加到主屏幕，已安装图标不会自动替换。');
