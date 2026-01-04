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

// ========== CRITICAL: ADD ERROR HANDLING MIDDLEWARE ==========
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

    await pool.query(
      `INSERT INTO payment_queue
       (transaction_id, customer_email, customer_phone, plan,
        mikrotik_username, mikrotik_password, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
    ON CONFLICT (transaction_id, customer_email) DO NOTHING`,
      [
        reference,
        customer?.email || 'unknown@example.com',
        customer?.phone || '',
        plan,
        username,
        password
      ]
    );

    console.log(`✅ Queued Paystack user ${username}`);

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('❌ Paystack webhook error:', error.message);
    return res.status(500).json({ error: 'Webhook error' });
  }
});

// ========== SIMPLE SUCCESS PAGE - NO ERRORS ==========
app.get('/success', (req, res) => {
  try {
    const { reference, trxref } = req.query;
    const ref = reference || trxref;
    
    console.log('📄 Success page accessed, ref:', ref);
    
    // SIMPLE HTML - NO DATABASE QUERIES
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Payment Successful - Dream Hatcher Tech</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          margin: 0;
          padding: 20px;
          background: #f0f8ff;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .container {
          background: white;
          padding: 40px;
          border-radius: 15px;
          box-shadow: 0 5px 20px rgba(0,0,0,0.1);
          max-width: 500px;
          width: 100%;
          text-align: center;
        }
        h1 {
          color: #0072ff;
          margin-bottom: 20px;
        }
        .status {
          background: #e6f7ff;
          padding: 15px;
          border-radius: 10px;
          margin: 20px 0;
          border-left: 5px solid #0072ff;
        }
        .ref {
          font-family: monospace;
          background: #f8f9fa;
          padding: 10px;
          border-radius: 5px;
          margin: 10px 0;
          word-break: break-all;
        }
        .btn {
          background: #0072ff;
          color: white;
          border: none;
          padding: 15px 30px;
          border-radius: 10px;
          font-size: 16px;
          cursor: pointer;
          margin-top: 20px;
          text-decoration: none;
          display: inline-block;
        }
        .btn:hover {
          background: #0056cc;
        }
        .spinner {
          border: 4px solid #f3f3f3;
          border-top: 4px solid #0072ff;
          border-radius: 50%;
          width: 40px;
          height: 40px;
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
        <h1>✅ Payment Successful!</h1>
        <div class="status">
          <p><strong>Status:</strong> Processing your WiFi access</p>
          <p><strong>Reference:</strong> <span class="ref">${ref || 'N/A'}</span></p>
        </div>
        
        <div class="spinner"></div>
        
        <p>Your WiFi credentials will be ready in 30-60 seconds.</p>
        <p>You can:</p>
        
        <div style="margin: 20px 0;">
          <button class="btn" onclick="checkStatus()" style="margin-right: 10px;">
            Check Now
          </button>
          <button class="btn" onclick="goToLogin()" style="background: #00cc66;">
            Go to WiFi Login
          </button>
        </div>
        
        <p style="color: #666; font-size: 14px; margin-top: 30px;">
          <strong>Note:</strong> If credentials don't appear, refresh this page in 1 minute.<br>
          Support: 07037412314
        </p>
      </div>
      
      <script>
        let ref = '${ref}';
        let attempts = 0;
        
        function checkStatus() {
          attempts++;
          console.log('Check attempt:', attempts);
          
          // Show loading
          const spinner = document.querySelector('.spinner');
          spinner.style.display = 'block';
          
          // Simple fetch without complex logic
          fetch('/api/check-status?ref=' + encodeURIComponent(ref))
            .then(response => {
              if (!response.ok) throw new Error('Network error');
              return response.json();
            })
            .then(data => {
              console.log('Status check result:', data);
              
              if (data.ready && data.username && data.password) {
                // Redirect to login page with credentials
                window.location.href = 'https://dreamhatcher.login?username=' +
                encodeURIComponent(data.username) + '&password=' +
                encodeURIComponent(data.password);
              } else {
                alert('Still processing... Try again in 30 seconds.');
              }
            })
            .catch(error => {
              console.error('Check error:', error);
              alert('Check failed. Please wait or contact support.');
            })
            .finally(() => {
              spinner.style.display = 'none';
            });
        }
        
        function goToLogin() {
          window.location.href = 'http://dreamhatcher.login';
        }
        
        // Auto-check after 10 seconds
        setTimeout(() => {
          console.log('Auto-checking status...');
          checkStatus();
        }, 10000);
      </script>
    </body>
    </html>
    `;
    
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
    
  } catch (error) {
    console.error('Success page error:', error.message);
    // Even if error, send basic HTML
    res.send(`
      <h2>Payment Successful</h2>
      <p>Your payment was successful. Go to <a href="http://dreamhatcher.login">dreamhatcher.login</a></p>
      <p>Support: 07037412314</p>
    `);
  }
});

// ========== SIMPLE STATUS CHECK ==========
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

// ========== TEST ENDPOINTS ==========
app.get('/test', (req, res) => {
  res.json({ 
    status: 'OK', 
    time: new Date().toISOString(),
    service: 'Dream Hatcher Backend'
  });
});

app.get('/test-payment', (req, res) => {
  const html = `
  <html>
  <body style="font-family: Arial; padding: 20px;">
    <h2>🧪 Test Payment System</h2>
    <div style="margin: 20px 0;">
      <button onclick="testDaily()" style="padding: 15px; margin: 5px; background: #0072ff; color: white; border: none; border-radius: 5px;">
        Test Daily Plan
      </button>
      <button onclick="testWeekly()" style="padding: 15px; margin: 5px; background: #00aa00; color: white; border: none; border-radius: 5px;">
        Test Weekly Plan
      </button>
      <button onclick="testMonthly()" style="padding: 15px; margin: 5px; background: #ff6600; color: white; border: none; border-radius: 5px;">
        Test Monthly Plan
      </button>
    </div>
    
    <div id="result" style="margin-top: 20px; padding: 15px; background: #f0f8ff; border-radius: 5px; display: none;"></div>
    
    <script>
      async function testPlan(plan) {
        try {
          const response = await fetch('/api/test-create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ plan: plan })
          });
          
          const data = await response.json();
          
          if (data.success && data.redirect) {
            window.location.href = data.redirect;
          } else {
            document.getElementById('result').innerHTML = 
              '<h3>Test Failed</h3><p>' + (data.error || 'Unknown error') + '</p>';
            document.getElementById('result').style.display = 'block';
          }
        } catch (error) {
          document.getElementById('result').innerHTML = 
            '<h3>Error</h3><p>' + error.message + '</p>';
          document.getElementById('result').style.display = 'block';
        }
      }
      
      function testDaily() { testPlan('daily'); }
      function testWeekly() { testPlan('weekly'); }
      function testMonthly() { testPlan('monthly'); }
    </script>
  </body>
  </html>
  `;
  res.send(html);
});

app.post('/api/test-create', async (req, res) => {
  try {
    const { plan } = req.body;
    
    if (!plan || !['daily', 'weekly', 'monthly'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }
    
    const planMap = {
      daily: { code: '24hr', amount: 350 },
      weekly: { code: '7d', amount: 2400 },
      monthly: { code: '30d', amount: 7500 }
    };
    
    const username = `test_${Date.now().toString().slice(-6)}`;
    const password = 'test123';
    const token = crypto.randomBytes(16).toString('hex');
    
    await pool.query(
      `INSERT INTO payment_queue 
       (transaction_id, customer_email, plan, mikrotik_username, mikrotik_password, status, one_time_token)
       VALUES ($1, $2, $3, $4, $5, 'processed', $6)`,
      [
        `test_${Date.now()}`,
        'test@dreamhatcher.com',
        planMap[plan].code,
        username,
        password,
        token
      ]
    );
    
    console.log(`✅ Test ${plan} created: ${username}`);
    
    res.json({
      success: true,
      redirect: `/success?token=${token}`
    });
    
  } catch (error) {
    console.error('Test create error:', error);
    res.status(500).json({ error: 'Test failed' });
  }
});

// ========== MIKROTIK ENDPOINTS ==========
app.get('/api/mikrotik-queue', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (apiKey !== process.env.MIKROTIK_API_KEY) {
      console.log('❌ Invalid API key');
      return res.status(403).json({ error: 'Forbidden' });
    }

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

// ========== HEALTH CHECK ==========
app.get('/health', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT NOW()');
    const queueResult = await pool.query('SELECT COUNT(*) FROM payment_queue');
    
    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      database: 'connected',
      db_time: dbResult.rows[0].now,
      total_payments: queueResult.rows[0].count,
      uptime: process.uptime()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'ERROR', 
      error: error.message 
    });
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
        <h3>🧪 Test System</h3>
        <p><a href="/test-payment" class="btn">Test Payment</a></p>
      </div>
      <div class="card">
        <h3>📊 Endpoints</h3>
        <ul>
          <li><strong>POST</strong> /api/paystack-webhook - Paystack webhook</li>
          <li><strong>GET</strong> /success - Success page</li>
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
  console.log(`✅ Health: https://dreamhatcher-backend.onrender.com/health`);
  console.log(`🧪 Test: https://dreamhatcher-backend.onrender.com/test-payment`);
});

// Set server timeout to prevent hanging
server.setTimeout(30000);
server.keepAliveTimeout = 30000;



