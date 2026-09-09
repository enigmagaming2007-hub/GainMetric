/* ============================================================
   GainMetric — Express Backend
   Auth (bcrypt + JWT), Cloudflare Turnstile, Trial System
   ============================================================ */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_dev_secret';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '0x4AAAAAAEtpxyu8YDxhWbIz8hjlDd12iyc';
const TRIAL_DAYS = 10;
const SALT_ROUNDS = 10;
const DB_PATH = path.join(__dirname, 'data', 'gainmetric.db');

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_TZsww2nVEvct8I';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'CVu2Vrm5uOpjfCBXu8fujSoA';

// ——— Middleware ———
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ——— Database ———
let db;

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

async function initDb() {
  const SQL = await initSqlJs();

  // Ensure data directory exists
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Load existing DB or create new
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_paid INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  saveDb();
}

// ——— Helpers ———

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

async function verifyTurnstile(token, ip) {
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: TURNSTILE_SECRET,
        response: token,
        remoteip: ip || ''
      })
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error('Turnstile verification error:', err);
    return false;
  }
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function getTrialStatus(user) {
  const createdAt = new Date(user.created_at + 'Z');
  const now = new Date();
  const diffMs = now - createdAt;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const daysRemaining = Math.max(0, TRIAL_DAYS - diffDays);
  const trialActive = daysRemaining > 0;

  return {
    trialActive: trialActive || user.is_paid === 1,
    daysRemaining,
    isPaid: user.is_paid === 1,
    trialExpired: !trialActive && user.is_paid !== 1
  };
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ——— Auth Routes ———

// Sign Up
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password, turnstileToken } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Verify Turnstile
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const turnstileOk = await verifyTurnstile(turnstileToken, ip);
    if (!turnstileOk) {
      return res.status(403).json({ error: 'Bot verification failed. Please try again.' });
    }

    // Check if user exists
    const existing = dbGet('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Hash password and create user
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    dbRun(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [name || 'Lifter', email, passwordHash]
    );

    const user = dbGet('SELECT * FROM users WHERE email = ?', [email]);
    const token = generateToken(user);
    const trial = getTrialStatus(user);

    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
      trial
    });
  } catch (err) {
    console.error('Signup error:', err);
    if (err.message && err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Sign In
app.post('/api/auth/signin', async (req, res) => {
  try {
    const { email, password, turnstileToken } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Verify Turnstile
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const turnstileOk = await verifyTurnstile(turnstileToken, ip);
    if (!turnstileOk) {
      return res.status(403).json({ error: 'Bot verification failed. Please try again.' });
    }

    // Find user
    const user = dbGet('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = generateToken(user);
    const trial = getTrialStatus(user);

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
      trial
    });
  } catch (err) {
    console.error('Signin error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current user + trial status
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const trial = getTrialStatus(user);
  res.json({
    user: { id: user.id, name: user.name, email: user.email },
    trial
  });
});

// ——— Payment Routes (Razorpay) ———
const crypto = require('crypto');

// 1. Create Order
app.post('/api/payment/razorpay/create-order', authMiddleware, async (req, res) => {
  try {
    const amount = 2000; // ₹20.00 in paise
    const txnid = 'GM_' + Date.now() + '_' + req.user.id;
    
    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}` 
      },
      body: JSON.stringify({
        amount: amount,
        currency: 'INR',
        receipt: txnid
      })
    });
    
    const data = await response.json();
    if (response.ok) {
      res.json({ order_id: data.id, amount, currency: 'INR', key: RAZORPAY_KEY_ID });
    } else {
      console.error('Razorpay Error:', data);
      res.status(400).json({ error: data.error.description || 'Failed to create order' });
    }
  } catch (err) {
    console.error('Razorpay creation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Verify Payment
app.post('/api/payment/razorpay/verify', authMiddleware, async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
    
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment details' });
    }

    const hmac = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET);
    hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
    const generated_signature = hmac.digest('hex');
    
    if (generated_signature === razorpay_signature) {
      // Valid payment
      dbRun('UPDATE users SET is_paid = 1 WHERE id = ?', [req.user.id]);
      res.json({ success: true, message: 'Payment verified' });
    } else {
      res.status(400).json({ error: 'Payment signature mismatch' });
    }
  } catch (err) {
    console.error('Razorpay verification error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ——— Catch-all: serve index.html for SPA ———
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ——— Start ———
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`\n  🏋️  GainMetric server running at http://localhost:${PORT}\n`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
