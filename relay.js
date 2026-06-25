const http = require('http');
const https = require('https');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { WebSocketServer } = require('ws');

const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(session({
	secret: process.env.SESSION_SECRET || 'relay-session-secret',
	resave: false,
	saveUninitialized: false,
	cookie: { secure: process.env.NODE_ENV === 'production' },
}));
app.use(passport.initialize());
app.use(passport.session());

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleCallbackUrl = process.env.GOOGLE_CALLBACK_URL || `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3001'}/auth/google/callback`;
const allowedEmails = (process.env.GOOGLE_ALLOWED_EMAILS || '')
	.split(',')
	.map((email) => email.trim().toLowerCase())
	.filter(Boolean);
const authEnabled = process.env.AUTH_ENABLED !== 'false' && process.env.AUTH_ENABLED !== '0';
const authConfigured = authEnabled && Boolean(googleClientId && googleClientSecret);

if (authConfigured) {
	passport.use(new GoogleStrategy({
		clientID: googleClientId,
		clientSecret: googleClientSecret,
		callbackURL: googleCallbackUrl,
		scope: ['profile', 'email'],
	}, (_accessToken, _refreshToken, profile, done) => {
		const email = profile.emails?.[0]?.value?.toLowerCase();
		const isAllowed = allowedEmails.length === 0 || allowedEmails.includes(email);
		if (!isAllowed) {
			return done(null, false, { message: 'Email not authorized' });
		}
		return done(null, {
			id: profile.id,
			displayName: profile.displayName,
			email,
		});
	}));
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

function requireAuth(req, res, next) {
	if (!authEnabled) {
		return next();
	}
	if (!authConfigured) {
		res.status(503).type('html').send('<!DOCTYPE html><html><body><h2>Google OAuth not configured</h2><p>Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_ALLOWED_EMAILS before enabling the dashboard.</p></body></html>');
		return;
	}
	if (req.isAuthenticated && req.isAuthenticated()) {
		return next();
	}
	req.session.returnTo = req.originalUrl;
	if (req.accepts('html')) {
		return res.redirect('/auth/login');
	}
	return res.status(401).json({ error: 'Unauthorized' });
}

app.use((req, res, next) => {
	if (req.path === '/' || req.path === '/status') {
		return requireAuth(req, res, next);
	}
	return next();
});

app.get('/auth/login', (req, res) => {
	if (!authEnabled) {
		return res.redirect('/');
	}
	const loginPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ASV relay login</title>
  <style>
    body { font-family: sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
    .card { max-width: 420px; margin: 3rem auto; background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 1.5rem; }
    a { display: inline-block; margin-top: 1rem; padding: .6rem 1rem; background: #2563eb; color: white; text-decoration: none; border-radius: 4px; }
    code { background: #0f172a; padding: .1rem .3rem; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>ASV relay</h2>
    <p>Sign in with your Google account to access the dashboard.</p>
    ${authConfigured ? '<a href="/auth/google">Sign in with Google</a>' : '<p><strong>OAuth is not configured yet.</strong> Set <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>, and <code>GOOGLE_ALLOWED_EMAILS</code>.</p>'}
  </div>
</body>
</html>`;
	res.type('html').send(loginPage);
});

app.get('/auth/google', (req, res, next) => {
	if (!authEnabled || !authConfigured) {
		return res.redirect('/auth/login');
	}
	passport.authenticate('google')(req, res, next);
});

app.get('/auth/google/callback', (req, res, next) => {
	if (!authEnabled) {
		return res.redirect('/');
	}
	passport.authenticate('google', {
		failureRedirect: '/auth/login',
	})(req, res, next);
}, (req, res) => {
	const returnTo = req.session.returnTo || '/';
	delete req.session.returnTo;
	res.redirect(returnTo);
});

app.get('/auth/logout', (req, res, next) => {
	req.logout((err) => {
		if (err) {
			return next(err);
		}
		req.session.destroy(() => {
			res.redirect('/auth/login');
		});
	});
});

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
    .test{margin-top:1rem;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1rem}
    .test .label{font-size:.75rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:.6rem}
    input[type=text]{width:100%;padding:.35rem .6rem;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:4px;font-family:monospace;font-size:.875rem;margin-bottom:.5rem}
    button{padding:.4rem 1rem;cursor:pointer;background:#1d4ed8;color:#fff;border:none;border-radius:4px;font-size:.875rem}
    button:hover{background:#2563eb}
    #testResult{margin-top:.5rem;font-size:.8rem;color:#86efac;min-height:1.2em}
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
  <div class="test">
    <div class="label">Send test message</div>
    <input type="text" id="imeiInput" placeholder="IMEI (default 300000000000001)">
    <button onclick="sendTest()">Send</button>
    <div id="testResult"></div>
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

    let testMomsn = 1;
    async function sendTest() {
      const out = document.getElementById('testResult');
      const imei = document.getElementById('imeiInput').value.trim() || '300000000000001';
      out.textContent = 'Sending…';
      try {
        const body = new URLSearchParams({
          imei, momsn: testMomsn++,
          transmit_time: new Date().toISOString(),
          iridium_latitude: '21.3', iridium_longitude: '-157.8', iridium_cep: '5',
          data: '234539413232343030303030304545303646463430344430454146363830363641303030303030303030303030303030303630464138313134323535424138423830343030303031413030303337453034303030302c302c302a4646',
        });
        const r = await fetch('/webhook', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
        out.textContent = r.ok ? 'OK' : 'HTTP ' + r.status;
        refresh();
      } catch(e) { out.textContent = 'Error: ' + e.message; }
    }
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
