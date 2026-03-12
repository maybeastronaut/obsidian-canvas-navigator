import type { App, TFile } from 'obsidian';

export function parseLinks(field: unknown): string[] {
    if (!field) return [];

    const list = Array.isArray(field) ? field : [field];
    return list
        .map((item: unknown) => {
            if (typeof item !== 'string') return null;

            const match = item.match(/\[\[(.*?)\]\]/);
            if (match && match[1]) {
                return match[1].split('|')[0];
            }

            return item;
        })
        .filter(Boolean) as string[];
}

export function containsLink(field: unknown, targetBasename: string): boolean {
    const links = parseLinks(field);

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

export function resolveFile(app: App, linkText: string, sourcePath = ''): TFile | null {
    if (!linkText) return null;
    return app.metadataCache.getFirstLinkpathDest(linkText, sourcePath);
}
