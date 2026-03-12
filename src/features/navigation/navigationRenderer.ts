import { App, MarkdownView, Menu, TFile } from 'obsidian';

import { cleanName } from '../../utils/nameUtils';
import { NavigationService } from './navigationService';

export class NavigationRenderer {
    private observedViews = new Set<MarkdownView>();
    private viewObservers = new Map<MarkdownView, MutationObserver>();
    private queuedViews = new Set<MarkdownView>();

    constructor(
        private app: App,
        private navigationService: NavigationService,
        private isNavigationEnabled: () => boolean,
    ) {}

    updateAllViews() {
        const activeViews = new Set<MarkdownView>();

        this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            if (leaf.view instanceof MarkdownView) {
                activeViews.add(leaf.view);
                this.ensureViewObserver(leaf.view);
                this.renderView(leaf.view);
            }
        });

        this.cleanupStaleObservers(activeViews);
    }

    clear() {
        for (const observer of this.viewObservers.values()) {
            observer.disconnect();
        }

        this.viewObservers.clear();
        this.observedViews.clear();
        this.queuedViews.clear();
    }

    private renderView(view: MarkdownView) {
        const file = view.file;
        if (!file) return;

        const container = view.contentEl;
        const cache = this.app.metadataCache.getFileCache(file);

        if (!this.isNavigationEnabled() || (cache?.frontmatter && cache.frontmatter['banner'])) {
            container.querySelector('.nav-header-wrapper')?.remove();
            return;
        }

        const breadcrumbPath = this.navigationService.getBreadcrumbPath(file);
        const { prevs, nexts } = this.navigationService.getNeighbors(file);

        const showBreadcrumbs = breadcrumbPath.length > 1;
        const showButtons = prevs.length > 0 || nexts.length > 0;

        if (!showBreadcrumbs && !showButtons) {
            container.querySelector('.nav-header-wrapper')?.remove();
            return;
        }

        const wrappers = Array.from(container.querySelectorAll('.nav-header-wrapper'));
        const [firstWrapper, ...duplicates] = wrappers;
        duplicates.forEach(el => el.remove());

        let wrapper = firstWrapper;
        if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.addClass('nav-header-wrapper');
            container.prepend(wrapper);
        }

        if (container.firstElementChild !== wrapper) {
            container.prepend(wrapper);
        }

        wrapper.empty();

        if (showBreadcrumbs) this.renderBreadcrumbsRow(wrapper, breadcrumbPath);
        if (showButtons) this.renderButtonsRow(wrapper as HTMLElement, prevs, nexts);
    }

    private ensureViewObserver(view: MarkdownView) {
        if (this.observedViews.has(view)) return;

        const observer = new MutationObserver(() => {
            this.queueRender(view);
        });

        observer.observe(view.contentEl, {
            childList: true,
        });

        this.observedViews.add(view);
        this.viewObservers.set(view, observer);
    }

    private cleanupStaleObservers(activeViews: Set<MarkdownView>) {
        for (const view of Array.from(this.observedViews)) {
            if (activeViews.has(view)) continue;

            const observer = this.viewObservers.get(view);
            observer?.disconnect();
            this.viewObservers.delete(view);
            this.observedViews.delete(view);
            this.queuedViews.delete(view);
        }
    }

    private queueRender(view: MarkdownView) {
        if (this.queuedViews.has(view)) return;

        this.queuedViews.add(view);
        window.requestAnimationFrame(() => {
            this.queuedViews.delete(view);
            if (!this.observedViews.has(view)) return;
            this.renderView(view);
        });
    }

    private renderBreadcrumbsRow(container: Element, path: TFile[]) {
        const displayPath = path.length > 3 ? path.slice(-3) : path;
        const breadcrumbBox = container.createDiv({ cls: 'nav-breadcrumbs-container' });

        displayPath.forEach((file, index) => {
            const isLast = index === displayPath.length - 1;
            const item = breadcrumbBox.createDiv({
                cls: `breadcrumb-item ${isLast ? 'current' : ''}`,
                text: cleanName(file.basename),
            });

            if (!isLast) {
                item.onclick = async () => {
                    await this.navigationService.openFile(file);
                };
                breadcrumbBox.createSpan({ cls: 'breadcrumb-separator', text: '/' });
            }
        });
    }

    private renderButtonsRow(container: HTMLElement, prevs: TFile[], nexts: TFile[]) {
        const row = container.createDiv({ cls: 'nav-buttons-row' });
        this.createBoxButton(row, 'left', prevs);
        this.createBoxButton(row, 'right', nexts);
    }

    private createBoxButton(container: HTMLElement, direction: 'left' | 'right', targetFiles: TFile[]) {
        const hasFiles = targetFiles && targetFiles.length > 0;
        const firstFile = targetFiles[0];

        const btn = container.createDiv({
            cls: `nav-btn-box ${!hasFiles ? 'disabled' : ''}`,
        });

        let labelText = '';
        if (!hasFiles) labelText = direction === 'left' ? '无上一篇' : '无下一篇';
        else if (targetFiles.length === 1 && firstFile) labelText = cleanName(firstFile.basename);
        else labelText = `多条路径 (${targetFiles.length})`;

        if (direction === 'left') {
            btn.createSpan({ text: '←' });
            btn.createSpan({ cls: 'nav-btn-text', text: labelText });
        } else {
            btn.createSpan({ cls: 'nav-btn-text', text: labelText });
            btn.createSpan({ text: '→' });
        }

        if (hasFiles) {
            btn.onclick = e => {
                if (targetFiles.length === 1 && firstFile) {
                    void this.navigationService.openFile(firstFile);
                } else {
                    const menu = new Menu();
                    targetFiles.forEach(f => {
                        menu.addItem(item => {
                            item.setTitle(cleanName(f.basename)).setIcon('link').onClick(async () => {
                                await this.navigationService.openFile(f);
                            });
                        });
                    });
                    menu.showAtMouseEvent(e);
                }
            };
        }
    }
}
