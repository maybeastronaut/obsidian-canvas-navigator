import { App, Modal, setIcon, TFile, WorkspaceLeaf } from 'obsidian';

import type { CanvasNode, CanvasView, ReferenceResult } from '../features/canvas/canvasTypes';

export interface CanvasReferenceModalActions {
    syncNodeInCanvas: (canvasFile: TFile, noteFile: TFile) => Promise<string | null>;
    addToCanvas: (canvasFile: TFile, noteFile: TFile) => Promise<string | null>;
}

export class CanvasReferencesModal extends Modal {
    constructor(
        app: App,
        private results: ReferenceResult[],
        private targetFile: TFile,
        private actions: CanvasReferenceModalActions,
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        this.modalEl.addClass('canvas-ref-modal');

        contentEl.createEl('h3', { text: '白板引用查询' });

        this.results.forEach(({ file, type }) => {
            const item = contentEl.createDiv({ cls: 'canvas-ref-item' });
            const iconBox = item.createDiv({ cls: 'canvas-ref-icon' });

            if (type === 'potential') {
                setIcon(iconBox, 'circle-dashed');
                iconBox.title = '未引用 (点击添加)';
                iconBox.addClass('potential-ref');
            } else {
                setIcon(iconBox, 'box-select');
            }

            item.createDiv({ cls: 'canvas-ref-name', text: file.basename });

            item.createDiv({
                cls: `canvas-ref-badge ${type === 'existing' ? 'badge-existing' : 'badge-potential'}`,
                text: type === 'existing' ? 'Existing' : 'Add +',
            });

            item.onclick = async () => {
                this.close();
                let targetId: string | null = null;

                try {
                    if (type === 'existing') {
                        targetId = await this.actions.syncNodeInCanvas(file, this.targetFile);
                    } else {
                        targetId = await this.actions.addToCanvas(file, this.targetFile);
                    }

                    const leaf = this.app.workspace.getLeavesOfType('canvas').find((l: WorkspaceLeaf) => {
                        const v = l.view as CanvasView;
                        return v.file && v.file.path === file.path;
                    });

                    let targetLeaf: WorkspaceLeaf;
                    if (leaf) {
                        targetLeaf = leaf;
                        this.app.workspace.setActiveLeaf(leaf, { focus: true });
                    } else {
                        targetLeaf = this.app.workspace.getLeaf(false);
                        await targetLeaf.openFile(file);
                    }

                    const view = targetLeaf.view as CanvasView;
                    if (view.getViewType() === 'canvas') {
                        if (targetId) {
                            this.tryZoomToNode(view, targetId, true);
                        } else {
                            this.tryZoomToNode(view, this.targetFile, false);
                        }
                    }
                } catch (e) {
                    console.error('Error opening canvas:', e);
                }
            };
        });
    }

    onClose() {
        this.contentEl.empty();
    }

    private tryZoomToNode(view: CanvasView, target: string | TFile, isId: boolean) {
        let attempts = 0;
        const maxAttempts = 30;

        const poll = setInterval(() => {
            attempts++;
            const canvas = view.canvas;
            if (!canvas) return;

            let foundNode: CanvasNode | undefined;

            if (isId && typeof target === 'string') {
                if (canvas.nodes && canvas.nodes.has(target)) {
                    foundNode = canvas.nodes.get(target);
                }
            } else if (target instanceof TFile) {
                for (const [, node] of canvas.nodes) {
                    let match = false;
                    if (node.filePath && node.filePath === target.path) match = true;
                    if (!match && node.text && node.text.includes(target.basename)) match = true;
                    if (match) {
                        foundNode = node;
                        break;
                    }
                }
            }

            if (foundNode) {
                clearInterval(poll);
                canvas.select(foundNode);
                canvas.zoomToSelection();
                setTimeout(() => canvas.zoomToSelection(), 100);
            } else if (attempts >= maxAttempts) {
                clearInterval(poll);
            }
        }, 100);
    }
}
