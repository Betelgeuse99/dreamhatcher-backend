require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const https = require('https');
const axios = require('axios');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

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

// ========== GLOBAL ERROR HANDLERS ==========
process.on('uncaughtException', (error) => {
  console.error('💥 UNCAUGHT EXCEPTION:', error);
  // Don't exit in production, log and continue
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION at:', promise, 'reason:', reason);
  // Don't exit in production, log and continue
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

// ========== KEEP ALIVE (prevents Render sleep) ==========
function keepAlive() {
  https.get('https://dreamhatcher-backend.onrender.com/health', (res) => {
    console.log('🏓 Keep-alive ping, status:', res.statusCode);
  }).on('error', (err) => {
    console.log('🏓 Keep-alive error:', err.message);
  });
}
setInterval(keepAlive, 14 * 60 * 1000);

// ========== ERROR HANDLING & TIMEOUT ==========
app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    console.log(`⏰ Timeout on ${req.method} ${req.url}`);
  });
  next();
});

// ========== PAYMENT REDIRECT (With Email & MAC) ==========
app.get('/pay/:plan', async (req, res) => {
  const { plan } = req.params;
  const mac = req.query.mac || 'unknown';
  const email = req.query.email || 'customer@dreamhatcher.com';
  
  // Plan configuration - CHANGE PRICES HERE
  const planConfig = {
    daily: { amount: 350, code: '24hr' },
    weekly: { amount: 2400, code: '7d' },
    monthly: { amount: 7500, code: '30d' }
  };
  
  const selectedPlan = planConfig[plan];
  
  if (!selectedPlan) {
    return res.status(400).send('Invalid plan selected');
  }
  
  try {
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: email,
        amount: selectedPlan.amount * 100,
        callback_url: 'https://dreamhatcher-backend.onrender.com/paystack-callback',
        metadata: {
          mac_address: mac,
          plan: selectedPlan.code
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log(`💳 Payment init: ${plan} | MAC: ${mac} | Email: ${email}`);
    
    // Redirect user directly to Paystack checkout
    res.redirect(response.data.data.authorization_url);
    
  } catch (error) {
    console.error('Payment redirect error:', error.response?.data || error.message);
    res.send(`
      <html>
        <body style="font-family: Arial; text-align: center; padding: 50px; background: #1a1a2e; color: white;">
          <h2>⚠️ Payment Error</h2>
          <p>Could not initialize payment. Please try again.</p>
          <a href="javascript:history.back()" style="color: #00d4ff;">← Go Back</a>
          <p style="margin-top: 20px;">Support: 07037412314</p>
        </body>
      </html>
    `);
  }
});

// ========== REQUEST LOGGING (Skip MikroTik polling endpoints) ==========
app.use((req, res, next) => {
  const start = Date.now();
  
  // Skip logging for MikroTik polling endpoints to reduce noise
  if (!req.url.includes('/api/mikrotik-queue-text') && 
      !req.url.includes('/api/expired-users') &&
      !req.url.includes('/api/check-status') &&
      !req.url.includes('/health')) {
    console.log(`📥 ${req.method} ${req.url}`);
  }
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    // Skip logging for MikroTik polling endpoints
    if (!req.url.includes('/api/mikrotik-queue-text') && 
        !req.url.includes('/api/expired-users') &&
        !req.url.includes('/api/check-status') &&
        !req.url.includes('/health')) {
      console.log(`📤 ${req.method} ${req.url} ${res.statusCode} - ${duration}ms`);
    }
  });
  
  next();
});

// ========== NEW: INITIALIZE PAYSTACK PAYMENT (Dynamic Checkout) ==========
app.post('/api/initialize-payment', async (req, res) => {
  try {
    const { email, amount, plan, mac_address } = req.body;

    if (!amount || !plan) {
      return res.status(400).json({ error: 'Missing amount or plan' });
    }

    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: email || 'customer@example.com',
        amount: amount * 100, // Paystack uses kobo
        callback_url: 'https://dreamhatcher-backend.onrender.com/paystack-callback',
        metadata: {
          mac_address: mac_address || 'unknown',
          plan: plan
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({
      success: true,
      authorization_url: response.data.data.authorization_url
    });

  } catch (error) {
    console.error('❌ Paystack initialize error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to initialize payment' });
  }
});

// ========== PAYSTACK WEBHOOK ==========
app.post('/api/paystack-webhook', async (req, res) => {
  console.log('📥 Paystack webhook received');

  // Verify webhook signature (recommended)
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const hash = crypto.createHmac('sha512', secret).update(req.rawBody).digest('hex');
  if (hash !== req.headers['x-paystack-signature']) {
    console.log('❌ Invalid webhook signature');
    return res.status(400).send('Invalid signature');
  }

  try {
    const { event, data } = req.body;

    if (event !== 'charge.success') {
      return res.status(200).json({ received: true });
    }

    const { reference, amount, metadata } = data;
    const amountNaira = amount / 100;
    const macAddress = metadata?.mac_address || 'unknown';
    const planFromMetadata = metadata?.plan;

    // Determine plan: prefer metadata, fallback to amount
    let plan = planFromMetadata;
    if (!plan) {
      if (amountNaira === 350) plan = '24hr';
      else if (amountNaira === 2400) plan = '7d';
      else if (amountNaira === 7500) plan = '30d';
      else {
        console.error('❌ Invalid amount:', amountNaira);
        return res.status(400).json({ error: 'Invalid amount' });
      }
    }

    const username = `user_${Date.now().toString().slice(-6)}`;
    const password = generatePassword();

    // Calculate exact expiry timestamp based on plan
    let expiresAt;
    const now = new Date();
    if (plan === '24hr') {
      expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +24 hours
    } else if (plan === '7d') {
      expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // +7 days
    } else if (plan === '30d') {
      expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // +30 days
    }

    await pool.query(
      `INSERT INTO payment_queue
       (transaction_id, customer_email, customer_phone, plan,
        mikrotik_username, mikrotik_password, mac_address, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
      [
        reference,
        data.customer?.email || 'unknown@example.com',
        data.customer?.phone || '',
        plan,
        username,
        password,
        macAddress,
        expiresAt
      ]
    );

    console.log(`✅ Queued user ${username} | Expires: ${expiresAt.toISOString()}`);
    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('❌ Webhook error:', error.message);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ========== PAYSTACK CALLBACK (20-second waiting page) ==========
app.get('/paystack-callback', (req, res) => {
  const { reference, trxref } = req.query;
  const ref = reference || trxref || 'unknown';

  console.log('🔗 Paystack callback:', ref);

  const html = ` 
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Creating Your Account...</title>
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
        max-width: 420px;
        width: 100%;
        text-align: center;
        border: 1px solid rgba(255,255,255,0.1);
      }
      .success-badge {
        background: linear-gradient(135deg, #00c9ff 0%, #92fe9d 100%);
        color: #000;
        padding: 10px 25px;
        border-radius: 50px;
        font-weight: bold;
        display: inline-block;
        margin-bottom: 20px;
      }
      .spinner-container {
        position: relative;
        width: 120px;
        height: 120px;
        margin: 30px auto;
      }
      .spinner {
        border: 4px solid rgba(255,255,255,0.1);
        border-top: 4px solid #00c9ff;
        border-radius: 50%;
        width: 120px;
        height: 120px;
        animation: spin 1.5s linear infinite;
      }
      .countdown-number {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        font-size: 36px;
        font-weight: bold;
        color: #00c9ff;
      }
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      .progress-bar {
        background: rgba(255,255,255,0.1);
        border-radius: 10px;
        height: 10px;
        margin: 25px 0;
        overflow: hidden;
      }
      .progress-fill {
        background: linear-gradient(90deg, #00c9ff, #92fe9d);
        height: 100%;
        width: 0%;
        transition: width 1s linear;
      }
      h2 { color: #00c9ff; margin-bottom: 15px; }
      .status-text { margin: 15px 0; line-height: 1.6; }
      .steps {
        text-align: left;
        background: rgba(0,0,0,0.2);
        padding: 15px 20px;
        border-radius: 10px;
        margin: 20px 0;
        font-size: 14px;
      }
      .step {
        padding: 8px 0;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .step-icon {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        flex-shrink: 0;
      }
      .step-pending { background: rgba(255,255,255,0.2); }
      .step-active { background: #00c9ff; animation: pulse 1s infinite; }
      .step-done { background: #92fe9d; color: #000; }
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
      .ref-box {
        background: rgba(0,0,0,0.3);
        padding: 10px;
        border-radius: 8px;
        font-size: 12px;
        margin-top: 20px;
        word-break: break-all;
      }
      .warning {
        background: rgba(255,200,0,0.2);
        border: 1px solid rgba(255,200,0,0.5);
        padding: 15px;
        border-radius: 10px;
        margin-top: 20px;
        font-size: 13px;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="success-badge">✓ PAYMENT RECEIVED</div>
      
      <h2>Creating Your WiFi Account</h2>
      
      <div class="spinner-container">
        <div class="spinner"></div>
        <div class="countdown-number" id="countdown">20</div>
      </div>
      
      <div class="progress-bar">
        <div class="progress-fill" id="progress"></div>
      </div>
      
      <p class="status-text" id="status">Please wait while we set up your account...</p>
      
      <div class="steps">
        <div class="step" id="step1">
          <div class="step-icon step-active" id="icon1">1</div>
          <span>Verifying payment with Paystack...</span>
        </div>
        <div class="step" id="step2">
          <div class="step-icon step-pending" id="icon2">2</div>
          <span>Creating WiFi credentials...</span>
        </div>
        <div class="step" id="step3">
          <div class="step-icon step-pending" id="icon3">3</div>
          <span>Activating on Server...</span>
        </div>
        <div class="step" id="step4">
          <div class="step-icon step-pending" id="icon4">4</div>
          <span>Ready to connect!</span>
        </div>
      </div>
      
      <div class="warning">
        ⚠️ <strong>Do NOT close this page!</strong><br>
        Your account is being created. This takes about 20 seconds.
      </div>
      
      <div class="ref-box">
        Reference: <strong>${ref || 'N/A'}</strong>
      </div>
    </div>
    
    <script>
      const totalSeconds = 20;
      let seconds = totalSeconds;
      const countdownEl = document.getElementById('countdown');
      const progressEl = document.getElementById('progress');
      const statusEl = document.getElementById('status');
      
      function updateStep(stepNum, state) {
        const icon = document.getElementById('icon' + stepNum);
        icon.className = 'step-icon step-' + state;
        if (state === 'done') {
          icon.textContent = '✓';
        }
      }
      
      const messages = [
        { time: 20, msg: 'Connecting to payment server...', step: 1 },
        { time: 17, msg: 'Payment verified successfully!', step: 1, done: true },
        { time: 15, msg: 'Generating your unique credentials...', step: 2 },
        { time: 12, msg: 'Credentials created!', step: 2, done: true },
        { time: 10, msg: 'Sending to server...', step: 3 },
        { time: 7, msg: 'Activating your account on server...', step: 3 },
        { time: 5, msg: 'Almost done! Finalizing...', step: 3, done: true },
        { time: 3, msg: 'Account ready! Redirecting...', step: 4, done: true }
      ];
      
      let lastStep = 0;
      
      const timer = setInterval(function() {
        seconds--;
        countdownEl.textContent = seconds;
        
        const progress = ((totalSeconds - seconds) / totalSeconds) * 100;
        progressEl.style.width = progress + '%';
        
        // Update messages and steps based on time
        for (let i = 0; i < messages.length; i++) {
          if (seconds <= messages[i].time && seconds > (messages[i+1]?.time || 0)) {
            statusEl.textContent = messages[i].msg;
            
            if (messages[i].step > lastStep) {
              updateStep(messages[i].step, 'active');
              lastStep = messages[i].step;
            }
            
            if (messages[i].done) {
              updateStep(messages[i].step, 'done');
              if (messages[i].step < 4) {
                updateStep(messages[i].step + 1, 'active');
              }
            }
            break;
          }
        }
        
        if (seconds <= 0) {
          clearInterval(timer);
          countdownEl.textContent = '✓';
          statusEl.textContent = 'Redirecting to your credentials...';
          window.location.href = '/success?reference=' + encodeURIComponent('${ref || ''}');
        }
      }, 1000);
    </script>
  </body>
  </html>
  `;

  res.send(html.replace('${ref || \'\'}', ref));
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
            <div class="credential-label">Expires</div>
            <div class="credential" id="expires-display">---</div>
          </div>
          
          <div class="steps">
            <h4>📶 How to Connect</h4>
            <ol>
              <li>Connect to <strong>Dream Hatcher WiFi</strong> network</li>
              <li>A login page will open automatically or a pop-up window </li>
              <li>If not, open browser and type:<br><strong>dreamhatcher.login</strong></li>
              <li>Enter your username and password above</li>
              <li>Click Login and enjoy!</li>
            </ol>
          </div>
          
         <button class="btn" onclick="copyCredentials()">📋 Copy Credentials</button>
          <button class="btn" id="autoLoginBtn" onclick="autoLogin()" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%);">🚀 Auto-Login Now</button>

          <div id="autoLoginStatus" style="margin-top: 15px; padding: 15px; background: rgba(0,0,0,0.3); border-radius: 10px; display: none;">
            <p id="autoLoginText">⏳ Auto-connecting in <span id="autoLoginCountdown">8</span> seconds...</p>
          </div>
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
        const maxChecks = 20;
        let credentials = { username: '', password: '', plan: '', expires_at: '' };
        
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
        
        let autoLoginTimer = null;
        let autoLoginCountdown = 8;
        const HOTSPOT_LOGIN_URL = 'http://192.168.88.1/login';

        function startAutoLoginCountdown() {
          document.getElementById('autoLoginStatus').style.display = 'block';

          autoLoginTimer = setInterval(function() {
            autoLoginCountdown--;
            document.getElementById('autoLoginCountdown').textContent = autoLoginCountdown;

            if (autoLoginCountdown <= 0) {
              clearInterval(autoLoginTimer);
              autoLogin();
            }
          }, 1000);
        }

        function autoLogin() {
          if (autoLoginTimer) {
            clearInterval(autoLoginTimer);
          }

          if (!credentials.username || !credentials.password) {
            document.getElementById('autoLoginText').innerHTML = '❌ Credentials not ready. Please copy and login manually.';
            return;
          }

          document.getElementById('autoLoginText').innerHTML = '🔄 Connecting to WiFi login page...';
          document.getElementById('autoLoginBtn').disabled = true;
          document.getElementById('autoLoginBtn').textContent = '⏳ Connecting...';

          const loginUrl = HOTSPOT_LOGIN_URL +
            '?username=' + encodeURIComponent(credentials.username) +
            '&password=' + encodeURIComponent(credentials.password) +
            '&auto=1';

          try {
            window.location.href = loginUrl;

            setTimeout(function() {
              if (document.getElementById('autoLoginText')) {
                document.getElementById('autoLoginText').innerHTML =
                  '⚠️ Auto-login may have opened in a new tab. ' +
                  '<br>If not connected, <a href="' + loginUrl + '" target="_blank" style="color: #00c9ff;">click here</a> or login manually.';
                document.getElementById('autoLoginBtn').disabled = false;
                document.getElementById('autoLoginBtn').textContent = '🔄 Try Again';
              }
            }, 3000);

          } catch (e) {
            window.open(loginUrl, '_blank');
            document.getElementById('autoLoginText').innerHTML =
              '✅ Login page opened! Check new tab/window.';
          }
        }
        
        function copyCredentials() {
          const text = 'Username: ' + credentials.username + '\\nPassword: ' + credentials.password + '\\nPlan: ' + credentials.plan + '\\nExpires: ' + credentials.expires_at;
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
              credentials = {
                username: data.username,
                password: data.password,
                plan: data.plan || 'WiFi Access',
                expires_at: data.expires_at ? new Date(data.expires_at).toLocaleString('en-NG', { 
                  year: 'numeric', 
                  month: 'short', 
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                }) : 'Not set'
              };
              
              document.getElementById('username-display').textContent = credentials.username;
              document.getElementById('password-display').textContent = credentials.password;
              document.getElementById('plan-display').textContent = credentials.plan;
              document.getElementById('expires-display').textContent = credentials.expires_at;

              showState('credentials');
              setTimeout(startAutoLoginCountdown, 1000);
              
            } else if (checkCount >= maxChecks) {
              document.getElementById('error-text').textContent = 
                'Your payment was received but account creation is taking longer than expected. ' +
                'Please wait a few minutes and try the "Check Again" button, or contact support.';
              showState('error');
              
            } else {
              if (data.status === 'pending') {
                statusText.textContent = 'Account queued, waiting for MikroTik to create user...';
              } else if (data.status === 'processed') {
                statusText.textContent = 'Account created! Loading credentials...';
              } else {
                statusText.textContent = data.message || 'Processing your payment...';
              }
              
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
              setTimeout(checkStatus, 5000);
            }
          }
        }
        
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
      `SELECT mikrotik_username, mikrotik_password, plan, status, mac_address, expires_at
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
          expires_at: user.expires_at,
          message: 'Credentials ready'
        });
      } else {
        return res.json({
          ready: false,
          status: user.status,
          expires_at: user.expires_at,
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
    
    if (!apiKey || apiKey !== process.env.MIKROTIK_API_KEY) {
      console.warn('❌ Invalid or missing API key');
      return res.status(403).send('FORBIDDEN');
    }

    const result = await pool.query(`
      SELECT id, mikrotik_username, mikrotik_password, plan, mac_address, expires_at
      FROM payment_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 5
    `);

    if (result.rows.length === 0) {
      return res.send('');
    }

    console.log(`📤 Preparing ${result.rows.length} users for MikroTik`);
    
    // Format: username|password|plan|mac|expires_at|id
    const lines = result.rows.map(row => {
      const expires = row.expires_at ? row.expires_at.toISOString() : '';
      return [
        row.mikrotik_username || '',
        row.mikrotik_password || '',
        row.plan || '',
        row.mac_address || 'unknown',
        expires,
        row.id
      ].join('|');
    });

    const output = lines.join('\n');
    console.log(`✅ Sending ${result.rows.length} users to MikroTik`);
    
    res.set('Content-Type', 'text/plain');
    res.send(output);
    
  } catch (error) {
    console.error('❌ MikroTik queue error:', error.message, error.stack);
    // Send empty response instead of ERROR to avoid breaking MikroTik
    res.set('Content-Type', 'text/plain');
    res.send('');
  }
});

app.post('/api/mark-processed/:id', async (req, res) => {
  try {
    console.log(`🔄 Processing mark-processed for: ${req.params.id}`);
    let userId = req.params.id;
    
    // Extract ID from pipe-separated string if needed
    if (userId.includes('|')) {
      const parts = userId.split('|');
      // ID should be the LAST element in our format
      userId = parts[parts.length - 1];
      console.log(`📝 Extracted ID from string: ${userId} (full: ${req.params.id})`);
    }
    
    const idNum = parseInt(userId);
    
    if (isNaN(idNum)) {
      console.error('❌ Invalid ID format for mark-processed:', userId);
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid user ID format' 
      });
    }
    
    const result = await pool.query(
      `UPDATE payment_queue SET status = 'processed' WHERE id = $1 RETURNING id`,
      [idNum]
    );
    
    if (result.rowCount === 0) {
      console.warn(`⚠️ No user found with ID: ${idNum}`);
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    console.log(`✅ Successfully marked ${idNum} as processed`);
    res.json({ 
      success: true,
      id: idNum
    });
    
  } catch (error) {
    console.error('❌ Mark-processed error:', error.message, error.stack);
    res.status(500).json({ 
      success: false, 
      error: 'Database update failed' 
    });
  }
});

// ========== GET EXPIRED USERS (for MikroTik to disable) ==========
app.get('/api/expired-users', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    
    if (!apiKey || apiKey !== process.env.MIKROTIK_API_KEY) {
      console.warn('❌ Invalid or missing API key for expired users');
      return res.status(403).send('FORBIDDEN');
    }

    const result = await pool.query(`
      SELECT id, mikrotik_username, mac_address, expires_at
      FROM payment_queue
      WHERE status = 'processed'
      AND expires_at IS NOT NULL
      AND expires_at < NOW()
      LIMIT 20
    `);

    if (result.rows.length === 0) {
      return res.send('');
    }

    // Format: username|mac_address|expires_at|id
    const lines = result.rows.map(row => [
      row.mikrotik_username || 'unknown',
      row.mac_address || 'unknown',
      row.expires_at.toISOString(),
      row.id  // ID is last
    ].join('|'));

    const output = lines.join('\n');
    
    res.set('Content-Type', 'text/plain');
    res.send(output);

  } catch (error) {
    console.error('❌ Expired users query error:', error.message, error.stack);
    // Send empty response instead of ERROR to avoid breaking MikroTik
    res.set('Content-Type', 'text/plain');
    res.send('');
  }
});

// ========== MARK USER AS EXPIRED ==========
app.post('/api/mark-expired/:id', async (req, res) => {
  try {
    console.log(`🔄 Processing mark-expired for: ${req.params.id}`);
    let userId = req.params.id;
    
    // Extract ID from pipe-separated string if needed
    if (userId.includes('|')) {
      const parts = userId.split('|');
      // ID should be the LAST element in our format
      userId = parts[parts.length - 1];
      console.log(`📝 Extracted expired ID from string: ${userId} (full: ${req.params.id})`);
    }
    
    const idNum = parseInt(userId);
    
    if (isNaN(idNum) || idNum <= 0) {
      console.error('❌ Invalid ID format for mark-expired:', userId);
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid user ID' 
      });
    }
    
    const result = await pool.query(
      `UPDATE payment_queue SET status = 'expired' WHERE id = $1 RETURNING id`,
      [idNum]
    );
    
    if (result.rowCount === 0) {
      console.warn(`⚠️ No user found with ID for mark-expired: ${idNum}`);
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    console.log(`⏰ Successfully marked ${idNum} as expired`);
    res.json({ 
      success: true,
      id: idNum
    });
    
  } catch (error) {
    console.error('❌ Mark-expired error:', error.message, error.stack);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to mark as expired' 
    });
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

// ========== ROOT PAGE - CUSTOMER FACING ==========
app.get('/', (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dream Hatcher Tech - WiFi Portal</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
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
        border-radius: 24px;
        max-width: 500px;
        width: 100%;
        text-align: center;
        border: 1px solid rgba(255,255,255,0.1);
        box-shadow: 0 25px 50px rgba(0,0,0,0.5);
      }
      .logo {
        font-size: 48px;
        margin-bottom: 20px;
        color: #00c9ff;
      }
      h1 {
        font-size: 28px;
        margin-bottom: 10px;
        color: #00c9ff;
      }
      .status-badge {
        background: linear-gradient(135deg, #00c9ff 0%, #92fe9d 100%);
        color: #000;
        padding: 8px 20px;
        border-radius: 50px;
        font-weight: 800;
        display: inline-block;
        margin: 15px 0;
        font-size: 14px;
      }
      .option-card {
        background: rgba(255,255,255,0.1);
        padding: 20px;
        border-radius: 15px;
        margin: 20px 0;
        text-align: left;
        border: 1px solid rgba(255,255,255,0.1);
      }
      .option-card h3 {
        color: #00c9ff;
        margin-bottom: 10px;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .btn {
        background: linear-gradient(135deg, #00c9ff 0%, #92fe9d 100%);
        color: #000;
        border: none;
        padding: 14px 28px;
        border-radius: 50px;
        font-size: 16px;
        font-weight: 800;
        cursor: pointer;
        margin: 10px 0;
        text-decoration: none;
        display: inline-block;
        transition: transform 0.3s;
      }
      .btn:hover {
        transform: translateY(-2px);
      }
      .support-box {
        background: rgba(255,200,0,0.1);
        border: 1px solid rgba(255,200,0,0.3);
        padding: 20px;
        border-radius: 15px;
        margin: 25px 0;
        font-size: 14px;
      }
      .qr-section {
        margin: 25px 0;
        padding: 20px;
        background: rgba(0,0,0,0.2);
        border-radius: 15px;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="logo">🌐</div>
      <h1>Dream Hatcher Tech</h1>
      <p>High-Speed Business WiFi Solutions</p>
      
      <div class="status-badge">✅ SYSTEM OPERATIONAL</div>
      
      <div class="option-card">
        <h3>📱 <span>Already on our WiFi?</span></h3>
        <p>If you're connected to <strong>Dream Hatcher WiFi</strong> network:</p>
        <a href="http://192.168.88.1" class="btn">Go to WiFi Login Page</a>
        <p style="margin-top: 10px; font-size: 12px; color: #aaa;">
          Or enter in browser: <code>192.168.88.1</code>
        </p>
      </div>
      
      <div class="option-card">
        <h3>💰 <span>Need WiFi Access?</span></h3>
        <p>Purchase WiFi packages starting at ₦350/day:</p>
        <a href="http://192.168.88.1/hotspotlogin.html" class="btn">View WiFi Plans & Pricing</a>
      </div>
      
      <div class="option-card">
        <h3>✅ <span>Already Paid?</span></h3>
        <p>Check your payment status and get credentials:</p>
        <a href="/success" class="btn">Check Payment Status</a>
      </div>
      
      <div class="qr-section">
        <h3>📲 Quick Connect QR</h3>
        <p>Scan to open WiFi login:</p>
        <div style="background: white; padding: 10px; display: inline-block; border-radius: 10px;">
          <div id="qrcode"></div>
        </div>
        <p style="font-size: 12px; margin-top: 10px; color: #aaa;">
          Scan with phone camera
        </p>
      </div>
      
      <div class="support-box">
        <h3>📞 Need Help?</h3>
        <p style="font-size: 18px; font-weight: bold; color: #00c9ff;">07037412314</p>
        <p style="font-size: 12px; color: #aaa;">24/7 Customer Support</p>
        <p style="margin-top: 10px; font-size: 12px;">
          Email: support@dreamhatcher-tech1.xo.je<br>
          Website: dreamhatcher-tech1.xo.je
        </p>
      </div>
      
      <p style="margin-top: 20px; font-size: 12px; color: #888;">
        © 2024 Dream Hatcher Tech. All rights reserved.<br>
        Secure Payment Processing via Paystack
      </p>
    </div>
    
    <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
    <script>
      QRCode.toCanvas(document.getElementById('qrcode'), 'http://192.168.88.1', {
        width: 150,
        margin: 1,
        color: {
          dark: '#000000',
          light: '#ffffff'
        }
      });
    </script>
  </body>
  </html>
  `;
  
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ============================================
// ADMIN DASHBOARD v3.0 - INDUSTRIAL GRADE
// Add this to your index.js (replace old /admin route)
// ============================================

// Admin configuration
const ADMIN_PASSWORD = 'dreamhatcher2024'; // CHANGE THIS!
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes in milliseconds

// ========== ADMIN DASHBOARD ==========
app.get('/admin', async (req, res) => {
  const { pwd, action, userId, newPlan, format } = req.query;

  // Password check
  if (pwd !== ADMIN_PASSWORD) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Admin Login - Dream Hatcher</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            background: #0f0f14;
            color: white;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            overflow: hidden;
          }
          body::before {
            content: '';
            position: absolute;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background:
              radial-gradient(circle at 20% 80%, rgba(0, 212, 255, 0.08) 0%, transparent 50%),
              radial-gradient(circle at 80% 20%, rgba(138, 43, 226, 0.08) 0%, transparent 50%),
              radial-gradient(circle at 40% 40%, rgba(0, 255, 136, 0.05) 0%, transparent 40%);
            animation: pulse 15s ease-in-out infinite;
          }
          @keyframes pulse {
            0%, 100% { transform: scale(1) rotate(0deg); }
            50% { transform: scale(1.1) rotate(5deg); }
          }
          .box {
            background: rgba(20, 20, 30, 0.9);
            backdrop-filter: blur(20px);
            padding: 50px;
            border-radius: 24px;
            text-align: center;
            border: 1px solid rgba(255,255,255,0.1);
            max-width: 420px;
            width: 90%;
            position: relative;
            z-index: 1;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
          }
          .logo {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #00d4ff, #8b5cf6);
            border-radius: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 36px;
            margin: 0 auto 24px;
            box-shadow: 0 10px 40px rgba(0, 212, 255, 0.3);
          }
          h2 {
            color: #fff;
            margin-bottom: 8px;
            font-size: 24px;
            font-weight: 700;
          }
          .subtitle {
            color: #64748b;
            font-size: 14px;
            margin-bottom: 32px;
          }
          input {
            padding: 16px 20px;
            border-radius: 12px;
            border: 2px solid rgba(255,255,255,0.1);
            background: rgba(255,255,255,0.05);
            color: white;
            font-size: 16px;
            width: 100%;
            margin: 10px 0;
            transition: all 0.3s ease;
          }
          input:focus {
            outline: none;
            border-color: #00d4ff;
            background: rgba(0, 212, 255, 0.05);
          }
          input::placeholder { color: #64748b; }
          button {
            padding: 16px 40px;
            background: linear-gradient(135deg, #00d4ff, #0066ff);
            border: none;
            border-radius: 12px;
            color: white;
            font-weight: 600;
            font-size: 16px;
            cursor: pointer;
            width: 100%;
            margin-top: 15px;
            transition: all 0.3s ease;
            position: relative;
            overflow: hidden;
          }
          button::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
            transition: 0.5s;
          }
          button:hover::before { left: 100%; }
          button:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(0, 212, 255, 0.3); }
          .footer { margin-top: 30px; font-size: 12px; color: #475569; }
          .version {
            display: inline-block;
            background: rgba(0, 212, 255, 0.1);
            color: #00d4ff;
            padding: 4px 10px;
            border-radius: 20px;
            font-size: 11px;
            margin-top: 8px;
          }
        </style>
      </head>
      <body>
        <div class="box">
          <div class="logo">🔐</div>
          <h2>Admin Access</h2>
          <p class="subtitle">Dream Hatcher Control Center</p>
          <form method="GET">
            <input type="password" name="pwd" placeholder="Enter admin password" required autofocus>
            <button type="submit">Authenticate →</button>
          </form>
          <div class="footer">
            Secure Administrative Portal
            <div class="version">v3.0 Industrial</div>
          </div>
        </div>
      </body>
      </html>
    `);
  }

  try {
    // Handle admin actions
    let actionMessage = '';

    if (action === 'delete' && userId) {
      await pool.query('DELETE FROM payment_queue WHERE id = $1', [userId]);
      actionMessage = '✅ User deleted successfully';
    }

    if (action === 'extend' && userId && newPlan) {
      await pool.query('UPDATE payment_queue SET plan = $1, created_at = NOW() WHERE id = $2', [newPlan, userId]);
      actionMessage = '✅ User plan extended successfully';
    }

    if (action === 'reset' && userId) {
      await pool.query('UPDATE payment_queue SET status = $1 WHERE id = $2', ['pending', userId]);
      actionMessage = '✅ User reset to pending (will be re-created on MikroTik)';
    }

    if (action === 'cleanup') {
      const result = await pool.query(\`
        DELETE FROM payment_queue
        WHERE status = 'processed'
        AND (
          (plan = '24hr' AND created_at + INTERVAL '24 hours' < NOW())
          OR (plan = '7d' AND created_at + INTERVAL '7 days' < NOW())
          OR (plan = '30d' AND created_at + INTERVAL '30 days' < NOW())
        )
      \`);
      actionMessage = \`✅ Cleaned up \${result.rowCount} expired users\`;
    }

    // Get statistics
    const stats = await pool.query(\`
      SELECT
        COUNT(*) as total_payments,
        COUNT(*) FILTER (WHERE status = 'processed') as processed,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) as today_count,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days') as week_count,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '30 days') as month_count
      FROM payment_queue
    \`);

    // Revenue calculations
    const revenue = await pool.query(\`
      SELECT
        COALESCE(SUM(CASE WHEN plan = '24hr' THEN 350 WHEN plan = '7d' THEN 2400 WHEN plan = '30d' THEN 7500 ELSE 0 END), 0) as total_revenue,
        COALESCE(SUM(CASE WHEN created_at >= CURRENT_DATE THEN (CASE WHEN plan = '24hr' THEN 350 WHEN plan = '7d' THEN 2400 WHEN plan = '30d' THEN 7500 ELSE 0 END) ELSE 0 END), 0) as today_revenue,
        COALESCE(SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' THEN (CASE WHEN plan = '24hr' THEN 350 WHEN plan = '7d' THEN 2400 WHEN plan = '30d' THEN 7500 ELSE 0 END) ELSE 0 END), 0) as week_revenue,
        COALESCE(SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN (CASE WHEN plan = '24hr' THEN 350 WHEN plan = '7d' THEN 2400 WHEN plan = '30d' THEN 7500 ELSE 0 END) ELSE 0 END), 0) as month_revenue
      FROM payment_queue WHERE status = 'processed'
    \`);

    // Plan breakdown
    const plans = await pool.query(\`
      SELECT plan, COUNT(*) as count FROM payment_queue WHERE status = 'processed' GROUP BY plan
    \`);

    // Daily revenue for chart (last 7 days)
    const dailyRevenue = await pool.query(\`
      SELECT
        DATE(created_at) as date,
        COALESCE(SUM(CASE WHEN plan = '24hr' THEN 350 WHEN plan = '7d' THEN 2400 WHEN plan = '30d' THEN 7500 ELSE 0 END), 0) as revenue,
        COUNT(*) as signups
      FROM payment_queue
      WHERE status = 'processed' AND created_at >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY DATE(created_at)
      ORDER BY date
    \`);

    // All users (for export and display)
    const allUsers = await pool.query(\`
      SELECT
        id, mikrotik_username, mikrotik_password, plan, status, mac_address, customer_email, created_at,
        CASE
          WHEN status != 'processed' THEN 'pending'
          WHEN plan = '24hr' AND created_at + INTERVAL '24 hours' < NOW() THEN 'expired'
          WHEN plan = '7d' AND created_at + INTERVAL '7 days' < NOW() THEN 'expired'
          WHEN plan = '30d' AND created_at + INTERVAL '30 days' < NOW() THEN 'expired'
          ELSE 'active'
        END as real_status,
        CASE
          WHEN plan = '24hr' THEN created_at + INTERVAL '24 hours'
          WHEN plan = '7d' THEN created_at + INTERVAL '7 days'
          WHEN plan = '30d' THEN created_at + INTERVAL '30 days'
        END as expires_at
      FROM payment_queue
      ORDER BY created_at DESC
    \`);

    // ========== HANDLE EXPORT ==========
    if (format === 'csv' || format === 'excel') {
      const BOM = '\uFEFF'; // UTF-8 BOM for Excel compatibility
      const headers = ['Username', 'Password', 'Plan', 'Status', 'MAC Address', 'Email', 'Created', 'Expires'];

      const rows = allUsers.rows.map(row => {
        // Use clean text instead of emojis for Excel compatibility
        const planText = row.plan === '24hr' ? 'Daily (24hr)' : row.plan === '7d' ? 'Weekly (7 days)' : 'Monthly (30 days)';
        const statusText = row.real_status === 'active' ? 'ACTIVE' : row.real_status === 'expired' ? 'EXPIRED' : 'PENDING';

        return [
          row.mikrotik_username,
          row.mikrotik_password,
          planText,
          statusText,
          row.mac_address || 'N/A',
          row.customer_email || 'N/A',
          new Date(row.created_at).toISOString().slice(0, 19).replace('T', ' '),
          row.expires_at ? new Date(row.expires_at).toISOString().slice(0, 19).replace('T', ' ') : 'N/A'
        ];
      });

      const csvContent = BOM + [headers, ...rows]
        .map(row => row.map(cell => \`"\${String(cell).replace(/"/g, '""')}"\`).join(','))
        .join('\r\n');

      const filename = \`dreamhatcher_users_\${new Date().toISOString().slice(0,10)}.csv\`;

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', \`attachment; filename="\${filename}"\`);
      return res.send(csvContent);
    }

    const s = stats.rows[0];
    const r = revenue.rows[0];
    const planData = {};
    plans.rows.forEach(p => { planData[p.plan] = parseInt(p.count); });

    // Count by status
    const activeCount = allUsers.rows.filter(r => r.real_status === 'active').length;
    const expiredCount = allUsers.rows.filter(r => r.real_status === 'expired').length;
    const pendingCount = allUsers.rows.filter(r => r.real_status === 'pending').length;

    // Prepare chart data
    const chartLabels = dailyRevenue.rows.map(d => new Date(d.date).toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric' }));
    const chartRevenue = dailyRevenue.rows.map(d => parseInt(d.revenue));
    const chartSignups = dailyRevenue.rows.map(d => parseInt(d.signups));

    const html = \`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Admin Dashboard - Dream Hatcher</title>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <style>
        :root {
          --bg-primary: #0f0f14;
          --bg-secondary: #16161e;
          --bg-tertiary: #1e1e2a;
          --border: rgba(255,255,255,0.08);
          --text-primary: #f8fafc;
          --text-secondary: #94a3b8;
          --text-muted: #64748b;
          --accent-blue: #00d4ff;
          --accent-purple: #8b5cf6;
          --accent-green: #10b981;
          --accent-red: #ef4444;
          --accent-orange: #f59e0b;
          --accent-pink: #ec4899;
          --shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          background: var(--bg-primary);
          min-height: 100vh;
          color: var(--text-primary);
          line-height: 1.6;
        }

        /* Sidebar */
        .sidebar {
          position: fixed;
          left: 0;
          top: 0;
          bottom: 0;
          width: 260px;
          background: var(--bg-secondary);
          border-right: 1px solid var(--border);
          padding: 24px;
          display: flex;
          flex-direction: column;
          z-index: 100;
          transition: transform 0.3s ease;
        }
        .sidebar-header {
          display: flex;
          align-items: center;
          gap: 12px;
          padding-bottom: 24px;
          border-bottom: 1px solid var(--border);
          margin-bottom: 24px;
        }
        .sidebar-logo {
          width: 44px;
          height: 44px;
          background: linear-gradient(135deg, var(--accent-blue), var(--accent-purple));
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 20px;
        }
        .sidebar-title h1 { font-size: 16px; font-weight: 700; }
        .sidebar-title span { font-size: 11px; color: var(--text-muted); }
        .nav-section { margin-bottom: 24px; }
        .nav-section-title {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 12px;
        }
        .nav-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          border-radius: 10px;
          color: var(--text-secondary);
          text-decoration: none;
          font-size: 14px;
          font-weight: 500;
          transition: all 0.2s ease;
          margin-bottom: 4px;
          cursor: pointer;
        }
        .nav-item:hover { background: var(--bg-tertiary); color: var(--text-primary); }
        .nav-item.active { background: rgba(0, 212, 255, 0.1); color: var(--accent-blue); }
        .nav-item .icon { font-size: 18px; }
        .sidebar-footer {
          margin-top: auto;
          padding-top: 24px;
          border-top: 1px solid var(--border);
        }

        /* Main Content */
        .main {
          margin-left: 260px;
          padding: 24px 32px;
          min-height: 100vh;
        }

        /* Header */
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 32px;
          flex-wrap: wrap;
          gap: 16px;
        }
        .header-left h2 { font-size: 24px; font-weight: 700; }
        .header-left p { color: var(--text-muted); font-size: 14px; margin-top: 4px; }
        .header-right { display: flex; gap: 12px; align-items: center; }

        /* Buttons */
        .btn {
          padding: 10px 20px;
          border-radius: 10px;
          border: none;
          font-weight: 600;
          cursor: pointer;
          font-size: 13px;
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          transition: all 0.2s ease;
        }
        .btn:hover { transform: translateY(-1px); }
        .btn-primary { background: linear-gradient(135deg, var(--accent-blue), #0066ff); color: white; }
        .btn-primary:hover { box-shadow: 0 8px 25px rgba(0, 212, 255, 0.3); }
        .btn-danger { background: rgba(239, 68, 68, 0.15); color: var(--accent-red); border: 1px solid rgba(239, 68, 68, 0.3); }
        .btn-danger:hover { background: rgba(239, 68, 68, 0.25); }
        .btn-success { background: rgba(16, 185, 129, 0.15); color: var(--accent-green); border: 1px solid rgba(16, 185, 129, 0.3); }
        .btn-success:hover { background: rgba(16, 185, 129, 0.25); }
        .btn-secondary { background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border); }
        .btn-secondary:hover { background: rgba(255,255,255,0.1); }
        .btn-ghost { background: transparent; color: var(--text-secondary); }
        .btn-ghost:hover { background: var(--bg-tertiary); color: var(--text-primary); }

        /* Session Timer */
        .session-badge {
          background: rgba(245, 158, 11, 0.15);
          color: var(--accent-orange);
          padding: 8px 16px;
          border-radius: 10px;
          font-size: 13px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 8px;
          border: 1px solid rgba(245, 158, 11, 0.3);
        }
        .session-badge.warning { background: rgba(239, 68, 68, 0.15); color: var(--accent-red); border-color: rgba(239, 68, 68, 0.3); }

        /* Stats Grid */
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 20px;
          margin-bottom: 32px;
        }
        .stat-card {
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 16px;
          padding: 24px;
          position: relative;
          overflow: hidden;
          transition: all 0.3s ease;
        }
        .stat-card::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 3px;
          background: linear-gradient(90deg, var(--card-accent, var(--accent-blue)), transparent);
        }
        .stat-card:hover { transform: translateY(-4px); box-shadow: var(--shadow); }
        .stat-card.revenue { --card-accent: var(--accent-green); }
        .stat-card.users { --card-accent: var(--accent-blue); }
        .stat-card.active { --card-accent: var(--accent-purple); }
        .stat-card.expired { --card-accent: var(--accent-red); }
        .stat-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 16px;
        }
        .stat-icon {
          width: 48px;
          height: 48px;
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 22px;
        }
        .stat-icon.green { background: rgba(16, 185, 129, 0.15); }
        .stat-icon.blue { background: rgba(0, 212, 255, 0.15); }
        .stat-icon.purple { background: rgba(139, 92, 246, 0.15); }
        .stat-icon.red { background: rgba(239, 68, 68, 0.15); }
        .stat-icon.orange { background: rgba(245, 158, 11, 0.15); }
        .stat-trend {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 12px;
          font-weight: 600;
          padding: 4px 8px;
          border-radius: 6px;
        }
        .stat-trend.up { background: rgba(16, 185, 129, 0.15); color: var(--accent-green); }
        .stat-trend.down { background: rgba(239, 68, 68, 0.15); color: var(--accent-red); }
        .stat-value {
          font-size: 32px;
          font-weight: 800;
          line-height: 1;
          margin-bottom: 4px;
        }
        .stat-value.money { color: var(--accent-green); }
        .stat-label { color: var(--text-muted); font-size: 13px; }

        /* Cards */
        .card {
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 16px;
          margin-bottom: 24px;
          overflow: hidden;
        }
        .card-header {
          padding: 20px 24px;
          border-bottom: 1px solid var(--border);
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 12px;
        }
        .card-title {
          display: flex;
          align-items: center;
          gap: 12px;
          font-size: 16px;
          font-weight: 600;
        }
        .card-title .icon {
          width: 36px;
          height: 36px;
          background: var(--bg-tertiary);
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .card-body { padding: 24px; }

        /* Tools Grid */
        .tools-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 20px;
        }
        .tool-card {
          background: var(--bg-tertiary);
          border-radius: 14px;
          padding: 24px;
          border: 1px solid var(--border);
          transition: all 0.3s ease;
        }
        .tool-card:hover { border-color: rgba(0, 212, 255, 0.3); }
        .tool-header {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 12px;
        }
        .tool-icon {
          width: 42px;
          height: 42px;
          background: linear-gradient(135deg, rgba(0, 212, 255, 0.2), rgba(139, 92, 246, 0.2));
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
        }
        .tool-header h3 { font-size: 15px; font-weight: 600; }
        .tool-desc { color: var(--text-muted); font-size: 13px; margin-bottom: 16px; }
        .tool-card input, .tool-card select {
          width: 100%;
          padding: 12px 16px;
          border-radius: 10px;
          border: 1px solid var(--border);
          background: var(--bg-secondary);
          color: var(--text-primary);
          font-size: 14px;
          margin-bottom: 12px;
          transition: all 0.2s ease;
        }
        .tool-card input:focus, .tool-card select:focus {
          outline: none;
          border-color: var(--accent-blue);
          box-shadow: 0 0 0 3px rgba(0, 212, 255, 0.1);
        }
        .tool-card input::placeholder { color: var(--text-muted); }

        /* Table */
        .table-container { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; }
        th {
          padding: 14px 16px;
          text-align: left;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--text-muted);
          background: var(--bg-tertiary);
          border-bottom: 1px solid var(--border);
          white-space: nowrap;
        }
        td {
          padding: 16px;
          border-bottom: 1px solid var(--border);
          font-size: 14px;
          vertical-align: middle;
        }
        tr:hover td { background: rgba(255, 255, 255, 0.02); }
        tr:last-child td { border-bottom: none; }

        /* Badges */
        .badge {
          padding: 6px 12px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 600;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          white-space: nowrap;
        }
        .badge-active { background: rgba(16, 185, 129, 0.15); color: var(--accent-green); }
        .badge-expired { background: rgba(239, 68, 68, 0.15); color: var(--accent-red); }
        .badge-pending { background: rgba(245, 158, 11, 0.15); color: var(--accent-orange); }
        .badge-daily { background: rgba(59, 130, 246, 0.15); color: #3b82f6; }
        .badge-weekly { background: rgba(139, 92, 246, 0.15); color: var(--accent-purple); }
        .badge-monthly { background: rgba(236, 72, 153, 0.15); color: var(--accent-pink); }

        /* Actions */
        .actions { display: flex; gap: 8px; }
        .action-btn {
          width: 34px;
          height: 34px;
          border-radius: 8px;
          border: none;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.2s ease;
          background: var(--bg-tertiary);
          color: var(--text-secondary);
          text-decoration: none;
          font-size: 14px;
        }
        .action-btn:hover { background: rgba(255, 255, 255, 0.1); color: var(--text-primary); transform: scale(1.05); }
        .action-btn.extend:hover { background: rgba(16, 185, 129, 0.2); color: var(--accent-green); }
        .action-btn.delete:hover { background: rgba(239, 68, 68, 0.2); color: var(--accent-red); }

        /* Special text */
        .mac { font-family: 'SF Mono', 'Monaco', monospace; font-size: 12px; color: var(--text-muted); }
        .password {
          font-family: 'SF Mono', 'Monaco', monospace;
          color: var(--accent-orange);
          cursor: pointer;
          padding: 4px 8px;
          background: rgba(245, 158, 11, 0.1);
          border-radius: 6px;
          transition: all 0.2s ease;
        }
        .password:hover { background: rgba(245, 158, 11, 0.2); }
        .time { color: var(--text-muted); font-size: 13px; }

        /* Filters */
        .filters {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
          align-items: center;
        }
        .filter-group {
          display: flex;
          background: var(--bg-tertiary);
          border-radius: 10px;
          overflow: hidden;
          border: 1px solid var(--border);
        }
        .filter-btn {
          padding: 8px 16px;
          border: none;
          background: transparent;
          color: var(--text-secondary);
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s ease;
        }
        .filter-btn:hover { color: var(--text-primary); }
        .filter-btn.active { background: var(--accent-blue); color: white; }
        .search-input {
          background: var(--bg-tertiary);
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 10px 16px;
          color: var(--text-primary);
          font-size: 14px;
          min-width: 250px;
        }
        .search-input:focus {
          outline: none;
          border-color: var(--accent-blue);
        }

        /* Alert */
        .alert {
          padding: 16px 20px;
          border-radius: 12px;
          margin-bottom: 24px;
          display: flex;
          align-items: center;
          gap: 12px;
          animation: slideIn 0.3s ease;
        }
        @keyframes slideIn {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .alert-success {
          background: rgba(16, 185, 129, 0.1);
          border: 1px solid rgba(16, 185, 129, 0.3);
          color: var(--accent-green);
        }

        /* Chart Container */
        .chart-container {
          height: 250px;
          position: relative;
        }

        /* Modal */
        .modal {
          display: none;
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.7);
          backdrop-filter: blur(4px);
          z-index: 1000;
          align-items: center;
          justify-content: center;
        }
        .modal.active { display: flex; }
        .modal-content {
          background: var(--bg-secondary);
          border-radius: 20px;
          padding: 32px;
          max-width: 440px;
          width: 90%;
          border: 1px solid var(--border);
          box-shadow: var(--shadow);
          animation: modalIn 0.3s ease;
        }
        @keyframes modalIn {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
        .modal-header {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 20px;
        }
        .modal-icon {
          width: 48px;
          height: 48px;
          background: linear-gradient(135deg, rgba(0, 212, 255, 0.2), rgba(139, 92, 246, 0.2));
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 22px;
        }
        .modal-title h3 { font-size: 18px; font-weight: 600; }
        .modal-title p { color: var(--text-muted); font-size: 13px; margin-top: 2px; }

        /* Logout Overlay */
        .logout-overlay {
          display: none;
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(15, 15, 20, 0.98);
          z-index: 2000;
          align-items: center;
          justify-content: center;
          flex-direction: column;
        }
        .logout-overlay.active { display: flex; }
        .logout-icon {
          width: 80px;
          height: 80px;
          background: rgba(239, 68, 68, 0.15);
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 36px;
          margin-bottom: 24px;
        }
        .logout-overlay h2 { color: var(--text-primary); margin-bottom: 8px; }
        .logout-overlay p { color: var(--text-muted); margin-bottom: 24px; }

        /* Responsive */
        @media (max-width: 1200px) {
          .stats-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 900px) {
          .sidebar { transform: translateX(-100%); }
          .sidebar.open { transform: translateX(0); }
          .main { margin-left: 0; }
          .mobile-menu { display: flex !important; }
        }
        @media (max-width: 600px) {
          .stats-grid { grid-template-columns: 1fr; }
          .header { flex-direction: column; align-items: flex-start; }
          .tools-grid { grid-template-columns: 1fr; }
        }

        .mobile-menu {
          display: none;
          width: 44px;
          height: 44px;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 10px;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          font-size: 20px;
        }

        /* Keyboard shortcuts hint */
        .shortcuts {
          position: fixed;
          bottom: 20px;
          right: 20px;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 12px 16px;
          font-size: 12px;
          color: var(--text-muted);
          z-index: 50;
        }
        .shortcuts kbd {
          background: var(--bg-tertiary);
          padding: 2px 6px;
          border-radius: 4px;
          font-family: monospace;
          margin: 0 2px;
        }

        /* Pulse animation for live indicator */
        .live-indicator {
          display: flex;
          align-items: center;
          gap: 8px;
          color: var(--accent-green);
          font-size: 13px;
          font-weight: 500;
        }
        .live-dot {
          width: 8px;
          height: 8px;
          background: var(--accent-green);
          border-radius: 50%;
          animation: pulse 2s infinite;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      </style>
    </head>
    <body>
      <!-- Session timeout overlay -->
      <div class="logout-overlay" id="logoutOverlay">
        <div class="logout-icon">⏰</div>
        <h2>Session Expired</h2>
        <p>You've been logged out due to inactivity</p>
        <a href="/admin" class="btn btn-primary">🔐 Login Again</a>
      </div>

      <!-- Extend Plan Modal -->
      <div class="modal" id="extendModal">
        <div class="modal-content">
          <div class="modal-header">
            <div class="modal-icon">⏰</div>
            <div class="modal-title">
              <h3>Extend Plan</h3>
              <p>Update subscription for <strong id="extendUsername"></strong></p>
            </div>
          </div>
          <form id="extendForm" method="GET">
            <input type="hidden" name="pwd" value="\${pwd}">
            <input type="hidden" name="action" value="extend">
            <input type="hidden" name="userId" id="extendUserId">
            <select name="newPlan" style="width: 100%; padding: 14px; border-radius: 10px; margin-bottom: 20px; background: var(--bg-tertiary); border: 1px solid var(--border); color: white; font-size: 14px;">
              <option value="24hr">⚡ Daily — 24 hours</option>
              <option value="7d">🚀 Weekly — 7 days</option>
              <option value="30d">👑 Monthly — 30 days</option>
            </select>
            <div style="display: flex; gap: 12px;">
              <button type="button" class="btn btn-secondary" onclick="closeExtendModal()" style="flex: 1;">Cancel</button>
              <button type="submit" class="btn btn-success" style="flex: 1;">✓ Extend Plan</button>
            </div>
          </form>
        </div>
      </div>

      <!-- Confirm Modal -->
      <div class="modal" id="confirmModal">
        <div class="modal-content">
          <div class="modal-header">
            <div class="modal-icon" id="confirmIcon">⚠️</div>
            <div class="modal-title">
              <h3 id="confirmTitle">Confirm Action</h3>
              <p id="confirmMessage">Are you sure?</p>
            </div>
          </div>
          <div style="display: flex; gap: 12px;">
            <button class="btn btn-secondary" onclick="closeConfirmModal()" style="flex: 1;">Cancel</button>
            <a href="#" id="confirmLink" class="btn btn-danger" style="flex: 1; justify-content: center;">Confirm</a>
          </div>
        </div>
      </div>

      <!-- Sidebar -->
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-header">
          <div class="sidebar-logo">🌐</div>
          <div class="sidebar-title">
            <h1>Dream Hatcher</h1>
            <span>Admin Dashboard</span>
          </div>
        </div>

        <div class="nav-section">
          <div class="nav-section-title">Overview</div>
          <a class="nav-item active" onclick="scrollToSection('stats')">
            <span class="icon">📊</span> Dashboard
          </a>
          <a class="nav-item" onclick="scrollToSection('chart')">
            <span class="icon">📈</span> Analytics
          </a>
        </div>

        <div class="nav-section">
          <div class="nav-section-title">Management</div>
          <a class="nav-item" onclick="scrollToSection('tools')">
            <span class="icon">🛠️</span> Admin Tools
          </a>
          <a class="nav-item" onclick="scrollToSection('users')">
            <span class="icon">👥</span> All Users
          </a>
        </div>

        <div class="nav-section">
          <div class="nav-section-title">Quick Actions</div>
          <a class="nav-item" href="/admin?pwd=\${pwd}&format=csv">
            <span class="icon">📥</span> Export CSV
          </a>
          <a class="nav-item" onclick="showConfirm('Cleanup Expired', 'Remove all expired users from database?', '/admin?pwd=\${pwd}&action=cleanup', '🧹')">
            <span class="icon">🧹</span> Cleanup Expired
          </a>
        </div>

        <div class="sidebar-footer">
          <div class="live-indicator">
            <span class="live-dot"></span>
            System Online
          </div>
          <div style="margin-top: 12px; font-size: 11px; color: var(--text-muted);">
            v3.0 Industrial Grade
          </div>
        </div>
      </aside>

      <!-- Main Content -->
      <main class="main">
        <div class="header">
          <div class="header-left">
            <div class="mobile-menu" onclick="toggleSidebar()">☰</div>
            <h2>Dashboard Overview</h2>
            <p>Monitor your WiFi business in real-time</p>
          </div>
          <div class="header-right">
            <div class="session-badge" id="sessionBadge">
              <span>⏱️</span>
              <span id="sessionTimer">5:00</span>
            </div>
            <button class="btn btn-secondary" onclick="location.reload()">
              <span>🔄</span> Refresh
            </button>
            <a href="/admin" class="btn btn-danger">
              <span>🚪</span> Logout
            </a>
          </div>
        </div>

        \${actionMessage ? \`<div class="alert alert-success">✓ \${actionMessage}</div>\` : ''}

        <!-- Stats Section -->
        <section id="stats">
          <div class="stats-grid">
            <div class="stat-card revenue">
              <div class="stat-header">
                <div class="stat-icon green">💰</div>
              </div>
              <div class="stat-value money">₦\${Number(r.today_revenue).toLocaleString()}</div>
              <div class="stat-label">Today's Revenue</div>
            </div>
            <div class="stat-card revenue">
              <div class="stat-header">
                <div class="stat-icon green">📅</div>
              </div>
              <div class="stat-value money">₦\${Number(r.week_revenue).toLocaleString()}</div>
              <div class="stat-label">This Week</div>
            </div>
            <div class="stat-card revenue">
              <div class="stat-header">
                <div class="stat-icon green">📆</div>
              </div>
              <div class="stat-value money">₦\${Number(r.month_revenue).toLocaleString()}</div>
              <div class="stat-label">This Month</div>
            </div>
            <div class="stat-card revenue">
              <div class="stat-header">
                <div class="stat-icon green">🏆</div>
              </div>
              <div class="stat-value money">₦\${Number(r.total_revenue).toLocaleString()}</div>
              <div class="stat-label">All-Time Revenue</div>
            </div>
          </div>

          <div class="stats-grid">
            <div class="stat-card users">
              <div class="stat-header">
                <div class="stat-icon blue">👥</div>
              </div>
              <div class="stat-value">\${s.total_payments}</div>
              <div class="stat-label">Total Users</div>
            </div>
            <div class="stat-card active">
              <div class="stat-header">
                <div class="stat-icon purple">✅</div>
              </div>
              <div class="stat-value" style="color: var(--accent-green);">\${activeCount}</div>
              <div class="stat-label">Active Now</div>
            </div>
            <div class="stat-card expired">
              <div class="stat-header">
                <div class="stat-icon red">❌</div>
              </div>
              <div class="stat-value" style="color: var(--accent-red);">\${expiredCount}</div>
              <div class="stat-label">Expired</div>
            </div>
            <div class="stat-card">
              <div class="stat-header">
                <div class="stat-icon orange">📈</div>
              </div>
              <div class="stat-value">\${s.today_count}</div>
              <div class="stat-label">Today's Signups</div>
            </div>
          </div>
        </section>

        <!-- Chart Section -->
        <section id="chart">
          <div class="card">
            <div class="card-header">
              <div class="card-title">
                <div class="icon">📈</div>
                Revenue Analytics (Last 7 Days)
              </div>
            </div>
            <div class="card-body">
              <div class="chart-container">
                <canvas id="revenueChart"></canvas>
              </div>
            </div>
          </div>
        </section>

        <!-- Admin Tools Section -->
        <section id="tools">
          <div class="card">
            <div class="card-header">
              <div class="card-title">
                <div class="icon">🛠️</div>
                Admin Tools
              </div>
            </div>
            <div class="card-body">
              <div class="tools-grid">
                <div class="tool-card">
                  <div class="tool-header">
                    <div class="tool-icon">🔍</div>
                    <h3>Search Users</h3>
                  </div>
                  <p class="tool-desc">Find users by username, MAC address, or email</p>
                  <input type="text" id="searchInput" placeholder="Type to search..." onkeyup="searchTable()">
                </div>

                <div class="tool-card">
                  <div class="tool-header">
                    <div class="tool-icon">📊</div>
                    <h3>Export Data</h3>
                  </div>
                  <p class="tool-desc">Download payment records (Excel-compatible UTF-8)</p>
                  <a href="/admin?pwd=\${pwd}&format=csv" class="btn btn-primary" style="width: 100%; justify-content: center;">
                    📥 Download CSV
                  </a>
                </div>

                <div class="tool-card">
                  <div class="tool-header">
                    <div class="tool-icon">🧹</div>
                    <h3>Database Cleanup</h3>
                  </div>
                  <p class="tool-desc">Remove expired users to free up resources</p>
                  <button class="btn btn-danger" style="width: 100%;" onclick="showConfirm('Delete Expired Users', 'This will permanently remove all expired accounts. Continue?', '/admin?pwd=\${pwd}&action=cleanup', '🗑️')">
                    🗑️ Delete \${expiredCount} Expired
                  </button>
                </div>

                <div class="tool-card">
                  <div class="tool-header">
                    <div class="tool-icon">⚡</div>
                    <h3>Quick Stats</h3>
                  </div>
                  <p class="tool-desc">Plan distribution overview</p>
                  <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                    <span class="badge badge-daily">⚡ Daily: \${planData['24hr'] || 0}</span>
                    <span class="badge badge-weekly">🚀 Weekly: \${planData['7d'] || 0}</span>
                    <span class="badge badge-monthly">👑 Monthly: \${planData['30d'] || 0}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- Users Table Section -->
        <section id="users">
          <div class="card">
            <div class="card-header">
              <div class="card-title">
                <div class="icon">👥</div>
                All Users (\${allUsers.rows.length})
              </div>
              <div class="filters">
                <div class="filter-group">
                  <button class="filter-btn active" onclick="filterTable('all', this)">All</button>
                  <button class="filter-btn" onclick="filterTable('active', this)">Active</button>
                  <button class="filter-btn" onclick="filterTable('expired', this)">Expired</button>
                  <button class="filter-btn" onclick="filterTable('pending', this)">Pending</button>
                </div>
              </div>
            </div>
            <div class="table-container">
              <table id="usersTable">
                <thead>
                  <tr>
                    <th>Username</th>
                    <th>Password</th>
                    <th>Plan</th>
                    <th>Status</th>
                    <th>Expires</th>
                    <th>MAC Address</th>
                    <th>Created</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  \${allUsers.rows.slice(0, 100).map(row => \`
                    <tr data-search="\${row.mikrotik_username} \${row.mac_address || ''} \${row.customer_email || ''}" data-status="\${row.real_status}">
                      <td><strong>\${row.mikrotik_username}</strong></td>
                      <td><span class="password" onclick="copyText(this)" title="Click to copy">\${row.mikrotik_password}</span></td>
                      <td>
                        <span class="badge badge-\${row.plan === '24hr' ? 'daily' : row.plan === '7d' ? 'weekly' : 'monthly'}">
                          \${row.plan === '24hr' ? '⚡ Daily' : row.plan === '7d' ? '🚀 Weekly' : '👑 Monthly'}
                        </span>
                      </td>
                      <td>
                        <span class="badge \${row.real_status === 'active' ? 'badge-active' : row.real_status === 'expired' ? 'badge-expired' : 'badge-pending'}">
                          \${row.real_status === 'active' ? '✓ Active' : row.real_status === 'expired' ? '✗ Expired' : '⏳ Pending'}
                        </span>
                      </td>
                      <td class="time">\${row.expires_at ? new Date(row.expires_at).toLocaleString('en-NG', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td>
                      <td class="mac">\${row.mac_address || '—'}</td>
                      <td class="time">\${new Date(row.created_at).toLocaleString('en-NG', { dateStyle: 'short', timeStyle: 'short' })}</td>
                      <td class="actions">
                        <button class="action-btn extend" onclick="openExtendModal('\${row.id}', '\${row.mikrotik_username}')" title="Extend Plan">⏰</button>
                        <button class="action-btn" onclick="showConfirm('Reset User', 'Reset this user to pending status?', '/admin?pwd=\${pwd}&action=reset&userId=\${row.id}', '🔄')" title="Reset">🔄</button>
                        <button class="action-btn delete" onclick="showConfirm('Delete User', 'Permanently delete this user?', '/admin?pwd=\${pwd}&action=delete&userId=\${row.id}', '🗑️')" title="Delete">🗑️</button>
                      </td>
                    </tr>
                  \`).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <footer style="text-align: center; padding: 32px 20px; color: var(--text-muted); font-size: 13px;">
          <p>Dream Hatcher Tech Admin Dashboard v3.0 Industrial</p>
          <p style="margin-top: 4px;">Last refreshed: \${new Date().toLocaleString('en-NG')}</p>
        </footer>
      </main>

      <!-- Keyboard shortcuts hint -->
      <div class="shortcuts" id="shortcuts">
        <kbd>R</kbd> Refresh &nbsp; <kbd>S</kbd> Search &nbsp; <kbd>?</kbd> Toggle
      </div>

      <script>
        // ============================================
        // CHART INITIALIZATION
        // ============================================
        const ctx = document.getElementById('revenueChart').getContext('2d');
        new Chart(ctx, {
          type: 'bar',
          data: {
            labels: \${JSON.stringify(chartLabels)},
            datasets: [{
              label: 'Revenue (₦)',
              data: \${JSON.stringify(chartRevenue)},
              backgroundColor: 'rgba(16, 185, 129, 0.5)',
              borderColor: 'rgba(16, 185, 129, 1)',
              borderWidth: 2,
              borderRadius: 8,
              yAxisID: 'y'
            }, {
              label: 'Signups',
              data: \${JSON.stringify(chartSignups)},
              type: 'line',
              borderColor: 'rgba(0, 212, 255, 1)',
              backgroundColor: 'rgba(0, 212, 255, 0.1)',
              borderWidth: 3,
              pointRadius: 5,
              pointBackgroundColor: 'rgba(0, 212, 255, 1)',
              fill: true,
              tension: 0.4,
              yAxisID: 'y1'
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
              legend: {
                position: 'top',
                labels: { color: '#94a3b8', font: { family: 'Inter' } }
              }
            },
            scales: {
              x: {
                grid: { color: 'rgba(255,255,255,0.05)' },
                ticks: { color: '#64748b' }
              },
              y: {
                type: 'linear',
                position: 'left',
                grid: { color: 'rgba(255,255,255,0.05)' },
                ticks: {
                  color: '#10b981',
                  callback: function(value) { return '₦' + value.toLocaleString(); }
                }
              },
              y1: {
                type: 'linear',
                position: 'right',
                grid: { display: false },
                ticks: { color: '#00d4ff' }
              }
            }
          }
        });

        // ============================================
        // SESSION TIMEOUT (5 minutes)
        // ============================================
        let sessionTime = 5 * 60;
        const sessionBadge = document.getElementById('sessionBadge');
        const sessionTimer = document.getElementById('sessionTimer');

        function updateTimer() {
          const minutes = Math.floor(sessionTime / 60);
          const seconds = sessionTime % 60;
          sessionTimer.textContent = minutes + ':' + (seconds < 10 ? '0' : '') + seconds;

          if (sessionTime <= 60) {
            sessionBadge.classList.add('warning');
          } else {
            sessionBadge.classList.remove('warning');
          }

          if (sessionTime <= 0) {
            document.getElementById('logoutOverlay').classList.add('active');
            return;
          }

          sessionTime--;
          setTimeout(updateTimer, 1000);
        }

        ['mousemove', 'keypress', 'click', 'scroll', 'touchstart'].forEach(event => {
          document.addEventListener(event, () => { sessionTime = 5 * 60; });
        });

        updateTimer();

        // ============================================
        // SEARCH & FILTER
        // ============================================
        function searchTable() {
          const input = document.getElementById('searchInput').value.toLowerCase();
          const rows = document.querySelectorAll('#usersTable tbody tr');
          rows.forEach(row => {
            const searchData = row.getAttribute('data-search').toLowerCase();
            const matchesSearch = searchData.includes(input);
            const currentFilter = document.querySelector('.filter-btn.active')?.textContent.toLowerCase() || 'all';
            const matchesFilter = currentFilter === 'all' || row.getAttribute('data-status') === currentFilter;
            row.style.display = (matchesSearch && matchesFilter) ? '' : 'none';
          });
        }

        function filterTable(status, btn) {
          document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');

          const rows = document.querySelectorAll('#usersTable tbody tr');
          const searchInput = document.getElementById('searchInput').value.toLowerCase();

          rows.forEach(row => {
            const rowStatus = row.getAttribute('data-status');
            const searchData = row.getAttribute('data-search').toLowerCase();
            const matchesFilter = status === 'all' || rowStatus === status;
            const matchesSearch = searchData.includes(searchInput);
            row.style.display = (matchesFilter && matchesSearch) ? '' : 'none';
          });
        }

        // ============================================
        // COPY TEXT
        // ============================================
        function copyText(element) {
          const text = element.textContent;
          navigator.clipboard.writeText(text).then(() => {
            const original = element.textContent;
            element.textContent = '✓ Copied';
            element.style.background = 'rgba(16, 185, 129, 0.2)';
            element.style.color = '#10b981';
            setTimeout(() => {
              element.textContent = original;
              element.style.background = '';
              element.style.color = '';
            }, 1500);
          });
        }

        // ============================================
        // MODALS
        // ============================================
        function openExtendModal(userId, username) {
          document.getElementById('extendUserId').value = userId;
          document.getElementById('extendUsername').textContent = username;
          document.getElementById('extendModal').classList.add('active');
        }

        function closeExtendModal() {
          document.getElementById('extendModal').classList.remove('active');
        }

        function showConfirm(title, message, link, icon = '⚠️') {
          document.getElementById('confirmTitle').textContent = title;
          document.getElementById('confirmMessage').textContent = message;
          document.getElementById('confirmLink').href = link;
          document.getElementById('confirmIcon').textContent = icon;
          document.getElementById('confirmModal').classList.add('active');
        }

        function closeConfirmModal() {
          document.getElementById('confirmModal').classList.remove('active');
        }

        document.querySelectorAll('.modal').forEach(modal => {
          modal.addEventListener('click', function(e) {
            if (e.target === this) {
              this.classList.remove('active');
            }
          });
        });

        // ============================================
        // SIDEBAR & NAVIGATION
        // ============================================
        function toggleSidebar() {
          document.getElementById('sidebar').classList.toggle('open');
        }

        function scrollToSection(id) {
          document.getElementById(id).scrollIntoView({ behavior: 'smooth' });
          document.getElementById('sidebar').classList.remove('open');
        }

        // ============================================
        // KEYBOARD SHORTCUTS
        // ============================================
        document.addEventListener('keydown', function(e) {
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

          switch(e.key.toLowerCase()) {
            case 'r':
              location.reload();
              break;
            case 's':
              e.preventDefault();
              document.getElementById('searchInput').focus();
              break;
            case '?':
              document.getElementById('shortcuts').style.display =
                document.getElementById('shortcuts').style.display === 'none' ? 'block' : 'none';
              break;
            case 'escape':
              closeExtendModal();
              closeConfirmModal();
              break;
          }
        });
      </script>
    </body>
    </html>
    \`;

    res.send(html);

  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send('Dashboard error: ' + error.message);
  }
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
  console.log(`🌐 Initialize: https://dreamhatcher-backend.onrender.com/api/initialize-payment`);
  console.log(`🔗 Callback: https://dreamhatcher-backend.onrender.com/paystack-callback`);
  console.log(`👑 Admin: https://dreamhatcher-backend.onrender.com/admin?pwd=Huda2024@`);
});

server.setTimeout(30000);






