// @ts-nocheck
import { Plugin, PluginSettingTab, Setting, TFile, MarkdownView, Menu, Modal, Notice, MarkdownRenderer, Component, TAbstractFile } from 'obsidian';

// --- 样式定义 ---
const STYLES = `
/* ...原有样式保持不变... */
.nav-header-wrapper {
    width: 100%;
    max-width: var(--file-line-width);
    margin: 0 auto; 
    display: flex;
    flex-direction: column; 
    gap: 12px; 
    padding-top: 10px;
    padding-bottom: 20px;
    font-size: 14px;
    line-height: 1.5;
}
.nav-breadcrumbs-container {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center; 
    background-color: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    padding: 8px 16px;
    flex-wrap: wrap;
    gap: 6px;
    min-height: 40px;
}
.breadcrumb-item {
    cursor: pointer;
    color: var(--text-muted);
    transition: color 0.2s ease;
    border-radius: 4px;
    padding: 2px 4px;
}
.breadcrumb-item:hover {
    color: var(--text-normal);
    background-color: var(--background-modifier-hover);
}
.breadcrumb-item.current {
    color: var(--text-normal);
    font-weight: 600;
    cursor: default;
}
.breadcrumb-item.current:hover {
    background-color: transparent;
}
.breadcrumb-separator {
    color: var(--text-faint);
    font-size: 12px;
}
.nav-buttons-row {
    width: 100%;
    display: flex;
    justify-content: space-between; 
    gap: 20px;
}
.nav-btn-box {
    flex: 1; 
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background-color: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    padding: 10px;
    cursor: pointer;
    transition: all 0.2s ease;
    color: var(--text-muted);
    min-width: 0; 
}
.nav-btn-box:hover {
    background-color: var(--background-primary);
    border-color: var(--interactive-accent);
    color: var(--text-normal);
    box-shadow: 0 2px 8px rgba(0,0,0,0.05);
}
.nav-btn-box.disabled {
    opacity: 0.4;
    cursor: not-allowed;
    background-color: transparent;
    border-style: dashed;
}
.nav-btn-box.disabled:hover {
    background-color: transparent;
    border-color: var(--background-modifier-border);
    color: var(--text-muted);
    box-shadow: none;
}
.nav-btn-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
}

/* --- Canvas Modal 样式 --- */
.canvas-ref-modal .modal-content {
    padding-top: 10px;
}
.canvas-ref-item {
    display: flex;
    align-items: center;
    padding: 14px 16px;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s ease;
    border: 1px solid var(--background-modifier-border);
    margin-bottom: 8px;
    background-color: var(--background-secondary);
}
.canvas-ref-item:hover {
    background-color: var(--background-primary);
    border-color: var(--interactive-accent);
    transform: translateX(4px);
}
.canvas-ref-icon {
    margin-right: 12px;
    color: var(--interactive-accent);
    display: flex;
    align-items: center;
    opacity: 0.8;
}
.canvas-ref-name {
    font-weight: 500;
    font-size: 15px;
    color: var(--text-normal);
    flex: 1;
}
.canvas-ref-badge {
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 4px;
    margin-left: 10px;
}
.badge-existing {
    background-color: rgba(var(--interactive-accent-rgb), 0.1);
    color: var(--interactive-accent);
}
.badge-potential {
    background-color: var(--background-modifier-border);
    color: var(--text-muted);
    border: 1px dashed var(--text-muted);
}
`;

const DEFAULT_SETTINGS = {
    enableNav: true
};

export default class BreadcrumbPlugin extends Plugin {
    // --- 内部索引 ---
    // Key: Canvas文件路径, Value: 该Canvas引用的所有文件路径集合 (Set)
    canvasIndex = new Map();

    async onload() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.injectStyles();
        this.addSettingTab(new BreadcrumbSettingTab(this.app, this));

        this.registerEvent(this.app.workspace.on('file-open', () => this.updateAllViews()));
        this.registerEvent(this.app.metadataCache.on('changed', () => this.updateAllViews()));
        
        this.app.workspace.onLayoutReady(() => {
            this.updateAllViews();
            
            // --- 性能优化：延迟启动索引构建 ---
            setTimeout(() => {
                this.buildCanvasIndex();
            }, 2000);
        });

        // 注册文件变动监听，实时更新索引
        this.setupIndexListeners();
        
        this.addCommand({
            id: 'toggle-breadcrumb-nav',
            name: 'Toggle/Refresh Breadcrumb Nav',
            callback: () => this.updateAllViews()
        });

        this.addCommand({
            id: 'check-canvas-references',
            name: 'Check Canvas References (Existing & Potential)',
            checkCallback: (checking) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (!activeFile) return false;
                if (checking) return true;
                this.scanCanvasFiles(activeFile);
            }
        });
    }

    onunload() {
        document.getElementById('breadcrumb-nav-styles')?.remove();
        document.querySelectorAll('.nav-header-wrapper').forEach(el => el.remove());
        this.canvasIndex.clear();
    }

    injectStyles() {
        if (!document.getElementById('breadcrumb-nav-styles')) {
            const style = document.createElement('style');
            style.id = 'breadcrumb-nav-styles';
            style.textContent = STYLES;
            document.head.appendChild(style);
        }
    }

    // --- 核心：内部索引管理与自动同步 ---
    
    setupIndexListeners() {
        // 监听文件修改
        this.registerEvent(this.app.vault.on('modify', async (file) => {
            if (file instanceof TFile) {
                // 1. 如果是 Canvas 文件，更新索引
                if (file.extension === 'canvas') {
                    this.indexSingleCanvas(file);
                } 
                // 2. 如果是 Markdown 文件，尝试自动同步更新所有引用它的白板 (新功能)
                else if (file.extension === 'md') {
                    await this.autoSyncToCanvases(file);
                }
            }
        }));
        
        // 监听文件删除
        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (file instanceof TFile && file.extension === 'canvas') {
                this.canvasIndex.delete(file.path);
            }
        }));
        // 监听文件重命名 (如果 Canvas 被重命名，更新 Key)
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (file instanceof TFile && file.extension === 'canvas') {
                this.canvasIndex.delete(oldPath);
                this.indexSingleCanvas(file);
            }
        }));
    }

    // --- 性能优化核心：分批构建索引 (Batched Build) ---
    async buildCanvasIndex() {
        const start = Date.now();
        const canvasFiles = this.app.vault.getFiles().filter(f => f.extension === 'canvas');
        
        // 配置：每次处理多少个文件，以及间隔多少毫秒
        const BATCH_SIZE = 5; 
        const YIELD_INTERVAL = 20;

        let processed = 0;

        for (let i = 0; i < canvasFiles.length; i += BATCH_SIZE) {
            // 取出一批文件
            const batch = canvasFiles.slice(i, i + BATCH_SIZE);
            
            // 并发处理这一小批
            await Promise.all(batch.map(file => this.indexSingleCanvas(file)));
            
            processed += batch.length;

            // 关键：处理完一批后，强制暂停一下，让出主线程给 UI 渲染
            if (i + BATCH_SIZE < canvasFiles.length) {
                await new Promise(resolve => setTimeout(resolve, YIELD_INTERVAL));
            }
        }
        
        console.log(`[BreadcrumbPlugin] Indexed ${processed} canvas files in ${Date.now() - start}ms (Background Batched)`);
    }

    async indexSingleCanvas(file) {
        try {
            const content = await this.app.vault.read(file);
            const data = JSON.parse(content);
            const referencedPaths = new Set();

            if (data.nodes && Array.isArray(data.nodes)) {
                for (const node of data.nodes) {
                    // 1. 文件节点 (File Nodes)
                    if (node.type === 'file' && node.file) {
                        referencedPaths.add(node.file);
                    }
                    // 2. 文本卡片中的链接 (Text Nodes with WikiLinks)
                    else if (node.type === 'text' && node.text) {
                        const links = this.extractWikiLinks(node.text);
                        for (const linkText of links) {
                            // 解析链接为实际路径
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
            console.warn(`[BreadcrumbPlugin] Failed to index canvas: ${file.path}`, e);
            this.canvasIndex.delete(file.path);
        }
    }

    extractWikiLinks(text) {
        const matches = text.matchAll(/\[\[(.*?)\]\]/g);
        const links = [];
        for (const match of matches) {
            // 处理 [[Link|Alias]] 的情况
            links.push(match[1].split('|')[0]);
        }
        return links;
    }

    // --- 引用查询逻辑 (Updated: 使用内部索引) ---
    
    async scanCanvasFiles(targetFile) {
        const resultMap = new Map();
        
        // 1. 查询内部索引 (瞬时完成)
        const targetPath = targetFile.path;
        
        for (const [canvasPath, refSet] of this.canvasIndex.entries()) {
            if (refSet.has(targetPath)) {
                // 需要获取 TFile 对象
                const canvasFile = this.app.vault.getAbstractFileByPath(canvasPath);
                if (canvasFile && canvasFile instanceof TFile) {
                    resultMap.set(canvasPath, { file: canvasFile, type: 'existing' });
                }
            }
        }

        // 2. 推断潜在引用
        const potentialCanvases = this.findPotentialCanvases(targetFile);
        
        // 3. 合并结果
        for (const canvas of potentialCanvases) {
            // 如果已经在 Existing 列表中，跳过
            if (resultMap.has(canvas.path)) continue; 

            // 如果不在 Existing 列表中，说明真的没有引用
            resultMap.set(canvas.path, { file: canvas, type: 'potential' });
        }

        const results = Array.from(resultMap.values());

        if (results.length > 0) {
            new CanvasReferencesModal(this.app, results, targetFile, this).open();
        } else {
            new Notice(`未找到现有引用或潜在的白板关联。`);
        }
    }

    findPotentialCanvases(startFile) {
        const potentials = [];
        let queue = [startFile];
        const visited = new Set([startFile.path]);

        while(queue.length > 0) {
            const curr = queue.shift();
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

    // --- 自动同步逻辑 (New) ---
    async autoSyncToCanvases(file) {
        const targetPath = file.path;
        
        // 查找引用了此文件的所有 Canvas
        const relatedCanvases = [];
        for (const [canvasPath, refSet] of this.canvasIndex.entries()) {
            if (refSet.has(targetPath)) {
                relatedCanvases.push(canvasPath);
            }
        }

        if (relatedCanvases.length === 0) return;

        // 遍历所有相关的白板，进行无声同步
        for (const canvasPath of relatedCanvases) {
            try {
                const canvasFile = this.app.vault.getAbstractFileByPath(canvasPath);
                if (canvasFile && canvasFile instanceof TFile) {
                    // 调用已有的同步方法
                    await this.syncNodeInCanvas(canvasFile, file);
                }
            } catch (e) {
                console.error(`[BreadcrumbPlugin] Failed to auto-sync to canvas: ${canvasPath}`, e);
            }
        }
    }

    // --- 内容提取 ---
    async extractNodeText(file) {
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

    // --- 真实渲染测量 (Render & Measure) ---
    async measureTextPrecisely(text) {
        const wrapper = document.body.createDiv();
        wrapper.style.position = 'absolute';
        wrapper.style.visibility = 'hidden';
        wrapper.style.top = '-9999px';
        wrapper.style.left = '-9999px';

        const cardWidth = 400; 
        
        const nodeContent = wrapper.createDiv({
            cls: 'canvas-node-content markdown-preview-view'
        });
        
        nodeContent.style.width = `${cardWidth}px`;
        nodeContent.style.padding = '16px'; 
        nodeContent.style.boxSizing = 'border-box';
        nodeContent.style.overflowWrap = 'break-word';

        const component = new Component();
        await MarkdownRenderer.render(this.app, text, nodeContent, '', component);

        const height = nodeContent.scrollHeight;
        
        component.unload();
        wrapper.remove();

        return { width: cardWidth, height: height + 4 };
    }

    // --- 同步与重排：保证完美贴合 ---
    // 检查已存在的卡片，更新其内容和尺寸以匹配当前文件状态
    async syncNodeInCanvas(canvasFile, noteFile) {
        let canvasData;
        try {
            const content = await this.app.vault.read(canvasFile);
            canvasData = JSON.parse(content);
        } catch (e) {
            return null;
        }

        if (!canvasData.nodes) return null;

        const targetPath = noteFile.path;
        const targetLink = `[[${noteFile.basename}`;
        let updated = false;
        let targetNodeId = null;

        // 1. 获取当前笔记的最新文本和完美尺寸
        const textContent = await this.extractNodeText(noteFile);
        const { width, height } = await this.measureTextPrecisely(textContent);

        // 2. 遍历白板节点寻找目标
        for (const node of canvasData.nodes) {
            // 我们主要关注由本插件生成的 Text 节点 (包含 WikiLink)
            // 或者是用户手动创建但包含该链接的文本卡片
            if (node.type === 'text' && node.text && node.text.includes(targetLink)) {
                
                // 检查是否需要更新 (内容不同，或者尺寸误差超过 2px)
                const isContentDiff = node.text !== textContent;
                const isSizeDiff = Math.abs((node.width || 0) - width) > 2 || Math.abs((node.height || 0) - height) > 2;

                if (isContentDiff || isSizeDiff) {
                    node.text = textContent;
                    node.width = width;
                    node.height = height;
                    updated = true;
                }
                // 记录 ID 用于跳转
                targetNodeId = node.id;
            }
        }

        // 3. 如果没找到文本节点，尝试找原生的 File 节点
        // File 节点通常不需要更新内容（它是引用），也不建议强制 Resize（因为渲染方式不同）
        // 但我们需要返回 ID 以便缩放
        if (!targetNodeId) {
             for (const node of canvasData.nodes) {
                if (node.type === 'file' && node.file === targetPath) {
                    targetNodeId = node.id;
                    break;
                }
             }
        }

        // 4. 如果有变动，写入文件
        if (updated) {
            await this.app.vault.modify(canvasFile, JSON.stringify(canvasData, null, "\t"));
        }

        return targetNodeId;
    }

    // --- 添加到白板 (使用精准尺寸) ---
    async addToCanvas(canvasFile, noteFile) {
        let canvasData;
        try {
            const jsonStr = await this.app.vault.read(canvasFile);
            canvasData = JSON.parse(jsonStr);
        } catch (e) {
            new Notice("无法读取白板数据");
            return null;
        }

        if (!canvasData.nodes) canvasData.nodes = [];

        const targetPath = noteFile.path;
        const targetLink = `[[${noteFile.basename}`;
        
        // 检查重复 (安全网)
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
        const newNode = {
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

    // --- 视图更新 ---
    updateAllViews() {
        this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            if (leaf.view instanceof MarkdownView) {
                this.renderView(leaf.view);
            }
        });
    }

    renderView(view) {
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
        if (showButtons) this.renderButtonsRow(wrapper, prevs, nexts);
    }

    getBreadcrumbPath(currentFile) {
        const path = [];
        let curr = currentFile;
        const seen = new Set(); 
        while (curr) {
            if (seen.has(curr.path)) break;
            seen.add(curr.path);
            path.unshift(curr); 
            curr = this.getParentFile(curr);
        }
        return path;
    }

    renderBreadcrumbsRow(container, path) {
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

    renderButtonsRow(container, prevs, nexts) {
        const row = container.createDiv({ cls: 'nav-buttons-row' });
        this.createBoxButton(row, 'left', prevs);
        this.createBoxButton(row, 'right', nexts);
    }

    createBoxButton(container, direction, targetFiles) {
        const hasFiles = targetFiles && targetFiles.length > 0;
        const btn = container.createDiv({ 
            cls: `nav-btn-box ${!hasFiles ? 'disabled' : ''}` 
        });
        let labelText = '';
        if (!hasFiles) labelText = direction === 'left' ? '无上一篇' : '无下一篇';
        else if (targetFiles.length === 1) labelText = this.cleanName(targetFiles[0].basename);
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
                if (targetFiles.length === 1) this.openFile(targetFiles[0]);
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

    getParentFile(file) {
        const cache = this.app.metadataCache.getFileCache(file);
        const upLinks = this.parseLinks(cache?.frontmatter?.up);
        if (upLinks.length > 0) return this.resolveFile(upLinks[0]);
        return null;
    }

    getNeighbors(file) {
        const prevs = new Map();
        const nexts = new Map();
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

    cleanName(text) { return text.replace(/^[\d\.\-_]+\s+/, ''); }
    
    parseLinks(field) {
        if (!field) return [];
        const list = Array.isArray(field) ? field : [field];
        return list.map(item => {
            if (typeof item !== 'string') return null;
            const match = item.match(/\[\[(.*?)\]\]/);
            return match ? match[1].split('|')[0] : item;
        }).filter(Boolean);
    }

    containsLink(field, targetBasename) {
        const links = this.parseLinks(field);
        return links.some(link => {
            const linkName = link.split('/').pop().replace(/\.md$/, '');
            return linkName === targetBasename;
        });
    }

    resolveFile(linkText) {
        if (!linkText) return null;
        return this.app.metadataCache.getFirstLinkpathDest(linkText, '');
    }

    openFile(file) {
        if (file instanceof TFile) {
            this.app.workspace.getLeaf(false).openFile(file);
        }
    }
}

class CanvasReferencesModal extends Modal {
    constructor(app, results, targetFile, plugin) {
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
                iconBox.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`;
                iconBox.title = "未引用 (点击添加)";
                iconBox.style.color = "var(--text-accent)";
            } else {
                iconBox.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="12" y1="8" x2="12" y2="16"/></svg>`;
            }

            item.createDiv({ cls: 'canvas-ref-name', text: file.basename });
            
            const badge = item.createDiv({ 
                cls: `canvas-ref-badge ${type === 'existing' ? 'badge-existing' : 'badge-potential'}`,
                text: type === 'existing' ? 'Existing' : 'Add +'
            });

            item.onclick = async () => {
                this.close();
                let targetId = null;
                
                if (type === 'existing') {
                    // --- 核心变更：同步更新 ---
                    // 如果已存在，先尝试更新内容和尺寸，保证"完美贴合"
                    targetId = await this.plugin.syncNodeInCanvas(file, this.targetFile);
                } else {
                    // 如果不存在，添加新节点
                    targetId = await this.plugin.addToCanvas(file, this.targetFile);
                }

                // --- 查找已打开的 Leaf ---
                let leaf = this.app.workspace.getLeavesOfType('canvas').find(l => l.view.file && l.view.file.path === file.path);
                
                if (leaf) {
                    this.app.workspace.setActiveLeaf(leaf, { focus: true });
                } else {
                    leaf = this.app.workspace.getLeaf(false);
                    await leaf.openFile(file);
                }
                
                // 等待视图准备好并缩放
                const view = leaf.view;
                if (view.getViewType() === 'canvas') {
                    if (targetId) {
                        this.tryZoomToNode(view, targetId, true);
                    } else {
                        // Fallback
                        this.tryZoomToNode(view, this.targetFile, false);
                    }
                }
            };
        });
    }

    tryZoomToNode(view, target, isId) {
        let attempts = 0;
        const maxAttempts = 30; 

        const poll = setInterval(() => {
            attempts++;
            const canvas = view.canvas;
            if (!canvas) return;

            let foundNode = null;

            if (isId) {
                if (canvas.nodes && canvas.nodes.has(target)) {
                    foundNode = canvas.nodes.get(target);
                }
            } else {
                for (const [id, node] of canvas.nodes) {
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
                // 再次缩放以防动画未完成
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
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Enable Navigation Bar')
            .setDesc('Show breadcrumbs and prev/next buttons at the top of the note.')
            .addToggle(t => t.setValue(this.plugin.settings.enableNav).onChange(async v => {
                this.plugin.settings.enableNav = v;
                await this.plugin.saveData(this.plugin.settings);
                this.plugin.updateAllViews();
            }));
    }
}