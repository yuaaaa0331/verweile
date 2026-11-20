// mockReply.js — 无密钥时的本地模拟回复（明确标注“模拟”，绝不冒充真实 API 成功）。
// 只用 TT 协议格式产出 2—4 条气泡，供界面预览与自检使用；
// 表情包只从角色已绑定的分组里取，取不到就不发。

export function mockReplyText(character, userText, stickers = []) {
  const rn = character?.realName || '对方';
  const mn = character?.myName || '我';
  const bilingual = !!character?.bilingualModeEnabled;
  const groups = String(character?.stickerGroups || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const allowed = stickers.filter((s) => groups.includes(s.group));
  const lines = [];
  const plain = (t) => `[${rn}的消息：${t}]`;
  const bi = (f, c) => `[${rn}的消息：${f}「${c}」]`;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  const openers = bilingual
    ? [bi('Hey, I\'m here.', '嘿，我在呢。'), bi('You finally texted me.', '你终于给我发消息了。')]
    : [plain('在呢，怎么啦'), plain('刚看到，你说')];
  lines.push(pick(openers));
  const mids = bilingual
    ? [bi('That sounds nice, tell me more.', '听起来不错，再跟我说说。'), bi('Hmm, let me think about it.', '嗯，让我想想。')]
    : [plain('嗯嗯，然后呢'), plain('哈哈，这个我懂'), plain('你继续说，我听着')];
  lines.push(pick(mids));
  if (allowed.length && Math.random() < 0.5) {
    lines.push(`[${rn}的表情包：${pick(allowed).name}]`);
  }
  if (Math.random() < 0.3) {
    lines.push(plain('对了，今天过得怎么样'));
  }
  void mn; void userText;
  return lines.join('\n');
}

export const MOCK_BADGE = '模拟回复 · 未调用真实 API';
