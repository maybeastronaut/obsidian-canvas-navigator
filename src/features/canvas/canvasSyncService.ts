import { App, Notice, TFile } from 'obsidian';

import { CanvasReferencesModal } from '../../ui/canvasReferencesModal';
import { parseLinks, resolveFile } from '../../utils/linkUtils';
import type {
    CanvasData,
    CanvasEdge,
    CanvasEdgePathMode,
    CanvasNode,
    CanvasRuntimeEdge,
    CanvasView,
    ReferenceResult,
} from './canvasTypes';
import { CanvasIndexService } from './canvasIndexService';
import { NoteNodeContentService } from './noteNodeContent';

export class CanvasSyncService {
    private autoSyncTimers = new Map<string, number>();
    private readonly AUTO_SYNC_DEBOUNCE_MS = 500;

    constructor(
        private app: App,
        private canvasIndexService: CanvasIndexService,
        private noteNodeContentService: NoteNodeContentService,
    ) {}

    async scanCanvasFiles(targetFile: TFile) {
        const resultMap = new Map<string, ReferenceResult>();
        const targetPath = targetFile.path;
        const existingCanvasPaths = this.canvasIndexService.getCanvasPathsReferencing(targetPath);

        for (const canvasPath of existingCanvasPaths) {
            const canvasFile = this.app.vault.getAbstractFileByPath(canvasPath);
            if (canvasFile && canvasFile instanceof TFile) {
                resultMap.set(canvasPath, { file: canvasFile, type: 'existing' });
            }
        }

        const potentialCanvases = this.findPotentialCanvases(targetFile);
        for (const canvas of potentialCanvases) {
            if (resultMap.has(canvas.path)) continue;
            resultMap.set(canvas.path, { file: canvas, type: 'potential' });
        }

        const results = Array.from(resultMap.values());

        if (results.length > 0) {
            new CanvasReferencesModal(this.app, results, targetFile, {
                syncNodeInCanvas: this.syncNodeInCanvas.bind(this),
                addToCanvas: this.addToCanvas.bind(this),
            }).open();
        } else {
            new Notice('未找到现有引用或潜在的白板关联。');
        }
    }

    findPotentialCanvases(startFile: TFile): TFile[] {
        const potentials: TFile[] = [];
        const queue: TFile[] = [startFile];
        const visited = new Set<string>([startFile.path]);

        while (queue.length > 0) {
            const curr = queue.shift();
            if (!curr) continue;

            const cache = this.app.metadataCache.getFileCache(curr);
            if (!cache) continue;

            const canvasLinks = parseLinks(cache?.frontmatter?.canvas);
            if (canvasLinks.length > 0) {
                canvasLinks.forEach(link => {
                    const f = resolveFile(this.app, link);
                    if (f && f.extension === 'canvas') {
                        potentials.push(f);
                    }
                });
            }

            const upLinks = parseLinks(cache?.frontmatter?.up);
            upLinks.forEach(link => {
                const parent = resolveFile(this.app, link);
                if (parent && !visited.has(parent.path)) {
                    visited.add(parent.path);
                    queue.push(parent);
                }
            });
        }

        return potentials;
    }

    scheduleAutoSync(file: TFile) {
        const existingTimer = this.autoSyncTimers.get(file.path);
        if (existingTimer !== undefined) {
            window.clearTimeout(existingTimer);
        }

        const timer = window.setTimeout(() => {
            this.autoSyncTimers.delete(file.path);
            void this.autoSyncToCanvases(file);
        }, this.AUTO_SYNC_DEBOUNCE_MS);

        this.autoSyncTimers.set(file.path, timer);
    }

    clearPendingAutoSync() {
        for (const timer of this.autoSyncTimers.values()) {
            window.clearTimeout(timer);
        }
        this.autoSyncTimers.clear();
    }

    async autoSyncToCanvases(file: TFile) {
        const relatedCanvases = this.canvasIndexService.getCanvasPathsReferencing(file.path);
        if (relatedCanvases.length === 0) return;

        for (const canvasPath of relatedCanvases) {
            try {
                const canvasFile = this.app.vault.getAbstractFileByPath(canvasPath);
                if (canvasFile && canvasFile instanceof TFile) {
                    await this.syncNodeInCanvas(canvasFile, file);
                }
            } catch (error) {
                console.error(`[BreadcrumbPlugin] Failed to auto-sync to canvas: ${canvasPath}`, error);
            }
        }
    }

    async syncNodeInCanvas(canvasFile: TFile, noteFile: TFile): Promise<string | null> {
        let canvasData: CanvasData;
        try {
            const content = await this.app.vault.read(canvasFile);
            canvasData = JSON.parse(content) as CanvasData;
        } catch {
            return null;
        }

        if (!canvasData.nodes) return null;

        const targetPath = noteFile.path;
        const targetLink = `[[${noteFile.basename}`;
        let updated = false;

        let targetNodeId: string | null = null;
        let targetNode: CanvasNode | null = null;

        const textContent = await this.noteNodeContentService.extractNodeText(noteFile);

        for (const node of canvasData.nodes) {
            const matchesByPath = node.type === 'text' && node.filePath === targetPath;
            const matchesByLink = node.type === 'text' && typeof node.text === 'string' && node.text.includes(targetLink);

            if (matchesByPath || matchesByLink) {
                const isContentDiff = node.text !== textContent;

                if (isContentDiff) {
                    node.text = textContent;
                    updated = true;
                }

                if (node.filePath !== targetPath) {
                    node.filePath = targetPath;
                    updated = true;
                }

                targetNodeId = node.id;
                targetNode = node;
            }
        }

        if (!targetNodeId) {
            for (const node of canvasData.nodes) {
                if (node.type === 'file' && node.file === targetPath) {
                    targetNodeId = node.id;
                    targetNode = node;
                    break;
                }
            }
        }

        if (targetNode) {
            const hasGroup = canvasData.nodes.some(n => n.type === 'group' && n.label === noteFile.basename);
            if (!hasGroup) {
                const groupId = Math.random().toString(36).substring(2, 15);
                const newGroup: CanvasNode = {
                    id: groupId,
                    type: 'group',
                    label: noteFile.basename,
                    x: targetNode.x,
                    y: targetNode.y,
                    width: targetNode.width,
                    height: targetNode.height,
                };

                canvasData.nodes.unshift(newGroup);
                updated = true;
            }
        }

        if (updated) {
            await this.app.vault.modify(canvasFile, JSON.stringify(canvasData, null, '\t'));
        }

        return targetNodeId;
    }

    async addToCanvas(canvasFile: TFile, noteFile: TFile): Promise<string | null> {
        let canvasData: CanvasData;
        try {
            const jsonStr = await this.app.vault.read(canvasFile);
            canvasData = JSON.parse(jsonStr) as CanvasData;
        } catch {
            new Notice('无法读取白板数据');
            return null;
        }

        if (!canvasData.nodes) canvasData.nodes = [];

        const targetPath = noteFile.path;
        const targetLink = `[[${noteFile.basename}`;

        for (const node of canvasData.nodes) {
            if (node.type === 'file' && node.file === targetPath) return node.id;
            if (node.type === 'text' && node.filePath === targetPath) return node.id;
            if (node.type === 'text' && typeof node.text === 'string' && node.text.includes(targetLink)) return node.id;
        }

        const textContent = await this.noteNodeContentService.extractNodeText(noteFile);
        const { width, height } = await this.noteNodeContentService.measureTextPrecisely(textContent);

        let maxX = 0;
        let avgY = 0;

        if (canvasData.nodes.length > 0) {
            canvasData.nodes.forEach(n => {
                if (n.x + n.width > maxX) maxX = n.x + n.width;
                avgY += n.y;
            });
            avgY = avgY / canvasData.nodes.length;
        } else {
            maxX = -400;
            avgY = -200;
        }

        const newNodeId = Math.random().toString(36).substring(2, 15);
        const newNode: CanvasNode = {
            id: newNodeId,
            type: 'text',
            text: textContent,
            filePath: targetPath,
            x: maxX + 100,
            y: avgY,
            width,
            height,
        };

        const groupId = Math.random().toString(36).substring(2, 15);
        const newGroup: CanvasNode = {
            id: groupId,
            type: 'group',
            label: noteFile.basename,
            x: newNode.x,
            y: newNode.y,
            width: newNode.width,
            height: newNode.height,
        };

        canvasData.nodes.push(newGroup);
        canvasData.nodes.push(newNode);

        await this.app.vault.modify(canvasFile, JSON.stringify(canvasData, null, '\t'));

        return newNodeId;
    }

    async setCanvasEdgesToSquare(canvasFile: TFile) {
        await this.setCanvasEdgesPathMode(canvasFile, 'square');
    }

    async setCanvasEdgesToNative(canvasFile: TFile) {
        await this.setCanvasEdgesPathMode(canvasFile, 'native');
    }

    async setCanvasEdgesPathMode(
        canvasFile: TFile,
        mode: CanvasEdgePathMode,
        edgeIds?: string[],
    ) {
        let canvasData: CanvasData;
        try {
            const content = await this.app.vault.read(canvasFile);
            canvasData = JSON.parse(content) as CanvasData;
        } catch (error) {
            console.error(error);
            new Notice('修改连线类型失败');
            return;
        }

        if (!canvasData.edges || canvasData.edges.length === 0) {
            new Notice('当前白板没有连线');
            return;
        }

        const targetEdgeIdSet = edgeIds ? new Set(edgeIds) : null;
        const selectedOnly = Boolean(targetEdgeIdSet);

        let total = 0;
        let updated = 0;

        for (const edge of canvasData.edges) {
            if (!this.isCanvasEdgeLike(edge)) continue;
            if (targetEdgeIdSet && !targetEdgeIdSet.has(edge.id)) continue;

            total++;
            if (this.applyEdgePathMode(edge, mode)) updated++;
        }

        if (total === 0) {
            new Notice('未找到要修改的连线');
            return;
        }

        if (updated === 0) {
            if (mode === 'square') {
                new Notice(selectedOnly ? '选中的连线已是 square 类型' : '当前白板连线已是 square 类型');
            } else {
                new Notice(selectedOnly ? '选中的连线已是原生类型' : '当前白板连线已是原生类型');
            }
            return;
        }

        await this.app.vault.modify(canvasFile, JSON.stringify(canvasData, null, '\t'));
        this.updateOpenedCanvasEdgesPathMode(canvasFile, mode, targetEdgeIdSet);

        if (mode === 'square') {
            new Notice(`已将 ${updated}/${total} 条连线改为 square 类型`);
        } else {
            new Notice(`已将 ${updated}/${total} 条连线改为原生类型`);
        }
    }

    async adjustGroupsInCanvas(canvasFile: TFile) {
        try {
            const content = await this.app.vault.read(canvasFile);
            const canvasData = JSON.parse(content) as CanvasData;
            if (!canvasData.nodes) return;

            let updated = false;

            const groups = canvasData.nodes.filter(n => n.type === 'group');
            const nonGroups = canvasData.nodes.filter(n => n.type !== 'group');

            for (const group of groups) {
                const nodesInside = nonGroups.filter(n => {
                    const cx = n.x + n.width / 2;
                    const cy = n.y + n.height / 2;
                    return cx >= group.x && cx <= group.x + group.width && cy >= group.y && cy <= group.y + group.height;
                });

                if (nodesInside.length > 1) continue;
                if (!group.label) continue;

                const targetNode = canvasData.nodes.find(n => {
                    if (n.type === 'file' && typeof n.file === 'string') {
                        const basename = n.file.split('/').pop()?.replace(/\.md$/, '');
                        return basename === group.label;
                    }
                    if (n.type === 'text' && typeof n.text === 'string') {
                        return (
                            n.text.includes(`[[${group.label}]]`) ||
                            n.text.includes(`[[${group.label}|`) ||
                            n.text.includes(`# [[${group.label}]]`)
                        );
                    }
                    return false;
                });

                if (targetNode) {
                    const newX = targetNode.x;
                    const newY = targetNode.y;
                    const newW = targetNode.width;
                    const newH = targetNode.height;

                    if (group.x !== newX || group.y !== newY || group.width !== newW || group.height !== newH) {
                        group.x = newX;
                        group.y = newY;
                        group.width = newW;
                        group.height = newH;
                        updated = true;
                    }
                }
            }

            if (updated) {
                await this.app.vault.modify(canvasFile, JSON.stringify(canvasData, null, '\t'));
                new Notice('已调整白板中的 Group 尺寸与对应卡片完全对齐');
            } else {
                new Notice('没有需要调整的 Group');
            }
        } catch (error) {
            console.error(error);
            new Notice('调整 Group 失败');
        }
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    private isCanvasEdgeLike(edge: unknown): edge is CanvasEdge {
        return this.isRecord(edge);
    }

    isAdvancedCanvasEnabledForSquareRouting(): boolean {
        const plugins = (this.app as App & {
            plugins?: {
                enabledPlugins?: Set<string>;
                plugins?: Record<string, unknown>;
            };
        }).plugins;

        if (!plugins) return false;

        if (plugins.enabledPlugins?.has('advanced-canvas')) return true;
        return Boolean(plugins.plugins?.['advanced-canvas']);
    }

    private applyEdgePathMode(edge: CanvasEdge, mode: CanvasEdgePathMode): boolean {
        let changed = false;
        const styleAttributes = this.isRecord(edge.styleAttributes) ? { ...edge.styleAttributes } : {};

        if (mode === 'square') {
            if (styleAttributes.pathfindingMethod !== 'square') {
                styleAttributes.pathfindingMethod = 'square';
                changed = true;
            }

            if (!this.isRecord(edge.styleAttributes) || edge.styleAttributes.pathfindingMethod !== 'square') {
                edge.styleAttributes = styleAttributes;
                changed = true;
            }

            if (edge.pathfindingMethod !== 'square') {
                edge.pathfindingMethod = 'square';
                changed = true;
            }

            return changed;
        }

        if (styleAttributes.pathfindingMethod !== undefined) {
            delete styleAttributes.pathfindingMethod;
            changed = true;
        }

        if (Object.keys(styleAttributes).length === 0) {
            if (edge.styleAttributes !== undefined) {
                delete edge.styleAttributes;
                changed = true;
            }
        } else if (!this.isRecord(edge.styleAttributes) || edge.styleAttributes.pathfindingMethod !== styleAttributes.pathfindingMethod) {
            edge.styleAttributes = styleAttributes;
            changed = true;
        }

        if (edge.pathfindingMethod !== undefined) {
            delete edge.pathfindingMethod;
            changed = true;
        }

        return changed;
    }

    private updateOpenedCanvasEdgesPathMode(
        canvasFile: TFile,
        mode: CanvasEdgePathMode,
        targetEdgeIdSet: Set<string> | null,
    ) {
        const leaves = this.app.workspace.getLeavesOfType('canvas');
        for (const leaf of leaves) {
            const view = leaf.view as CanvasView;
            if (view.file?.path !== canvasFile.path) continue;

            const edges = view.canvas.edges;
            if (!edges || typeof edges.values !== 'function') continue;

            for (const edge of edges.values()) {
                if (!edge.id) continue;
                if (targetEdgeIdSet && !targetEdgeIdSet.has(edge.id)) continue;
                this.applyRuntimeEdgePathMode(edge, mode);
            }
        }
    }

    private applyRuntimeEdgePathMode(edge: CanvasRuntimeEdge, mode: CanvasEdgePathMode) {
        const currentData = typeof edge.getData === 'function' ? edge.getData() : null;
        if (currentData && this.isCanvasEdgeLike(currentData)) {
            const clonedData = {
                ...currentData,
                styleAttributes: this.isRecord(currentData.styleAttributes) ? { ...currentData.styleAttributes } : currentData.styleAttributes,
            } as CanvasEdge;

            this.applyEdgePathMode(clonedData, mode);
            if (typeof edge.setData === 'function') {
                edge.setData(clonedData);
            } else {
                edge.styleAttributes = clonedData.styleAttributes;
                edge.pathfindingMethod = clonedData.pathfindingMethod;
            }
        } else {
            const clonedEdge = {
                id: edge.id,
                fromNode: '',
                toNode: '',
                styleAttributes: this.isRecord(edge.styleAttributes) ? { ...edge.styleAttributes } : edge.styleAttributes,
                pathfindingMethod: edge.pathfindingMethod,
            } as CanvasEdge;

            this.applyEdgePathMode(clonedEdge, mode);
            edge.styleAttributes = clonedEdge.styleAttributes;
            edge.pathfindingMethod = clonedEdge.pathfindingMethod;
        }

        if (typeof edge.updatePath === 'function') {
            edge.updatePath();
        }
        edge.labelElement?.render?.();
    }
}
