/**
 * MacKit · 模块清单（**前后端唯一事实源**）
 *
 * 为什么放在 web/ 下：静态服务器只把 `web/` 暴露给浏览器，所以浏览器能 import 的文件必须在
 * 这一层；而后端（node）用相对路径 import 任何位置都没有限制 —— 于是这一个文件就能同时被
 * 两边的代码读到。放在别处就必须复制一份，等于把"两处手工同步"这个老问题再引回来。
 *
 * 它取代了此前**三处手工登记**（少登记一处就是"设置了却不生效"或"页面空白"）：
 *   · 后端加载哪些模块   → server.js 的 MODULE_FILES
 *   · 侧边栏有哪些入口   → app.js 的 NAV
 *   · 前端按 id 动态导入  → app.js 的 VIEW_MODULES
 *
 * 字段：
 *   id       模块 id —— **后端注册表键**（`registry.get(id)`），
 *            也是前端 `runTask(module, …)` 里要填的那个名字
 *   viewId   前端路由 / 视图 id（缺省 = id）。只有「备份中心」不同：后端叫 backup、前端叫 backups
 *            （历史原因：后端文件是 lib/backup.js，而前端路由是 #/backups）。刻意保留两者，
 *            避免改动既有的哈希链接与后端契约。
 *   title    侧边栏与标题用的名字
 *   icon     app.js 里 ICON 表的键（没有图标就不渲染）
 *   view     前端视图文件（相对 app.js 的路径）；null = 没有独立页面
 *   backend  后端模块文件（相对 app/lib/）；null = 纯前端页面（如总览）
 *   nav      是否出现在侧边栏（默认 true）
 */
export const MODULES = Object.freeze([
  {
    id: 'dashboard',
    title: '总览',
    icon: 'home',
    view: './views/dashboard.js',
    backend: null,
  },
  {
    id: 'brew',
    title: 'Homebrew 管家',
    icon: 'beer',
    view: './views/brew.js',
    backend: 'brew.js',
  },
  {
    id: 'sysinit',
    title: '系统初始化',
    icon: 'gear',
    view: './views/sysinit.js',
    backend: 'sysinit.js',
  },
  {
    id: 'rime',
    title: 'Rime 输入法',
    icon: 'ime',
    view: './views/rime.js',
    backend: 'rime.js',
  },
  {
    id: 'unseal',
    title: '应用解隔离',
    icon: 'lock',
    view: './views/unseal.js',
    backend: 'unseal.js',
  },
  {
    // LibreTV：托管官方 Next.js standalone 预构建包（下载 → 解压 → 常驻子进程）。
    // 不内置任何点播 / 直播源，只把官方包体跑起来；安装 / 更新要连 GitHub，
    // 因此开通道档位（实测直连 7KB/s，代理 1.4MB/s）。
    id: 'libretv',
    title: 'LibreTV',
    icon: 'film',
    view: './views/libretv.js',
    backend: 'libretv.js',
  },
  {
    id: 'backup',          // 后端注册表键与 runTask('backup', …) 用这个
    viewId: 'backups',     // 前端路由 #/backups
    title: '备份中心',
    icon: 'backups',
    view: './views/backups.js',
    backend: 'backup.js',
  },
  {
    // 没有独立页面：入口在「总览」页的 MacKit 自更新卡片里，所以 nav 关掉。
    id: 'selfupdate',
    title: 'MacKit 自更新',
    icon: null,
    view: null,
    backend: 'selfupdate.js',
    nav: false,
  },
]);

/** 侧边栏顺序 = 清单顺序（过滤掉 nav:false 的）。 */
export const NAV_MODULES = MODULES.filter((m) => m.nav !== false);

/** 后端模块 id → 文件名。 */
export const BACKEND_MODULES = MODULES.filter((m) => m.backend);
