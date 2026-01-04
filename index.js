// File: index.js - PRODUCTION READY
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Database connection to Supabase
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) console.error('❌ Database connection failed:', err);
  else console.log('✅ Connected to Supabase');
});

// Helper functions
function generatePassword(length = 8) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

function getPlanDuration(planCode) {
  switch(planCode) {
    case '24hr': return '24 hours';
    case '7d': return '7 days';
    case '30d': return '30 days';
    default: return planCode;
  }
}

// ========== ERROR HANDLING MIDDLEWARE ==========
app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    console.log(`⏰ Timeout on ${req.method} ${req.url}`);
  });
  next();
});

app.use((err, req, res, next) => {
  console.error('💥 Uncaught error:', err.message);
  res.status(500).send(`
    <h2>Server Error</h2>
    <p>Please try again or contact support: 07037412314</p>
  `);
});

// ========== PAYSTACK WEBHOOK ==========
app.post('/api/paystack-webhook', async (req, res) => {
  console.log('📥 Paystack webhook received');

  try {
    const { event, data } = req.body;

    if (event !== 'charge.success') {
      return res.status(200).json({ received: true });
    }

    const { reference, amount, customer } = data;
    const amountNaira = amount / 100;

    console.log(`💰 Paystack payment ₦${amountNaira} ref=${reference}`);

    // Determine plan STRICTLY by amount
    let plan;
    if (amountNaira === 350) plan = '24hr';
    else if (amountNaira === 2400) plan = '7d';
    else if (amountNaira === 7500) plan = '30d';
    else {
      console.error('❌ Invalid amount:', amountNaira);
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const username = `user_${Date.now().toString().slice(-6)}`;
    const password = generatePassword();

    // Generate one-time token
    const token = crypto.randomBytes(16).toString('hex');

    await pool.query(
      `INSERT INTO payment_queue
       (transaction_id, customer_email, customer_phone, plan,
        mikrotik_username, mikrotik_password, status, one_time_token, token_expires)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, NOW() + INTERVAL '10 minutes')
       ON CONFLICT (transaction_id) DO NOTHING`,
      [
        reference,
        customer?.email || 'unknown@example.com',
        customer?.phone || '',
        plan,
        username,
        password,
        token
      ]
    );

    console.log(`✅ Queued Paystack user ${username}, token: ${token}`);

    return res.status(200).json({ 
      received: true,
      redirect_url: `http://dreamhatcher.login/payment-processing.html?token=${token}`
    });

  } catch (error) {
    console.error('❌ Paystack webhook error:', error.message);
    return res.status(500).json({ error: 'Webhook error' });
  }
});

// ========== SUCCESS PAGE WITH TOKEN REDIRECT ==========
app.get('/success', async (req, res) => {
  try {
    const { reference, trxref } = req.query;
    const ref = reference || trxref;
    
    console.log('📄 Success page accessed, ref:', ref);
    
    // Generate a one-time token for the hotspot
    const token = crypto.randomBytes(16).toString('hex');
    
    // Store token in database with reference
    await pool.query(
      `UPDATE payment_queue 
       SET one_time_token = $1, token_expires = NOW() + INTERVAL '10 minutes'
       WHERE transaction_id = $2`,
      [token, ref]
    );
    
    // Redirect IMMEDIATELY to hotspot with token
    const redirectUrl = `http://dreamhatcher.login/payment-processing.html?token=${token}`;
    return res.redirect(302, redirectUrl);
    
  } catch (error) {
    console.error('Success redirect error:', error);
    // Fallback: redirect to hotspot anyway
    return res.redirect(302, 'http://dreamhatcher.login/payment-processing.html');
  }
});

// ========== TOKEN VERIFICATION ENDPOINT ==========
app.get('/api/verify-token', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.json({ ready: false, message: 'No token provided' });
    }
    
    // Verify token and get user data
    const result = await pool.query(`
      SELECT mikrotik_username, mikrotik_password, status
      FROM payment_queue 
      WHERE one_time_token = $1 
        AND token_expires > NOW()
      LIMIT 1`,
      [token]
    );
    
    if (result.rows.length > 0) {
      const user = result.rows[0];
      
      if (user.status === 'processed') {
        // Clear token after use
        await pool.query(
          `UPDATE payment_queue SET one_time_token = NULL WHERE one_time_token = $1`,
          [token]
        );
        
        return res.json({
          ready: true,
          username: user.mikrotik_username,
          password: user.mikrotik_password
        });
      } else {
        return res.json({ 
          ready: false, 
          status: user.status,
          message: 'Account not yet processed'
        });
      }
    }
    
    return res.json({ 
      ready: false, 
      message: 'Invalid or expired token' 
    });
    
  } catch (error) {
    console.error('Token verification error:', error);
    return res.json({ ready: false, error: 'Server error' });
  }
});

// ========== SIMPLE STATUS CHECK (keep for compatibility) ==========
app.get('/api/check-status', async (req, res) => {
  try {
    const { ref } = req.query;
    
    if (!ref) {
      return res.json({ ready: false });
    }
    
    // Simple query with timeout
    const result = await pool.query(`
      SELECT mikrotik_username, mikrotik_password, plan, status
      FROM payment_queue 
      WHERE transaction_id = $1 
      LIMIT 1`,
      [ref]
    );
    
    if (result.rows.length > 0) {
      const user = result.rows[0];
      
      if (user.status === 'processed') {
        return res.json({
          ready: true,
          username: user.mikrotik_username,
          password: user.mikrotik_password,
          plan: user.plan
        });
      } else {
        return res.json({
          ready: false,
          status: user.status,
          message: 'Status: ' + user.status
        });
      }
    } else {
      return res.json({ 
        ready: false,
        message: 'Payment not found in system'
      });
    }
    
  } catch (error) {
    console.error('Check status error:', error.message);
    return res.json({ ready: false, error: 'Server error' });
  }
});

// ========== MIKROTIK ENDPOINTS ==========
app.get('/api/mikrotik-queue-text', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (apiKey !== process.env.MIKROTIK_API_KEY) {
      console.log('❌ Invalid API key');
      return res.status(403).send('FORBIDDEN');
    }

    const result = await pool.query(`
      SELECT id, mikrotik_username, mikrotik_password, plan
      FROM payment_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 5
    `);

    if (result.rows.length === 0) {
      console.log('📤 No pending users for MikroTik');
      return res.send('');
    }

    console.log(`📤 Sending ${result.rows.length} users to MikroTik`);
    
    const lines = result.rows.map(row =>
      `${row.mikrotik_username}|${row.mikrotik_password}|${row.plan}|${row.id}`
    );

    res.set('Content-Type', 'text/plain');
    res.send(lines.join('\n'));
    
  } catch (error) {
    console.error('❌ Text queue error:', error.message);
    res.status(500).send('ERROR');
  }
});

app.post('/api/mark-processed/:id', async (req, res) => {
  try {
    await pool.query(
      `UPDATE payment_queue SET status = 'processed' WHERE id = $1`,
      [req.params.id]
    );
    console.log(`✅ Marked ${req.params.id} as processed`);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Update error:', error.message);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ========== ROOT PAGE ==========
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Dream Hatcher Tech Backend</title>
      <style>
        body { font-family: Arial; padding: 20px; }
        .card { background: #f0f8ff; padding: 20px; border-radius: 10px; margin: 10px 0; }
        .btn { display: inline-block; padding: 10px 20px; background: #0072ff; color: white; 
               text-decoration: none; border-radius: 5px; margin: 5px; }
      </style>
    </head>
    <body>
      <h1>🌐 Dream Hatcher Tech Backend</h1>
      <div class="card">
        <h3>✅ Status: Running</h3>
        <p><a href="/health" class="btn">Health Check</a></p>
      </div>
      <div class="card">
        <h3>📊 Endpoints</h3>
        <ul>
          <li><strong>POST</strong> /api/paystack-webhook - Paystack webhook</li>
          <li><strong>GET</strong> /success - Success redirect page</li>
          <li><strong>GET</strong> /api/verify-token - Token verification</li>
          <li><strong>GET</strong> /api/mikrotik-queue-text - Mikrotik queue</li>
          <li><strong>POST</strong> /api/mark-processed/:id - Mark as processed</li>
        </ul>
      </div>
    </body>
    </html>
  `);
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  console.log(`🌐 Local: http://localhost:${PORT}`);
  console.log(`✅ Success page: https://dreamhatcher-backend.onrender.com/success`);
  console.log(`🔗 Token verify: https://dreamhatcher-backend.onrender.com/api/verify-token`);
});

// Set server timeout to prevent hanging
server.setTimeout(30000);
server.keepAliveTimeout = 30000;
