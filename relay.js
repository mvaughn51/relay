const http = require('http');
const https = require('https');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

const clients = new Set();

const stats = {
	startTime:    Date.now(),
	messageCount: 0,
	lastMessage:  null,
};

wss.on('connection', (ws) => {
	ws.isAlive = true;
	ws.on('pong', () => { ws.isAlive = true; });
	clients.add(ws);
	ws.on('close', () => clients.delete(ws));
	ws.on('error', () => clients.delete(ws));
	console.log(`[ws] client connected (${clients.size} total)`);
});

// Terminate zombie connections every 30 s so dead clients don't accumulate
const heartbeatInterval = setInterval(() => {
	wss.clients.forEach((ws) => {
		if (!ws.isAlive) {
			clients.delete(ws);
			return ws.terminate();
		}
		ws.isAlive = false;
		ws.ping();
	});
}, 30000);

server.on('close', () => clearInterval(heartbeatInterval));

app.post('/webhook', (req, res) => {
	const { imei, momsn, transmit_time, iridium_latitude, iridium_longitude, iridium_cep, data } = req.body;
	const payload = JSON.stringify({
		imei,
		momsn: Number(momsn),
		transmit_time,
		iridium_latitude: Number(iridium_latitude),
		iridium_longitude: Number(iridium_longitude),
		iridium_cep: Number(iridium_cep),
		data,
	});
	stats.messageCount++;
	stats.lastMessage = { time: new Date().toISOString(), imei, momsn: Number(momsn) };

	let pushed = 0;
	for (const client of clients) {
		if (client.readyState === 1) { client.send(payload); pushed++; }
	}
	console.log(`[webhook] MO from ${imei} → pushed to ${pushed} client(s): ${data}`);
	res.sendStatus(200);
});

app.get('/ping', (_req, res) => res.sendStatus(200));

app.get('/status', (_req, res) => {
	const uptimeSec = Math.floor((Date.now() - stats.startTime) / 1000);
	const h = Math.floor(uptimeSec / 3600);
	const m = Math.floor((uptimeSec % 3600) / 60);
	const s = uptimeSec % 60;
	const uptime = h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
	res.json({
		uptime,
		clients:      clients.size,
		messageCount: stats.messageCount,
		lastMessage:  stats.lastMessage,
	});
});

app.get('/', (_req, res) => res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ASV relay</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:monospace;background:#0f172a;color:#e2e8f0;padding:2rem}
    h2{color:#7dd3fc;margin-bottom:1.5rem;font-size:1.2rem;letter-spacing:.05em}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1rem;margin-bottom:1.5rem}
    .card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1rem}
    .card .label{font-size:.75rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:.4rem}
    .card .value{font-size:1.4rem;font-weight:700;color:#f1f5f9}
    .card .value.connected{color:#4ade80}
    .last{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1rem}
    .last .label{font-size:.75rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:.6rem}
    .last table{width:100%;border-collapse:collapse;font-size:.85rem}
    .last td{padding:3px 8px 3px 0;color:#cbd5e1}
    .last td:first-child{color:#94a3b8;width:80px}
    .none{color:#475569;font-style:italic;font-size:.85rem}
    .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#4ade80;margin-right:6px;animation:pulse 2s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  </style>
</head>
<body>
  <h2><span class="dot"></span>ASV relay</h2>
  <div class="grid">
    <div class="card"><div class="label">Uptime</div><div class="value" id="uptime">—</div></div>
    <div class="card"><div class="label">WS Clients</div><div class="value" id="clients">—</div></div>
    <div class="card"><div class="label">Messages Relayed</div><div class="value" id="count">—</div></div>
  </div>
  <div class="last">
    <div class="label">Last Message</div>
    <div id="last"><span class="none">none yet</span></div>
  </div>
  <script>
    async function refresh() {
      try {
        const s = await fetch('/status').then(r => r.json());
        document.getElementById('uptime').textContent  = s.uptime;
        const c = document.getElementById('clients');
        c.textContent  = s.clients;
        c.className    = 'value' + (s.clients > 0 ? ' connected' : '');
        document.getElementById('count').textContent   = s.messageCount;
        const lm = s.lastMessage;
        document.getElementById('last').innerHTML = lm
          ? '<table><tr><td>Time</td><td>' + lm.time + '</td></tr>' +
            '<tr><td>IMEI</td><td>' + lm.imei + '</td></tr>' +
            '<tr><td>MOMSN</td><td>' + lm.momsn + '</td></tr></table>'
          : '<span class="none">none yet</span>';
      } catch(e) {}
    }
    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
	console.log(`Relay listening on port ${PORT}`);

	const selfUrl = process.env.RENDER_EXTERNAL_URL;
	if (selfUrl) {
		const INTERVAL_MS = 14 * 60 * 1000;
		setInterval(() => {
			https.get(`${selfUrl}/ping`, (res) => {
				console.log(`[keepalive] ping → ${res.statusCode}`);
				res.resume();
			}).on('error', (err) => console.error('[keepalive] error:', err.message));
		}, INTERVAL_MS);
		console.log(`[keepalive] pinging ${selfUrl}/ping every 14 min`);
	}
});
