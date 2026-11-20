// manage.js — 管理页：角色卡片、分组入口行、二级页外壳、设计变量页。
// 只做界面与导航；各二级页的内容由调用方（app.js 的设置渲染器 / ThemeStore）填充。
// 不依赖 app.js 的具体函数；角色与数量通过 init 传入的 getState 回调读取。

export const ManageView = (() => {
  const GROUPS = [
    {
      label: '角色与内容',
      rows: [
        { id: 'persona', icon: 'user', name: '人设', desc: '角色名、人设、提示词版本' },
        { id: 'worldbook', icon: 'book', name: '世界书', desc: '', count: (s) => `${(s.worldBooks || []).length} 本` },
        { id: 'prompt', icon: 'file', name: '提示词', desc: '', count: (s) => `${s.promptVersion || 'TT'} 模板` },
        { id: 'stickers', icon: 'smile', name: '贴纸', desc: '', count: (s) => `${(s.stickers || []).length} 张` },
      ],
    },
    {
      label: '记忆与上下文',
      rows: [
        { id: 'memory', icon: 'clock', name: '记忆', desc: '', count: (s) => `${(s.journals || []).length} 条` },
        { id: 'context', icon: 'eye', name: '上下文预览', desc: '本次发送内容的 Token 构成' },
      ],
    },
    {
      label: '连接',
      rows: [
        { id: 'api', icon: 'key', name: 'API 设置', desc: '', count: (s) => (s.apiSettings?.key ? (s.apiSettings.model || '已配置') : '模拟模式') },
        { id: 'mcp', icon: 'server', name: 'MCP', desc: '', count: () => '未接入' },
      ],
    },
    {
      label: '数据与外观',
      rows: [
        { id: 'data', icon: 'download', name: '数据管理', desc: '导入、导出、自检' },
        { id: 'appearance', icon: 'sliders', name: '外观与背景', desc: '背景图、文字与气泡、玻璃材质' },
        { id: 'tokens', icon: 'grid', name: '设计变量', desc: '颜色、圆角、间距、玻璃参数' },
      ],
    },
  ];

  let getState = null;
  let onRowClick = null;
  let currentSub = null;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  function renderGroups() {
    const host = document.getElementById('manage-groups');
    if (!host) return;
    host.innerHTML = '';
    const s = getState ? getState() : {};
    for (const g of GROUPS) {
      host.appendChild(el('div', 'group-label', g.label));
      const group = el('div', 'group');
      for (const r of g.rows) {
        const row = el('button', 'm-row');
        row.dataset.page = r.id;
        const ico = el('span', 'm-ico');
        ico.appendChild(icon(r.icon));
        row.appendChild(ico);
        const main = el('span', 'm-main');
        main.appendChild(el('span', 'm-name', r.name));
        if (r.desc) main.appendChild(el('span', 'm-desc', r.desc));
        row.appendChild(main);
        const count = r.count ? r.count(s) : '';
        if (count) row.appendChild(el('span', 'm-count', count));
        const chev = el('span', 'm-chev');
        chev.appendChild(icon('chev-r'));
        row.appendChild(chev);
        row.addEventListener('click', () => {
          if (onRowClick) onRowClick(r.id);
        });
        group.appendChild(row);
      }
      host.appendChild(group);
    }
  }

  function renderCharCard(avatarUrl) {
    const s = getState ? getState() : {};
    const c = s.char || {};
    const card = document.getElementById('manage-char-card');
    if (!card) return;
    const avatar = card.querySelector('.char-card-avatar');
    if (avatar) {
      if (avatarUrl) { avatar.src = avatarUrl; avatar.style.display = ''; }
      else { avatar.style.display = 'none'; }
    }
    const name = card.querySelector('.char-card-name');
    if (name) name.textContent = c.remarkName || c.realName || '角色';
    const sub = card.querySelector('.char-card-sub');
    if (sub) {
      sub.textContent = `人设 · 世界书 ${(s.worldBooks || []).length} 本 · 记忆 ${(s.journals || []).length} 条 · 贴纸 ${(s.stickers || []).length} 张`;
    }
  }

  return {
    init(opts = {}) {
      if (typeof opts.getState === 'function') getState = opts.getState;
      if (typeof opts.onRowClick === 'function') onRowClick = opts.onRowClick;
      document.querySelectorAll('[data-sub-close]').forEach((b) => {
        b.addEventListener('click', () => this.closeSubpage());
      });
      const card = document.getElementById('manage-char-card');
      if (card) {
        card.addEventListener('click', () => {
          if (onRowClick) onRowClick('persona');
        });
      }
      renderGroups();
    },

    /** 刷新管理首页的角色卡与各行计数（角色/世界书/记忆/贴纸/API 变化后调用）。 */
    refreshHome(avatarUrl) {
      renderCharCard(avatarUrl);
      renderGroups();
    },

    /** 打开二级页，返回该页的 .sub-body（调用方往里面填内容）。 */
    openSubpage(id) {
      const page = document.getElementById(`sub-${id}`);
      if (!page) return null;
      this.closeSubpage();
      currentSub = id;
      page.classList.add('open');
      return page.querySelector('.sub-body');
    },

    closeSubpage() {
      if (!currentSub) return;
      document.getElementById(`sub-${currentSub}`)?.classList.remove('open');
      currentSub = null;
    },

    getCurrentSub() { return currentSub; },

    /** 设计变量页：只做展示，不改任何设置。 */
    renderTokensPage(container) {
      if (!container) return;
      const cs = getComputedStyle(document.documentElement);
      const get = (name) => (cs.getPropertyValue(name) || '').trim();
      container.innerHTML = '';
      const intro = el('p', 'muted', '本页只展示设计变量，改动请去「外观与背景」。圆角与玻璃填充以 :root 为准。');
      container.appendChild(intro);
      const colorCard = el('div', 'card');
      colorCard.appendChild(el('h3', '', '颜色'));
      const grid = el('div', 'token-grid');
      for (const [name, value] of [
        ['文字 ink', get('--ink') || '#1d1d1f'],
        ['次要文字', get('--ink-2') || '#515154'],
        ['弱化文字', get('--ink-3') || '#86868b'],
        ['主题蓝', get('--accent') || '#0071e3'],
        ['深蓝', get('--accent-deep') || '#0060c9'],
        ['我方气泡', get('--bubble-me') || '#d6ebff'],
        ['对方气泡', get('--bubble-ai') || 'rgba(255,255,255,.62)'],
        ['在线绿', '#34c759'],
      ]) {
        const cell = el('div', 'token-cell');
        const sw = el('span', 'token-swatch');
        sw.style.background = value;
        cell.appendChild(sw);
        cell.appendChild(el('span', 'token-name', name));
        cell.appendChild(el('span', 'token-value', value));
        grid.appendChild(cell);
      }
      colorCard.appendChild(grid);
      container.appendChild(colorCard);
      const shapeCard = el('div', 'card');
      shapeCard.appendChild(el('h3', '', '圆角 / 间距 / 玻璃'));
      const mono = el('pre', 'mono-block', [
        `大卡片 ${get('--r-lg') || '28px'} · 中卡片 ${get('--r-md') || '22px'} · 小圆角 ${get('--r-sm') || '14px'} · 气泡 ${get('--r-bubble') || '22px'}`,
        '页面边距 14 · 卡片内距 16 · 消息间距 3 · 头像 42 / 30 · 触控目标 ≥ 40',
        '玻璃：填充 rgba(255,255,255,.06) · 雾化 8px · 边缘高光上限 0.45',
        '亮度钳制：相对壁纸 +0.10 / -0.16 · 光源强度默认 55% · 白色染色 2%',
        '图标：单色描边 currentColor · 线宽 1.8 · 22px（小 18 / 大 25）',
      ].join('\n'));
      shapeCard.appendChild(mono);
      container.appendChild(shapeCard);
    },
  };
})();
