// server/server.js - Final version
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// Store active tunnels
const tunnels = new Map();

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.raw({ limit: '10mb', type: 'application/octet-stream' }));

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', tunnels: tunnels.size });
});

// Dashboard endpoint
app.get('/', (req, res) => {
  const host = req.headers.host || process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost';
  const activeTunnels = Array.from(tunnels.keys()).map(id => ({
    id: id,
    url: `https://${host}/t/${id}`
  }));
  res.send(`<h1>Active Tunnels:</h1><ul>${activeTunnels.map(t => `<li><code>${t.url}</code></li>`).join('') || '<li>None</li>'}</ul>`);
});

// WebSocket server for tunnel connections
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] New client connected from ${clientIP}, waiting for registration.`);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const tunnelId = ws.tunnelId; // Get ID from the websocket session

      // Handle 'register' message
      if (data.type === 'register') {
        let requestedId = data.subdomain;
        if (!requestedId) {
          requestedId = uuidv4().substring(0, 8);
        }
        if (tunnels.has(requestedId)) {
          ws.send(JSON.stringify({ type: 'error', message: `Tunnel name '${requestedId}' is already in use.` }));
          ws.close();
          return;
        }

        console.log(`[${new Date().toISOString()}] Registering tunnel: ${requestedId}`);
        ws.tunnelId = requestedId;
        tunnels.set(requestedId, { socket: ws, createdAt: Date.now(), lastActivity: Date.now() });

        const host = req.headers.host || process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost';
        const tunnelUrl = `https://${host}/t/${requestedId}`;
        ws.send(JSON.stringify({ type: 'registered', subdomain: requestedId, url: tunnelUrl, tunnelId: requestedId }));
        return;
      }

      // Handle 'response' messages from an already registered tunnel
      const tunnel = tunnels.get(tunnelId);
      if (data.type === 'response' && tunnel) {
        tunnel.lastActivity = Date.now();
        if (tunnel.pendingResponse) {
          const res = tunnel.pendingResponse;
          try {
            if (data.headers) {
              Object.entries(data.headers).forEach(([key, value]) => {
                if (key.toLowerCase() !== 'content-length') { res.setHeader(key, value); }
              });
            }
            res.status(data.statusCode || 200);
            if (data.body) {
              res.send(typeof data.body === 'string' ? data.body : JSON.stringify(data.body));
            } else {
              res.end();
            }
          } catch (error) {
            console.error('Error sending response:', error);
            if (!res.headersSent) { res.status(500).json({ error: 'Response handling error' }); }
          }
          delete tunnel.pendingResponse;
        }
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    if (ws.tunnelId) {
      console.log(`[${new Date().toISOString()}] Tunnel disconnected: ${ws.tunnelId}`);
      tunnels.delete(ws.tunnelId);
    } else {
      console.log(`[${new Date().toISOString()}] Unregistered client disconnected.`);
    }
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for tunnel ${ws.tunnelId || 'unregistered'}:`, error);
  });
});

// HTTP request handler for proxying
app.use('*', (req, res) => {
  console.error('Proxying call:', req.originalUrl);
  const match = req.originalUrl.match(/^\/t\/([^/]+)(\/.*)?$/);
  if (!match) {
    return res.status(404).json({ error: 'URL must start with /t/<tunnel-id>/' });
  }

  const tunnelId = match[1];
  const remainingUrl = match[2] || '/';
  const targetTunnel = tunnels.get(tunnelId);

  if (!targetTunnel) {
    return res.status(404).json({ error: 'Tunnel not found', tunnelId: tunnelId });
  }

  targetTunnel.pendingResponse = res;
  targetTunnel.socket.send(JSON.stringify({
    type: 'request',
    method: req.method,
    url: remainingUrl,
    headers: req.headers,
    body: Buffer.isBuffer(req.body) ? req.body.toString('base64') : req.body,
  }));

  const timeout = setTimeout(() => {
    if (targetTunnel.pendingResponse) {
      console.log(`Request timeout for tunnel ${tunnelId}`);
      if (!res.headersSent) {
        res.status(504).json({ error: 'Gateway timeout' });
      }
      delete targetTunnel.pendingResponse;
    }
  }, 30000);

  res.on('finish', () => {
      clearTimeout(timeout);
      //delete targetTunnel.pendingResponse;
  });
});


// Cleanup inactive tunnels
setInterval(() => {
  const now = Date.now();
  const inactiveThreshold = 5 * 60 * 1000; // 5 minutes

  for (const [tunnelId, tunnel] of tunnels) {
    if (now - tunnel.lastActivity > inactiveThreshold) {
      console.log(`Cleaning up inactive tunnel: ${tunnelId}`);
      tunnel.socket.terminate();
      tunnels.delete(tunnelId);
    }
  }
}, 60000); // Check every minute

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Tunnel proxy server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
