// build-preview.mjs — 把 uwu-chat 源码打包成单文件 dist/index.html（预览用）。
// 源码仍是分模块的 ES modules；这里按依赖顺序拼接、去掉 import/export，
// 生成一个 <script type="module">，与源码同一份逻辑。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORDER = [
  'js/utils.js',
  'js/statusBar.js',
  'js/promptTemplates.js',
  'js/promptBuilder.js',
  'js/historyBuilder.js',
  'js/replyParser.js',
  'js/sse.js',
  'js/providerAdapter.js',
  'js/storage.js',
  'js/importExport.js',
  'js/mockReply.js',
  'js/liquidGlass.js',
  'js/theme.js',
  'js/moments.js',
  'js/nav.js',
  'js/manage.js',
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

// 重复声明由 node --check 兜底（顶层同名会直接报 SyntaxError）；
// 这里不做正则扫描——函数体内的同名局部变量（如 buildTTPrompt /
// buildUWUPrompt 里的 const c）与顶层声明无法用简单正则区分。

const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const css = readFileSync(resolve(root, 'styles.css'), 'utf8');
let out = html
  .replace(/<link rel="stylesheet" href="styles\.css">/, () => `<style>\n${css}\n</style>`)
  .replace(/<script type="module" src="js\/app\.js"><\/script>/, () => `<script type="module">\n${bundle}\n</script>`);
if (out === html) throw new Error('index.html 替换失败：未找到 styles.css / app.js 引用');

mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/index.html'), out, 'utf8');
writeFileSync(resolve(root, 'dist/bundle.mjs'), bundle, 'utf8');
console.log(`dist/index.html 已生成：${out.length} 字节，bundle ${bundle.length} 字节`);
