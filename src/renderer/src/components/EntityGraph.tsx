import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import * as THREE from 'three';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@renderer/lib/utils';
import { BorderBeam } from './ui/border-beam';
import { SourceFilterTabs, Source } from './SourceFilterTabs';
import { IconSearch, IconX, IconPlus, IconMinus, IconFocus2 } from '@tabler/icons-react';

interface GraphNode {
    id: number;
    name: string;
    type: string;
    summary?: string | null;
    updated_at: string;
    fact_count: number;
    session_count: number;
    facts?: string[];
}

interface GraphEdge {
    source: number;
    target: number;
    type: string;
    weight: number;
    evidence_count: number;
    updated_at: string;
}

interface GraphResponse {
    nodes: GraphNode[];
    edges: GraphEdge[];
}

interface EntityGraphProps {
    // No props needed - source filter is managed internally
}

// Color palette for different entity types - muted, desaturated tones
// These are the only place where color appears per the design system
const typeColors: Record<string, string> = {
    'Person': '#c9a0b8',      // Muted pink
    'Organization': '#8aa8c9', // Muted blue
    'Technology': '#7ab8a0',   // Muted green
    'Concept': '#a89cc9',      // Muted purple
    'Location': '#c9b87a',     // Muted yellow
    'Event': '#c9957a',        // Muted orange
    'Product': '#7ab8b8',      // Muted cyan
    'Unknown': '#7a7a7a',      // Muted gray
};

const normalizeType = (type?: string): string => {
    if (!type) return 'Unknown';
    const t = type.trim().toLowerCase();

    // Direct match against known types (case-insensitive)
    const directMatch = Object.keys(typeColors).find(k => k.toLowerCase() === t);
    if (directMatch) return directMatch;

    // Map common aliases to our defined types
    const typeMap: Record<string, string> = {
        'library': 'Technology',
        'framework': 'Technology',
        'tool': 'Technology',
        'software': 'Technology',
        'api': 'Technology',
        'sdk': 'Technology',
        'platform': 'Technology',
        'service': 'Technology',
        'programming language': 'Technology',
        'language': 'Technology',
        'database': 'Technology',
        'company': 'Organization',
        'corp': 'Organization',
        'corporation': 'Organization',
        'startup': 'Organization',
        'org': 'Organization',
        'team': 'Organization',
        'group': 'Organization',
        'human': 'Person',
        'user': 'Person',
        'individual': 'Person',
        'people': 'Person',
        'place': 'Location',
        'city': 'Location',
        'country': 'Location',
        'region': 'Location',
        'address': 'Location',
        'idea': 'Concept',
        'theory': 'Concept',
        'principle': 'Concept',
        'methodology': 'Concept',
        'topic': 'Concept',
        'subject': 'Concept',
        'meeting': 'Event',
        'conference': 'Event',
        'launch': 'Event',
        'release': 'Event',
        'app': 'Product',
        'application': 'Product',
        'website': 'Product',
        'design system': 'Product',
        'ui library': 'Product',
        'project': 'Product',
    };

    // Check for exact match in our map
    if (typeMap[t]) return typeMap[t];

    // Check if type contains any known type keyword
    for (const [alias, mapped] of Object.entries(typeMap)) {
        if (t.includes(alias)) return mapped;
    }

    // Default to Unknown
    return 'Unknown';
};

const getTypeColor = (type: string): string => {
    const normalized = normalizeType(type);
    return typeColors[normalized] || typeColors['Unknown'];
};

export function EntityGraph({ }: EntityGraphProps) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const graphRef = useRef<any>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [graph, setGraph] = useState<GraphResponse>({ nodes: [], edges: [] });
    const [loading, setLoading] = useState(false);
    const [focusEntityId, setFocusEntityId] = useState<number | undefined>();
    const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<number | null>(null);
    const [dimensions, setDimensions] = useState({ width: 600, height: 500 });
    const [activeSource, setActiveSource] = useState<Source>('All');
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<GraphNode[]>([]);
    const [showSearchResults, setShowSearchResults] = useState(false);

    const nodesById = useMemo(() => {
        const map = new Map<number, GraphNode>();
        graph.nodes.forEach(n => map.set(n.id, n));
        return map;
    }, [graph.nodes]);

    // Transform data for force-graph
    const graphData = useMemo(() => ({
        nodes: graph.nodes.map(n => ({ ...n })),
        links: graph.edges.map(e => ({
            source: e.source,
            target: e.target,
            weight: e.weight,
            type: e.type,
        })),
    }), [graph]);

    const fetchGraph = async () => {
        setLoading(true);
        try {
            const data = await window.api.getEntityGraph(activeSource, focusEntityId, 200);
            setGraph(data as GraphResponse);
        } catch (e) {
            console.error('Failed to fetch entity graph', e);
        } finally {
            setLoading(false);
        }
    };

    const rebuildGraph = async () => {
        setLoading(true);
        try {
            await window.api.rebuildEntityGraph();
            await fetchGraph();
        } catch (e) {
            console.error('Failed to rebuild entity graph', e);
        } finally {
            setLoading(false);
        }
    };

    // Handle container resize
    useEffect(() => {
        const updateDimensions = () => {
            if (containerRef.current) {
                const rect = containerRef.current.getBoundingClientRect();
                setDimensions({ width: rect.width, height: Math.max(420, rect.height) });
            }
        };

        updateDimensions();
        window.addEventListener('resize', updateDimensions);
        const resizeObserver = new ResizeObserver(updateDimensions);
        if (containerRef.current) {
            resizeObserver.observe(containerRef.current);
        }

        return () => {
            window.removeEventListener('resize', updateDimensions);
            resizeObserver.disconnect();
        };
    }, []);

    useEffect(() => {
        fetchGraph();
    }, [activeSource, focusEntityId]);

    // Configure d3 forces once on mount
    const forcesConfigured = useRef(false);
    useEffect(() => {
        if (graphRef.current && graph.nodes.length > 0 && !forcesConfigured.current) {
            const fg = graphRef.current;

            // Configure charge force (node repulsion)
            fg.d3Force('charge')?.strength(-300);
            fg.d3Force('charge')?.distanceMax(500);

            // Configure link force
            fg.d3Force('link')?.distance(100);

            // Weaker centering force
            fg.d3Force('center')?.strength(0.05);

            forcesConfigured.current = true;
        }
    }, [graph.nodes.length]);

    // Reset forces flag when graph is cleared
    useEffect(() => {
        if (graph.nodes.length === 0) {
            forcesConfigured.current = false;
        }
    }, [graph.nodes.length]);

    // Select node on click - no camera movement to avoid fighting with user controls
    const handleNodeClick = useCallback((node: GraphNode & { x?: number; y?: number; z?: number }) => {
        setSelectedNodeId(node.id);
    }, []);

    const handleNodeDoubleClick = useCallback((node: GraphNode) => {
        setFocusEntityId(node.id);
    }, []);

    const handleNodeHover = useCallback((node: GraphNode | null) => {
        setHoveredNodeId(node ? node.id : null);
        if (containerRef.current) {
            containerRef.current.style.cursor = node ? 'pointer' : 'grab';
        }
    }, []);

    // Search functionality
    const handleSearch = useCallback((query: string) => {
        setSearchQuery(query);
        if (query.trim().length < 2) {
            setSearchResults([]);
            setShowSearchResults(false);
            return;
        }
        const q = query.toLowerCase();
        const matches = graph.nodes.filter(n =>
            n.name.toLowerCase().includes(q) ||
            (n.type && n.type.toLowerCase().includes(q))
        ).slice(0, 8);
        setSearchResults(matches);
        setShowSearchResults(matches.length > 0);
    }, [graph.nodes]);

    // Zoom to a specific node with pan/zoom animation
    const zoomToNode = useCallback((node: GraphNode, e?: React.MouseEvent) => {
        if (e) {
            e.stopPropagation();
            e.preventDefault();
        }

        setSearchQuery('');
        setShowSearchResults(false);
        setSelectedNodeId(node.id);

        const fg = graphRef.current;
        if (!fg) return;

        // Find node in graphData - ForceGraph mutates these with x, y, z coordinates
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const targetNode = graphData.nodes.find((n: any) => n.id === node.id) as any;

        console.log('[ZoomToNode] targetNode:', targetNode?.name, 'coords:', targetNode?.x, targetNode?.y, targetNode?.z);

        if (targetNode && targetNode.x !== undefined) {
            const x = targetNode.x;
            const y = targetNode.y;
            const z = targetNode.z;

            // Animate camera to node position
            const distance = 350;
            fg.cameraPosition(
                { x, y, z: z + distance },
                { x, y, z },
                1500
            );
            console.log('[ZoomToNode] Camera animating to node');
        } else {
            // Fallback: focus on entity neighborhood
            setFocusEntityId(node.id);
        }
    }, [graphData.nodes]);

    // Zoom controls using wheel events (these work with trackball controls)
    const handleZoomIn = useCallback(() => {
        const fg = graphRef.current;
        if (!fg) return;

        const renderer = fg.renderer?.();
        const canvas = renderer?.domElement;
        if (canvas) {
            const wheelEvent = new WheelEvent('wheel', {
                deltaY: -200,
                bubbles: true,
                cancelable: true,
            });
            canvas.dispatchEvent(wheelEvent);
        }
    }, []);

    const handleZoomOut = useCallback(() => {
        const fg = graphRef.current;
        if (!fg) return;

        const renderer = fg.renderer?.();
        const canvas = renderer?.domElement;
        if (canvas) {
            const wheelEvent = new WheelEvent('wheel', {
                deltaY: 200,
                bubbles: true,
                cancelable: true,
            });
            canvas.dispatchEvent(wheelEvent);
        }
    }, []);

    const handleResetView = useCallback(() => {
        const fg = graphRef.current;
        if (!fg) return;

        // Reset to fit all nodes
        fg.zoomToFit?.(500, 50);
    }, []);

    const clearSearch = useCallback(() => {
        setSearchQuery('');
        setSearchResults([]);
        setShowSearchResults(false);
    }, []);

    // Close search dropdown on outside click
    useEffect(() => {
        if (!showSearchResults) return;
        const handleClickOutside = () => {
            setShowSearchResults(false);
        };
        document.addEventListener('click', handleClickOutside);
        return () => document.removeEventListener('click', handleClickOutside);
    }, [showSearchResults]);

    // Custom node object with sphere + label sprite
    const nodeThreeObject = useCallback((node: GraphNode & { x?: number; y?: number; z?: number }) => {
        const isSelected = node.id === selectedNodeId;
        const isHovered = node.id === hoveredNodeId;
        const color = getTypeColor(node.type || 'Unknown');
        const threeColor = new THREE.Color(color);

        // Size based on fact count
        const baseSize = Math.max(6, Math.min(16, 6 + Math.log2(node.fact_count + 1) * 3));
        const size = isSelected ? baseSize * 1.4 : isHovered ? baseSize * 1.2 : baseSize;

        const group = new THREE.Group();

        // Outer glow (larger, semi-transparent sphere)
        const glowGeometry = new THREE.SphereGeometry(size * (isSelected ? 2.2 : 1.6), 32, 32);
        const glowMaterial = new THREE.MeshBasicMaterial({
            color: threeColor,
            transparent: true,
            opacity: isSelected ? 0.35 : isHovered ? 0.25 : 0.15,
        });
        const glow = new THREE.Mesh(glowGeometry, glowMaterial);
        group.add(glow);

        // Main sphere with stronger color
        const geometry = new THREE.SphereGeometry(size, 32, 32);
        const material = new THREE.MeshBasicMaterial({
            color: threeColor,
            transparent: true,
            opacity: isSelected ? 1 : 0.95,
        });
        const sphere = new THREE.Mesh(geometry, material);
        group.add(sphere);

        // Inner bright core - slightly tinted with the node color
        const coreGeometry = new THREE.SphereGeometry(size * 0.35, 16, 16);
        const coreColor = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.7);
        const coreMaterial = new THREE.MeshBasicMaterial({
            color: coreColor,
            transparent: true,
            opacity: 0.8,
        });
        const core = new THREE.Mesh(coreGeometry, coreMaterial);
        group.add(core);

        // Text sprite for label
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (context) {
            const fontSize = 48;
            const text = node.name.length > 20 ? node.name.substring(0, 18) + '...' : node.name;

            canvas.width = 512;
            canvas.height = 128;

            context.fillStyle = 'transparent';
            context.fillRect(0, 0, canvas.width, canvas.height);

            context.font = `bold ${fontSize}px Inter, system-ui, sans-serif`;
            context.textAlign = 'center';
            context.textBaseline = 'middle';

            // Text shadow
            context.fillStyle = 'rgba(0,0,0,0.8)';
            context.fillText(text, canvas.width / 2 + 2, canvas.height / 2 + 2);

            // Main text
            context.fillStyle = isSelected ? '#ffffff' : 'rgba(255,255,255,0.9)';
            context.fillText(text, canvas.width / 2, canvas.height / 2);

            const texture = new THREE.CanvasTexture(canvas);
            texture.needsUpdate = true;

            const spriteMaterial = new THREE.SpriteMaterial({
                map: texture,
                transparent: true,
                depthWrite: false,
            });

            const sprite = new THREE.Sprite(spriteMaterial);
            sprite.scale.set(60, 15, 1);
            sprite.position.y = size + 12;
            group.add(sprite);
        }

        return group;
    }, [selectedNodeId, hoveredNodeId]);

    const selectedNode = selectedNodeId ? nodesById.get(selectedNodeId) : null;

    return (
        <div className="flex gap-4 h-full overflow-hidden">
            {/* Graph Area - Fixed width to prevent drift */}
            <div className="flex-1 flex flex-col gap-3 min-w-0">
                {/* Header */}
                <div className="flex items-center gap-3 flex-shrink-0">
                    <h2 className="text-lg font-semibold text-white">Entity Graph</h2>

                    {/* Search */}
                    <div className="relative" onClick={(e) => e.stopPropagation()}>
                        <div className="relative">
                            <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => handleSearch(e.target.value)}
                                onFocus={() => searchResults.length > 0 && setShowSearchResults(true)}
                                placeholder="Search entities..."
                                className="pl-9 pr-8 py-1.5 w-48 rounded-lg bg-neutral-800 border border-neutral-700 text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-neutral-600 transition-colors"
                            />
                            {searchQuery && (
                                <button
                                    onClick={clearSearch}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300"
                                >
                                    <IconX className="w-4 h-4" />
                                </button>
                            )}
                        </div>

                        {/* Search Results Dropdown */}
                        <AnimatePresence>
                            {showSearchResults && searchResults.length > 0 && (
                                <motion.div
                                    initial={{ opacity: 0, y: -4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -4 }}
                                    className="absolute top-full left-0 mt-1 w-64 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl z-20 overflow-hidden"
                                >
                                    {searchResults.map((node, idx) => (
                                        <button
                                            key={node.id}
                                            onClick={(e) => zoomToNode(node, e)}
                                            className={cn(
                                                "w-full px-3 py-2 text-left hover:bg-neutral-800 transition-colors flex items-center gap-3",
                                                idx !== searchResults.length - 1 && "border-b border-neutral-800"
                                            )}
                                        >
                                            <span
                                                className="w-2.5 h-2.5 rounded-full shrink-0"
                                                style={{ backgroundColor: getTypeColor(node.type) }}
                                            />
                                            <div className="min-w-0 flex-1">
                                                <p className="text-sm text-white truncate">{node.name}</p>
                                                <p className="text-[10px] text-neutral-500">{node.type || 'Unknown'}</p>
                                            </div>
                                        </button>
                                    ))}
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>

                    {focusEntityId && (
                        <button
                            onClick={() => setFocusEntityId(undefined)}
                            className="px-3 py-1.5 rounded-lg bg-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors text-sm"
                        >
                            Clear focus
                        </button>
                    )}
                    <button
                        onClick={rebuildGraph}
                        className="px-3 py-1.5 rounded-lg bg-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors text-sm"
                    >
                        Rebuild
                    </button>
                    <div className="ml-auto text-sm text-neutral-500">
                        {loading ? (
                            <span className="flex items-center gap-2">
                                <span className="w-4 h-4 border-2 border-neutral-500 border-t-transparent rounded-full animate-spin" />
                                Loading...
                            </span>
                        ) : (
                            `${graph.nodes.length} nodes • ${graph.edges.length} edges`
                        )}
                    </div>
                </div>

                {/* 3D Graph Container */}
                <div
                    ref={containerRef}
                    className="flex-1 min-h-[420px] rounded-xl border border-neutral-800 bg-neutral-950 overflow-hidden relative"
                >
                    {dimensions.width > 0 && (
                        <ForceGraph3D
                            ref={graphRef}
                            width={dimensions.width}
                            height={dimensions.height}
                            graphData={graphData}
                            nodeId="id"
                            nodeThreeObject={nodeThreeObject}
                            nodeThreeObjectExtend={false}
                            onNodeClick={handleNodeClick}
                            onNodeRightClick={handleNodeDoubleClick}
                            onNodeHover={handleNodeHover}
                            linkColor={() => 'rgba(115, 115, 115, 0.5)'}
                            linkWidth={(link: { weight: number }) => Math.max(1, Math.min(4, link.weight * 0.5))}
                            linkOpacity={0.5}
                            linkCurvature={0.15}
                            linkDirectionalParticles={2}
                            linkDirectionalParticleWidth={1.5}
                            linkDirectionalParticleSpeed={0.004}
                            linkDirectionalParticleColor={() => '#a3a3a3'}
                            backgroundColor="#0a0a0a"
                            showNavInfo={false}
                            enableNodeDrag={true}
                            enableNavigationControls={true}
                            controlType="orbit"
                            cooldownTime={2000}
                            d3AlphaDecay={0.02}
                            d3VelocityDecay={0.3}
                            warmupTicks={50}
                        />
                    )}

                    {/* Loading overlay */}
                    <AnimatePresence>
                        {loading && (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="absolute inset-0 flex items-center justify-center bg-neutral-950/80 backdrop-blur-sm z-10"
                            >
                                <div className="relative">
                                    <div className="w-16 h-16 border-2 border-neutral-700 rounded-full" />
                                    <div className="absolute top-0 left-0 w-16 h-16 border-2 border-neutral-500 border-t-transparent rounded-full animate-spin" />
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    {/* Zoom Controls */}
                    <div className="absolute bottom-4 right-4 flex flex-col gap-1 z-10">
                        <button
                            onClick={handleZoomIn}
                            className="p-2 rounded-lg bg-neutral-800/90 hover:bg-neutral-700 text-neutral-300 hover:text-white transition-colors backdrop-blur-sm"
                            title="Zoom in"
                        >
                            <IconPlus className="w-4 h-4" />
                        </button>
                        <button
                            onClick={handleZoomOut}
                            className="p-2 rounded-lg bg-neutral-800/90 hover:bg-neutral-700 text-neutral-300 hover:text-white transition-colors backdrop-blur-sm"
                            title="Zoom out"
                        >
                            <IconMinus className="w-4 h-4" />
                        </button>
                        <button
                            onClick={handleResetView}
                            className="p-2 rounded-lg bg-neutral-800/90 hover:bg-neutral-700 text-neutral-300 hover:text-white transition-colors backdrop-blur-sm"
                            title="Reset view"
                        >
                            <IconFocus2 className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                {/* Help Text */}
                <div className="text-xs text-neutral-500 flex-shrink-0">
                    Search to find and zoom to entities. Click a node to view details. Right-click to filter neighborhood. Drag to orbit, scroll to zoom.
                </div>
            </div>

            {/* Details Panel - Fixed width */}
            <div className="w-72 flex-shrink-0 h-full overflow-y-auto flex flex-col gap-4 pr-1">
                <div className="relative rounded-xl border border-neutral-800 bg-neutral-900/80 backdrop-blur-xl p-6 overflow-hidden flex-shrink-0">
                    {selectedNode && (
                        <BorderBeam
                            size={180}
                            duration={5}
                            borderWidth={1.5}
                            className="from-neutral-500/50 via-neutral-400/50 to-neutral-500/50"
                        />
                    )}

                    <AnimatePresence mode="wait">
                        {selectedNode ? (
                            <motion.div
                                key={selectedNode.id}
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                transition={{ duration: 0.2 }}
                                className="relative z-10 space-y-4"
                            >
                                <h3 className="font-bold text-lg text-white">
                                    {selectedNode.name}
                                </h3>

                                <span
                                    className="inline-block px-3 py-1 rounded-full text-xs font-medium border"
                                    style={{
                                        backgroundColor: `${getTypeColor(selectedNode.type || 'Unknown')}20`,
                                        borderColor: `${getTypeColor(selectedNode.type || 'Unknown')}50`,
                                        color: getTypeColor(selectedNode.type || 'Unknown'),
                                    }}
                                >
                                    {selectedNode.type || 'Unknown'}
                                </span>

                                <div className="flex gap-4 text-xs" >
                                    <div className="flex items-center gap-1.5">
                                        <span className="w-1.5 h-1.5 rounded-full bg-neutral-500" />
                                        <span className="text-neutral-400">{selectedNode.fact_count} facts</span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <span className="w-1.5 h-1.5 rounded-full bg-neutral-500" />
                                        <span className="text-neutral-400">{selectedNode.session_count} sessions</span>
                                    </div>
                                </div>

                                {selectedNode.summary ? (
                                    <div className="p-4 rounded-lg bg-neutral-800/50 border border-neutral-700/50">
                                        <p className="text-sm text-neutral-300 leading-relaxed whitespace-pre-wrap">
                                            {selectedNode.summary}
                                        </p>
                                    </div>
                                ) : (
                                    <div className="p-4 rounded-lg bg-neutral-800/30 border border-neutral-700/30 border-dashed">
                                        <p className="text-sm text-neutral-500 italic">No summary available.</p>
                                    </div>
                                )}

                                {selectedNode.facts && selectedNode.facts.length > 0 && (
                                    <div>
                                        <h4 className="text-xs font-medium text-neutral-400 mb-3 uppercase tracking-wide">
                                            Recent Facts
                                        </h4>
                                        <ul className="space-y-3">
                                            {selectedNode.facts.slice(0, 5).map((fact, idx) => (
                                                <motion.li
                                                    key={`fact-${idx}`}
                                                    initial={{ opacity: 0, x: -5 }}
                                                    animate={{ opacity: 1, x: 0 }}
                                                    transition={{ delay: idx * 0.05 }}
                                                    className="flex items-start gap-2 text-xs text-neutral-400"
                                                >
                                                    <span className="text-neutral-500 mt-0.5 min-w-[3px]">•</span>
                                                    <span className="leading-relaxed">{fact}</span>
                                                </motion.li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </motion.div>
                        ) : (
                            <motion.div
                                key="empty"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="text-center py-8"
                            >
                                <div className={cn(
                                    "w-14 h-14 rounded-2xl mx-auto mb-4",
                                    "bg-neutral-800/60",
                                    "border border-neutral-700",
                                    "flex items-center justify-center"
                                )}>
                                    <svg className="w-7 h-7 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                                    </svg>
                                </div>
                                <p className="text-neutral-400 text-sm font-medium mb-1">Select a node to view details</p>
                                <p className="text-neutral-600 text-xs">Click any entity in the graph</p>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>

                {/* Type Legend — reflects the entity types actually present
                    (open/emergent), not a fixed taxonomy. Hidden when empty. */}
                {(() => {
                    const present = Array.from(
                        new Set(graph.nodes.map((n) => (n.type || 'Unknown').trim()).filter(Boolean))
                    ).slice(0, 12);
                    if (present.length === 0) return null;
                    return (
                        <div className="p-4 rounded-xl border border-neutral-800 bg-neutral-900/50 flex-shrink-0">
                            <h4 className="text-xs font-medium text-neutral-500 mb-3 uppercase tracking-wide">Entity Types</h4>
                            <div className="grid grid-cols-2 gap-2.5">
                                {present.map((type) => {
                                    const color = getTypeColor(type);
                                    return (
                                        <div key={type} className="flex items-center gap-2.5 text-xs">
                                            <span
                                                className="w-2.5 h-2.5 rounded-full ring-2 ring-offset-1 ring-offset-neutral-900"
                                                style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}40` }}
                                            />
                                            <span className="text-neutral-400">{type}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })()}
            </div>
        </div>
    );
}
