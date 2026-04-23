require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const https = require('https');
const axios = require('axios');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-auth-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

process.env.TZ = 'Africa/Lagos';
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.query('SELECT NOW()', (err, res) => {
  if (err) console.error('❌ Database connection failed:', err);
  else console.log('✅ Connected to Supabase');
});

process.on('uncaughtException', (error) => { console.error('💥 UNCAUGHT EXCEPTION:', error); });
process.on('unhandledRejection', (reason, promise) => { console.error('💥 UNHANDLED REJECTION:', reason); });

function generatePassword(length = 8) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

function getPlanDuration(planCode) {
  switch(planCode) {
    case '24hr': return '24 hours';
    case '3d': return '3 days';
    case '5d': return '5 days';
    case '7d': return '7 days';
    case '14d': return '14 days';
    case '30d': return '30 days';
    default: return planCode;
  }
}

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

function keepAlive() {
  https.get('https://dreamhatcher-backend.onrender.com/health', () => {}).on('error', () => {});
}
setInterval(keepAlive, 14 * 60 * 1000);

app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    console.log(`⏰ Timeout on ${req.method} ${req.url}`);
  });
  next();
});

const generatePaymentReference = (length = 10) => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

const initializeMonnifyPayment = async ({ email, amount, plan, mac_address, description }) => {
  const accessToken = await getMonnifyToken();
  const paymentReference = generatePaymentReference(10);

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

const planConfig = {
  daily:   { amount: 350, code: '24hr', duration: '24 Hours' },
  '3day':  { amount: 1050, code: '3d', duration: '3 Days' },
  '5day':  { amount: 1750, code: '5d', duration: '5 Days' },
  weekly:  { amount: 2400, code: '7d', duration: '7 Days' },
  '2week': { amount: 4100, code: '14d', duration: '14 Days' },
  monthly: { amount: 7500, code: '30d', duration: '30 Days' }
};

// ========== PAYMENT REDIRECT ==========
app.get('/pay/:plan', async (req, res) => {
  const { plan } = req.params;
  const mac = req.query.mac || 'unknown';
  const email = req.query.email;

  const selectedPlan = planConfig[plan];
  if (!selectedPlan) return res.status(400).send('Invalid plan selected');

  if (!email) {
    return res.status(400).send('Email address is required to complete purchase.');
  }

  try {
    const { checkoutUrl, paymentReference } = await initializeMonnifyPayment({
      email: email,
      amount: selectedPlan.amount,
      plan: selectedPlan.code,
      mac_address: mac,
      description: `Dream Hatcher WiFi - ${selectedPlan.duration}`
    });

    console.log(`💵 Payment: ${plan} | MAC: ${mac} | Email: ${email} | Ref: ${paymentReference}`);
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

// ========== INITIALIZE PAYMENT API ==========
app.post('/api/initialize-payment', async (req, res) => {
  try {
    const { email, amount, plan, mac_address } = req.body;
    if (!amount || !plan) return res.status(400).json({ error: 'Missing amount or plan' });
    const { checkoutUrl, paymentReference } = await initializeMonnifyPayment({ email, amount, plan, mac_address });
    console.log(`💳 API Payment: ${plan} | Amount: ₦${amount} | Ref: ${paymentReference}`);
    res.json({ success: true, checkout_url: checkoutUrl, payment_reference: paymentReference });
  } catch (error) {
    console.error('❌ Monnify initialize error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to initialize payment' });
  }
});

// ========== MONNIFY WEBHOOK (MODIFIED: adds one_time_token) ==========
app.post('/api/monnify-webhook', async (req, res) => {
  console.log('📥 Monnify webhook received');

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
    if (eventType !== 'SUCCESSFUL_TRANSACTION') {
      console.log(`📝 Received event type: ${eventType} - ignoring`);
      return res.status(200).json({ received: true });
    }

    const { paymentReference, amountPaid, metaData, customer } = eventData;
    const amountNaira = amountPaid;
    const macAddress = metaData?.mac_address || 'unknown';
    const planFromMetadata = metaData?.plan;

    let plan = planFromMetadata;
    if (!plan) {
      if (amountNaira === 350) plan = '24hr';
      else if (amountNaira === 1050) plan = '3d';
      else if (amountNaira === 1750) plan = '5d';
      else if (amountNaira === 2400) plan = '7d';
      else if (amountNaira === 4100) plan = '14d';
      else if (amountNaira === 7500) plan = '30d';
      else {
        console.error('❌ Invalid amount:', amountNaira);
        return res.status(400).json({ error: 'Invalid amount' });
      }
    }

    const username = `user_${Date.now().toString().slice(-6)}`;
    const password = generatePassword();
    const oneTimeToken = crypto.randomBytes(32).toString('hex');

    let expiresAt;
    const now = new Date();
    if (plan === '24hr') expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    else if (plan === '3d') expiresAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    else if (plan === '5d') expiresAt = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
    else if (plan === '7d') expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    else if (plan === '14d') expiresAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    else if (plan === '30d') expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO payment_queue
       (transaction_id, customer_email, customer_phone, plan,
        mikrotik_username, mikrotik_password, mac_address, status, expires_at, one_time_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9)`,
      [
        paymentReference,
        customer?.email || 'unknown@example.com',
        customer?.phoneNumber || '',
        plan,
        username,
        password,
        macAddress,
        expiresAt,
        oneTimeToken
      ]
    );

    console.log(`🙋 Queued user ${username} | Plan: ${plan} | Expires: ${expiresAt.toISOString()} | Token: ${oneTimeToken.substring(0,8)}...`);
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('❌ Monnify webhook error:', error.message);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ========== GET TOKEN BY REFERENCE ==========
app.get('/api/get-token', async (req, res) => {
  const { ref } = req.query;
  if (!ref) return res.status(400).json({ error: 'No reference provided' });

  try {
    const result = await pool.query(
      `SELECT one_time_token FROM payment_queue WHERE transaction_id = $1`,
      [ref]
    );
    if (result.rows.length === 0 || !result.rows[0].one_time_token) {
      return res.json({ token: null });
    }
    res.json({ token: result.rows[0].one_time_token });
  } catch (err) {
    console.error('Get token error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ========== CHECK CREDENTIALS VIA TOKEN ==========
app.get('/api/check-token', async (req, res) => {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!token) return res.json({ found: false });

  try {
    const result = await pool.query(`
      SELECT mikrotik_username, mikrotik_password, plan, status, expires_at
      FROM payment_queue
      WHERE one_time_token = $1
        AND status = 'processed'
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1
    `, [token]);

    if (result.rows.length === 0) return res.json({ found: false });

    const row = result.rows[0];
    res.json({
      found: true,
      username: row.mikrotik_username,
      password: row.mikrotik_password,
      plan: row.plan,
      expires_at: row.expires_at ? row.expires_at.toISOString() : null
    });
  } catch (err) {
    console.error('Check token error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ========== EMAIL LOOKUP (returns credentials and token) ==========
app.get('/api/check-email', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const result = await pool.query(`
      SELECT mikrotik_username, mikrotik_password, plan, expires_at, one_time_token
      FROM payment_queue
      WHERE customer_email = $1
        AND status = 'processed'
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
      LIMIT 1
    `, [email]);

    if (result.rows.length === 0) {
      return res.json({ found: false, message: 'No active account for this email.' });
    }

    const row = result.rows[0];
    res.json({
      found: true,
      username: row.mikrotik_username,
      password: row.mikrotik_password,
      plan: row.plan,
      expires_at: row.expires_at ? row.expires_at.toISOString() : null,
      token: row.one_time_token
    });
  } catch (error) {
    console.error('Email lookup error:', error.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ========== AUTO‑TOKEN PAGE ==========
app.get('/auto-token', (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html>
  <head><title>Auto Login - Dream Hatcher</title>
  <style>
    body { background: #1a1a2e; color: white; font-family: sans-serif; text-align: center; padding: 50px; }
    .spinner { border: 4px solid rgba(255,255,255,0.1); border-top: 4px solid #00c9ff; border-radius: 50%; width: 50px; height: 50px; animation: spin 1s linear infinite; margin: 20px auto; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
  </head>
  <body>
    <h2>🔐 Automatic Login</h2>
    <div class="spinner"></div>
    <div id="status">Checking your saved login...</div>
    <script>
      const token = localStorage.getItem('dh_token');
      if (!token) {
        document.getElementById('status').innerHTML = 'No saved login. <a href="/">Go to portal</a>';
      } else {
        fetch('/api/check-token?token=' + encodeURIComponent(token))
          .then(r => r.json())
          .then(data => {
            if (data.found && data.username && data.password) {
              document.getElementById('status').innerHTML = '✅ Account found! Redirecting...';
              window.location.href = 'http://192.168.88.1/login?username=' + encodeURIComponent(data.username) + '&password=' + encodeURIComponent(data.password) + '&auto=1';
            } else {
              document.getElementById('status').innerHTML = 'Expired. <a href="/">Portal</a>';
              localStorage.removeItem('dh_token');
            }
          })
          .catch(() => {
            document.getElementById('status').innerHTML = 'Error. <a href="/">Try again</a>';
          });
      }
    </script>
  </body>
  </html>
  `;
  res.send(html);
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

    console.log('💱 Success page accessed, ref:', ref);

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
          <div class="success-icon">🛜🔑</div>
          <h4>User & Password</h4>

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
    if (!ref) return res.json({ ready: false, message: 'No reference provided' });
    const result = await pool.query(`
      SELECT mikrotik_username, mikrotik_password, plan, status, mac_address, expires_at
      FROM payment_queue WHERE transaction_id = $1 LIMIT 1`, [ref]);
    if (result.rows.length > 0) {
      const user = result.rows[0];
      if (user.status === 'processed') {
        return res.json({ ready: true, username: user.mikrotik_username, password: user.mikrotik_password,
          plan: user.plan, expires_at: user.expires_at, message: 'Credentials ready' });
      } else {
        return res.json({ ready: false, status: user.status, expires_at: user.expires_at,
          message: 'Status: ' + user.status + ' - Please wait...' });
      }
    } else {
      return res.json({ ready: false, message: 'Payment not found. Please wait...' });
    }
  } catch (error) {
    console.error('Check status error:', error.message);
    return res.json({ ready: false, error: 'Server error', message: 'Please try again.' });
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
      FROM payment_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 5`);
    if (result.rows.length === 0) return res.send('');
    console.log(`✒️ Preparing ${result.rows.length} users for MikroTik`);
    const lines = result.rows.map(row => {
      const expires = row.expires_at ? row.expires_at.toISOString() : '';
      return [row.mikrotik_username || '', row.mikrotik_password || '', row.plan || '',
        '00:00:00:00:00:00', expires, row.id].join('|');
    });
    res.set('Content-Type', 'text/plain');
    res.send(lines.join('\n'));
  } catch (error) {
    console.error('❌ MikroTik queue error:', error.message);
    res.set('Content-Type', 'text/plain');
    res.send('');
  }
});

app.post('/api/mark-processed/:id', async (req, res) => {
  try {
    console.log(`⌛ Processing mark-processed for: ${req.params.id}`);
    let userId = req.params.id;
    if (userId.includes('|')) userId = userId.split('|').pop();
    const idNum = parseInt(userId);
    if (isNaN(idNum)) return res.status(400).json({ success: false, error: 'Invalid ID' });
    const result = await pool.query(`UPDATE payment_queue SET status = 'processed' WHERE id = $1 RETURNING id`, [idNum]);
    if (result.rowCount === 0) return res.status(404).json({ success: false, error: 'User not found' });
    console.log(`✅ Successfully marked ${idNum} as processed`);
    res.json({ success: true, id: idNum });
  } catch (error) {
    console.error('❌ Mark-processed error:', error.message);
    res.status(500).json({ success: false, error: 'Database update failed' });
  }
});

app.get('/api/expired-users', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey || apiKey !== process.env.MIKROTIK_API_KEY) return res.status(403).send('');
    const result = await pool.query(`
      SELECT id, mikrotik_username, mac_address, expires_at
      FROM payment_queue WHERE status = 'processed' AND expires_at IS NOT NULL AND expires_at < NOW() LIMIT 20`);
    if (result.rows.length === 0) return res.send('');
    console.log(`⏰ Found ${result.rows.length} expired user(s)`);
    const lines = result.rows.map(row => [
      row.mikrotik_username || 'unknown',
      '00:00:00:00:00:00',
      row.expires_at.toISOString(),
      row.id
    ].join('|'));
    res.set('Content-Type', 'text/plain');
    res.send(lines.join('\n'));
  } catch (error) {
    res.set('Content-Type', 'text/plain');
    res.send('');
  }
});

app.post('/api/mark-expired/:id', async (req, res) => {
  try {
    let userId = req.params.id;
    if (userId.includes('|')) userId = userId.split('|').pop();
    const idNum = parseInt(userId);
    if (isNaN(idNum) || idNum <= 0) return res.json({ success: false });
    const result = await pool.query(`
      UPDATE payment_queue SET status = 'expired' WHERE id = $1 AND status = 'processed' RETURNING mikrotik_username`, [idNum]);
    if (result.rowCount > 0) {
      console.log(`⏰ Expired: ${result.rows[0].mikrotik_username} (ID: ${idNum})`);
      return res.json({ success: true, id: idNum });
    }
    return res.json({ success: false });
  } catch (error) {
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
    res.status(500).json({ status: 'ERROR', error: error.message });
  }
});

// ========== ROOT PAGE ==========
app.get('/', (req, res) => {
  const html = `<!DOCTYPE html>
  <html>
  <head><title>Dream Hatcher Tech - WiFi Portal</title>
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
    .logo { font-size: 48px; margin-bottom: 20px; color: #00c9ff; }
    h1 { font-size: 28px; margin-bottom: 10px; color: #00c9ff; }
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
    .option-card h3 { color: #00c9ff; margin-bottom: 10px; display: flex; align-items: center; gap: 10px; }
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
    .btn:hover { transform: translateY(-2px); }
    .support-box {
      background: rgba(255,200,0,0.1);
      border: 1px solid rgba(255,200,0,0.3);
      padding: 20px;
      border-radius: 15px;
      margin: 25px 0;
      font-size: 14px;
    }
    .qr-section { margin: 25px 0; padding: 20px; background: rgba(0,0,0,0.2); border-radius: 15px; }
  </style>
  </head>
  <body>
    <div class="container">
      <div class="logo">🌐</div>
      <h1>Dream Hatcher Tech</h1>
      <p>High-Speed Business WiFi Solutions</p>
      <div class="status-badge">✅ SYSTEM OPERATIONAL</div>
      <div class="option-card">
        <h3>📱 Already on our WiFi?</h3>
        <p>If you're connected to <strong>Dream Hatcher WiFi</strong> network:</p>
        <a href="http://192.168.88.1" class="btn">Go to WiFi Login Page</a>
        <p style="margin-top: 10px; font-size: 12px; color: #aaa;">Or enter in browser: <code>192.168.88.1</code></p>
      </div>
      <div class="option-card">
        <h3>💰 Need WiFi Access?</h3>
        <p>Purchase WiFi packages starting at ₦350/day:</p>
        <a href="http://192.168.88.1/hotspotlogin.html" class="btn">View WiFi Plans & Pricing</a>
      </div>
      <div class="option-card">
        <h3>✅ Already Paid?</h3>
        <p>Check your payment status and get credentials:</p>
        <a href="/success" class="btn">Check Payment Status</a>
      </div>
      <div class="qr-section">
        <h3>📲 Quick Connect QR</h3>
        <p>Scan to open WiFi login:</p>
        <div style="background: white; padding: 10px; display: inline-block; border-radius: 10px;"><div id="qrcode"></div></div>
        <p style="font-size: 12px; margin-top: 10px; color: #aaa;">Scan with phone camera</p>
      </div>
      <div class="support-box">
        <h3>📞 Need Help?</h3>
        <p style="font-size: 18px; font-weight: bold; color: #00c9ff;">07037412314</p>
        <p style="font-size: 12px; color: #aaa;">24/7 Customer Support</p>
        <p style="margin-top: 10px; font-size: 12px;">Email: support@dreamhatcher-tech1.xo.je<br>Website: dreamhatcher-tech1.xo.je</p>
      </div>
      <p style="margin-top: 20px; font-size: 12px; color: #888;">© 2024 Dream Hatcher Tech. All rights reserved.<br>Secure Payment Processing via Monnify</p>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
    <script>QRCode.toCanvas(document.getElementById('qrcode'), 'http://192.168.88.1', { width: 150, margin: 1, color: { dark: '#000000', light: '#ffffff' } });</script>
  </body>
  </html>`;
  res.send(html);
});

// DREAM HATCHER ENTERPRISE ADMIN DASHBOARD v4.6
// Professional WiFi Management System with Role-Based Access Control
// COLUMN LAYOUT: Username + Email (stacked) | Password | Plan | Status | Created | Expires | MAC Address
// ============================================

// ========== SECURITY CONFIGURATION ==========
const ADMIN_USERS = {
    'superadmin': {
        password: 'dreamatcher@2024',
        role: 'super_admin',
        permissions: ['delete', 'create', 'update', 'extend', 'manage_users', 'export', 'force_logout']
    },
    'admin': {
        password: 'yusuf200',
        role: 'check',
        permissions: ['view']
    }
};

const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const adminSessions = {};
const adminUserSessions = {};

// ========== HELPER FUNCTIONS ==========
function naira(amount) {
    const num = Number(amount) || 0;
    return '₦' + num.toLocaleString('en-NG');
}

function planLabel(plan) {
    const labels = { '24hr': 'Daily', '3d': '3-Day', '5d': '5-Day', '7d': 'Weekly', '14d': '2-Week', '30d': 'Monthly' };
    return labels[plan] || plan || 'Unknown';
}

function escapeHtml(text) {
    if (!text) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.toString().replace(/[&<>"']/g, m => map[m]);
}

// ========== ADMIN SESSION MANAGEMENT ==========
async function createAdminLogsTable() {
    try {
        const tableCheck = await pool.query(`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'admin_logs');`);
        if (tableCheck.rows[0].exists) {
            const columns = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'admin_logs'`);
            const columnNames = columns.rows.map(row => row.column_name);
            let changed = false;
            if (!columnNames.includes('username')) {
                await pool.query(`ALTER TABLE admin_logs ADD COLUMN IF NOT EXISTS username VARCHAR(50) DEFAULT 'unknown'`);
                changed = true;
            }
            if (!columnNames.includes('role')) {
                await pool.query(`ALTER TABLE admin_logs ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'unknown'`);
                changed = true;
            }
            await pool.query(`UPDATE admin_logs SET username = 'unknown' WHERE username IS NULL`);
            await pool.query(`UPDATE admin_logs SET role = 'unknown' WHERE role IS NULL`);
            if (changed) console.log('✅ Admin logs table updated');
        } else {
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
            console.log('✅ Created admin_logs table');
        }
        try {
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_logs_session ON admin_logs(session_id)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_logs_active ON admin_logs(is_active)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_logs_time ON admin_logs(login_time DESC)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_logs_username ON admin_logs(username)`);
        } catch (error) {}
    } catch (error) {
        console.log('Admin logs table setup error:', error.message);
    }
}
createAdminLogsTable();

async function logAdminLogin(username, role, sessionId, ip, userAgent) {
    try {
        await pool.query(`UPDATE admin_logs SET logout_time = NOW(), is_active = false WHERE username = $1 AND is_active = true`, [username]);
        await pool.query(`INSERT INTO admin_logs (username, role, session_id, admin_ip, user_agent, login_time, last_activity, is_active) VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), true)`, [username, role, sessionId, ip, userAgent]);
        adminUserSessions[username] = sessionId;
    } catch (error) { console.log('Logging admin login error:', error.message); }
}

async function updateAdminActivity(sessionId) {
    try {
        await pool.query('UPDATE admin_logs SET last_activity = NOW() WHERE session_id = $1 AND is_active = true', [sessionId]);
    } catch (error) { console.log('Updating admin activity error:', error.message); }
}

async function logAdminLogout(sessionId) {
    try {
        const result = await pool.query('SELECT username FROM admin_logs WHERE session_id = $1', [sessionId]);
        if (result.rows[0]) delete adminUserSessions[result.rows[0].username];
        await pool.query('UPDATE admin_logs SET logout_time = NOW(), is_active = false WHERE session_id = $1', [sessionId]);
    } catch (error) { console.log('Logging admin logout error:', error.message); }
}

async function getActiveAdmins() {
    try {
        const result = await pool.query(`
            SELECT username, role, session_id, admin_ip, user_agent, login_time, last_activity,
                   EXTRACT(EPOCH FROM (NOW() - last_activity)) as idle_seconds
            FROM admin_logs WHERE is_active = true ORDER BY last_activity DESC
        `);
        const uniqueAdmins = {};
        result.rows.forEach(row => {
            if (!uniqueAdmins[row.username] || new Date(row.last_activity) > new Date(uniqueAdmins[row.username].last_activity)) {
                uniqueAdmins[row.username] = row;
            }
        });
        return Object.values(uniqueAdmins);
    } catch (error) { console.log('Getting active admins error:', error.message); return []; }
}

function hasPermission(session, requiredPermission) {
    if (!session || !session.role) return false;
    if (session.role === 'super_admin') return true;
    const userConfig = ADMIN_USERS[session.username];
    return userConfig && userConfig.permissions.includes(requiredPermission);
}

async function checkExpiredUsers() {
    try {
        const now = new Date();
        const result = await pool.query(`
            SELECT id FROM payment_queue 
            WHERE (status = 'processed' OR status = 'pending') AND expires_at IS NOT NULL 
            AND expires_at <= $1 AND (status != 'expired' OR status IS NULL) LIMIT 50
        `, [now]);
        for (const user of result.rows) {
            await pool.query(`UPDATE payment_queue SET status = 'expired' WHERE id = $1`, [user.id]);
        }
    } catch (error) { console.log('Checking expired users error:', error.message); }
}
setInterval(checkExpiredUsers, 120000);

async function syncExpiredWithMikroTik() {
    try {
        const result = await pool.query(`
            SELECT id, mikrotik_username, mac_address, expires_at
            FROM payment_queue
            WHERE status = 'expired' AND expires_at IS NOT NULL AND expires_at < NOW() - INTERVAL '1 minute'
            AND mikrotik_username IS NOT NULL AND mikrotik_username != ''
            AND (last_sync IS NULL OR last_sync < expires_at) LIMIT 20
        `);
        for (const user of result.rows) {
            await pool.query(`UPDATE payment_queue SET last_sync = NOW() WHERE id = $1`, [user.id]);
        }
        return result.rows;
    } catch (error) { console.log('Syncing expired users error:', error.message); return []; }
}
setInterval(syncExpiredWithMikroTik, 300000);

app.get('/api/check-mac', async (req, res) => {
    const mac = (req.query.mac || '').trim().toUpperCase();
    res.set({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    if (!mac || mac === 'UNKNOWN' || mac.length < 10) return res.json({ found: false });
    try {
        const result = await pool.query(
            `SELECT mikrotik_username, mikrotik_password, plan, status, expires_at, transaction_id
             FROM payment_queue WHERE UPPER(mac_address) = $1 AND status IN ('pending', 'processed')
             AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT 1`,
            [mac]
        );
        if (result.rows.length === 0) return res.json({ found: false });
        const row = result.rows[0];
        if (row.status === 'pending') return res.json({ found: true, ready: false, message: 'Account is being created, please wait...' });
        return res.json({ found: true, ready: true, username: row.mikrotik_username, password: row.mikrotik_password, plan: row.plan, expires: row.expires_at ? row.expires_at.toISOString() : '', reference: row.transaction_id });
    } catch (error) { console.error('Check-MAC error:', error.message); return res.json({ found: false }); }
});

app.get('/admin/api/daily', async (req, res) => {
    const { sessionId, month } = req.query;
    if (!sessionId || !adminSessions[sessionId]) return res.status(401).json({ error: 'Unauthorized' });
    const session = adminSessions[sessionId];
    if (Date.now() - session.lastActivity > SESSION_TIMEOUT) {
        await logAdminLogout(sessionId);
        delete adminSessions[sessionId];
        return res.status(401).json({ error: 'Session expired' });
    }
    session.lastActivity = Date.now();
    adminSessions[sessionId] = session;
    await updateAdminActivity(sessionId);
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month format. Use YYYY-MM.' });
    try {
        const queryDate = `${month}-01`;
        const result = await pool.query(`
            SELECT 
                EXTRACT(DAY FROM created_at) as day,
                SUM(CASE plan
                    WHEN '24hr' THEN 350 WHEN '3d' THEN 1050 WHEN '5d' THEN 1750
                    WHEN '7d' THEN 2400 WHEN '14d' THEN 4100 WHEN '30d' THEN 7500 ELSE 0 END
                ) as daily_total,
                COUNT(*) as signups_count
            FROM payment_queue
            WHERE created_at >= DATE_TRUNC('month', $1::date)
              AND created_at < DATE_TRUNC('month', $1::date) + INTERVAL '1 month'
            GROUP BY EXTRACT(DAY FROM created_at)
            ORDER BY day ASC
        `, [queryDate]);
        res.json({ success: true, data: result.rows, month: month });
    } catch (error) {
        console.error('Daily revenue API error:', error.message);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/admin', async (req, res) => {
    const { user, pwd, action, userId, newPlan, sessionId, exportData, forceLogout } = req.query;
    
    if (forceLogout === 'all' && sessionId && adminSessions[sessionId]) {
        const currentSession = adminSessions[sessionId];
        if (currentSession.role !== 'super_admin') return res.redirect(`/admin?sessionId=${sessionId}&action=permission_denied`);
        try {
            Object.keys(adminSessions).forEach(key => { if (key !== sessionId) { logAdminLogout(key); delete adminSessions[key]; } });
            await pool.query(`UPDATE admin_logs SET logout_time = NOW(), is_active = false WHERE session_id != $1 AND is_active = true`, [sessionId]);
            return res.redirect(`/admin?sessionId=${sessionId}&action=force_logout_success`);
        } catch (error) { return res.redirect(`/admin?sessionId=${sessionId}&action=force_logout_error`); }
    }
    
    if (sessionId && adminSessions[sessionId]) {
        const session = adminSessions[sessionId];
        if (Date.now() - session.lastActivity > SESSION_TIMEOUT) {
            await logAdminLogout(sessionId);
            delete adminSessions[sessionId];
            return res.redirect('/admin?sessionExpired=true');
        }
        session.lastActivity = Date.now();
        adminSessions[sessionId] = session;
        await updateAdminActivity(sessionId);
        return await handleAdminDashboard(req, res, sessionId);
    }
    
    if (user && pwd) {
        const userConfig = ADMIN_USERS[user];
        if (userConfig && userConfig.password === pwd) {
            const existingSessionId = adminUserSessions[user];
            if (existingSessionId && adminSessions[existingSessionId]) {
                const session = adminSessions[existingSessionId];
                session.lastActivity = Date.now();
                return res.redirect(`/admin?sessionId=${existingSessionId}`);
            }
            const newSessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            adminSessions[newSessionId] = {
                id: newSessionId, username: user, role: userConfig.role, permissions: userConfig.permissions,
                loggedInAt: new Date(), lastActivity: Date.now(), ip: req.ip, userAgent: req.headers['user-agent']
            };
            await logAdminLogin(user, userConfig.role, newSessionId, req.ip, req.headers['user-agent']);
            return res.redirect(`/admin?sessionId=${newSessionId}`);
        }
    }
    return res.send(getLoginForm(req.query.sessionExpired));
});

async function handleAdminDashboard(req, res, sessionId) {
    try {
        const session = adminSessions[sessionId];
        if (!session) return res.redirect('/admin');
        
        const { action, userId, newPlan, exportData } = req.query;
        let actionMessage = '', messageType = '';

        if (action === 'delete' && userId) {
            if (!hasPermission(session, 'delete')) { actionMessage = 'Permission denied: Cannot delete users'; messageType = 'error'; }
            else { await pool.query('DELETE FROM payment_queue WHERE id = $1', [userId]); actionMessage = 'User account permanently deleted'; messageType = 'success'; }
        }
        if (action === 'extend' && userId && newPlan) {
            if (!hasPermission(session, 'extend')) { actionMessage = 'Permission denied: Cannot extend plans'; messageType = 'error'; }
            else {
                let interval = '';
                if (newPlan === '24hr') interval = '24 hours';
                else if (newPlan === '3d') interval = '3 days';
                else if (newPlan === '5d') interval = '5 days';
                else if (newPlan === '7d') interval = '7 days';
                else if (newPlan === '14d') interval = '14 days';
                else if (newPlan === '30d') interval = '30 days';
                await pool.query(`UPDATE payment_queue SET plan = $1, expires_at = NOW() + INTERVAL '${interval}', status = 'processed' WHERE id = $2`, [newPlan, userId]);
                actionMessage = 'User plan extended to ' + interval; messageType = 'success';
            }
        }
        if (action === 'reset' && userId) {
            if (!hasPermission(session, 'update')) { actionMessage = 'Permission denied: Cannot reset users'; messageType = 'error'; }
            else { await pool.query(`UPDATE payment_queue SET status = 'pending', expires_at = NULL WHERE id = $1`, [userId]); actionMessage = 'User reset to pending - will be recreated on MikroTik'; messageType = 'warning'; }
        }
        if (action === 'toggle_status' && userId) {
            if (!hasPermission(session, 'toggle_status')) { actionMessage = 'Permission denied: Cannot toggle status'; messageType = 'error'; }
            else {
                const current = await pool.query('SELECT status FROM payment_queue WHERE id = $1', [userId]);
                const newStatus = current.rows[0].status === 'processed' ? 'suspended' : 'processed';
                await pool.query('UPDATE payment_queue SET status = $1 WHERE id = $2', [newStatus, userId]);
                actionMessage = 'User status changed to ' + newStatus; messageType = 'info';
            }
        }
        if (action === 'cleanup') {
            if (!hasPermission(session, 'delete')) { actionMessage = 'Permission denied: Cannot perform cleanup'; messageType = 'error'; }
            else {
                const result = await pool.query(`DELETE FROM payment_queue WHERE (status = 'expired') OR (status = 'processed' AND expires_at < NOW() - INTERVAL '7 days') OR (status = 'pending' AND created_at < NOW() - INTERVAL '7 days')`);
                actionMessage = 'Cleaned up ' + result.rowCount + ' expired/pending users'; messageType = 'success';
            }
        }
        if (action === 'sync_expired') {
            if (!hasPermission(session, 'update')) { actionMessage = 'Permission denied: Cannot sync expired users'; messageType = 'error'; }
            else { const expiredUsers = await syncExpiredWithMikroTik(); actionMessage = 'Synced ' + expiredUsers.length + ' expired users with MikroTik'; messageType = 'success'; }
        }
        if (action === 'force_logout_success') { actionMessage = 'All other admin sessions have been terminated'; messageType = 'success'; }
        if (action === 'force_logout_error') { actionMessage = 'Error terminating other sessions'; messageType = 'error'; }
        if (action === 'permission_denied') { actionMessage = 'Permission denied: Requires Super Admin access'; messageType = 'error'; }

        if (exportData === 'csv') {
            if (!hasPermission(session, 'export')) return res.status(403).send('Permission denied');
            const { rows } = await pool.query(`SELECT id, mikrotik_username as username, mikrotik_password as password, plan, status, mac_address as mac, customer_email as email, created_at, expires_at, last_sync FROM payment_queue ORDER BY created_at DESC`);
            let csvData = 'ID,Username,Password,Plan,Status,MAC Address,Email,Created,Expires,Last Sync\n';
            rows.forEach(row => {
                csvData += [row.id, '"' + (row.username || '').replace(/"/g, '""') + '"', '"' + (row.password || '').replace(/"/g, '""') + '"', '"' + (row.plan || '').replace(/"/g, '""') + '"', '"' + (row.status || '').replace(/"/g, '""') + '"', '"' + (row.mac || 'N/A').replace(/"/g, '""') + '"', '"' + (row.email || 'N/A').replace(/"/g, '""') + '"', '"' + new Date(row.created_at).toISOString() + '"', '"' + (row.expires_at ? new Date(row.expires_at).toISOString() : 'N/A') + '"', '"' + (row.last_sync ? new Date(row.last_sync).toISOString() : 'N/A') + '"'].join(',') + '\n';
            });
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="dreamhatcher_users_' + new Date().toISOString().split('T')[0] + '.csv"');
            return res.send(csvData);
        }
        
        const metrics = await pool.query(`
            WITH user_stats AS (
                SELECT COUNT(*) as total_users,
                       COUNT(CASE WHEN status = 'processed' AND (expires_at IS NULL OR expires_at > NOW()) THEN 1 END) as active_users,
                       COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_users,
                       COUNT(CASE WHEN status = 'expired' OR (status = 'processed' AND expires_at <= NOW()) THEN 1 END) as expired_users,
                       COUNT(CASE WHEN status = 'suspended' THEN 1 END) as suspended_users,
                       COUNT(CASE WHEN created_at::date = CURRENT_DATE THEN 1 END) as signups_today,
                       COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as signups_week
                FROM payment_queue
            ),
            revenue_stats AS (
                SELECT COALESCE(SUM(CASE WHEN plan = '24hr' THEN 350 WHEN plan = '3d' THEN 1050 WHEN plan = '5d' THEN 1750 WHEN plan = '7d' THEN 2400 WHEN plan = '14d' THEN 4100 WHEN plan = '30d' THEN 7500 ELSE 0 END),0) as total_revenue_lifetime,
                       COALESCE(SUM(CASE WHEN created_at::date = CURRENT_DATE THEN CASE WHEN plan = '24hr' THEN 350 WHEN plan = '3d' THEN 1050 WHEN plan = '5d' THEN 1750 WHEN plan = '7d' THEN 2400 WHEN plan = '14d' THEN 4100 WHEN plan = '30d' THEN 7500 ELSE 0 END ELSE 0 END),0) as revenue_today,
                       COALESCE(SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' THEN CASE WHEN plan = '24hr' THEN 350 WHEN plan = '3d' THEN 1050 WHEN plan = '5d' THEN 1750 WHEN plan = '7d' THEN 2400 WHEN plan = '14d' THEN 4100 WHEN plan = '30d' THEN 7500 END ELSE 0 END),0) as revenue_week,
                       COALESCE(SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN CASE WHEN plan = '24hr' THEN 350 WHEN plan = '3d' THEN 1050 WHEN plan = '5d' THEN 1750 WHEN plan = '7d' THEN 2400 WHEN plan = '14d' THEN 4100 WHEN plan = '30d' THEN 7500 END ELSE 0 END),0) as revenue_month
                FROM payment_queue
            )
            SELECT u.*, r.* FROM user_stats u, revenue_stats r
        `);

        const recentActivity = await pool.query(`
            SELECT id, mikrotik_username, mikrotik_password, plan, status, mac_address, customer_email, created_at, expires_at,
                   COALESCE(last_sync, created_at) as last_sync,
                   CASE WHEN status = 'expired' THEN 'expired' WHEN status = 'pending' THEN 'pending' WHEN status = 'suspended' THEN 'suspended'
                        WHEN status = 'processed' AND (expires_at IS NULL OR expires_at > NOW()) THEN 'active'
                        WHEN status = 'processed' AND expires_at <= NOW() THEN 'expired' ELSE 'unknown' END as realtime_status
            FROM payment_queue ORDER BY created_at DESC LIMIT 100
        `);

        const monthlyRevenue = await pool.query(`
            WITH months AS (
                SELECT DATE_TRUNC('month', created_at) as month_start,
                       SUM(CASE plan WHEN '24hr' THEN 350 WHEN '3d' THEN 1050 WHEN '5d' THEN 1750 WHEN '7d' THEN 2400 WHEN '14d' THEN 4100 WHEN '30d' THEN 7500 ELSE 0 END) as total
                FROM payment_queue WHERE created_at >= NOW() - INTERVAL '12 months' GROUP BY DATE_TRUNC('month', created_at)
                ORDER BY month_start DESC
            )
            SELECT to_char(month_start, 'Mon YYYY') as month_label, to_char(month_start, 'YYYY-MM') as month_raw, month_start, COALESCE(total, 0) as revenue FROM months LIMIT 12
        `);

        let activeAdmins = await getActiveAdmins();
        let visibleSessionCount = activeAdmins.length;
        if (session.role !== 'super_admin') {
            activeAdmins = activeAdmins.filter(admin => admin.role !== 'super_admin');
            visibleSessionCount = activeAdmins.length;
        }

        const stats = metrics.rows[0];
        const users = recentActivity.rows;
        const activeCount = users.filter(u => u.realtime_status === 'active').length;
        const expiredCount = users.filter(u => u.realtime_status === 'expired').length;
        const pendingCount = users.filter(u => u.realtime_status === 'pending').length;
        const suspendedCount = users.filter(u => u.realtime_status === 'suspended').length;
        const currentSession = session;
        const currentAdminIdleSeconds = currentSession ? Math.floor((Date.now() - currentSession.lastActivity) / 1000) : 0;
        const activeSessions = visibleSessionCount;

        res.send(renderDashboard({
            session, sessionId, stats, users, activeCount, expiredCount, pendingCount, suspendedCount,
            activeAdmins, activeSessions, currentAdminIdleSeconds, currentAdminIP: currentSession ? currentSession.ip : 'Unknown',
            actionMessage, messageType, monthlyRevenue: monthlyRevenue.rows
        }));
    } catch (error) {
        console.log('Dashboard handler error:', error.message);
        res.status(500).send(getErrorPage(error.message));
    }
}

function getLoginForm(sessionExpired) { /* unchanged – keep as before */ }

function getErrorPage(error) { /* unchanged – keep as before */ }

// ========== RENDER DASHBOARD WITH NEW COLUMN LAYOUT ==========
function renderDashboard(data) {
    const { session, sessionId, stats, users, activeCount, expiredCount, pendingCount, suspendedCount, activeAdmins, activeSessions, currentAdminIdleSeconds, actionMessage, messageType, monthlyRevenue } = data;
    const now = new Date();
    const sessionEnd = now.getTime() + (5 * 60 * 1000);

    // Build user table rows: first column = username + email (stacked), second column = password
    let userRows = '';
    if (users.length === 0) {
        userRows = '<tr><td colspan="7" style="text-align:center;padding:48px;color:var(--text-muted);">No users found</td></tr>';
    } else {
        users.forEach(user => {
            const created = new Date(user.created_at);
            const expires = user.expires_at ? new Date(user.expires_at) : null;
            const isExpired = user.realtime_status === 'expired';
            const statusBadge = 'badge-' + user.realtime_status;
            const statusIcon = user.realtime_status === 'active' ? 'fa-circle-check' : user.realtime_status === 'expired' ? 'fa-circle-xmark' : user.realtime_status === 'pending' ? 'fa-hourglass-half' : user.realtime_status === 'suspended' ? 'fa-pause-circle' : 'fa-circle-question';
            
            userRows += `
                <tr data-status="${user.realtime_status}" data-search="${escapeHtml(user.mikrotik_username)} ${escapeHtml(user.mac_address)} ${escapeHtml(user.customer_email)}">
                    <td class="user-email-cell">
                        <div class="username">${escapeHtml(user.mikrotik_username)}</div>
                        <div class="user-email">${escapeHtml(user.customer_email || 'N/A')}</div>
                    </td>
                    <td class="password-cell">${escapeHtml(user.mikrotik_password)}</td>
                    <td><div class="plan-tag tag-${user.plan}">${planLabel(user.plan)}</div></td>
                    <td>
                        <span class="badge ${statusBadge}">
                            <i class="fa-solid ${statusIcon}"></i> ${user.realtime_status.toUpperCase()}
                        </span>
                    </td>
                    <td class="text-secondary">${created.toLocaleDateString()} <span style="font-size:11px;opacity:0.6">${created.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span></td>
                    <td class="${isExpired ? 'text-danger' : 'text-success'} font-600">
                        ${expires ? expires.toLocaleDateString() : 'Never'}
                        <div style="font-size:11px;opacity:0.6">${expires ? expires.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : ''}</div>
                    </td>
                    <td class="mono" style="font-size:12px;">${escapeHtml(user.mac_address || 'N/A')}</td>
                </tr>
            `;
        });
    }

    // Build admin sessions rows (unchanged)
    let adminSessionsRows = '';
    activeAdmins.forEach(admin => {
        const loginTime = new Date(admin.login_time);
        const idleMins = Math.floor(admin.idle_seconds / 60);
        const idleSeconds = Math.floor(admin.idle_seconds % 60);
        const isCurrentUser = admin.username === session.username;
        const idleTooLong = admin.idle_seconds > 300;
        adminSessionsRows += `
            <tr style="${isCurrentUser ? 'background: rgba(139, 92, 246, 0.1);' : ''}">
                <td style="padding: 12px;">
                    <strong>${admin.username}</strong> ${isCurrentUser ? '<span style="color: #10b981;">(You)</span>' : ''}
                    <div style="font-size: 11px; color: var(--text-muted);">${admin.role.replace('_', ' ')}</div>
                </td>
                <td style="padding: 12px; font-family: monospace;">${admin.admin_ip}</td>
                <td style="padding: 12px;">${loginTime.toLocaleString()}</td>
                <td style="padding: 12px; ${idleTooLong ? 'color: var(--danger); font-weight: 600;' : ''}">${idleMins}m ${idleSeconds}s idle</td>
            </tr>
        `;
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DH Dashboard • Dream Hatcher</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-primary: #020617;
            --bg-secondary: #0f172a;
            --bg-card: #1e293b;
            --bg-hover: #334155;
            --border: #334155;
            --border-light: #475569;
            --text-primary: #f8fafc;
            --text-secondary: #cbd5e1;
            --text-muted: #64748b;
            --accent: #3b82f6;
            --accent-glow: rgba(59, 130, 246, 0.5);
            --success: #10b981;
            --success-bg: rgba(16, 185, 129, 0.1);
            --warning: #f59e0b;
            --warning-bg: rgba(245, 158, 11, 0.1);
            --danger: #ef4444;
            --danger-bg: rgba(239, 68, 68, 0.1);
            --purple: #8b5cf6;
            --purple-bg: rgba(139, 92, 246, 0.1);
            --radius: 16px;
            --radius-sm: 10px;
            --shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
        }

        * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Plus Jakarta Sans', sans-serif; }
        body { background: var(--bg-primary); color: var(--text-primary); min-height: 100vh; overflow-x: hidden; }

        .topbar {
            height: 72px;
            background: rgba(15, 23, 42, 0.8);
            backdrop-filter: blur(12px);
            border-bottom: 1px solid var(--border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 32px;
            position: sticky;
            top: 0;
            z-index: 100;
        }
        .brand { display: flex; align-items: center; gap: 14px; }
        .brand-logo { width: 48px; height: 48px; border-radius: 12px; background: transparent; display: flex; align-items: center; justify-content: center; }
        .brand-name { font-size: 20px; font-weight: 800; letter-spacing: -0.5px; }
        .brand-user { font-size: 13px; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; }
        .user-role { 
            background: ${session.role === 'super_admin' ? 'var(--purple-bg)' : 'var(--success-bg)'}; 
            color: ${session.role === 'super_admin' ? 'var(--purple)' : 'var(--success)'}; 
            padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; text-transform: uppercase; 
        }

        .nav-actions { display: flex; align-items: center; gap: 12px; }
        .chip { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 20px; font-size: 13px; font-weight: 600; background: var(--success-bg); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.3); }
        .btn { display: inline-flex; align-items: center; gap: 8px; padding: 9px 18px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-card); color: var(--text-primary); font-size: 14px; font-weight: 600; cursor: pointer; text-decoration: none; transition: all 0.2s; white-space: nowrap; }
        .btn:hover { background: var(--bg-hover); border-color: var(--border-light); }
        .btn-primary { background: var(--accent); border-color: var(--accent); color: white; }
        .btn-danger { color: var(--danger); }
        .btn-danger:hover { background: var(--danger-bg); border-color: var(--danger); }
        .main-container { max-width: 1400px; margin: 0 auto; padding: 32px; }

        .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px; margin-bottom: 40px; }
        .metric { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; box-shadow: var(--shadow); transition: transform 0.2s; cursor: pointer; }
        .metric:hover { transform: translateY(-4px); border-color: var(--border-light); }
        .metric-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
        .metric-icon { width: 48px; height: 48px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 20px; }
        .metric-tag { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; padding: 4px 12px; border-radius: 20px; }
        .metric-value { font-size: 32px; font-weight: 800; margin-bottom: 8px; color: var(--text-primary); }
        .metric-value.currency { color: var(--success); }
        .metric-label { font-size: 14px; color: var(--text-secondary); margin-bottom: 16px; }
        .metric-footer { padding-top: 16px; border-top: 1px solid var(--border); font-size: 13px; color: var(--text-muted); display: flex; align-items: center; gap: 8px; }

        .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 32px; overflow: hidden; box-shadow: var(--shadow); }
        .card-header { padding: 24px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; background: var(--bg-secondary); }
        .card-title { font-size: 18px; font-weight: 700; color: var(--text-primary); }
        .card-subtitle { font-size: 14px; color: var(--text-secondary); margin-top: 4px; }
        .card-tools { display: flex; gap: 12px; align-items: center; }

        .table-wrap { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; text-align: left; }
        th { padding: 16px 24px; background: rgba(15, 23, 42, 0.4); color: var(--text-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid var(--border); }
        td { padding: 16px 24px; border-bottom: 1px solid var(--border); font-size: 14px; vertical-align: middle; }
        tr:hover td { background: rgba(51, 65, 85, 0.3); }

        /* New column styles */
        .user-email-cell {
            min-width: 260px;
            max-width: 320px;
            word-break: break-word;
            white-space: normal;
        }
        .username {
            font-weight: 700;
            color: var(--text-primary);
            margin-bottom: 6px;
        }
        .user-email {
            font-size: 12px;
            color: var(--text-muted);
            word-break: break-word;
        }
        .password-cell {
            font-family: 'JetBrains Mono', monospace;
            font-size: 13px;
            color: var(--text-primary);
            white-space: nowrap;
            overflow-x: auto;
            max-width: 150px;
        }

        .badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; }
        .badge-active { background: var(--success-bg); color: var(--success); }
        .badge-expired { background: var(--danger-bg); color: var(--danger); }
        .badge-pending { background: var(--warning-bg); color: var(--warning); }
        .badge-suspended { background: #334155; color: #94a3b8; }

        .plan-tag { padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; display: inline-block; }
        .tag-24hr { background: rgba(59, 130, 246, 0.1); color: var(--accent); }
        .tag-3d { background: rgba(6, 182, 212, 0.1); color: #06b6d4; }
        .tag-5d { background: rgba(139, 92, 246, 0.1); color: var(--purple); }
        .tag-7d { background: rgba(16, 185, 129, 0.1); color: var(--success); }
        .tag-14d { background: rgba(245, 158, 11, 0.1); color: var(--warning); }
        .tag-30d { background: rgba(236, 72, 153, 0.1); color: #ec4899; }

        .search-wrap { position: relative; min-width: 240px; }
        .search-wrap i { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: var(--text-muted); font-size: 14px; }
        .search-input { width: 100%; padding: 11px 16px 11px 40px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-secondary); color: var(--text-primary); font-size: 14px; transition: all 0.2s; }
        .search-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2); }

        .filter-tabs { display: flex; gap: 8px; flex-wrap: wrap; }
        .filter-tab { padding: 8px 16px; border-radius: 20px; font-size: 13px; font-weight: 600; border: 1px solid var(--border); background: var(--bg-secondary); color: var(--text-secondary); cursor: pointer; transition: all 0.2s; }
        .filter-tab:hover { background: var(--bg-hover); }
        .filter-tab.active { background: var(--accent); border-color: var(--accent); color: white; }

        .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.7); backdrop-filter: blur(4px); z-index: 1000; align-items: center; justify-content: center; padding: 20px; }
        .modal-overlay.open { display: flex; }
        .modal-box { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); width: 100%; max-width: 800px; max-height: 90vh; overflow-y: auto; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); }
        .modal-header { padding: 24px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
        .modal-title { font-size: 18px; font-weight: 700; }
        .modal-close { background: none; border: none; color: var(--text-muted); font-size: 24px; cursor: pointer; }
        .modal-body { padding: 24px; }
        .modal-footer { padding: 20px 24px; border-top: 1px solid var(--border); background: rgba(15, 23, 42, 0.4); display: flex; justify-content: flex-end; gap: 12px; }

        .progress-row { margin-bottom: 12px; }
        .progress-info { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 6px; color: var(--text-secondary); }
        .progress-track { height: 10px; background: var(--bg-primary); border-radius: 5px; overflow: hidden; position: relative; }
        .progress-fill { height: 100%; background: var(--accent); border-radius: 5px; transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1); }

        .revenue-link { background: none; border: none; color: var(--accent); font-weight: 600; cursor: pointer; transition: color 0.2s; display: block; text-align: left; width: 100%; font-size: inherit; }
        .revenue-link:hover { color: var(--text-primary); text-decoration: underline; }

        .page-footer { text-align: center; padding: 32px; border-top: 1px solid var(--border); margin-top: 32px; color: var(--text-muted); font-size: 14px; background: var(--bg-card); border-radius: var(--radius); box-shadow: var(--shadow); }
        .footer-stats { display: flex; justify-content: center; gap: 32px; margin-top: 16px; flex-wrap: wrap; font-size: 13px; }

        .mono { font-family: 'JetBrains Mono', monospace; }
        .text-success { color: var(--success); }
        .text-danger { color: var(--danger); }
        .text-secondary { color: var(--text-secondary); }
        .font-600 { font-weight: 600; }

        @media (max-width: 768px) {
            .topbar { padding: 0 16px; }
            .main-container { padding: 20px; }
            .metrics { grid-template-columns: 1fr; }
            .card-header { padding: 16px; }
            .card-tools { width: 100%; }
            .search-wrap { min-width: 100%; }
            .user-email-cell { min-width: 180px; max-width: 220px; }
            .password-cell { white-space: normal; word-break: break-word; }
        }
    </style>
</head>
<body>

    <!-- Extend Modal -->
    <div class="modal-overlay" id="extendModal">
        <div class="modal-box" style="max-width: 500px;">
            <div class="modal-header">
                <h3 class="modal-title">Extend User Plan</h3>
                <button class="modal-close" onclick="closeExtend()">&times;</button>
            </div>
            <div class="modal-body">
                <p style="color: var(--text-secondary); margin-bottom: 20px;">Extending plan for: <strong id="extendUser" style="color: var(--text-primary);"></strong></p>
                <div class="plan-options">
                    <label class="plan-option" style="display:block; padding:16px; border:2px solid var(--border); border-radius:var(--radius-sm); margin-bottom:12px; cursor:pointer;" onclick="selectPlan(this)">
                        <input type="radio" name="extPlan" value="24hr" checked style="margin-right:12px;">
                        <span style="font-weight:600; color:var(--accent);">Daily Plan</span>
                        <div style="margin-left:28px; font-size:14px; color:var(--text-secondary);">24 hours • ₦350</div>
                    </label>
                    <label class="plan-option" style="display:block; padding:16px; border:2px solid var(--border); border-radius:var(--radius-sm); margin-bottom:12px; cursor:pointer;" onclick="selectPlan(this)">
                        <input type="radio" name="extPlan" value="3d" style="margin-right:12px;">
                        <span style="font-weight:600; color:#06b6d4;">3-Day Plan</span>
                        <div style="margin-left:28px; font-size:14px; color:var(--text-secondary);">3 days • ₦1,050</div>
                    </label>
                    <label class="plan-option" style="display:block; padding:16px; border:2px solid var(--border); border-radius:var(--radius-sm); margin-bottom:12px; cursor:pointer;" onclick="selectPlan(this)">
                        <input type="radio" name="extPlan" value="5d" style="margin-right:12px;">
                        <span style="font-weight:600; color:var(--purple);">5-Day Plan</span>
                        <div style="margin-left:28px; font-size:14px; color:var(--text-secondary);">5 days • ₦1,750</div>
                    </label>
                    <label class="plan-option" style="display:block; padding:16px; border:2px solid var(--border); border-radius:var(--radius-sm); margin-bottom:12px; cursor:pointer;" onclick="selectPlan(this)">
                        <input type="radio" name="extPlan" value="7d" style="margin-right:12px;">
                        <span style="font-weight:600; color:var(--success);">Weekly Plan</span>
                        <div style="margin-left:28px; font-size:14px; color:var(--text-secondary);">7 days • ₦2,400</div>
                    </label>
                    <label class="plan-option" style="display:block; padding:16px; border:2px solid var(--border); border-radius:var(--radius-sm); margin-bottom:12px; cursor:pointer;" onclick="selectPlan(this)">
                        <input type="radio" name="extPlan" value="14d" style="margin-right:12px;">
                        <span style="font-weight:600; color:var(--warning);">2-Week Plan</span>
                        <div style="margin-left:28px; font-size:14px; color:var(--text-secondary);">14 days • ₦4,100</div>
                    </label>
                    <label class="plan-option" style="display:block; padding:16px; border:2px solid var(--border); border-radius:var(--radius-sm); cursor:pointer;" onclick="selectPlan(this)">
                        <input type="radio" name="extPlan" value="30d" style="margin-right:12px;">
                        <span style="font-weight:600; color:#ec4899;">Monthly Plan</span>
                        <div style="margin-left:28px; font-size:14px; color:var(--text-secondary);">30 days • ₦7,500</div>
                    </label>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn" onclick="closeExtend()">Cancel</button>
                <button class="btn btn-primary" id="extendConfirmBtn">Update Plan</button>
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
                <div class="table-wrap">
                    <table style="width:100%">
                        <thead>
                            <tr><th>Admin User</th><th>IP Address</th><th>Login Time</th><th>Idle Time</th></tr>
                        </thead>
                        <tbody>
                            ${activeAdmins.length > 0 ? adminSessionsRows : '<tr><td colspan="4" style="text-align:center; padding:32px;">No active admin sessions</td></tr>'}
                        </tbody>
                    </table>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn" onclick="closeModal('adminSessionsModal')">Close</button>
                ${activeSessions > 1 && hasPermission(session, 'force_logout') ? `<button class="btn btn-danger" onclick="forceLogoutAll()"><i class="fa-solid fa-power-off"></i> Force Logout All Others</button>` : ''}
            </div>
        </div>
    </div>

    <!-- Revenue Analytics Modal -->
    <div class="modal-overlay" id="revenueModal">
        <div class="modal-box">
            <div class="modal-header">
                <h3 class="modal-title"><i class="fa-solid fa-chart-line"></i> Revenue Analytics</h3>
                <button class="modal-close" onclick="closeRevenueModal()">&times;</button>
            </div>
            <div class="modal-body">
                <h4 style="margin-bottom: 16px; color: var(--text-primary);"><i class="fa-solid fa-calendar-alt"></i> Last 12 Months (Descending)</h4>
                <div style="overflow-x: auto; margin-bottom: 32px;">
                    <table style="width: 100%; border-collapse: collapse; min-width: 300px;">
                        <thead><tr><th style="text-align:left; padding: 12px;">Month</th><th style="text-align:right; padding: 12px;">Revenue</th></tr></thead>
                        <tbody>
                            ${monthlyRevenue.map(m => `
                                <tr>
                                    <td style="padding: 10px; border-bottom: 1px solid var(--border);">
                                        <button class="revenue-link" onclick="loadMonthData('${m.month_raw}')">${m.month_label}</button>
                                    </td>
                                    <td style="padding: 10px; text-align: right; border-bottom: 1px solid var(--border); font-weight: 600; color: var(--success);">
                                        ${naira(m.revenue)}
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; flex-wrap: wrap; gap: 12px;">
                    <h4 style="color: var(--text-primary); margin: 0;"><i class="fa-solid fa-chart-simple"></i> Daily Progress – <span id="currentMonthLabel">Current Month</span></h4>
                    <button id="returnToCurrentMonthBtn" class="btn" style="padding: 6px 12px; font-size: 12px;" onclick="returnToCurrentMonth()"><i class="fa-solid fa-arrow-left"></i> Return to Current Month</button>
                </div>
                <div style="background: var(--bg-secondary); border-radius: var(--radius-sm); padding: 20px;">
                    <div id="dailyProgressContainer" style="display: flex; flex-direction: column; gap: 16px;">
                        <div style="text-align: center; color: var(--text-muted);">Click a month to view daily revenue & signups</div>
                    </div>
                    <div style="margin-top: 20px; font-size: 13px; color: var(--text-secondary); text-align: center;">
                        <i class="fa-solid fa-info-circle"></i> Each day shows revenue (white) and signups (green)
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn" onclick="closeRevenueModal()">Close</button>
            </div>
        </div>
    </div>

    <nav class="topbar">
        <div class="brand">
            <div class="brand-logo">
                <img src="https://i.imgur.com/f0xX5TT.png" style="width: 48px; height: 48px; border-radius: 12px;">
            </div>
            <div>
                <div class="brand-name">Dream Hatcher Tech</div>
                <div class="brand-user">
                    <span>${session.username}</span>
                    <span class="user-role">${session.role === 'super_admin' ? 'SUPER ADMIN' : 'ADMIN'}</span>
                </div>
            </div>
        </div>
        <div class="nav-actions">
            <div class="chip"><i class="fa-solid fa-satellite-dish"></i><span>Network Live</span></div>
            ${hasPermission(session, 'export') ? `<a href="/admin?sessionId=${sessionId}&exportData=csv" class="btn"><i class="fa-solid fa-file-export"></i> <span>Export Users</span></a>` : ''}
            <button class="btn" onclick="location.reload()"><i class="fa-solid fa-rotate"></i> Refresh</button>
            <a href="/admin" class="btn btn-danger"><i class="fa-solid fa-right-from-bracket"></i> <span>Logout</span></a>
        </div>
    </nav>

    <div class="main-container">
        ${actionMessage ? `
            <div style="background: ${messageType === 'success' ? 'var(--success-bg)' : messageType === 'error' ? 'var(--danger-bg)' : 'var(--warning-bg)'}; 
                        border: 1px solid ${messageType === 'success' ? 'var(--success)' : messageType === 'error' ? 'var(--danger)' : 'var(--warning)'}; 
                        color: ${messageType === 'success' ? 'var(--success)' : messageType === 'error' ? '#f87171' : 'var(--warning)'}; 
                        padding: 16px 24px; border-radius: 12px; margin-bottom: 32px; display: flex; align-items: center; justify-content: space-between; font-weight: 600;">
                <div style="display:flex; align-items:center; gap:12px;">
                    <i class="fa-solid ${messageType === 'success' ? 'fa-circle-check' : 'fa-circle-exclamation'}"></i>
                    ${actionMessage}
                </div>
                <button onclick="this.parentElement.remove()" style="background:none; border:none; color:inherit; cursor:pointer; font-size:18px;">&times;</button>
            </div>
        ` : ''}

        <div style="margin-bottom: 40px; display: flex; justify-content: space-between; align-items: flex-end;">
            <div>
                <h1 style="font-size: 28px; font-weight: 800; margin-bottom: 8px;">Network Dashboard</h1>
                <p style="color: var(--text-secondary);">Real-time monitoring and management of WiFi clients</p>
            </div>
            <div style="text-align: right; color: var(--text-muted); font-size: 13px;">
                <i class="fa-solid fa-server"></i> Server Time: ${now.toLocaleTimeString()}
            </div>
        </div>

        <div class="metrics">
            <div class="metric" onclick="showRevenueModal()" style="cursor:pointer; border-color: rgba(16, 185, 129, 0.3);">
                <div class="metric-header">
                    <div class="metric-icon" style="background:var(--success-bg); color:var(--success);"><i class="fa-solid fa-money-bill-trend-up"></i></div>
                    <span class="metric-tag" style="background:var(--success-bg); color:var(--success);">Lifetime</span>
                </div>
                <div class="metric-value currency">${naira(stats.total_revenue_lifetime)}</div>
                <div class="metric-label">Total Revenue Generated</div>
                <div class="metric-footer"><i class="fa-solid fa-chart-line"></i> Click for detailed analytics</div>
            </div>

            <div class="metric">
                <div class="metric-header">
                    <div class="metric-icon" style="background:rgba(59, 130, 246, 0.2); color:var(--accent);"><i class="fa-solid fa-calendar-day"></i></div>
                    <span class="metric-tag" style="background:rgba(59, 130, 246, 0.2); color:var(--accent);">TODAY</span>
                </div>
                <div class="metric-value currency" style="color:var(--accent);">${naira(stats.revenue_today)}</div>
                <div class="metric-label">Today's Revenue</div>
                <div class="metric-footer"><i class="fa-solid fa-user-plus"></i> ${stats.signups_today} signups today</div>
            </div>

            <div class="metric">
                <div class="metric-header">
                    <div class="metric-icon" style="background:var(--success-bg); color:var(--success);"><i class="fa-solid fa-users"></i></div>
                    <span class="metric-tag" style="background:var(--success-bg); color:var(--success);">ACTIVE</span>
                </div>
                <div class="metric-value" style="color:var(--success);">${activeCount}</div>
                <div class="metric-label">Currently Active Users</div>
                <div class="metric-footer">
                    <span style="color:var(--danger);"><i class="fa-solid fa-xmark"></i> ${expiredCount} expired</span>
                    <span style="color:var(--warning); margin-left:12px;"><i class="fa-solid fa-clock"></i> ${pendingCount} pending</span>
                </div>
            </div>

            <div class="metric" onclick="showAdminSessions()" style="cursor:pointer;">
                <div class="metric-header">
                    <div class="metric-icon" style="background:var(--purple-bg); color:var(--purple);"><i class="fa-solid fa-user-shield"></i></div>
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

        <div class="card">
            <div class="card-header">
                <div>
                    <div class="card-title"><i class="fa-solid fa-users-gear" style="color:var(--accent); margin-right:10px;"></i>WiFi Client Management</div>
                    <div class="card-subtitle">Latest 100 users – Username + Email, separate Password column</div>
                </div>
                <div class="card-tools">
                    <div class="search-wrap">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input type="text" class="search-input" id="searchInput" placeholder="Search username, MAC, email..." autocomplete="off">
                    </div>
                    <div class="filter-tabs">
                        <button class="filter-tab active" onclick="setFilter('all')" data-filter="all">All</button>
                        <button class="filter-tab" onclick="setFilter('active')" data-filter="active">Active</button>
                        <button class="filter-tab" onclick="setFilter('pending')" data-filter="pending">Pending</button>
                        <button class="filter-tab" onclick="setFilter('expired')" data-filter="expired">Expired</button>
                    </div>
                    ${hasPermission(session, 'delete') ? `
                        <button class="btn btn-danger" onclick="confirmCleanup()" title="Remove inactive/old data">
                            <i class="fa-solid fa-broom"></i> <span>Cleanup</span>
                        </button>
                    ` : ''}
                    <button class="btn" onclick="confirmSync()" title="Sync expired users with MikroTik">
                        <i class="fa-solid fa-sync"></i> <span>Sync</span>
                    </button>
                </div>
            </div>
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>User / Email</th>
                            <th>Password</th>
                            <th>Plan</th>
                            <th>Status</th>
                            <th>Created</th>
                            <th>Expires</th>
                            <th>MAC Address</th>
                        </tr>
                    </thead>
                    <tbody id="usersTbody">
                        ${userRows}
                    </tbody>
                </table>
            </div>
        </div>

        <div class="page-footer">
            <p>Dream Hatcher Tech Dashboard v4.6 — Professional WiFi Management System</p>
            <div class="footer-stats">
                <span><i class="fa-solid fa-database"></i> ${stats.total_users} Total Users</span>
                <span><i class="fa-solid fa-money-bill-wave"></i> ${naira(stats.total_revenue_lifetime)} Lifetime Revenue</span>
                <span><i class="fa-solid fa-user-shield"></i> ${activeSessions} Admin Sessions</span>
                <span><i class="fa-solid fa-shield-halved"></i> Role: ${session.role === 'super_admin' ? 'SUPER ADMIN' : 'ADMIN'}</span>
            </div>
        </div>
    </div>

    <script>
        let currentFilter = 'all';
        let extendTargetId = null;
        let currentMonthRaw = null;

        function formatNaira(amount) { const num = Number(amount) || 0; return '₦' + num.toLocaleString('en-NG'); }

        function loadMonthData(monthRaw) {
            const container = document.getElementById('dailyProgressContainer');
            const monthLabelSpan = document.getElementById('currentMonthLabel');
            currentMonthRaw = monthRaw;
            container.innerHTML = '<div style="text-align: center; padding: 20px;"><i class=\"fa-solid fa-spinner fa-spin\"></i> Loading...</div>';
            fetch('/admin/api/daily?sessionId=${sessionId}&month=' + monthRaw)
                .then(response => response.json())
                .then(result => {
                    if (!result.success) throw new Error(result.error || 'Failed to load data');
                    const dailyData = result.data;
                    const monthDisplay = new Date(monthRaw + '-01').toLocaleString('default', { month: 'long', year: 'numeric' });
                    monthLabelSpan.textContent = monthDisplay;
                    if (dailyData.length === 0) { container.innerHTML = '<p style="color: var(--text-muted); text-align: center;">No revenue recorded for this month.</p>'; return; }
                    const maxRevenue = Math.max(...dailyData.map(d => Number(d.daily_total)), 1);
                    let barsHtml = '';
                    for (let i = 0; i < dailyData.length; i++) {
                        const day = dailyData[i];
                        const percent = (Number(day.daily_total) / maxRevenue) * 100;
                        const revenueFormatted = formatNaira(day.daily_total);
                        const signups = day.signups_count || 0;
                        barsHtml += '<div class="progress-row">' +
                            '<div class="progress-info">' +
                                '<span>Day ' + day.day + '</span>' +
                                '<div style="display: flex; gap: 16px;">' +
                                    '<span style="font-weight:700; color: var(--text-primary);">' + revenueFormatted + '</span>' +
                                    '<span style="font-weight:700; color: var(--success);"><i class="fa-solid fa-user-plus"></i> +' + signups + ' signups</span>' +
                                '</div>' +
                            '</div>' +
                            '<div class="progress-track">' +
                                '<div class="progress-fill" style="width: 0%;" data-w="' + percent + '"></div>' +
                            '</div>' +
                        '</div>';
                    }
                    container.innerHTML = barsHtml;
                    setTimeout(() => {
                        document.querySelectorAll('.progress-fill').forEach(bar => { bar.style.width = bar.dataset.w + '%'; });
                    }, 50);
                })
                .catch(err => { container.innerHTML = '<p style="color: var(--danger); text-align: center;">Error loading data: ' + err.message + '</p>'; });
        }

        function returnToCurrentMonth() {
            const now = new Date();
            const currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
            loadMonthData(currentMonth);
        }

        function showRevenueModal() {
            const container = document.getElementById('dailyProgressContainer');
            if (container.innerHTML.includes('Click a month')) {
                const now = new Date();
                const currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
                loadMonthData(currentMonth);
            }
            document.getElementById('revenueModal').classList.add('open');
        }
        function closeRevenueModal() { document.getElementById('revenueModal').classList.remove('open'); }

        function openExtend(id, name) {
            extendTargetId = id;
            document.getElementById('extendUser').textContent = name;
            document.getElementById('extendModal').classList.add('open');
        }
        function closeExtend() { document.getElementById('extendModal').classList.remove('open'); extendTargetId = null; }
        function selectPlan(element) {
            document.querySelectorAll('.plan-option').forEach(opt => { opt.style.borderColor = 'var(--border)'; opt.style.background = 'var(--bg-secondary)'; });
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

        function confirmReset(id) { if (confirm('Reset this user?')) window.location.href = '/admin?sessionId=${sessionId}&action=reset&userId=' + id; }
        function confirmDelete(id) { if (confirm('PERMANENTLY DELETE this user?')) window.location.href = '/admin?sessionId=${sessionId}&action=delete&userId=' + id; }
        function confirmCleanup() { if (confirm('Clean up expired/pending records?')) window.location.href = '/admin?sessionId=${sessionId}&action=cleanup'; }
        function confirmSync() { window.location.href = '/admin?sessionId=${sessionId}&action=sync_expired'; }
        function showAdminSessions() { document.getElementById('adminSessionsModal').classList.add('open'); }
        function closeModal(modalId) { document.getElementById(modalId).classList.remove('open'); }
        function forceLogoutAll() { if (confirm('Force logout all other admin sessions?')) window.location.href = '/admin?sessionId=${sessionId}&forceLogout=all'; }

        document.getElementById('searchInput').addEventListener('input', filterTable);
        document.querySelectorAll('.modal-overlay').forEach(modal => {
            modal.addEventListener('click', function(e) {
                if (e.target === this) {
                    if (this.id === 'extendModal') closeExtend();
                    else if (this.id === 'adminSessionsModal') closeModal('adminSessionsModal');
                    else if (this.id === 'revenueModal') closeRevenueModal();
                }
            });
        });

        function setFilter(filter) {
            currentFilter = filter;
            document.querySelectorAll('.filter-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.filter === filter));
            filterTable();
        }
        function filterTable() {
            const search = document.getElementById('searchInput').value.toLowerCase();
            const rows = document.querySelectorAll('#usersTbody tr');
            rows.forEach(row => {
                if (!row.dataset.search) { row.style.display = 'none'; return; }
                const matchSearch = search === '' || row.dataset.search.toLowerCase().includes(search);
                const matchFilter = currentFilter === 'all' || row.dataset.status === currentFilter;
                row.style.display = (matchSearch && matchFilter) ? '' : 'none';
            });
        }
        document.getElementById('searchInput')?.addEventListener('focus', function() { this.select(); });
    </script>
</body>
</html>`;
}
// ========== FAVICON FALLBACK ==========
app.get('/favicon.ico', (req, res) => {
    res.redirect(301, 'https://i.imgpeek.com/eSikilY_SDfQ');
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
  console.log(`🔗 Callback: https://dreamhatcher-backend.onrender.com/monnify-callback`);
  console.log(`💰 Payment Provider: Monnify`);
});
server.setTimeout(30000);
