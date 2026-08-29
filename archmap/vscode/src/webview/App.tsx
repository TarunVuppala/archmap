import { useEffect, useState } from 'react';
import { useRef } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import { Cosmograph } from '@cosmos.gl/graph';
import '@xyflow/react/dist/style.css';

type GraphPayload = { nodes?: Array<Record<string, unknown>>; edges?: Array<Record<string, unknown>> };

export default function App() {
  const [graph, setGraph] = useState<GraphPayload>({ nodes: [], edges: [] });
  const [view, setView] = useState<'architecture' | 'galaxy'>('architecture');
  const vscodeApi = useRef<{ postMessage: (message: unknown) => void }>();
  useEffect(() => {
    const handler = (event: MessageEvent<{ type: string; payload?: GraphPayload }>) => {
      if (event.data.type === 'graph' && event.data.payload) {
        setGraph(event.data.payload);
        setView(event.data.payload.renderer === 'cosmograph' ? 'galaxy' : 'architecture');
      }
    };
    window.addEventListener('message', handler);
    vscodeApi.current = (window as unknown as { acquireVsCodeApi?: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi?.();
    vscodeApi.current?.postMessage({ command: 'refresh', view: 'architecture' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const nodes: Node[] = (graph.nodes || []).map((node, index) => ({
    id: String(node.id),
    data: { label: String(node.name || node.id) },
    position: { x: (index % 4) * 220, y: Math.floor(index / 4) * 100 },
  }));
  const edges: Edge[] = (graph.edges || []).map((edge) => ({
    id: String(edge.id), source: String(edge.from), target: String(edge.to), label: String(edge.type || ''),
  }));
  const toggle = <div style={{ position: 'absolute', zIndex: 2, padding: 8 }}><button onClick={() => { setView('architecture'); vscodeApi.current?.postMessage({ command: 'refresh', view: 'architecture' }); }}>Map</button><button onClick={() => { setView('galaxy'); vscodeApi.current?.postMessage({ command: 'refresh', view: 'galaxy' }); }}>Galaxy</button></div>;
  if (view === 'galaxy') return <>{toggle}<GalaxyView nodes={nodes} edges={edges} /></>;
  return <>{toggle}<div style={{ height: '100vh' }}><ReactFlow nodes={nodes} edges={edges} fitView><Background /><Controls /><MiniMap /></ReactFlow></div></>;
}

function GalaxyView({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const graph = new Cosmograph(container.current, { spaceSize: 1, curvedLinks: true });
    graph.setData(nodes.map((node) => ({ id: node.id, label: String(node.data.label) })), edges.map((edge) => ({ source: edge.source, target: edge.target })));
    return () => graph.destroy();
  }, [nodes, edges]);
  return <div ref={container} data-renderer="cosmograph" style={{ height: '100vh' }} />;
}
