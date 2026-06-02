/** Returns today's date in YYYY-MM-DD using America/New_York timezone */
export const getTodayET = () => {
  const now = new Date();
  return now
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    .slice(0, 10); // en-CA gives YYYY-MM-DD natively
};

/** Converts a YYYY-MM-DD string to MM/DD/YYYY display format */
export const formatDate = (dateStr) => {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${m}/${d}/${y}`;
};

/** Formats an ISO datetime for ticket "Date/Time Opened" display */
export const formatDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};
