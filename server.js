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

const EASEBUZZ_KEY = process.env.EASEBUZZ_KEY || '2PBP7IABZ2';
const EASEBUZZ_SALT = process.env.EASEBUZZ_SALT || 'DAH88E3UWQ';
const EASEBUZZ_ENV = process.env.EASEBUZZ_ENV || 'test';
const EASEBUZZ_URL = EASEBUZZ_ENV === 'prod' ? 'https://pay.easebuzz.in' : 'https://testpay.easebuzz.in';

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

// ——— Payment Routes (Easebuzz) ———

// 1. Initiate Payment
app.post('/api/payment/easebuzz/initiate', authMiddleware, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const txnid = 'GM_' + Date.now() + '_' + req.user.id;
    const amount = '20.0';
    const productinfo = 'GainMetric Lifetime Access';
    const firstname = req.user.name || 'User';
    const email = req.user.email;

    // Generate Hash
    // Sequence: key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5|udf6|udf7|udf8|udf9|udf10|salt
    const hashString = [
      EASEBUZZ_KEY, txnid, amount, productinfo, firstname, email,
      '', '', '', '', '', '', '', '', '', '', // udf1 - udf10
      EASEBUZZ_SALT
    ].join('|');

    const hash = crypto.createHash('sha512').update(hashString).digest('hex');

    // SURL/FURL (will redirect back to our frontend callback)
    const surl = `http://localhost:${PORT}/api/payment/easebuzz/success`;
    const furl = `http://localhost:${PORT}/api/payment/easebuzz/failure`;

    // Make request to Easebuzz
    const params = new URLSearchParams({
      key: EASEBUZZ_KEY,
      txnid,
      amount,
      productinfo,
      firstname,
      phone,
      email,
      surl,
      furl,
      hash
    });

    const response = await fetch(`${EASEBUZZ_URL}/payment/initiateLink`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: params
    });

    const data = await response.json();
    if (data.status === 1) {
      res.json({ access_key: data.data });
    } else {
      console.error('Easebuzz error:', data);
      res.status(500).json({ error: 'Failed to initiate payment', details: data });
    }
  } catch (err) {
    console.error('Payment initiation error:', err);
    res.status(500).json({ error: 'Server error during payment initiation' });
  }
});

// 2. Success Webhook / Redirect
app.post('/api/payment/easebuzz/success', express.urlencoded({ extended: true }), (req, res) => {
  const data = req.body;
  // Expected fields: status, firstname, amount, txnid, hash, etc.
  
  if (data.status === 'success') {
    // Reverse hash to verify
    // Sequence: salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
    const reverseHashString = [
      EASEBUZZ_SALT, data.status, '', '', '', '', '', // udf10-udf6 are empty
      data.udf5 || '', data.udf4 || '', data.udf3 || '', data.udf2 || '', data.udf1 || '',
      data.email, data.firstname, data.productinfo, data.amount, data.txnid, EASEBUZZ_KEY
    ].join('|');
    
    const validHash = crypto.createHash('sha512').update(reverseHashString).digest('hex');
    
    if (validHash === data.hash) {
      // Find user from txnid (e.g., GM_178..._1)
      const userId = data.txnid.split('_').pop();
      dbRun('UPDATE users SET is_paid = 1 WHERE id = ?', [userId]);
      // Redirect back to frontend
      return res.redirect('/#payment-success');
    } else {
      console.error('Easebuzz Hash mismatch');
      return res.redirect('/#payment-failure');
    }
  }
  
  res.redirect('/#payment-failure');
});

// 3. Failure Webhook / Redirect
app.post('/api/payment/easebuzz/failure', express.urlencoded({ extended: true }), (req, res) => {
  res.redirect('/#payment-failure');
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
