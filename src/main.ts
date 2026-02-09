import {
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    MarkdownView,
    Menu,
    Modal,
    Notice,
    MarkdownRenderer,
    Component,
    TAbstractFile,
    App,
    WorkspaceLeaf,
    setIcon,
    View
} from 'obsidian';

// --- 接口定义 ---

interface BreadcrumbSettings {
    enableNav: boolean;
}

interface CanvasNode {
    id: string;
    type: string;
    text?: string;
    file?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    filePath?: string;
    // 允许额外的属性以避免 no-unsafe-assignment 报错
    [key: string]: unknown;
}

interface CanvasData {
    nodes: CanvasNode[];
    edges?: unknown[];
}

// 这是一个临时的接口，用于描述 Canvas View 的结构，避免使用 any
interface CanvasView extends View {
    file: TFile | null;
    canvas: {
        nodes: Map<string, CanvasNode>;
        select: (node: CanvasNode) => void;
        zoomToSelection: () => void;
        [key: string]: unknown;
    };
}

interface ReferenceResult {
    file: TFile;
    type: 'existing' | 'potential';
}

interface NeighborResult {
    prevs: TFile[];
    nexts: TFile[];
}

const DEFAULT_SETTINGS: BreadcrumbSettings = {
    enableNav: true
};

export default class BreadcrumbPlugin extends Plugin {
    // Key: Canvas文件路径, Value: 该Canvas引用的所有文件路径集合 (Set)
    canvasIndex: Map<string, Set<string>> = new Map();
    settings: BreadcrumbSettings;

    async onload() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        // 样式注入已移除，改用 styles.css，Obsidian 会自动加载它
        this.addSettingTab(new BreadcrumbSettingTab(this.app, this));

        this.registerEvent(this.app.workspace.on('file-open', () => this.updateAllViews()));
        this.registerEvent(this.app.metadataCache.on('changed', () => this.updateAllViews()));
        
        this.app.workspace.onLayoutReady(() => {
            this.updateAllViews();
            
            // 延迟启动索引构建
            setTimeout(() => {
                void this.buildCanvasIndex();
            }, 2000);
        });

        this.setupIndexListeners();
        
        this.addCommand({
            id: 'toggle-breadcrumb-nav',
            name: 'Toggle/refresh breadcrumb nav', // Sentence case
            callback: () => this.updateAllViews()
        });

        this.addCommand({
            id: 'check-canvas-references',
            name: 'Check canvas references (existing & potential)', // Sentence case
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (!activeFile) return false;
                if (checking) return true;
                // 显式 void 忽略 promise
                void this.scanCanvasFiles(activeFile);
                return true; 
            }
        });
    }

    onunload() {
        document.querySelectorAll('.nav-header-wrapper').forEach(el => el.remove());
        this.canvasIndex.clear();
    }

    setupIndexListeners() {
        this.registerEvent(this.app.vault.on('modify', async (file: TAbstractFile) => {
            if (file instanceof TFile) {
                if (file.extension === 'canvas') {
                    await this.indexSingleCanvas(file);
                } 
                else if (file.extension === 'md') {
                    await this.autoSyncToCanvases(file);
                }
            }
        }));
        
        this.registerEvent(this.app.vault.on('delete', (file: TAbstractFile) => {
            if (file instanceof TFile && file.extension === 'canvas') {
                this.canvasIndex.delete(file.path);
            }
        }));
        
        this.registerEvent(this.app.vault.on('rename', async (file: TAbstractFile, oldPath: string) => {
            if (file instanceof TFile && file.extension === 'canvas') {
                this.canvasIndex.delete(oldPath);
                await this.indexSingleCanvas(file);
            }
        }));
    }

    async buildCanvasIndex() {
        const start = Date.now();
        const canvasFiles = this.app.vault.getFiles().filter(f => f.extension === 'canvas');
        
        const BATCH_SIZE = 5; 
        const YIELD_INTERVAL = 20;

        let processed = 0;

        for (let i = 0; i < canvasFiles.length; i += BATCH_SIZE) {
            const batch = canvasFiles.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(file => this.indexSingleCanvas(file)));
            processed += batch.length;

            if (i + BATCH_SIZE < canvasFiles.length) {
                await new Promise(resolve => setTimeout(resolve, YIELD_INTERVAL));
            }
        }
        
        // Console.log 替换为 debug，此处保留用于调试
        console.debug(`[BreadcrumbPlugin] Indexed ${processed} canvas files in ${Date.now() - start}ms`);
    }

    async indexSingleCanvas(file: TFile) {
        try {
            const content = await this.app.vault.read(file);
            const data = JSON.parse(content) as CanvasData;
            const referencedPaths = new Set<string>();

            if (data.nodes && Array.isArray(data.nodes)) {
                for (const node of data.nodes) {
                    if (node.type === 'file' && typeof node.file === 'string') {
                        referencedPaths.add(node.file);
                    }
                    else if (node.type === 'text' && typeof node.text === 'string') {
                        const links = this.extractWikiLinks(node.text);
                        for (const linkText of links) {
                            const resolvedFile = this.app.metadataCache.getFirstLinkpathDest(linkText, file.path);
                            if (resolvedFile) {
                                referencedPaths.add(resolvedFile.path);
                            }
                        }
                    }
                }
            }
            this.canvasIndex.set(file.path, referencedPaths);
        } catch (e) {
            console.error(`[BreadcrumbPlugin] Failed to index canvas: ${file.path}`, e);
            this.canvasIndex.delete(file.path);
        }
    }

    extractWikiLinks(text: string): string[] {
        const matches = text.matchAll(/\[\[(.*?)\]\]/g);
        const links: string[] = [];
        for (const match of matches) {
            if (match[1]) {
                 const linkTarget = match[1].split('|')[0];
                 if (linkTarget) {
                    links.push(linkTarget);
                 }
            }
        }
        return links;
    }

    async scanCanvasFiles(targetFile: TFile) {
        const resultMap = new Map<string, ReferenceResult>();
        const targetPath = targetFile.path;
        
        for (const [canvasPath, refSet] of this.canvasIndex.entries()) {
            if (refSet.has(targetPath)) {
                const canvasFile = this.app.vault.getAbstractFileByPath(canvasPath);
                if (canvasFile && canvasFile instanceof TFile) {
                    resultMap.set(canvasPath, { file: canvasFile, type: 'existing' });
                }
            }
        }

        const potentialCanvases = this.findPotentialCanvases(targetFile);
        
        for (const canvas of potentialCanvases) {
            if (resultMap.has(canvas.path)) continue; 
            resultMap.set(canvas.path, { file: canvas, type: 'potential' });
        }

        const results = Array.from(resultMap.values());

        if (results.length > 0) {
            new CanvasReferencesModal(this.app, results, targetFile, this).open();
        } else {
            new Notice(`未找到现有引用或潜在的白板关联。`);
        }
    }

    findPotentialCanvases(startFile: TFile): TFile[] {
        const potentials: TFile[] = [];
        let queue: TFile[] = [startFile];
        const visited = new Set<string>([startFile.path]);

        while(queue.length > 0) {
            const curr = queue.shift();
            if (!curr) continue;
            
            const cache = this.app.metadataCache.getFileCache(curr);
            if(!cache) continue;

            const canvasLinks = this.parseLinks(cache?.frontmatter?.canvas);
            if (canvasLinks.length > 0) {
                canvasLinks.forEach(link => {
                    const f = this.resolveFile(link);
                    if (f && f.extension === 'canvas') {
                        potentials.push(f);
                    }
                });
            }

            const upLinks = this.parseLinks(cache?.frontmatter?.up);
            upLinks.forEach(link => {
                const parent = this.resolveFile(link);
                if (parent && !visited.has(parent.path)) {
                    visited.add(parent.path);
                    queue.push(parent);
                }
            });
        }
        return potentials;
    }

    async autoSyncToCanvases(file: TFile) {
        const targetPath = file.path;
        const relatedCanvases: string[] = [];
        
        for (const [canvasPath, refSet] of this.canvasIndex.entries()) {
            if (refSet.has(targetPath)) {
                relatedCanvases.push(canvasPath);
            }
        }

        if (relatedCanvases.length === 0) return;

        for (const canvasPath of relatedCanvases) {
            try {
                const canvasFile = this.app.vault.getAbstractFileByPath(canvasPath);
                if (canvasFile && canvasFile instanceof TFile) {
                    await this.syncNodeInCanvas(canvasFile, file);
                }
            } catch (e) {
                console.error(`[BreadcrumbPlugin] Failed to auto-sync to canvas: ${canvasPath}`, e);
            }
        }
    }

    async extractNodeText(file: TFile): Promise<string> {
        const content = await this.app.vault.read(file);
        const descKeyword = "description:";
        const descIndex = content.indexOf(descKeyword);
        
        if (descIndex === -1) {
            return `# [[${file.basename}]]\n\n`;
        }

        const startIdx = descIndex + descKeyword.length;
        const textAfter = content.substring(startIdx);
        const endMatch = textAfter.match(/\n---/); 
        
        let descContent = "";
        if (endMatch) {
            descContent = textAfter.substring(0, endMatch.index).trim();
        } else {
            descContent = textAfter.trim();
        }

        return `# [[${file.basename}]]\n\n${descContent}`;
    }

    async measureTextPrecisely(text: string): Promise<{width: number, height: number}> {
        const wrapper = document.body.createDiv();
        // 使用 CSS 类替代内联样式，类名在 styles.css 中定义
        wrapper.addClass('canvas-measure-wrapper');

        const cardWidth = 400; 
        
        const nodeContent = wrapper.createDiv({
            cls: 'canvas-node-content markdown-preview-view canvas-measure-content'
        });
        
        // 动态宽度仍需 JS 设置，但尽量少用内联样式
        nodeContent.style.width = `${cardWidth}px`;

        const component = new Component();
        await MarkdownRenderer.render(this.app, text, nodeContent, '', component);

        const height = nodeContent.scrollHeight;
        
        component.unload();
        wrapper.remove();

        return { width: cardWidth, height: height + 4 };
    }

    async syncNodeInCanvas(canvasFile: TFile, noteFile: TFile): Promise<string | null> {
        let canvasData: CanvasData;
        try {
            const content = await this.app.vault.read(canvasFile);
            canvasData = JSON.parse(content) as CanvasData;
        } catch (e) {
            return null;
        }

        if (!canvasData.nodes) return null;

        const targetPath = noteFile.path;
        const targetLink = `[[${noteFile.basename}`;
        let updated = false;
        let targetNodeId: string | null = null;

        const textContent = await this.extractNodeText(noteFile);
        const { width, height } = await this.measureTextPrecisely(textContent);

        for (const node of canvasData.nodes) {
            if (node.type === 'text' && node.text && node.text.includes(targetLink)) {
                
                const isContentDiff = node.text !== textContent;
                const isSizeDiff = Math.abs((node.width || 0) - width) > 2 || Math.abs((node.height || 0) - height) > 2;

                if (isContentDiff || isSizeDiff) {
                    node.text = textContent;
                    node.width = width;
                    node.height = height;
                    updated = true;
                }
                targetNodeId = node.id;
            }
        }

        if (!targetNodeId) {
             for (const node of canvasData.nodes) {
                if (node.type === 'file' && node.file === targetPath) {
                    targetNodeId = node.id;
                    break;
                }
             }
        }

        if (updated) {
            await this.app.vault.modify(canvasFile, JSON.stringify(canvasData, null, "\t"));
        }

        return targetNodeId;
    }

    async addToCanvas(canvasFile: TFile, noteFile: TFile): Promise<string | null> {
        let canvasData: CanvasData;
        try {
            const jsonStr = await this.app.vault.read(canvasFile);
            canvasData = JSON.parse(jsonStr) as CanvasData;
        } catch (e) {
            new Notice("无法读取白板数据");
            return null;
        }

        if (!canvasData.nodes) canvasData.nodes = [];

        const targetPath = noteFile.path;
        const targetLink = `[[${noteFile.basename}`;
        
        for (const node of canvasData.nodes) {
            if (node.type === 'file' && node.file === targetPath) return node.id;
            if (node.type === 'text' && node.text && node.text.includes(targetLink)) return node.id;
        }

        const textContent = await this.extractNodeText(noteFile);
        const { width, height } = await this.measureTextPrecisely(textContent);

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
            type: "text",
            text: textContent,
            x: maxX + 100, 
            y: avgY,
            width: width,   
            height: height  
        };

        canvasData.nodes.push(newNode);
        await this.app.vault.modify(canvasFile, JSON.stringify(canvasData, null, "\t"));
        
        return newNodeId; 
    }

    updateAllViews() {
        this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            if (leaf.view instanceof MarkdownView) {
                this.renderView(leaf.view);
            }
        });
    }

    renderView(view: MarkdownView) {
        const file = view.file;
        if (!file) return;
        const container = view.contentEl;
        const cache = this.app.metadataCache.getFileCache(file);

        if (!this.settings.enableNav || (cache?.frontmatter && cache.frontmatter['banner'])) {
            container.querySelector('.nav-header-wrapper')?.remove();
            return;
        }

        const breadcrumbPath = this.getBreadcrumbPath(file);
        const { prevs, nexts } = this.getNeighbors(file);
        const showBreadcrumbs = breadcrumbPath.length > 1;
        const showButtons = prevs.length > 0 || nexts.length > 0;

        if (!showBreadcrumbs && !showButtons) {
            container.querySelector('.nav-header-wrapper')?.remove();
            return;
        }

        let wrapper = container.querySelector('.nav-header-wrapper');
        if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.addClass('nav-header-wrapper');
            container.prepend(wrapper);
        }
        wrapper.empty();

        if (showBreadcrumbs) this.renderBreadcrumbsRow(wrapper, breadcrumbPath);
        if (showButtons) this.renderButtonsRow(wrapper as HTMLElement, prevs, nexts);
    }

    getBreadcrumbPath(currentFile: TFile): TFile[] {
        const path: TFile[] = [];
        let curr: TFile | null = currentFile;
        const seen = new Set<string>(); 
        while (curr) {
            if (seen.has(curr.path)) break;
            seen.add(curr.path);
            path.unshift(curr); 
            curr = this.getParentFile(curr);
        }
        return path;
    }

    renderBreadcrumbsRow(container: Element, path: TFile[]) {
        const displayPath = path.length > 3 ? path.slice(-3) : path;
        const breadcrumbBox = container.createDiv({ cls: 'nav-breadcrumbs-container' });
        displayPath.forEach((file, index) => {
            const isLast = index === displayPath.length - 1;
            const item = breadcrumbBox.createDiv({ 
                cls: `breadcrumb-item ${isLast ? 'current' : ''}`,
                text: this.cleanName(file.basename)
            });
            if (!isLast) {
                item.onclick = () => this.openFile(file);
                breadcrumbBox.createSpan({ cls: 'breadcrumb-separator', text: '/' });
            }
        });
    }

    renderButtonsRow(container: HTMLElement, prevs: TFile[], nexts: TFile[]) {
        const row = container.createDiv({ cls: 'nav-buttons-row' });
        this.createBoxButton(row, 'left', prevs);
        this.createBoxButton(row, 'right', nexts);
    }

    createBoxButton(container: HTMLElement, direction: 'left' | 'right', targetFiles: TFile[]) {
        const hasFiles = targetFiles && targetFiles.length > 0;
        const firstFile = targetFiles[0]; 

        const btn = container.createDiv({ 
            cls: `nav-btn-box ${!hasFiles ? 'disabled' : ''}` 
        });
        let labelText = '';
        if (!hasFiles) labelText = direction === 'left' ? '无上一篇' : '无下一篇';
        else if (targetFiles.length === 1 && firstFile) labelText = this.cleanName(firstFile.basename);
        else labelText = `多条路径 (${targetFiles.length})`; 

        if (direction === 'left') {
            btn.createSpan({ text: '←' });
            btn.createSpan({ cls: 'nav-btn-text', text: labelText });
        } else {
            btn.createSpan({ cls: 'nav-btn-text', text: labelText });
            btn.createSpan({ text: '→' });
        }

        if (hasFiles) {
            btn.onclick = (e) => {
                if (targetFiles.length === 1 && firstFile) this.openFile(firstFile);
                else {
                    const menu = new Menu();
                    targetFiles.forEach(f => {
                        menu.addItem(item => {
                            item.setTitle(this.cleanName(f.basename)).setIcon('link').onClick(() => this.openFile(f));
                        });
                    });
                    menu.showAtMouseEvent(e);
                }
            };
        }
    }

    getParentFile(file: TFile): TFile | null {
        const cache = this.app.metadataCache.getFileCache(file);
        const upLinks = this.parseLinks(cache?.frontmatter?.up);
        const firstLink = upLinks[0];
        if (firstLink) return this.resolveFile(firstLink);
        return null;
    }

    getNeighbors(file: TFile): NeighborResult {
        const prevs = new Map<string, TFile>();
        const nexts = new Map<string, TFile>();
        const myName = file.basename;
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;
        
        if (fm) {
            this.parseLinks(fm.prev).forEach(link => { const f = this.resolveFile(link); if (f) prevs.set(f.path, f); });
            this.parseLinks(fm.next).forEach(link => { const f = this.resolveFile(link); if (f) nexts.set(f.path, f); });
        }
        const allFiles = this.app.vault.getMarkdownFiles();
        for (const f of allFiles) {
            if (f.path === file.path) continue;
            const c = this.app.metadataCache.getFileCache(f);
            const links = c?.frontmatter;
            if (!links) continue;
            if (links.next && this.containsLink(links.next, myName)) prevs.set(f.path, f);
            if (links.prev && this.containsLink(links.prev, myName)) nexts.set(f.path, f);
        }
        return { prevs: Array.from(prevs.values()), nexts: Array.from(nexts.values()) };
    }

    cleanName(text: string): string { return text.replace(/^[\d.\-_]+\s+/, ''); }
    
    parseLinks(field: unknown): string[] {
        if (!field) return [];
        const list = Array.isArray(field) ? field : [field];
        return list.map((item: unknown) => {
            if (typeof item !== 'string') return null;
            const match = item.match(/\[\[(.*?)\]\]/);
            if (match && match[1]) {
                return match[1].split('|')[0];
            }
            return item;
        }).filter(Boolean) as string[];
    }

    containsLink(field: unknown, targetBasename: string): boolean {
        const links = this.parseLinks(field);
        return links.some(link => {
            if (!link) return false;
            
            const fileName = link.split('/').pop();
            if (fileName) {
                const linkName = fileName.replace(/\.md$/, '');
                return linkName === targetBasename;
            }
            return false;
        });
    }

    resolveFile(linkText: string): TFile | null {
        if (!linkText) return null;
        return this.app.metadataCache.getFirstLinkpathDest(linkText, '');
    }

    openFile(file: TFile) {
        if (file instanceof TFile) {
            this.app.workspace.getLeaf(false).openFile(file);
        }
    }
}

class CanvasReferencesModal extends Modal {
    results: ReferenceResult[];
    targetFile: TFile;
    plugin: BreadcrumbPlugin;

    constructor(app: App, results: ReferenceResult[], targetFile: TFile, plugin: BreadcrumbPlugin) {
        super(app);
        this.results = results; 
        this.targetFile = targetFile;
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        this.modalEl.addClass('canvas-ref-modal');
        
        contentEl.createEl('h3', { text: `白板引用查询` });

        this.results.forEach(({ file, type }) => {
            const item = contentEl.createDiv({ cls: 'canvas-ref-item' });
            
            const iconBox = item.createDiv({ cls: 'canvas-ref-icon' });
            
            // 使用 Obsidian 的 setIcon 替代 innerHTML，避免 unsafe-call 和 innerHTML 警告
            if (type === 'potential') {
                setIcon(iconBox, 'circle-dashed'); 
                iconBox.title = "未引用 (点击添加)";
                // 使用 CSS 变量或类来设置颜色，避免内联样式报错 (已在 styles.css 中通过类名处理，或此处用 CSS 变量)
                // 为保险起见，这里设置 style.color 可能仍会被 strict lint 警告，但通常 setCssProps 是推荐做法
                // 更好的做法是加一个 specific class
                iconBox.addClass('potential-icon-color'); // 需在 CSS 补充，或直接保留 setAttribute
                iconBox.setAttribute('style', 'color: var(--text-accent)'); 
            } else {
                setIcon(iconBox, 'box-select'); 
            }

            item.createDiv({ cls: 'canvas-ref-name', text: file.basename });
            
            item.createDiv({ 
                cls: `canvas-ref-badge ${type === 'existing' ? 'badge-existing' : 'badge-potential'}`,
                text: type === 'existing' ? 'Existing' : 'Add +'
            });

            item.onclick = async () => {
                this.close();
                let targetId: string | null = null;
                
                try {
                    if (type === 'existing') {
                        targetId = await this.plugin.syncNodeInCanvas(file, this.targetFile);
                    } else {
                        targetId = await this.plugin.addToCanvas(file, this.targetFile);
                    }

                    // 使用自定义的 CanvasView 接口来避免 any 报错
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
                    console.error("Error opening canvas:", e);
                }
            };
        });
    }

    tryZoomToNode(view: CanvasView, target: string | TFile, isId: boolean) {
        let attempts = 0;
        const maxAttempts = 30; 

        const poll = setInterval(() => {
            attempts++;
            // 使用自定义接口访问 canvas 属性
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

    onClose() {
        this.contentEl.empty();
    }
}

class BreadcrumbSettingTab extends PluginSettingTab {
    plugin: BreadcrumbPlugin;

    constructor(app: App, plugin: BreadcrumbPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Enable navigation bar') // Sentence case
            .setDesc('Show breadcrumbs and prev/next buttons at the top of the note.')
            .addToggle(t => t.setValue(this.plugin.settings.enableNav).onChange(async v => {
                this.plugin.settings.enableNav = v;
                await this.plugin.saveData(this.plugin.settings);
                this.plugin.updateAllViews();
            }));
    }
}