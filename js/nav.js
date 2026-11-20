// nav.js — 三页导航（聊天 / 动态 / 管理）与底部悬浮胶囊 Tab 栏。
// 不依赖 app.js；只操作 index.html 里的 .view 与 .tabbar。
// 动态角标：第一次进入动态页后消失（原型行为）。

export const NavShell = (() => {
  const VIEWS = ['chat', 'moments', 'manage'];
  let current = 'chat';
  let badgeSeen = false;

  function placePill() {
    const pill = document.getElementById('tab-pill');
    const active = document.querySelector('.tabbar .tab.active');
    if (!pill || !active) return;
    pill.style.left = `${active.offsetLeft}px`;
    pill.style.width = `${active.offsetWidth}px`;
  }

  function switchView(name) {
    if (!VIEWS.includes(name)) return;
    current = name;
    for (const v of VIEWS) {
      document.getElementById(`view-${v}`)?.classList.toggle('active', v === name);
    }
    document.querySelectorAll('.tabbar .tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.view === name);
      t.setAttribute('aria-selected', String(t.dataset.view === name));
      t.tabIndex = t.dataset.view === name ? 0 : -1;
    });
    if (name === 'moments' && !badgeSeen) {
      badgeSeen = true;
      document.getElementById('moments-badge')?.classList.add('hidden');
    }
    placePill();
  }

  return {
    getCurrent() { return current; },
    switchView,
    placePill,

    init() {
      document.querySelectorAll('.tabbar .tab').forEach((t) => {
        t.addEventListener('click', () => switchView(t.dataset.view));
        t.tabIndex = t.classList.contains('active') ? 0 : -1;
        t.addEventListener('keydown', (e) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
          e.preventDefault();
          const n = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (VIEWS.indexOf(current) + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
          switchView(VIEWS[n]); document.querySelector(`[data-view="${VIEWS[n]}"]`)?.focus();
        });
      });
      window.addEventListener('resize', placePill);
      // 字体与布局稳定后再定位一次胶囊，避免初次偏移。
      requestAnimationFrame(placePill);
      setTimeout(placePill, 300);
    },
  };
})();
