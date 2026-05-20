/** Small "AI" indicator pill — solid when approved, outline when pending */
export default function AIBadge({ approved = false }) {
  return (
    <span
      className={`inline-flex items-center justify-center text-[10px] font-bold tracking-wide rounded-full px-2 py-0.5 leading-tight ${
        approved
          ? 'bg-ai text-white'
          : 'bg-transparent text-ai border-[1.5px] border-ai'
      }`}
    >
      AI
    </span>
  );
}
