import { useCallback, useRef } from 'react';
import useStore from '../../store';

const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;

/**
 * Resizable two-panel layout with three modes: mapOnly, split, listOnly.
 * Reads panelMode & splitRatio from the store.
 */
export default function SplitPanel({ leftPanel, rightPanel }) {
  const panelMode = useStore((st) => st.panelMode);
  const splitRatio = useStore((st) => st.splitRatio);
  const setSplitRatio = useStore((st) => st.setSplitRatio);
  const containerRef = useRef(null);
  const dragging = useRef(false);

  const getColumns = () => {
    if (panelMode === 'mapOnly') return '1fr 0px 0fr';
    if (panelMode === 'listOnly') return '0fr 0px 1fr';
    const pct = (splitRatio * 100).toFixed(1);
    return `${pct}% 6px 1fr`;
  };

  const onMouseDown = useCallback(
    (e) => {
      if (panelMode !== 'split') return;
      e.preventDefault();
      dragging.current = true;

      const onMove = (ev) => {
        if (!dragging.current || !containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        let ratio = (ev.clientX - rect.left) / rect.width;
        ratio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
        setSplitRatio(ratio);
      };

      const onUp = () => {
        dragging.current = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [panelMode, setSplitRatio],
  );

  return (
    <div
      ref={containerRef}
      className="grid h-full overflow-hidden transition-[grid-template-columns] duration-200 ease-out"
      style={{ gridTemplateColumns: getColumns() }}
    >
      <div className="overflow-hidden relative">{leftPanel}</div>

      {panelMode === 'split' ? (
        <div
          className="w-1.5 cursor-col-resize bg-border hover:bg-primary-light relative z-5 shrink-0 transition-colors group"
          onMouseDown={onMouseDown}
        >
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full bg-txt-secondary/40 group-hover:bg-primary/60 transition-colors" />
        </div>
      ) : (
        <div />
      )}

      <div className="overflow-hidden relative">{rightPanel}</div>
    </div>
  );
}
