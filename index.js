require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const https = require('https');
const axios = require('axios');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

process.env.TZ = 'Africa/Lagos';  // Force Nigerian timezone
require('dotenv').config();

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
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION at:', promise, 'reason:', reason);
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

// ========== MONNIFY AUTH HELPER ==========
async function getMonnifyToken() {
  const authString = Buffer.from(
    `${process.env.MONNIFY_API_KEY}:${process.env.MONNIFY_SECRET_KEY}`
  ).toString('base64');

  const response = await axios.post(
    `${process.env.MONNIFY_BASE_URL}/api/v1/auth/login`,
    {},
    { headers: { Authorization: `Basic ${authString}` } }
  );

  return response.data.responseBody.accessToken;
}

// ========== KEEP ALIVE (prevents Render sleep) ==========
function keepAlive() {
  https.get('https://dreamhatcher-backend.onrender.com/health', (res) => {
    // No logging
  }).on('error', (err) => {});
}
setInterval(keepAlive, 14 * 60 * 1000);

// ========== ERROR HANDLING & TIMEOUT ==========
app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    console.log(`⏰ Timeout on ${req.method} ${req.url}`);
  });
  next();
});

// ========== HELPER: Generate Payment Reference ==========
const generatePaymentReference = (length = 10) => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

// ========== HELPER: Initialize Monnify Transaction ==========
const initializeMonnifyPayment = async ({ email, amount, plan, mac_address, description }) => {
  const accessToken = await getMonnifyToken();
  const paymentReference = generatePaymentReference(10); // e.g., "vq490fp113"

  const response = await axios.post(
    `${process.env.MONNIFY_BASE_URL}/api/v1/merchant/transactions/init-transaction`,
    {
      amount: amount,
      customerName: 'WiFi Customer',
      customerEmail: email || 'customer@dreamhatcher.com',
      paymentReference: paymentReference,
      paymentDescription: description || `Dream Hatcher WiFi - ${plan}`,
      currencyCode: 'NGN',
      contractCode: process.env.MONNIFY_CONTRACT_CODE,
      redirectUrl: 'https://dreamhatcher-backend.onrender.com/monnify-callback',
      paymentMethods: ['CARD', 'ACCOUNT_TRANSFER', 'USSD', 'PHONE_NUMBER'],
      metaData: {
        mac_address: mac_address || 'unknown',
        plan: plan
      }
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return {
    checkoutUrl: response.data.responseBody.checkoutUrl,
    paymentReference: paymentReference
  };
};

// ========== PLAN CONFIGURATION ==========
const planConfig = {
  daily: { amount: 350, code: '24hr', duration: '24 Hours' },
  weekly: { amount: 2400, code: '7d', duration: '7 Days' },
  monthly: { amount: 7500, code: '30d', duration: '30 Days' }
};

// ========== PAYMENT REDIRECT (Captive Portal Flow) ==========
app.get('/pay/:plan', async (req, res) => {
  const { plan } = req.params;
  const mac = req.query.mac || 'unknown';
  const email = req.query.email || 'customer@dreamhatcher.com';

  const selectedPlan = planConfig[plan];

  if (!selectedPlan) {
    return res.status(400).send('Invalid plan selected');
  }

  try {
    const { checkoutUrl, paymentReference } = await initializeMonnifyPayment({
      email: email,
      amount: selectedPlan.amount,
      plan: selectedPlan.code,
      mac_address: mac,
      description: `Dream Hatcher WiFi - ${selectedPlan.duration}`
    });

    console.log(`💳 Payment: ${plan} | MAC: ${mac} | Email: ${email} | Ref: ${paymentReference}`);

    res.redirect(checkoutUrl);

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

// ========== INITIALIZE PAYMENT API (Dynamic Checkout) ==========
app.post('/api/initialize-payment', async (req, res) => {
  try {
    const { email, amount, plan, mac_address } = req.body;

    if (!amount || !plan) {
      return res.status(400).json({ error: 'Missing amount or plan' });
    }

    const { checkoutUrl, paymentReference } = await initializeMonnifyPayment({
      email: email,
      amount: amount,
      plan: plan,
      mac_address: mac_address
    });

    console.log(`💳 API Payment: ${plan} | Amount: ₦${amount} | Ref: ${paymentReference}`);

    res.json({
      success: true,
      checkout_url: checkoutUrl,
      payment_reference: paymentReference
    });

  } catch (error) {
    console.error('❌ Monnify initialize error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to initialize payment' });
  }
});

// ========== MONNIFY WEBHOOK ==========
app.post('/api/monnify-webhook', async (req, res) => {
  console.log('📥 Monnify webhook received');

  // Verify Monnify webhook signature
  const secret = process.env.MONNIFY_SECRET_KEY;
  const computedHash = crypto.createHmac('sha512', secret)
    .update(JSON.stringify(req.body))
    .digest('hex');

  const receivedSignature = req.headers['monnify-signature'];

  if (computedHash !== receivedSignature) {
    console.log('❌ Invalid Monnify webhook signature');
    return res.status(400).send('Invalid signature');
  }

  try {
    const { eventType, eventData } = req.body;

    // Only process successful transactions
    if (eventType !== 'SUCCESSFUL_TRANSACTION') {
      console.log(`📝 Received event type: ${eventType} - ignoring`);
      return res.status(200).json({ received: true });
    }

    const {
      paymentReference,
      amountPaid,
      metaData,
      customer
    } = eventData;

    const amountNaira = amountPaid; // Already in Naira
    const macAddress = metaData?.mac_address || 'unknown';
    const planFromMetadata = metaData?.plan;

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
      expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    } else if (plan === '7d') {
      expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    } else if (plan === '30d') {
      expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    }

    await pool.query(
      `INSERT INTO payment_queue
       (transaction_id, customer_email, customer_phone, plan,
        mikrotik_username, mikrotik_password, mac_address, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
      [
        paymentReference,
        customer?.email || 'unknown@example.com',
        customer?.phoneNumber || '',
        plan,
        username,
        password,
        macAddress,
        expiresAt
      ]
    );

    console.log(`✅ Queued user ${username} | Plan: ${plan} | Expires: ${expiresAt.toISOString()}`);
    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('❌ Monnify webhook error:', error.message);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ========== MONNIFY CALLBACK (20-second waiting page) ==========
app.get('/monnify-callback', (req, res) => {
  const { paymentReference, transactionReference } = req.query;
  const ref = paymentReference || transactionReference || 'unknown';

  console.log('🔗 Monnify callback:', ref);

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
          <span>Verifying payment with Monnify...</span>
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
        Reference: <strong>${ref}</strong>
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
          window.location.href = '/success?reference=' + encodeURIComponent('${ref}');
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
    const { reference, trxref, paymentReference } = req.query;
    const ref = reference || trxref || paymentReference;

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
              <li>A login page will open automatically or a pop-up window</li>
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
    res.set('Content-Type', 'text/plain');
    res.send('');
  }
});

app.post('/api/mark-processed/:id', async (req, res) => {
  try {
    console.log(`🔄 Processing mark-processed for: ${req.params.id}`);
    let userId = req.params.id;

    if (userId.includes('|')) {
      const parts = userId.split('|');
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

// ========== GET EXPIRED USERS (SILENT - for MikroTik) ==========
app.get('/api/expired-users', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;

    if (!apiKey || apiKey !== process.env.MIKROTIK_API_KEY) {
      return res.status(403).send('');
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

    // Only log when there ARE expired users to process
    console.log(`⏰ Found ${result.rows.length} expired user(s)`);

    const lines = result.rows.map(row => [
      row.mikrotik_username || 'unknown',
      row.mac_address || 'unknown',
      row.expires_at.toISOString(),
      row.id
    ].join('|'));

    res.set('Content-Type', 'text/plain');
    res.send(lines.join('\n'));

  } catch (error) {
    // Silent fail - just return empty
    res.set('Content-Type', 'text/plain');
    res.send('');
  }
});

// ========== MARK USER AS EXPIRED (SILENT) ==========
app.post('/api/mark-expired/:id', async (req, res) => {
  try {
    let userId = req.params.id;

    // Extract ID from pipe-separated string if needed
    if (userId.includes('|')) {
      const parts = userId.split('|');
      userId = parts[parts.length - 1];
    }

    const idNum = parseInt(userId);

    // Silent validation fail
    if (isNaN(idNum) || idNum <= 0) {
      return res.json({ success: false });
    }

    const result = await pool.query(
      `UPDATE payment_queue SET status = 'expired' WHERE id = $1 AND status = 'processed' RETURNING mikrotik_username`,
      [idNum]
    );

    // Only log successful expirations
    if (result.rowCount > 0) {
      console.log(`⏰ Expired: ${result.rows[0].mikrotik_username} (ID: ${idNum})`);
      return res.json({ success: true, id: idNum });
    }

    // Silent return if not found or already expired - no logging
    return res.json({ success: false });

  } catch (error) {
    // Silent fail
    return res.json({ success: false });
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
      uptime: process.uptime(),
      payment_provider: 'Monnify'
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
        Secure Payment Processing via Monnify
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

// DREAM HATCHER ENTERPRISE ADMIN DASHBOARD v4.1
// Professional WiFi Management System with Role-Based Access Control
// FIXED DATABASE SCHEMA & EXPIRY ISSUES
// ============================================

// ========== SECURITY CONFIGURATION ==========
const ADMIN_USERS = {
    // SUPER ADMIN - Full access (100%)
    'superadmin': {
        password: 'dreamatcher@2024',
        role: 'super_admin',
        permissions: ['delete', 'create', 'update', 'extend', 'manage_users', 'export', 'force_logout']
    },
    // ADMIN - Read-only access
    'admin': {
        password: 'yusuf2026',
        role: 'check',
        permissions: ['view']
    }
};

const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// Session storage with unique user tracking
const adminSessions = {};
const adminUserSessions = {}; // Track by username to prevent duplicates

// ========== HELPER FUNCTIONS ==========

function naira(amount) {
    const num = Number(amount) || 0;
    return '₦' + num.toLocaleString('en-NG');
}

function planPrice(plan) {
    const prices = { '24hr': 350, '7d': 2400, '30d': 7500 };
    return prices[plan] || 0;
}

function planLabel(plan) {
    const labels = { '24hr': 'Daily', '7d': 'Weekly', '30d': 'Monthly' };
    return labels[plan] || plan || 'Unknown';
}

function escapeHtml(text) {
    if (!text) return '';
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.toString().replace(/[&<>"']/g, m => map[m]);
}

// ========== ADMIN SESSION MANAGEMENT ==========

async function createAdminLogsTable() {
    try {
        // First check if table exists
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'admin_logs'
            );
        `);

        if (tableCheck.rows[0].exists) {
            // Table exists, check for columns and add if missing
            const columns = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'admin_logs'
            `);
            
            const columnNames = columns.rows.map(row => row.column_name);
            
            // Add missing columns if they don't exist
            if (!columnNames.includes('username')) {
                await pool.query(`ALTER TABLE admin_logs ADD COLUMN IF NOT EXISTS username VARCHAR(50) DEFAULT 'unknown'`);
                console.log('✅ Added username column to admin_logs');
            }
            
            if (!columnNames.includes('role')) {
                await pool.query(`ALTER TABLE admin_logs ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'unknown'`);
                console.log('✅ Added role column to admin_logs');
            }
            
            // Update any NULL values
            await pool.query(`UPDATE admin_logs SET username = 'unknown' WHERE username IS NULL`);
            await pool.query(`UPDATE admin_logs SET role = 'unknown' WHERE role IS NULL`);
            
        } else {
            // Create table from scratch
            await pool.query(`
                CREATE TABLE IF NOT EXISTS admin_logs (
                    id SERIAL PRIMARY KEY,
                    username VARCHAR(50) NOT NULL DEFAULT 'unknown',
                    role VARCHAR(20) NOT NULL DEFAULT 'unknown',
                    session_id VARCHAR(255) NOT NULL,
                    admin_ip VARCHAR(45) NOT NULL,
                    user_agent TEXT,
                    login_time TIMESTAMP DEFAULT NOW(),
                    logout_time TIMESTAMP,
                    last_activity TIMESTAMP DEFAULT NOW(),
                    is_active BOOLEAN DEFAULT true
                );
            `);
            
            console.log('✅ Created admin_logs table with proper schema');
        }
        
        // Create indexes if they don't exist
        try {
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_logs_session ON admin_logs(session_id)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_logs_active ON admin_logs(is_active)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_logs_time ON admin_logs(login_time DESC)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_logs_username ON admin_logs(username)`);
        } catch (error) {
            console.log('Indexes already exist or error creating them:', error.message);
        }
        
        console.log('✅ Admin logs table ready and verified');
    } catch (error) {
        console.log('Admin logs table setup error:', error.message);
    }
}

// Initialize admin logs table
createAdminLogsTable();

// Log admin login with unique user session
async function logAdminLogin(username, role, sessionId, ip, userAgent) {
    try {
        // Close any existing active session for this user
        await pool.query(
            `UPDATE admin_logs SET logout_time = NOW(), is_active = false 
             WHERE username = $1 AND is_active = true`,
            [username]
        );
        
        // Create new session
        await pool.query(
            `INSERT INTO admin_logs (username, role, session_id, admin_ip, user_agent, login_time, last_activity, is_active) 
             VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), true)`,
            [username, role, sessionId, ip, userAgent]
        );
        
        // Update tracking
        adminUserSessions[username] = sessionId;
    } catch (error) {
        console.log('Logging admin login error:', error.message);
    }
}

// Update admin activity
async function updateAdminActivity(sessionId) {
    try {
        await pool.query(
            'UPDATE admin_logs SET last_activity = NOW() WHERE session_id = $1 AND is_active = true',
            [sessionId]
        );
    } catch (error) {
        console.log('Updating admin activity error:', error.message);
    }
}

// Log admin logout
async function logAdminLogout(sessionId) {
    try {
        const result = await pool.query(
            'SELECT username FROM admin_logs WHERE session_id = $1',
            [sessionId]
        );
        
        if (result.rows[0]) {
            const username = result.rows[0].username;
            delete adminUserSessions[username];
        }
        
        await pool.query(
            'UPDATE admin_logs SET logout_time = NOW(), is_active = false WHERE session_id = $1',
            [sessionId]
        );
    } catch (error) {
        console.log('Logging admin logout error:', error.message);
    }
}

// Get active admins (unique by user) - FIXED QUERY
async function getActiveAdmins() {
    try {
        const result = await pool.query(`
            SELECT 
                username,
                role,
                session_id,
                admin_ip,
                user_agent,
                login_time,
                last_activity,
                EXTRACT(EPOCH FROM (NOW() - last_activity)) as idle_seconds
            FROM admin_logs 
            WHERE is_active = true 
            ORDER BY last_activity DESC
        `);
        
        // Group by username to get unique sessions
        const uniqueAdmins = {};
        result.rows.forEach(row => {
            if (!uniqueAdmins[row.username] || 
                new Date(row.last_activity) > new Date(uniqueAdmins[row.username].last_activity)) {
                uniqueAdmins[row.username] = row;
            }
        });
        
        return Object.values(uniqueAdmins);
    } catch (error) {
        console.log('Getting active admins error:', error.message);
        return [];
    }
}

// Get admin login history - FIXED QUERY
async function getAdminLoginHistory(limit = 20) {
    try {
        const result = await pool.query(`
            SELECT 
                username,
                role,
                admin_ip,
                login_time,
                logout_time,
                EXTRACT(EPOCH FROM (COALESCE(logout_time, NOW()) - login_time)) as session_duration_seconds,
                is_active
            FROM admin_logs 
            ORDER BY login_time DESC
            LIMIT $1
        `, [limit]);
        return result.rows;
    } catch (error) {
        console.log('Getting admin history error:', error.message);
        return [];
    }
}

// ========== PERMISSION CHECK ==========
function hasPermission(session, requiredPermission) {
    if (!session || !session.role) return false;
    
    // Super admin has all permissions
    if (session.role === 'super_admin') return true;
    
    // Check specific permission
    const userConfig = ADMIN_USERS[session.username];
    if (!userConfig) return false;
    
    return userConfig.permissions.includes(requiredPermission);
}

// ========== FIXED EXPIRY CHECK FUNCTION ==========
async function checkExpiredUsers() {
    try {
        // Find users who should be expired but aren't marked as expired
        const now = new Date();
        const result = await pool.query(`
            SELECT id, mikrotik_username, expires_at, status
            FROM payment_queue 
            WHERE (status = 'processed' OR status = 'pending')
            AND expires_at IS NOT NULL 
            AND expires_at <= $1
            AND (status != 'expired' OR status IS NULL)
            LIMIT 50
        `, [now]);
        
        if (result.rows.length > 0) {
            console.log(`⏰ Auto-expiring ${result.rows.length} user(s) via scheduled check`);
            
            // Mark them as expired
            for (const user of result.rows) {
                console.log(`⏰ Auto-expired: ${user.mikrotik_username} (ID: ${user.id})`);
                await pool.query(
                    `UPDATE payment_queue SET status = 'expired' WHERE id = $1`,
                    [user.id]
                );
            }
        }
    } catch (error) {
        console.log('Checking expired users error:', error.message);
    }
}

// Run expiry check every 2 minutes
setInterval(checkExpiredUsers, 120000);

// ========== EXPIRY SYNC FUNCTION (For dashboard) ==========
async function syncExpiredWithMikroTik() {
    try {
        // Get users that need to be synced with MikroTik
        const result = await pool.query(`
            SELECT 
                id,
                mikrotik_username,
                mac_address,
                expires_at
            FROM payment_queue
            WHERE status = 'expired'
            AND expires_at IS NOT NULL
            AND expires_at < NOW() - INTERVAL '1 minute'
            AND mikrotik_username IS NOT NULL
            AND mikrotik_username != ''
            AND (last_sync IS NULL OR last_sync < expires_at)
            LIMIT 20
        `);
        
        if (result.rows.length > 0) {
            console.log(`🔄 Syncing ${result.rows.length} expired users with MikroTik`);
            
            // Update last_sync timestamp
            for (const user of result.rows) {
                await pool.query(
                    `UPDATE payment_queue SET last_sync = NOW() WHERE id = $1`,
                    [user.id]
                );
            }
            
            return result.rows;
        }
        return [];
    } catch (error) {
        console.log('Syncing expired users error:', error.message);
        return [];
    }
}

// Run sync every 5 minutes
setInterval(syncExpiredWithMikroTik, 300000);

// ========== ADMIN DASHBOARD ROUTE ==========
app.get('/admin', async (req, res) => {
    const { user, pwd, action, userId, newPlan, sessionId, exportData, forceLogout } = req.query;
    
    // ========== FORCE LOGOUT OTHER SESSIONS ==========
    if (forceLogout === 'all' && sessionId && adminSessions[sessionId]) {
        const currentSession = adminSessions[sessionId];
        if (currentSession.role !== 'super_admin') {
            return res.redirect(`/admin?sessionId=${sessionId}&action=permission_denied`);
        }
        
        try {
            // Logout all other sessions except current one
            Object.keys(adminSessions).forEach(key => {
                if (key !== sessionId) {
                    logAdminLogout(key);
                    delete adminSessions[key];
                }
            });
            
            // Mark all other sessions as inactive
            await pool.query(
                `UPDATE admin_logs SET logout_time = NOW(), is_active = false 
                 WHERE session_id != $1 AND is_active = true`,
                [sessionId]
            );
            
            return res.redirect(`/admin?sessionId=${sessionId}&action=force_logout_success`);
        } catch (error) {
            console.log('Force logout error:', error.message);
            return res.redirect(`/admin?sessionId=${sessionId}&action=force_logout_error`);
        }
    }
    
    // ========== SESSION-BASED AUTH ==========
    if (sessionId && adminSessions[sessionId]) {
        const session = adminSessions[sessionId];
        
        // Check session expiry
        if (Date.now() - session.lastActivity > SESSION_TIMEOUT) {
            await logAdminLogout(sessionId);
            delete adminSessions[sessionId];
            return res.redirect('/admin?sessionExpired=true');
        }
        
        // Update last activity
        session.lastActivity = Date.now();
        adminSessions[sessionId] = session;
        await updateAdminActivity(sessionId);
        
        return await handleAdminDashboard(req, res, sessionId);
    }
    
    // ========== USER/PASSWORD LOGIN ==========
    if (user && pwd) {
        const userConfig = ADMIN_USERS[user];
        if (userConfig && userConfig.password === pwd) {
            // Check if user already has active session
            const existingSessionId = adminUserSessions[user];
            if (existingSessionId && adminSessions[existingSessionId]) {
                // Use existing session
                const session = adminSessions[existingSessionId];
                session.lastActivity = Date.now();
                return res.redirect(`/admin?sessionId=${existingSessionId}`);
            }
            
            // Create new session
            const newSessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            adminSessions[newSessionId] = {
                id: newSessionId,
                username: user,
                role: userConfig.role,
                permissions: userConfig.permissions,
                loggedInAt: new Date(),
                lastActivity: Date.now(),
                ip: req.ip,
                userAgent: req.headers['user-agent']
            };
            
            await logAdminLogin(user, userConfig.role, newSessionId, req.ip, req.headers['user-agent']);
            return res.redirect(`/admin?sessionId=${newSessionId}`);
        }
    }
    
    // ========== SHOW LOGIN FORM ==========
    return res.send(getLoginForm(req.query.sessionExpired));
});

// ========== ADMIN DASHBOARD HANDLER ==========
async function handleAdminDashboard(req, res, sessionId) {
    try {
        const session = adminSessions[sessionId];
        if (!session) {
            return res.redirect('/admin');
        }
        
        const { action, userId, newPlan, exportData } = req.query;
        let actionMessage = '';
        let messageType = '';

        // ========== HANDLE ADMIN ACTIONS WITH PERMISSION CHECK ==========
        if (action === 'delete' && userId) {
            if (!hasPermission(session, 'delete')) {
                actionMessage = 'Permission denied: Cannot delete users';
                messageType = 'error';
            } else {
                await pool.query('DELETE FROM payment_queue WHERE id = $1', [userId]);
                actionMessage = 'User account permanently deleted';
                messageType = 'success';
            }
        }

        if (action === 'extend' && userId && newPlan) {
            if (!hasPermission(session, 'extend')) {
                actionMessage = 'Permission denied: Cannot extend plans';
                messageType = 'error';
            } else {
                // Calculate proper expiry based on plan
                let interval = '';
                if (newPlan === '24hr') interval = '24 hours';
                else if (newPlan === '7d') interval = '7 days';
                else if (newPlan === '30d') interval = '30 days';
                
                await pool.query(
                    `UPDATE payment_queue 
                     SET plan = $1, 
                         expires_at = NOW() + INTERVAL '${interval}', 
                         status = 'processed' 
                     WHERE id = $2`,
                    [newPlan, userId]
                );
                actionMessage = 'User plan extended to ' + interval;
                messageType = 'success';
            }
        }

        if (action === 'reset' && userId) {
            if (!hasPermission(session, 'update')) {
                actionMessage = 'Permission denied: Cannot reset users';
                messageType = 'error';
            } else {
                await pool.query(
                    `UPDATE payment_queue 
                     SET status = 'pending', expires_at = NULL 
                     WHERE id = $1`,
                    [userId]
                );
                actionMessage = 'User reset to pending - will be recreated on MikroTik';
                messageType = 'warning';
            }
        }

        if (action === 'toggle_status' && userId) {
            if (!hasPermission(session, 'toggle_status')) {
                actionMessage = 'Permission denied: Cannot toggle status';
                messageType = 'error';
            } else {
                const current = await pool.query('SELECT status FROM payment_queue WHERE id = $1', [userId]);
                const newStatus = current.rows[0].status === 'processed' ? 'suspended' : 'processed';
                await pool.query('UPDATE payment_queue SET status = $1 WHERE id = $2', [newStatus, userId]);
                actionMessage = 'User status changed to ' + newStatus;
                messageType = 'info';
            }
        }

        // ========== BULK CLEANUP (Super Admin Only) ==========
        if (action === 'cleanup') {
            if (!hasPermission(session, 'delete')) {
                actionMessage = 'Permission denied: Cannot perform cleanup';
                messageType = 'error';
            } else {
                // Proper cleanup of expired users
                const result = await pool.query(`
                    DELETE FROM payment_queue 
                    WHERE (
                        (status = 'expired') OR
                        (status = 'processed' AND expires_at < NOW() - INTERVAL '7 days') OR
                        (status = 'pending' AND created_at < NOW() - INTERVAL '7 days')
                    )
                `);
                actionMessage = 'Cleaned up ' + result.rowCount + ' expired/pending users';
                messageType = 'success';
            }
        }

        // ========== SYNC EXPIRED WITH MIKROTIK ==========
        if (action === 'sync_expired') {
            if (!hasPermission(session, 'update')) {
                actionMessage = 'Permission denied: Cannot sync expired users';
                messageType = 'error';
            } else {
                const expiredUsers = await syncExpiredWithMikroTik();
                actionMessage = 'Synced ' + expiredUsers.length + ' expired users with MikroTik';
                messageType = 'success';
            }
        }

        // ========== FORCE LOGOUT MESSAGES ==========
        if (action === 'force_logout_success') {
            actionMessage = 'All other admin sessions have been terminated';
            messageType = 'success';
        }
        if (action === 'force_logout_error') {
            actionMessage = 'Error terminating other sessions';
            messageType = 'error';
        }
        if (action === 'permission_denied') {
            actionMessage = 'Permission denied: Requires Super Admin access';
            messageType = 'error';
        }

        // ========== EXPORT CSV (Super Admin Only) ==========
        if (exportData === 'csv') {
            if (!hasPermission(session, 'export')) {
                return res.status(403).send('Permission denied');
            }
            
            const { rows } = await pool.query(`
                SELECT 
                    id,
                    mikrotik_username as username,
                    mikrotik_password as password,
                    plan,
                    status,
                    mac_address as mac,
                    customer_email as email,
                    created_at,
                    expires_at,
                    last_sync
                FROM payment_queue 
                ORDER BY created_at DESC
            `);
            
            let csvData = 'ID,Username,Password,Plan,Status,MAC Address,Email,Created,Expires,Last Sync\n';
            rows.forEach(row => {
                csvData += [
                    row.id,
                    '"' + (row.username || '').replace(/"/g, '""') + '"',
                    '"' + (row.password || '').replace(/"/g, '""') + '"',
                    '"' + (row.plan || '').replace(/"/g, '""') + '"',
                    '"' + (row.status || '').replace(/"/g, '""') + '"',
                    '"' + (row.mac || 'N/A').replace(/"/g, '""') + '"',
                    '"' + (row.email || 'N/A').replace(/"/g, '""') + '"',
                    '"' + new Date(row.created_at).toISOString() + '"',
                    '"' + (row.expires_at ? new Date(row.expires_at).toISOString() : 'N/A') + '"',
                    '"' + (row.last_sync ? new Date(row.last_sync).toISOString() : 'N/A') + '"'
                ].join(',') + '\n';
            });
            
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="dreamhatcher_users_' + new Date().toISOString().split('T')[0] + '.csv"');
            return res.send(csvData);
        }

        // ========== GET DASHBOARD STATISTICS ==========
        
        // 1. CORE METRICS
        const metrics = await pool.query(`
            WITH user_stats AS (
                SELECT 
                    COUNT(*) as total_users,
                    COUNT(CASE WHEN status = 'processed' AND (expires_at IS NULL OR expires_at > NOW()) THEN 1 END) as active_users,
                    COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_users,
                    COUNT(CASE WHEN status = 'expired' OR (status = 'processed' AND expires_at <= NOW()) THEN 1 END) as expired_users,
                    COUNT(CASE WHEN status = 'suspended' THEN 1 END) as suspended_users,
                    COUNT(CASE WHEN created_at::date = CURRENT_DATE THEN 1 END) as signups_today,
                    COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as signups_week
                FROM payment_queue
            ),
            revenue_stats AS (
                SELECT
                    COALESCE(SUM(
                        CASE 
                            WHEN plan = '24hr' THEN 350
                            WHEN plan = '7d' THEN 2400
                            WHEN plan = '30d' THEN 7500
                            ELSE 0
                        END
                    ), 0) as total_revenue_lifetime,
                    
                    COALESCE(SUM(
                        CASE WHEN created_at::date = CURRENT_DATE
                        THEN CASE 
                            WHEN plan = '24hr' THEN 350
                            WHEN plan = '7d' THEN 2400
                            WHEN plan = '30d' THEN 7500
                            ELSE 0
                        END ELSE 0 END
                    ), 0) as revenue_today,
                    
                    COALESCE(SUM(
                        CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days'
                        THEN CASE 
                            WHEN plan = '24hr' THEN 350
                            WHEN plan = '7d' THEN 2400
                            WHEN plan = '30d' THEN 7500
                        END ELSE 0 END
                    ), 0) as revenue_week,
                    
                    COALESCE(SUM(
                        CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days'
                        THEN CASE 
                            WHEN plan = '24hr' THEN 350
                            WHEN plan = '7d' THEN 2400
                            WHEN plan = '30d' THEN 7500
                        END ELSE 0 END
                    ), 0) as revenue_month
                FROM payment_queue
            ),
            plan_distribution AS (
                SELECT 
                    plan,
                    COUNT(*) as count,
                    SUM(
                        CASE 
                            WHEN plan = '24hr' THEN 350
                            WHEN plan = '7d' THEN 2400
                            WHEN plan = '30d' THEN 7500
                            ELSE 0
                        END
                    ) as revenue
                FROM payment_queue 
                GROUP BY plan
            )
            SELECT 
                u.*, 
                r.*,
                json_agg(json_build_object('plan', p.plan, 'count', p.count, 'revenue', p.revenue)) as plans_data
            FROM user_stats u, revenue_stats r, plan_distribution p
            GROUP BY 
                u.total_users, u.active_users, u.pending_users, u.expired_users, u.suspended_users, 
                u.signups_today, u.signups_week, r.total_revenue_lifetime, r.revenue_today, 
                r.revenue_week, r.revenue_month
        `);

      // 2. USERS WITH FIXED EXPIRY CALCULATION (REAL-TIME CHECK)
const recentActivity = await pool.query(`
  SELECT 
    id,
    mikrotik_username,
    mikrotik_password,
    plan,
    status,
    mac_address,
    customer_email,
    created_at,
    expires_at,
    -- Use COALESCE to handle missing last_sync column gracefully
    COALESCE(last_sync, created_at) as last_sync,
    -- FIXED: REAL-TIME STATUS CHECK (IMMEDIATE EXPIRY)
    CASE 
      WHEN status = 'expired' THEN 'expired'
      WHEN status = 'pending' THEN 'pending'
      WHEN status = 'suspended' THEN 'suspended'
      WHEN status = 'processed' AND (expires_at IS NULL) THEN 'active'
      WHEN status = 'processed' AND (expires_at > NOW()) THEN 'active'
      WHEN status = 'processed' AND (expires_at <= NOW()) THEN 'expired'
      ELSE 'unknown'
    END as realtime_status
  FROM payment_queue
  ORDER BY created_at DESC
  LIMIT 100
`);
        // 3. GET ACTIVE ADMINS (UNIQUE BY USER)
        const activeAdmins = await getActiveAdmins();
        const adminHistory = await getAdminLoginHistory(10);
        
        const stats = metrics.rows[0];
        const users = recentActivity.rows;
        
        // Count realtime statuses
        const activeCount = users.filter(u => u.realtime_status === 'active').length;
        const expiredCount = users.filter(u => u.realtime_status === 'expired').length;
        const pendingCount = users.filter(u => u.realtime_status === 'pending').length;
        const suspendedCount = users.filter(u => u.realtime_status === 'suspended').length;
        
        // Plan distribution
        const planData = {
            daily: { count: 0, revenue: 0 },
            weekly: { count: 0, revenue: 0 },
            monthly: { count: 0, revenue: 0 }
        };
        
        if (stats.plans_data) {
            stats.plans_data.forEach(p => {
                if (p.plan === '24hr') {
                    planData.daily.count = p.count;
                    planData.daily.revenue = p.revenue;
                } else if (p.plan === '7d') {
                    planData.weekly.count = p.count;
                    planData.weekly.revenue = p.revenue;
                } else if (p.plan === '30d') {
                    planData.monthly.count = p.count;
                    planData.monthly.revenue = p.revenue;
                }
            });
        }

        // Current session info
        const currentSession = session;
        const currentAdminIdleSeconds = currentSession ? 
            Math.floor((Date.now() - currentSession.lastActivity) / 1000) : 0;
        const activeSessions = activeAdmins.length;

        // ========== RENDER DASHBOARD ==========
        res.send(renderDashboard({
            session: session,
            sessionId: sessionId,
            stats: stats,
            users: users,
            activeCount: activeCount,
            expiredCount: expiredCount,
            pendingCount: pendingCount,
            suspendedCount: suspendedCount,
            planData: planData,
            activeAdmins: activeAdmins,
            adminHistory: adminHistory,
            activeSessions: activeSessions,
            currentAdminIdleSeconds: currentAdminIdleSeconds,
            currentAdminIP: currentSession ? currentSession.ip : 'Unknown',
            actionMessage: actionMessage,
            messageType: messageType
        }));

    } catch (error) {
        console.log('Dashboard handler error:', error.message);
        res.status(500).send(getErrorPage(error.message));
    }
}

// ========== LOGIN FORM ==========
function getLoginForm(sessionExpired) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Portal • Dream Hatcher</title>
    <style>
        :root {
            --bg-primary: #0f172a;
            --bg-secondary: #1e293b;
            --bg-card: #334155;
            --border: #475569;
            --text-primary: #f1f5f9;
            --text-secondary: #cbd5e1;
            --text-muted: #94a3b8;
            --accent: #3b82f6;
            --accent-dark: #2563eb;
            --success: #10b981;
            --danger: #ef4444;
            --warning: #f59e0b;
            --purple: #8b5cf6;
        }
        
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
            line-height: 1.6;
        }
        
        .login-container {
            width: 100%;
            max-width: 420px;
        }
        
        .login-card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 40px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.3);
            text-align: center;
        }
        
        .logo {
            width: 64px;
            height: 64px;
            background: linear-gradient(135deg, var(--accent), var(--purple));
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 24px;
            color: white;
            font-size: 28px;
            font-weight: bold;
        }
        
        h1 {
            font-size: 28px;
            margin-bottom: 8px;
            color: var(--text-primary);
            font-weight: 700;
        }
        
        p {
            color: var(--text-secondary);
            margin-bottom: 32px;
            font-size: 15px;
        }
        
        .alert {
            background: rgba(239, 68, 68, 0.2);
            border: 1px solid rgba(239, 68, 68, 0.4);
            color: var(--danger);
            padding: 12px 16px;
            border-radius: 10px;
            margin-bottom: 24px;
            display: ${sessionExpired ? 'flex' : 'none'};
            align-items: center;
            justify-content: center;
            gap: 10px;
            font-size: 14px;
        }
        
        .input-group {
            margin-bottom: 20px;
            text-align: left;
        }
        
        label {
            display: block;
            margin-bottom: 8px;
            color: var(--text-secondary);
            font-size: 14px;
            font-weight: 500;
        }
        
        input {
            width: 100%;
            padding: 14px 16px;
            border-radius: 10px;
            border: 1px solid var(--border);
            background: var(--bg-secondary);
            color: var(--text-primary);
            font-size: 15px;
            transition: all 0.2s;
        }
        
        input:focus {
            outline: none;
            border-color: var(--accent);
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
        }
        
        button {
            width: 100%;
            padding: 16px;
            border-radius: 10px;
            border: none;
            background: linear-gradient(135deg, var(--accent), var(--accent-dark));
            color: white;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            margin-top: 8px;
        }
        
        button:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
        }
        
        .security-note {
            margin-top: 28px;
            font-size: 12px;
            color: var(--text-muted);
            padding-top: 20px;
            border-top: 1px solid var(--border);
        }
        
        .credentials-hint {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 16px;
            margin-top: 24px;
            font-size: 13px;
            color: var(--text-secondary);
            text-align: left;
        }
        
        .credentials-hint h4 {
            color: var(--text-primary);
            margin-bottom: 10px;
            font-size: 14px;
        }
        
        .cred-item {
            display: flex;
            justify-content: space-between;
            padding: 6px 0;
            border-bottom: 1px dashed var(--border);
        }
        
        .cred-item:last-child {
            border-bottom: none;
        }
    </style>
</head>
<body>
    <div class="login-container">
        <div class="login-card">
            <div class="logo">DH</div>
            <h1>Dream Hatcher Admin</h1>
            <p>Secure Admin Portal with Role-Based Access</p>
            
            <div class="alert">
                Session expired. Please login again.
            </div>
            
            <form method="GET" action="/admin">
                <div class="input-group">
                    <label for="user">Username</label>
                    <input type="text" id="user" name="user" placeholder="Enter username" required autofocus>
                </div>
                
                <div class="input-group">
                    <label for="pwd">Password</label>
                    <input type="password" id="pwd" name="pwd" placeholder="Enter password" required>
                </div>
                
                <button type="submit">
                    Access Dashboard
                </button>
            </form>
                     
            <div class="security-note">
                Session Timeout: 5 minutes • Encrypted Connection
            </div>
        </div>
    </div>
</body>
</html>`;
}

// ========== ERROR PAGE ==========
function getErrorPage(error) {
    return `<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            background: #0f172a;
            color: #f1f5f9;
            font-family: 'Segoe UI', sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 20px;
        }
        .error-box {
            background: #1e293b;
            border: 1px solid #475569;
            border-radius: 16px;
            padding: 40px;
            text-align: center;
            max-width: 500px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.3);
        }
        .error-icon { font-size: 48px; color: #ef4444; margin-bottom: 20px; }
        h2 { color: #fca5a5; margin-bottom: 10px; }
        pre {
            background: #334155;
            padding: 15px;
            border-radius: 8px;
            text-align: left;
            overflow-x: auto;
            color: #94a3b8;
            font-size: 14px;
            margin: 20px 0;
        }
        .btn {
            display: inline-block;
            margin-top: 20px;
            padding: 12px 30px;
            background: linear-gradient(135deg, #3b82f6, #2563eb);
            color: white;
            border-radius: 10px;
            text-decoration: none;
            font-weight: 600;
            transition: all 0.2s;
        }
        .btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
        }
    </style>
</head>
<body>
    <div class="error-box">
        <div class="error-icon">⚠️</div>
        <h2>Dashboard Error</h2>
        <p>An unexpected error occurred while loading the dashboard.</p>
        <pre>${escapeHtml(error)}</pre>
        <a href="/admin" class="btn">Return to Login</a>
    </div>
</body>
</html>`;
}

// ========== DASHBOARD RENDERER ==========
function renderDashboard(data) {
    const { 
        session,
        sessionId, 
        stats, 
        users, 
        activeCount, 
        expiredCount, 
        pendingCount,
        suspendedCount,
        planData,
        activeAdmins,
        adminHistory,
        activeSessions,
        currentAdminIdleSeconds,
        currentAdminIP,
        actionMessage, 
        messageType 
    } = data;
    
    const now = new Date();
    const sessionEnd = now.getTime() + (5 * 60 * 1000);
    
    // Build user table rows WITH CORRECT COLUMN ORDER: Created, Expires, MAC
    let userRows = '';
    if (users.length === 0) {
        userRows = '<tr><td colspan="10" style="text-align:center;padding:48px;color:var(--text-muted);">No users found</td></tr>';
    } else {
        users.forEach(user => {
            const created = new Date(user.created_at);
            const expires = user.expires_at ? new Date(user.expires_at) : null;
            const lastSync = user.last_sync ? new Date(user.last_sync) : null;
            const isExpired = user.realtime_status === 'expired';
            
            const statusBadge = 'badge-' + user.realtime_status;
            const statusIcon = user.realtime_status === 'active' ? 'fa-circle-check' :
                             user.realtime_status === 'expired' ? 'fa-circle-xmark' :
                             user.realtime_status === 'pending' ? 'fa-hourglass-half' :
                             user.realtime_status === 'suspended' ? 'fa-pause-circle' : 'fa-question-circle';
            const statusLabel = user.realtime_status.charAt(0).toUpperCase() + user.realtime_status.slice(1);
            
            // Check permissions for action buttons
            const showDelete = hasPermission(session, 'delete');
            const showExtend = hasPermission(session, 'extend');
            const showReset = hasPermission(session, 'update');
            const showToggle = hasPermission(session, 'toggle_status');
            
            userRows += `
                <tr data-status="${user.realtime_status}" data-search="${escapeHtml(user.mikrotik_username || '')} ${escapeHtml(user.mac_address || '')} ${escapeHtml(user.customer_email || '')}">
                    <td class="user-cell">
                        <strong>${escapeHtml(user.mikrotik_username || 'N/A')}</strong>
                        ${user.customer_email ? '<small>' + escapeHtml(user.customer_email) + '</small>' : ''}
                    </td>
                    <td><span class="pw" onclick="copyPw('${escapeHtml(user.mikrotik_password || '')}')" title="Click to copy">${escapeHtml(user.mikrotik_password || 'N/A')}</span></td>
                    <td>
                        <span class="plan-tag plan-${user.plan === '24hr' ? 'daily' : user.plan === '7d' ? 'weekly' : 'monthly'}">
                            <i class="fa-solid ${user.plan === '24hr' ? 'fa-bolt' : user.plan === '7d' ? 'fa-rocket' : 'fa-crown'}"></i> 
                            ${planLabel(user.plan)}
                        </span>
                    </td>
                    <td>
                        <span class="badge ${statusBadge}">
                            <i class="fa-solid ${statusIcon}"></i> ${statusLabel}
                        </span>
                    </td>
                    <td class="time-cell">
                        ${created.toLocaleDateString('en-NG')}<br>
                        <small>${created.toLocaleTimeString('en-NG', {hour:'2-digit',minute:'2-digit'})}</small>
                    </td>
                    <td>
                        ${expires ? 
                            `<span class="time-cell ${isExpired ? 'expires-gone' : 'expires-ok'}">
                                ${expires.toLocaleDateString('en-NG')}<br>
                                <small>${expires.toLocaleTimeString('en-NG', {hour:'2-digit',minute:'2-digit'})}</small>
                            </span>` : 
                            '<span style="color:var(--text-muted);">N/A</span>'
                        }
                    </td>
                    <td>${user.mac_address ? `<span class="mac">${escapeHtml(user.mac_address)}</span>` : '<span style="color:var(--text-muted);">N/A</span>'}</td>
                    <td>
                        ${lastSync ? 
                            `<span class="time-cell">
                                ${lastSync.toLocaleDateString('en-NG')}<br>
                                <small>${lastSync.toLocaleTimeString('en-NG', {hour:'2-digit',minute:'2-digit'})}</small>
                            </span>` : 
                            '<span style="color:var(--text-muted);">Never</span>'
                        }
                    </td>
                    <td>
                        <div class="row-actions">
                            ${showExtend ? `
                                <button class="act-btn a-extend" title="Extend Plan" onclick="openExtend(${user.id}, '${escapeHtml(user.mikrotik_username || '')}')">
                                    <i class="fa-solid fa-clock-rotate-left"></i>
                                </button>
                            ` : ''}
                            ${showToggle ? `
                                <a href="/admin?sessionId=${sessionId}&action=toggle_status&userId=${user.id}" class="act-btn a-reset" title="Toggle Status">
                                    <i class="fa-solid fa-power-off"></i>
                                </a>
                            ` : ''}
                            ${showReset ? `
                                <a href="/admin?sessionId=${sessionId}&action=reset&userId=${user.id}" class="act-btn a-reset" onclick="return confirm('Reset user to pending?')" title="Reset to Pending">
                                    <i class="fa-solid fa-arrow-rotate-left"></i>
                                </a>
                            ` : ''}
                            ${showDelete ? `
                                <a href="/admin?sessionId=${sessionId}&action=delete&userId=${user.id}" class="act-btn a-delete" onclick="return confirm('Permanently delete this user?')" title="Delete User">
                                    <i class="fa-solid fa-trash-can"></i>
                                </a>
                            ` : ''}
                        </div>
                    </td>
                </tr>
            `;
        });
    }
    
    // Build admin sessions rows (unique per user)
    let adminSessionsRows = '';
    activeAdmins.forEach(admin => {
        const loginTime = new Date(admin.login_time);
        const lastActivity = new Date(admin.last_activity);
        const idleMinutes = Math.floor(admin.idle_seconds / 60);
        const idleSeconds = Math.floor(admin.idle_seconds % 60);
        const isCurrentUser = admin.username === session.username;
        
        adminSessionsRows += `
            <tr style="${isCurrentUser ? 'background: rgba(139, 92, 246, 0.1);' : ''}">
                <td style="padding: 12px;">
                    <div style="font-weight: 600; color: ${isCurrentUser ? 'var(--purple)' : 'var(--text-primary)'}">
                        ${admin.username}
                        ${isCurrentUser ? '<span style="color: var(--success); font-size: 11px; margin-left: 5px;">(You)</span>' : ''}
                    </div>
                    <div style="font-size: 11px; color: var(--text-muted);">
                        ${admin.role.replace('_', ' ').toUpperCase()}
                    </div>
                </td>
                <td style="padding: 12px; font-size: 13px; font-family: monospace;">
                    ${admin.admin_ip}
                </td>
                <td style="padding: 12px; font-size: 13px;">
                    ${loginTime.toLocaleTimeString('en-NG', {hour:'2-digit', minute:'2-digit'})}<br>
                    <small style="color: var(--text-muted);">
                        ${loginTime.toLocaleDateString('en-NG', {day:'numeric', month:'short'})}
                    </small>
                </td>
                <td style="padding: 12px; font-size: 13px;">
                    ${lastActivity.toLocaleTimeString('en-NG', {hour:'2-digit', minute:'2-digit'})}<br>
                    <small style="color: var(--text-muted);">
                        ${idleMinutes}m ago
                    </small>
                </td>
                <td style="padding: 12px;">
                    <span class="${admin.idle_seconds > 300 ? 'badge-expired' : 'badge-active'}" style="font-size: 12px; padding: 4px 10px;">
                        ${idleMinutes}m ${idleSeconds}s
                    </span>
                </td>
            </tr>
        `;
    });
    
    // Plan distribution percentages
    const totalUsers = Number(stats.total_users) || 1;
    const dailyPct = ((planData.daily.count / totalUsers) * 100).toFixed(1);
    const weeklyPct = ((planData.weekly.count / totalUsers) * 100).toFixed(1);
    const monthlyPct = ((planData.monthly.count / totalUsers) * 100).toFixed(1);
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dream Hatcher Admin Dashboard v4.1</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
    <style>
        :root {
            --bg-primary: #0f172a;
            --bg-secondary: #1e293b;
            --bg-card: #334155;
            --bg-hover: #475569;
            --border: #475569;
            --border-light: #64748b;
            --text-primary: #f1f5f9;
            --text-secondary: #cbd5e1;
            --text-muted: #94a3b8;
            --accent: #3b82f6;
            --accent-dark: #2563eb;
            --success: #10b981;
            --success-bg: rgba(16, 185, 129, 0.2);
            --danger: #ef4444;
            --danger-bg: rgba(239, 68, 68, 0.2);
            --warning: #f59e0b;
            --warning-bg: rgba(245, 158, 11, 0.2);
            --purple: #8b5cf6;
            --purple-bg: rgba(139, 92, 246, 0.2);
            --pink: #ec4899;
            --pink-bg: rgba(236, 72, 153, 0.2);
            --radius: 12px;
            --radius-sm: 8px;
            --shadow: 0 4px 6px rgba(0,0,0,0.3);
            --shadow-lg: 0 10px 25px rgba(0,0,0,0.5);
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            line-height: 1.6;
            -webkit-font-smoothing: antialiased;
        }

        /* =================== TOPBAR =================== */
        .topbar {
            position: sticky;
            top: 0;
            z-index: 100;
            background: rgba(15, 23, 42, 0.95);
            backdrop-filter: blur(10px);
            border-bottom: 1px solid var(--border);
            padding: 0 32px;
            height: 70px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .brand {
            display: flex;
            align-items: center;
            gap: 14px;
        }

        .brand-mark {
            width: 40px;
            height: 40px;
            border-radius: var(--radius-sm);
            background: linear-gradient(135deg, var(--accent), var(--purple));
            display: grid;
            place-items: center;
            color: white;
            font-weight: 800;
            font-size: 18px;
            box-shadow: var(--shadow);
        }

        .brand-info {
            display: flex;
            flex-direction: column;
        }

        .brand-name {
            font-size: 17px;
            font-weight: 700;
            color: var(--text-primary);
        }

        .brand-user {
            font-size: 13px;
            color: var(--text-secondary);
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .user-role {
            background: ${session.role === 'super_admin' ? 'var(--purple-bg)' : 'var(--success-bg)'};
            color: ${session.role === 'super_admin' ? 'var(--purple)' : 'var(--success)'};
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
        }

        .nav-actions {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .chip {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: 600;
            background: var(--success-bg);
            color: var(--success);
            border: 1px solid rgba(16, 185, 129, 0.3);
        }

        .btn {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 9px 18px;
            border-radius: var(--radius-sm);
            border: 1px solid var(--border);
            background: var(--bg-card);
            color: var(--text-primary);
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            text-decoration: none;
            transition: all 0.2s;
            white-space: nowrap;
        }

        .btn:hover {
            background: var(--bg-hover);
            border-color: var(--border-light);
            transform: translateY(-1px);
            box-shadow: var(--shadow);
        }

        .btn-accent {
            background: linear-gradient(135deg, var(--accent), var(--accent-dark));
            border: none;
            color: white;
        }

        .btn-accent:hover {
            background: linear-gradient(135deg, var(--accent-dark), #1d4ed8);
            box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
        }

        .btn-danger {
            color: var(--danger);
            border-color: rgba(239, 68, 68, 0.3);
            background: var(--danger-bg);
        }

        .btn-danger:hover {
            background: rgba(239, 68, 68, 0.3);
        }

        /* =================== MAIN CONTENT =================== */
        .page {
            padding: 32px;
            max-width: 1600px;
            margin: 0 auto;
        }

        .page-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
            margin-bottom: 32px;
            flex-wrap: wrap;
            gap: 16px;
        }

        .page-title {
            font-size: 32px;
            font-weight: 800;
            color: var(--text-primary);
            margin-bottom: 8px;
        }

        .page-subtitle {
            color: var(--text-secondary);
            font-size: 16px;
        }

        /* =================== TOAST =================== */
        .toast {
            padding: 16px 20px;
            border-radius: var(--radius-sm);
            margin-bottom: 24px;
            display: ${actionMessage ? 'flex' : 'none'};
            align-items: center;
            gap: 12px;
            font-size: 15px;
            font-weight: 500;
            animation: slideDown 0.3s ease-out;
            border-left: 4px solid;
            background: var(--bg-card);
            border: 1px solid var(--border);
            box-shadow: var(--shadow);
        }

        .toast-success { border-left-color: var(--success); color: var(--success); }
        .toast-warning { border-left-color: var(--warning); color: var(--warning); }
        .toast-error { border-left-color: var(--danger); color: var(--danger); }
        .toast-info { border-left-color: var(--accent); color: var(--accent); }

        /* =================== METRICS GRID =================== */
        .metrics {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 20px;
            margin-bottom: 32px;
        }

        .metric {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: 24px;
            transition: all 0.3s;
            box-shadow: var(--shadow);
        }

        .metric:hover {
            transform: translateY(-4px);
            box-shadow: var(--shadow-lg);
            border-color: var(--accent);
        }

        .metric-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }

        .metric-icon {
            width: 48px;
            height: 48px;
            border-radius: var(--radius-sm);
            display: grid;
            place-items: center;
            font-size: 22px;
            background: var(--bg-secondary);
            color: var(--accent);
        }

        .metric-tag {
            font-size: 12px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            padding: 4px 12px;
            border-radius: 20px;
        }

        .metric-value {
            font-size: 32px;
            font-weight: 800;
            margin-bottom: 8px;
            color: var(--text-primary);
        }

        .metric-value.currency { color: var(--success); }

        .metric-label {
            font-size: 14px;
            color: var(--text-secondary);
            margin-bottom: 16px;
        }

        .metric-footer {
            padding-top: 16px;
            border-top: 1px solid var(--border);
            font-size: 13px;
            color: var(--text-muted);
            display: flex;
            align-items: center;
            gap: 8px;
        }

        /* =================== CARDS =================== */
        .card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            margin-bottom: 32px;
            overflow: hidden;
            box-shadow: var(--shadow);
        }

        .card-header {
            padding: 24px;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 16px;
            background: var(--bg-secondary);
        }

        .card-title {
            font-size: 18px;
            font-weight: 700;
            color: var(--text-primary);
        }

        .card-subtitle {
            font-size: 14px;
            color: var(--text-secondary);
            margin-top: 4px;
        }

        .card-tools {
            display: flex;
            gap: 12px;
            flex-wrap: wrap;
        }

        .card-body { padding: 24px; }

        /* =================== TABLE =================== */
        .tbl-wrap {
            overflow-x: auto;
            border-radius: var(--radius-sm);
            border: 1px solid var(--border);
        }

        table {
            width: 100%;
            border-collapse: collapse;
            min-width: 1000px;
        }

        thead {
            background: var(--bg-secondary);
            border-bottom: 2px solid var(--border);
        }

        th {
            padding: 16px;
            text-align: left;
            font-size: 12px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-secondary);
            white-space: nowrap;
        }

        td {
            padding: 16px;
            border-bottom: 1px solid var(--border);
            font-size: 14px;
            vertical-align: middle;
        }

        tbody tr { transition: background 0.2s; }
        tbody tr:hover { background: var(--bg-hover); }
        tbody tr:last-child td { border-bottom: none; }

        /* =================== BADGES & TAGS =================== */
        .badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: 600;
            white-space: nowrap;
        }

        .badge-active { background: var(--success-bg); color: var(--success); }
        .badge-expired { background: var(--danger-bg); color: var(--danger); }
        .badge-pending { background: var(--warning-bg); color: var(--warning); }
        .badge-suspended { background: #475569; color: var(--text-secondary); }

        .plan-tag {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-radius: var(--radius-sm);
            font-size: 13px;
            font-weight: 600;
        }

        .plan-daily { background: rgba(59, 130, 246, 0.2); color: var(--accent); }
        .plan-weekly { background: rgba(139, 92, 246, 0.2); color: var(--purple); }
        .plan-monthly { background: rgba(236, 72, 153, 0.2); color: var(--pink); }

        /* =================== ACTIONS =================== */
        .row-actions {
            display: flex;
            gap: 8px;
        }

        .act-btn {
            width: 36px;
            height: 36px;
            border-radius: var(--radius-sm);
            border: 1px solid var(--border);
            background: var(--bg-secondary);
            color: var(--text-secondary);
            cursor: pointer;
            display: grid;
            place-items: center;
            font-size: 14px;
            transition: all 0.2s;
            text-decoration: none;
        }

        .act-btn:hover {
            transform: translateY(-2px);
            box-shadow: var(--shadow);
        }

        .act-btn.a-extend:hover { color: var(--success); border-color: var(--success); }
        .act-btn.a-reset:hover { color: var(--warning); border-color: var(--warning); }
        .act-btn.a-delete:hover { color: var(--danger); border-color: var(--danger); }

        /* =================== SEARCH & FILTERS =================== */
        .search-wrap {
            position: relative;
            min-width: 240px;
        }

        .search-wrap i {
            position: absolute;
            left: 14px;
            top: 50%;
            transform: translateY(-50%);
            color: var(--text-muted);
            font-size: 14px;
        }

        .search-input {
            width: 100%;
            padding: 11px 16px 11px 40px;
            border-radius: var(--radius-sm);
            border: 1px solid var(--border);
            background: var(--bg-secondary);
            color: var(--text-primary);
            font-size: 14px;
            transition: all 0.2s;
        }

        .search-input:focus {
            outline: none;
            border-color: var(--accent);
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
        }

        .filter-tabs {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }

        .filter-tab {
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: 600;
            border: 1px solid var(--border);
            background: var(--bg-secondary);
            color: var(--text-secondary);
            cursor: pointer;
            transition: all 0.2s;
        }

        .filter-tab:hover { background: var(--bg-hover); }
        .filter-tab.active { background: var(--accent); border-color: var(--accent); color: white; }

        /* =================== MODALS =================== */
        .modal-overlay {
            display: none;
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.7);
            backdrop-filter: blur(4px);
            z-index: 1000;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }

        .modal-overlay.open { display: flex; animation: fadeIn 0.3s; }

        .modal-box {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            width: 100%;
            max-width: 500px;
            box-shadow: var(--shadow-lg);
            animation: modalSlide 0.3s ease-out;
        }

        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes modalSlide { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }

        .modal-header {
            padding: 20px 24px;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .modal-title { font-size: 18px; font-weight: 700; }

        .modal-close {
            width: 36px;
            height: 36px;
            border-radius: var(--radius-sm);
            border: 1px solid var(--border);
            background: var(--bg-secondary);
            color: var(--text-muted);
            cursor: pointer;
            display: grid;
            place-items: center;
            font-size: 20px;
            transition: all 0.2s;
        }

        .modal-close:hover { background: var(--bg-hover); color: var(--text-primary); }

        .modal-body { padding: 24px; }
        .modal-footer {
            padding: 20px 24px;
            border-top: 1px solid var(--border);
            display: flex;
            gap: 12px;
            justify-content: flex-end;
        }

        /* =================== FOOTER =================== */
        .page-footer {
            text-align: center;
            padding: 32px;
            border-top: 1px solid var(--border);
            margin-top: 32px;
            color: var(--text-muted);
            font-size: 14px;
            background: var(--bg-card);
            border-radius: var(--radius);
            box-shadow: var(--shadow);
        }

        .footer-stats {
            display: flex;
            justify-content: center;
            gap: 32px;
            margin-top: 16px;
            flex-wrap: wrap;
            font-size: 13px;
        }

        /* =================== RESPONSIVE =================== */
        @media (max-width: 1200px) {
            .plan-grid { grid-template-columns: 1fr; }
        }

        @media (max-width: 768px) {
            .topbar { height: 60px; padding: 0 20px; }
            .page { padding: 20px; }
            .metrics { grid-template-columns: 1fr; }
            .card-header { padding: 16px; }
            .card-body { padding: 16px; }
            .card-tools { width: 100%; }
            .search-wrap { min-width: 100%; }
        }

        @media (max-width: 480px) {
            .filter-tabs { overflow-x: auto; flex-wrap: nowrap; padding-bottom: 8px; }
            .footer-stats { gap: 16px; }
            .row-actions { flex-wrap: wrap; }
        }
    </style>
</head>
<body>
    <!-- Copy Toast -->
    <div class="copy-feedback" id="copyToast" style="position:fixed; bottom:24px; left:50%; transform:translateX(-50%) translateY(100px); background:var(--success); color:white; padding:12px 24px; border-radius:8px; font-size:14px; font-weight:600; z-index:9999; opacity:0; transition:all 0.3s;">
        <i class="fa-solid fa-check"></i> Copied to clipboard
    </div>

    <!-- Extend Modal -->
    <div class="modal-overlay" id="extendModal">
        <div class="modal-box">
            <div class="modal-header">
                <h3 class="modal-title">Extend User Plan</h3>
                <button class="modal-close" onclick="closeExtend()">&times;</button>
            </div>
            <div class="modal-body">
                <p style="color: var(--text-secondary); margin-bottom: 20px;">
                    Extending plan for: <strong id="extendUser" style="color: var(--text-primary);"></strong>
                </p>
                <div class="plan-options">
                    <label class="plan-option" style="display:block; padding:16px; border:2px solid var(--border); border-radius:var(--radius-sm); margin-bottom:12px; cursor:pointer; transition:all 0.2s;" onclick="selectPlan(this)">
                        <input type="radio" name="extPlan" value="24hr" checked style="margin-right:12px;">
                        <span style="font-weight:600; color:var(--accent);">Daily Plan</span>
                        <div style="margin-left:28px; font-size:14px; color:var(--text-secondary);">24 hours • ₦350</div>
                    </label>
                    <label class="plan-option" style="display:block; padding:16px; border:2px solid var(--border); border-radius:var(--radius-sm); margin-bottom:12px; cursor:pointer; transition:all 0.2s;" onclick="selectPlan(this)">
                        <input type="radio" name="extPlan" value="7d" style="margin-right:12px;">
                        <span style="font-weight:600; color:var(--purple);">Weekly Plan</span>
                        <div style="margin-left:28px; font-size:14px; color:var(--text-secondary);">7 days • ₦2,400</div>
                    </label>
                    <label class="plan-option" style="display:block; padding:16px; border:2px solid var(--border); border-radius:var(--radius-sm); margin-bottom:12px; cursor:pointer; transition:all 0.2s;" onclick="selectPlan(this)">
                        <input type="radio" name="extPlan" value="30d" style="margin-right:12px;">
                        <span style="font-weight:600; color:var(--pink);">Monthly Plan</span>
                        <div style="margin-left:28px; font-size:14px; color:var(--text-secondary);">30 days • ₦7,500</div>
                    </label>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn" onclick="closeExtend()">Cancel</button>
                <button class="btn btn-accent" id="extendConfirmBtn">
                    <i class="fa-solid fa-check"></i> Confirm Extension
                </button>
            </div>
        </div>
    </div>

    <!-- Admin Sessions Modal -->
    <div class="modal-overlay" id="adminSessionsModal">
        <div class="modal-box" style="max-width: 700px;">
            <div class="modal-header">
                <h3 class="modal-title"><i class="fa-solid fa-user-shield"></i> Active Admin Sessions</h3>
                <button class="modal-close" onclick="closeModal('adminSessionsModal')">&times;</button>
            </div>
            <div class="modal-body">
                <div style="max-height: 400px; overflow-y: auto;">
                    <table style="width: 100%;">
                        <thead>
                            <tr>
                                <th style="padding: 12px;">Username</th>
                                <th style="padding: 12px;">IP Address</th>
                                <th style="padding: 12px;">Login Time</th>
                                <th style="padding: 12px;">Last Activity</th>
                                <th style="padding: 12px;">Idle Time</th>
                            </tr>
                        </thead>
                        <tbody id="adminSessionsBody">
                            ${activeAdmins.length > 0 ? adminSessionsRows : `
                                <tr>
                                    <td colspan="5" style="text-align: center; padding: 40px; color: var(--text-muted);">
                                        <i class="fa-solid fa-user-slash" style="font-size: 24px; display: block; margin-bottom: 10px;"></i>
                                        No active admin sessions
                                    </td>
                                </tr>
                            `}
                        </tbody>
                    </table>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn" onclick="closeModal('adminSessionsModal')">Close</button>
                ${activeSessions > 1 && hasPermission(session, 'force_logout') ? `
                    <button class="btn btn-danger" onclick="forceLogoutAll()">
                        <i class="fa-solid fa-power-off"></i> Force Logout All Others
                    </button>
                ` : ''}
            </div>
        </div>
    </div>

    <!-- Topbar -->
    <nav class="topbar">
        <div class="brand">
            <div class="brand-mark">DH</div>
            <div class="brand-info">
                <div class="brand-name">Dream Hatcher Admin</div>
                <div class="brand-user">
                    <span>${session.username}</span>
                    <span class="user-role">${session.role.replace('_', ' ')}</span>
                </div>
            </div>
        </div>
        <div class="nav-actions">
            <div class="chip">
                <i class="fa-solid fa-circle" style="font-size: 8px; color: var(--success);"></i>
                System Online
            </div>
            ${hasPermission(session, 'export') ? `
                <a href="/admin?sessionId=${sessionId}&exportData=csv" class="btn">
                    <i class="fa-solid fa-download"></i> Export CSV
                </a>
            ` : ''}
            ${hasPermission(session, 'delete') ? `
                <a href="/admin?sessionId=${sessionId}&action=cleanup" class="btn btn-danger" onclick="return confirm('Cleanup expired/pending users?')">
                    <i class="fa-solid fa-broom"></i> Cleanup
                </a>
            ` : ''}
            ${hasPermission(session, 'update') ? `
                <a href="/admin?sessionId=${sessionId}&action=sync_expired" class="btn" title="Sync expired users with MikroTik">
                    <i class="fa-solid fa-rotate"></i> Sync Expired
                </a>
            ` : ''}
            <button class="btn" onclick="location.reload()">
                <i class="fa-solid fa-rotate"></i> Refresh
            </button>
            <button class="btn btn-danger" onclick="logout()">
                <i class="fa-solid fa-right-from-bracket"></i> Logout
            </button>
        </div>
    </nav>

    <!-- Main Content -->
    <main class="page">
        <div class="page-header">
            <div>
                <h1 class="page-title">Dashboard Overview</h1>
                <p class="page-subtitle">Real-time business insights & user management</p>
            </div>
            <div style="font-size: 14px; color: var(--text-secondary);">
                <i class="fa-solid fa-clock"></i> Last refreshed: ${new Date().toLocaleString('en-NG')}
            </div>
        </div>

        ${actionMessage ? `
            <div class="toast toast-${messageType}">
                <i class="fa-solid fa-${messageType === 'success' ? 'check-circle' : messageType === 'warning' ? 'triangle-exclamation' : messageType === 'error' ? 'circle-xmark' : 'circle-info'}"></i>
                ${actionMessage}
            </div>
        ` : ''}

        <!-- Metrics Grid -->
        <div class="metrics">
            <!-- Lifetime Revenue -->
            <div class="metric">
                <div class="metric-header">
                    <div class="metric-icon">
                        <i class="fa-solid fa-vault"></i>
                    </div>
                    <span class="metric-tag" style="background:var(--success-bg); color:var(--success);">ALL-TIME</span>
                </div>
                <div class="metric-value currency">${naira(stats.total_revenue_lifetime)}</div>
                <div class="metric-label">Lifetime Revenue</div>
                <div class="metric-footer">
                    <i class="fa-solid fa-info-circle"></i> All payments received
                </div>
            </div>
            
            <!-- Today's Revenue -->
            <div class="metric">
                <div class="metric-header">
                    <div class="metric-icon" style="background:rgba(59, 130, 246, 0.2); color:var(--accent);">
                        <i class="fa-solid fa-calendar-day"></i>
                    </div>
                    <span class="metric-tag" style="background:rgba(59, 130, 246, 0.2); color:var(--accent);">TODAY</span>
                </div>
                <div class="metric-value currency" style="color:var(--accent);">${naira(stats.revenue_today)}</div>
                <div class="metric-label">Today's Revenue</div>
                <div class="metric-footer">
                    <i class="fa-solid fa-user-plus"></i> ${stats.signups_today} signups today
                </div>
            </div>
            
            <!-- Active Users -->
            <div class="metric">
                <div class="metric-header">
                    <div class="metric-icon" style="background:var(--success-bg); color:var(--success);">
                        <i class="fa-solid fa-users"></i>
                    </div>
                    <span class="metric-tag" style="background:var(--success-bg); color:var(--success);">ACTIVE</span>
                </div>
                <div class="metric-value" style="color:var(--success);">${activeCount}</div>
                <div class="metric-label">Currently Active Users</div>
                <div class="metric-footer">
                    <span style="color:var(--danger);"><i class="fa-solid fa-xmark"></i> ${expiredCount} expired</span>
                    <span style="color:var(--warning);"><i class="fa-solid fa-clock"></i> ${pendingCount} pending</span>
                </div>
            </div>
            
            <!-- Admin Sessions -->
            <div class="metric" onclick="showAdminSessions()" style="cursor:pointer;">
                <div class="metric-header">
                    <div class="metric-icon" style="background:var(--purple-bg); color:var(--purple);">
                        <i class="fa-solid fa-user-shield"></i>
                    </div>
                    <span class="metric-tag" style="background:var(--purple-bg); color:var(--purple);">SESSIONS</span>
                </div>
                <div class="metric-value" style="color:var(--purple);">${activeSessions}</div>
                <div class="metric-label">Active Admin Sessions</div>
                <div class="metric-footer">
                    <i class="fa-solid fa-user"></i> ${session.username}
                    <i class="fa-solid fa-clock" style="margin-left:12px;"></i> ${Math.floor(currentAdminIdleSeconds / 60)}m idle
                </div>
            </div>
        </div>

        <!-- User Management -->
        <div class="card">
            <div class="card-header">
                <div>
                    <div class="card-title">
                        <i class="fa-solid fa-users-gear" style="color:var(--accent); margin-right:10px;"></i>
                        User Management
                    </div>
                    <div class="card-subtitle">
                        ${users.length} users • 
                        <span style="color:var(--success);">${activeCount} active</span> • 
                        <span style="color:var(--danger);">${expiredCount} expired</span> • 
                        <span style="color:var(--warning);">${pendingCount} pending</span>
                        ${suspendedCount > 0 ? `• <span style="color:var(--text-secondary);">${suspendedCount} suspended</span>` : ''}
                    </div>
                </div>
                <div class="card-tools">
                    <div class="search-wrap">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input class="search-input" type="text" id="searchInput" placeholder="Search users, MAC, email..." oninput="filterTable()">
                    </div>
                    <div class="filter-tabs">
                        <button class="filter-tab active" data-filter="all" onclick="setFilter('all')">All</button>
                        <button class="filter-tab" data-filter="active" onclick="setFilter('active')">Active</button>
                        <button class="filter-tab" data-filter="pending" onclick="setFilter('pending')">Pending</button>
                        <button class="filter-tab" data-filter="expired" onclick="setFilter('expired')">Expired</button>
                        ${suspendedCount > 0 ? '<button class="filter-tab" data-filter="suspended" onclick="setFilter(\'suspended\')">Suspended</button>' : ''}
                    </div>
                </div>
            </div>
            <div class="tbl-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Username</th>
                            <th>Password</th>
                            <th>Plan</th>
                            <th>Status</th>
                            <th>Created</th>
                            <th>Expires</th>
                            <th>MAC Address</th>
                            <th>Last Sync</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody id="usersTbody">
                        ${userRows}
                    </tbody>
                </table>
            </div>
        </div>

        <!-- Footer -->
        <div class="page-footer">
            <p>Dream Hatcher Admin Dashboard v4.1 — Professional WiFi Management System</p>
            <div class="footer-stats">
                <span><i class="fa-solid fa-database"></i> ${stats.total_users} Total Users</span>
                <span><i class="fa-solid fa-money-bill-wave"></i> ${naira(stats.total_revenue_lifetime)} Lifetime Revenue</span>
                <span><i class="fa-solid fa-user-shield"></i> ${activeSessions} Admin Sessions</span>
                <span><i class="fa-solid fa-shield-halved"></i> Role: ${session.role.replace('_', ' ').toUpperCase()}</span>
            </div>
        </div>
    </main>

    <script>
        // Session Management
        let sessionEndTime = ${sessionEnd};
        let extendTargetId = null;
        let currentFilter = 'all';

        function updateSessionTimer() {
            const now = Date.now();
            const timeLeft = Math.max(0, sessionEndTime - now);
            
            if (timeLeft <= 0) {
                logout();
                return;
            }
            
            setTimeout(updateSessionTimer, 1000);
        }

        function resetSessionTimer() {
            sessionEndTime = Date.now() + (5 * 60 * 1000);
        }

        function logout() {
            window.location.href = "/admin";
        }

        // Activity detection
        ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(event => {
            document.addEventListener(event, resetSessionTimer, { passive: true });
        });

        // Copy password
        function copyPw(text) {
            navigator.clipboard.writeText(text).then(() => {
                const toast = document.getElementById('copyToast');
                toast.style.transform = 'translateX(-50%) translateY(0)';
                toast.style.opacity = '1';
                setTimeout(() => {
                    toast.style.transform = 'translateX(-50%) translateY(100px)';
                    toast.style.opacity = '0';
                }, 2000);
            });
        }

        // Extend modal
        function openExtend(userId, username) {
            extendTargetId = userId;
            document.getElementById('extendUser').textContent = username;
            document.getElementById('extendModal').classList.add('open');
        }

        function closeExtend() {
            document.getElementById('extendModal').classList.remove('open');
            extendTargetId = null;
        }

        function selectPlan(element) {
            document.querySelectorAll('.plan-option').forEach(opt => {
                opt.style.borderColor = 'var(--border)';
                opt.style.background = 'var(--bg-secondary)';
            });
            element.style.borderColor = 'var(--accent)';
            element.style.background = 'rgba(59, 130, 246, 0.1)';
            element.querySelector('input').checked = true;
        }

        document.getElementById('extendConfirmBtn').addEventListener('click', function() {
            if (!extendTargetId) return;
            const sel = document.querySelector('input[name="extPlan"]:checked');
            if (!sel) return;
            window.location.href = '/admin?sessionId=${sessionId}&action=extend&userId=' + extendTargetId + '&newPlan=' + sel.value;
        });

        // Admin sessions modal
        function showAdminSessions() {
            document.getElementById('adminSessionsModal').classList.add('open');
        }

        function closeModal(modalId) {
            document.getElementById(modalId).classList.remove('open');
        }

        // Close modals on outside click
        document.querySelectorAll('.modal-overlay').forEach(modal => {
            modal.addEventListener('click', function(e) {
                if (e.target === this) {
                    if (this.id === 'extendModal') closeExtend();
                    else if (this.id === 'adminSessionsModal') closeModal('adminSessionsModal');
                }
            });
        });

        // Force logout all other sessions
        function forceLogoutAll() {
            if (confirm('Force logout all other admin sessions? Only you will remain logged in.')) {
                window.location.href = '/admin?sessionId=${sessionId}&forceLogout=all';
            }
        }

        // Table filtering
        function setFilter(filter) {
            currentFilter = filter;
            document.querySelectorAll('.filter-tab').forEach(tab => {
                tab.classList.toggle('active', tab.dataset.filter === filter);
            });
            filterTable();
        }

        function filterTable() {
            const search = document.getElementById('searchInput').value.toLowerCase();
            const rows = document.querySelectorAll('#usersTbody tr');
            
            rows.forEach(row => {
                if (!row.dataset.search) {
                    row.style.display = 'none';
                    return;
                }
                
                const matchSearch = search === '' || row.dataset.search.toLowerCase().includes(search);
                const matchFilter = currentFilter === 'all' || row.dataset.status === currentFilter;
                
                row.style.display = (matchSearch && matchFilter) ? '' : 'none';
            });
        }

        // Auto-refresh every 60 seconds
        setInterval(() => {
            window.location.reload();
        }, 60000);

        // Initialize
        updateSessionTimer();
        
        // Highlight search on focus
        document.getElementById('searchInput')?.addEventListener('focus', function() {
            this.select();
        });
    </script>
</body>
</html>`;
}
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
  console.log(`🔗 Callback: https://dreamhatcher-backend.onrender.com/monnify-callback`);
  console.log(`💰 Payment Provider: Monnify`);
});

server.setTimeout(30000);



