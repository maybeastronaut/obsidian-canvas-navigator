import type { TFile, View } from 'obsidian';

export interface CanvasNode {
    id: string;
    type: string;
    text?: string;
    file?: string;
    label?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    filePath?: string;
    [key: string]: unknown;
}

export interface CanvasEdgeStyleAttributes {
    pathfindingMethod?: string;
    [key: string]: unknown;
}

export type CanvasEdgePathMode = 'native' | 'square';

export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';

export interface CanvasRuntimePosition {
    x: number;
    y: number;
}

export interface CanvasRuntimeEdgePathTarget {
    setAttr?: (key: string, value: string) => void;
    setAttribute?: (key: string, value: string) => void;
}

export interface CanvasRuntimeNode {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    getBBox?: () => {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
    };
    [key: string]: unknown;
}

export interface CanvasRuntimeEdgeEnd {
    node: CanvasRuntimeNode;
    side?: CanvasSide;
    end?: string;
}

export interface CanvasRuntimeEdge {
    id: string;
    from: CanvasRuntimeEdgeEnd;
    to: CanvasRuntimeEdgeEnd;
    styleAttributes?: CanvasEdgeStyleAttributes;
    pathfindingMethod?: string;
    bezier?: {
        from: CanvasRuntimePosition;
        to: CanvasRuntimePosition;
        [key: string]: unknown;
    };
    path?: {
        interaction?: CanvasRuntimeEdgePathTarget;
        display?: CanvasRuntimeEdgePathTarget;
        [key: string]: unknown;
    };
    labelElement?: {
        render?: () => void;
        [key: string]: unknown;
    };
    getData?: () => CanvasEdge;
    setData?: (data: CanvasEdge) => void;
    updatePath?: (...args: unknown[]) => unknown;
    center?: CanvasRuntimePosition;
    [key: string]: unknown;
}

export interface CanvasEdge {
    id: string;
    fromNode: string;
    toNode: string;
    styleAttributes?: CanvasEdgeStyleAttributes;
    pathfindingMethod?: string;
    [key: string]: unknown;
}

export interface CanvasData {
    nodes: CanvasNode[];
    edges?: CanvasEdge[];
}

export interface CanvasView extends View {
    file: TFile | null;
    canvas: {
        nodes: Map<string, CanvasNode>;
        edges?: Map<string, CanvasRuntimeEdge>;
        selection?: Set<unknown>;
        select: (node: CanvasNode) => void;
        zoomToSelection: () => void;
        [key: string]: unknown;
    };
}

export interface ReferenceResult {
    file: TFile;
    type: 'existing' | 'potential';
}

export interface NeighborResult {
    prevs: TFile[];
    nexts: TFile[];
}
