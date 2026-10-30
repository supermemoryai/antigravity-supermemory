const CREDENTIAL_ASSIGNMENT =
  /\b((?:[A-Z][A-Z0-9]*_)*(?:API_?KEY|ACCESS_?KEY_?ID|SECRET_?ACCESS_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|TOKEN|PASSWORD|PASSWD|SECRET|CLIENT_?SECRET|PRIVATE_?KEY))(["']?\s*[:=]\s*)("(?:(?!<\|end\|>)[^"])*"|'(?:(?!<\|end\|>)[^'])*'|[^\s,;"'`<>]+)/gi;

function isPlaceholder(value) {
  return /^(?:\[REDACTED(?::[^\]]+)?\]|<[^>]+>|\$\{[^}]+\}|\{\{[^}]+\}\}|\$[A-Z_][A-Z0-9_]*|(?:your|example|placeholder|replace|insert|changeme|redacted)(?:[-_ ].*)?|password|token|api[-_]key|secret|dummy|\*+|\.+)$/i.test(
    value,
  );
}

function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text;

  return text
    .replace(
      /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|(?="(?:\s+[A-Za-z_][A-Za-z0-9_]*="|<\|end\|>))|(?=<\|end\|>)|$)/g,
      '[REDACTED:private_key]',
    )
    .replace(
      /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/<>"'`]*:[^\s/<>"'`]*?)@/gi,
      (match, scheme, credentials) =>
        isPlaceholder(credentials.split(':').slice(1).join(':'))
          ? match
          : `${scheme}[REDACTED:url_credentials]@`,
    )
    .replace(CREDENTIAL_ASSIGNMENT, (match, name, separator, raw) => {
      const quote = raw.startsWith('"') || raw.startsWith("'") ? raw[0] : '';
      const value = quote ? raw.slice(1, -1) : raw;
      if (value.length < 8 || isPlaceholder(value)) return match;
      return `${name}${separator}${quote}[REDACTED:credential]${quote}`;
    })
    .replace(
      /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})(?![A-Za-z0-9._~+/=-])/gi,
      (match, value) =>
        isPlaceholder(value) ? match : 'Bearer [REDACTED:bearer_token]',
    )
    .replace(
      /(?<![A-Za-z0-9_])(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|sm_[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{35}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16})(?![A-Za-z0-9_-])/g,
      '[REDACTED:provider_token]',
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g,
      '[REDACTED:jwt]',
    );
}

// <private>…</private> never leaves the machine. An unclosed tag hides
// everything after it rather than leaking the tail.
function stripPrivate(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(/<private>[\s\S]*?<\/private>/gi, '[REDACTED]')
    .replace(/<private>[\s\S]*$/i, '[REDACTED]');
}

module.exports = { redactSecrets, stripPrivate };
