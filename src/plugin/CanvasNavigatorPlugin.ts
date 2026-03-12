import { Plugin, TFile } from 'obsidian';

import { CanvasIndexService } from '../features/canvas/canvasIndexService';
import { CanvasSquareRenderService } from '../features/canvas/canvasSquareRenderService';
import { NoteNodeContentService } from '../features/canvas/noteNodeContent';
import { CanvasSyncService } from '../features/canvas/canvasSyncService';
import type { CanvasRuntimeEdge, CanvasView } from '../features/canvas/canvasTypes';
import { NavigationRenderer } from '../features/navigation/navigationRenderer';
import { NavigationService } from '../features/navigation/navigationService';
import { BreadcrumbSettings, DEFAULT_SETTINGS } from '../settings/settings';
import { BreadcrumbSettingTab } from '../settings/settingsTab';

export default class CanvasNavigatorPlugin extends Plugin {
    settings: BreadcrumbSettings;

    private canvasIndexService: CanvasIndexService;
    private canvasSquareRenderService: CanvasSquareRenderService;
    private noteNodeContentService: NoteNodeContentService;
    private canvasSyncService: CanvasSyncService;
    private navigationService: NavigationService;
    private navigationRenderer: NavigationRenderer;

    async onload() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as BreadcrumbSettings);

        this.canvasIndexService = new CanvasIndexService(this.app);
        this.canvasSquareRenderService = new CanvasSquareRenderService(this.app, () => this.settings.defaultCanvasEdgePathMode);
        this.noteNodeContentService = new NoteNodeContentService(this.app);
        this.canvasSyncService = new CanvasSyncService(this.app, this.canvasIndexService, this.noteNodeContentService);
        this.navigationService = new NavigationService(this.app);
        this.navigationRenderer = new NavigationRenderer(this.app, this.navigationService, () => this.settings.enableNav);

        this.addSettingTab(new BreadcrumbSettingTab(this.app, this));

        this.registerEvent(this.app.workspace.on('file-open', () => this.updateAllViews()));
        this.registerEvent(this.app.metadataCache.on('changed', () => this.updateAllViews()));
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshCanvasEdgeRendering()));
        this.registerEvent(this.app.workspace.on('layout-change', () => this.refreshCanvasEdgeRendering()));

        this.app.workspace.onLayoutReady(() => {
            this.updateAllViews();
            setTimeout(() => {
                void this.canvasIndexService.buildCanvasIndex();
                this.refreshCanvasEdgeRendering();
            }, 2000);
        });

        this.canvasIndexService.setupListeners(this, file => {
            this.canvasSyncService.scheduleAutoSync(file);
        });

        this.addCommand({
            id: 'check-canvas-references',
            name: 'Check canvas references / Adjust groups in canvas',
            checkCallback: checking => {
                const activeFile = this.app.workspace.getActiveFile();
                if (!activeFile) return false;

                if (activeFile.extension === 'canvas') {
                    if (checking) return true;
                    void this.canvasSyncService.adjustGroupsInCanvas(activeFile);
                    return true;
                }

                if (activeFile.extension === 'md') {
                    if (checking) return true;
                    void this.canvasSyncService.scanCanvasFiles(activeFile);
                    return true;
                }

                return false;
            },
        });

        this.addCommand({
            id: 'set-canvas-edges-square',
            name: 'Set canvas edges to square path',
            checkCallback: checking => {
                const activeFile = this.app.workspace.getActiveFile();
                if (!activeFile || activeFile.extension !== 'canvas') return false;
                if (checking) return true;

                void this.canvasSyncService.setCanvasEdgesToSquare(activeFile).then(() => this.refreshCanvasEdgeRendering());

                return true;
            },
        });

        this.addCommand({
            id: 'set-canvas-edges-native',
            name: 'Set canvas edges to native path',
            checkCallback: checking => {
                const activeFile = this.app.workspace.getActiveFile();
                if (!activeFile || activeFile.extension !== 'canvas') return false;
                if (checking) return true;

                void this.canvasSyncService.setCanvasEdgesToNative(activeFile).then(() => this.refreshCanvasEdgeRendering());
                return true;
            },
        });

        this.addCommand({
            id: 'set-selected-canvas-edges-square',
            name: 'Set selected canvas edges to square path',
            checkCallback: checking => {
                const context = this.getActiveCanvasContext();
                if (!context) return false;

                const selectedEdgeIds = this.getSelectedCanvasEdgeIds(context.view);
                if (selectedEdgeIds.length === 0) return false;
                if (checking) return true;

                void this.canvasSyncService
                    .setCanvasEdgesPathMode(context.file, 'square', selectedEdgeIds)
                    .then(() => this.refreshCanvasEdgeRendering());
                return true;
            },
        });

        this.addCommand({
            id: 'set-selected-canvas-edges-native',
            name: 'Set selected canvas edges to native path',
            checkCallback: checking => {
                const context = this.getActiveCanvasContext();
                if (!context) return false;

                const selectedEdgeIds = this.getSelectedCanvasEdgeIds(context.view);
                if (selectedEdgeIds.length === 0) return false;
                if (checking) return true;

                void this.canvasSyncService
                    .setCanvasEdgesPathMode(context.file, 'native', selectedEdgeIds)
                    .then(() => this.refreshCanvasEdgeRendering());
                return true;
            },
        });

        this.addCommand({
            id: 'toggle-breadcrumb-nav',
            name: 'Toggle/refresh breadcrumb nav',
            callback: () => this.updateAllViews(),
        });

        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.updateAllViews()));
        this.registerEvent(this.app.workspace.on('layout-change', () => this.updateAllViews()));
    }

    onunload() {
        document.querySelectorAll('.nav-header-wrapper').forEach(el => el.remove());
        this.navigationRenderer.clear();
        this.canvasSquareRenderService.clear();
        this.canvasSyncService.clearPendingAutoSync();
        this.canvasIndexService.clear();
    }

    updateAllViews() {
        this.navigationRenderer.updateAllViews();
    }

    refreshCanvasEdgeRendering() {
        this.canvasSquareRenderService.refreshBindings();
    }

    private getActiveCanvasContext(): { file: TFile; view: CanvasView } | null {
        const recentLeaf = this.app.workspace.getMostRecentLeaf();
        if (recentLeaf) {
            const recentView = recentLeaf.view as CanvasView;
            if (recentView.getViewType() === 'canvas' && recentView.file?.extension === 'canvas') {
                return { file: recentView.file, view: recentView };
            }
        }

        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'canvas') return null;

        const canvasLeaf = this.app.workspace.getLeavesOfType('canvas').find(leaf => {
            const view = leaf.view as CanvasView;
            return view.file?.path === activeFile.path;
        });

        if (!canvasLeaf) return null;

        const view = canvasLeaf.view as CanvasView;
        if (!view.file) return null;
        return { file: view.file, view };
    }

    private getSelectedCanvasEdgeIds(view: CanvasView): string[] {
        const selection = view.canvas.selection;
        if (!selection) return [];

        const edgeIds: string[] = [];
        for (const item of selection) {
            if (!this.isRuntimeEdgeLike(item)) continue;
            edgeIds.push(item.id);
        }

        return Array.from(new Set(edgeIds));
    }

    private isRuntimeEdgeLike(item: unknown): item is CanvasRuntimeEdge {
        if (!item || typeof item !== 'object') return false;
        const candidate = item as { id?: unknown; from?: unknown; to?: unknown; path?: unknown };
        if (typeof candidate.id !== 'string') return false;
        return (
            (typeof candidate.from === 'object' && candidate.from !== null && typeof candidate.to === 'object' && candidate.to !== null)
            || candidate.path !== undefined
        );
    }
}
