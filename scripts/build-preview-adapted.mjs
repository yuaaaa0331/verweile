// build-preview-adapted.mjs — 从 dist/index.html 生成预览版 uwu-liao-tian.html。
// 只做沿用已定的 4 处最小 hosting 适配，不改源码、不改功能：
//  1. 内联 <script type="module"> 改 classic <script>（bundle 无顶层 await / 动态 import）；
//  2. 四处原生 confirm() 改应用内 showModal（确定回调里跑原后续逻辑）：
//     2a 向量索引重建；2b 删除记忆（文案：向量索引段与关键词记录一起清理；
//        索引清理已改名 deleteDocumentIndexes）；2c 删除经历（新增）；
//     2d 删除角色全部数据（开头 + 结尾两处）；
//  3. 关闭态子页 display:none；4. .input-row/.input-shell 恢复 min-width:0。
// 每处变换都精确匹配断言，匹配不到就报错退出，不静默跳过。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'dist/index.html'), 'utf8');

function once(hay, needle, label) {
  const n = hay.split(needle).length - 1;
  if (n !== 1) throw new Error(`${label}：期望恰好出现 1 次，实际 ${n} 次`);
  return hay.replace(needle, '§§§');
}
function apply(hay, needle, replacement, label) {
  const marked = once(hay, needle, label);
  return marked.replace('§§§', () => replacement);
}

let out = src;

// 1. module -> classic
out = apply(out, '<script type="module">', '<script>', 'module script');

// 2a. 向量索引重建确认
out = apply(out,
  `    $('#vec-rebuild').addEventListener('click', async () => {
      if (!confirm('重建索引会清空当前空间的全部向量段再重新生成，记忆原文不受影响。确定重建吗？')) return;
      await runVectorIndex({ rebuild: true });
    });`,
  `    $('#vec-rebuild').addEventListener('click', () => {
      showModal('重建索引', '<p>重建索引会清空当前空间的全部向量段再重新生成，记忆原文不受影响。确定重建吗？</p>', [{ label: '取消' }, { label: '确定重建', primary: true, onClick: () => runVectorIndex({ rebuild: true }) }]);
    });`,
  'vec-rebuild confirm');

// 2b. 删除记忆确认（现行文案 + deleteDocumentIndexes）
out = apply(out,
  `      if (!confirm(\`确定删除「\${j.title || '这条记忆'}」吗？它的向量索引段与关键词记录会一起清理，原始聊天不受影响。\`)) return;
      await backend.delete('journals', j.id);
      await deleteDocumentIndexes(backend, j.id);
      await attachJournals(char);
      renderSettingsBody();
      toast('已删除');`,
  `      showModal('删除记忆', \`<p>确定删除「\${escapeHtml(j.title || '这条记忆')}」吗？它的向量索引段与关键词记录会一起清理，原始聊天不受影响。</p>\`, [{ label: '取消' }, { label: '删除', danger: true, onClick: async () => {
        await backend.delete('journals', j.id);
        await deleteDocumentIndexes(backend, j.id);
        await attachJournals(char);
        renderSettingsBody();
        toast('已删除');
      } }]);`,
  'mem-del confirm');

// 2c. 删除经历确认（新增的第 4 处 confirm）
out = apply(out,
  `          if (!confirm(\`确定删除经历「\${e.title || '这条经历'}」吗？原始聊天不受影响。\`)) return;
          await deleteExperience(backend, e.id);
          await deleteDocumentIndexes(backend, e.id);
          renderSettingsBody();
          toast('已删除');`,
  `          showModal('删除经历', \`<p>确定删除经历「\${escapeHtml(e.title || '这条经历')}」吗？原始聊天不受影响。</p>\`, [{ label: '取消' }, { label: '删除', danger: true, onClick: async () => {
            await deleteExperience(backend, e.id);
            await deleteDocumentIndexes(backend, e.id);
            renderSettingsBody();
            toast('已删除');
          } }]);`,
  'exp-del confirm');

// 2d. 删除角色全部数据确认（开头 + 结尾两处）
out = apply(out,
  `      if (!confirm(\`确定删除「\${char.remarkName || char.realName}」的全部数据吗？建议先导出备份。\`)) return;`,
  `      showModal('删除角色', \`<p>确定删除「\${escapeHtml(char.remarkName || char.realName)}」的全部数据吗？建议先导出备份。</p>\`, [{ label: '取消' }, { label: '删除全部数据', danger: true, onClick: async () => {`,
  'data-delete-char confirm 开头');
out = apply(out,
  `      localStorage.removeItem('uwu-chat.lastChar');
      location.reload();
    });`,
  `        localStorage.removeItem('uwu-chat.lastChar');
        location.reload();
      } }]);
    });`,
  'data-delete-char confirm 结尾');

// 3+4. 预览 hosting CSS（插在 </head> 前）
out = apply(out, '</head>\n<body>',
  `<style>
/* 预览 hosting 适配（不进源码）：关闭态子页不占位；输入行在 iframe flex 下不溢出 */
.subpage:not(.open) { display: none; }
.input-row, .input-shell { min-width: 0; }
</style>
</head>
<body>`,
  '</head>\n<body>');

// 收尾断言
if (out.includes('confirm(')) throw new Error('仍有 confirm( 残留');
if (out.includes('type="module"')) throw new Error('仍有 type="module" 残留');
if (!out.includes('.subpage:not(.open) { display: none; }')) throw new Error('子页 display:none 未注入');
if (!out.includes('.input-row, .input-shell { min-width: 0; }')) throw new Error('min-width:0 未注入');
if (!out.includes("showModal('删除经历'")) throw new Error('经历删除 showModal 未注入');
if (!out.includes("showModal('删除记忆'")) throw new Error('记忆删除 showModal 未注入');
if (!out.includes("showModal('重建索引'")) throw new Error('重建索引 showModal 未注入');
if (!out.includes("showModal('删除角色'")) throw new Error('删除角色 showModal 未注入');

mkdirSync(resolve(root, 'dist-preview'), { recursive: true });
writeFileSync(resolve(root, 'dist-preview/uwu-liao-tian.html'), out, 'utf8');
console.log(`dist-preview/uwu-liao-tian.html 已生成：${out.length} 字节`);
