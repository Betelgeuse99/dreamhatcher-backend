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

// ========== KEEP ALIVE (prevents Render sleep) ==========
const https = require('https');

function keepAlive() {
  https.get('https://dreamhatcher-backend.onrender.com/health', (res) => {
    console.log('🏓 Keep-alive ping, status:', res.statusCode);
  }).on('error', (err) => {
    console.log('🏓 Keep-alive error:', err.message);
  });
}

// Ping every 14 minutes
setInterval(keepAlive, 14 * 60 * 1000);
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

// ========== PAYSTACK CALLBACK - WITH DELAY ==========
app.get('/paystack-callback', (req, res) => {
  const { reference, trxref, transaction_id } = req.query;
  const ref = reference || trxref || transaction_id;
  
  console.log('🔗 Paystack callback:', ref);
  
  // Show a delay page before redirecting to success
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Processing Payment...</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: Arial, sans-serif;
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        color: white;
      }
      .container {
        background: rgba(255,255,255,0.05);
        padding: 40px;
        border-radius: 20px;
        max-width: 400px;
        width: 100%;
        text-align: center;
        border: 1px solid rgba(255,255,255,0.1);
      }
      .spinner {
        border: 4px solid rgba(255,255,255,0.1);
        border-top: 4px solid #00c9ff;
        border-radius: 50%;
        width: 60px;
        height: 60px;
        animation: spin 1s linear infinite;
        margin: 30px auto;
      }
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      .progress-bar {
        background: rgba(255,255,255,0.1);
        border-radius: 10px;
        height: 8px;
        margin: 20px 0;
        overflow: hidden;
      }
      .progress-fill {
        background: linear-gradient(90deg, #00c9ff, #92fe9d);
        height: 100%;
        width: 0%;
        animation: fill 8s linear forwards;
      }
      @keyframes fill {
        0% { width: 0%; }
        100% { width: 100%; }
      }
      h2 { color: #00c9ff; margin-bottom: 10px; }
    </style>
  </head>
  <body>
    <div class="container">
      <h2>✅ Payment Received!</h2>
      <div class="spinner"></div>
      <p>Processing your WiFi credentials...</p>
      <div class="progress-bar">
        <div class="progress-fill"></div>
      </div>
      <p id="countdown">Preparing your account: <strong>8</strong> seconds</p>
      <p style="margin-top: 20px; font-size: 12px; color: #888;">
        Reference: ${ref || 'N/A'}
      </p>
    </div>
    
    <script>
      let seconds = 8;
      const countdown = document.getElementById('countdown');
      
      const timer = setInterval(function() {
        seconds--;
        countdown.innerHTML = 'Preparing your account: <strong>' + seconds + '</strong> seconds';
        
        if (seconds <= 0) {
          clearInterval(timer);
          countdown.innerHTML = '<strong>Redirecting...</strong>';
          window.location.href = '/success?reference=${encodeURIComponent(ref || '')}';
        }
      }, 1000);
    </script>
  </body>
  </html>
  `;
  
  res.send(html);
});
    
   // ========== SUCCESS PAGE - PATIENT POLLING ==========
app.get('/success', async (req, res) => {
  try {
    const { reference, trxref } = req.query;
    const ref = reference || trxref;
    
    console.log('📄 Success page accessed, ref:', ref);
    
    if (!ref) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Payment Error</title>
          <style>
            body { font-family: Arial; padding: 20px; text-align: center; background: #1a1a2e; color: white; min-height: 100vh; }
            .error { color: #ff6b6b; background: rgba(255,0,0,0.1); padding: 20px; border-radius: 10px; max-width: 400px; margin: 50px auto; }
          </style>
        </head>
        <body>
          <h1>⚠️ Payment Reference Missing</h1>
          <div class="error">
            <p>No payment reference found.</p>
            <p>Please return to the payment page and try again.</p>
            <p>Support: <strong>07037412314</strong></p>
          </div>
        </body>
        </html>
      `);
    }
    
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Payment Successful - Dream Hatcher</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: Arial, sans-serif;
          background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          color: white;
        }
        .container {
          background: rgba(255,255,255,0.05);
          backdrop-filter: blur(10px);
          padding: 30px;
          border-radius: 20px;
          max-width: 420px;
          width: 100%;
          text-align: center;
          border: 1px solid rgba(255,255,255,0.1);
          box-shadow: 0 20px 50px rgba(0,0,0,0.5);
        }
        .logo { font-size: 28px; margin-bottom: 20px; }
        .success-icon { font-size: 60px; margin: 20px 0; }
        .credentials-box {
          background: linear-gradient(135deg, #00c9ff 0%, #92fe9d 100%);
          color: #000;
          padding: 25px;
          border-radius: 15px;
          margin: 20px 0;
        }
        .credentials-box h3 { margin-bottom: 15px; font-size: 18px; }
        .credential {
          background: rgba(255,255,255,0.9);
          padding: 12px;
          border-radius: 8px;
          margin: 10px 0;
          font-family: monospace;
          font-size: 18px;
          font-weight: bold;
          user-select: all;
          cursor: pointer;
        }
        .credential-label {
          font-size: 12px;
          color: #333;
          margin-bottom: 5px;
        }
        .status-box {
          background: rgba(0,0,0,0.3);
          padding: 20px;
          border-radius: 10px;
          margin: 20px 0;
        }
        .spinner {
          border: 3px solid rgba(255,255,255,0.1);
          border-top: 3px solid #00c9ff;
          border-radius: 50%;
          width: 40px;
          height: 40px;
          animation: spin 1s linear infinite;
          margin: 15px auto;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .steps {
          text-align: left;
          background: rgba(0,0,0,0.3);
          padding: 20px;
          border-radius: 10px;
          margin: 20px 0;
        }
        .steps h4 { margin-bottom: 15px; text-align: center; }
        .steps ol { padding-left: 20px; }
        .steps li { margin: 10px 0; line-height: 1.5; }
        .btn {
          background: linear-gradient(135deg, #00c9ff 0%, #92fe9d 100%);
          color: #000;
          border: none;
          padding: 15px 30px;
          border-radius: 50px;
          font-size: 16px;
          font-weight: bold;
          cursor: pointer;
          margin: 10px 5px;
          transition: transform 0.3s, box-shadow 0.3s;
        }
        .btn:hover { transform: translateY(-2px); box-shadow: 0 5px 20px rgba(0,201,255,0.4); }
        .hidden { display: none; }
        .support { margin-top: 20px; font-size: 14px; color: #aaa; }
        .attempt-info { font-size: 12px; color: #888; margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">🌐 Dream Hatcher Tech</div>
        
        <div id="loading-state">
          <div class="success-icon">✅</div>
          <h2>Payment Successful!</h2>
          <div class="status-box">
            <div class="spinner"></div>
            <p id="status-text">Creating your WiFi account...</p>
            <p class="attempt-info" id="attempt-info">This usually takes 30-60 seconds</p>
            <p style="font-size: 12px; margin-top: 10px;">Reference: ${ref}</p>
          </div>
        </div>
        
        <div id="credentials-state" class="hidden">
          <div class="success-icon">🎉</div>
          <h2>Your WiFi Credentials</h2>
          
          <div class="credentials-box">
            <h3>Login Details</h3>
            <div class="credential-label">Username</div>
            <div class="credential" id="username-display" onclick="copyText(this)">---</div>
            <div class="credential-label">Password</div>
            <div class="credential" id="password-display" onclick="copyText(this)">---</div>
            <div class="credential-label">Plan</div>
            <div class="credential" id="plan-display">---</div>
          </div>
          
          <div class="steps">
            <h4>📶 How to Connect</h4>
            <ol>
              <li>Connect to <strong>Dream Hatcher WiFi</strong> network</li>
              <li>A login page will open automatically</li>
              <li>If not, open browser and go to:<br><strong>http://192.168.88.1</strong></li>
              <li>Enter your username and password above</li>
              <li>Click Login and enjoy!</li>
            </ol>
          </div>
          
          <button class="btn" onclick="copyCredentials()">📋 Copy Credentials</button>
        </div>
        
        <div id="error-state" class="hidden">
          <div class="success-icon">⏳</div>
          <h2>Still Processing...</h2>
          <div class="status-box">
            <p id="error-text">Your account is being created. This may take a bit longer.</p>
            <button class="btn" onclick="checkStatus()" style="margin-top: 15px;">🔄 Check Again</button>
            <p style="margin-top: 15px; font-size: 12px;">
              Reference: <strong>${ref}</strong><br>
              Save this reference and contact support if needed.
            </p>
          </div>
        </div>
        
        <div class="support">
          Need help? Call: <strong>07037412314</strong>
        </div>
      </div>
      
      <script>
        const ref = '${ref}';
        let checkCount = 0;
        const maxChecks = 20; // 20 attempts x 5 seconds = 100 seconds max
        let credentials = { username: '', password: '', plan: '' };
        
        function showState(state) {
          document.getElementById('loading-state').classList.add('hidden');
          document.getElementById('credentials-state').classList.add('hidden');
          document.getElementById('error-state').classList.add('hidden');
          document.getElementById(state + '-state').classList.remove('hidden');
        }
        
        function copyText(element) {
          const text = element.textContent;
          navigator.clipboard.writeText(text).then(function() {
            const original = element.textContent;
            element.textContent = '✓ Copied!';
            setTimeout(function() { element.textContent = original; }, 1000);
          });
        }
        
        function copyCredentials() {
          const text = 'Username: ' + credentials.username + '\\nPassword: ' + credentials.password + '\\nPlan: ' + credentials.plan;
          navigator.clipboard.writeText(text).then(function() {
            const btns = document.querySelectorAll('.btn');
            btns.forEach(function(btn) {
              if (btn.textContent.includes('Copy')) {
                btn.textContent = '✓ Copied!';
                setTimeout(function() { btn.textContent = '📋 Copy Credentials'; }, 2000);
              }
            });
          });
        }
        
        async function checkStatus() {
          checkCount++;
          
          const statusText = document.getElementById('status-text');
          const attemptInfo = document.getElementById('attempt-info');
          
          statusText.textContent = 'Checking for your credentials...';
          attemptInfo.textContent = 'Attempt ' + checkCount + ' of ' + maxChecks + ' (checking every 5 seconds)';
          
          try {
            const response = await fetch('/api/check-status?ref=' + encodeURIComponent(ref));
            const data = await response.json();
            
            console.log('Status check #' + checkCount + ':', data);
            
            if (data.ready && data.username && data.password) {
              // SUCCESS! Credentials are ready
              credentials = {
                username: data.username,
                password: data.password,
                plan: data.plan || 'WiFi Access'
              };
              
              document.getElementById('username-display').textContent = credentials.username;
              document.getElementById('password-display').textContent = credentials.password;
              document.getElementById('plan-display').textContent = credentials.plan;
              
              showState('credentials');
              
            } else if (checkCount >= maxChecks) {
              // Max attempts reached
              document.getElementById('error-text').textContent = 
                'Your payment was received but account creation is taking longer than expected. ' +
                'Please wait a few minutes and try the "Check Again" button, or contact support.';
              showState('error');
              
            } else {
              // Still processing, update status and retry
              if (data.status === 'pending') {
                statusText.textContent = 'Account queued, waiting for MikroTik to create user...';
              } else if (data.status === 'processed') {
                statusText.textContent = 'Account created! Loading credentials...';
              } else {
                statusText.textContent = data.message || 'Processing your payment...';
              }
              
              // Retry after 5 seconds
              setTimeout(checkStatus, 5000);
            }
            
          } catch (error) {
            console.error('Check error:', error);
            
            if (checkCount >= 5) {
              statusText.textContent = 'Connection issue, retrying...';
            }
            
            if (checkCount >= maxChecks) {
              document.getElementById('error-text').textContent = 
                'Connection issues detected. Please check your internet and try again.';
              showState('error');
            } else {
              // Retry after 5 seconds
              setTimeout(checkStatus, 5000);
            }
          }
        }
        
        // Start checking after 3 seconds (give webhook time to arrive)
        setTimeout(checkStatus, 3000);
      </script>
    </body>
    </html>
    `;
    
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
    
  } catch (error) {
    console.error('Success page error:', error.message);
    res.status(500).send('Error loading page. Please contact support: 07037412314');
  }
});

// ========== SIMPLE STATUS CHECK ==========
app.get('/api/check-status', async (req, res) => {
  try {
    const { ref } = req.query;
    
    if (!ref) {
      return res.json({ ready: false, message: 'No reference provided' });
    }
    
    const result = await pool.query(
      `SELECT mikrotik_username, mikrotik_password, plan, status
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

// ========== ERROR HANDLER ==========
app.use((err, req, res, next) => {
  console.error('💥 Uncaught error:', err.message);
  res.status(500).send('Server Error. Please contact support: 07037412314');
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


