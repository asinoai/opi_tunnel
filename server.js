// server/server.js - Optimized for Render.com deployment with path-based routing
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
  res.json({
    status: 'ok',
    tunnels: tunnels.size,
    timestamp: new Date().toISOString()
  });
});

// Dashboard endpoint
app.get('/', (req, res) => {
  const host = req.headers.host || process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost';
  const activeTunnels = Array.from(tunnels.entries()).map(([id, tunnel]) => ({
    id: id,
    connected: tunnel.socket.readyState === WebSocket.OPEN,
    url: `https://${host}/t/${id}`
  }));

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Tunnel Proxy Dashboard</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; }
        h1 { color: #333; border-bottom: 2px solid #007cba; padding-bottom: 10px; }
        .tunnel { background: #f8f9fa; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #28a745; }
        .status { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; }
        .connected { background: #d4edda; color: #155724; }
        .disconnected { background: #f8d7da; color: #721c24; }
        .no-tunnels { text-align: center; color: #666; margin: 40px 0; }
        code { background: #f1f1f1; padding: 2px 4px; border-radius: 3px; word-break: break-all; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚇 Tunnel Proxy Dashboard</h1>
        
        ${activeTunnels.length > 0 ?
          `<h2>Active Tunnels (${activeTunnels.length})</h2>
           ${activeTunnels.map(tunnel => `
             <div class="tunnel">
               <strong>Tunnel ID: ${tunnel.id}</strong>
               <span class="status ${tunnel.connected ? 'connected' : 'disconnected'}">
                 ${tunnel.connected ? 'Connected' : 'Disconnected'}
               </span>
               <br><code>${tunnel.url}</code>
             </div>
           `).join('')}` :
          '<div class="no-tunnels">No active tunnels</div>'
        }
        
        <h2>Usage</h2>
        <p>Connect your local client:</p>
        <code>TUNNEL_SERVER=wss://${host} LOCAL_PORT=3000 java -jar your-client.jar</code>
      </div>
    </body>
    </html>
  `);
});

// WebSocket server for tunnel connections
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] New client connected from ${clientIP}, waiting for registration.`);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // The first message from a client MUST be 'register'
      if (data.type === 'register') {
        let tunnelId = data.subdomain; // Get the requested name from the client

        // If no name was provided, generate a random one.
        if (!tunnelId) {
          tunnelId = uuidv4().substring(0, 8);
        }

        // If the requested name is already in use, reject the connection.
        if (tunnels.has(tunnelId)) {
          ws.send(JSON.stringify({ type: 'error', message: `Tunnel name '${tunnelId}' is already in use.` }));
          ws.close();
          return;
        }

        // The name is valid and available, so register the tunnel.
        console.log(`[${new Date().toISOString()}] Registering tunnel: ${tunnelId}`);
        ws.tunnelId = tunnelId; // Attach the ID to the websocket session for cleanup

        tunnels.set(tunnelId, {
          socket: ws,
          createdAt: Date.now(),
          lastActivity: Date.now(),
          pendingResponse: null
        });

        // Send confirmation back to the client
        const host = req.headers.host || process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost';
        const tunnelUrl = `https://${host}/t/${tunnelId}`;
        ws.send(JSON.stringify({
          type: 'registered',
          subdomain: tunnelId,
          url: tunnelUrl,
          tunnelId: tunnelId
        }));
        return; // Registration is complete for this message.
      }

      // Handle 'response' messages from already registered tunnels
      const tunnel = tunnels.get(ws.tunnelId);
      if (data.type === 'response' && tunnel) {
        tunnel.lastActivity = Date.now();
        if (tunnel.pendingResponse) {
          const res = tunnel.pendingResponse;
          // ... (The rest of the response handling logic remains the same)
          try {
            if (data.headers) {
              Object.entries(data.headers).forEach(([key, value]) => {
                if (key.toLowerCase() !== 'content-length') {
                  res.setHeader(key, value);
                }
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
    // If the tunnel was successfully registered, clean it up from the map.
    if (ws.tunnelId && tunnels.has(ws.tunnelId)) {
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

// HTTP request handler for proxying - MODIFIED FOR PATH-BASED ROUTING
app.use('*', (req, res) => {
  console.error('Proxying call:', req.originalUrl);
  // Match requests like /t/tunnel-id/some/path
  const match = req.originalUrl.match(/^\/t\/([a-zA-Z0-9-]+)(\/.*)?$/);

  if (!match) {
    return res.status(404).json({ error: 'Not a valid tunnel URL. Use the format /t/<tunnel-id>/path' });
  }

  const tunnelId = match[1];
  const remainingUrl = match[2] || '/'; // The rest of the path

  const targetTunnel = tunnels.get(tunnelId);

  if (!targetTunnel) {
    return res.status(404).json({
      error: 'Tunnel not found',
      tunnelId: tunnelId,
      availableTunnels: Array.from(tunnels.keys())
    });
  }

  if (targetTunnel.socket.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ error: 'Tunnel not connected' });
  }

  targetTunnel.pendingResponse = res;

  let body = null;
  if (req.body) {
    if (Buffer.isBuffer(req.body)) {
      body = req.body.toString('base64');
    } else if (typeof req.body === 'object') {
      body = JSON.stringify(req.body);
    } else {
      body = req.body;
    }
  }

  const requestData = {
    type: 'request',
    method: req.method,
    url: remainingUrl, // Use the path AFTER the tunnel ID
    headers: req.headers,
    body: body,
    timestamp: Date.now()
  };

  try {
    targetTunnel.socket.send(JSON.stringify(requestData));
  } catch (error) {
    console.error('Error sending request to tunnel:', error);
    delete targetTunnel.pendingResponse;
    return res.status(502).json({ error: 'Failed to forward request' });
  }

  const timeout = setTimeout(() => {
    if (targetTunnel.pendingResponse === res) {
      console.log(`Request timeout for tunnel ${targetTunnel.tunnelId}`);
      if (!res.headersSent) {
          res.status(504).json({ error: 'Gateway timeout' });
      }
      delete targetTunnel.pendingResponse;
    }
  }, 30000);

  res.on('finish', () => {
      clearTimeout(timeout);
      delete targetTunnel.pendingResponse;
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
