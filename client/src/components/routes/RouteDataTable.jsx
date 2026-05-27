import { useRef, useState, useEffect } from 'react';
import useStore from '../../store';

/** Route stops — table when wide, cards when narrow */
export default function RouteDataTable({ points: rawPoints = [], onSelectPoint }) {
  const points = [...rawPoints].sort((a, b) => (a.Priority__c ?? 9999) - (b.Priority__c ?? 9999));
  const containerRef = useRef(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setNarrow(entry.contentRect.width < 640);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!points.length) {
    return <div className="flex items-center justify-center h-28 text-txt-secondary text-sm">No stops on this route</div>;
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-auto">
      {narrow ? (
        <CardView points={points} onSelectPoint={onSelectPoint} />
      ) : (
        <TableView points={points} onSelectPoint={onSelectPoint} />
      )}
    </div>
  );
}

const COLS = [
  { key: '#', width: 40, align: 'left' },
  { key: 'Location', width: 200 },
  { key: 'Address', width: 220 },
  { key: 'Service Type', width: 130 },
  { key: 'Last Gal.', width: 80, align: 'right' },
  { key: 'Notes', width: 160 },
  { key: 'Customer Note', width: 160 },
  { key: 'Status', width: 100 },
];

function TableView({ points, onSelectPoint }) {
  const sfInstanceUrl = useStore((s) => s.sfInstanceUrl);
  return (
    <div className="bg-surface rounded-lg border border-border overflow-auto">
      <table className="w-full border-collapse text-[13px] table-fixed">
        <colgroup>
          {COLS.map((c) => (
            <col key={c.key} style={{ width: `${c.width}px` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {COLS.map((col) => (
              <th
                key={col.key}
                className={`sticky top-0 px-2.5 py-2 text-[11px] font-semibold text-txt-secondary uppercase tracking-wider bg-bg border-b-2 border-border whitespace-nowrap ${col.align === 'right' ? 'text-right' : 'text-left'}`}
              >
                {col.key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {points.map((pt, idx) => (
            <tr key={pt.Id || idx} className="hover:bg-primary-light/40 cursor-pointer transition-colors" onClick={() => onSelectPoint?.(pt)}>
              <td className="px-2.5 py-2 text-txt tabular-nums">{pt.Priority__c ?? idx + 1}</td>
              <Cell value={pt.Account_Name__c}>
                {sfInstanceUrl && pt.AccountId__c ? (
                  <a
                    href={`${sfInstanceUrl}/${pt.AccountId__c}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline truncate font-medium"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {pt.Account_Name__c || '—'}
                  </a>
                ) : (
                  <span className="truncate font-medium text-txt">{pt.Account_Name__c || '—'}</span>
                )}
                {pt.isAI__c && <span className="shrink-0 text-[9px] font-bold text-white bg-ai rounded px-1.5 py-px">AI</span>}
                {pt.Fixed_point__c && <span className="shrink-0 text-[9px] font-bold text-primary">📌</span>}
              </Cell>
              <Cell value={pt.Container_Address__c}>
                <span className="truncate text-txt">{pt.Container_Address__c || '—'}</span>
              </Cell>
              <Cell value={pt.ServiceType__c}>
                <span className="truncate text-txt">{pt.ServiceType__c || '—'}</span>
              </Cell>
              <td className="px-2.5 py-2 text-txt tabular-nums text-right">{pt.LastGallonsCollected__c ?? '—'}</td>
              <Cell value={pt.Notes__c} className="text-xs text-txt-secondary">
                <span className="truncate">{pt.Notes__c || '—'}</span>
              </Cell>
              <Cell value={pt.Notes2__c} className="text-xs text-txt-secondary">
                <span className="truncate">{pt.Notes2__c || '—'}</span>
              </Cell>
              <td className="px-2.5 py-2">
                <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                  pt.Status__c === 'Completed' || pt.Status__c === 'Complete' ? 'bg-success-bg text-success' :
                  pt.Status__c === 'Skipped' ? 'bg-warning-bg text-warning' :
                  'bg-bg text-txt-secondary'
                }`}>{pt.Status__c || '—'}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Single-line truncating table cell with native hover tooltip showing the full text. */
function Cell({ value, className = '', children }) {
  const title = value == null || value === '' ? undefined : String(value);
  return (
    <td className={`px-2.5 py-2 ${className}`}>
      <div className="flex items-center gap-1.5 min-w-0" title={title}>
        {children}
      </div>
    </td>
  );
}

function CardView({ points, onSelectPoint }) {
  const sfInstanceUrl = useStore((s) => s.sfInstanceUrl);
  return (
    <div className="flex flex-col gap-1.5">
      {points.map((pt, idx) => {
        const num = pt.Priority__c ?? idx + 1;
        const gallons = pt.LastGallonsCollected__c;
        const hasNotes = pt.Notes__c || pt.Notes2__c;
        return (
          <div
            key={pt.Id || idx}
            className="flex items-start gap-2.5 px-3 py-2.5 bg-surface border border-border rounded-lg hover:shadow-sm hover:border-primary/30 cursor-pointer transition group"
            onClick={() => onSelectPoint?.(pt)}
          >
            <div className="w-7 h-7 rounded-full bg-primary/10 text-primary text-[12px] font-bold flex items-center justify-center shrink-0 mt-0.5">
              {num}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                {sfInstanceUrl && pt.AccountId__c ? (
                  <a href={`${sfInstanceUrl}/${pt.AccountId__c}`} target="_blank" rel="noreferrer" className="text-[13px] font-semibold text-primary hover:underline truncate" onClick={(e) => e.stopPropagation()}>
                    {pt.Account_Name__c || '—'}
                  </a>
                ) : (
                  <span className="text-[13px] font-semibold text-txt truncate">{pt.Account_Name__c || '—'}</span>
                )}
                {pt.isAI__c && <span className="text-[9px] font-bold text-white bg-ai rounded px-1.5 py-px">AI</span>}
                {pt.Fixed_point__c && (
                  <svg className="w-3 h-3 text-primary shrink-0" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth={1}>
                    <path d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" /><path d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                  </svg>
                )}
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${
                  pt.Status__c === 'Completed' ? 'bg-success-bg text-success' :
                  pt.Status__c === 'Skipped' ? 'bg-warning-bg text-warning' :
                  'bg-bg text-txt-secondary'
                }`}>{pt.Status__c || 'New'}</span>
                {pt.isFull__c && <span className="text-[9px] font-bold text-white bg-warning rounded px-1.5 py-px">FULL</span>}
              </div>
              <div className="text-[11px] text-txt-secondary truncate mt-0.5">{pt.Container_Address__c || '—'}</div>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <span className="text-[10px] font-medium text-txt-secondary bg-bg px-2 py-0.5 rounded">{pt.ServiceType__c || 'UCO Collection'}</span>
                {pt.ServiceSubType__c && <span className="text-[10px] text-txt-secondary bg-bg px-2 py-0.5 rounded">{pt.ServiceSubType__c}</span>}
                {gallons != null && gallons !== '' && (
                  <span className="text-[10px] font-bold text-primary bg-primary/10 px-2 py-0.5 rounded tabular-nums">{gallons} gal</span>
                )}
                {hasNotes && (
                  <span className="text-[10px] text-txt-secondary italic truncate max-w-[180px]" title={pt.Notes__c || pt.Notes2__c}>
                    {pt.Notes__c || pt.Notes2__c}
                  </span>
                )}
              </div>
            </div>
            <svg className="w-4 h-4 text-border group-hover:text-txt-secondary transition shrink-0 mt-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </div>
        );
      })}
    </div>
  );
}
