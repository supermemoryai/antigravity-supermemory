const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {
  SETTINGS_DIR,
  CREDENTIALS_FILE,
  CLIENT_FILE,
  LOCK_FILE,
  LOGGED_OUT_FILE,
} = require('./paths');
const { PLUGIN_VERSION } = require('./version');

const AUTH_PORT = 19882;
const AUTH_WAIT_MS = 5 * 60 * 1000;
const HOOK_WAIT_MS = 20000;
const POLL_MS = 500;
const REFRESH_TIMEOUT = 3000;
const REFRESH_REQUEST_TIMEOUT = 10000;
const REFRESH_SKEW = 60000;
const REDIRECT_URI = `http://127.0.0.1:${AUTH_PORT}/callback`;
const SCOPE = 'openid profile email offline_access';

const PAGE_STYLE = `*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:100vh;background:#0b1015;color:#f4f4f5;text-align:center;padding:24px}
.badge{display:inline-flex;align-items:center;gap:8px;font-size:14px;margin-bottom:16px}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
h1{font-size:30px;font-weight:500;margin-bottom:12px}
p{color:#a1a1aa;font-size:16px;max-width:460px;line-height:1.5}`;

// The browser only ever sees these fixed strings; error details stay in the
// terminal so a response body can never leak into the page.
const AUTH_SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Connected - Supermemory</title><style>${PAGE_STYLE}</style></head><body>
<div class="badge"><span class="dot" style="background:#22c55e"></span><span style="color:#22c55e">Connected</span></div>
<h1>Supermemory is ready</h1>
<p>You can close this tab and return to Antigravity. Memory turns on from your next message.</p>
</body></html>`;

function renderAuthError(error) {
  const denied = error?.code === 'access_denied';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${denied ? 'Authorization Denied' : 'Connection Failed'} - Supermemory</title><style>${PAGE_STYLE}</style></head><body>
<div class="badge"><span class="dot" style="background:#ef4444"></span><span style="color:#ef4444">Not connected</span></div>
<h1>${denied ? 'Authorization Denied' : 'Connection Failed'}</h1>
<p>${
    denied
      ? 'You declined access, so Supermemory was not connected. Return to Antigravity and run /supermemory-login to retry.'
      : 'Supermemory could not finish signing you in. Return to Antigravity and run /supermemory-login to try again.'
  }</p>
</body></html>`;
}

function openUrl(url) {
  const target = url.toString();
  if (!/^https?:\/\//i.test(target))
    throw new Error('Refusing to open non-http URL');
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  return new Promise((resolve, reject) => {
    // A headless box has no opener; report that instead of crashing the hook.
    const child = execFile(command, args, { windowsHide: true }, (error) =>
      error ? reject(error) : resolve(),
    );
    child.on('error', reject);
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function loadCredentials() {
  const data = readJson(CREDENTIALS_FILE);
  return data?.apiKey || data?.type === 'oauth' ? data : null;
}

function writeJson(file, data) {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function saveCredentials(credentials) {
  writeJson(CREDENTIALS_FILE, {
    ...(typeof credentials === 'string'
      ? { apiKey: credentials }
      : credentials),
    savedAt: new Date().toISOString(),
  });
}

// An explicit logout stays in effect: sessions stop opening the browser until
// the user signs in again on purpose.
function isLoggedOut() {
  return fs.existsSync(LOGGED_OUT_FILE);
}

// Hooks and the proxy are separate processes. Serialize refresh token rotation
// and re-read credentials under the lock before spending a single-use token.
function recoverAbandonedLock() {
  let recovery;
  let linked = false;
  try {
    const original = fs.statSync(LOCK_FILE);
    // Only one process may reclaim a particular inode. Re-check the inode after
    // linking: another process may already have replaced the abandoned lock.
    recovery = `${LOCK_FILE}.${original.dev}.${original.ino}.recovery`;
    fs.linkSync(LOCK_FILE, recovery);
    linked = true;
    const snapshot = fs.statSync(recovery);
    if (snapshot.ino !== original.ino || snapshot.dev !== original.dev) return;
    const owner = readJson(recovery);
    let abandoned = false;
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        abandoned = error.code === 'ESRCH';
      }
    } else {
      abandoned = Date.now() - snapshot.mtimeMs > AUTH_WAIT_MS * 2;
    }
    if (abandoned) {
      const current = fs.statSync(LOCK_FILE);
      if (current.ino === original.ino && current.dev === original.dev) {
        fs.unlinkSync(LOCK_FILE);
      }
    }
  } catch (error) {
    if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error;
  } finally {
    if (linked) fs.rmSync(recovery, { force: true });
  }
}

// A login started by a hook waits in the background, so a newer login stops it
// instead of waiting up to five minutes for the lock.
function stopBackgroundLogin() {
  const owner = readJson(LOCK_FILE);
  if (!owner?.background || !Number.isInteger(owner.pid) || owner.pid <= 0)
    return;
  try {
    process.kill(owner.pid);
  } catch {}
}

async function withAuthLock(
  action,
  timeoutMs,
  { background = false, preempt = false } = {},
) {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let descriptor;
  let stopped = false;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(LOCK_FILE, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (preempt && !stopped) {
        stopBackgroundLogin();
        stopped = true;
      }
      recoverAbandonedLock();
      if (Date.now() >= deadline)
        throw new Error('Supermemory authentication is busy. Try again.');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    fs.writeFileSync(
      descriptor,
      JSON.stringify({ pid: process.pid, ...(background && { background }) }),
    );
    return await action(Math.max(1, deadline - Date.now()));
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(LOCK_FILE, { force: true });
  }
}

function secureUrl(value) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new Error(
      'OAuth requires HTTPS (HTTP is allowed only for loopback development).',
    );
  }
  return url.toString().replace(/\/+$/, '');
}

function getOAuthConfig(baseUrl, mcpUrl) {
  const apiBaseUrl = secureUrl(baseUrl);
  const issuer = secureUrl(
    process.env.SUPERMEMORY_OAUTH_ISSUER || `${apiBaseUrl}/api/auth`,
  );
  return { apiBaseUrl, issuer, resource: secureUrl(mcpUrl) };
}

function sameConfig(credentials, config) {
  return ['apiBaseUrl', 'issuer', 'resource'].every(
    (key) => credentials?.[key] === config[key],
  );
}

function hasOAuthCredentials(config) {
  const credentials = loadCredentials();
  return (
    credentials?.type === 'oauth' &&
    sameConfig(credentials, config) &&
    (!!credentials.refreshToken ||
      (!!credentials.accessToken &&
        credentials.expiresAt > Date.now() + REFRESH_SKEW))
  );
}

function issuerEndpoint(value, issuer) {
  const endpoint = secureUrl(value);
  if (new URL(endpoint).origin !== new URL(issuer).origin) {
    throw new Error('OAuth endpoint does not belong to the configured issuer.');
  }
  return endpoint;
}

async function oauthRequest(url, options) {
  const response = await fetch(url, { ...options, redirect: 'error' });
  const body = await response.json().catch(() => null);
  const data = body && typeof body === 'object' ? body : {};
  if (!response.ok) {
    // Never include response bodies or tokens in hook output.
    const code = ['invalid_grant', 'invalid_client', 'access_denied'].includes(
      data.error,
    )
      ? data.error
      : 'oauth_request_failed';
    throw Object.assign(
      new Error(
        `Supermemory authorization failed (${code}, HTTP ${response.status}).`,
      ),
      {
        code,
        status: response.status,
      },
    );
  }
  return data;
}

async function registerClient(config, signal) {
  const saved = readJson(CLIENT_FILE);
  if (
    sameConfig(saved, config) &&
    saved.clientId &&
    saved.redirectUri === REDIRECT_URI
  )
    return saved;
  const metadata = await oauthRequest(
    new URL('/.well-known/oauth-authorization-server', config.issuer),
    { signal },
  );
  if (metadata.issuer !== config.issuer)
    throw new Error('OAuth discovery returned an unexpected issuer.');
  const authorizationEndpoint = issuerEndpoint(
    metadata.authorization_endpoint,
    config.issuer,
  );
  const tokenEndpoint = issuerEndpoint(metadata.token_endpoint, config.issuer);
  const registrationEndpoint = issuerEndpoint(
    metadata.registration_endpoint,
    config.issuer,
  );
  const revocationEndpoint = issuerEndpoint(
    metadata.revocation_endpoint,
    config.issuer,
  );
  const registration = await oauthRequest(registrationEndpoint, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Supermemory for Antigravity',
      client_uri: 'https://github.com/supermemoryai/antigravity-supermemory',
      software_id: 'antigravity-supermemory',
      software_version: PLUGIN_VERSION,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: SCOPE,
    }),
  });
  if (
    typeof registration.client_id !== 'string' ||
    !registration.client_id ||
    registration.token_endpoint_auth_method !== 'none'
  ) {
    throw new Error('OAuth registration did not return a public client.');
  }
  const client = {
    ...config,
    clientId: registration.client_id,
    redirectUri: REDIRECT_URI,
    authorizationEndpoint,
    tokenEndpoint,
    revocationEndpoint,
  };
  signal.throwIfAborted();
  writeJson(CLIENT_FILE, client);
  return client;
}

async function exchangeToken(client, parameters, signal, previous) {
  const data = await oauthRequest(
    issuerEndpoint(client.tokenEndpoint, client.issuer),
    {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.clientId,
        resource: client.resource,
        ...parameters,
      }),
    },
  );
  const refreshToken = data.refresh_token ?? previous?.refreshToken;
  if (
    typeof data.access_token !== 'string' ||
    !data.access_token ||
    typeof data.token_type !== 'string' ||
    data.token_type.toLowerCase() !== 'bearer' ||
    typeof data.expires_in !== 'number' ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0 ||
    typeof refreshToken !== 'string' ||
    !refreshToken
  ) {
    throw new Error('OAuth returned an invalid token response.');
  }
  signal.throwIfAborted();
  saveCredentials({
    ...client,
    type: 'oauth',
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  fs.rmSync(LOGGED_OUT_FILE, { force: true });
  return data.access_token;
}

function authRequired() {
  return Object.assign(new Error('AUTH_REQUIRED'), { code: 'AUTH_REQUIRED' });
}

// Never abort a refresh mid-flight: the server would rotate a refresh token we
// never stored, and the next refresh would fail with invalid_grant.
let pendingRefresh = null;

function refreshCredentials(config) {
  if (pendingRefresh) return pendingRefresh;
  pendingRefresh = withAuthLock(async (remaining) => {
    const credentials = loadCredentials();
    if (credentials?.type !== 'oauth' || !sameConfig(credentials, config))
      throw authRequired();
    if (
      credentials.accessToken &&
      credentials.expiresAt > Date.now() + REFRESH_SKEW
    )
      return credentials.accessToken;
    if (!credentials.refreshToken) throw authRequired();
    try {
      return await exchangeToken(
        credentials,
        {
          grant_type: 'refresh_token',
          refresh_token: credentials.refreshToken,
        },
        AbortSignal.timeout(remaining),
        credentials,
      );
    } catch (error) {
      if (error.code === 'invalid_grant' || error.code === 'invalid_client') {
        const registration = { ...credentials };
        delete registration.accessToken;
        delete registration.refreshToken;
        saveCredentials(registration);
        if (error.code === 'invalid_client')
          fs.rmSync(CLIENT_FILE, { force: true });
        throw authRequired();
      }
      throw error;
    }
  }, REFRESH_REQUEST_TIMEOUT).finally(() => {
    pendingRefresh = null;
  });
  pendingRefresh.catch(() => {});
  return pendingRefresh;
}

function waitFor(promise, timeoutMs) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        Object.assign(
          new Error('Supermemory token refresh is still in progress.'),
          { code: 'AUTH_PENDING', name: 'TimeoutError' },
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

async function getAccessToken(config, timeoutMs = REFRESH_TIMEOUT) {
  const saved = loadCredentials();
  if (saved?.type !== 'oauth' || !sameConfig(saved, config))
    throw authRequired();
  if (saved.accessToken && saved.expiresAt > Date.now() + REFRESH_SKEW)
    return saved.accessToken;
  return waitFor(refreshCredentials(config), timeoutMs);
}

// Resolves once any in-flight refresh has saved or failed, so a process that
// exits explicitly can let the rotated tokens land first.
async function settleAuth() {
  while (pendingRefresh) {
    await pendingRefresh.catch(() => {});
  }
}

async function clearCredentials() {
  return withAuthLock(
    async (remaining) => {
      const credentials = loadCredentials();
      if (credentials?.type === 'oauth' && credentials.refreshToken) {
        await oauthRequest(
          issuerEndpoint(credentials.revocationEndpoint, credentials.issuer),
          {
            method: 'POST',
            signal: AbortSignal.timeout(remaining),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: credentials.clientId,
              token: credentials.refreshToken,
              token_type_hint: 'refresh_token',
            }),
          },
        );
      }
      writeJson(LOGGED_OUT_FILE, { loggedOutAt: new Date().toISOString() });
      fs.rmSync(CREDENTIALS_FILE, { force: true });
    },
    REFRESH_REQUEST_TIMEOUT,
    { preempt: true },
  );
}

async function startAuthFlow(
  config,
  {
    force = false,
    timeoutMs = AUTH_WAIT_MS,
    printUrl = false,
    background = false,
  } = {},
) {
  return withAuthLock(
    async (remaining) => {
      const current = loadCredentials();
      if (
        !force &&
        sameConfig(current, config) &&
        current.accessToken &&
        current.expiresAt > Date.now() + REFRESH_SKEW
      )
        return current.accessToken;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error('AUTH_TIMEOUT')),
        remaining,
      );
      let server;
      try {
        const client = await registerClient(config, controller.signal);
        const state = crypto.randomBytes(32).toString('base64url');
        const verifier = crypto.randomBytes(32).toString('base64url');
        const authorizationUrl = new URL(
          issuerEndpoint(client.authorizationEndpoint, client.issuer),
        );
        authorizationUrl.search = new URLSearchParams({
          client_id: client.clientId,
          redirect_uri: REDIRECT_URI,
          response_type: 'code',
          scope: SCOPE,
          resource: client.resource,
          code_challenge: crypto
            .createHash('sha256')
            .update(verifier)
            .digest('base64url'),
          code_challenge_method: 'S256',
          state,
          prompt: 'consent',
        }).toString();
        return await new Promise((resolve, reject) => {
          let exchanging = false;
          controller.signal.addEventListener(
            'abort',
            () => reject(controller.signal.reason),
            { once: true },
          );
          server = http.createServer(async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Referrer-Policy', 'no-referrer');
            let url;
            try {
              url = new URL(req.url, REDIRECT_URI);
            } catch {
              res.writeHead(400).end();
              return;
            }
            if (req.method !== 'GET' || url.pathname !== '/callback') {
              res.writeHead(404).end();
              return;
            }
            const receivedState = Buffer.from(
              url.searchParams.get('state') || '',
            );
            if (
              receivedState.length !== state.length ||
              !crypto.timingSafeEqual(receivedState, Buffer.from(state)) ||
              (url.searchParams.has('iss') &&
                url.searchParams.get('iss') !== client.issuer)
            ) {
              res.writeHead(400).end('Invalid authorization state.');
              return;
            }
            if (exchanging) {
              res.writeHead(409).end();
              return;
            }
            exchanging = true;
            try {
              if (url.searchParams.has('error'))
                throw Object.assign(new Error('Authorization was denied.'), {
                  code: 'access_denied',
                });
              const code = url.searchParams.get('code');
              if (!code) throw new Error('Authorization code missing.');
              const token = await exchangeToken(
                client,
                {
                  grant_type: 'authorization_code',
                  code,
                  code_verifier: verifier,
                  redirect_uri: REDIRECT_URI,
                },
                controller.signal,
              );
              res
                .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
                .end(AUTH_SUCCESS_HTML, () => resolve(token));
            } catch (error) {
              res
                .writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
                .end(renderAuthError(error));
              if (error.code === 'invalid_client' && !controller.signal.aborted)
                fs.rmSync(CLIENT_FILE, { force: true });
              reject(error);
            }
          });
          server.on('error', () =>
            reject(
              new Error(
                'Cannot open the authentication callback port. Retry after other logins finish.',
              ),
            ),
          );
          server.listen(AUTH_PORT, '127.0.0.1', () => {
            // The Supermemory CLI collects these links to approve several
            // plugins on one consent screen.
            if (printUrl) {
              process.stdout.write(
                `SUPERMEMORY_AUTHORIZE_URL=${authorizationUrl}\n`,
              );
              return;
            }
            openUrl(authorizationUrl).catch(() =>
              reject(
                new Error(
                  `Failed to open the browser. Open this URL to sign in: ${authorizationUrl}`,
                ),
              ),
            );
          });
        });
      } finally {
        clearTimeout(timer);
        controller.abort();
        server?.close();
        server?.closeAllConnections();
      }
    },
    timeoutMs,
    { background, preempt: true },
  );
}

// Hooks are killed at their timeout, so the login runs detached for five
// minutes and the hook only waits briefly for it.
function startBackgroundAuth(config, waitMs = HOOK_WAIT_MS) {
  const child = spawn(
    process.execPath,
    [
      path.join(__dirname, '..', 'auth-server.js'),
      config.apiBaseUrl,
      config.resource,
    ],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const done = (error, token) => {
      clearInterval(timer);
      child.removeAllListeners();
      if (error) reject(error);
      else resolve(token);
    };
    child.on('error', () => done(new Error('AUTH_FAILED')));
    // A newer login stopping this one (a signal) is not a failure.
    child.on('exit', (code, signal) => {
      if (code !== 0 && !signal) done(new Error('AUTH_FAILED'));
    });
    const timer = setInterval(() => {
      const current = loadCredentials();
      if (
        sameConfig(current, config) &&
        current.accessToken &&
        current.expiresAt > Date.now() + REFRESH_SKEW
      ) {
        done(null, current.accessToken);
      } else if (Date.now() - startedAt > waitMs) {
        done(new Error('AUTH_PENDING'));
      }
    }, POLL_MS);
  });
}

module.exports = {
  AUTH_PORT,
  AUTH_WAIT_MS,
  CREDENTIALS_FILE,
  REDIRECT_URI,
  clearCredentials,
  getAccessToken,
  getOAuthConfig,
  hasOAuthCredentials,
  isLoggedOut,
  loadCredentials,
  openUrl,
  saveCredentials,
  settleAuth,
  startAuthFlow,
  startBackgroundAuth,
};
