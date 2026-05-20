/** Extract a readable error message from API responses */
export function getErrorMessage(err) {
  const data = err?.response?.data;
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      if (parsed.error) return parsed.error;
    } catch {
      return data;
    }
  }
  if (data?.error) {
    if (typeof data.error === 'string') {
      try {
        const inner = JSON.parse(data.error);
        return inner.error || inner.message || data.error;
      } catch {
        return data.error;
      }
    }
    return String(data.error);
  }
  if (data?.message) return data.message;
  return err?.message || 'An unexpected error occurred';
}
