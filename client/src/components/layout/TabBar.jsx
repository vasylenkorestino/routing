/** Horizontal tab switcher */
export default function TabBar({ tabs, activeTab, onTabChange }) {
  return (
    <div className="flex border-b-2 border-border bg-surface shrink-0">
      {tabs.map((t) => (
        <button
          key={t.key}
          className={`px-5 py-2.5 text-[13px] -mb-[2px] border-b-2 bg-transparent transition-colors ${
            activeTab === t.key
              ? 'font-semibold text-primary border-primary'
              : 'font-normal text-txt-secondary border-transparent hover:text-txt hover:border-border'
          }`}
          onClick={() => onTabChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
