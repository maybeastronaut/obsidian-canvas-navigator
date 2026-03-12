import { App, PluginSettingTab, Setting } from 'obsidian';

import type { CanvasEdgePathMode } from '../features/canvas/canvasTypes';
import type CanvasNavigatorPlugin from '../plugin/CanvasNavigatorPlugin';

export class BreadcrumbSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: CanvasNavigatorPlugin) {
        super(app, plugin);
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Enable navigation bar')
            .setDesc('Show breadcrumbs and prev/next buttons at the top of the note.')
            .addToggle(t =>
                t.setValue(this.plugin.settings.enableNav).onChange(async v => {
                    this.plugin.settings.enableNav = v;
                    await this.plugin.saveData(this.plugin.settings);
                    this.plugin.updateAllViews();
                }),
            );

        new Setting(containerEl)
            .setName('Default canvas edge path mode')
            .setDesc('Choose whether canvas edges default to square or native paths.')
            .addDropdown(dropdown =>
                dropdown
                    .addOption('native', 'Native')
                    .addOption('square', 'Square')
                    .setValue(this.plugin.settings.defaultCanvasEdgePathMode)
                    .onChange(async value => {
                        this.plugin.settings.defaultCanvasEdgePathMode = value as CanvasEdgePathMode;
                        await this.plugin.saveData(this.plugin.settings);
                        this.plugin.refreshCanvasEdgeRendering();
                    }),
            );
    }
}
