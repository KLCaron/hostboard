import { useRef, type ReactNode, type PointerEvent, type KeyboardEvent } from 'react';

export interface Selection { startIndex: number; endIndex: number }
type Drag = { pointer: number; anchor: number; edge?: 'startIndex' | 'endIndex'; initial: Selection; original: Selection | null; started: boolean };
const label = (time: number) => new Date(time * 1000).toLocaleString();
const clock = (time: number) => new Date(time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function HistorySelection({ times, selection, onChange, onStart, children }: {
  times: number[];
  selection: Selection | null;
  onChange: (selection: Selection | null) => void;
  onStart: () => void;
  children: ReactNode;
}) {
  const plot = useRef<HTMLDivElement>(null), track = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const last = times.length - 1;
  const current = selection || { startIndex: 0, endIndex: last };
  const fraction = (index: number) => last > 0 ? index / last : 0;
  const bounds = (element: HTMLDivElement) => {
    const rect = element.getBoundingClientRect(), isPlot = element === plot.current;
    // These offsets match LineChart's left/right margins and 54px Y axis.
    return { left: rect.left + (isPlot ? 54 : 0), width: rect.width - (isPlot ? 66 : 0), top: rect.top + 8, bottom: rect.bottom - 30 };
  };
  const indexAt = (event: PointerEvent<HTMLDivElement>) => {
    const b = bounds(event.currentTarget);
    return Math.round(Math.max(0, Math.min(1, (event.clientX - b.left) / b.width)) * last);
  };
  const begin = (event: PointerEvent<HTMLDivElement>, edge?: Drag['edge']) => {
    if (!event.isPrimary || event.button !== 0 || last < 1) return;
    const b = bounds(event.currentTarget);
    if (event.currentTarget === plot.current && (event.clientX < b.left || event.clientX > b.left + b.width || event.clientY < b.top || event.clientY > b.bottom)) return;
    const anchor = indexAt(event);
    drag.current = { pointer: event.pointerId, anchor, edge, initial: current, original: selection, started: !!edge };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (edge) onStart();
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    const index = indexAt(event);
    if (!d.started) {
      if (index === d.anchor) return;
      d.started = true; onStart();
    }
    onChange(d.edge === 'startIndex' ? { ...d.initial, startIndex: Math.max(0, Math.min(index, d.initial.endIndex - 1)) }
      : d.edge === 'endIndex' ? { ...d.initial, endIndex: Math.min(last, Math.max(index, d.initial.startIndex + 1)) }
        : { startIndex: Math.min(d.anchor, index), endIndex: Math.max(d.anchor, index) });
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    move(event); drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const cancel = () => { if (drag.current?.started) onChange(drag.current.original); drag.current = null; };
  const key = (event: KeyboardEvent, edge: 'startIndex' | 'endIndex') => {
    if (last < 1) return;
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, PageDown: -10, PageUp: 10 };
    if (!(event.key in steps) && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault(); onStart();
    const low = edge === 'startIndex' ? 0 : Math.min(last, current.startIndex + 1);
    const high = edge === 'startIndex' ? Math.max(0, current.endIndex - 1) : last;
    const value = event.key === 'Home' ? low : event.key === 'End' ? high : current[edge] + steps[event.key];
    onChange({ ...current, [edge]: Math.max(low, Math.min(high, value)) });
  };
  const startPercent = fraction(current.startIndex) * 100, endPercent = fraction(current.endIndex) * 100;
  return <>
    <p className="detail-description">Drag across the chart or timeline to select a period. Adjust its handles, then zoom to investigate.</p>
    <div className="history-chart selectable-chart" ref={plot} onPointerDown={event => begin(event)} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel}>
      {children}
      {selection && <div className="chart-selection-plot" aria-hidden="true"><div style={{ left: `${startPercent}%`, width: `${endPercent - startPercent}%` }} /></div>}
    </div>
    <div className="history-brush" role="group" aria-label="Historical range selector">
      <div className="history-brush-track" ref={track} onPointerDown={event => {
        const handle = (event.target as Element).closest('[data-edge]');
        begin(event, handle?.getAttribute('data-edge') as Drag['edge']);
      }} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel}>
        <div className="history-brush-range" aria-hidden="true" style={{ left: `${startPercent}%`, width: `${endPercent - startPercent}%` }} />
        {(['startIndex', 'endIndex'] as const).map((edge, i) => <div key={edge} className="history-brush-handle" data-edge={edge} role="slider" tabIndex={0}
          aria-label={i === 0 ? 'Selection start' : 'Selection end'} aria-disabled={last < 1} aria-valuemin={i === 0 ? 0 : Math.min(last, current.startIndex + 1)} aria-valuemax={i === 0 ? Math.max(0, current.endIndex - 1) : last}
          aria-valuenow={current[edge]} aria-valuetext={label(times[current[edge]])} onKeyDown={event => key(event, edge)} style={{ left: `${fraction(current[edge]) * 100}%` }}><span aria-hidden="true">Ⅱ</span></div>)}
      </div>
      <div className="history-brush-labels"><span>{clock(times[0])}</span><span>{clock(times[last])}</span></div>
    </div>
    {selection && <p className="detail-description" role="status" aria-label="Selected time window">Selected: {label(times[selection.startIndex])} — {label(times[selection.endIndex])}{times[selection.endIndex] - times[selection.startIndex] < 30 ? ' · select at least 30 seconds to zoom' : ''} <button className="text-link" onClick={() => onChange(null)}>Clear selection</button></p>}
  </>;
}
