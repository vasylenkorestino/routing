import { useState, useEffect, useCallback } from 'react';

let addToastFn = null;
let idCounter = 0;

/** Call from anywhere to show a toast */
export function toast(message, type = 'error', duration = 6000) {
  if (addToastFn) addToastFn({ id: ++idCounter, message, type, duration });
}

toast.error = (msg, duration) => toast(msg, 'error', duration);
toast.success = (msg, duration) => toast(msg, 'success', duration);
toast.info = (msg, duration) => toast(msg, 'info', duration);

const ICONS = {
  error: (
    <svg className="w-5 h-5 text-red-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
    </svg>
  ),
  success: (
    <svg className="w-5 h-5 text-emerald-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  info: (
    <svg className="w-5 h-5 text-blue-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
    </svg>
  ),
};

const BORDER = { error: 'border-l-red-500', success: 'border-l-emerald-500', info: 'border-l-blue-500' };

/** Render this once at app root — provides the toast container */
export default function ToastContainer() {
  const [toasts, setToasts] = useState([]);

  const add = useCallback((t) => setToasts((prev) => [...prev, t]), []);
  const remove = useCallback((id) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  useEffect(() => { addToastFn = add; return () => { addToastFn = null; }; }, [add]);

  return (
    <div className="fixed top-3 right-3 z-[9999] flex flex-col gap-2 max-w-[420px] pointer-events-none">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => remove(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast: t, onDismiss }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, t.duration || 6000);
    return () => clearTimeout(timer);
  }, [t.duration, onDismiss]);

  return (
    <div
      className={`pointer-events-auto flex items-start gap-2.5 px-4 py-3 bg-surface border border-border border-l-4 ${BORDER[t.type] || BORDER.error} rounded-lg shadow-xl animate-slide-in`}
    >
      {ICONS[t.type] || ICONS.error}
      <p className="flex-1 text-[13px] text-txt leading-snug break-words">{t.message}</p>
      <button
        className="shrink-0 text-txt-secondary hover:text-txt text-sm leading-none mt-0.5"
        onClick={onDismiss}
      >×</button>
    </div>
  );
}
