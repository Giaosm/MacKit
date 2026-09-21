/**
 * MacKit · 前端纯函数：Homebrew 元数据同步状态的「前后对比」决策
 *
 * 背景：服务端启动后会自动跑一次 `brew update`（实测 1.7~3.2s）来刷新「可更新」判定所依赖的
 * 元数据；同步成功后需要把体检结果重算一次，界面上的数字才是真值。
 *
 * ★ 为什么比较时间戳，而不是看 `refreshing` 的跳变（2026-09-21 修）：
 *   `/api/health` 是 15s 轮询，而一次同步只要 ~2s —— 「refreshing: true」那段中间态大概率整个
 *   被轮询错过，于是「同步完成」永远不会被发现，界面就一直停在同步前的数字上。
 *   比较 `refreshedAt` / `failedAt` 是否**变新**与轮询频率无关，怎么错开都能发现。
 *
 * 与 reltime.js 同款：本文件只做纯计算，不碰 DOM、不发请求（便于单测）。
 */

/**
 * 对比两次 `/api/health` 里的 `brewMeta`，得出「这次该做什么」。
 *
 * @param {{refreshedAt?:number|null, failedAt?:number|null}|null} [prev] 上一次的状态
 * @param {{refreshedAt?:number|null, failedAt?:number|null, lastError?:string|null}|null} [next] 本次的状态
 * @returns {{refreshed:boolean, failed:boolean}}
 *   refreshed：元数据刚刚同步成功（refreshedAt 变新）→ 调用方应重算体检并提示成功；
 *   failed   ：同步刚刚失败（failedAt 变新）→ 调用方应提示失败（不重算，数字本来就没变）。
 *   两者互斥：同一次同步不可能既成功又失败。
 *   prev 为空（页面刚打开的第一次采样）→ 两者都为 false：先建立基线，只看页面打开期间的变化。
 */
export function diffMetaState(prev, next) {
  const p = prev || null;
  const n = next || {};
  // ★ 首次拿到状态（页面刚打开时 prev 为 null）一律不作动作：
  //   此刻页面自己的体检（mount 时那次 /api/env）已经反映了当前元数据，若把「已有 refreshedAt」
  //   误判成「刚刚同步」，每次刷新页面都会白跑一次强制体检 + 弹一次「已同步」（2026-09-21 修）。
  //   我们只关心**页面打开期间**发生的变化，所以必须先有一个基线。
  if (!p) return { refreshed: false, failed: false };
  const at = typeof n.refreshedAt === 'number' ? n.refreshedAt : null;
  const prevAt = typeof p.refreshedAt === 'number' ? p.refreshedAt : null;
  const failedAt = typeof n.failedAt === 'number' ? n.failedAt : null;
  const prevFailedAt = typeof p.failedAt === 'number' ? p.failedAt : null;
  return {
    refreshed: at !== null && at !== prevAt,
    failed: failedAt !== null && failedAt !== prevFailedAt,
  };
}
