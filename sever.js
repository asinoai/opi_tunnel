// server/server.js - Optimized for Render.com deployment
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

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
  const activeTunnels = Array.from(tunnels.entries()).map(([id, tunnel]) => ({
    id: id.substring(0, 8),
    subdomain: tunnel.subdomain,
    connected: tunnel.socket.readyState === WebSocket.OPEN,
    url: tunnel.subdomain ? `https://${tunnel.subdomain}.${req.get('host')}` : null
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
        code { background: #f1f1f1; padding: 2px 4px; border-radius: 3px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚇 Tunnel Proxy Dashboard</h1>
        <p>Server running on <strong>${req.get('host')}</strong></p>
        
        ${activeTunnels.length > 0 ? 
          `<h2>Active Tunnels (${activeTunnels.length})</h2>
           ${activeTunnels.map(tunnel => `
             <div class="tunnel">
               <strong>${tunnel.subdomain || tunnel.id}</strong>
               <span class="status ${tunnel.connected ? 'connected' : 'disconnected'}">
                 ${tunnel.connected ? 'Connected' : 'Disconnected'}
               </span>
               ${tunnel.url ? `<br><code>${tunnel.url}</code>` : ''}
             </div>
           `).join('')}` :
          '<div class="no-tunnels">No active tunnels</div>'
        }
        
        <h2>Usage</h2>
        <p>Connect your local client:</p>
        <code>TUNNEL_SERVER=wss://${req.get('host')} LOCAL_PORT=3000 node client.js</code>
      </div>
    </body>
    </html>
  `);
});

// WebSocket server for tunnel connections
const wss = new WebSocket.Server({ 
  server,
  verifyClient: (info) => {
    // Basic verification - you can add authentication here
    return true;
  }
});

wss.on('connection', (ws, req) => {
  const tunnelId = uuidv4();
  const clientIP = req.socket.remoteAddress;
  
  console.log(`[${new Date().toISOString()}] New tunnel connection: ${tunnelId} from ${clientIP}`);
  
  tunnels.set(tunnelId, {
    socket: ws,
    subdomain: null,
    createdAt: Date.now(),
    lastActivity: Date.now()
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const tunnel = tunnels.get(tunnelId);
      
      if (!tunnel) return;
      
      tunnel.lastActivity = Date.now();
      
      if (data.type === 'register') {
        // Generate subdomain - use provided or create random
        let subdomain = data.subdomain;
        if (!subdomain) {
          subdomain = tunnelId.substring(0, 8);
        }
        
        // Check if subdomain is already taken
        const existingTunnel = Array.from(tunnels.values()).find(t => t.subdomain === subdomain);
        if (existingTunnel && existingTunnel.socket !== ws) {
          subdomain = `${subdomain}-${Date.now().toString(36)}`;
        }
        
        tunnel.subdomain = subdomain;
        
        const tunnelUrl = `https://${subdomain}.${req.get('host') || 'localhost'}`;
        
        ws.send(JSON.stringify({
          type: 'registered',
          subdomain: subdomain,
          url: tunnelUrl,
          tunnelId: tunnelId
        }));
        
        console.log(`[${new Date().toISOString()}] Tunnel registered: ${subdomain} -> ${tunnelId}`);
      }
      
      if (data.type === 'response') {
        // Forward response back to the original HTTP request
        if (tunnel.pendingResponse) {
          const res = tunnel.pendingResponse;
          
          try {
            // Set headers
            if (data.headers) {
              Object.entries(data.headers).forEach(([key, value]) => {
                if (key.toLowerCase() !== 'content-length') {
                  res.setHeader(key, value);
                }
              });
            }
            
            // Send response
            res.status(data.statusCode || 200);
            
            if (data.body) {
              if (typeof data.body === 'string') {
                res.send(data.body);
              } else {
                res.json(data.body);
              }
            } else {
              res.end();
            }
          } catch (error) {
            console.error('Error sending response:', error);
            if (!res.headersSent) {
              res.status(500).json({ error: 'Response handling error' });
            }
          }
          
          delete tunnel.pendingResponse;
        }
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    console.log(`[${new Date().toISOString()}] Tunnel disconnected: ${tunnelId}`);
    tunnels.delete(tunnelId);
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for tunnel ${tunnelId}:`, error);
  });
});

// HTTP request handler for proxying
app.use('*', (req, res) => {
  const host = req.get('host');
  const subdomain = host.split('.')[0];
  
  // Skip if it's the main domain (dashboard)
  if (subdomain === host.replace(/:\d+$/, '')) {
    return res.status(404).json({ error: 'Not found' });
  }
  
  // Find tunnel by subdomain
  let targetTunnel = null;
  for (const [tunnelId, tunnel] of tunnels) {
    if (tunnel.subdomain === subdomain) {
      targetTunnel = { tunnelId, ...tunnel };
      break;
    }
  }
  
  if (!targetTunnel) {
    return res.status(404).json({ 
      error: 'Tunnel not found',
      subdomain: subdomain,
      availableTunnels: Array.from(tunnels.values()).map(t => t.subdomain).filter(Boolean)
    });
  }
  
  if (targetTunnel.socket.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ error: 'Tunnel not connected' });
  }
  
  // Store the response object to send back later
  targetTunnel.pendingResponse = res;
  
  // Prepare request body
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
  
  // Forward request to tunnel client
  const requestData = {
    type: 'request',
    method: req.method,
    url: req.url,
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
  
  // Set timeout for response
  const timeout = setTimeout(() => {
    if (targetTunnel.pendingResponse === res) {
      console.log(`Request timeout for tunnel ${targetTunnel.tunnelId}`);
      res.status(504).json({ error: 'Gateway timeout' });
      delete targetTunnel.pendingResponse;
    }
  }, 30000); // 30 second timeout
  
  // Clear timeout when response is sent
  const originalEnd = res.end;
  res.end = function(...args) {
    clearTimeout(timeout);
    return originalEnd.apply(this, args);
  };
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
  console.log(`Dashboard: http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
