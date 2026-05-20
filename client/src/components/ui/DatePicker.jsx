import { useState, useRef, useEffect, useMemo, useCallback } from 'react';

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function pad(n) { return String(n).padStart(2, '0'); }
function toISO(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; }
function parseDate(str) {
  if (!str) return null;
  const [y, m, d] = str.split('-').map(Number);
  return { year: y, month: m - 1, day: d };
}

/** Custom date picker with calendar dropdown */
export default function DatePicker({ value, onChange, className = '' }) {
  const [open, setOpen] = useState(false);
  const parsed = parseDate(value);
  const now = new Date();
  const [viewYear, setViewYear] = useState(parsed?.year ?? now.getFullYear());
  const [viewMonth, setViewMonth] = useState(parsed?.month ?? now.getMonth());
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  useEffect(() => {
    if (open && parsed) {
      setViewYear(parsed.year);
      setViewMonth(parsed.month);
    }
  }, [open]);

  const grid = useMemo(() => {
    const first = new Date(viewYear, viewMonth, 1);
    const startDay = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const daysInPrev = new Date(viewYear, viewMonth, 0).getDate();

    const cells = [];
    for (let i = startDay - 1; i >= 0; i--) cells.push({ day: daysInPrev - i, current: false });
    for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, current: true });
    const remaining = 42 - cells.length;
    for (let d = 1; d <= remaining; d++) cells.push({ day: d, current: false });

    return cells;
  }, [viewYear, viewMonth]);

  const prevMonth = useCallback(() => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1); }
    else setViewMonth((m) => m - 1);
  }, [viewMonth]);

  const nextMonth = useCallback(() => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1); }
    else setViewMonth((m) => m + 1);
  }, [viewMonth]);

  const selectDay = (cell) => {
    if (!cell.current) return;
    onChange(toISO(viewYear, viewMonth, cell.day));
    setOpen(false);
  };

  const goToday = () => {
    const t = new Date();
    onChange(toISO(t.getFullYear(), t.getMonth(), t.getDate()));
    setOpen(false);
  };

  const isToday = (cell) => {
    if (!cell.current) return false;
    return viewYear === now.getFullYear() && viewMonth === now.getMonth() && cell.day === now.getDate();
  };
  const isSelected = (cell) => {
    if (!cell.current || !parsed) return false;
    return viewYear === parsed.year && viewMonth === parsed.month && cell.day === parsed.day;
  };

  const displayValue = parsed
    ? `${pad(parsed.day)}.${pad(parsed.month + 1)}.${parsed.year}`
    : '';

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        className={`h-8 w-full flex items-center gap-1.5 px-2.5 rounded-lg border text-[13px] text-left transition outline-none min-w-[130px] ${
          open
            ? 'border-primary ring-2 ring-primary-light bg-surface'
            : 'border-border bg-surface hover:border-txt-secondary/40'
        }`}
        onClick={() => setOpen(!open)}
      >
        <svg className="w-3.5 h-3.5 text-txt-secondary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
        </svg>
        <span className={`flex-1 tabular-nums ${displayValue ? 'text-txt' : 'text-txt-secondary'}`}>
          {displayValue || 'Pick date'}
        </span>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-[280px] bg-surface border border-border rounded-xl shadow-xl z-50 p-3">
          {/* Month/year nav */}
          <div className="flex items-center justify-between mb-2">
            <button type="button" className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-bg text-txt-secondary transition text-sm" onClick={prevMonth}>‹</button>
            <span className="text-sm font-semibold text-txt">{MONTHS[viewMonth]} {viewYear}</span>
            <button type="button" className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-bg text-txt-secondary transition text-sm" onClick={nextMonth}>›</button>
          </div>

          {/* Day headers */}
          <div className="grid grid-cols-7 mb-1">
            {DAYS.map((d) => (
              <div key={d} className="text-center text-[11px] font-medium text-txt-secondary py-1">{d}</div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7">
            {grid.map((cell, i) => (
              <button
                key={i}
                type="button"
                disabled={!cell.current}
                className={`w-full aspect-square flex items-center justify-center text-[13px] rounded-lg transition-all ${
                  !cell.current
                    ? 'text-txt-secondary/30 cursor-default'
                    : isSelected(cell)
                    ? 'bg-primary text-white font-semibold shadow-sm'
                    : isToday(cell)
                    ? 'bg-primary-light text-primary font-semibold'
                    : 'text-txt hover:bg-bg cursor-pointer'
                }`}
                onClick={() => selectDay(cell)}
              >
                {cell.day}
              </button>
            ))}
          </div>

          {/* Footer */}
          <div className="flex justify-between mt-2 pt-2 border-t border-border">
            <button type="button" className="text-xs text-txt-secondary hover:text-txt transition" onClick={() => { onChange(''); setOpen(false); }}>Clear</button>
            <button type="button" className="text-xs text-primary font-medium hover:text-primary-hover transition" onClick={goToday}>Today</button>
          </div>
        </div>
      )}
    </div>
  );
}
