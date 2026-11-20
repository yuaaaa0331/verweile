import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, resolvePromptVersion, HISTORY_PLACEHOLDER } from '../js/promptBuilder.js';
import { fixtureCharacter, fixtureWorldBooks, fixtureStickers, globalSettings, countOccurrences} from './helpers.mjs';

const char = fixtureCharacter();
const deps = { worldBooks: fixtureWorldBooks(), stickers: fixtureStickers(), globalSettings};

test('TT 是实际生效版本：全局 tt + 角色专属为空 → tt', () => {
assert.equal(resolvePromptVersion(char, globalSettings), 'tt');
assert.equal(resolvePromptVersion(fixtureCharacter({ exclusivePromptVersion: 'uwu'}), globalSettings), 'uwu');
});

test('TT 基线：保留原始措辞与结构，回复 3—8 条', () => {
const { systemPrompt, version} = buildSystemPrompt(char, deps);
assert.equal(version, 'tt');
assert.ok(systemPrompt.includes('[世界定义]'));
assert.ok(systemPrompt.includes('一个真实的线上聊天软件。'));
assert.ok(systemPrompt.includes('[rule=正确理解]'));
assert.ok(systemPrompt.includes('保持角色人格＞迎合讨好朵朵'));
assert.ok(systemPrompt.includes('数量：3-8条短消息'));
assert.ok(systemPrompt.includes(HISTORY_PLACEHOLDER));
assert.ok(systemPrompt.includes('现在，根据用户的最新发言，继续对话吧。'));
// 不催睡
assert.ok(systemPrompt.includes('不要催促我睡觉'));
});

test('TT 基线：裁剪未实现能力，不出现朋友圈/代付/转发/思维链', () => {
const { systemPrompt} = buildSystemPrompt(char, deps);
for (const banned of ['朋友圈', '代付', '下单', '转发聊天记录', '思维链', '<thinking>', '[incipere]', '视频通话', '语音通话']) {
assert.ok(!systemPrompt.includes(banned), `不应出现：${banned}`);
}
// 保留的必要格式仍在
for (const kept of ['普通消息', '撤回消息', '图片消息', '语音消息', '引用消息', '双语消息', '转账消息', '礼物消息', '状态更新', '已接收礼物']) {
assert.ok(systemPrompt.includes(kept), `应保留：${kept}`);
}
});

test('世界书四位置 + depth 排序 + 只取绑定 ID', () => {
const { systemPrompt} = buildSystemPrompt(char, deps);
assert.ok(systemPrompt.includes('破限：世界是真实的线上聊天。'));
assert.ok(systemPrompt.includes('前置2：养了一只猫。'));
assert.ok(systemPrompt.indexOf('前置2') < systemPrompt.indexOf('前置：住在同一条街'), 'before 应按 depth 升序');
assert.ok(!systemPrompt.includes('未绑定的世界书'));
assert.ok(systemPrompt.includes('后置：不喜欢吃香菜。'));
assert.ok(systemPrompt.includes('准则：说话别太正式。'));
});

test('只注入收藏记忆；只列绑定分组的表情包；双语与状态栏后缀', () => {
const { systemPrompt} = buildSystemPrompt(char, deps);
assert.ok(systemPrompt.includes('第一次见面'));
assert.ok(!systemPrompt.includes('没收藏的'));
assert.ok(systemPrompt.includes('贴贴') && systemPrompt.includes('哼'));
assert.ok(!systemPrompt.includes('未分类的') &&!systemPrompt.includes('别组的'));
assert.ok(systemPrompt.includes('双语消息'));
assert.ok(systemPrompt.includes('状态栏：显示心情与位置。'));
});

test('覆盖层：用户编辑覆盖基线，清空即恢复默认；相关记忆默认空不注入', () => {
const over = buildSystemPrompt(fixtureCharacter({ promptOverride: '自定义覆盖层'}), deps);
assert.equal(over.systemPrompt, '自定义覆盖层');
const empty = buildSystemPrompt(char, {...deps, relatedMemories: []});
assert.ok(!empty.systemPrompt.includes('相关记忆'));
const withMem = buildSystemPrompt(char, {...deps, relatedMemories: [{ title: '检索到的', content: '某事', source: 'vector（待接入）'}]});
assert.ok(withMem.systemPrompt.includes('检索到的'));
});

test('UWU 默认分支：无占位符、3—8 条、无朋友圈/通话/转发', () => {
const c = fixtureCharacter({ exclusivePromptVersion: 'uwu'});
const { systemPrompt, hasHistoryPlaceholder} = buildSystemPrompt(c, deps);
assert.equal(hasHistoryPlaceholder, false);
assert.ok(systemPrompt.includes('你正在一个名为“404”的线上聊天软件中扮演一个角色'));
assert.ok(systemPrompt.includes('每次回复3-8条消息之内'));
for (const banned of ['朋友圈', '代付', '转发', '视频通话', 'HTML模块']) {
assert.ok(!systemPrompt.includes(banned), `UWU 不应出现：${banned}`);
}
void countOccurrences;
});
