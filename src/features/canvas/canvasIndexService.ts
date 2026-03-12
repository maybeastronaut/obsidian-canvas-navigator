import { App, Plugin, TAbstractFile, TFile } from 'obsidian';

import type { CanvasData } from './canvasTypes';

export class CanvasIndexService {
    private canvasIndex: Map<string, Set<string>> = new Map();
    private reverseCanvasIndex: Map<string, Set<string>> = new Map();
    private rebuildTimer: number | null = null;

    constructor(private app: App) {}

    setupListeners(plugin: Plugin, onMarkdownModify: (file: TFile) => void | Promise<void>) {
        plugin.registerEvent(this.app.vault.on('modify', async (file: TAbstractFile) => {
            if (file instanceof TFile) {
                if (file.extension === 'canvas') {
                    await this.indexSingleCanvas(file);
                } else if (file.extension === 'md') {
                    await onMarkdownModify(file);
                }
            }
        }));

        plugin.registerEvent(this.app.vault.on('delete', (file: TAbstractFile) => {
            if (file instanceof TFile && file.extension === 'canvas') {
                this.removeCanvasReferences(file.path);
            }
        }));

        plugin.registerEvent(this.app.vault.on('rename', async (file: TAbstractFile, oldPath: string) => {
            if (file instanceof TFile && file.extension === 'canvas') {
                this.removeCanvasReferences(oldPath);
                await this.indexSingleCanvas(file);
            }
        }));

        plugin.registerEvent(this.app.metadataCache.on('resolved', () => {
            this.scheduleRebuildFromMetadata();
        }));
    }

    async buildCanvasIndex() {
        const start = Date.now();
        const metadataIndexed = this.rebuildFromResolvedLinks();
        const canvasFiles = this.app.vault.getFiles().filter(f => f.extension === 'canvas');
        const missingCanvasFiles = canvasFiles.filter(file => !this.canvasIndex.has(file.path));

        const BATCH_SIZE = 5;
        const YIELD_INTERVAL = 20;
        let processed = 0;

        for (let i = 0; i < missingCanvasFiles.length; i += BATCH_SIZE) {
            const batch = missingCanvasFiles.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(file => this.indexSingleCanvasFromJson(file)));
            processed += batch.length;

            if (i + BATCH_SIZE < missingCanvasFiles.length) {
                await new Promise(resolve => setTimeout(resolve, YIELD_INTERVAL));
            }
        }

        console.debug(
            `[BreadcrumbPlugin] Indexed ${canvasFiles.length} canvas files in ${Date.now() - start}ms `
            + `(metadata: ${metadataIndexed}, fallback: ${processed})`,
        );
    }

    async indexSingleCanvas(file: TFile) {
        if (this.indexCanvasFromResolvedLinks(file.path)) return;
        await this.indexSingleCanvasFromJson(file);
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

    getIndexEntries() {
        return this.canvasIndex.entries();
    }

    getCanvasPathsReferencing(targetPath: string): string[] {
        const relatedCanvases = this.reverseCanvasIndex.get(targetPath);
        if (!relatedCanvases) return [];
        return Array.from(relatedCanvases);
    }

    clear() {
        if (this.rebuildTimer !== null) {
            window.clearTimeout(this.rebuildTimer);
            this.rebuildTimer = null;
        }

        this.canvasIndex.clear();
        this.reverseCanvasIndex.clear();
    }

    private scheduleRebuildFromMetadata() {
        if (this.rebuildTimer !== null) {
            window.clearTimeout(this.rebuildTimer);
        }

        this.rebuildTimer = window.setTimeout(() => {
            this.rebuildTimer = null;
            void this.buildCanvasIndex();
        }, 500);
    }

    private rebuildFromResolvedLinks(): number {
        this.canvasIndex.clear();
        this.reverseCanvasIndex.clear();

        let indexed = 0;
        const { resolvedLinks } = this.app.metadataCache;

        for (const [sourcePath, destinations] of Object.entries(resolvedLinks)) {
            if (!sourcePath.endsWith('.canvas')) continue;

            const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
            if (!(sourceFile instanceof TFile) || sourceFile.extension !== 'canvas') continue;

            this.setCanvasReferences(sourcePath, new Set<string>(Object.keys(destinations ?? {})));
            indexed++;
        }

        return indexed;
    }

    private indexCanvasFromResolvedLinks(canvasPath: string): boolean {
        const destinations = this.app.metadataCache.resolvedLinks[canvasPath];
        if (!destinations) return false;

        this.setCanvasReferences(canvasPath, new Set<string>(Object.keys(destinations)));
        return true;
    }

    private async indexSingleCanvasFromJson(file: TFile) {
        try {
            const content = await this.app.vault.read(file);
            const data = JSON.parse(content) as CanvasData;
            const referencedPaths = new Set<string>();

            if (data.nodes && Array.isArray(data.nodes)) {
                for (const node of data.nodes) {
                    if (node.type === 'file' && typeof node.file === 'string') {
                        referencedPaths.add(node.file);
                    } else if (node.type === 'text' && typeof node.text === 'string') {
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

            this.setCanvasReferences(file.path, referencedPaths);
        } catch (error) {
            console.error(`[BreadcrumbPlugin] Failed to index canvas: ${file.path}`, error);
            this.removeCanvasReferences(file.path);
        }
    }

    private setCanvasReferences(canvasPath: string, referencedPaths: Set<string>) {
        this.removeCanvasReferences(canvasPath);
        this.canvasIndex.set(canvasPath, referencedPaths);

        for (const targetPath of referencedPaths) {
            let fromCanvases = this.reverseCanvasIndex.get(targetPath);
            if (!fromCanvases) {
                fromCanvases = new Set<string>();
                this.reverseCanvasIndex.set(targetPath, fromCanvases);
            }
            fromCanvases.add(canvasPath);
        }
    }

    private removeCanvasReferences(canvasPath: string) {
        const existing = this.canvasIndex.get(canvasPath);
        if (existing) {
            for (const targetPath of existing) {
                const fromCanvases = this.reverseCanvasIndex.get(targetPath);
                if (!fromCanvases) continue;

                fromCanvases.delete(canvasPath);
                if (fromCanvases.size === 0) {
                    this.reverseCanvasIndex.delete(targetPath);
                }
            }
        }

        this.canvasIndex.delete(canvasPath);
    }
}
