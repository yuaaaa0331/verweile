// build-preview.mjs — 把 uwu-chat 源码打包成单文件 dist/index.html（预览用）。
// 源码仍是分模块的 ES modules；这里按依赖顺序拼接、去掉 import/export，
// 生成一个 <script type="module">，与源码同一份逻辑。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORDER = [
  'js/utils.js',
  'js/statusBar.js',
  'js/promptTemplates.js',
  'js/statusMode.js',
  'js/promptBuilder.js',
  'js/historyBuilder.js',
  'js/replyParser.js',
  'js/sse.js',
  'js/providerAdapter.js',
  'js/auxApi.js',
  'js/memorySummary.js',
  'js/experiences.js',
  'js/keywordSearch.js',
  'js/vectorMemory.js',
  'js/associative.js',
  'js/retrievalWorker.js',
  'js/storage.js',
  'js/chatCenter.js',
  'js/chatSearch.js',
  'js/chatDates.js',
  'js/inAppNotify.js',
  'js/audioKeepAlive.js',
  'js/pushNotify.js',
  'js/customIcon.js',
  'js/wakeEngine.js',
  'js/importExport.js',
  'js/mockReply.js',
  'js/liquidGlass.js',
  'js/theme.js',
  'js/moments.js',
  'js/nav.js',
  'js/manage.js',
  'js/stickers.js',
  'js/longPressMenu.js',
  'js/innerVoice.js',
  'js/chatDaily.js',
  'js/quoteNavigation.js',
  'js/app.js',
];

function stripModule(src, name) {
  // 去掉 import 行
  let out = src.replace(/^import\s+[^;]+?from\s+['"][^'"]+['"];?\s*$/gm, '');
  // export function/const/class/async function -> 去掉 export 前缀
  out = out.replace(/^export\s+(?=(async\s+)?(function|const|let|var|class)\b)/gm, '');
  // export { ... }; 形式的导出列表（本项目暂无，防御性处理）
  out = out.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  if (/^import\s/m.test(out)) throw new Error(`${name}: 仍有 import 残留`);
  if (/^export\s/m.test(out)) throw new Error(`${name}: 仍有 export 残留`);
  return out.trim();
}

const parts = ORDER.map((p) => {
  const src = readFileSync(resolve(root, p), 'utf8');
  return `\n/* ===== ${p} ===== */\n` + stripModule(src, p);
});
const bundle = parts.join('\n');

// 构建后防线（2026-11-21 导入别名事故）：拼接脚本去掉 import 行后，
// `import { X as Y }` 的别名 Y 在 bundle 里没有任何定义，调用点一跑就
// ReferenceError，而 Node ESM 测试能解析别名、抓不到。扫描全部源码的
// import 别名，确认没有一个以裸标识符出现在 bundle 里；再加本次事故的
// 显式回归名。以后新增别名必须同步改掉调用点，否则构建直接失败。
const KNOWN_BAD_ALIASES = ['withoutAuxKey'];
const importAliases = new Set(KNOWN_BAD_ALIASES);
for (const p of ORDER) {
  const src = readFileSync(resolve(root, p), 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const spec of m[1].split(',')) {
      const alias = spec.match(/^\s*([\w$]+)\s+as\s+([\w$]+)\s*$/);
      if (alias) importAliases.add(alias[2]);
    }
  }
}
for (const alias of importAliases) {
  if (new RegExp(`\\b${alias}\\b`).test(bundle)) {
    throw new Error(`构建失败：bundle 里出现未定义的 import 别名 ${alias}（import { X as ${alias} } 被 stripModule 去掉后无定义，浏览器里会抛 ReferenceError）`);
  }
}

// 重复声明由 node --check 兜底（顶层同名会直接报 SyntaxError）；
// 这里不做正则扫描——函数体内的同名局部变量（如 buildTTPrompt /
// buildUWUPrompt 里的 const c）与顶层声明无法用简单正则区分。

const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const css = readFileSync(resolve(root, 'styles.css'), 'utf8') + '\n' + readFileSync(resolve(root, 'chat.css'), 'utf8');
let out = html
  .replace(/<link rel="stylesheet" href="chat\.css">/, '')
  .replace(/<link rel="stylesheet" href="styles\.css">/, () => `<style>\n${css}\n</style>`)
  .replace(/<script type="module" src="js\/app\.js"><\/script>/, () => `<script type="module">\n${bundle}\n</script>`);
if (out === html) throw new Error('index.html 替换失败：未找到 styles.css / app.js 引用');

mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/index.html'), out, 'utf8');
writeFileSync(resolve(root, 'dist/bundle.mjs'), bundle, 'utf8');

// B 组：Service Worker / manifest / 图标不能内联进单文件 HTML，必须作为独立文件复制到 dist。
// sw.js 是独立的 Service Worker 脚本（含顶层 self 监听），绝不能拼进 bundle。
if (existsSync(resolve(root, 'sw.js'))) copyFileSync(resolve(root, 'sw.js'), resolve(root, 'dist/sw.js'));
if (existsSync(resolve(root, 'manifest.json'))) copyFileSync(resolve(root, 'manifest.json'), resolve(root, 'dist/manifest.json'));
if (existsSync(resolve(root, 'apple-touch-icon.png'))) copyFileSync(resolve(root, 'apple-touch-icon.png'), resolve(root, 'dist/apple-touch-icon.png'));
if (existsSync(resolve(root, 'assets/icons'))) {
  cpSync(resolve(root, 'assets/icons'), resolve(root, 'dist/icons'), { recursive: true });
}
// 接线轮补齐：没有自定义图标时，dist 里也必须有 manifest.json 与
// apple-touch-icon.png（index.html 已改指这两个部署文件）。build-icons.mjs
// 只在 assets/icons/ 存在时才生成；缺失时这里写一份默认 manifest 与一张
// 180×180 纯色默认图标，已有文件时绝不覆盖（自定义图标优先）。
if (!existsSync(resolve(root, 'dist/manifest.json'))) {
  writeFileSync(resolve(root, 'dist/manifest.json'), `${JSON.stringify({
    name: 'verweile', short_name: 'verweile', display: 'standalone',
    background_color: '#ececed', theme_color: '#ececed', start_url: '.', icons: [],
  }, null, 2)}\n`, 'utf8');
}
if (!existsSync(resolve(root, 'dist/apple-touch-icon.png'))) {
  writeFileSync(resolve(root, 'dist/apple-touch-icon.png'), defaultIconPng());
}
console.log(`dist/index.html 已生成：${out.length} 字节，bundle ${bundle.length} 字节`);

/** 默认主屏幕图标：180×180 纯色 #1d1d1f PNG（无自定义图标时的兜底）。 */
function defaultIconPng() {
  const size = 180;
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 3)] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * (1 + size * 3) + 1 + x * 3;
      raw[o] = 0x1d; raw[o + 1] = 0x1d; raw[o + 2] = 0x1f;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
