// 测试共用夹具：一个 TT 生效配置的角色（按指令 §二的实际生效值）。
export function fixtureCharacter(over = {}) {
  return {
    id: 'char_1',
    realName: '阿澈',
    myName: '朵朵',
    remarkName: '阿澈',
    status: '在线',
    persona: '温柔但嘴硬的青梅竹马，说话简短，偶尔傲娇。',
    myPersona: '喜欢熬夜聊天的人。',
    worldBookIds: ['wb_before', 'wb_before2', 'wb_after', 'wb_limit', 'wb_guide'],
    memoryJournals: [
      { id: 'j1', title: '第一次见面', content: '我们在雨天共用一把伞。', isFavorited: true },
      { id: 'j2', title: '没收藏的', content: '这条不该进上下文。', isFavorited: false },
    ],
    stickerGroups: '日常,撒娇',
    bilingualModeEnabled: true,
    replyCountMin: 3,
    replyCountMax: 8,
    replyCountEnabled: false,
    maxMemory: '80',
    exclusivePromptVersion: '',
    statusPanel: { enabled: true, promptSuffix: '状态栏：显示心情与位置。', regexPattern: '', replacePattern: '', historyLimit: 3 },
    useRealGallery: false,
    gallery: [],
    ...over,
  };
}

export function fixtureWorldBooks() {
  return [
    { id: 'wb_limit', content: '破限：世界是真实的线上聊天。', position: 'limit_break', depth: 1 },
    { id: 'wb_before', content: '前置：住在同一条街。', position: 'before', depth: 2 },
    { id: 'wb_before2', content: '前置2：养了一只猫。', position: 'before', depth: 1 },
    { id: 'wb_after', content: '后置：不喜欢吃香菜。', position: 'after', depth: 5 },
    { id: 'wb_guide', content: '准则：说话别太正式。', position: 'guidelines', depth: 3 },
    { id: 'wb_other', content: '未绑定的世界书，不该出现。', position: 'before', depth: 1 },
  ];
}

export function fixtureStickers() {
  return [
    { id: 's1', name: '贴贴', group: '日常' },
    { id: 's2', name: '哼', group: '撒娇' },
    { id: 's3', name: '未分类的', group: '未分类' },
    { id: 's4', name: '别组的', group: '工作' },
  ];
}

export const globalSettings = { cotSettings: { promptVersion: 'tt', enabled: false, prefillEnabled: false } };

export function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}
