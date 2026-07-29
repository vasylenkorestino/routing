import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Optional comment dialog shown when declining AI Route Log recommendations.
 * Comment is not required — Decline can proceed with an empty note.
 */
export default function DeclineCommentModal({
  open,
  title = 'Decline recommendation',
  message,
  loading = false,
  onConfirm,
  onCancel,
}) {
  const [comment, setComment] = useState('');
  const textareaRef = useRef(null);

  useEffect(() => {
    if (open) {
      setComment('');
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape' && !loading) onCancel(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, loading, onCancel]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => !loading && onCancel()} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden animate-[scaleIn_0.15s_ease-out]">
        <div className="px-5 pt-5 pb-3">
          <h3 className="text-base font-semibold text-gray-900 mb-1">{title}</h3>
          {message && <p className="text-sm text-gray-500 leading-relaxed mb-3">{message}</p>}
          <label className="block text-[11px] font-medium text-gray-500 mb-1">
            Reason <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <textarea
            ref={textareaRef}
            className="w-full h-24 px-3 py-2 text-sm rounded-lg border border-gray-200 bg-gray-50 text-gray-900 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100 resize-y"
            placeholder="Why are you declining this recommendation?"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            disabled={loading}
            maxLength={32000}
          />
        </div>
        <div className="flex justify-end gap-2 px-5 pb-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(comment.trim())}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg bg-red-500 hover:bg-red-600 transition disabled:opacity-50"
          >
            {loading ? 'Declining…' : 'Decline'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
