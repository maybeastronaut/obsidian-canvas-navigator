# Canvas Navigator Architecture

## Overview

插件以 `CanvasNavigatorPlugin` 为装配入口，按“导航渲染 / 白板索引 / 白板同步 / 设置 / UI”分层。

## Module responsibilities

- `plugin/CanvasNavigatorPlugin.ts`
  - 生命周期入口（`onload` / `onunload`）
  - 服务初始化与命令注册
  - 工作区事件订阅与视图刷新调度
- `features/navigation/`
  - `navigationService.ts`：基于 frontmatter 计算 breadcrumb 路径与前后邻接
  - `navigationRenderer.ts`：渲染顶部导航 DOM，处理点击与菜单跳转，并通过观察器在内容区重建后自动自愈
- `features/canvas/`
  - `canvasTypes.ts`：canvas 相关内部类型边界
  - `canvasIndexService.ts`：维护 canvas -> note 与 note -> canvas 双向索引（优先使用 `metadataCache.resolvedLinks`，缺失时回退 JSON 解析）
  - `squarePathRouter.ts`：strict square 路径规划核心（U/Z/L/绕行路径与 SVG path 生成）
  - `canvasSquareRenderService.ts`：strict square 运行时渲染补丁（包装 runtime edge 的 `updatePath`，按“默认模式 + 边级别设置”决定是否 square）
  - `noteNodeContent.ts`：笔记卡片文本抽取与动态尺寸测量
  - `canvasSyncService.ts`：引用查询、自动同步（去抖）、节点创建、Group 校正、连线路径批量/选中修改（square/native）
- `ui/canvasReferencesModal.ts`
  - 展示 Existing / Add+ 结果，处理打开 canvas 与聚焦节点
- `settings/`
  - `settings.ts`：设置类型与默认值
  - `settingsTab.ts`：设置面板渲染与持久化
- `utils/`
  - `linkUtils.ts`：frontmatter 链接解析、匹配、解析到文件
  - `nameUtils.ts`：展示名清洗
- `constants/layout.ts`
  - 卡片尺寸测量常量

## Runtime flow

1. 插件加载后初始化服务，注册命令与事件。
2. 视图变化时由 navigation renderer 刷新 markdown 顶部导航栏。
3. canvas 索引在启动后批量构建，优先复用 Obsidian 已解析链接并对缺失项回退解析。
4. 当 markdown 文件变化且被 canvas 引用时，触发去抖后的自动同步。
5. 用户执行智能命令时，根据当前文件类型进入“查询/添加”或“Group 校正”流程。
6. 用户可通过设置项指定默认连线路径模式；命令可按全白板或仅选中连线切换 `square/native`。
7. markdown 视图 DOM 变化（如切换阅读模式或视图重建）时，breadcrumb 会自动重渲染并保持在顶部首位。

## Invariants

- 命令 ID、设置键、manifest 字段与用户可见文案保持不变。
- 构建入口仍为 `src/main.ts`，发布产物仍为根目录的 `main.js` / `manifest.json` / `styles.css`。

## Attribution

- strict square 路由的几何策略基于 Advanced Canvas 的 square pathfinding 思路进行移植与适配。
