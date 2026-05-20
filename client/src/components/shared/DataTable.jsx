import { useState, useMemo, useCallback } from 'react';

/** Reusable sortable table: columns = [{key, label, width?, render?}] */
export default function DataTable({ columns = [], data = [], onRowClick, emptyMessage = 'No data' }) {
  const [sortKey, setSortKey] = useState(null);
  const [sortAsc, setSortAsc] = useState(true);

  const handleSort = useCallback((key) => {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(true); }
  }, [sortKey]);

  const sorted = useMemo(() => {
    if (!sortKey) return data;
    return [...data].sort((a, b) => {
      const va = a[sortKey] ?? '';
      const vb = b[sortKey] ?? '';
      const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sortAsc ? cmp : -cmp;
    });
  }, [data, sortKey, sortAsc]);

  if (!data.length) {
    return <div className="py-6 text-center text-txt-secondary text-sm">{emptyMessage}</div>;
  }

  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr>
          {columns.map((col) => (
            <th
              key={col.key}
              className="text-left px-2 py-2 font-semibold text-xs text-txt-secondary border-b-2 border-border cursor-pointer select-none hover:text-txt transition"
              style={{ width: col.width }}
              onClick={() => handleSort(col.key)}
            >
              {col.label} {sortKey === col.key ? (sortAsc ? '↑' : '↓') : ''}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {sorted.map((row, i) => (
          <tr
            key={row.Id ?? row.id ?? i}
            className="hover:bg-primary-light/40 cursor-pointer transition-colors"
            onClick={() => onRowClick?.(row)}
          >
            {columns.map((col) => (
              <td key={col.key} className="px-2 py-1.5 text-txt">
                {col.render ? col.render(row[col.key], row) : (row[col.key] ?? '—')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
