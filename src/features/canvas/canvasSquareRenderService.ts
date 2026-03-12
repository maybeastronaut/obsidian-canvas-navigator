import { App, WorkspaceLeaf } from 'obsidian';

import { buildSquarePath, type BBox } from './squarePathRouter';
import type {
    CanvasEdge,
    CanvasEdgePathMode,
    CanvasRuntimeEdge,
    CanvasRuntimePosition,
    CanvasSide,
    CanvasView,
} from './canvasTypes';

const PATCH_SCAN_INTERVAL_MS = 160;

interface PatchedEdgeState {
    edge: CanvasRuntimeEdge;
    originalUpdatePath: (...args: unknown[]) => unknown;
    wrappedUpdatePath: (...args: unknown[]) => unknown;
}

interface SquareRenderSession {
    patchIntervalId: number;
    patchedEdges: Map<string, PatchedEdgeState>;
}

export class CanvasSquareRenderService {
    private leafSessions = new Map<WorkspaceLeaf, SquareRenderSession>();

    constructor(
        private app: App,
        private getDefaultMode: () => CanvasEdgePathMode,
    ) {}

    refreshBindings() {
        const canvasLeaves = this.app.workspace.getLeavesOfType('canvas');

        for (const leaf of canvasLeaves) {
            const view = leaf.view as CanvasView;
            if (view.getViewType() !== 'canvas') {
                this.detachFromLeaf(leaf, false);
                continue;
            }

            if (this.shouldAttachToLeaf(view)) {
                this.attachToLeaf(leaf);
            } else {
                this.detachFromLeaf(leaf, true);
            }
        }
    }

    clear() {
        for (const leaf of Array.from(this.leafSessions.keys())) {
            this.detachFromLeaf(leaf, false);
        }
    }

    private shouldAttachToLeaf(view: CanvasView): boolean {
        if (this.getDefaultMode() === 'square') return true;
        return this.hasSquareEdgeInView(view);
    }

    private hasSquareEdgeInView(view: CanvasView): boolean {
        const edges = view.canvas.edges;
        if (!edges || typeof edges.values !== 'function') return false;

        for (const edge of edges.values()) {
            if (!this.isRuntimeEdge(edge)) continue;
            if (this.resolveEdgeMode(edge) === 'square') return true;
        }

        return false;
    }

    private attachToLeaf(leaf: WorkspaceLeaf) {
        if (this.leafSessions.has(leaf)) return;

        const session: SquareRenderSession = {
            patchIntervalId: window.setInterval(() => this.patchEdgesInLeaf(leaf), PATCH_SCAN_INTERVAL_MS),
            patchedEdges: new Map<string, PatchedEdgeState>(),
        };

        this.leafSessions.set(leaf, session);
        this.patchEdgesInLeaf(leaf);
    }

    private detachFromLeaf(leaf: WorkspaceLeaf, rerenderEdges: boolean) {
        const session = this.leafSessions.get(leaf);
        if (!session) return;

        window.clearInterval(session.patchIntervalId);
        this.restoreSessionEdges(session, rerenderEdges);
        this.leafSessions.delete(leaf);
    }

    private patchEdgesInLeaf(leaf: WorkspaceLeaf) {
        const session = this.leafSessions.get(leaf);
        if (!session) return;

        const view = leaf.view as CanvasView;
        if (view.getViewType() !== 'canvas') return;

        const edges = view.canvas.edges;
        if (!edges || typeof edges.values !== 'function') return;

        const seenEdgeIds = new Set<string>();

        for (const edge of edges.values()) {
            if (!this.isRuntimeEdge(edge)) continue;
            if (!edge.id || !this.hasUpdatePath(edge)) continue;

            seenEdgeIds.add(edge.id);

            if (!session.patchedEdges.has(edge.id)) {
                this.patchEdge(session, edge);
            }
        }

        for (const [edgeId, state] of Array.from(session.patchedEdges.entries())) {
            if (!seenEdgeIds.has(edgeId)) {
                this.restoreEdge(state, false);
                session.patchedEdges.delete(edgeId);
            }
        }
    }

    private patchEdge(
        session: SquareRenderSession,
        edge: CanvasRuntimeEdge & { updatePath: (...args: unknown[]) => unknown },
    ) {
        const originalUpdatePath = edge.updatePath;

        const wrappedUpdatePath = (...args: unknown[]) => {
            const result = originalUpdatePath.apply(edge, args);
            if (this.shouldRenderSquareEdge(edge)) {
                this.applySquarePath(edge);
            }
            return result;
        };

        edge.updatePath = wrappedUpdatePath;

        const state: PatchedEdgeState = {
            edge,
            originalUpdatePath,
            wrappedUpdatePath,
        };

        session.patchedEdges.set(edge.id, state);

        // Trigger once so existing edges are immediately rerouted.
        wrappedUpdatePath();
    }

    private shouldRenderSquareEdge(edge: CanvasRuntimeEdge): boolean {
        const mode = this.resolveEdgeMode(edge);
        if (mode === 'square') return true;
        if (mode === 'native') return false;
        return this.getDefaultMode() === 'square';
    }

    private resolveEdgeMode(edge: CanvasRuntimeEdge): CanvasEdgePathMode | null {
        const runtimeData = this.getRuntimeEdgeData(edge);
        const styleMode = this.readPathfindingMode(runtimeData?.styleAttributes);
        const rootMode = this.readString(runtimeData?.pathfindingMethod);
        const edgeStyleMode = this.readPathfindingMode(edge.styleAttributes);
        const edgeRootMode = this.readString(edge.pathfindingMethod);

        return this.normalizePathMode(styleMode ?? rootMode ?? edgeStyleMode ?? edgeRootMode);
    }

    private getRuntimeEdgeData(edge: CanvasRuntimeEdge): CanvasEdge | null {
        if (typeof edge.getData !== 'function') return null;

        const data = edge.getData();
        if (!data || typeof data !== 'object') return null;
        return data;
    }

    private readPathfindingMode(styleAttributes: unknown): string | null {
        if (!this.isRecord(styleAttributes)) return null;
        const value = styleAttributes.pathfindingMethod;
        return typeof value === 'string' ? value : null;
    }

    private readString(value: unknown): string | null {
        return typeof value === 'string' ? value : null;
    }

    private normalizePathMode(value: string | null): CanvasEdgePathMode | null {
        if (value === 'square') return 'square';
        if (value === 'native' || value === 'direct') return 'native';
        return null;
    }

    private applySquarePath(edge: CanvasRuntimeEdge) {
        const fromNode = edge.from?.node;
        const toNode = edge.to?.node;
        if (!fromNode || !toNode) return;

        const fromNodeBBox = this.nodeToBBox(fromNode);
        const toNodeBBox = this.nodeToBBox(toNode);
        if (!fromNodeBBox || !toNodeBBox) return;

        const fromSide = this.ensureSide(edge.from.side, fromNodeBBox, toNodeBBox);
        const toSide = this.ensureSide(edge.to.side, toNodeBBox, fromNodeBBox);

        const fromBBoxSidePos = this.centerOfBBoxSide(fromNodeBBox, fromSide);
        const toBBoxSidePos = this.centerOfBBoxSide(toNodeBBox, toSide);

        const fromPos = edge.from.end === 'none'
            ? fromBBoxSidePos
            : edge.bezier?.from ?? fromBBoxSidePos;

        const toPos = edge.to.end === 'none'
            ? toBBoxSidePos
            : edge.bezier?.to ?? toBBoxSidePos;

        const routed = buildSquarePath({
            fromNodeBBox,
            fromPos,
            fromBBoxSidePos,
            fromSide,
            toNodeBBox,
            toPos,
            toBBoxSidePos,
            toSide,
            rounded: false,
        });

        if (!routed) return;

        this.setSvgPath(edge.path?.interaction, routed.svgPath);
        this.setSvgPath(edge.path?.display, routed.svgPath);

        edge.center = routed.center;
        edge.labelElement?.render?.();
    }

    private restoreSessionEdges(session: SquareRenderSession, rerenderEdges: boolean) {
        for (const state of session.patchedEdges.values()) {
            this.restoreEdge(state, rerenderEdges);
        }
        session.patchedEdges.clear();
    }

    private restoreEdge(state: PatchedEdgeState, rerender: boolean) {
        if (this.hasUpdatePath(state.edge) && state.edge.updatePath === state.wrappedUpdatePath) {
            state.edge.updatePath = state.originalUpdatePath;
        }

        if (!rerender) return;

        try {
            state.originalUpdatePath.call(state.edge);
            state.edge.labelElement?.render?.();
        } catch {
            // Ignore runtime edge disposal races.
        }
    }

    private setSvgPath(target: unknown, path: string) {
        if (!target) return;

        if (this.hasSetAttr(target)) {
            target.setAttr('d', path);
            return;
        }

        if (this.hasSetAttribute(target)) {
            target.setAttribute('d', path);
        }
    }

    private nodeToBBox(node: unknown): BBox | null {
        const withBBox = node as { getBBox?: () => BBox };
        if (typeof withBBox.getBBox === 'function') {
            const bbox = withBBox.getBBox();
            if (bbox && this.isFiniteBBox(bbox)) {
                return bbox;
            }
        }

        const withRect = node as { x?: number; y?: number; width?: number; height?: number };
        if (
            typeof withRect.x === 'number'
            && typeof withRect.y === 'number'
            && typeof withRect.width === 'number'
            && typeof withRect.height === 'number'
        ) {
            return {
                minX: withRect.x,
                minY: withRect.y,
                maxX: withRect.x + withRect.width,
                maxY: withRect.y + withRect.height,
            };
        }

        return null;
    }

    private ensureSide(side: unknown, sourceBBox: BBox, targetBBox: BBox): CanvasSide {
        if (this.isSide(side)) return side;

        const sourceCenter = {
            x: (sourceBBox.minX + sourceBBox.maxX) / 2,
            y: (sourceBBox.minY + sourceBBox.maxY) / 2,
        };

        const targetCenter = {
            x: (targetBBox.minX + targetBBox.maxX) / 2,
            y: (targetBBox.minY + targetBBox.maxY) / 2,
        };

        const dx = targetCenter.x - sourceCenter.x;
        const dy = targetCenter.y - sourceCenter.y;

        if (Math.abs(dx) >= Math.abs(dy)) {
            return dx >= 0 ? 'right' : 'left';
        }

        return dy >= 0 ? 'bottom' : 'top';
    }

    private centerOfBBoxSide(bbox: BBox, side: CanvasSide): CanvasRuntimePosition {
        switch (side) {
            case 'top':
                return { x: (bbox.minX + bbox.maxX) / 2, y: bbox.minY };
            case 'right':
                return { x: bbox.maxX, y: (bbox.minY + bbox.maxY) / 2 };
            case 'bottom':
                return { x: (bbox.minX + bbox.maxX) / 2, y: bbox.maxY };
            case 'left':
                return { x: bbox.minX, y: (bbox.minY + bbox.maxY) / 2 };
        }
    }

    private isFiniteBBox(bbox: BBox): boolean {
        return [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY].every(value => Number.isFinite(value));
    }

    private isRuntimeEdge(edge: unknown): edge is CanvasRuntimeEdge {
        if (!edge || typeof edge !== 'object') return false;

        const candidate = edge as {
            id?: unknown;
            from?: unknown;
            to?: unknown;
        };

        return (
            typeof candidate.id === 'string'
            && typeof candidate.from === 'object'
            && candidate.from !== null
            && typeof candidate.to === 'object'
            && candidate.to !== null
        );
    }

    private hasUpdatePath(edge: CanvasRuntimeEdge): edge is CanvasRuntimeEdge & { updatePath: (...args: unknown[]) => unknown } {
        return typeof edge.updatePath === 'function';
    }

    private isSide(side: unknown): side is CanvasSide {
        return side === 'top' || side === 'right' || side === 'bottom' || side === 'left';
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    private hasSetAttr(value: unknown): value is { setAttr: (key: string, val: string) => void } {
        return typeof value === 'object' && value !== null && typeof (value as { setAttr?: unknown }).setAttr === 'function';
    }

    private hasSetAttribute(value: unknown): value is { setAttribute: (key: string, val: string) => void } {
        return typeof value === 'object' && value !== null && typeof (value as { setAttribute?: unknown }).setAttribute === 'function';
    }
}
