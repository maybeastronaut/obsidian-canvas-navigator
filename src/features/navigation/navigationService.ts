import { App, TFile } from 'obsidian';

import type { NeighborResult } from '../canvas/canvasTypes';
import { containsLink, parseLinks, resolveFile } from '../../utils/linkUtils';

export class NavigationService {
    constructor(private app: App) {}

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

    getNeighbors(file: TFile): NeighborResult {
        const prevs = new Map<string, TFile>();
        const nexts = new Map<string, TFile>();
        const myName = file.basename;
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;

        if (fm) {
            parseLinks(fm.prev).forEach(link => {
                const f = resolveFile(this.app, link);
                if (f) prevs.set(f.path, f);
            });

            parseLinks(fm.next).forEach(link => {
                const f = resolveFile(this.app, link);
                if (f) nexts.set(f.path, f);
            });
        }

        const allFiles = this.app.vault.getMarkdownFiles();
        for (const f of allFiles) {
            if (f.path === file.path) continue;
            const c = this.app.metadataCache.getFileCache(f);
            const links = c?.frontmatter;
            if (!links) continue;
            if (links.next && containsLink(links.next, myName)) prevs.set(f.path, f);
            if (links.prev && containsLink(links.prev, myName)) nexts.set(f.path, f);
        }

        return {
            prevs: Array.from(prevs.values()),
            nexts: Array.from(nexts.values()),
        };
    }

    async openFile(file: TFile) {
        if (file instanceof TFile) {
            await this.app.workspace.getLeaf(false).openFile(file);
        }
    }

    private getParentFile(file: TFile): TFile | null {
        const cache = this.app.metadataCache.getFileCache(file);
        const upLinks = parseLinks(cache?.frontmatter?.up);
        const firstLink = upLinks[0];

        if (firstLink) {
            return resolveFile(this.app, firstLink);
        }

        return null;
    }
}
