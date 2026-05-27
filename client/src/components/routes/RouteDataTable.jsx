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
  { key: '#', width: 40 },
  { key: 'Location', width: 180 },
  { key: 'Service Location', width: 190 },
  { key: 'Type', width: 60, align: 'center' },
  { key: 'Last Serviced', width: 100, align: 'center' },
  { key: 'Last Gal.', width: 75, align: 'right' },
  { key: 'Gallons', width: 70, align: 'right' },
  { key: 'Special Instructions', width: 160 },
  { key: 'Customer Note', width: 140 },
  { key: 'Driver Note', width: 140 },
  { key: 'Status', width: 105, align: 'center' },
  { key: '', width: 48, align: 'center' },
];

/** Maps Route__c.ServiceType__c picklist value to a short Service__c.Code__c-style code. */
const SERVICE_TYPE_CODES = {
  'UCO Collection': 'UCO',
  'Container Service': 'CDL',
  'Grease Trap Service': 'GTC',
  'Rotisserie Water': 'RWT',
};
function shortServiceType(value) {
  if (!value) return '';
  return SERVICE_TYPE_CODES[value] || value.slice(0, 3).toUpperCase();
}

/** Formats a Salesforce date string (YYYY-MM-DD) for display. */
function formatDate(value) {
  if (!value) return '';
  try {
    const d = new Date(`${value}T00:00:00Z`);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC' });
  } catch {
    return '';
  }
}

/**
 * Returns display label + Tailwind classes for a Route__c.Status__c value.
 * - 'Driver Complete' / 'Completed' → "Complete" in green
 * - 'Passed' → grey muted ("inactive/unserviced")
 * - 'Skipped' → warning yellow
 * - others → neutral
 */
function statusBadge(raw) {
  const s = raw || '';
  if (s === 'Driver Complete' || s === 'Complete' || s === 'Completed') {
    return { label: 'Complete', cls: 'bg-success-bg text-success border border-success/20' };
  }
  if (s === 'Passed') return { label: 'Passed', cls: 'bg-bg text-txt-secondary border border-border' };
  if (s === 'Skipped') return { label: 'Skipped', cls: 'bg-warning-bg text-warning border border-warning/20' };
  if (!s) return { label: 'New', cls: 'bg-bg text-txt-secondary border border-border' };
  return { label: s, cls: 'bg-bg text-txt-secondary border border-border' };
}

function TableView({ points, onSelectPoint }) {
  const sfInstanceUrl = useStore((s) => s.sfInstanceUrl);
  const openPointEditor = useStore((s) => s.openPointEditor);

  return (
    <div className="bg-surface rounded-lg border border-border overflow-auto">
      <table className="w-full border-collapse text-[13px] table-fixed">
        <colgroup>
          {COLS.map((c, i) => (
            <col key={c.key || `col-${i}`} style={{ width: `${c.width}px` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {COLS.map((col, i) => (
              <th
                key={col.key || `h-${i}`}
                className={`sticky top-0 px-2.5 py-2 text-[11px] font-semibold text-txt-secondary uppercase tracking-wider bg-bg border-b-2 border-border whitespace-nowrap ${
                  col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'
                }`}
              >
                {col.key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {points.map((pt, idx) => {
            const fullServiceType = pt.ServiceType__c || '';
            const codeServiceType = shortServiceType(fullServiceType);
            const lastServiced = formatDate(pt.Last_Route_Serviced_Date__c);
            const status = statusBadge(pt.Status__c);
            return (
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
                  {pt.isAI__c && (
                    <span className="shrink-0 text-[9px] font-bold text-white bg-ai rounded px-1.5 py-px" title="Generated by AI">AI</span>
                  )}
                  {pt.Fixed_point__c && <span className="shrink-0 text-[9px] font-bold text-primary" title="Fixed point">📌</span>}
                </Cell>
                <Cell value={pt.Container_Address__c}>
                  <span className="truncate text-txt">{pt.Container_Address__c || '—'}</span>
                </Cell>
                <td className="px-2.5 py-2 text-center" title={fullServiceType}>
                  <span className="font-mono text-[12px] font-semibold text-txt">{codeServiceType || '—'}</span>
                </td>
                <td className="px-2.5 py-2 text-center text-[12px] text-txt-secondary tabular-nums" title={pt.Last_Route_Serviced_Date__c || ''}>
                  {lastServiced || '—'}
                </td>
                <td className="px-2.5 py-2 text-txt tabular-nums text-right">{pt.LastGallonsCollected__c ?? '—'}</td>
                <td className="px-2.5 py-2 text-txt tabular-nums text-right font-semibold">{pt.Gallons_Collected__c ?? '—'}</td>
                <Cell value={pt.Notes__c} className="text-xs text-txt-secondary">
                  <span className="truncate">{pt.Notes__c || '—'}</span>
                </Cell>
                <Cell value={pt.Notes2__c} className="text-xs text-txt-secondary">
                  <span className="truncate">{pt.Notes2__c || '—'}</span>
                </Cell>
                <Cell value={pt.Driver_Notes__c} className="text-xs text-txt-secondary">
                  <span className="truncate">{pt.Driver_Notes__c || '—'}</span>
                </Cell>
                <td className="px-2.5 py-2 text-center">
                  <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${status.cls}`}>
                    {status.label}
                  </span>
                </td>
                <td className="px-2.5 py-2 text-center">
                  <button
                    type="button"
                    title="Edit stop"
                    className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border bg-surface text-txt-secondary hover:bg-bg hover:text-primary hover:border-primary/30 transition"
                    onClick={(e) => {
                      e.stopPropagation();
                      openPointEditor(pt);
                    }}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v4.875a2.625 2.625 0 01-2.625 2.625H5.625A2.625 2.625 0 013 19.125V8.625A2.625 2.625 0 015.625 6H10.5" />
                    </svg>
                  </button>
                </td>
              </tr>
            );
          })}
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
                {(() => {
                  const s = statusBadge(pt.Status__c);
                  return <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${s.cls}`}>{s.label}</span>;
                })()}
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
