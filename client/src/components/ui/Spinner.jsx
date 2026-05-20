/** Reusable spinner — sizes: sm (16px), md (24px), lg (32px) */
export default function Spinner({ size = 'md', className = '' }) {
  const sizes = { sm: 'w-4 h-4 border-[2px]', md: 'w-6 h-6 border-[2.5px]', lg: 'w-8 h-8 border-[3px]' };
  return (
    <div className={`${sizes[size] || sizes.md} border-primary/30 border-t-primary rounded-full animate-spin ${className}`} />
  );
}

/** Full overlay spinner — covers parent with semi-transparent backdrop */
export function OverlaySpinner({ label }) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-surface/70 backdrop-blur-[1px] rounded-xl">
      <Spinner size="lg" />
      {label && <span className="mt-2 text-xs font-medium text-txt-secondary">{label}</span>}
    </div>
  );
}

/** Inline spinner with optional text — use inside buttons or next to content */
export function InlineSpinner({ label, size = 'sm' }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Spinner size={size} />
      {label && <span className="text-xs text-txt-secondary">{label}</span>}
    </span>
  );
}
