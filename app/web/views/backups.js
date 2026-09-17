/**
 * MacKit · 备份中心（视图）
 *
 * 2026-09-17 重做：**手动导出 / 导入本地 JSON 文件已整体移除**，本页只保留
 * 「☁ WebDAV 备份」区块（备份 / 查看记录 / 配置 WEBDAV）。自动备份（集中备份 /
 * 原地 .bak）已于 2026-09-16 移除，因此本页是配置迁移的唯一入口。
 *
 * 相关接口（实现见 views/backups-webdav.js）：
 *   - GET  /api/webdav/config            → 脱敏配置（永不回显密码）
 *   - PUT  /api/webdav/config            → 保存配置 + 自动探测
 *   - GET  /api/webdav/backups           → 远程备份记录列表
 *   - POST /api/tasks  module=backup     action=webdav_backup|webdav_restore|webdav_delete
 *
 * 备份内容：MacKit 设置 · 代理端口/镜像 · Git 全局配置 · 钥匙串 GitHub 凭据（明文 Token）
 *           · Rime 全部 *.custom.yaml + 已装 .gram 清单。
 * 词库 / 万象模型等大文件不打包，恢复后按需重新下载。
 *
 * 契约（对齐 web/app.js 顶部说明）：默认导出 { id, title, mount(root, ctx) }。
 * 侧边栏图标由 app.js 的 NAV 统一提供，视图不再自带。
 */

// WebDAV 备份区块 + 弹窗：非路由子模块（必须落在 web/ 下，由本文件相对引入；
// 切勿把它加进 app.js 的 VIEW_MODULES，否则会多出一个空白路由页）。
import { buildWebdavSection } from './backups-webdav.js';

export default {
  id: 'backups',
  title: '备份中心',

  mount(root, ctx) {
    const { el } = ctx;
    const head = el('div', { class: 'view-head' });
    const body = el('div');
    root.append(head, body);

    head.append(
      el('div', {}, [
        el('h1', { text: '备份中心' }),
        el('div', { class: 'muted', text: '把本机配置备份到你的 WebDAV 服务器（NAS）· 换电脑一键恢复' }),
      ]),
    );
    body.append(buildWebdavSection(ctx));
  },

  unmount() { /* 订阅由 app.js 统一回收 */ },
};
