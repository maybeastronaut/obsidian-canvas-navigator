import type { CanvasRuntimePosition, CanvasSide } from './canvasTypes';

export interface BBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

interface PartialPath {
    pathArray: CanvasRuntimePosition[];
    center: CanvasRuntimePosition;
}

export interface SquarePathInput {
    fromNodeBBox: BBox;
    fromPos: CanvasRuntimePosition;
    fromBBoxSidePos: CanvasRuntimePosition;
    fromSide: CanvasSide;
    toNodeBBox: BBox;
    toPos: CanvasRuntimePosition;
    toBBoxSidePos: CanvasRuntimePosition;
    toSide: CanvasSide;
    rounded: boolean;
}

export interface SquarePathResult {
    svgPath: string;
    center: CanvasRuntimePosition;
}

const GRID_SIZE = 20;
const ROUNDED_EDGE_RADIUS = 5;

export function buildSquarePath(input: SquarePathInput): SquarePathResult | null {
    const {
        fromNodeBBox,
        fromPos,
        fromBBoxSidePos,
        fromSide,
        toNodeBBox,
        toPos,
        toBBoxSidePos,
        toSide,
        rounded,
    } = input;

    const pathArray: CanvasRuntimePosition[] = [];
    let center: CanvasRuntimePosition = {
        x: (fromPos.x + toPos.x) / 2,
        y: (fromPos.y + toPos.y) / 2,
    };

    const idealCenter = isHorizontal(fromSide)
        ? { x: toBBoxSidePos.x, y: fromBBoxSidePos.y }
        : { x: fromBBoxSidePos.x, y: toBBoxSidePos.y };

    const isPathCollidingAtFrom = (
        (fromSide === 'top' && idealCenter.y > fromPos.y)
        || (fromSide === 'bottom' && idealCenter.y < fromPos.y)
        || (fromSide === 'left' && idealCenter.x > fromPos.x)
        || (fromSide === 'right' && idealCenter.x < fromPos.x)
    );

    const isPathCollidingAtTo = (
        (toSide === 'top' && idealCenter.y > toPos.y)
        || (toSide === 'bottom' && idealCenter.y < toPos.y)
        || (toSide === 'left' && idealCenter.x > toPos.x)
        || (toSide === 'right' && idealCenter.x < toPos.x)
    );

    if (fromSide === toSide) {
        const uPath = getUPath(fromPos, toPos, fromSide);
        pathArray.push(...uPath.pathArray);
        center = uPath.center;
    } else if (isHorizontal(fromSide) === isHorizontal(toSide)) {
        let zPath: PartialPath;
        if (!isPathCollidingAtFrom || !isPathCollidingAtTo) {
            zPath = getZPath(fromPos, toPos, fromSide);
            pathArray.push(...zPath.pathArray);
        } else {
            const fromDirection = direction(fromSide);
            const firstFromDetourPoint = isHorizontal(fromSide)
                ? {
                    x: alignToGrid(fromBBoxSidePos.x + fromDirection * GRID_SIZE),
                    y: fromBBoxSidePos.y,
                }
                : {
                    x: fromBBoxSidePos.x,
                    y: alignToGrid(fromBBoxSidePos.y + fromDirection * GRID_SIZE),
                };

            const toDirection = direction(toSide);
            const firstToDetourPoint = isHorizontal(toSide)
                ? {
                    x: alignToGrid(toBBoxSidePos.x + toDirection * GRID_SIZE),
                    y: toBBoxSidePos.y,
                }
                : {
                    x: toBBoxSidePos.x,
                    y: alignToGrid(toBBoxSidePos.y + toDirection * GRID_SIZE),
                };

            const newFromSide: CanvasSide = isHorizontal(fromSide)
                ? (firstFromDetourPoint.y < fromPos.y ? 'top' : 'bottom')
                : (firstFromDetourPoint.x < firstToDetourPoint.x ? 'right' : 'left');

            zPath = getZPath(firstFromDetourPoint, firstToDetourPoint, newFromSide);

            pathArray.push(fromPos);
            pathArray.push(...zPath.pathArray);
            pathArray.push(toPos);
        }

        center = zPath.center;
    } else {
        if (isPathCollidingAtFrom || isPathCollidingAtTo) {
            if (isPathCollidingAtFrom && isPathCollidingAtTo) {
                const fromDirection = direction(fromSide);

                let firstFromDetourPoint: CanvasRuntimePosition;
                let secondFromDetourPoint: CanvasRuntimePosition;

                if (isHorizontal(fromSide)) {
                    const combinedBBoxes = combineBBoxes([fromNodeBBox, toNodeBBox]);

                    firstFromDetourPoint = {
                        x: alignToGrid((fromDirection > 0 ? combinedBBoxes.maxX : combinedBBoxes.minX) + fromDirection * GRID_SIZE),
                        y: fromBBoxSidePos.y,
                    };

                    secondFromDetourPoint = {
                        x: firstFromDetourPoint.x,
                        y: getCenterOfBBoxSide(fromNodeBBox, toSide).y,
                    };
                } else {
                    const combinedBBoxes = combineBBoxes([fromNodeBBox, toNodeBBox]);

                    firstFromDetourPoint = {
                        x: fromBBoxSidePos.x,
                        y: alignToGrid((fromDirection > 0 ? combinedBBoxes.maxY : combinedBBoxes.minY) + fromDirection * GRID_SIZE),
                    };

                    secondFromDetourPoint = {
                        x: getCenterOfBBoxSide(fromNodeBBox, toSide).x,
                        y: firstFromDetourPoint.y,
                    };
                }

                const uPath = getUPath(secondFromDetourPoint, toPos, toSide);

                pathArray.push(fromPos);
                pathArray.push(firstFromDetourPoint);
                pathArray.push(...uPath.pathArray);
                center = pathArray[Math.floor(pathArray.length / 2)] ?? center;
            } else if (isPathCollidingAtFrom) {
                const fromDirection = direction(fromSide);

                const firstFromDetourPoint = isHorizontal(fromSide)
                    ? {
                        x: alignToGrid(fromBBoxSidePos.x + fromDirection * GRID_SIZE),
                        y: fromBBoxSidePos.y,
                    }
                    : {
                        x: fromBBoxSidePos.x,
                        y: alignToGrid(fromBBoxSidePos.y + fromDirection * GRID_SIZE),
                    };

                const useUPath = isHorizontal(fromSide)
                    ? ((toPos.y > getCenterOfBBoxSide(fromNodeBBox, getOppositeSide(toSide)).y) === (direction(toSide) > 0))
                    : ((toPos.x > getCenterOfBBoxSide(fromNodeBBox, getOppositeSide(toSide)).x) === (direction(toSide) > 0));

                const connectionSide = useUPath ? toSide : getOppositeSide(toSide);
                const secondFromDetourPoint = isHorizontal(fromSide)
                    ? {
                        x: firstFromDetourPoint.x,
                        y: getCenterOfBBoxSide(fromNodeBBox, connectionSide).y,
                    }
                    : {
                        x: getCenterOfBBoxSide(fromNodeBBox, connectionSide).x,
                        y: firstFromDetourPoint.y,
                    };

                const path = useUPath
                    ? getUPath(secondFromDetourPoint, toPos, toSide)
                    : getZPath(secondFromDetourPoint, toPos, toSide);

                pathArray.push(fromPos);
                pathArray.push(firstFromDetourPoint);
                pathArray.push(...path.pathArray);
                center = path.center;
            } else if (isPathCollidingAtTo) {
                const toDirection = direction(toSide);

                const firstToDetourPoint = isHorizontal(toSide)
                    ? {
                        x: alignToGrid(toBBoxSidePos.x + toDirection * GRID_SIZE),
                        y: toBBoxSidePos.y,
                    }
                    : {
                        x: toBBoxSidePos.x,
                        y: alignToGrid(toBBoxSidePos.y + toDirection * GRID_SIZE),
                    };

                const useUPath = isHorizontal(toSide)
                    ? ((fromPos.y > getCenterOfBBoxSide(toNodeBBox, getOppositeSide(fromSide)).y) === (direction(fromSide) > 0))
                    : ((fromPos.x > getCenterOfBBoxSide(toNodeBBox, getOppositeSide(fromSide)).x) === (direction(fromSide) > 0));

                const connectionSide = useUPath ? fromSide : getOppositeSide(fromSide);
                const secondToDetourPoint = isHorizontal(toSide)
                    ? {
                        x: firstToDetourPoint.x,
                        y: getCenterOfBBoxSide(toNodeBBox, connectionSide).y,
                    }
                    : {
                        x: getCenterOfBBoxSide(toNodeBBox, connectionSide).x,
                        y: firstToDetourPoint.y,
                    };

                const path = useUPath
                    ? getUPath(fromPos, secondToDetourPoint, fromSide)
                    : getZPath(fromPos, secondToDetourPoint, fromSide);

                pathArray.push(...path.pathArray);
                pathArray.push(secondToDetourPoint);
                pathArray.push(firstToDetourPoint);
                pathArray.push(toPos);

                center = path.center;
            }
        } else {
            pathArray.push(fromPos);
            pathArray.push(idealCenter);
            pathArray.push(toPos);

            center = {
                x: pathArray[1]?.x ?? center.x,
                y: pathArray[1]?.y ?? center.y,
            };
        }
    }

    if (pathArray.length < 2) return null;

    const points = pathArray.map(point => ({ x: round(point.x), y: round(point.y) }));
    const svgPath = rounded
        ? pathArrayToRoundedSvgPath(points, ROUNDED_EDGE_RADIUS)
        : pathArrayToSvgPath(points);

    return { svgPath, center };
}

function getUPath(
    fromPos: CanvasRuntimePosition,
    toPos: CanvasRuntimePosition,
    fromSide: CanvasSide,
): PartialPath {
    const sideDirection = direction(fromSide);

    if (isHorizontal(fromSide)) {
        const xExtremum = sideDirection > 0 ? Math.max(fromPos.x, toPos.x) : Math.min(fromPos.x, toPos.x);
        const x = alignToGrid(xExtremum + sideDirection * GRID_SIZE);
        return {
            pathArray: [
                fromPos,
                { x, y: fromPos.y },
                { x, y: toPos.y },
                toPos,
            ],
            center: { x, y: (fromPos.y + toPos.y) / 2 },
        };
    }

    const yExtremum = sideDirection > 0 ? Math.max(fromPos.y, toPos.y) : Math.min(fromPos.y, toPos.y);
    const y = alignToGrid(yExtremum + sideDirection * GRID_SIZE);

    return {
        pathArray: [
            fromPos,
            { x: fromPos.x, y },
            { x: toPos.x, y },
            toPos,
        ],
        center: { x: (fromPos.x + toPos.x) / 2, y },
    };
}

function getZPath(
    fromPos: CanvasRuntimePosition,
    toPos: CanvasRuntimePosition,
    fromSide: CanvasSide,
): PartialPath {
    if (isHorizontal(fromSide)) {
        const midX = fromPos.x + (toPos.x - fromPos.x) / 2;
        return {
            pathArray: [
                fromPos,
                { x: midX, y: fromPos.y },
                { x: midX, y: toPos.y },
                toPos,
            ],
            center: { x: midX, y: (fromPos.y + toPos.y) / 2 },
        };
    }

    const midY = fromPos.y + (toPos.y - fromPos.y) / 2;
    return {
        pathArray: [
            fromPos,
            { x: fromPos.x, y: midY },
            { x: toPos.x, y: midY },
            toPos,
        ],
        center: { x: (fromPos.x + toPos.x) / 2, y: midY },
    };
}

function combineBBoxes(bboxes: BBox[]): BBox {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const bbox of bboxes) {
        minX = Math.min(minX, bbox.minX);
        minY = Math.min(minY, bbox.minY);
        maxX = Math.max(maxX, bbox.maxX);
        maxY = Math.max(maxY, bbox.maxY);
    }

    return { minX, minY, maxX, maxY };
}

function getCenterOfBBoxSide(bbox: BBox, side: CanvasSide): CanvasRuntimePosition {
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

function getOppositeSide(side: CanvasSide): CanvasSide {
    switch (side) {
        case 'top':
            return 'bottom';
        case 'right':
            return 'left';
        case 'bottom':
            return 'top';
        case 'left':
            return 'right';
    }
}

function isHorizontal(side: CanvasSide): boolean {
    return side === 'left' || side === 'right';
}

function direction(side: CanvasSide): number {
    return side === 'right' || side === 'bottom' ? 1 : -1;
}

function alignToGrid(value: number): number {
    return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

function pathArrayToSvgPath(positions: CanvasRuntimePosition[]): string {
    const points = [...positions];

    for (let i = 0; i < points.length - 2; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2];
        if (!p1 || !p2 || !p3) continue;

        const currentDirection = {
            x: p2.x - p1.x,
            y: p2.y - p1.y,
        };

        const nextDirection = {
            x: p3.x - p2.x,
            y: p3.y - p2.y,
        };

        if (currentDirection.x !== nextDirection.x && currentDirection.y !== nextDirection.y) continue;

        points.splice(i + 1, 1);
        i--;
    }

    return points.map((position, index) => `${index === 0 ? 'M' : 'L'} ${position.x} ${position.y}`).join(' ');
}

function pathArrayToRoundedSvgPath(pathArray: CanvasRuntimePosition[], targetRadius: number): string {
    if (pathArray.length < 3) {
        return pathArrayToSvgPath(pathArray);
    }

    const filteredPath = pathArray.filter((position, index) => {
        if (index === 0) return true;
        const previous = pathArray[index - 1];
        if (!previous) return true;
        return !(position.x === previous.x && position.y === previous.y);
    });

    const commands: string[] = [];
    const first = filteredPath[0];
    if (!first) return '';

    commands.push(`M ${first.x} ${first.y}`);

    for (let i = 1; i < filteredPath.length - 1; i++) {
        const previous = filteredPath[i - 1];
        const current = filteredPath[i];
        const next = filteredPath[i + 1];
        if (!previous || !current || !next) continue;

        const prevDelta = { x: current.x - previous.x, y: current.y - previous.y };
        const nextDelta = { x: next.x - current.x, y: next.y - current.y };

        const prevLen = Math.sqrt(prevDelta.x * prevDelta.x + prevDelta.y * prevDelta.y);
        const nextLen = Math.sqrt(nextDelta.x * nextDelta.x + nextDelta.y * nextDelta.y);

        const prevUnit = prevLen ? { x: prevDelta.x / prevLen, y: prevDelta.y / prevLen } : { x: 0, y: 0 };
        const nextUnit = nextLen ? { x: nextDelta.x / nextLen, y: nextDelta.y / nextLen } : { x: 0, y: 0 };

        let dot = prevUnit.x * nextUnit.x + prevUnit.y * nextUnit.y;
        dot = Math.max(-1, Math.min(1, dot));
        const angle = Math.acos(dot);

        if (angle < 0.01 || Math.abs(Math.PI - angle) < 0.01) {
            commands.push(`L ${current.x} ${current.y}`);
            continue;
        }

        const desiredOffset = targetRadius * Math.tan(angle / 2);
        const d = Math.min(desiredOffset, prevLen / 2, nextLen / 2);
        const effectiveRadius = d / Math.tan(angle / 2);

        const firstAnchor = {
            x: current.x - prevUnit.x * d,
            y: current.y - prevUnit.y * d,
        };

        const secondAnchor = {
            x: current.x + nextUnit.x * d,
            y: current.y + nextUnit.y * d,
        };

        commands.push(`L ${firstAnchor.x} ${firstAnchor.y}`);

        const cross = prevDelta.x * nextDelta.y - prevDelta.y * nextDelta.x;
        const sweepFlag = cross < 0 ? 0 : 1;

        commands.push(`A ${effectiveRadius} ${effectiveRadius} 0 0 ${sweepFlag} ${secondAnchor.x} ${secondAnchor.y}`);
    }

    const last = filteredPath[filteredPath.length - 1];
    if (last) {
        commands.push(`L ${last.x} ${last.y}`);
    }

    return commands.join(' ');
}
