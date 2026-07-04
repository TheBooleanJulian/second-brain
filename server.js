require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const fs = require('fs');

const {
  DATABASE_URL,
  JWT_SECRET,
  ANTHROPIC_API_KEY,
  PORT = 3000
} = process.env;

if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!JWT_SECRET) throw new Error('JWT_SECRET is required');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

const DOMAINS = {
  origins:   { name: 'Origins',    desc: 'Background, upbringing, formative places and people.' },
  values:    { name: 'Values',     desc: 'Core beliefs and the principles you actually live by.' },
  mind:      { name: 'Mind',       desc: 'How you think, reason, and process the world.' },
  craft:     { name: 'Craft',      desc: 'Your work, skills, and what mastery means to you.' },
  people:    { name: 'People',     desc: 'Relationships — who matters, and why.' },
  rhythms:   { name: 'Rhythms',    desc: 'Habits, daily patterns, energy — how you actually spend a day.' },
  taste:     { name: 'Taste',      desc: 'Aesthetics and preference — what draws you in.' },
  shadows:   { name: 'Shadows',    desc: 'Fears, struggles, and blind spots.' },
  direction: { name: 'Direction',  desc: "Goals, ambitions, and the future you're building toward." },
  meaning:   { name: 'Meaning',    desc: 'Worldview and what makes life feel worthwhile.' }
};

async function initDb() {
  const sql = fs.readFileSync(path.join(__dirname, 'db', 'init.sql'), 'utf8');
  await pool.query(sql);
}

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const COOKIE_NAME = 'sb_session';
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 30 * 24 * 60 * 60 * 1000
};

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.userId = jwt.verify(token, JWT_SECRET).userId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid session' });
  }
}

function defaultState() {
  const domains = {};
  Object.keys(DOMAINS).forEach(id => {
    domains[id] = { distilled: [], depth: 0, messages: [], saturated: false };
  });
  return { domains, createdAt: new Date().toISOString() };
}

app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Email and a password of at least 8 characters are required' });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email.toLowerCase().trim(), passwordHash]
    );
    const userId = result.rows[0].id;
    await pool.query('INSERT INTO profiles (user_id, state) VALUES ($1, $2)', [userId, defaultState()]);
    const token = jwt.sign({ userId }, JWT_SECRET);
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.json({ email });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'An account with that email already exists' });
    console.error(e);
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  try {
    const result = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign({ userId: user.id }, JWT_SECRET);
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.json({ email });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, COOKIE_OPTS);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT email FROM users WHERE id = $1', [req.userId]);
  if (!result.rows[0]) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ email: result.rows[0].email });
});

app.get('/api/state', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT state FROM profiles WHERE user_id = $1', [req.userId]);
  res.json(result.rows[0] ? result.rows[0].state : defaultState());
});

app.put('/api/state', requireAuth, async (req, res) => {
  const state = req.body;
  if (!state || typeof state !== 'object') return res.status(400).json({ error: 'Invalid state' });
  await pool.query(
    `INSERT INTO profiles (user_id, state, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET state = $2, updated_at = now()`,
    [req.userId, state]
  );
  res.json({ ok: true });
});

app.post('/api/interview', requireAuth, async (req, res) => {
  const { domainId, messages } = req.body || {};
  const domain = DOMAINS[domainId];
  if (!domain || !Array.isArray(messages)) return res.status(400).json({ error: 'Invalid request' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Interview engine is not configured' });

  const systemPrompt = `You are conducting a warm, perceptive interview about the user's "${domain.name}" (${domain.desc}) as part of building their personal second-brain document. This is one of ten life domains being explored.

Given the conversation so far, respond with ONLY a raw JSON object, no markdown fences, no preamble, matching exactly this shape:
{"distilled": ["concise third-person statement of new, concrete information or insight from the user's last answer", "..."], "reply": "one brief warm acknowledgment (max 1 sentence) plus exactly one thoughtful follow-up question that goes deeper into this domain or opens a new facet of it", "depth_increment": <integer 1-3, how substantive the new information was>, "domain_saturated": <boolean, true only if this domain has been thoroughly explored across many exchanges>}

Rules for "distilled": only include genuinely new facts, values, patterns, or self-insight — not restatements of the question. Write each as a flat, dense, standalone statement suitable for a personal reference document (e.g. "Grew up in a household where..." or "Believes that..."). If the answer contained no new substantive information, return an empty array. Never invent details the user didn't say.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: systemPrompt,
        messages
      })
    });
    const data = await response.json();
    const textBlocks = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    const clean = textBlocks.replace(/```json|```/g, '').trim();
    const jsonStart = clean.indexOf('{');
    const jsonEnd = clean.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
      throw new Error('No JSON object found in model response');
    }
    const parsed = JSON.parse(clean.slice(jsonStart, jsonEnd + 1));
    res.json(parsed);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Interview engine failed' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'second-brain.html'));
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Second Brain listening on :${PORT}`));
  })
  .catch(e => {
    console.error('Failed to initialize database', e);
    process.exit(1);
  });
