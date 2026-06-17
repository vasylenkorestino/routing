/** Reusable live step checklist + findings feed for async AI jobs. */
export default function AIProgressSteps({
  steps = [],
  findings = [],
  progress = {},
  status = 'running',
  compact = false,
}) {
  const percent = Math.max(0, Math.min(100, progress?.percent ?? 0));
  const currentLabel = progress?.label || 'Processing…';

  return (
    <div className={`space-y-3 ${compact ? '' : 'py-2'}`}>
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className={`font-medium text-txt flex items-center gap-2 ${compact ? 'text-[12px]' : 'text-[13px]'}`}>
            {status === 'running' && <Spinner />}
            {currentLabel}
          </span>
          <span className="text-[11px] text-txt-secondary tabular-nums">{percent}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-border/60 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${status === 'error' ? 'bg-red-500' : 'bg-ai'}`}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      {steps.length > 0 && (
        <ul className={`space-y-1 ${compact ? 'text-[11px]' : 'text-[12px]'}`}>
          {steps.map((s) => (
            <li key={s.id} className="flex items-start gap-2 text-txt-secondary">
              <StepIcon status={s.status} />
              <span className={s.status === 'running' ? 'text-txt font-medium' : ''}>
                {s.label}
                {s.detail ? <span className="text-txt-secondary font-normal"> — {s.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      {findings.length > 0 && (
        <div className={`space-y-1 ${compact ? 'text-[11px]' : 'text-[12px]'}`}>
          {findings.map((f, i) => (
            <div key={i} className="text-txt-secondary pl-3 border-l-2 border-ai/30">
              → {f}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StepIcon({ status }) {
  if (status === 'done') return <span className="text-success shrink-0">✓</span>;
  if (status === 'running') return <span className="text-ai shrink-0 animate-pulse">⏳</span>;
  if (status === 'error') return <span className="text-error shrink-0">✗</span>;
  return <span className="text-txt-secondary/50 shrink-0">○</span>;
}

function Spinner() {
  return <span className="w-3 h-3 border-2 border-ai border-t-transparent rounded-full animate-spin inline-block shrink-0" />;
}
