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

// --- 常量定义 ---
const CARD_MIN_WIDTH = 260; // 卡片最小宽度 (px)
const CARD_MAX_WIDTH = 1200; // 扩大最大宽度以支持文本量极大时生成大面积的正方形

// --- 接口定义 ---

interface BreadcrumbSettings {
    enableNav: boolean;
}

interface CanvasNode {
    id: string;
    type: string;
    text?: string;
    file?: string;
    label?: string; // 为 Group 节点增加 label 属性
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
    canvasIndex: Map<string, Set<string>> = new Map();
    settings: BreadcrumbSettings;

    async onload() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as BreadcrumbSettings);
        this.addSettingTab(new BreadcrumbSettingTab(this.app, this));

        this.registerEvent(this.app.workspace.on('file-open', () => this.updateAllViews()));
        this.registerEvent(this.app.metadataCache.on('changed', () => this.updateAllViews()));
        
        this.app.workspace.onLayoutReady(() => {
            this.updateAllViews();
            setTimeout(() => {
                void this.buildCanvasIndex();
            }, 2000);
        });

        this.setupIndexListeners();
        
        // 智能命令：根据当前活跃文件类型执行不同逻辑
        this.addCommand({
            id: 'check-canvas-references',
            name: 'Check canvas references / Adjust groups in canvas',
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (!activeFile) return false;
                
                if (activeFile.extension === 'canvas') {
                    if (checking) return true;
                    // 白板内执行：调整 Group 边框
                    void this.adjustGroupsInCanvas(activeFile);
                    return true;
                } else if (activeFile.extension === 'md') {
                    if (checking) return true;
                    // 笔记内执行：检查引用并添加卡片
                    void this.scanCanvasFiles(activeFile);
                    return true; 
                }
                
                return false;
            }
        });

        this.addCommand({
            id: 'toggle-breadcrumb-nav',
            name: 'Toggle/refresh breadcrumb nav',
            callback: () => this.updateAllViews()
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
        } catch (error) {
            console.error(`[BreadcrumbPlugin] Failed to index canvas: ${file.path}`, error);
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
            } catch (error) {
                console.error(`[BreadcrumbPlugin] Failed to auto-sync to canvas: ${canvasPath}`, error);
            }
        }
    }

    async extractNodeText(file: TFile): Promise<string> {
        // 1. 优先尝试从 Obsidian 的元数据缓存中读取
        const cache = this.app.metadataCache.getFileCache(file);
        let descContent = "";

        if (cache?.frontmatter && typeof cache.frontmatter['description'] === 'string') {
            descContent = cache.frontmatter['description'];
        } else {
            // 2. 正则后备提取
            const content = await this.app.vault.read(file);
            const match = content.match(/^\s*description\s*[:：]/im);
            
            if (match && match.index !== undefined) {
                const startIdx = match.index + match[0].length;
                const textAfter = content.substring(startIdx);
                const endMatch = textAfter.match(/(\n---|^\s*$|\n#)/m); 
                
                if (endMatch && endMatch.index !== undefined) {
                    descContent = textAfter.substring(0, endMatch.index).trim();
                } else {
                    descContent = textAfter.trim();
                }

                if (!descContent && textAfter.startsWith('\n')) {
                     const nextContent = textAfter.trimStart();
                     const nextEndMatch = nextContent.match(/(\n---|^\s*$|\n#)/m);
                     if (nextEndMatch && nextEndMatch.index !== undefined) {
                         descContent = nextContent.substring(0, nextEndMatch.index).trim();
                     } else {
                         descContent = nextContent.trim();
                     }
                }
            }
        }

        // 【修改 1】：去除标题前缀并以别名显示 (例如：# [[00.04.02 函数中的变量|函数中的变量]])
        const cleanedTitle = this.cleanName(file.basename);
        return `# [[${file.basename}|${cleanedTitle}]]\n\n${descContent}`;
    }

    // --- 动态尺寸测量（仅在创建卡片时调用） ---
    async measureTextPrecisely(text: string): Promise<{width: number, height: number}> {
        const wrapper = document.body.createDiv();
        wrapper.addClass('canvas-measure-wrapper');
        // eslint-disable-next-line obsidianmd/no-static-styles-assignment
        wrapper.setAttribute('style', 'position: absolute; top: -9999px; left: -9999px; visibility: hidden; z-index: -1;');

        const nodeContent = wrapper.createDiv({
            cls: 'canvas-node-content markdown-preview-view canvas-measure-content'
        });
        
        const component = new Component();
        await MarkdownRenderer.render(this.app, text, nodeContent, '', component);

        // eslint-disable-next-line obsidianmd/no-static-styles-assignment
        nodeContent.setAttribute('style', `width: ${CARD_MIN_WIDTH}px !important;`);

        let titleWidth = 0;
        const h1 = nodeContent.querySelector('h1');
        if (h1) {
            // eslint-disable-next-line obsidianmd/no-static-styles-assignment
            h1.setAttribute('style', 'white-space: nowrap; display: inline-block; width: auto;');
            const h1Rect = h1.getBoundingClientRect();
            titleWidth = Math.ceil(h1Rect.width) + 80; 
            h1.removeAttribute('style');
        }

        const minW = Math.max(CARD_MIN_WIDTH, titleWidth);
        const maxW = Math.max(CARD_MAX_WIDTH, minW * 2);

        let low = minW;
        let high = maxW;
        let bestWidth = minW;
        let bestDiff = Infinity;

        for (let i = 0; i < 10; i++) {
            const mid = Math.floor((low + high) / 2);
            // eslint-disable-next-line obsidianmd/no-static-styles-assignment
            nodeContent.setAttribute('style', `width: ${mid}px !important;`);
            
            const rect = nodeContent.getBoundingClientRect();
            const h = Math.ceil(rect.height);
            const diff = Math.abs(mid - h);

            if (diff < bestDiff) {
                bestDiff = diff;
                bestWidth = mid;
            }

            if (mid < h) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        // eslint-disable-next-line obsidianmd/no-static-styles-assignment
        nodeContent.setAttribute('style', `width: ${bestWidth}px !important;`);
        const finalRect = nodeContent.getBoundingClientRect();
        
        let finalWidth = Math.ceil(finalRect.width);
        let finalHeight = Math.ceil(finalRect.height);
        
        component.unload();
        wrapper.remove();

        finalWidth += 40;
        finalHeight += 50;

        const squareSide = Math.max(finalWidth, finalHeight);

        return { width: squareSide, height: squareSide };
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

        const textContent = await this.extractNodeText(noteFile);

        for (const node of canvasData.nodes) {
            // 仅更新文本内容，不涉及尺寸调整
            if (node.type === 'text' && typeof node.text === 'string' && node.text.includes(targetLink)) {
                
                const isContentDiff = node.text !== textContent;

                if (isContentDiff) {
                    node.text = textContent;
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

        // 【修改 3】：补充缺失的 Group（如果跳转到白板卡片，发现只有卡片没有 Group，自动创建）
        if (targetNode) {
            const hasGroup = canvasData.nodes.some(n => n.type === 'group' && n.label === noteFile.basename);
            if (!hasGroup) {
                const groupId = Math.random().toString(36).substring(2, 15);
                const newGroup: CanvasNode = {
                    id: groupId,
                    type: "group",
                    label: noteFile.basename, // Group 名字与文件名保持一致
                    x: targetNode.x,          // 严格保持一致
                    y: targetNode.y,
                    width: targetNode.width,
                    height: targetNode.height
                };
                
                // 插入到数组最前端，确保渲染时处于底层背景
                canvasData.nodes.unshift(newGroup);
                updated = true;
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
        } catch {
            new Notice("无法读取白板数据");
            return null;
        }

        if (!canvasData.nodes) canvasData.nodes = [];

        const targetPath = noteFile.path;
        const targetLink = `[[${noteFile.basename}`;
        
        for (const node of canvasData.nodes) {
            if (node.type === 'file' && node.file === targetPath) return node.id;
            if (node.type === 'text' && typeof node.text === 'string' && node.text.includes(targetLink)) return node.id;
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

        // 【修改 2】：同时生成恰好包围该卡片的 Group，名字完全一致，长宽严格一致
        const groupId = Math.random().toString(36).substring(2, 15);
        const newGroup: CanvasNode = {
            id: groupId,
            type: "group",
            label: noteFile.basename,
            x: newNode.x,
            y: newNode.y,
            width: newNode.width,
            height: newNode.height
        };

        // 先把 group 推入数组，让它处于底层，避免挡住文本节点
        canvasData.nodes.push(newGroup);
        canvasData.nodes.push(newNode);

        await this.app.vault.modify(canvasFile, JSON.stringify(canvasData, null, "\t"));
        
        return newNodeId; 
    }

    // 在白板中调整 Group 使其严格包围对应卡片
    async adjustGroupsInCanvas(canvasFile: TFile) {
        try {
            const content = await this.app.vault.read(canvasFile);
            const canvasData = JSON.parse(content) as CanvasData;
            if (!canvasData.nodes) return;

            let updated = false;

            const groups = canvasData.nodes.filter(n => n.type === 'group');
            const nonGroups = canvasData.nodes.filter(n => n.type !== 'group');

            for (const group of groups) {
                // 判断当前 group 的范围内，包含了多少个其他卡片 (基于中心点判断)
                const nodesInside = nonGroups.filter(n => {
                    const cx = n.x + n.width / 2;
                    const cy = n.y + n.height / 2;
                    return cx >= group.x && cx <= group.x + group.width &&
                           cy >= group.y && cy <= group.y + group.height;
                });

                // 如果 group 包含了一个以上卡片，则不必调整
                if (nodesInside.length > 1) continue;

                if (!group.label) continue;
                
                // 查找 group 对应的目标卡片
                const targetNode = canvasData.nodes.find(n => {
                    if (n.type === 'file' && typeof n.file === 'string') {
                        const basename = n.file.split('/').pop()?.replace(/\.md$/, '');
                        return basename === group.label;
                    }
                    if (n.type === 'text' && typeof n.text === 'string') {
                        // 包含链接的文本即判定为对应卡片
                        return n.text.includes(`[[${group.label}]]`) || 
                               n.text.includes(`[[${group.label}|`) || 
                               n.text.includes(`# [[${group.label}]]`);
                    }
                    return false;
                });

                if (targetNode) {
                    // 【修改 2】：取消全部偏移（Padding），使其长宽完全保持一致
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
                await this.app.vault.modify(canvasFile, JSON.stringify(canvasData, null, "\t"));
                new Notice("已调整白板中的 Group 尺寸与对应卡片完全对齐");
            } else {
                new Notice("没有需要调整的 Group");
            }

        } catch (error) {
            console.error(error);
            new Notice("调整 Group 失败");
        }
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
                item.onclick = async () => {
                    await this.openFile(file);
                };
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
                if (targetFiles.length === 1 && firstFile) {
                    void this.openFile(firstFile);
                }
                else {
                    const menu = new Menu();
                    targetFiles.forEach(f => {
                        menu.addItem(item => {
                            item.setTitle(this.cleanName(f.basename)).setIcon('link').onClick(async () => {
                                await this.openFile(f);
                            });
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

    async openFile(file: TFile) {
        if (file instanceof TFile) {
            await this.app.workspace.getLeaf(false).openFile(file);
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
            
            if (type === 'potential') {
                setIcon(iconBox, 'circle-dashed'); 
                iconBox.title = "未引用 (点击添加)";
                iconBox.addClass('potential-ref'); 
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
            .setName('Enable navigation bar')
            .setDesc('Show breadcrumbs and prev/next buttons at the top of the note.')
            .addToggle(t => t.setValue(this.plugin.settings.enableNav).onChange(async v => {
                this.plugin.settings.enableNav = v;
                await this.plugin.saveData(this.plugin.settings);
                this.plugin.updateAllViews();
            }));
    }
}