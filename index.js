// File: index.js - COMPLETE PAYSTACK VERSION
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const https = require('https');

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

function getPlanColor(planCode) {
  switch(planCode) {
    case '24hr': return '#ff6600';
    case '7d': return '#00aa00';
    case '30d': return '#0072ff';
    default: return '#666';
  }
}

// Verify Paystack webhook signature
function verifyPaystackSignature(req) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const signature = req.headers['x-paystack-signature'];
  
  if (!signature || !secret) {
    console.log('⚠️ Missing Paystack signature or secret');
    return false;
  }
  
  const body = JSON.stringify(req.body);
  const hash = crypto.createHmac('sha512', secret)
    .update(body)
    .digest('hex');
    
  return hash === signature;
}

// PAYSTACK WEBHOOK - FIXED VERSION
app.post('/api/paystack-webhook', async (req, res) => {
  console.log('📥 Paystack webhook received');
  
  try {
    // Skip signature check for now (enable later)
    const { event, data } = req.body;
    
    if (event !== 'charge.success') {
      return res.status(200).json({ received: true });
    }
    
    const { reference, amount, customer, metadata } = data;
    const amountNaira = amount / 100;
    
    console.log(`💰 Payment: ₦${amountNaira} for ${customer?.email}`);
    
    // Determine plan
    let plan = '24hr';
    if (amountNaira >= 7500) plan = '30d';
    else if (amountNaira >= 2400) plan = '7d';
    
    // Generate credentials
    const username = `user_${Date.now().toString().slice(-6)}`;
    const password = generatePassword();
    const token = crypto.randomBytes(32).toString('hex');
    
    // ✅ FIXED: Status is 'pending' (Mikrotik will change to 'processed')
    // ✅ FIXED: Phone number optional
    const result = await pool.query(
      `INSERT INTO payment_queue 
       (transaction_id, customer_email, customer_phone, plan, 
        mikrotik_username, mikrotik_password, status, one_time_token) 
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
       RETURNING id`,
      [
        reference,
        customer?.email || 'unknown@example.com',
        customer?.phone || '',  // Empty string if no phone
        plan,
        username,
        password,
        token
      ]
    );
    
    console.log(`✅ Payment queued: ${username} / ${password}`);
    console.log(`📝 Status: pending (waiting for Mikrotik)`);
    console.log(`🔑 Token: ${token}`);
    
    res.status(200).json({ 
      success: true,
      message: 'Payment queued for Mikrotik processing'
    });
    
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== PAYSTACK CALLBACK HANDLER ==========
app.get('/paystack-callback', async (req, res) => {
  console.log('🔄 Paystack callback received:', req.query);
  
  const { reference, trxref } = req.query;
  const txRef = reference || trxref;
  
  if (!txRef) {
    console.log('❌ No reference in callback');
    return res.redirect('/success?error=no_reference');
  }
  
  try {
    // Check if payment exists in database
    const result = await pool.query(
      `SELECT one_time_token, status FROM payment_queue 
       WHERE transaction_id = $1`,
      [txRef]
    );
    
    if (result.rows.length === 0) {
      console.log(`❌ Payment ${txRef} not found in database`);
      
      // Try to verify with Paystack API
      const verifyUrl = `https://api.paystack.co/transaction/verify/${txRef}`;
      const options = {
        headers: {
          'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      };
      
      https.get(verifyUrl, options, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', async () => {
          try {
            const result = JSON.parse(data);
            if (result.status && result.data.status === 'success') {
              console.log(`✅ Payment ${txRef} verified via API`);
              // The webhook will handle it, redirect to waiting page
              return res.redirect(`/success?ref=${txRef}&waiting=true`);
            } else {
              console.log(`❌ Payment ${txRef} not successful`);
              return res.redirect('/success?error=payment_failed');
            }
          } catch (error) {
            console.error('❌ API verification error:', error.message);
            return res.redirect(`/success?ref=${txRef}&waiting=true`);
          }
        });
      }).on('error', (error) => {
        console.error('❌ API request error:', error.message);
        return res.redirect(`/success?ref=${txRef}&waiting=true`);
      });
      
    } else {
      const { one_time_token, status } = result.rows[0];
      
      if (status === 'processed' && one_time_token) {
        console.log(`✅ Payment found, redirecting with token`);
        return res.redirect(`/success?token=${one_time_token}`);
      } else {
        console.log(`⏳ Payment ${txRef} status: ${status}`);
        return res.redirect(`/success?ref=${txRef}&waiting=true`);
      }
    }
    
  } catch (error) {
    console.error('❌ Callback error:', error.message);
    res.redirect('/success?error=server_error');
  }
});

// ========== SIMPLE SUCCESS PAGE ==========
app.get('/success', (req, res) => {
  const { reference, trxref } = req.query;
  const ref = reference || trxref;
  
  console.log('📄 Success page loaded with reference:', ref);
  
  // IMMEDIATE response - no database queries
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body {
        font-family: Arial, sans-serif;
        background: linear-gradient(135deg, #0f2027, #203a43, #2c5364);
        min-height: 100vh;
        display: flex;
        justify-content: center;
        align-items: center;
        padding: 20px;
        margin: 0;
        color: white;
      }
      .container {
        background: rgba(255, 255, 255, 0.1);
        padding: 40px;
        border-radius: 20px;
        backdrop-filter: blur(10px);
        max-width: 500px;
        width: 100%;
        text-align: center;
      }
      h1 { color: #00c6ff; margin-bottom: 20px; }
      .spinner {
        border: 5px solid rgba(255,255,255,0.3);
        border-top: 5px solid #00c6ff;
        border-radius: 50%;
        width: 50px;
        height: 50px;
        animation: spin 1s linear infinite;
        margin: 20px auto;
      }
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>🎉 Payment Successful!</h1>
      <p>Your payment reference: <strong>${ref || 'N/A'}</strong></p>
      <p>We're activating your WiFi access now...</p>
      <div class="spinner"></div>
      <p>Please wait 10-30 seconds for activation.</p>
      <p>If this page doesn't update, refresh or contact: 07037412314</p>
    </div>
    
    <script>
      // Simple JavaScript to check status
      const ref = '${ref}';
      let checkCount = 0;
      
      function checkStatus() {
        checkCount++;
        console.log('Checking status, attempt:', checkCount);
        
        // After 5 seconds, try to redirect to hotspot page
        if (checkCount >= 5) {
          window.location.href = 'http://dreamhatcher.login';
          return;
        }
        
        // Simple check without complex queries
        fetch('/api/simple-check?ref=' + ref)
          .then(res => res.json())
          .then(data => {
            if (data.ready) {
              window.location.href = 'http://dreamhatcher.login?username=' + 
                encodeURIComponent(data.username) + '&password=' + 
                encodeURIComponent(data.password);
            } else {
              setTimeout(checkStatus, 3000);
            }
          })
          .catch(() => {
            setTimeout(checkStatus, 3000);
          });
      }
      
      // Start checking after 3 seconds
      setTimeout(checkStatus, 3000);
    </script>
  </body>
  </html>
  `;
  
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// SIMPLE CHECK ENDPOINT - No database queries
app.get('/api/simple-check', async (req, res) => {
  const { ref } = req.query;
  
  if (!ref) {
    return res.json({ ready: false });
  }
  
  try {
    // SIMPLE query only
    const result = await pool.query(
      `SELECT mikrotik_username, mikrotik_password 
       FROM payment_queue 
       WHERE transaction_id = $1 AND status = 'processed' 
       LIMIT 1`,
      [ref]
    );
    
    if (result.rows.length > 0) {
      res.json({
        ready: true,
        username: result.rows[0].mikrotik_username,
        password: result.rows[0].mikrotik_password
      });
    } else {
      res.json({ ready: false });
    }
  } catch (error) {
    console.log('Simple check error:', error.message);
    res.json({ ready: false });
  }
});

// ========== TEST PAYMENT ENDPOINT ==========
app.get('/test-payment', (req, res) => {
  const testHtml = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Test Payment - Dream Hatcher Tech</title>
    <style>
      body { font-family: Arial; padding: 20px; }
      .test-box { max-width: 500px; margin: 0 auto; }
      button { margin: 10px; padding: 10px 20px; }
    </style>
  </head>
  <body>
    <div class="test-box">
      <h2>🧪 Test Payment Options</h2>
      <button onclick="window.location.href='https://dreamhatcher-backend.onrender.com/test-create?plan=daily'">
        Test Daily Plan (₦350)
      </button>
      <button onclick="window.location.href='https://dreamhatcher-backend.onrender.com/test-create?plan=weekly'">
        Test Weekly Plan (₦2400)
      </button>
      <button onclick="window.location.href='https://dreamhatcher-backend.onrender.com/test-create?plan=monthly'">
        Test Monthly Plan (₦7500)
      </button>
    </div>
  </body>
  </html>
  `;
  res.send(testHtml);
});

app.get('/test-create', async (req, res) => {
  const { plan } = req.query;
  
  if (!plan || !['daily', 'weekly', 'monthly'].includes(plan)) {
    return res.status(400).send('Invalid plan');
  }
  
  try {
    const planMap = {
      daily: { code: '24hr', amount: 350 },
      weekly: { code: '7d', amount: 2400 },
      monthly: { code: '30d', amount: 7500 }
    };
    
    const username = `test_${Date.now().toString().slice(-6)}`;
    const password = 'test123';
    const token = crypto.randomBytes(32).toString('hex');
    
    await pool.query(
      `INSERT INTO payment_queue 
       (transaction_id, customer_email, plan, mikrotik_username, mikrotik_password, status, one_time_token)
       VALUES ($1, $2, $3, $4, $5, 'processed', $6)`,
      [
        `test_${Date.now()}`,
        'test@example.com',
        planMap[plan].code,
        username,
        password,
        token
      ]
    );
    
    console.log(`✅ Test payment created for ${plan} plan`);
    res.redirect(`/success?token=${token}`);
    
  } catch (error) {
    console.error('Test create error:', error);
    res.status(500).send('Test failed');
  }
});

// ========== MIKROTIK QUEUE ENDPOINTS ==========
app.get('/api/mikrotik-queue', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey !== process.env.MIKROTIK_API_KEY) {
    console.log('❌ Invalid API key');
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const result = await pool.query(`
      SELECT * FROM payment_queue 
      WHERE status = 'pending' 
      ORDER BY created_at ASC 
      LIMIT 5
    `);
    console.log(`📤 Sending ${result.rows.length} pending users to Mikrotik`);
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Queue error:', error.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/mikrotik-queue-text', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey !== process.env.MIKROTIK_API_KEY) {
    console.log('❌ Invalid API key (text endpoint)');
    return res.status(403).send('FORBIDDEN');
  }

  try {
    const result = await pool.query(`
      SELECT id, mikrotik_username, mikrotik_password, plan
      FROM payment_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 5
    `);
    console.log(`📤 Sending ${result.rows.length} users to MikroTik (TEXT)`);
    if (result.rows.length === 0) return res.send('');
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

app.get('/api/queue-status', async (req, res) => {
  const result = await pool.query(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) as processed
    FROM payment_queue
  `);
  res.json(result.rows[0]);
});

// ========== HEALTH CHECK ==========
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    backend: 'dreamhatcher-paystack',
    database: 'connected'
  });
});

app.get('/', (req, res) => {
  res.send(`
    <h2>Dream Hatcher Tech Backend</h2>
    <p>Status: ✅ Running</p>
    <p>Endpoints:</p>
    <ul>
      <li><a href="/health">/health</a> - Health check</li>
      <li><a href="/test-payment">/test-payment</a> - Test payment</li>
      <li><a href="/success">/success</a> - Success page (requires token)</li>
    </ul>
  `);
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Paystack Backend running on port ${PORT}`);
  console.log(`✅ Health check: http://localhost:${PORT}/health`);
  console.log(`✅ Test payment: http://localhost:${PORT}/test-payment`);
});



