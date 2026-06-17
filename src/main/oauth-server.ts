/**
 * OAuth Callback Server
 * Handles OAuth redirects from providers via localhost HTTP server
 */

import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { parse as parseUrl } from 'url';
import { BrowserWindow } from 'electron';

const OAUTH_PORT = 40021;

// EADDRINUSE is normally another live ACP instance holding the port (the
// single-instance lock in index.ts is the primary defense). Cap the retries
// so we never loop forever: an unbounded silent retry IS the defect (it left
// the installed window's loginWithOAuth awaiting a callback that never came =
// infinite spinner). On exhaustion we surface a real PORT_IN_USE error.
const MAX_EADDRINUSE_RETRIES = 5;

let server: Server | null = null;
let mainWindow: BrowserWindow | null = null;
let addrInUseRetries = 0;

/**
 * HTML page shown after OAuth callback
 */
function getCallbackHtml(success: boolean, message: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>ACP - OAuth</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .container {
      text-align: center;
      padding: 40px;
    }
    .icon {
      font-size: 48px;
      margin-bottom: 20px;
    }
    h1 {
      font-size: 24px;
      margin-bottom: 10px;
    }
    p {
      color: #94a3b8;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">${success ? '✓' : '✗'}</div>
    <h1>${success ? 'Authentication Successful' : 'Authentication Failed'}</h1>
    <p>${message}</p>
    <p>You can close this window and return to the app.</p>
  </div>
  <script>
    // Auto-close after 2 seconds
    setTimeout(() => window.close(), 2000);
  </script>
</body>
</html>
`;
}

/**
 * Handle incoming OAuth callback request
 */
function handleCallback(req: IncomingMessage, res: ServerResponse): void {
  const url = parseUrl(req.url || '', true);

  // Only handle /oauth/callback path
  if (url.pathname !== '/oauth/callback') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const { code, state, error, error_description } = url.query as Record<string, string>;

  if (error) {
    console.error('[OAuth Server] Error from provider:', error, error_description);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getCallbackHtml(false, error_description || error));

    // Notify renderer of error
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('oauth:callback', {
        success: false,
        error: { code: error, message: error_description || error },
      });
    }
    return;
  }

  if (!code || !state) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(getCallbackHtml(false, 'Missing code or state parameter'));
    return;
  }

  console.log('[OAuth Server] Received callback with code');

  // Send success response to browser
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(getCallbackHtml(true, 'Completing sign-in...'));

  // Notify renderer to complete OAuth flow
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('oauth:callback', {
      success: true,
      code,
      state,
    });

    // Bring app to front
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
}

/**
 * Start the OAuth callback server
 */
export function startOAuthServer(window: BrowserWindow): void {
  if (server) {
    console.log('[OAuth Server] Already running');
    mainWindow = window;
    return;
  }

  mainWindow = window;

  server = createServer((req, res) => {
    try {
      handleCallback(req, res);
    } catch (err) {
      console.error('[OAuth Server] Error handling request:', err);
      res.writeHead(500);
      res.end('Internal error');
    }
  });

  server.listen(OAUTH_PORT, '127.0.0.1', () => {
    addrInUseRetries = 0; // clean bind — reset the retry budget
    console.log(`[OAuth Server] Listening on http://localhost:${OAUTH_PORT}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      if (addrInUseRetries >= MAX_EADDRINUSE_RETRIES) {
        // Exhausted: another ACP instance owns the port. STOP retrying and
        // surface a real error so the renderer's awaited OAuth callback
        // rejects with PORT_IN_USE instead of hanging forever (no-silent-
        // fallback rule). The single-instance lock should prevent this from
        // ever being reached; this is the backstop that fails loud.
        console.error(`[OAuth Server] Port ${OAUTH_PORT} still in use after ${MAX_EADDRINUSE_RETRIES} retries — another ACP instance owns it. Halting and surfacing PORT_IN_USE.`);
        server?.close();
        server = null;
        addrInUseRetries = 0;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('oauth:callback', {
            success: false,
            error: {
              code: 'PORT_IN_USE',
              message: `OAuth callback port ${OAUTH_PORT} is held by another running ACP instance. Close the other instance and try signing in again.`,
            },
          });
        }
        return;
      }
      addrInUseRetries++;
      console.warn(`[OAuth Server] Port ${OAUTH_PORT} in use, retry ${addrInUseRetries}/${MAX_EADDRINUSE_RETRIES}...`);
      setTimeout(() => {
        server?.close();
        server = null;
        startOAuthServer(window);
      }, 1000);
    } else {
      console.error('[OAuth Server] Error:', err);
    }
  });
}

/**
 * Stop the OAuth callback server
 */
export function stopOAuthServer(): void {
  if (server) {
    server.close();
    server = null;
    console.log('[OAuth Server] Stopped');
  }
}

export { OAUTH_PORT };
