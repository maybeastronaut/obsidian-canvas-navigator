# Canvas Navigator

Obsidian 的面包屑导航 + 白板联动插件。

## 功能概览

- 在笔记顶部显示 breadcrumb 与前后导航按钮（基于 frontmatter 的 `up` / `prev` / `next`）
- 查询当前笔记与 canvas 的现有引用和潜在关联
- 将笔记智能添加到 canvas，并自动创建对应 Group
- 笔记更新后自动同步相关 canvas 卡片内容
- 在 canvas 内一键校正 Group 与目标卡片尺寸
- 在 canvas 内一键将连线路径改为 square 类型
  - 若启用了 Advanced Canvas：写入扩展字段并使用其原生 square 能力
  - 若未启用：自动启用本插件的 strict square 运行时渲染模式（直接移植 square 路由核心算法）
- 支持设置默认连线路径模式（square / native）
- 支持在 canvas 页面直接修改选中连线为 square / native（命令面板）
- 增强 breadcrumb 稳定性：视图重绘后自动自愈，顶部位置自动纠正与去重

## 本版本更新

- 新增设置项：`Default canvas edge path mode`（`Native` / `Square`）
- 新增命令：`Set canvas edges to native path`
- 新增命令：`Set selected canvas edges to square path`
- 新增命令：`Set selected canvas edges to native path`
- 优化 breadcrumb 顶部渲染稳定性（DOM 变化后自动重渲染）

## 命令清单

- `check-canvas-references`：Check canvas references / Adjust groups in canvas
- `set-canvas-edges-square`：Set canvas edges to square path
- `set-canvas-edges-native`：Set canvas edges to native path
- `set-selected-canvas-edges-square`：Set selected canvas edges to square path
- `set-selected-canvas-edges-native`：Set selected canvas edges to native path
- `toggle-breadcrumb-nav`：Toggle/refresh breadcrumb nav

## 设置项

- `Enable navigation bar`：控制顶部 breadcrumb 与前后按钮显示
- `Default canvas edge path mode`：设置默认连线路径模式（`Native` / `Square`）

## 开发命令

```bash
npm install
npm run dev
npm run build
npm run lint
```

## 目录结构

```text
src/
  main.ts
  plugin/
    CanvasNavigatorPlugin.ts
  settings/
    settings.ts
    settingsTab.ts
  features/
    navigation/
      navigationService.ts
      navigationRenderer.ts
    canvas/
      canvasTypes.ts
      canvasIndexService.ts
      canvasSyncService.ts
      canvasSquareRenderService.ts
      noteNodeContent.ts
      squarePathRouter.ts
  ui/
    canvasReferencesModal.ts
  utils/
    linkUtils.ts
    nameUtils.ts
  constants/
    layout.ts
docs/
  architecture.md
```

架构说明见 [docs/architecture.md](docs/architecture.md)。

## License and attribution

- 本仓库当前许可证：`GPL-3.0-or-later`。
- `strict square` 路由实现参考并移植自 [obsidian-advanced-canvas](https://github.com/Developer-Mike/obsidian-advanced-canvas) 的 square pathfinding 逻辑（见 `NOTICE`）。
