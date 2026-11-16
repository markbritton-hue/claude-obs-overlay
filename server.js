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

// Extract last assistant text block from a JSONL transcript file
function getLastAssistantText(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (!obj.message || obj.message.role !== 'assistant') continue;
        const content = obj.message.content;
        if (!Array.isArray(content)) continue;
        const textBlocks = content.filter(b => b.type === 'text' && b.text && b.text.trim());
        if (textBlocks.length) return textBlocks[textBlocks.length - 1].text.trim();
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
    const text = getLastAssistantText(filePath);
    if (!text) return;

    const isQuestion = /\?\s*$/.test(text);
    const current = readStatus();

    if (isQuestion) {
      const trimmed = text.length > 350 ? text.slice(0, 347) + '...' : text;
      // Don't re-push the same question
      if (current.type === 'question' && current.message === trimmed) return;
      const status = writeStatus({ type: 'question', message: trimmed });
      broadcast(status);
      console.log(`[overlay] Question: ${trimmed.slice(0, 80)}`);
    } else if (current.type === 'question') {
      // Last message was a question, now it's not — Claude answered itself or moved on
      // Keep showing the question until a non-question assistant message comes in
      // Actually clear it so the overlay doesn't show stale questions
      const status = writeStatus({ type: 'idle', message: '' });
      broadcast(status);
      console.log('[overlay] Cleared (non-question response)');
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

// REST endpoints (manual control / fallback)
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
