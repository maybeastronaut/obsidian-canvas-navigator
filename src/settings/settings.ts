import type { CanvasEdgePathMode } from '../features/canvas/canvasTypes';

export interface BreadcrumbSettings {
    enableNav: boolean;
    defaultCanvasEdgePathMode: CanvasEdgePathMode;
}

export const DEFAULT_SETTINGS: BreadcrumbSettings = {
    enableNav: true,
    defaultCanvasEdgePathMode: 'native',
};
