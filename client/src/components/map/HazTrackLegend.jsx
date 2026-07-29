import { HAZTRACK_STATUS_COLORS } from '../../utils/haztrack';

const ITEMS = ['Healthy', 'Warning', 'Critical', 'Issue'];

/** Bottom-left legend for HazTrack marker colors. */
export default function HazTrackLegend() {
  return (
    <div className="absolute bottom-6 left-2 z-10 flex items-center gap-3 px-3 py-1.5 bg-surface/95 border border-border rounded-lg shadow-md">
      {ITEMS.map((label) => (
        <span key={label} className="flex items-center gap-1.5 text-[11px] text-txt">
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ background: HAZTRACK_STATUS_COLORS[label] }}
          />
          {label}
        </span>
      ))}
    </div>
  );
}
