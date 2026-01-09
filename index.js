require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const https = require('https');
const axios = require('axios'); // <-- NEW: for Paystack API calls

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } })); // Needed for webhook signature

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

    await pool.query(
      `INSERT INTO payment_queue
       (transaction_id, customer_email, customer_phone, plan,
        mikrotik_username, mikrotik_password, mac_address, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
      [
        reference,
        data.customer?.email || 'unknown@example.com',
        data.customer?.phone || '',
        plan,
        username,
        password,
        macAddress
      ]
    );

    console.log(`✅ Queued user ${username} (Plan: ${plan}, Ref: ${reference})`);
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

  res.send(html.replace('${ref || \'\'}', ref)); // Make sure ref is injected
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
          // ============================================
        // AUTO-LOGIN FUNCTIONALITY
        // ============================================
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

          // Method 1: Try opening hotspot login with credentials in URL
          const loginUrl = HOTSPOT_LOGIN_URL +
            '?username=' + encodeURIComponent(credentials.username) +
            '&password=' + encodeURIComponent(credentials.password) +
            '&auto=1';

          // Try to open in same window (works if we're in hotspot network)
          try {
            // First try: Direct navigation
            window.location.href = loginUrl;

            // Fallback after 3 seconds if still on this page
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
            // Fallback: Open in new window
            window.open(loginUrl, '_blank');
            document.getElementById('autoLoginText').innerHTML =
              '✅ Login page opened! Check new tab/window.';
          }
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

              // Start auto-login countdown after showing credentials
              setTimeout(startAutoLoginCountdown, 1000);
              
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
          <!-- QR will be generated by JS -->
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
      // Generate QR code for hotspot login
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
// ADMIN DASHBOARD ROUTE
// Add this to your index.js file (before the error handler)
// ============================================

// Simple password protection (change this!)
const ADMIN_PASSWORD = 'Huda2024@';

// ========== ADMIN DASHBOARD ==========
app.get('/admin', async (req, res) => {
  const { pwd } = req.query;

  // Simple password check
  if (pwd !== ADMIN_PASSWORD) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Admin Login</title>
        <style>
          body { font-family: Arial; background: #0a0e1a; color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
          .box { background: rgba(255,255,255,0.05); padding: 40px; border-radius: 20px; text-align: center; }
          input { padding: 15px; border-radius: 8px; border: none; font-size: 16px; width: 200px; margin: 10px 0; }
          button { padding: 15px 30px; background: linear-gradient(135deg, #00c9ff, #0066ff); border: none; border-radius: 8px; color: white; font-weight: bold; cursor: pointer; }
        </style>
      </head>
      <body>
        <div class="box">
          <h2>🔐 Admin Access</h2>
          <form method="GET">
            <input type="password" name="pwd" placeholder="Enter password" required><br>
            <button type="submit">Login</button>
          </form>
        </div>
      </body>
      </html>
    `);
  }

  try {
    // Get statistics from database
    const stats = await pool.query(`
      SELECT
        COUNT(*) as total_payments,
        COUNT(*) FILTER (WHERE status = 'processed') as processed,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) as today_count,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days') as week_count,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '30 days') as month_count
      FROM payment_queue
    `);

    // Revenue calculations
    const revenue = await pool.query(`
      SELECT
        COALESCE(SUM(CASE
          WHEN plan = '24hr' THEN 350
          WHEN plan = '7d' THEN 2400
          WHEN plan = '30d' THEN 7500
          ELSE 0
        END), 0) as total_revenue,
        COALESCE(SUM(CASE
          WHEN created_at >= CURRENT_DATE AND plan = '24hr' THEN 350
          WHEN created_at >= CURRENT_DATE AND plan = '7d' THEN 2400
          WHEN created_at >= CURRENT_DATE AND plan = '30d' THEN 7500
          ELSE 0
        END), 0) as today_revenue,
        COALESCE(SUM(CASE
          WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' AND plan = '24hr' THEN 350
          WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' AND plan = '7d' THEN 2400
          WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' AND plan = '30d' THEN 7500
          ELSE 0
        END), 0) as week_revenue,
        COALESCE(SUM(CASE
          WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' AND plan = '24hr' THEN 350
          WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' AND plan = '7d' THEN 2400
          WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' AND plan = '30d' THEN 7500
          ELSE 0
        END), 0) as month_revenue
      FROM payment_queue
      WHERE status = 'processed'
    `);

    // Plan breakdown
    const plans = await pool.query(`
      SELECT
        plan,
        COUNT(*) as count
      FROM payment_queue
      WHERE status = 'processed'
      GROUP BY plan
    `);

    // Recent payments
    const recent = await pool.query(`
      SELECT
        mikrotik_username,
        plan,
        status,
        mac_address,
        created_at
      FROM payment_queue
      ORDER BY created_at DESC
      LIMIT 20
    `);

    const s = stats.rows[0];
    const r = revenue.rows[0];
    const planData = {};
    plans.rows.forEach(p => { planData[p.plan] = parseInt(p.count); });

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Dream Hatcher Admin Dashboard</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Segoe UI', Arial, sans-serif;
          background: linear-gradient(135deg, #0a0e1a 0%, #1a1a2e 100%);
          min-height: 100vh;
          color: white;
          padding: 20px;
        }
        .header {
          text-align: center;
          padding: 20px 0 30px;
          border-bottom: 1px solid rgba(255,255,255,0.1);
          margin-bottom: 30px;
        }
        .header h1 { color: #00d4ff; font-size: 1.8rem; }
        .header p { color: #64748b; margin-top: 5px; }
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 20px;
          margin-bottom: 30px;
        }
        .stat-card {
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 16px;
          padding: 25px;
          text-align: center;
        }
        .stat-card.highlight {
          background: linear-gradient(135deg, rgba(0,201,255,0.1), rgba(146,254,157,0.1));
          border-color: rgba(0,201,255,0.3);
        }
        .stat-icon { font-size: 2rem; margin-bottom: 10px; }
        .stat-value { font-size: 2rem; font-weight: 800; color: #00d4ff; }
        .stat-value.money { color: #10b981; }
        .stat-label { color: #94a3b8; font-size: 0.9rem; margin-top: 5px; }
        .section {
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 16px;
          padding: 25px;
          margin-bottom: 25px;
        }
        .section h2 {
          color: #00d4ff;
          font-size: 1.2rem;
          margin-bottom: 20px;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
        }
        th, td {
          padding: 12px 15px;
          text-align: left;
          border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        th { color: #94a3b8; font-weight: 600; font-size: 0.85rem; text-transform: uppercase; }
        td { font-size: 0.9rem; }
        .badge {
          padding: 4px 12px;
          border-radius: 20px;
          font-size: 0.75rem;
          font-weight: 600;
        }
        .badge-success { background: rgba(16,185,129,0.2); color: #10b981; }
        .badge-pending { background: rgba(245,158,11,0.2); color: #f59e0b; }
        .badge-daily { background: rgba(59,130,246,0.2); color: #3b82f6; }
        .badge-weekly { background: rgba(139,92,246,0.2); color: #8b5cf6; }
        .badge-monthly { background: rgba(236,72,153,0.2); color: #ec4899; }
        .plan-bars {
          display: flex;
          gap: 15px;
          flex-wrap: wrap;
        }
        .plan-bar {
          flex: 1;
          min-width: 150px;
          background: rgba(0,0,0,0.3);
          border-radius: 12px;
          padding: 15px;
        }
        .plan-bar-header {
          display: flex;
          justify-content: space-between;
          margin-bottom: 10px;
        }
        .plan-bar-label { font-weight: 600; }
        .plan-bar-count { color: #00d4ff; font-weight: 800; }
        .plan-bar-fill {
          height: 8px;
          border-radius: 4px;
          background: linear-gradient(90deg, #00c9ff, #92fe9d);
        }
        .refresh-btn {
          background: linear-gradient(135deg, #00c9ff, #0066ff);
          color: white;
          border: none;
          padding: 10px 25px;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 600;
        }
        .refresh-btn:hover { opacity: 0.9; }
        .mac { font-family: monospace; font-size: 0.8rem; color: #64748b; }
        .time { color: #64748b; font-size: 0.85rem; }
        @media (max-width: 600px) {
          .stats-grid { grid-template-columns: 1fr 1fr; }
          th, td { padding: 8px 10px; font-size: 0.8rem; }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🌐 Dream Hatcher Admin</h1>
        <p>WiFi Business Dashboard</p>
        <button class="refresh-btn" onclick="location.reload()" style="margin-top: 15px;">🔄 Refresh</button>
      </div>

      <div class="stats-grid">
        <div class="stat-card highlight">
          <div class="stat-icon">💰</div>
          <div class="stat-value money">₦${Number(r.today_revenue).toLocaleString()}</div>
          <div class="stat-label">Today's Revenue</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">📅</div>
          <div class="stat-value money">₦${Number(r.week_revenue).toLocaleString()}</div>
          <div class="stat-label">This Week</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">📆</div>
          <div class="stat-value money">₦${Number(r.month_revenue).toLocaleString()}</div>
          <div class="stat-label">This Month</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">🏆</div>
          <div class="stat-value money">₦${Number(r.total_revenue).toLocaleString()}</div>
          <div class="stat-label">All-Time Revenue</div>
        </div>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">👥</div>
          <div class="stat-value">${s.total_payments}</div>
          <div class="stat-label">Total Users</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">✅</div>
          <div class="stat-value">${s.processed}</div>
          <div class="stat-label">Active</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">⏳</div>
          <div class="stat-value">${s.pending}</div>
          <div class="stat-label">Pending</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">📈</div>
          <div class="stat-value">${s.today_count}</div>
          <div class="stat-label">Today's Signups</div>
        </div>
      </div>

      <div class="section">
        <h2>📊 Plan Breakdown</h2>
        <div class="plan-bars">
          <div class="plan-bar">
            <div class="plan-bar-header">
              <span class="plan-bar-label">⚡ Daily (₦350)</span>
              <span class="plan-bar-count">${planData['24hr'] || 0}</span>
            </div>
            <div class="plan-bar-fill" style="width: ${Math.min(100, ((planData['24hr'] || 0) / Math.max(1, s.processed)) * 100)}%"></div>
          </div>
          <div class="plan-bar">
            <div class="plan-bar-header">
              <span class="plan-bar-label">🚀 Weekly (₦2,400)</span>
              <span class="plan-bar-count">${planData['7d'] || 0}</span>
            </div>
            <div class="plan-bar-fill" style="width: ${Math.min(100, ((planData['7d'] || 0) / Math.max(1, s.processed)) * 100)}%; background: linear-gradient(90deg, #8b5cf6, #ec4899);"></div>
          </div>
          <div class="plan-bar">
            <div class="plan-bar-header">
              <span class="plan-bar-label">👑 Monthly (₦7,500)</span>
              <span class="plan-bar-count">${planData['30d'] || 0}</span>
            </div>
            <div class="plan-bar-fill" style="width: ${Math.min(100, ((planData['30d'] || 0) / Math.max(1, s.processed)) * 100)}%; background: linear-gradient(90deg, #f59e0b, #ef4444);"></div>
          </div>
        </div>
      </div>

      <div class="section">
        <h2>📋 Recent Payments</h2>
        <div style="overflow-x: auto;">
          <table>
            <thead>
              <tr>
                <th>Username</th>
                <th>Plan</th>
                <th>Status</th>
                <th>MAC</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              ${recent.rows.map(row => `
                <tr>
                  <td><strong>${row.mikrotik_username}</strong></td>
                  <td>
                    <span class="badge badge-${row.plan === '24hr' ? 'daily' : row.plan === '7d' ? 'weekly' : 'monthly'}">
                      ${row.plan === '24hr' ? '⚡ Daily' : row.plan === '7d' ? '🚀 Weekly' : '👑 Monthly'}
                    </span>
                  </td>
                  <td>
                    <span class="badge ${row.status === 'processed' ? 'badge-success' : 'badge-pending'}">
                      ${row.status === 'processed' ? '✅ Active' : '⏳ Pending'}
                    </span>
                  </td>
                  <td class="mac">${row.mac_address || 'N/A'}</td>
                  <td class="time">${new Date(row.created_at).toLocaleString('en-NG', { dateStyle: 'short', timeStyle: 'short' })}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div style="text-align: center; padding: 20px; color: #64748b; font-size: 0.85rem;">
        <p>Dream Hatcher Tech Admin Dashboard</p>
        <p>Last refreshed: ${new Date().toLocaleString('en-NG')}</p>
      </div>
    </body>
    </html>
    `;

    res.send(html);

  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send('Dashboard error: ' + error.message);
  }
});

// ============================================
// END OF ADMIN DASHBOARD ROUTE
// ============================================

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
});

server.setTimeout(30000);






