# Custom Tunnel Proxy

A self-hosted alternative to ngrok for creating secure tunnels to localhost.

## Quick Start

### 1. Deploy Server to Render
1. Fork this repository
2. Connect your GitHub repo to Render
3. Deploy the server from the `/server` directory
4. Note your Render app URL (e.g., `https://your-app.onrender.com`)

### 2. Run Client Locally
```bash
cd client
npm install
TUNNEL_SERVER=wss://your-app.onrender.com LOCAL_PORT=3000 npm start
