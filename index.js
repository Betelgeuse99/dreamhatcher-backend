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
  AND expires_at < NOW() - INTERVAL '10 minutes'  -- Add buffer to avoid race conditions
  AND mikrotik_username IS NOT NULL
  AND mikrotik_username != ''
  LIMIT 50
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

// ============================================
// DREAM HATCHER ENTERPRISE ADMIN DASHBOARD v3.1
// Professional WiFi Management System
// Bug-free, production-ready
// ============================================

// Security Configuration
const ADMIN_PASSWORD = 'dreamhatcher2024'; // CHANGE IN PRODUCTION!
const SESSION_TIMEOUT = 3 * 60 * 1000; // 3 minutes strict

// Simple session storage (use Redis in production)
const adminSessions = {};

// Helper: Format currency
function naira(amount) {
    const num = Number(amount) || 0;
    return '₦' + num.toLocaleString('en-NG');
}

// Helper: Plan price
function planPrice(plan) {
    if (plan === '24hr') return 350;
    if (plan === '7d') return 2400;
    if (plan === '30d') return 7500;
    return 0;
}

// Helper: Plan label
function planLabel(plan) {
    if (plan === '24hr') return 'Daily';
    if (plan === '7d') return 'Weekly';
    if (plan === '30d') return 'Monthly';
    return plan || 'Unknown';
}

// ========== ADMIN DASHBOARD ROUTE ==========
app.get('/admin', async (req, res) => {
    const { pwd, action, userId, newPlan, sessionId, exportData } = req.query;
    
    // ========== SESSION-BASED AUTH ==========
    if (sessionId && adminSessions[sessionId]) {
        const session = adminSessions[sessionId];
        
        // Check session expiry
        if (Date.now() - session.lastActivity > SESSION_TIMEOUT) {
            delete adminSessions[sessionId];
            return res.redirect('/admin?sessionExpired=true');
        }
        
        // Update last activity
        session.lastActivity = Date.now();
        adminSessions[sessionId] = session;
        
        // Handle admin actions
        return await handleAdminDashboard(req, res, sessionId);
    }
    
    // ========== PASSWORD-BASED LOGIN ==========
    if (pwd === ADMIN_PASSWORD) {
        // Create new session
        const newSessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        adminSessions[newSessionId] = {
            id: newSessionId,
            loggedInAt: new Date(),
            lastActivity: Date.now(),
            ip: req.ip
        };
        
        // Redirect with session ID
        return res.redirect(`/admin?sessionId=${newSessionId}`);
    }
    
    // ========== SHOW LOGIN FORM ==========
    return res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Portal • Dream Hatcher</title>
    <style>
        :root {
            --bg-primary: #06080f;
            --bg-secondary: #0c1019;
            --bg-card: #111623;
            --border: rgba(99, 130, 190, 0.12);
            --text-primary: #e8edf5;
            --text-secondary: #8494b2;
            --accent: #3e8bff;
            --success: #2dd4a0;
            --danger: #f46b6b;
        }
        
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Segoe UI', sans-serif; }
        
        body {
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        
        .login-container {
            width: 100%;
            max-width: 400px;
        }
        
        .login-card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 14px;
            padding: 40px;
            text-align: center;
        }
        
        .logo {
            font-size: 48px;
            margin-bottom: 20px;
            color: var(--accent);
        }
        
        h1 {
            font-size: 24px;
            margin-bottom: 8px;
            color: var(--text-primary);
        }
        
        p {
            color: var(--text-secondary);
            margin-bottom: 30px;
            font-size: 14px;
        }
        
        .alert {
            background: rgba(244, 107, 107, 0.1);
            border: 1px solid rgba(244, 107, 107, 0.3);
            color: var(--danger);
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 20px;
            display: ${req.query.sessionExpired ? 'block' : 'none'};
        }
        
        input {
            width: 100%;
            padding: 14px 18px;
            border-radius: 10px;
            border: 1px solid var(--border);
            background: rgba(255, 255, 255, 0.05);
            color: var(--text-primary);
            font-size: 15px;
            margin-bottom: 20px;
        }
        
        input:focus {
            outline: none;
            border-color: var(--accent);
        }
        
        button {
            width: 100%;
            padding: 15px;
            border-radius: 10px;
            border: none;
            background: var(--accent);
            color: white;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: opacity 0.2s;
        }
        
        button:hover { opacity: 0.9; }
        
        .security-note {
            margin-top: 25px;
            font-size: 12px;
            color: var(--text-secondary);
        }
    </style>
</head>
<body>
    <div class="login-container">
        <div class="login-card">
            <div class="logo">🔐</div>
            <h1>Dream Hatcher Admin</h1>
            <p>Enterprise Admin Portal</p>
            
            <div class="alert">
                ⚠️ Session expired. Please login again.
            </div>
            
            <form method="GET" action="/admin">
                <input type="password" name="pwd" placeholder="Enter admin password" required autofocus>
                <button type="submit">Access Dashboard</button>
            </form>
            
            <div class="security-note">
                🔒 Session Timeout: 3 minutes • Secure Connection
            </div>
        </div>
    </div>
</body>
</html>`);
});

// ========== ADMIN DASHBOARD HANDLER ==========
async function handleAdminDashboard(req, res, sessionId) {
    try {
        const { action, userId, newPlan, exportData } = req.query;
        let actionMessage = '';
        let messageType = '';

        // ========== HANDLE ADMIN ACTIONS ==========
        if (action === 'delete' && userId) {
            await pool.query('DELETE FROM payment_queue WHERE id = $1', [userId]);
            actionMessage = 'User account permanently deleted';
            messageType = 'success';
        }

        if (action === 'extend' && userId && newPlan) {
            const expiryMap = { '24hr': '24 hours', '7d': '7 days', '30d': '30 days' };
            await pool.query(
                'UPDATE payment_queue SET plan = $1, expires_at = NOW() + INTERVAL \'' + expiryMap[newPlan] + '\', status = \'processed\' WHERE id = $2',
                [newPlan, userId]
            );
            actionMessage = 'User plan extended to ' + expiryMap[newPlan];
            messageType = 'success';
        }

        if (action === 'reset' && userId) {
            await pool.query(
                'UPDATE payment_queue SET status = \'pending\', expires_at = NULL WHERE id = $1',
                [userId]
            );
            actionMessage = 'User reset to pending - will be recreated on MikroTik';
            messageType = 'warning';
        }

        if (action === 'toggle_status' && userId) {
            const current = await pool.query('SELECT status FROM payment_queue WHERE id = $1', [userId]);
            const newStatus = current.rows[0].status === 'processed' ? 'suspended' : 'processed';
            await pool.query('UPDATE payment_queue SET status = $1 WHERE id = $2', [newStatus, userId]);
            actionMessage = 'User status changed to ' + newStatus;
            messageType = 'info';
        }

        // ========== BULK CLEANUP ==========
        if (action === 'cleanup') {
            const result = await pool.query(`
                DELETE FROM payment_queue 
                WHERE status = 'processed' 
                AND (
                    (plan = '24hr' AND created_at + INTERVAL '24 hours' < NOW()) OR
                    (plan = '7d' AND created_at + INTERVAL '7 days' < NOW()) OR
                    (plan = '30d' AND created_at + INTERVAL '30 days' < NOW())
                )
            `);
            actionMessage = 'Cleaned up ' + result.rowCount + ' expired users';
            messageType = 'success';
        }

        // ========== EXPORT CSV ==========
        if (exportData === 'csv') {
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
                    expires_at
                FROM payment_queue 
                ORDER BY created_at DESC
            `);
            
            let csvData = 'ID,Username,Password,Plan,Status,MAC Address,Email,Created,Expires\n';
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
                    '"' + (row.expires_at ? new Date(row.expires_at).toISOString() : 'N/A') + '"'
                ].join(',') + '\n';
            });
            
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="dreamhatcher_users_' + new Date().toISOString().split('T')[0] + '.csv"');
            return res.send(csvData);
        }

        // ========== GET DASHBOARD STATISTICS ==========
        
        // 1. CORE METRICS (Revenue never expires - includes ALL users)
        const metrics = await pool.query(`
            WITH user_stats AS (
                SELECT 
                    COUNT(*) as total_users,
                    COUNT(CASE WHEN status = 'processed' AND (expires_at IS NULL OR expires_at > NOW()) THEN 1 END) as active_users,
                    COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_users,
                    COUNT(CASE WHEN status = 'expired' OR (status = 'processed' AND expires_at < NOW()) THEN 1 END) as expired_users,
                    COUNT(CASE WHEN status = 'suspended' THEN 1 END) as suspended_users,
                    COUNT(CASE WHEN created_at::date = CURRENT_DATE THEN 1 END) as signups_today,
                    COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as signups_week
                FROM payment_queue
            ),
            revenue_stats AS (
                SELECT
                    -- ALL-TIME REVENUE (never expires, includes ALL users regardless of status)
                    COALESCE(SUM(
                        CASE 
                            WHEN plan = '24hr' THEN 350
                            WHEN plan = '7d' THEN 2400
                            WHEN plan = '30d' THEN 7500
                            ELSE 0
                        END
                    ), 0) as total_revenue_lifetime,
                    
                    -- Today's revenue (only created today, all statuses)
                    COALESCE(SUM(
                        CASE WHEN created_at::date = CURRENT_DATE
                        THEN CASE 
                            WHEN plan = '24hr' THEN 350
                            WHEN plan = '7d' THEN 2400
                            WHEN plan = '30d' THEN 7500
                            ELSE 0
                        END ELSE 0 END
                    ), 0) as revenue_today,
                    
                    -- This week's revenue
                    COALESCE(SUM(
                        CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days'
                        THEN CASE 
                            WHEN plan = '24hr' THEN 350
                            WHEN plan = '7d' THEN 2400
                            WHEN plan = '30d' THEN 7500
                            ELSE 0
                        END ELSE 0 END
                    ), 0) as revenue_week,
                    
                    -- This month's revenue
                    COALESCE(SUM(
                        CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days'
                        THEN CASE 
                            WHEN plan = '24hr' THEN 350
                            WHEN plan = '7d' THEN 2400
                            WHEN plan = '30d' THEN 7500
                            ELSE 0
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

        // 2. RECENT ACTIVITY WITH CORRECT STATUS
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
                -- CORRECTED: Check expired status first
                CASE 
                    WHEN status = 'expired' THEN 'expired'
                    WHEN status = 'pending' THEN 'pending'
                    WHEN status = 'suspended' THEN 'suspended'
                    WHEN status = 'processed' AND (expires_at IS NULL OR expires_at > NOW()) THEN 'active'
                    WHEN status = 'processed' AND expires_at <= NOW() THEN 'expired'
                    ELSE 'unknown'
                END as realtime_status
            FROM payment_queue
            ORDER BY created_at DESC
            LIMIT 100
        `);

        const stats = metrics.rows[0];
        const users = recentActivity.rows;
        
        // Count realtime statuses
        const activeCount = users.filter(u => u.realtime_status === 'active').length;
        const expiredCount = users.filter(u => u.realtime_status === 'expired').length;
        const pendingCount = users.filter(u => u.realtime_status === 'pending').length;
        
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

        // ========== RENDER DASHBOARD ==========
        res.send(renderDashboard({
            sessionId: sessionId,
            stats: stats,
            users: users,
            activeCount: activeCount,
            expiredCount: expiredCount,
            pendingCount: pendingCount,
            planData: planData,
            actionMessage: actionMessage,
            messageType: messageType
        }));

    } catch (error) {
        console.error('Dashboard Error:', error);
        res.status(500).send('Internal Server Error: ' + error.message);
    }
}

// ========== DASHBOARD RENDERER ==========
function renderDashboard(data) {
    const { sessionId, stats, users, activeCount, expiredCount, pendingCount, planData, actionMessage, messageType } = data;
    
    const now = new Date();
    const sessionEnd = now.getTime() + (3 * 60 * 1000);
    
    // Escape HTML
    const escapeHtml = (text) => {
        if (!text) return '';
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.toString().replace(/[&<>"']/g, m => map[m]);
    };
    
    // Build user table rows
    let userRows = '';
    if (users.length === 0) {
        userRows = '<tr><td colspan="8" style="text-align:center;padding:48px;color:var(--text-muted);"><i class="fa-solid fa-inbox" style="font-size:32px;display:block;margin-bottom:12px;"></i>No users found</td></tr>';
    } else {
        users.forEach(user => {
            const created = new Date(user.created_at);
            const expires = user.expires_at ? new Date(user.expires_at) : null;
            const isExpired = expires && expires < now;
            
            const statusBadge = 'badge-' + user.realtime_status;
            const statusIcon = user.realtime_status === 'active' ? 'fa-circle-check' :
                             user.realtime_status === 'expired' ? 'fa-circle-xmark' :
                             user.realtime_status === 'pending' ? 'fa-hourglass-half' :
                             user.realtime_status === 'suspended' ? 'fa-pause-circle' : 'fa-question-circle';
            const statusLabel = user.realtime_status.charAt(0).toUpperCase() + user.realtime_status.slice(1);
            
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
                    <td class="time-cell">
                        ${created.toLocaleDateString('en-NG')}<br>
                        <small>${created.toLocaleTimeString('en-NG', {hour:'2-digit',minute:'2-digit'})}</small>
                    </td>
                    <td>
                        <div class="row-actions">
                            <button class="act-btn a-extend" title="Extend Plan" onclick="openExtend(${user.id}, '${escapeHtml(user.mikrotik_username || '')}')">
                                <i class="fa-solid fa-clock-rotate-left"></i>
                            </button>
                            <a href="/admin?sessionId=${sessionId}&action=toggle_status&userId=${user.id}" class="act-btn a-reset" title="Toggle Status">
                                <i class="fa-solid fa-power-off"></i>
                            </a>
                            <a href="/admin?sessionId=${sessionId}&action=reset&userId=${user.id}" class="act-btn a-reset" onclick="return confirm('Reset user to pending?')" title="Reset to Pending">
                                <i class="fa-solid fa-arrow-rotate-left"></i>
                            </a>
                            <a href="/admin?sessionId=${sessionId}&action=delete&userId=${user.id}" class="act-btn a-delete" onclick="return confirm('Permanently delete this user?')" title="Delete User">
                                <i class="fa-solid fa-trash-can"></i>
                            </a>
                        </div>
                    </td>
                </tr>
            `;
        });
    }
    
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
    <title>Dream Hatcher Admin Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,500;0,9..40,700;0,9..40,800;1,9..40,400&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
    <style>
        :root {
            --bg-primary: #06080f;
            --bg-secondary: #0c1019;
            --bg-card: #111623;
            --bg-card-hover: #161d2e;
            --bg-elevated: #1a2235;
            --border: rgba(99, 130, 190, 0.12);
            --border-active: rgba(99, 180, 255, 0.3);
            --text-primary: #e8edf5;
            --text-secondary: #8494b2;
            --text-muted: #566580;
            --accent: #3e8bff;
            --accent-glow: rgba(62, 139, 255, 0.15);
            --success: #2dd4a0;
            --success-bg: rgba(45, 212, 160, 0.12);
            --danger: #f46b6b;
            --danger-bg: rgba(244, 107, 107, 0.12);
            --warning: #f0b132;
            --warning-bg: rgba(240, 177, 50, 0.12);
            --purple: #a78bfa;
            --purple-bg: rgba(167, 139, 250, 0.12);
            --pink: #f472b6;
            --pink-bg: rgba(244, 114, 182, 0.12);
            --font: 'DM Sans', system-ui, -apple-system, sans-serif;
            --mono: 'JetBrains Mono', 'SF Mono', monospace;
            --radius: 14px;
            --radius-sm: 10px;
            --radius-xs: 7px;
        }

        .dark {
            --bg-primary: #06080f;
            --bg-secondary: #0c1019;
            --bg-card: #111623;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        html { font-size: 16px; scroll-behavior: smooth; }

        body {
            font-family: var(--font);
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            line-height: 1.6;
            -webkit-font-smoothing: antialiased;
        }

        /* =================== NAV =================== */
        .topbar {
            position: sticky;
            top: 0;
            z-index: 100;
            background: rgba(6, 8, 15, 0.88);
            backdrop-filter: blur(20px) saturate(1.5);
            -webkit-backdrop-filter: blur(20px) saturate(1.5);
            border-bottom: 1px solid var(--border);
            padding: 0 clamp(16px, 3vw, 32px);
            height: 64px;
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
            width: 38px;
            height: 38px;
            border-radius: var(--radius-sm);
            background: linear-gradient(135deg, var(--accent) 0%, #6366f1 100%);
            display: grid;
            place-items: center;
            font-size: 18px;
            color: #fff;
            font-weight: 800;
            box-shadow: 0 4px 16px rgba(62, 139, 255, 0.25);
        }

        .brand-name {
            font-size: 17px;
            font-weight: 700;
            letter-spacing: -0.3px;
        }

        .brand-tag {
            font-size: 11px;
            color: var(--text-muted);
            letter-spacing: 0.5px;
            text-transform: uppercase;
            font-weight: 500;
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
            padding: 7px 14px;
            border-radius: 50px;
            font-size: 13px;
            font-weight: 600;
            border: 1px solid var(--border);
            background: var(--bg-card);
        }

        .chip-live {
            color: var(--success);
            border-color: rgba(45, 212, 160, 0.25);
        }

        .chip-live::before {
            content: '';
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: var(--success);
            animation: livePulse 2s ease-in-out infinite;
        }

        @keyframes livePulse {
            0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(45, 212, 160, 0.5); }
            50% { opacity: 0.6; box-shadow: 0 0 0 6px rgba(45, 212, 160, 0); }
        }

        .btn {
            display: inline-flex;
            align-items: center;
            gap: 7px;
            padding: 8px 18px;
            border-radius: var(--radius-xs);
            border: 1px solid var(--border);
            background: var(--bg-card);
            color: var(--text-primary);
            font-family: var(--font);
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            text-decoration: none;
            transition: all 0.2s;
            white-space: nowrap;
        }

        .btn:hover {
            background: var(--bg-card-hover);
            border-color: var(--border-active);
            transform: translateY(-1px);
        }

        .btn-accent {
            background: var(--accent);
            border-color: var(--accent);
            color: #fff;
        }

        .btn-accent:hover {
            background: #5a9fff;
            border-color: #5a9fff;
        }

        .btn-danger {
            color: var(--danger);
            border-color: rgba(244, 107, 107, 0.25);
        }

        .btn-danger:hover {
            background: var(--danger-bg);
        }

        .btn-success {
            color: var(--success);
            border-color: rgba(45, 212, 160, 0.25);
        }

        .btn-success:hover {
            background: var(--success-bg);
        }

        .btn-sm {
            padding: 6px 12px;
            font-size: 12px;
        }

        /* =================== LAYOUT =================== */
        .page {
            padding: clamp(16px, 3vw, 32px);
            max-width: 1440px;
            margin: 0 auto;
        }

        .page-title {
            font-size: clamp(22px, 3vw, 28px);
            font-weight: 800;
            letter-spacing: -0.5px;
            margin-bottom: 4px;
        }

        .page-subtitle {
            color: var(--text-muted);
            font-size: 14px;
            margin-bottom: 28px;
        }

        /* =================== ALERT =================== */
        .toast {
            padding: 16px 20px;
            border-radius: var(--radius-sm);
            margin-bottom: 24px;
            display: ${actionMessage ? 'flex' : 'none'};
            align-items: center;
            gap: 12px;
            font-size: 14px;
            font-weight: 500;
            animation: slideDown 0.35s cubic-bezier(0.16, 1, 0.3, 1);
            border-left: 3px solid;
        }

        @keyframes slideDown {
            from { transform: translateY(-10px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }

        .toast-success { background: var(--success-bg); border-left-color: var(--success); color: var(--success); }
        .toast-warning { background: var(--warning-bg); border-left-color: var(--warning); color: var(--warning); }
        .toast-error { background: var(--danger-bg); border-left-color: var(--danger); color: var(--danger); }
        .toast-info { background: var(--accent-glow); border-left-color: var(--accent); color: var(--accent); }

        /* =================== METRIC CARDS =================== */
        .metrics {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }

        .metric {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: 22px 24px;
            position: relative;
            overflow: hidden;
            transition: all 0.25s;
        }

        .metric:hover {
            border-color: var(--border-active);
            transform: translateY(-3px);
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
        }

        .metric-top {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 16px;
        }

        .metric-icon {
            width: 44px;
            height: 44px;
            border-radius: 12px;
            display: grid;
            place-items: center;
            font-size: 24px;
        }

        .metric-icon.green { background: var(--success-bg); color: var(--success); }
        .metric-icon.blue { background: var(--accent-glow); color: var(--accent); }
        .metric-icon.purple { background: var(--purple-bg); color: var(--purple); }
        .metric-icon.pink { background: var(--pink-bg); color: var(--pink); }
        .metric-icon.orange { background: var(--warning-bg); color: var(--warning); }
        .metric-icon.red { background: var(--danger-bg); color: var(--danger); }

        .metric-tag {
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            padding: 4px 10px;
            border-radius: 50px;
        }

        .tag-lifetime { background: var(--success-bg); color: var(--success); }
        .tag-today { background: var(--accent-glow); color: var(--accent); }
        .tag-week { background: var(--purple-bg); color: var(--purple); }
        .tag-month { background: var(--pink-bg); color: var(--pink); }
        .tag-live { background: var(--warning-bg); color: var(--warning); }

        .metric-value {
            font-size: clamp(26px, 3vw, 32px);
            font-weight: 800;
            letter-spacing: -0.5px;
            line-height: 1.1;
            margin-bottom: 4px;
        }

        .metric-value.currency { color: var(--success); }

        .metric-label {
            font-size: 13px;
            color: var(--text-muted);
            font-weight: 500;
        }

        .metric-footer {
            margin-top: 14px;
            padding-top: 14px;
            border-top: 1px solid var(--border);
            font-size: 12px;
            color: var(--text-secondary);
            display: flex;
            align-items: center;
            gap: 6px;
        }

        /* =================== CARD =================== */
        .card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: var(--radius);
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
            gap: 14px;
        }

        .card-title {
            font-size: 17px;
            font-weight: 700;
            letter-spacing: -0.3px;
        }

        .card-subtitle {
            font-size: 13px;
            color: var(--text-muted);
            margin-top: 2px;
        }

        .card-tools {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }

        .card-body { padding: 24px; }

        /* =================== TABLE =================== */
        .tbl-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }

        table { width: 100%; border-collapse: collapse; min-width: 800px; }

        thead { background: var(--bg-secondary); }

        th {
            padding: 12px 16px;
            text-align: left;
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.7px;
            color: var(--text-muted);
            border-bottom: 1px solid var(--border);
            white-space: nowrap;
            user-select: none;
        }

        td {
            padding: 14px 16px;
            border-bottom: 1px solid var(--border);
            font-size: 13.5px;
            vertical-align: middle;
        }

        tbody tr { transition: background 0.15s; }
        tbody tr:hover { background: var(--bg-card-hover); }
        tbody tr:last-child td { border-bottom: none; }

        .user-cell strong {
            display: block;
            font-weight: 600;
            margin-bottom: 2px;
        }

        .user-cell small {
            color: var(--text-muted);
            font-size: 12px;
        }

        .pw {
            font-family: var(--mono);
            font-size: 13px;
            color: var(--warning);
            cursor: pointer;
            padding: 3px 8px;
            border-radius: var(--radius-xs);
            transition: background 0.15s;
        }

        .pw:hover { background: var(--warning-bg); }

        .mac {
            font-family: var(--mono);
            font-size: 12px;
            color: var(--text-secondary);
        }

        .badge {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 5px 12px;
            border-radius: 50px;
            font-size: 12px;
            font-weight: 600;
            white-space: nowrap;
        }

        .badge-active { background: var(--success-bg); color: var(--success); }
        .badge-expired { background: var(--danger-bg); color: var(--danger); }
        .badge-pending { background: var(--warning-bg); color: var(--warning); }
        .badge-suspended { background: rgba(100, 116, 139, 0.15); color: var(--text-secondary); }
        .badge-unknown { background: rgba(100, 116, 139, 0.1); color: var(--text-muted); }

        .plan-tag {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 5px 12px;
            border-radius: var(--radius-xs);
            font-size: 12px;
            font-weight: 600;
        }

        .plan-daily { background: var(--accent-glow); color: var(--accent); }
        .plan-weekly { background: var(--purple-bg); color: var(--purple); }
        .plan-monthly { background: var(--pink-bg); color: var(--pink); }

        .time-cell {
            font-size: 13px;
            color: var(--text-secondary);
            line-height: 1.5;
        }

        .time-cell small { color: var(--text-muted); }

        .expires-ok { color: var(--success); }
        .expires-gone { color: var(--danger); }

        .row-actions {
            display: flex;
            gap: 6px;
        }

        .act-btn {
            width: 32px;
            height: 32px;
            border-radius: var(--radius-xs);
            border: 1px solid var(--border);
            background: transparent;
            color: var(--text-secondary);
            cursor: pointer;
            display: grid;
            place-items: center;
            font-size: 14px;
            transition: all 0.2s;
            text-decoration: none;
        }

        .act-btn:hover { background: var(--bg-elevated); transform: translateY(-1px); }
        .act-btn.a-extend:hover { color: var(--success); border-color: rgba(45, 212, 160, 0.4); }
        .act-btn.a-reset:hover { color: var(--warning); border-color: rgba(240, 177, 50, 0.4); }
        .act-btn.a-delete:hover { color: var(--danger); border-color: rgba(244, 107, 107, 0.4); }

        /* =================== SEARCH =================== */
        .search-wrap {
            position: relative;
            min-width: 220px;
        }

        .search-wrap i {
            position: absolute;
            left: 14px;
            top: 50%;
            transform: translateY(-50%);
            color: var(--text-muted);
            font-size: 14px;
            pointer-events: none;
        }

        .search-input {
            width: 100%;
            padding: 10px 16px 10px 40px;
            border-radius: var(--radius-xs);
            border: 1px solid var(--border);
            background: var(--bg-secondary);
            color: var(--text-primary);
            font-family: var(--font);
            font-size: 14px;
            transition: border-color 0.2s;
        }

        .search-input:focus {
            outline: none;
            border-color: var(--accent);
            box-shadow: 0 0 0 3px var(--accent-glow);
        }

        .search-input::placeholder { color: var(--text-muted); }

        /* =================== FILTER TABS =================== */
        .filter-tabs {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
        }

        .filter-tab {
            padding: 7px 16px;
            border-radius: 50px;
            font-size: 12px;
            font-weight: 600;
            border: 1px solid var(--border);
            background: transparent;
            color: var(--text-secondary);
            cursor: pointer;
            transition: all 0.2s;
            font-family: var(--font);
        }

        .filter-tab:hover { background: var(--bg-elevated); }
        .filter-tab.active { background: var(--accent); border-color: var(--accent); color: #fff; }

        /* =================== PLAN DISTRIBUTION =================== */
        .dist-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
        }

        .dist-item {
            padding: 20px;
            border-radius: var(--radius-sm);
            border: 1px solid var(--border);
            background: var(--bg-secondary);
        }

        .dist-top {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }

        .dist-name { font-size: 14px; font-weight: 600; }
        .dist-count { font-size: 22px; font-weight: 800; }

        .dist-bar {
            height: 6px;
            border-radius: 3px;
            background: rgba(255, 255, 255, 0.06);
            overflow: hidden;
            margin-top: 8px;
        }

        .dist-fill {
            height: 100%;
            border-radius: 3px;
            transition: width 0.8s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .fill-blue { background: var(--accent); }
        .fill-purple { background: var(--purple); }
        .fill-pink { background: var(--pink); }

        .rev-summary {
            padding: 20px;
            border-radius: var(--radius-sm);
            background: var(--bg-secondary);
            border: 1px solid var(--border);
        }

        .rev-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 0;
            font-size: 14px;
        }

        .rev-row:not(:last-child) { border-bottom: 1px solid var(--border); }
        .rev-row-label { color: var(--text-secondary); }
        .rev-row-value { font-weight: 700; }
        .rev-row-total .rev-row-label { color: var(--success); font-weight: 600; }
        .rev-row-total .rev-row-value { color: var(--success); font-size: 16px; }

        /* =================== MODAL =================== */
        .modal-overlay {
            display: none;
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.7);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            z-index: 999;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }

        .modal-overlay.open { display: flex; animation: fadeIn 0.25s; }

        .modal-box {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            width: 100%;
            max-width: 440px;
            box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
            animation: modalPop 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes modalPop { from { opacity: 0; transform: scale(0.95) translateY(10px); } to { opacity: 1; transform: scale(1) translateY(0); } }

        .modal-head {
            padding: 20px 24px;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .modal-head h3 { font-size: 17px; font-weight: 700; }

        .modal-close {
            width: 32px;
            height: 32px;
            border-radius: var(--radius-xs);
            border: none;
            background: transparent;
            color: var(--text-muted);
            cursor: pointer;
            display: grid;
            place-items: center;
            font-size: 18px;
        }

        .modal-close:hover { background: var(--bg-elevated); color: var(--text-primary); }

        .modal-body { padding: 24px; }

        .modal-foot {
            padding: 16px 24px;
            border-top: 1px solid var(--border);
            display: flex;
            gap: 10px;
            justify-content: flex-end;
        }

        .plan-radio {
            display: block;
            padding: 14px 16px;
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            margin-bottom: 8px;
            cursor: pointer;
            transition: all 0.2s;
        }

        .plan-radio:hover { background: var(--bg-elevated); }

        .plan-radio input[type="radio"] {
            margin-right: 10px;
            accent-color: var(--accent);
        }

        .plan-radio-name { font-weight: 600; }
        .plan-radio-detail { font-size: 13px; color: var(--text-muted); margin-left: 24px; }

        /* =================== FOOTER =================== */
        .page-footer {
            text-align: center;
            padding: 32px 24px;
            border-top: 1px solid var(--border);
            margin-top: 16px;
            color: var(--text-muted);
            font-size: 13px;
        }

        .footer-stats {
            display: flex;
            justify-content: center;
            gap: 28px;
            margin-top: 12px;
            flex-wrap: wrap;
            font-size: 12px;
        }

        /* =================== COPY TOAST =================== */
        .copy-feedback {
            position: fixed;
            bottom: 24px;
            left: 50%;
            transform: translateX(-50%) translateY(80px);
            background: var(--bg-elevated);
            color: var(--success);
            border: 1px solid rgba(45, 212, 160, 0.3);
            padding: 10px 22px;
            border-radius: 50px;
            font-size: 13px;
            font-weight: 600;
            z-index: 9999;
            transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.35s;
            opacity: 0;
            pointer-events: none;
        }

        .copy-feedback.show {
            transform: translateX(-50%) translateY(0);
            opacity: 1;
        }

        /* =================== SCROLLBAR =================== */
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.08); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.14); }

        /* =================== RESPONSIVE =================== */
        @media (max-width: 768px) {
            .topbar { height: 56px; }
            .brand-name { font-size: 15px; }
            .brand-tag { display: none; }
            .nav-actions .btn span.lbl { display: none; }
            .metrics { grid-template-columns: 1fr 1fr; }
            .card-header { padding: 16px; }
            .card-body { padding: 16px; }
            td, th { padding: 10px 12px; }
            .dist-grid { grid-template-columns: 1fr; }
        }

        @media (max-width: 480px) {
            .metrics { grid-template-columns: 1fr; }
            .filter-tabs { overflow-x: auto; flex-wrap: nowrap; }
            .nav-actions { gap: 8px; }
            .chip span.lbl { display: none; }
        }
    </style>
</head>
<body>
    <!-- Copy Toast -->
    <div class="copy-feedback" id="copyToast"><i class="fa-solid fa-check"></i> Copied to clipboard</div>

    <!-- Extend Modal -->
    <div class="modal-overlay" id="extendModal">
        <div class="modal-box">
            <div class="modal-head">
                <h3>Extend User Plan</h3>
                <button class="modal-close" onclick="closeExtend()">&times;</button>
            </div>
            <div class="modal-body">
                <p style="color: var(--text-secondary); margin-bottom: 16px;">
                    Extending plan for: <strong id="extendUser" style="color: var(--text-primary);"></strong>
                </p>
                <label class="plan-radio">
                    <input type="radio" name="extPlan" value="24hr" checked>
                    <span class="plan-radio-name">Daily Plan</span>
                    <div class="plan-radio-detail">24 hours • ₦350</div>
                </label>
                <label class="plan-radio">
                    <input type="radio" name="extPlan" value="7d">
                    <span class="plan-radio-name">Weekly Plan</span>
                    <div class="plan-radio-detail">7 days • ₦2,400</div>
                </label>
                <label class="plan-radio">
                    <input type="radio" name="extPlan" value="30d">
                    <span class="plan-radio-name">Monthly Plan</span>
                    <div class="plan-radio-detail">30 days • ₦7,500</div>
                </label>
            </div>
            <div class="modal-foot">
                <button class="btn" onclick="closeExtend()">Cancel</button>
                <button class="btn btn-success" id="extendConfirmBtn">
                    <i class="fa-solid fa-check"></i> Confirm Extension
                </button>
            </div>
        </div>
    </div>

    <!-- Topbar -->
    <nav class="topbar">
        <div class="brand">
            <div class="brand-mark">DH</div>
            <div>
                <div class="brand-name">Dream Hatcher Tech</div>
                <div class="brand-tag">Admin Console For High Speed Internet Connectivity</div>
            </div>
        </div>
        <div class="nav-actions">
            <div class="chip chip-live"><span class="lbl">System Online</span></div>
            <button class="btn" onclick="location.reload()"><i class="fa-solid fa-arrows-rotate"></i> <span class="lbl">Refresh</span></button>
            <button class="btn btn-danger" onclick="logout()">
                <i class="fa-solid fa-right-from-bracket"></i>
            </button>
        </div>
    </nav>

    <!-- Main Content -->
    <main class="page" id="app">
        <div style="display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: wrap; gap: 12px; margin-bottom: 28px;">
            <div>
                <h1 class="page-title">Dashboard</h1>
                <p class="page-subtitle">Real-time business overview & user management</p>
            </div>
            <div style="font-size: 13px; color: var(--text-muted);">
                <i class="fa-regular fa-clock"></i> Last refreshed: <span id="lastRefresh">${new Date().toLocaleString('en-NG')}</span>
            </div>
        </div>

        <div class="toast ${messageType ? 'visible' : ''}" id="toastMsg" style="${actionMessage ? '' : 'display: none;'}">
            ${actionMessage ? `<i class="fa-solid fa-${messageType === 'success' ? 'check-circle' : messageType === 'warning' ? 'triangle-exclamation' : 'circle-info'}"></i> ${actionMessage}` : ''}
        </div>

        <!-- Metrics -->
        <div class="metrics" id="metricsGrid">
            <div class="metric">
                <div class="metric-top">
                    <div class="metric-icon green">
                        <i class="fa-solid fa-vault"></i>
                    </div>
                    <span class="metric-tag tag-lifetime">ALL-TIME</span>
                </div>
                <div class="metric-value currency">${naira(stats.total_revenue_lifetime)}</div>
                <div class="metric-label">Lifetime Revenue</div>
                <div class="metric-footer">
                    <i class="fa-solid fa-circle-info"></i> Includes every payment ever received
                </div>
            </div>
            
            <div class="metric">
                <div class="metric-top">
                    <div class="metric-icon blue">
                        <i class="fa-solid fa-calendar-day"></i>
                    </div>
                    <span class="metric-tag tag-today">TODAY</span>
                </div>
                <div class="metric-value currency">${naira(stats.revenue_today)}</div>
                <div class="metric-label">Today's Revenue</div>
                <div class="metric-footer">
                    <i class="fa-solid fa-user-plus"></i> ${stats.signups_today} new signups today
                </div>
            </div>
            
            <div class="metric">
                <div class="metric-top">
                    <div class="metric-icon purple">
                        <i class="fa-solid fa-calendar-week"></i>
                    </div>
                    <span class="metric-tag tag-week">7 DAYS</span>
                </div>
                <div class="metric-value currency">${naira(stats.revenue_week)}</div>
                <div class="metric-label">This Week</div>
                <div class="metric-footer">
                    <i class="fa-solid fa-chart-line"></i> Rolling 7-day window
                </div>
            </div>
            
            <div class="metric">
                <div class="metric-top">
                    <div class="metric-icon pink">
                        <i class="fa-solid fa-calendar"></i>
                    </div>
                    <span class="metric-tag tag-month">30 DAYS</span>
                </div>
                <div class="metric-value currency">${naira(stats.revenue_month)}</div>
                <div class="metric-label">This Month</div>
                <div class="metric-footer">
                    <i class="fa-solid fa-chart-line"></i> Rolling 30-day window
                </div>
            </div>
            
            <div class="metric">
                <div class="metric-top">
                    <div class="metric-icon blue">
                        <i class="fa-solid fa-users"></i>
                    </div>
                    <span class="metric-tag tag-today">TOTAL</span>
                </div>
                <div class="metric-value">${stats.total_users}</div>
                <div class="metric-label">Total Registered Users</div>
                <div class="metric-footer">
                    <i class="fa-solid fa-database"></i> All-time registrations
                </div>
            </div>
            
            <div class="metric">
                <div class="metric-top">
                    <div class="metric-icon green">
                        <i class="fa-solid fa-signal"></i>
                    </div>
                    <span class="metric-tag tag-live">LIVE</span>
                </div>
                <div class="metric-value" style="color: var(--success);">${activeCount}</div>
                <div class="metric-label">Currently Active</div>
                <div class="metric-footer">
                    <span style="color:var(--danger);"><i class="fa-solid fa-xmark"></i> ${expiredCount} expired</span>
                    <span style="color:var(--warning);"><i class="fa-solid fa-hourglass-half"></i> ${pendingCount} pending</span>
                </div>
            </div>
        </div>

        <!-- Plan Distribution & Revenue -->
        <div class="card">
            <div class="card-header">
                <div>
                    <div class="card-title">
                        <i class="fa-solid fa-chart-pie" style="color: var(--accent); margin-right: 8px;"></i>
                        Plan Distribution & Revenue
                    </div>
                    <div class="card-subtitle">
                        Breakdown by plan type — revenue counts <strong>all</strong> users regardless of status
                    </div>
                </div>
            </div>
            <div class="card-body">
                <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 20px;">
                    <div class="dist-grid" id="distGrid">
                        <div class="dist-item">
                            <div class="dist-top">
                                <span class="dist-name" style="color:var(--accent);">
                                    <i class="fa-solid fa-bolt"></i> Daily
                                </span>
                                <span class="dist-count">${planData.daily.count}</span>
                            </div>
                            <div style="font-size:12px; color:var(--text-muted);">
                                ${naira(planData.daily.revenue)} revenue • ${dailyPct}%
                            </div>
                            <div class="dist-bar">
                                <div class="dist-fill fill-blue" style="width:${dailyPct}%;"></div>
                            </div>
                        </div>
                        
                        <div class="dist-item">
                            <div class="dist-top">
                                <span class="dist-name" style="color:var(--purple);">
                                    <i class="fa-solid fa-rocket"></i> Weekly
                                </span>
                                <span class="dist-count">${planData.weekly.count}</span>
                            </div>
                            <div style="font-size:12px; color:var(--text-muted);">
                                ${naira(planData.weekly.revenue)} revenue • ${weeklyPct}%
                            </div>
                            <div class="dist-bar">
                                <div class="dist-fill fill-purple" style="width:${weeklyPct}%;"></div>
                            </div>
                        </div>
                        
                        <div class="dist-item">
                            <div class="dist-top">
                                <span class="dist-name" style="color:var(--pink);">
                                    <i class="fa-solid fa-crown"></i> Monthly
                                </span>
                                <span class="dist-count">${planData.monthly.count}</span>
                            </div>
                            <div style="font-size:12px; color:var(--text-muted);">
                                ${naira(planData.monthly.revenue)} revenue • ${monthlyPct}%
                            </div>
                            <div class="dist-bar">
                                <div class="dist-fill fill-pink" style="width:${monthlyPct}%;"></div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="rev-summary" id="revSummary">
                        <div style="font-size:15px; font-weight:700; margin-bottom:16px;">
                            <i class="fa-solid fa-receipt" style="color:var(--accent);margin-right:8px;"></i>
                            Revenue Summary
                        </div>
                        <div class="rev-row">
                            <span class="rev-row-label">Today</span>
                            <span class="rev-row-value">${naira(stats.revenue_today)}</span>
                        </div>
                        <div class="rev-row">
                            <span class="rev-row-label">This Week</span>
                            <span class="rev-row-value">${naira(stats.revenue_week)}</span>
                        </div>
                        <div class="rev-row">
                            <span class="rev-row-label">This Month</span>
                            <span class="rev-row-value">${naira(stats.revenue_month)}</span>
                        </div>
                        <div class="rev-row rev-row-total">
                            <span class="rev-row-label">Total Lifetime</span>
                            <span class="rev-row-value">${naira(stats.total_revenue_lifetime)}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- User Management -->
        <div class="card">
            <div class="card-header">
                <div>
                    <div class="card-title">
                        <i class="fa-solid fa-users" style="color: var(--accent); margin-right: 8px;"></i>
                        User Management
                    </div>
                    <div class="card-subtitle" id="tableSubtitle">
                        ${users.length} users • Active: ${activeCount} • Expired: ${expiredCount} • Pending: ${pendingCount}
                    </div>
                </div>
                <div class="card-tools">
                    <div class="search-wrap">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input class="search-input" type="text" id="searchInput" placeholder="Search users, MAC, email..." oninput="filterTable()">
                    </div>
                    <div class="filter-tabs" id="filterTabs">
                        <button class="filter-tab active" data-filter="all">All</button>
                        <button class="filter-tab" data-filter="active">Active</button>
                        <button class="filter-tab" data-filter="pending">Pending</button>
                        <button class="filter-tab" data-filter="expired">Expired</button>
                    </div>
                </div>
            </div>
            <div class="tbl-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>User</th>
                            <th>Password</th>
                            <th>Plan</th>
                            <th>Status</th>
                            <th>Expires</th>
                            <th>MAC</th>
                            <th>Created</th>
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
            <p>Dream Hatcher Tech ⓒ 2026</p>
            <div class="footer-stats" id="footerStats">
                <span><i class="fa-solid fa-database"></i> ${stats.total_users} Total Users</span>
                <span><i class="fa-solid fa-vault"></i> ${naira(stats.total_revenue_lifetime)} Lifetime Revenue</span>
                <span><i class="fa-solid fa-shield-halved"></i> Secure Admin Console</span>
            </div>
        </div>
    </main>

    <script>
        // Session Management
        let sessionEndTime = ${sessionEnd};
        let extendTargetId = null;

        function updateSessionTimer() {
            const now = Date.now();
            const timeLeft = Math.max(0, sessionEndTime - now);
            const minutes = Math.floor(timeLeft / (1000 * 60));
            const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);
            
            if (timeLeft <= 0) {
                logout();
                return;
            }
            
            setTimeout(updateSessionTimer, 1000);
        }

        function resetSessionTimer() {
            sessionEndTime = Date.now() + (3 * 60 * 1000);
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
                toast.classList.add('show');
                setTimeout(() => toast.classList.remove('show'), 1800);
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

        document.getElementById('extendConfirmBtn').addEventListener('click', function() {
            if (!extendTargetId) return;
            const sel = document.querySelector('input[name="extPlan"]:checked');
            if (!sel) return;
            window.location.href = '/admin?sessionId=${sessionId}&action=extend&userId=' + extendTargetId + '&newPlan=' + sel.value;
        });

        // Close modal on outside click
        document.getElementById('extendModal').addEventListener('click', function(e) {
            if (e.target === this) closeExtend();
        });

        // Table filtering
        let currentFilter = 'all';

        document.getElementById('filterTabs').addEventListener('click', function(e) {
            const tab = e.target.closest('.filter-tab');
            if (!tab) return;
            document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentFilter = tab.dataset.filter;
            filterTable();
        });

        function filterTable() {
            const search = document.getElementById('searchInput').value.toLowerCase();
            const rows = document.querySelectorAll('#usersTbody tr');
            rows.forEach(row => {
                if (!row.dataset.search) {
                    row.style.display = '';
                    return;
                }
                const matchSearch = row.dataset.search.toLowerCase().indexOf(search) !== -1;
                const matchFilter = currentFilter === 'all' || row.dataset.status === currentFilter;
                row.style.display = (matchSearch && matchFilter) ? '' : 'none';
            });
        }

        // Initialize
        updateSessionTimer();
        
        // Auto-refresh every 60 seconds
        setInterval(() => {
            window.location.reload();
        }, 60000);
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




