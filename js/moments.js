// moments.js — 动态页（本轮只做视觉原型）。
// 内容是写死的虚拟数据，不接真实数据库、不接角色数据；
// 角色状态与私人生活动态的真实接入是后续阶段。
// 点赞 / 展开评论只改本地显示状态，不写库。
// 本模块不依赖 app.js；交互回调由调用方在 init 时传入。

export const MomentsView = (() => {
  const HERO = {
    name: 'Noah',
    mono: '雨停了，楼下的桂花很香，晚上一起去散步。',
  };
  const POSTS = [
    {
      id: 'post_1', name: 'Noah', time: '今天 10:02',
      body: '年糕学会了新把戏——听到开门声就叼着牵引绳等在门口，尾巴摇得像要起飞。',
      photo: true, likes: 12, liked: false,
      comments: [{ name: '我', text: '它明明是想出去玩，装得像在等你。' }],
    },
    {
      id: 'post_2', name: 'Noah', time: '昨天 21:47',
      body: '旧书店淘到一本有批注的诗集，前任主人的字比诗还有意思。',
      photo: false, likes: 8, liked: false,
      comments: [],
    },
    {
      id: 'post_3', name: 'Noah', time: '昨天 18:20',
      body: '做了热可可，多放了一块巧克力，甜得刚刚好。',
      photo: false, likes: 5, liked: false,
      comments: [{ name: '我', text: '留一杯，我下班就到。' }],
    },
  ];

  let onCompose = null;

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

  function avatarEl(size) {
    const a = el('div', 'avatar-ph');
    if (size) a.style.cssText = `width:${size}px;height:${size}px`;
    a.textContent = 'n';
    return a;
  }

  function renderPost(post) {
    const card = el('article', 'post');
    const head = el('div', 'post-head');
    head.appendChild(avatarEl(38));
    const meta = el('div', 'post-meta');
    meta.appendChild(el('div', 'post-name', post.name));
    meta.appendChild(el('div', 'post-time', post.time));
    head.appendChild(meta);
    card.appendChild(head);
    card.appendChild(el('div', 'post-body', post.body));
    if (post.photo) {
      const ph = el('div', 'post-photo');
      ph.appendChild(el('span', 'photo-poem', '느린 하루'));
      ph.appendChild(el('span', 'photo-caption', 'a slower kind of day')); 
      card.appendChild(ph);
    }
    const actions = el('div', 'post-actions');
    const like = el('button', 'post-action' + (post.liked ? ' liked' : ''));
    like.appendChild(icon('heart'));
    like.appendChild(el('span', '', String(post.likes)));
    like.addEventListener('click', () => {
      post.liked = !post.liked;
      post.likes += post.liked ? 1 : -1;
      like.classList.toggle('liked', post.liked);
      like.querySelector('span').textContent = String(post.likes);
    });
    const comment = el('button', 'post-action');
    comment.appendChild(icon('chat'));
    comment.appendChild(el('span', '', String(post.comments.length)));
    const commentList = el('div', 'post-comments hidden');
    for (const c of post.comments) {
      const row = el('div', 'post-comment');
      row.appendChild(el('b', '', `${c.name}：`));
      row.appendChild(document.createTextNode(c.text));
      commentList.appendChild(row);
    }
    if (!post.comments.length) commentList.appendChild(el('div', 'post-comment muted', '还没有评论。'));
    comment.addEventListener('click', () => commentList.classList.toggle('hidden'));
    actions.append(like, comment);
    card.append(actions, commentList);
    return card;
  }

  return {
    init(opts = {}) {
      if (typeof opts.onCompose === 'function') onCompose = opts.onCompose;
    },

    /** 渲染动态页（虚拟数据）。container：#moments-scroll。 */
    render(container) {
      if (!container) return;
      container.innerHTML = '';
      const hero = el('div', 'hero-card glass');
      hero.appendChild(avatarEl(56));
      const heroInfo = el('div', 'hero-info');
      heroInfo.appendChild(el('div', 'hero-name', HERO.name));
      const mono = el('div', 'hero-mono', HERO.mono);
      heroInfo.appendChild(mono);
      hero.appendChild(heroInfo);
      container.appendChild(hero);
      for (const p of POSTS) container.appendChild(renderPost(p));
      const foot = el('p', 'muted moments-foot', '示例动态 · 仅供预览');
      container.appendChild(foot);
    },

    compose() {
      if (onCompose) onCompose();
    },
  };
})();
