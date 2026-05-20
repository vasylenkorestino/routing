/** Centered empty state placeholder with optional icon */
export default function EmptyState({ message = 'Nothing here yet', icon }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 gap-2">
      {icon && <div className="text-3xl opacity-50">{icon}</div>}
      <div className="text-sm text-txt-secondary text-center">{message}</div>
    </div>
  );
}
