const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const STATUS_FILE = path.join(__dirname, 'status.json');
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const PORT = 3000;

// Weather — Three Rivers MI (49093)
const WEATHER_LAT = 41.9434, WEATHER_LON = -85.6327;
const WMO_ICON = {
  0:'☀️',1:'🌤',2:'⛅',3:'☁️',
  45:'🌫',48:'🌫',
  51:'🌦',53:'🌦',55:'🌧',
  61:'🌧',63:'🌧',65:'🌧',
  71:'🌨',73:'🌨',75:'❄️',
  80:'🌦',81:'🌧',82:'⛈',
  95:'⛈',96:'⛈',99:'⛈'
};
let weatherCache = null;

async function fetchWeather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto`;
    const r = await fetch(url);
    const d = await r.json();
    weatherCache = {
      temp: Math.round(d.current.temperature_2m),
      icon: WMO_ICON[d.current.weather_code] || '🌡️'
    };
    console.log(`[weather] ${weatherCache.icon} ${weatherCache.temp}°F`);
  } catch (e) {
    console.log('[weather] fetch failed:', e.message);
  }
}

fetchWeather();
setInterval(fetchWeather, 10 * 60 * 1000);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); }
  catch { return { type: 'idle', message: '', timestamp: null }; }
}

function writeStatus(data) {
  const status = { ...readStatus(), ...data, timestamp: new Date().toISOString() };
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  return status;
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// Extract the latest meaningful assistant block from a JSONL transcript file
function getLatestAssistantBlock(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (!obj.message || obj.message.role !== 'assistant') continue;
        const blocks = obj.message.content;
        if (!Array.isArray(blocks) || !blocks.length) continue;
        for (const block of blocks) {
          if (block.type === 'thinking') return { type: 'thinking' };
          if (block.type === 'tool_use') return { type: 'tool_use', name: block.name };
          if (block.type === 'text' && block.text && block.text.trim())
            return { type: 'text', text: block.text.trim() };
        }
      } catch {}
    }
  } catch {}
  return null;
}

// Watch all JSONL transcripts under ~/.claude/projects/
// Debounce per-file so rapid writes don't spam
const debounceTimers = {};

function onTranscriptChange(filePath) {
  if (debounceTimers[filePath]) clearTimeout(debounceTimers[filePath]);
  debounceTimers[filePath] = setTimeout(() => {
    const block = getLatestAssistantBlock(filePath);
    if (!block) return;

    const current = readStatus();

    if (block.type === 'thinking') {
      if (current.type === 'thinking') return;
      const status = writeStatus({ type: 'thinking', message: 'Thinking...' });
      broadcast(status);
      console.log('[overlay] Thinking...');
    } else if (block.type === 'tool_use') {
      const msg = `Using ${block.name}...`;
      if (current.type === 'working' && current.message === msg) return;
      const status = writeStatus({ type: 'working', message: msg });
      broadcast(status);
      console.log(`[overlay] ${msg}`);
    } else if (block.type === 'text') {
      const isQuestion = /\?\s*$/.test(block.text);
      if (isQuestion) {
        const trimmed = block.text.length > 350 ? block.text.slice(0, 347) + '...' : block.text;
        if (current.type === 'question' && current.message === trimmed) return;
        const status = writeStatus({ type: 'question', message: trimmed });
        broadcast(status);
        console.log(`[overlay] Question: ${trimmed.slice(0, 80)}`);
      } else {
        if (current.type === 'idle') return;
        const status = writeStatus({ type: 'idle', message: '' });
        broadcast(status);
        console.log('[overlay] Cleared');
      }
    }
  }, 300);
}

if (fs.existsSync(CLAUDE_PROJECTS)) {
  chokidar.watch(path.join(CLAUDE_PROJECTS, '**', '*.jsonl'), {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
  }).on('change', onTranscriptChange);
  console.log(`Watching transcripts in ${CLAUDE_PROJECTS}`);
} else {
  console.log(`Warning: ${CLAUDE_PROJECTS} not found — transcript watching disabled`);
}

// Random chatter messages
const CHAT_MESSAGES = [
  "Are you still coding?",
  "Don't forget to blink.",
  "Have you tried turning it off and on again?",
  "Coffee break? You've earned it.",
  "Still here. Just watching.",
  "How's the bug hunt going?",
  "You've been at this a while...",
  "Remember to save your work!",
  "Is it working yet?",
  "Rubber duck debugging time?",
  "Stack Overflow to the rescue?",
  "Git commit before you forget.",
  "Any console errors I should know about?",
  "Need me to explain that error?",
  "You look like you need a snack.",
  "What are we building today?",
  "I believe in you. Mostly.",
  "Have you checked the logs?",
  "That variable name looks... creative.",
  "One more feature won't hurt. Right?",
];

let lastChatIndex = -1;

function fireChat() {
  const current = readStatus();
  if (current.type !== 'idle') {
    scheduleChat();
    return;
  }
  let idx;
  do { idx = Math.floor(Math.random() * CHAT_MESSAGES.length); } while (idx === lastChatIndex);
  lastChatIndex = idx;
  const msg = CHAT_MESSAGES[idx];
  const status = writeStatus({ type: 'chat', message: msg });
  broadcast(status);
  console.log(`[overlay] Chat: ${msg}`);
  setTimeout(() => {
    if (readStatus().type === 'chat') {
      const s = writeStatus({ type: 'idle', message: '' });
      broadcast(s);
    }
  }, 9000);
  scheduleChat();
}

function scheduleChat() {
  const delay = (8 + Math.random() * 7) * 60 * 1000; // 8–15 min
  setTimeout(fireChat, delay);
}

scheduleChat();

// REST endpoints (manual control / fallback)
app.get('/api/weather', (req, res) => res.json(weatherCache || {}));

app.get('/api/status', (req, res) => res.json(readStatus()));

app.post('/api/update', (req, res) => {
  const { message, type = 'waiting' } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const status = writeStatus({ message, type });
  broadcast(status);
  res.json(status);
});

app.post('/api/idle', (req, res) => {
  const status = writeStatus({ type: 'idle', message: '' });
  broadcast(status);
  res.json(status);
});

// Watch status.json for direct external writes
chokidar.watch(STATUS_FILE, { ignoreInitial: true }).on('change', () => {
  broadcast(readStatus());
});

wss.on('connection', ws => ws.send(JSON.stringify(readStatus())));

server.listen(PORT, () => {
  console.log(`Claude OBS Overlay running at http://localhost:${PORT}`);
});
