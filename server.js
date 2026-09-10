require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_dev_secret';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '0x4AAAAAAEtpxyu8YDxhWbIz8hjlDd12iyc';
const TRIAL_DAYS = 10;
const SALT_ROUNDS = 10;

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_live_TZtU5DcRuhWq63';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '9GSXvB14ELszeNhCVpAEnRnU';
const MONGODB_URI = (process.env.MONGODB_URI || '').trim().replace(/^["']|["']$/g, '').trim();

// ——— Middleware ———
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ——— Mongoose Schemas ———

const userSchema = new mongoose.Schema({
  name: { type: String, default: 'Lifter' },
  email: { 
    type: String, 
    required: true, 
    unique: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please fill a valid email address']
  },
  password_hash: { type: String, required: true },
  is_paid: { type: Number, default: 0 },
  subscription_expires_at: { type: Date },
  app_data: { type: mongoose.Schema.Types.Mixed, default: {} },
  created_at: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// ——— Helpers ———

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
    { id: user._id.toString(), email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function getTrialStatus(user) {
  const createdAt = new Date(user.created_at);
  const now = new Date();
  
  // Free trial calculation
  const diffMs = now - createdAt;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const daysRemaining = Math.max(0, TRIAL_DAYS - diffDays);
  const trialActive = daysRemaining > 0;

  // Premium subscription calculation
  let subDaysRemaining = 0;
  let isPaid = false;
  
  if (user.is_paid === 1) {
    if (user.subscription_expires_at) {
      const subDiffMs = new Date(user.subscription_expires_at) - now;
      if (subDiffMs > 0) {
        isPaid = true;
        subDaysRemaining = Math.ceil(subDiffMs / (1000 * 60 * 60 * 24));
      }
    } else {
      // Legacy users with is_paid but no expiration date: Treat created_at as payment date
      const subExpires = new Date(createdAt.getTime() + 31 * 24 * 60 * 60 * 1000);
      const subDiffMs = subExpires - now;
      if (subDiffMs > 0) {
        isPaid = true;
        subDaysRemaining = Math.ceil(subDiffMs / (1000 * 60 * 60 * 24));
      } else {
        isPaid = false;
        subDaysRemaining = 0;
      }
    }
  }

  return {
    trialActive: trialActive || isPaid,
    daysRemaining: isPaid ? subDaysRemaining : daysRemaining,
    isPaid,
    trialExpired: !trialActive && !isPaid,
    subDaysRemaining
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

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const turnstileOk = await verifyTurnstile(turnstileToken, ip);
    if (!turnstileOk) {
      return res.status(403).json({ error: 'Bot verification failed. Please try again.' });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = new User({
      name: name || 'Lifter',
      email,
      password_hash: passwordHash
    });
    
    await user.save();

    const token = generateToken(user);
    const trial = getTrialStatus(user);

    res.status(201).json({
      token,
      user: { id: user._id.toString(), name: user.name, email: user.email, data: user.app_data || {} },
      trial
    });
  } catch (err) {
    console.error('Signup error:', err);
    if (err.name === 'ValidationError') {
       return res.status(400).json({ error: err.message });
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

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const turnstileOk = await verifyTurnstile(turnstileToken, ip);
    if (!turnstileOk) {
      return res.status(403).json({ error: 'Bot verification failed. Please try again.' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = generateToken(user);
    const trial = getTrialStatus(user);

    res.json({
      token,
      user: { id: user._id.toString(), name: user.name, email: user.email, data: user.app_data || {} },
      trial
    });
  } catch (err) {
    console.error('Signin error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current user + trial status
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const trial = getTrialStatus(user);
    res.json({
      user: { id: user._id.toString(), name: user.name, email: user.email, data: user.app_data || {} },
      trial
    });
  } catch (err) {
    console.error('Auth/me error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Sync user data
app.post('/api/user/data', authMiddleware, async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'Key is required' });
    
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    if (!user.app_data) user.app_data = {};
    user.app_data[key] = value;
    user.markModified('app_data');
    await user.save();
    
    res.json({ success: true });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ——— Payment Routes (Razorpay) ———

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
      const expiresAt = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
      await User.findByIdAndUpdate(req.user.id, { 
        is_paid: 1,
        subscription_expires_at: expiresAt 
      });
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
  if (!MONGODB_URI) {
    console.error('MONGODB_URI is missing from environment variables');
    process.exit(1);
  }
  
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB Atlas');
  } catch (err) {
    console.error('❌ Failed to connect to MongoDB', err);
    process.exit(1);
  }
  
  app.listen(PORT, () => {
    console.log(`
  🏋️  GainMetric server running at http://localhost:${PORT}
`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
