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

    await pool.query(
      `INSERT INTO payment_queue
       (transaction_id, customer_email, customer_phone, plan,
        mikrotik_username, mikrotik_password, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       ON CONFLICT (transaction_id) DO NOTHING`,
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

// ========== SUCCESS PAGE - FIXED FOR PAYSTACK REDIRECT ==========
app.get('/success', (req, res) => {
  try {
    const { reference, trxref } = req.query;
    const ref = reference || trxref;
    
    console.log('📄 Success page accessed, ref:', ref);
    
    // If no reference, show error
    if (!ref) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Payment Error</title>
          <style>
            body { font-family: Arial; padding: 20px; text-align: center; }
            .error { color: red; background: #ffe6e6; padding: 20px; border-radius: 10px; }
          </style>
        </head>
        <body>
          <h1>⚠️ Payment Reference Missing</h1>
          <div class="error">
            <p>No payment reference found. This usually happens when:</p>
            <ol style="text-align: left; max-width: 500px; margin: 20px auto;">
              <li>Paystack didn't pass the reference properly</li>
              <li>You refreshed the page</li>
              <li>Browser blocked the redirect</li>
            </ol>
            <p><strong>Solution:</strong> Please return to the payment page and try again.</p>
            <p>Support: 07037412314</p>
          </div>
        </body>
        </html>
      `);
    }
    
    // SIMPLE HTML - MINIMAL JAVASCRIPT
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Payment Processing - Dream Hatcher</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          margin: 0;
          padding: 20px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .container {
          background: white;
          padding: 30px;
          border-radius: 20px;
          box-shadow: 0 10px 40px rgba(0,0,0,0.2);
          max-width: 400px;
          width: 100%;
          text-align: center;
        }
        h1 {
          color: #333;
          margin-bottom: 10px;
        }
        .ref {
          background: #f7f7f7;
          padding: 10px;
          border-radius: 5px;
          margin: 15px 0;
          font-family: monospace;
          word-break: break-all;
        }
        .spinner {
          border: 4px solid #f3f3f3;
          border-top: 4px solid #667eea;
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
        .btn {
          background: #667eea;
          color: white;
          border: none;
          padding: 12px 24px;
          border-radius: 10px;
          font-size: 16px;
          cursor: pointer;
          margin: 10px;
          text-decoration: none;
          display: inline-block;
        }
        .btn:hover {
          background: #5a67d8;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>✅ Payment Successful!</h1>
        <p>Your payment reference:</p>
        <div class="ref">${ref}</div>
        
        <div class="spinner"></div>
        
        <p>Processing your WiFi credentials...</p>
        <p><small>This may take 30-60 seconds</small></p>
        
        <div style="margin-top: 20px;">
          <button class="btn" onclick="checkStatus()">Check Status</button>
          <button class="btn" onclick="goToLogin()">Go to WiFi Login</button>
        </div>
        
        <p style="margin-top: 30px; color: #666; font-size: 14px;">
          If this takes more than 2 minutes, please contact:<br>
          <strong>07037412314</strong>
        </p>
      </div>
      
      <script>
        const ref = '${ref}';
        let checkCount = 0;
        
        function checkStatus() {
          checkCount++;
          
          // Simple fetch with error handling
          fetch('https://dreamhatcher-backend.onrender.com/api/check-status?ref=' + encodeURIComponent(ref))
            .then(res => {
              if (!res.ok) throw new Error('Network error');
              return res.json();
            })
            .then(data => {
              console.log('Check result:', data);
              
              if (data.ready && data.username && data.password) {
                // Redirect to WiFi login with credentials
                window.location.href = 'http://dreamhatcher.login/login?username=' + 
                  encodeURIComponent(data.username) + '&password=' + 
                  encodeURIComponent(data.password);
              } else {
                alert('Still processing... Try again in 30 seconds.');
              }
            })
            .catch(err => {
              console.error(err);
              alert('Failed to check status. Please try again later.');
            });
        }
        
        function goToLogin() {
          window.location.href = 'http://dreamhatcher.login';
        }
        
        // Auto-check after 5 seconds
        setTimeout(checkStatus, 5000);
      </script>
    </body>
    </html>
    `;
    
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
    
  } catch (error) {
    console.error('Success page error:', error.message);
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Payment Processed</title></head>
      <body>
        <h2>Payment Successful</h2>
        <p>Your payment was processed successfully.</p>
        <p>Please go to: <strong>http://dreamhatcher.login</strong></p>
        <p>Support: 07037412314</p>
      </body>
      </html>
    `);
  }
});

// ADD THIS ENDPOINT FOR PAYSTACK POST REDIRECT
app.post('/success', (req, res) => {
  // Paystack sometimes sends POST data
  const { reference, trxref } = req.body;
  const ref = reference || trxref;
  
  console.log('📄 POST Success page, ref:', ref);
  
  // Redirect to GET with the reference
  if (ref) {
    return res.redirect(`/success?reference=${ref}`);
  }
  
  res.redirect('/success');
});

// ========== SIMPLE STATUS CHECK ==========
app.get('/api/check-status', async (req, res) => {
  try {
    const { ref } = req.query;
    
    if (!ref) {
      return res.json({ ready: false, message: 'No reference provided' });
    }
    
    // Simple query
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
          plan: user.plan,
          message: 'Credentials ready'
        });
      } else {
        return res.json({
          ready: false,
          status: user.status,
          message: 'Status: ' + user.status + ' - Please wait...'
        });
      }
    } else {
      return res.json({ 
        ready: false,
        message: 'Payment not found in system. Please wait a moment...'
      });
    }
    
  } catch (error) {
    console.error('Check status error:', error.message);
    return res.json({ 
      ready: false, 
      error: 'Server error',
      message: 'Temporary server issue. Please try again in 30 seconds.'
    });
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
        <h3>📊 Endpoints</h3>
        <ul>
          <li><strong>POST</strong> /api/paystack-webhook - Paystack webhook</li>
          <li><strong>GET</strong> /success - Payment success page</li>
          <li><strong>GET</strong> /api/check-status - Check payment status</li>
          <li><strong>GET</strong> /api/mikrotik-queue-text - Mikrotik queue</li>
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
  console.log(`🔗 Paystack webhook: https://dreamhatcher-backend.onrender.com/api/paystack-webhook`);
});

server.setTimeout(30000);
server.keepAliveTimeout = 30000;

