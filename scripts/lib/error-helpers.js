// Numeric status is the stable field; error classes differ across SDK builds.
function getUserFriendlyError(err) {
  const status = err?.status ?? err?.statusCode;

  if (isTimeout(err) || err?.message === 'fetch failed') {
    return 'Supermemory unreachable (network) — continuing without memory.';
  }
  if (err?.code === 'INVALID_NAMESPACE') return err.message;
  if (status === 400) {
    return 'Bad request — your API key or request format may be invalid. Check your key at https://console.supermemory.ai';
  }
  if (status === 401) {
    return 'Authentication failed — your credentials may be expired or revoked. Run /supermemory-login, or check your configured API key.';
  }
  if (status === 402) {
    return 'Out of credits — top up at https://console.supermemory.ai to continue saving.';
  }
  if (status === 403) {
    return 'Permission denied — this feature may require a different Supermemory plan. Check https://supermemory.ai/pricing';
  }
  if (status === 429) {
    return 'Rate limited — too many requests. Will retry next session.';
  }
  if (typeof status === 'number' && status >= 500) {
    return 'Supermemory service is temporarily unavailable. Will retry next session.';
  }
  if (typeof status === 'number') {
    return `Supermemory API returned HTTP ${status}.`;
  }

  return err?.message || 'Unknown error';
}

function isTimeout(err) {
  const status = err?.status ?? err?.statusCode;
  return (
    err?.name === 'TimeoutError' ||
    err?.name === 'AbortError' ||
    err?.name === 'SupermemoryTimeoutError' ||
    (err?.name === 'SupermemoryError' && status == null) ||
    err?.cause?.name === 'TimeoutError' ||
    err?.cause?.name === 'AbortError'
  );
}

module.exports = { getUserFriendlyError, isTimeout };
