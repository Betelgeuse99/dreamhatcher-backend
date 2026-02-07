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
// ENTERPRISE ADMIN DASHBOARD v3.0 - FIXED VERSION
// Professional WiFi Management System
// ============================================

// Security Configuration
const ADMIN_PASSWORD = 'dreamhatcher2024'; // CHANGE IN PRODUCTION!
const SESSION_TIMEOUT = 3 * 60 * 1000; // 3 minutes strict

// Simple session storage
const adminSessions = {};

// ========== ADMIN DASHBOARD ROUTE ==========
app.get('/admin', async (req, res) => {
  const { pwd, action, userId, newPlan, sessionId, exportData } = req.query;
  
  // Session-based authentication
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
    
    // Continue with authenticated session
    return handleAdminDashboard(req, res, sessionId, action, userId, newPlan, exportData);
  }
  
  // Password-based initial login
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
  
  // Show login form
  return res.send(getLoginForm(req.query.sessionExpired));
});

// ========== ADMIN DASHBOARD HANDLER ==========
async function handleAdminDashboard(req, res, sessionId, action, userId, newPlan, exportData) {
  try {
    let actionMessage = '';
    let messageType = '';

    // Handle admin actions
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
        'UPDATE payment_queue SET status = \'pending\', mikrotik_sync = false, expires_at = NULL WHERE id = $1',
        [userId]
      );
      actionMessage = 'User reset to pending - will be recreated on MikroTik';
      messageType = 'warning';
    }

    if (action === 'toggle_status' && userId) {
      const current = await pool.query('SELECT status FROM payment_queue WHERE id = $1', [userId]);
      const newStatus = current.rows[0].status === 'active' ? 'suspended' : 'active';
      await pool.query('UPDATE payment_queue SET status = $1 WHERE id = $2', [newStatus, userId]);
      actionMessage = 'User status changed to ' + newStatus;
      messageType = 'info';
    }

    // EXPORT FUNCTIONALITY
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
          expires_at,
          EXTRACT(EPOCH FROM (expires_at - created_at))/86400 as duration_days
        FROM payment_queue 
        ORDER BY created_at DESC
      `);
      
      let csvData = 'ID,Username,Password,Plan,Status,MAC Address,Email,Created,Expires,Duration (days)\n';
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
          '"' + (row.duration_days ? Math.round(row.duration_days) : 'N/A') + '"'
        ].join(',') + '\n';
      });
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="dreamhatcher_users_' + new Date().toISOString().split('T')[0] + '.csv"');
      return res.send(csvData);
    }

    // Get dashboard statistics
    const metrics = await pool.query(`
      WITH user_stats AS (
        SELECT 
          COUNT(*) as total_users,
          COUNT(CASE WHEN status = 'processed' THEN 1 END) as active_users,
          COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_users,
          COUNT(CASE WHEN status = 'expired' THEN 1 END) as expired_users,
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
            CASE WHEN created_at::date = CURRENT_DATE AND status = 'processed'
            THEN CASE 
              WHEN plan = '24hr' THEN 350
              WHEN plan = '7d' THEN 2400
              WHEN plan = '30d' THEN 7500
              ELSE 0
            END ELSE 0 END
          ), 0) as revenue_today,
          
          COALESCE(SUM(
            CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' AND status = 'processed'
            THEN CASE 
              WHEN plan = '24hr' THEN 350
              WHEN plan = '7d' THEN 2400
              WHEN plan = '30d' THEN 7500
              ELSE 0
            END ELSE 0 END
          ), 0) as revenue_week,
          
          COALESCE(SUM(
            CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' AND status = 'processed'
            THEN CASE 
              WHEN plan = '24hr' THEN 350
              WHEN plan = '7d' THEN 2400
              WHEN plan = '30d' THEN 7500
              ELSE 0
            END ELSE 0 END
          ), 0) as revenue_month,
          
          COALESCE(AVG(
            CASE 
              WHEN plan = '24hr' THEN 350
              WHEN plan = '7d' THEN 2400
              WHEN plan = '30d' THEN 7500
              ELSE 0
            END
          ), 0) as avg_revenue_per_user
        FROM payment_queue
        WHERE status = 'processed'
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
        WHERE status = 'processed'
        GROUP BY plan
      ),
      growth_metrics AS (
        SELECT
          (COUNT(CASE WHEN created_at::date = CURRENT_DATE THEN 1 END) * 100.0 / 
           NULLIF(COUNT(CASE WHEN created_at::date = CURRENT_DATE - INTERVAL '1 day' THEN 1 END), 0)) as daily_growth_rate,
          
          COALESCE(SUM(
            CASE WHEN plan = '30d' THEN 7500/30
                 WHEN plan = '7d' THEN 2400/7
                 WHEN plan = '24hr' THEN 350
                 ELSE 0
            END
          ), 0) as mrr_projection
        FROM payment_queue
        WHERE status = 'processed' 
        AND expires_at > NOW()
      )
      SELECT 
        u.*, 
        r.*,
        g.*,
        json_agg(json_build_object('plan', p.plan, 'count', p.count, 'revenue', p.revenue)) as plans_data
      FROM user_stats u, revenue_stats r, growth_metrics g, plan_distribution p
      GROUP BY 
        u.total_users, u.active_users, u.pending_users, u.expired_users, u.suspended_users, 
        u.signups_today, u.signups_week, r.total_revenue_lifetime, r.revenue_today, 
        r.revenue_week, r.revenue_month, r.avg_revenue_per_user, g.daily_growth_rate, g.mrr_projection
    `);

    // Real-time status
    const realtimeStatus = await pool.query(`
      SELECT
        COUNT(CASE WHEN status = 'processed' AND (expires_at IS NULL OR expires_at > NOW()) THEN 1 END) as currently_active,
        COUNT(CASE WHEN status = 'processed' AND expires_at < NOW() THEN 1 END) as currently_expired,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as currently_pending,
        COUNT(CASE WHEN status = 'suspended' THEN 1 END) as currently_suspended
      FROM payment_queue
    `);

    // Recent activity
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
        CASE 
          WHEN status = 'suspended' THEN 'suspended'
          WHEN status = 'expired' THEN 'expired'
          WHEN status = 'pending' THEN 'pending'
          WHEN status = 'processed' AND expires_at IS NOT NULL AND expires_at < NOW() THEN 'expired'
          WHEN status = 'processed' THEN 'active'
          ELSE 'unknown'
        END as realtime_status,
        CASE 
          WHEN plan = '24hr' THEN 'Daily'
          WHEN plan = '7d' THEN 'Weekly'
          WHEN plan = '30d' THEN 'Monthly'
          ELSE plan
        END as plan_name
      FROM payment_queue
      ORDER BY created_at DESC
      LIMIT 100
    `);

    // Performance analytics
    const performance = await pool.query(`
      SELECT
        DATE(created_at) as date,
        COUNT(*) as signups,
        SUM(CASE 
          WHEN plan = '24hr' THEN 350
          WHEN plan = '7d' THEN 2400
          WHEN plan = '30d' THEN 7500
          ELSE 0
        END) as daily_revenue
      FROM payment_queue
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
        AND status = 'processed'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);

    const stats = metrics.rows[0];
    const realtime = realtimeStatus.rows[0];
    const perfData = performance.rows;
    
    // Format dates for chart
    const chartLabels = perfData.map(p => {
      const date = new Date(p.date);
      return date.getDate() + ' ' + date.toLocaleString('en-NG', { month: 'short' });
    }).reverse();
    
    const chartData = perfData.map(p => p.daily_revenue).reverse();

    // Send the dashboard HTML
    res.send(getDashboardHTML({
      sessionId: sessionId,
      stats: stats,
      realtime: realtime,
      recentActivity: recentActivity.rows,
      chartLabels: chartLabels,
      chartData: chartData,
      actionMessage: actionMessage,
      messageType: messageType,
      perfData: perfData
    }));

  } catch (error) {
    console.error('Dashboard Error:', error);
    res.status(500).send(getErrorPage(error.message));
  }
}

// ========== HELPER FUNCTIONS ==========

function getLoginForm(sessionExpired) {
  return '<!DOCTYPE html>' +
'<html lang="en">' +
'<head>' +
'    <meta charset="UTF-8">' +
'    <meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'    <title>Admin Portal • Dream Hatcher</title>' +
'    <style>' +
'        :root {' +
'            --primary: #0066ff;' +
'            --primary-dark: #0052d4;' +
'            --secondary: #00c9ff;' +
'            --success: #10b981;' +
'            --danger: #ef4444;' +
'            --warning: #f59e0b;' +
'            --dark: #0a0e1a;' +
'            --darker: #050811;' +
'            --light: #f8fafc;' +
'            --gray: #64748b;' +
'            --border: rgba(255,255,255,0.1);' +
'        }' +
'        ' +
'        * {' +
'            margin: 0;' +
'            padding: 0;' +
'            box-sizing: border-box;' +
'            font-family: \'Segoe UI\', system-ui, -apple-system, sans-serif;' +
'        }' +
'        ' +
'        body {' +
'            background: linear-gradient(135deg, var(--darker) 0%, var(--dark) 100%);' +
'            min-height: 100vh;' +
'            display: flex;' +
'            align-items: center;' +
'            justify-content: center;' +
'            padding: 20px;' +
'            color: var(--light);' +
'        }' +
'        ' +
'        .login-container {' +
'            width: 100%;' +
'            max-width: 420px;' +
'        }' +
'        ' +
'        .login-card {' +
'            background: rgba(255, 255, 255, 0.05);' +
'            backdrop-filter: blur(10px);' +
'            border-radius: 20px;' +
'            border: 1px solid var(--border);' +
'            padding: 40px;' +
'            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);' +
'            position: relative;' +
'            overflow: hidden;' +
'        }' +
'        ' +
'        .login-card::before {' +
'            content: \'\';' +
'            position: absolute;' +
'            top: 0;' +
'            left: 0;' +
'            right: 0;' +
'            height: 4px;' +
'            background: linear-gradient(90deg, var(--secondary), var(--primary));' +
'        }' +
'        ' +
'        .logo {' +
'            text-align: center;' +
'            margin-bottom: 30px;' +
'        }' +
'        ' +
'        .logo-icon {' +
'            font-size: 48px;' +
'            margin-bottom: 10px;' +
'            color: var(--secondary);' +
'        }' +
'        ' +
'        .logo h1 {' +
'            font-size: 28px;' +
'            font-weight: 700;' +
'            background: linear-gradient(135deg, var(--secondary), var(--primary));' +
'            -webkit-background-clip: text;' +
'            -webkit-text-fill-color: transparent;' +
'            margin-bottom: 5px;' +
'        }' +
'        ' +
'        .logo p {' +
'            color: var(--gray);' +
'            font-size: 14px;' +
'        }' +
'        ' +
'        .alert {' +
'            padding: 15px;' +
'            border-radius: 10px;' +
'            margin-bottom: 25px;' +
'            display: ' + (sessionExpired ? 'flex' : 'none') + ';' +
'            align-items: center;' +
'            gap: 10px;' +
'            background: rgba(239, 68, 68, 0.15);' +
'            border: 1px solid rgba(239, 68, 68, 0.3);' +
'            color: #fca5a5;' +
'        }' +
'        ' +
'        .form-group {' +
'            margin-bottom: 25px;' +
'        }' +
'        ' +
'        .form-label {' +
'            display: block;' +
'            margin-bottom: 8px;' +
'            color: var(--light);' +
'            font-weight: 500;' +
'            font-size: 14px;' +
'        }' +
'        ' +
'        .input-group {' +
'            position: relative;' +
'        }' +
'        ' +
'        .input-group input {' +
'            width: 100%;' +
'            padding: 16px 20px 16px 50px;' +
'            border-radius: 12px;' +
'            border: 1px solid var(--border);' +
'            background: rgba(255, 255, 255, 0.07);' +
'            color: var(--light);' +
'            font-size: 16px;' +
'            transition: all 0.3s;' +
'        }' +
'        ' +
'        .input-group input:focus {' +
'            outline: none;' +
'            border-color: var(--primary);' +
'            background: rgba(255, 255, 255, 0.1);' +
'            box-shadow: 0 0 0 3px rgba(0, 102, 255, 0.1);' +
'        }' +
'        ' +
'        .input-group i {' +
'            position: absolute;' +
'            left: 20px;' +
'            top: 50%;' +
'            transform: translateY(-50%);' +
'            color: var(--gray);' +
'            font-size: 18px;' +
'        }' +
'        ' +
'        .btn-login {' +
'            width: 100%;' +
'            padding: 18px;' +
'            border-radius: 12px;' +
'            border: none;' +
'            background: linear-gradient(135deg, var(--primary), var(--primary-dark));' +
'            color: white;' +
'            font-size: 16px;' +
'            font-weight: 600;' +
'            cursor: pointer;' +
'            transition: all 0.3s;' +
'            display: flex;' +
'            align-items: center;' +
'            justify-content: center;' +
'            gap: 10px;' +
'        }' +
'        ' +
'        .btn-login:hover {' +
'            transform: translateY(-2px);' +
'            box-shadow: 0 10px 20px rgba(0, 102, 255, 0.3);' +
'        }' +
'        ' +
'        .btn-login:active {' +
'            transform: translateY(0);' +
'        }' +
'        ' +
'        .security-note {' +
'            margin-top: 25px;' +
'            padding-top: 25px;' +
'            border-top: 1px solid var(--border);' +
'            text-align: center;' +
'            color: var(--gray);' +
'            font-size: 13px;' +
'        }' +
'        ' +
'        @media (max-width: 480px) {' +
'            .login-card {' +
'                padding: 30px 25px;' +
'            }' +
'        }' +
'    </style>' +
'</head>' +
'<body>' +
'    <div class="login-container">' +
'        <div class="login-card">' +
'            <div class="logo">' +
'                <div class="logo-icon">' +
'                    🔐' +
'                </div>' +
'                <h1>Dream Hatcher</h1>' +
'                <p>Enterprise Admin Portal</p>' +
'            </div>' +
'            ' +
'            <div class="alert">' +
'                ⚠️' +
'                <span>Session expired. Please login again.</span>' +
'            </div>' +
'            ' +
'            <form method="GET" action="/admin">' +
'                <div class="form-group">' +
'                    <label class="form-label">Administrator Password</label>' +
'                    <div class="input-group">' +
'                        🔑' +
'                        <input type="password" name="pwd" placeholder="Enter secure password" required autofocus>' +
'                    </div>' +
'                </div>' +
'                ' +
'                <button type="submit" class="btn-login">' +
'                    🔐 Access Dashboard' +
'                </button>' +
'            </form>' +
'            ' +
'            <div class="security-note">' +
'                🔒 Secure HTTPS Connection • Session Timeout: 3 min' +
'            </div>' +
'        </div>' +
'    </div>' +
'</body>' +
'</html>';
}

function getDashboardHTML(data) {
  const { sessionId, stats, realtime, recentActivity, chartLabels, chartData, actionMessage, messageType, perfData } = data;
  
  // Format currency
  const formatCurrency = (amount) => {
    const num = Number(amount) || 0;
    return '₦' + num.toLocaleString('en-NG');
  };
  
  // Calculate session end time (3 minutes from now)
  const sessionEnd = Date.now() + (3 * 60 * 1000);
  
  // Prepare plan distribution data
  const dailyCount = stats.plans_data?.find(p => p.plan === '24hr')?.count || 0;
  const weeklyCount = stats.plans_data?.find(p => p.plan === '7d')?.count || 0;
  const monthlyCount = stats.plans_data?.find(p => p.plan === '30d')?.count || 0;
  
  // Build HTML
  let html = '<!DOCTYPE html>' +
'<html lang="en">' +
'<head>' +
'    <meta charset="UTF-8">' +
'    <meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'    <title>Dashboard • Dream Hatcher Admin</title>' +
'    <style>' +
'        :root {' +
'            --primary: #0066ff;' +
'            --primary-dark: #0052d4;' +
'            --secondary: #00c9ff;' +
'            --success: #10b981;' +
'            --danger: #ef4444;' +
'            --warning: #f59e0b;' +
'            --info: #3b82f6;' +
'            --dark: #0a0e1a;' +
'            --darker: #050811;' +
'            --light: #f8fafc;' +
'            --gray: #64748b;' +
'            --border: rgba(255,255,255,0.1);' +
'            --card-bg: rgba(255, 255, 255, 0.05);' +
'        }' +
'        ' +
'        * {' +
'            margin: 0;' +
'            padding: 0;' +
'            box-sizing: border-box;' +
'            font-family: \'Segoe UI\', system-ui, -apple-system, sans-serif;' +
'        }' +
'        ' +
'        body {' +
'            background: var(--darker);' +
'            color: var(--light);' +
'            min-height: 100vh;' +
'            overflow-x: hidden;' +
'        }' +
'        ' +
'        /* ========== TOP NAVBAR ========== */' +
'        .navbar {' +
'            background: rgba(10, 14, 26, 0.95);' +
'            backdrop-filter: blur(10px);' +
'            border-bottom: 1px solid var(--border);' +
'            padding: 0 30px;' +
'            height: 70px;' +
'            display: flex;' +
'            align-items: center;' +
'            justify-content: space-between;' +
'            position: sticky;' +
'            top: 0;' +
'            z-index: 1000;' +
'        }' +
'        ' +
'        .brand {' +
'            display: flex;' +
'            align-items: center;' +
'            gap: 15px;' +
'        }' +
'        ' +
'        .brand-icon {' +
'            width: 40px;' +
'            height: 40px;' +
'            background: linear-gradient(135deg, var(--secondary), var(--primary));' +
'            border-radius: 10px;' +
'            display: flex;' +
'            align-items: center;' +
'            justify-content: center;' +
'            font-size: 20px;' +
'        }' +
'        ' +
'        .brand-text h1 {' +
'            font-size: 20px;' +
'            font-weight: 700;' +
'            background: linear-gradient(135deg, var(--secondary), var(--primary));' +
'            -webkit-background-clip: text;' +
'            -webkit-text-fill-color: transparent;' +
'        }' +
'        ' +
'        .brand-text p {' +
'            font-size: 12px;' +
'            color: var(--gray);' +
'        }' +
'        ' +
'        .nav-controls {' +
'            display: flex;' +
'            align-items: center;' +
'            gap: 20px;' +
'        }' +
'        ' +
'        .session-timer {' +
'            background: rgba(245, 158, 11, 0.15);' +
'            border: 1px solid rgba(245, 158, 11, 0.3);' +
'            border-radius: 10px;' +
'            padding: 10px 20px;' +
'            display: flex;' +
'            align-items: center;' +
'            gap: 10px;' +
'            font-weight: 600;' +
'            color: #fbbf24;' +
'        }' +
'        ' +
'        .session-timer.critical {' +
'            background: rgba(239, 68, 68, 0.15);' +
'            border-color: rgba(239, 68, 68, 0.3);' +
'            color: #fca5a5;' +
'            animation: pulse 2s infinite;' +
'        }' +
'        ' +
'        @keyframes pulse {' +
'            0%, 100% { opacity: 1; }' +
'            50% { opacity: 0.7; }' +
'        }' +
'        ' +
'        .btn {' +
'            padding: 10px 20px;' +
'            border-radius: 10px;' +
'            border: none;' +
'            font-weight: 600;' +
'            cursor: pointer;' +
'            transition: all 0.3s;' +
'            display: inline-flex;' +
'            align-items: center;' +
'            gap: 8px;' +
'            text-decoration: none;' +
'            font-size: 14px;' +
'        }' +
'        ' +
'        .btn-primary {' +
'            background: linear-gradient(135deg, var(--primary), var(--primary-dark));' +
'            color: white;' +
'        }' +
'        ' +
'        .btn-danger {' +
'            background: linear-gradient(135deg, var(--danger), #dc2626);' +
'            color: white;' +
'        }' +
'        ' +
'        .btn-success {' +
'            background: linear-gradient(135deg, var(--success), #059669);' +
'            color: white;' +
'        }' +
'        ' +
'        .btn-secondary {' +
'            background: var(--card-bg);' +
'            color: var(--light);' +
'            border: 1px solid var(--border);' +
'        }' +
'        ' +
'        .btn:hover {' +
'            transform: translateY(-2px);' +
'            box-shadow: 0 5px 15px rgba(0, 0, 0, 0.3);' +
'        }' +
'        ' +
'        /* ========== MAIN LAYOUT ========== */' +
'        .container {' +
'            padding: 30px;' +
'            max-width: 1600px;' +
'            margin: 0 auto;' +
'        }' +
'        ' +
'        /* ========== ALERT MESSAGES ========== */' +
'        .alert {' +
'            padding: 20px;' +
'            border-radius: 12px;' +
'            margin-bottom: 30px;' +
'            display: ' + (actionMessage ? 'flex' : 'none') + ';' +
'            align-items: center;' +
'            gap: 15px;' +
'            border-left: 4px solid;' +
'            animation: slideIn 0.3s ease-out;' +
'        }' +
'        ' +
'        @keyframes slideIn {' +
'            from { transform: translateY(-10px); opacity: 0; }' +
'            to { transform: translateY(0); opacity: 1; }' +
'        }' +
'        ' +
'        .alert-success {' +
'            background: rgba(16, 185, 129, 0.15);' +
'            border-left-color: var(--success);' +
'            color: #a7f3d0;' +
'        }' +
'        ' +
'        .alert-warning {' +
'            background: rgba(245, 158, 11, 0.15);' +
'            border-left-color: var(--warning);' +
'            color: #fde68a;' +
'        }' +
'        ' +
'        .alert-info {' +
'            background: rgba(59, 130, 246, 0.15);' +
'            border-left-color: var(--info);' +
'            color: #93c5fd;' +
'        }' +
'        ' +
'        /* ========== STATS GRID ========== */' +
'        .stats-grid {' +
'            display: grid;' +
'            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));' +
'            gap: 20px;' +
'            margin-bottom: 30px;' +
'        }' +
'        ' +
'        .stat-card {' +
'            background: var(--card-bg);' +
'            border: 1px solid var(--border);' +
'            border-radius: 16px;' +
'            padding: 25px;' +
'            transition: all 0.3s;' +
'            position: relative;' +
'            overflow: hidden;' +
'        }' +
'        ' +
'        .stat-card::before {' +
'            content: \'\';' +
'            position: absolute;' +
'            top: 0;' +
'            left: 0;' +
'            right: 0;' +
'            height: 4px;' +
'            background: linear-gradient(90deg, var(--secondary), var(--primary));' +
'        }' +
'        ' +
'        .stat-card:hover {' +
'            transform: translateY(-5px);' +
'            border-color: rgba(0, 201, 255, 0.3);' +
'            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);' +
'        }' +
'        ' +
'        .stat-header {' +
'            display: flex;' +
'            justify-content: space-between;' +
'            align-items: center;' +
'            margin-bottom: 20px;' +
'        }' +
'        ' +
'        .stat-icon {' +
'            width: 50px;' +
'            height: 50px;' +
'            border-radius: 12px;' +
'            display: flex;' +
'            align-items: center;' +
'            justify-content: center;' +
'            font-size: 24px;' +
'        }' +
'        ' +
'        .stat-icon.revenue { background: rgba(16, 185, 129, 0.2); color: var(--success); }' +
'        .stat-icon.users { background: rgba(59, 130, 246, 0.2); color: var(--info); }' +
'        .stat-icon.growth { background: rgba(168, 85, 247, 0.2); color: #a855f7; }' +
'        .stat-icon.active { background: rgba(34, 197, 94, 0.2); color: #22c55e; }' +
'        ' +
'        .stat-trend {' +
'            font-size: 14px;' +
'            padding: 5px 10px;' +
'            border-radius: 20px;' +
'            font-weight: 600;' +
'        }' +
'        ' +
'        .trend-up { background: rgba(16, 185, 129, 0.2); color: var(--success); }' +
'        .trend-down { background: rgba(239, 68, 68, 0.2); color: var(--danger); }' +
'        ' +
'        .stat-value {' +
'            font-size: 32px;' +
'            font-weight: 800;' +
'            margin-bottom: 5px;' +
'        }' +
'        ' +
'        .stat-label {' +
'            color: var(--gray);' +
'            font-size: 14px;' +
'            margin-top: 5px;' +
'        }' +
'        ' +
'        /* ========== DATA TABLE ========== */' +
'        .table-card {' +
'            background: var(--card-bg);' +
'            border: 1px solid var(--border);' +
'            border-radius: 16px;' +
'            padding: 25px;' +
'            margin-bottom: 30px;' +
'            overflow: hidden;' +
'        }' +
'        ' +
'        .table-header {' +
'            display: flex;' +
'            justify-content: space-between;' +
'            align-items: center;' +
'            margin-bottom: 20px;' +
'            flex-wrap: wrap;' +
'            gap: 15px;' +
'        }' +
'        ' +
'        .table-actions {' +
'            display: flex;' +
'            gap: 10px;' +
'            flex-wrap: wrap;' +
'        }' +
'        ' +
'        .search-box {' +
'            position: relative;' +
'            min-width: 250px;' +
'        }' +
'        ' +
'        .search-box input {' +
'            width: 100%;' +
'            padding: 12px 20px 12px 45px;' +
'            border-radius: 10px;' +
'            border: 1px solid var(--border);' +
'            background: rgba(255, 255, 255, 0.07);' +
'            color: var(--light);' +
'            font-size: 14px;' +
'        }' +
'        ' +
'        table {' +
'            width: 100%;' +
'            border-collapse: collapse;' +
'        }' +
'        ' +
'        thead {' +
'            background: rgba(255, 255, 255, 0.05);' +
'        }' +
'        ' +
'        th {' +
'            padding: 15px;' +
'            text-align: left;' +
'            color: var(--gray);' +
'            font-weight: 600;' +
'            font-size: 12px;' +
'            text-transform: uppercase;' +
'            letter-spacing: 0.5px;' +
'            border-bottom: 1px solid var(--border);' +
'        }' +
'        ' +
'        td {' +
'            padding: 15px;' +
'            border-bottom: 1px solid var(--border);' +
'            font-size: 14px;' +
'        }' +
'        ' +
'        tr:hover {' +
'            background: rgba(255, 255, 255, 0.03);' +
'        }' +
'        ' +
'        .badge {' +
'            padding: 6px 12px;' +
'            border-radius: 20px;' +
'            font-size: 12px;' +
'            font-weight: 600;' +
'            display: inline-flex;' +
'            align-items: center;' +
'            gap: 5px;' +
'        }' +
'        ' +
'        .badge-active { background: rgba(16, 185, 129, 0.2); color: var(--success); }' +
'        .badge-expired { background: rgba(239, 68, 68, 0.2); color: var(--danger); }' +
'        .badge-pending { background: rgba(245, 158, 11, 0.2); color: var(--warning); }' +
'        .badge-suspended { background: rgba(148, 163, 184, 0.2); color: var(--gray); }' +
'        ' +
'        .plan-badge {' +
'            padding: 6px 12px;' +
'            border-radius: 8px;' +
'            font-size: 12px;' +
'            font-weight: 600;' +
'        }' +
'        ' +
'        .plan-daily { background: rgba(59, 130, 246, 0.2); color: var(--info); }' +
'        .plan-weekly { background: rgba(139, 92, 246, 0.2); color: #8b5cf6; }' +
'        .plan-monthly { background: rgba(236, 72, 153, 0.2); color: #ec4899; }' +
'        ' +
'        .action-buttons {' +
'            display: flex;' +
'            gap: 8px;' +
'        }' +
'        ' +
'        .action-btn {' +
'            width: 36px;' +
'            height: 36px;' +
'            border-radius: 8px;' +
'            border: 1px solid var(--border);' +
'            background: rgba(255, 255, 255, 0.05);' +
'            color: var(--light);' +
'            cursor: pointer;' +
'            display: flex;' +
'            align-items: center;' +
'            justify-content: center;' +
'            transition: all 0.2s;' +
'        }' +
'        ' +
'        .action-btn:hover {' +
'            background: rgba(255, 255, 255, 0.1);' +
'            transform: translateY(-2px);' +
'        }' +
'        ' +
'        .action-btn.extend { color: var(--success); border-color: rgba(16, 185, 129, 0.3); }' +
'        .action-btn.reset { color: var(--warning); border-color: rgba(245, 158, 11, 0.3); }' +
'        .action-btn.delete { color: var(--danger); border-color: rgba(239, 68, 68, 0.3); }' +
'        .action-btn.toggle { color: var(--info); border-color: rgba(59, 130, 246, 0.3); }' +
'        ' +
'        /* ========== MODALS ========== */' +
'        .modal {' +
'            display: none;' +
'            position: fixed;' +
'            top: 0;' +
'            left: 0;' +
'            width: 100%;' +
'            height: 100%;' +
'            background: rgba(0, 0, 0, 0.8);' +
'            backdrop-filter: blur(5px);' +
'            z-index: 2000;' +
'            align-items: center;' +
'            justify-content: center;' +
'            padding: 20px;' +
'        }' +
'        ' +
'        .modal.active {' +
'            display: flex;' +
'            animation: fadeIn 0.3s;' +
'        }' +
'        ' +
'        @keyframes fadeIn {' +
'            from { opacity: 0; }' +
'            to { opacity: 1; }' +
'        }' +
'        ' +
'        .modal-content {' +
'            background: var(--dark);' +
'            border-radius: 20px;' +
'            padding: 30px;' +
'            width: 100%;' +
'            max-width: 500px;' +
'            border: 1px solid var(--border);' +
'            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);' +
'        }' +
'        ' +
'        .modal-header {' +
'            display: flex;' +
'            justify-content: space-between;' +
'            align-items: center;' +
'            margin-bottom: 20px;' +
'            padding-bottom: 20px;' +
'            border-bottom: 1px solid var(--border);' +
'        }' +
'        ' +
'        .modal-header h3 {' +
'            font-size: 20px;' +
'            color: var(--light);' +
'        }' +
'        ' +
'        .modal-close {' +
'            background: none;' +
'            border: none;' +
'            color: var(--gray);' +
'            font-size: 20px;' +
'            cursor: pointer;' +
'            width: 36px;' +
'            height: 36px;' +
'            border-radius: 8px;' +
'            display: flex;' +
'            align-items: center;' +
'            justify-content: center;' +
'        }' +
'        ' +
'        .modal-close:hover {' +
'            background: rgba(255, 255, 255, 0.05);' +
'        }' +
'        ' +
'        /* ========== FOOTER ========== */' +
'        .footer {' +
'            text-align: center;' +
'            padding: 30px;' +
'            color: var(--gray);' +
'            font-size: 14px;' +
'            border-top: 1px solid var(--border);' +
'            margin-top: 30px;' +
'        }' +
'        ' +
'        .footer-links {' +
'            display: flex;' +
'            justify-content: center;' +
'            gap: 30px;' +
'            margin-top: 15px;' +
'        }' +
'        ' +
'        /* ========== RESPONSIVE ========== */' +
'        @media (max-width: 768px) {' +
'            .container {' +
'                padding: 20px;' +
'            }' +
'            ' +
'            .navbar {' +
'                padding: 0 20px;' +
'                height: 60px;' +
'            }' +
'            ' +
'            .nav-controls {' +
'                gap: 10px;' +
'            }' +
'            ' +
'            .session-timer {' +
'                padding: 8px 12px;' +
'                font-size: 14px;' +
'            }' +
'            ' +
'            .btn {' +
'                padding: 8px 15px;' +
'                font-size: 13px;' +
'            }' +
'            ' +
'            .stats-grid {' +
'                grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));' +
'            }' +
'            ' +
'            th, td {' +
'                padding: 10px;' +
'                font-size: 12px;' +
'            }' +
'            ' +
'            .table-header {' +
'                flex-direction: column;' +
'                align-items: flex-start;' +
'            }' +
'            ' +
'            .search-box {' +
'                min-width: 100%;' +
'            }' +
'        }' +
'    </style>' +
'</head>' +
'<body>' +
'    <!-- Session Timeout Modal -->' +
'    <div class="modal" id="timeoutModal">' +
'        <div class="modal-content">' +
'            <div class="modal-header">' +
'                <h3>⚠️ Session Expired</h3>' +
'                <button class="modal-close" onclick="logout()">&times;</button>' +
'            </div>' +
'            <div style="padding: 20px 0;">' +
'                <p style="margin-bottom: 20px; color: var(--gray);">' +
'                    Your session has expired due to 3 minutes of inactivity.' +
'                    For security reasons, you have been automatically logged out.' +
'                </p>' +
'                <div style="display: flex; gap: 10px;">' +
'                    <button class="btn btn-secondary" onclick="logout()" style="flex: 1;">' +
'                        Close' +
'                    </button>' +
'                    <a href="/admin" class="btn btn-primary" style="flex: 1; text-align: center;">' +
'                        🔐 Login Again' +
'                    </a>' +
'                </div>' +
'            </div>' +
'        </div>' +
'    </div>' +

'    <!-- Extend Plan Modal -->' +
'    <div class="modal" id="extendModal">' +
'        <div class="modal-content">' +
'            <div class="modal-header">' +
'                <h3>⏰ Extend User Plan</h3>' +
'                <button class="modal-close" onclick="closeModal(\'extendModal\')">&times;</button>' +
'            </div>' +
'            <form id="extendForm" method="GET" action="/admin">' +
'                <input type="hidden" name="sessionId" value="' + sessionId + '">' +
'                <input type="hidden" name="action" value="extend">' +
'                <input type="hidden" name="userId" id="extendUserId">' +
'                ' +
'                <div style="padding: 20px 0;">' +
'                    <p style="margin-bottom: 15px; color: var(--gray);">' +
'                        Extend plan for: <strong id="extendUsername" style="color: var(--light);"></strong>' +
'                    </p>' +
'                    ' +
'                    <div style="margin-bottom: 20px;">' +
'                        <label style="display: block; margin-bottom: 8px; color: var(--light); font-weight: 500;">Select Plan</label>' +
'                        <div style="display: grid; gap: 10px;">' +
'                            <label class="plan-option" style="display: flex; align-items: center; padding: 15px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer;">' +
'                                <input type="radio" name="newPlan" value="24hr" style="margin-right: 10px;" required>' +
'                                <div>' +
'                                    <div style="font-weight: 600; color: var(--light);">Daily Plan</div>' +
'                                    <div style="font-size: 14px; color: var(--gray);">24 hours • ₦350</div>' +
'                                </div>' +
'                            </label>' +
'                            ' +
'                            <label class="plan-option" style="display: flex; align-items: center; padding: 15px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer;">' +
'                                <input type="radio" name="newPlan" value="7d" style="margin-right: 10px;">' +
'                                <div>' +
'                                    <div style="font-weight: 600; color: var(--light);">Weekly Plan</div>' +
'                                    <div style="font-size: 14px; color: var(--gray);">7 days • ₦2,400</div>' +
'                                </div>' +
'                            </label>' +
'                            ' +
'                            <label class="plan-option" style="display: flex; align-items: center; padding: 15px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer;">' +
'                                <input type="radio" name="newPlan" value="30d" style="margin-right: 10px;">' +
'                                <div>' +
'                                    <div style="font-weight: 600; color: var(--light);">Monthly Plan</div>' +
'                                    <div style="font-size: 14px; color: var(--gray);">30 days • ₦7,500</div>' +
'                                </div>' +
'                            </label>' +
'                        </div>' +
'                    </div>' +
'                    ' +
'                    <div style="display: flex; gap: 10px;">' +
'                        <button type="button" class="btn btn-secondary" onclick="closeModal(\'extendModal\')" style="flex: 1;">' +
'                            Cancel' +
'                        </button>' +
'                        <button type="submit" class="btn btn-success" style="flex: 1;">' +
'                            ✅ Confirm Extension' +
'                        </button>' +
'                    </div>' +
'                </div>' +
'            </form>' +
'        </div>' +
'    </div>' +

'    <!-- Top Navigation -->' +
'    <nav class="navbar">' +
'        <div class="brand">' +
'            <div class="brand-icon">' +
'                🌐' +
'            </div>' +
'            <div class="brand-text">' +
'                <h1>Dream Hatcher Admin</h1>' +
'                <p>Enterprise WiFi Management</p>' +
'            </div>' +
'        </div>' +
'        ' +
'        <div class="nav-controls">' +
'            <div class="session-timer" id="sessionTimer">' +
'                ⏱️' +
'                <span id="timerText">03:00</span>' +
'            </div>' +
'            <button class="btn btn-primary" onclick="window.location.reload()">' +
'                🔄 Refresh' +
'            </button>' +
'            <button class="btn btn-danger" onclick="logout()">' +
'                🚪 Logout' +
'            </button>' +
'        </div>' +
'    </nav>' +

'    <!-- Main Content -->' +
'    <div class="container">' +
        (actionMessage ? 
        '<div class="alert alert-' + (messageType || 'success') + '">' +
        '    ✅' +
        '    <span>' + actionMessage + '</span>' +
        '</div>' : '') +

'        <!-- Revenue Statistics -->' +
'        <div class="stats-grid">' +
'            <div class="stat-card">' +
'                <div class="stat-header">' +
'                    <div class="stat-icon revenue">' +
'                      📅' +
'                    </div>' +
'                    <div class="stat-trend trend-up">' +
'                        TODAY' +
'                    </div>' +
'                </div>' +
'                <div class="stat-value">' + formatCurrency(stats.revenue_today) + '</div>' +
'                <div class="stat-label">Today\'s Revenue</div>' +
'                <div style="margin-top: 15px; font-size: 13px; color: var(--gray);">' +
'                    👥 ' + stats.signups_today + ' signups today' +
'                </div>' +
'            </div>' +
'            ' + 
'            <div class="stat-card">' +
'                <div class="stat-header">' +
'                    <div class="stat-icon revenue">' +
'                         💰' +
'                    </div>' +
'                    <div class="stat-trend trend-up">' +
'                        ALL-TIME' +
'                    </div>' +
'                </div>' +
'                <div class="stat-value">' + formatCurrency(stats.total_revenue_lifetime) + '</div>' +
'                <div class="stat-label">Total Lifetime Revenue (Never Expires)</div>' +
'                <div style="margin-top: 15px; font-size: 13px; color: var(--success);">' +
'                    ℹ️ Includes all historical payments' +
'                </div>' +
'            </div>' +
'            ' +
'            <div class="stat-card">' +
'                <div class="stat-header">' +
'                    <div class="stat-icon users">' +
'                        👥' +
'                    </div>' +
'                    <div class="stat-trend ' + (stats.daily_growth_rate > 0 ? 'trend-up' : 'trend-down') + '">' +
'                        ' + (stats.daily_growth_rate > 0 ? '↗' : '↘') + ' ' + 
                        (stats.daily_growth_rate ? Math.abs(stats.daily_growth_rate).toFixed(1) : '0') + '%' +
'                    </div>' +
'                </div>' +
'                <div class="stat-value">' + stats.total_users + '</div>' +
'                <div class="stat-label">Total Registered Users</div>' +
'                <div style="margin-top: 15px; font-size: 13px; color: var(--gray);">' +
'                    📈 MRR Projection: ' + formatCurrency(stats.mrr_projection) + '/day' +
'                </div>' +
'            </div>' +
'            ' +
'            <div class="stat-card">' +
'                <div class="stat-header">' +
'                    <div class="stat-icon active">' +
'                        ⚡' +
'                    </div>' +
'                    <div class="stat-trend trend-up">' +
'                        LIVE' +
'                    </div>' +
'                </div>' +
'                <div class="stat-value">' + realtime.currently_active + '</div>' +
'                <div class="stat-label">Currently Active Users</div>' +
'                <div style="margin-top: 15px; display: flex; gap: 15px; font-size: 13px;">' +
'                    <span style="color: var(--danger);">' +
'                        ❌ ' + realtime.currently_expired + ' expired' +
'                    </span>' +
'                    <span style="color: var(--warning);">' +
'                        ⏳ ' + realtime.currently_pending + ' pending' +
'                    </span>' +
'                </div>' +
'            </div>' +
'        </div>' +

'        <!-- Plan Distribution -->' +
'        <div class="table-card">' +
'            <div class="table-header">' +
'                <div>' +
'                    <h2 style="color: var(--light); font-size: 20px; margin-bottom: 5px;">' +
'                        📊 Plan Distribution' +
'                    </h2>' +
'                    <p style="color: var(--gray); font-size: 14px;">' +
'                        ' + dailyCount + ' Daily • ' + weeklyCount + ' Weekly • ' + monthlyCount + ' Monthly' +
'                    </p>' +
'                </div>' +
'            </div>' +
'            <div style="display: flex; gap: 20px; flex-wrap: wrap;">' +
'                <div style="flex: 1; min-width: 300px;">' +
'                    <div style="background: rgba(59, 130, 246, 0.1); padding: 20px; border-radius: 12px; margin-bottom: 10px;">' +
'                        <div style="display: flex; justify-content: space-between; align-items: center;">' +
'                            <span style="color: var(--info); font-weight: 600;">⚡ Daily Plan</span>' +
'                            <span style="color: var(--light); font-weight: 700;">' + dailyCount + ' users</span>' +
'                        </div>' +
'                        <div style="margin-top: 10px; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden;">' +
'                            <div style="height: 100%; width: ' + (stats.total_users > 0 ? (dailyCount / stats.total_users * 100) : 0) + '%; background: var(--info);"></div>' +
'                        </div>' +
'                    </div>' +
'                    <div style="background: rgba(139, 92, 246, 0.1); padding: 20px; border-radius: 12px; margin-bottom: 10px;">' +
'                        <div style="display: flex; justify-content: space-between; align-items: center;">' +
'                            <span style="color: #8b5cf6; font-weight: 600;">🚀 Weekly Plan</span>' +
'                            <span style="color: var(--light); font-weight: 700;">' + weeklyCount + ' users</span>' +
'                        </div>' +
'                        <div style="margin-top: 10px; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden;">' +
'                            <div style="height: 100%; width: ' + (stats.total_users > 0 ? (weeklyCount / stats.total_users * 100) : 0) + '%; background: #8b5cf6;"></div>' +
'                        </div>' +
'                    </div>' +
'                    <div style="background: rgba(236, 72, 153, 0.1); padding: 20px; border-radius: 12px;">' +
'                        <div style="display: flex; justify-content: space-between; align-items: center;">' +
'                            <span style="color: #ec4899; font-weight: 600;">👑 Monthly Plan</span>' +
'                            <span style="color: var(--light); font-weight: 700;">' + monthlyCount + ' users</span>' +
'                        </div>' +
'                        <div style="margin-top: 10px; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden;">' +
'                            <div style="height: 100%; width: ' + (stats.total_users > 0 ? (monthlyCount / stats.total_users * 100) : 0) + '%; background: #ec4899;"></div>' +
'                        </div>' +
'                    </div>' +
'                </div>' +
'                <div style="flex: 1; min-width: 300px; padding: 20px; background: rgba(255,255,255,0.03); border-radius: 12px;">' +
'                    <h3 style="color: var(--light); margin-bottom: 15px;">💰 Revenue Summary</h3>' +
'                    <div style="display: grid; gap: 10px;">' +
'                        <div style="display: flex; justify-content: space-between;">' +
'                            <span style="color: var(--gray);">Today:</span>' +
'                            <span style="color: var(--light); font-weight: 600;">' + formatCurrency(stats.revenue_today) + '</span>' +
'                        </div>' +
'                        <div style="display: flex; justify-content: space-between;">' +
'                            <span style="color: var(--gray);">This Week:</span>' +
'                            <span style="color: var(--light); font-weight: 600;">' + formatCurrency(stats.revenue_week) + '</span>' +
'                        </div>' +
'                        <div style="display: flex; justify-content: space-between;">' +
'                            <span style="color: var(--gray);">This Month:</span>' +
'                            <span style="color: var(--light); font-weight: 600;">' + formatCurrency(stats.revenue_month) + '</span>' +
'                        </div>' +
'                        <div style="border-top: 1px solid var(--border); padding-top: 10px; margin-top: 5px;">' +
'                            <div style="display: flex; justify-content: space-between;">' +
'                                <span style="color: var(--success); font-weight: 600;">Total Lifetime:</span>' +
'                                <span style="color: var(--success); font-weight: 700;">' + formatCurrency(stats.total_revenue_lifetime) + '</span>' +
'                            </div>' +
'                        </div>' +
'                    </div>' +
'                </div>' +
'            </div>' +
'        </div>' +

'        <!-- User Management -->' +
'        <div class="table-card">' +
'            <div class="table-header">' +
'                <div>' +
'                    <h2 style="color: var(--light); font-size: 20px; margin-bottom: 5px;">' +
'                        👥 User Management' +
'                    </h2>' +
'                    <p style="color: var(--gray); font-size: 14px;">' +
'                        ' + recentActivity.length + ' users • Active: ' + realtime.currently_active + ' • Pending: ' + realtime.currently_pending +
'                    </p>' +
'                </div>' +
'                ' +
'                <div class="table-actions">' +
'                    <div class="search-box">' +
'                        🔍' +
'                        <input type="text" id="searchInput" placeholder="Search users, MAC, email..." onkeyup="searchTable()">' +
'                    </div>' +
'                    <a href="/admin?sessionId=' + sessionId + '&exportData=csv" class="btn btn-primary">' +
'                        📥 Export CSV' +
'                    </a>' +
'                    <button class="btn btn-secondary" onclick="showAllUsers()">' +
'                        👁️ Show All' +
'                    </button>' +
'                </div>' +
'            </div>' +
'            ' +
'            <div style="overflow-x: auto;">' +
'                <table id="usersTable">' +
'                    <thead>' +
'                        <tr>' +
'                            <th>Username</th>' +
'                            <th>Password</th>' +
'                            <th>Plan</th>' +
'                            <th>Status</th>' +
'                            <th>Expires</th>' +
'                            <th>MAC Address</th>' +
'                            <th>Created</th>' +
'                            <th>Actions</th>' +
'                        </tr>' +
'                    </thead>' +
'                    <tbody>' +
                        recentActivity.map(user => {
                          const createdDate = new Date(user.created_at);
                          const expiresDate = user.expires_at ? new Date(user.expires_at) : null;
                          
                          return '<tr data-search="' + 
                            (user.mikrotik_username || '') + ' ' + 
                            (user.mac_address || '') + ' ' + 
                            (user.customer_email || '') + '">' +
'                            <td>' +
'                                <strong>' + (user.mikrotik_username || 'N/A') + '</strong>' +
                                (user.customer_email ? '<br><small style="color: var(--gray);">' + user.customer_email + '</small>' : '') +
'                            </td>' +
'                            <td>' +
'                                <span class="password" onclick="copyToClipboard(\'' + (user.mikrotik_password || '') + '\')" ' +
'                                      style="font-family: monospace; cursor: pointer; color: var(--warning);">' +
                                    (user.mikrotik_password || 'N/A') +
'                                </span>' +
'                            </td>' +
'                            <td>' +
'                                <span class="plan-badge plan-' + 
                                  (user.plan === '24hr' ? 'daily' : user.plan === '7d' ? 'weekly' : 'monthly') + '">' +
                                    (user.plan_name || 'N/A') +
'                                </span>' +
'                            </td>' +
'                            <td>' +
'                                <span class="badge badge-' + user.realtime_status + '">' +
                                    (user.realtime_status === 'active' ? '✅' : 
                                     user.realtime_status === 'expired' ? '❌' : 
                                     user.realtime_status === 'pending' ? '⏳' : '⏸️') +
                                    ' ' + user.realtime_status.charAt(0).toUpperCase() + user.realtime_status.slice(1) +
'                                </span>' +
'                            </td>' +
'                            <td>' +
                                (expiresDate ? 
                                    '<span style="color: ' + (expiresDate > new Date() ? 'var(--success)' : 'var(--danger)') + ';">' +
                                        expiresDate.toLocaleDateString('en-NG') + '<br>' +
                                        '<small>' + expiresDate.toLocaleTimeString('en-NG', {hour: '2-digit', minute:'2-digit'}) + '</small>' +
                                    '</span>' : 
                                    '<span style="color: var(--gray);">N/A</span>'
                                ) +
'                            </td>' +
'                            <td>' +
                                (user.mac_address ? 
                                    '<span style="font-family: monospace; color: var(--light);">' + user.mac_address + '</span>' : 
                                    '<span style="color: var(--gray);">N/A</span>'
                                ) +
'                            </td>' +
'                            <td>' +
                                createdDate.toLocaleDateString('en-NG') + '<br>' +
                                '<small style="color: var(--gray);">' +
                                    createdDate.toLocaleTimeString('en-NG', {hour: '2-digit', minute:'2-digit'}) +
                                '</small>' +
'                            </td>' +
'                            <td>' +
'                                <div class="action-buttons">' +
'                                    <button class="action-btn extend" ' +
'                                            onclick="openExtendModal(\'' + user.id + '\', \'' + (user.mikrotik_username || '') + '\')"' +
'                                            title="Extend Plan">' +
'                                        ⏰' +
'                                    </button>' +
'                                    <a href="/admin?sessionId=' + sessionId + '&action=toggle_status&userId=' + user.id + '" ' +
'                                       class="action-btn toggle"' +
'                                       onclick="return confirm(\'Toggle user status?\')"' +
'                                       title="Toggle Status">' +
'                                        ⚡' +
'                                    </a>' +
'                                    <a href="/admin?sessionId=' + sessionId + '&action=reset&userId=' + user.id + '" ' +
'                                       class="action-btn reset"' +
'                                       onclick="return confirm(\'Reset user to pending?\')"' +
'                                       title="Reset User">' +
'                                        🔄' +
'                                    </a>' +
'                                    <a href="/admin?sessionId=' + sessionId + '&action=delete&userId=' + user.id + '" ' +
'                                       class="action-btn delete"' +
'                                       onclick="return confirm(\'Permanently delete this user?\')"' +
'                                       title="Delete User">' +
'                                        🗑️' +
'                                    </a>' +
'                                </div>' +
'                            </td>' +
'                        </tr>';
                        }).join('') +
'                    </tbody>' +
'                </table>' +
'            </div>' +
'        </div>' +

'        <!-- Footer -->' +
'        <div class="footer">' +
'            <p>Dream Hatcher Enterprise Admin Dashboard v3.0</p>' +
'            <p>Secure Connection • Last Updated: ' + new Date().toLocaleString('en-NG', { 
                weekday: 'long', 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            }) + '</p>' +
'            <div class="footer-links">' +
'                <span>💾 ' + stats.total_users + ' Total Users</span>' +
'                <span>💰 ' + formatCurrency(stats.total_revenue_lifetime) + ' Revenue</span>' +
'                <span>🔒 Enterprise Secure</span>' +
'            </div>' +
'        </div>' +
'    </div>' +

'    <script>' +
'        // ========== SESSION MANAGEMENT ==========' +
'        let sessionEndTime = ' + sessionEnd + ';' +
'        let activityDetected = false;' +
'' +
'        function updateSessionTimer() {' +
'            const now = Date.now();' +
'            const timeLeft = Math.max(0, sessionEndTime - now);' +
'            const minutes = Math.floor(timeLeft / (1000 * 60));' +
'            const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);' +
'            ' +
'            const timerElement = document.getElementById(\'sessionTimer\');' +
'            const timerText = document.getElementById(\'timerText\');' +
'            ' +
'            if (timeLeft <= 0) {' +
'                document.getElementById(\'timeoutModal\').classList.add(\'active\');' +
'                return;' +
'            }' +
'            ' +
'            // Format time' +
'            const timeStr = (minutes < 10 ? "0" : "") + minutes + ":" + (seconds < 10 ? "0" : "") + seconds;' +
'            timerText.textContent = timeStr;' +
'            ' +
'            // Add warning class when less than 1 minute' +
'            if (timeLeft < 60000) {' +
'                timerElement.classList.add(\'critical\');' +
'            } else {' +
'                timerElement.classList.remove(\'critical\');' +
'            }' +
'            ' +
'            setTimeout(updateSessionTimer, 1000);' +
'        }' +
'' +
'        function resetSessionTimer() {' +
'            activityDetected = true;' +
'            sessionEndTime = Date.now() + (3 * 60 * 1000);' +
'        }' +
'' +
'        function logout() {' +
'            window.location.href = "/admin";' +
'        }' +
'' +
'        // ========== ACTIVITY DETECTION ==========' +
'        [\'mousemove\', \'keydown\', \'click\', \'scroll\', \'touchstart\'].forEach(event => {' +
'            document.addEventListener(event, resetSessionTimer, { passive: true });' +
'        });' +
'' +
'        // ========== TABLE SEARCH ==========' +
'        function searchTable() {' +
'            const input = document.getElementById(\'searchInput\');' +
'            const filter = input.value.toLowerCase();' +
'            const rows = document.querySelectorAll(\'#usersTable tbody tr\');' +
'            ' +
'            rows.forEach(row => {' +
'                const searchData = row.getAttribute(\'data-search\').toLowerCase();' +
'                row.style.display = searchData.includes(filter) ? \'\' : \'none\';' +
'            });' +
'        }' +
'' +
'        // ========== MODAL CONTROLS ==========' +
'        function openExtendModal(userId, username) {' +
'            document.getElementById(\'extendUserId\').value = userId;' +
'            document.getElementById(\'extendUsername\').textContent = username;' +
'            document.getElementById(\'extendModal\').classList.add(\'active\');' +
'        }' +
'' +
'        function closeModal(modalId) {' +
'            document.getElementById(modalId).classList.remove(\'active\');' +
'        }' +
'' +
'        // Close modals on outside click' +
'        document.querySelectorAll(\'.modal\').forEach(modal => {' +
'            modal.addEventListener(\'click\', function(e) {' +
'                if (e.target === this) {' +
'                    this.classList.remove(\'active\');' +
'                }' +
'            });' +
'        });' +
'' +
'        // ========== UTILITY FUNCTIONS ==========' +
'        function copyToClipboard(text) {' +
'            navigator.clipboard.writeText(text).then(() => {' +
'                alert(\'Copied to clipboard: \' + text);' +
'            });' +
'        }' +
'' +
'        function showAllUsers() {' +
'            document.getElementById(\'searchInput\').value = \'\';' +
'            searchTable();' +
'        }' +
'' +
'        // Initialize session timer' +
'        updateSessionTimer();' +
'        ' +
'        // Auto-refresh every 60 seconds' +
'        setInterval(() => {' +
'            if (activityDetected) {' +
'                window.location.reload();' +
'            }' +
'        }, 60000);' +
'    </script>' +
'</body>' +
'</html>';
  
  return html;
}

function getErrorPage(error) {
  return '<!DOCTYPE html>' +
'<html>' +
'<head>' +
'    <style>' +
'        body {' +
'            background: #0a0e1a;' +
'            color: white;' +
'            font-family: \'Segoe UI\', sans-serif;' +
'            display: flex;' +
'            align-items: center;' +
'            justify-content: center;' +
'            min-height: 100vh;' +
'            padding: 20px;' +
'        }' +
'        .error-box {' +
'            background: rgba(239, 68, 68, 0.1);' +
'            border: 1px solid rgba(239, 68, 68, 0.3);' +
'            border-radius: 16px;' +
'            padding: 40px;' +
'            text-align: center;' +
'            max-width: 500px;' +
'        }' +
'        .error-icon {' +
'            font-size: 48px;' +
'            color: #ef4444;' +
'            margin-bottom: 20px;' +
'        }' +
'        h2 {' +
'            color: #fca5a5;' +
'            margin-bottom: 10px;' +
'        }' +
'        pre {' +
'            background: rgba(0,0,0,0.3);' +
'            padding: 15px;' +
'            border-radius: 8px;' +
'            text-align: left;' +
'            overflow-x: auto;' +
'            color: #94a3b8;' +
'            font-size: 14px;' +
'        }' +
'        .btn {' +
'            display: inline-block;' +
'            margin-top: 20px;' +
'            padding: 12px 30px;' +
'            background: linear-gradient(135deg, #0066ff, #0052d4);' +
'            color: white;' +
'            border-radius: 10px;' +
'            text-decoration: none;' +
'            font-weight: 600;' +
'        }' +
'    </style>' +
'</head>' +
'<body>' +
'    <div class="error-box">' +
'        <div class="error-icon">⚠️</div>' +
'        <h2>Dashboard Error</h2>' +
'        <p>An unexpected error occurred while loading the dashboard.</p>' +
'        <pre>' + error + '</pre>' +
'        <a href="/admin" class="btn">Return to Login</a>' +
'    </div>' +
'</body>' +
'</html>';
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


