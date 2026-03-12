import { App, Component, MarkdownRenderer, TFile } from 'obsidian';

import { CARD_MAX_WIDTH, CARD_MIN_WIDTH } from '../../constants/layout';
import { cleanName } from '../../utils/nameUtils';

export class NoteNodeContentService {
    constructor(private app: App) {}

    async extractNodeText(file: TFile): Promise<string> {
        const cache = this.app.metadataCache.getFileCache(file);
        let descContent = '';

        if (cache?.frontmatter && typeof cache.frontmatter['description'] === 'string') {
            descContent = cache.frontmatter['description'];
        } else {
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

        const cleanedTitle = cleanName(file.basename);
        return `# [[${file.basename}|${cleanedTitle}]]\n\n${descContent}`;
    }

    async measureTextPrecisely(text: string): Promise<{ width: number; height: number }> {
        const wrapper = document.body.createDiv();
        wrapper.addClass('canvas-measure-wrapper');
        // eslint-disable-next-line obsidianmd/no-static-styles-assignment
        wrapper.setAttribute('style', 'position: absolute; top: -9999px; left: -9999px; visibility: hidden; z-index: -1;');

        const nodeContent = wrapper.createDiv({
            cls: 'canvas-node-content markdown-preview-view canvas-measure-content',
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
}
