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

// ========== MONNIFY SERVICE CLASS ==========
class MonnifyService {
  constructor() {
    this.apiKey = process.env.MONNIFY_API_KEY;
    this.secretKey = process.env.MONNIFY_SECRET_KEY;
    this.contractCode = process.env.MONNIFY_CONTRACT_CODE;
    this.baseUrl = process.env.MONNIFY_BASE_URL || 'https://api.monnify.com';
    
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  async getAuthToken() {
    try {
      // Check if token is still valid
      if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
        return this.accessToken;
      }

      const authString = Buffer.from(`${this.apiKey}:${this.secretKey}`).toString('base64');
      
      const response = await axios.post(
        `${this.baseUrl}/api/v1/auth/login`,
        {},
        {
          headers: {
            'Authorization': `Basic ${authString}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.responseBody) {
        this.accessToken = response.data.responseBody.accessToken;
        this.tokenExpiry = Date.now() + (55 * 60 * 1000); // 55 minutes for safety
        return this.accessToken;
      } else {
        throw new Error('Failed to get authentication token');
      }
    } catch (error) {
      console.error('Monnify Auth Error:', error.response?.data || error.message);
      throw error;
    }
  }

  async initializeTransaction(transactionData) {
    try {
      const token = await this.getAuthToken();
      
      const payload = {
        amount: transactionData.amount,
        customerName: transactionData.customerName || '',
        customerEmail: transactionData.customerEmail,
        customerPhoneNumber: transactionData.customerPhoneNumber || '',
        paymentDescription: transactionData.description || 'WiFi Access Payment',
        currencyCode: transactionData.currency || 'NGN',
        contractCode: this.contractCode,
        redirectUrl: transactionData.redirectUrl || process.env.APP_BASE_URL,
        paymentReference: transactionData.reference || `DHT${Date.now()}${Math.random().toString(36).substr(2, 9)}`,
        paymentMethods: transactionData.paymentMethods || ["CARD", "ACCOUNT_TRANSFER"]
      };

      const response = await axios.post(
        `${this.baseUrl}/api/v1/merchant/transactions/init-transaction`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.responseBody) {
        return {
          success: true,
          message: 'Transaction initialized successfully',
          data: {
            transactionReference: response.data.responseBody.transactionReference,
            paymentReference: response.data.responseBody.paymentReference,
            checkoutUrl: response.data.responseBody.checkoutUrl,
            amount: response.data.responseBody.amount,
            currency: response.data.responseBody.currencyCode
          }
        };
      } else {
        throw new Error(response.data.responseMessage || 'Failed to initialize transaction');
      }
    } catch (error) {
      console.error('Monnify Initialize Error:', error.response?.data || error.message);
      return {
        success: false,
        message: error.response?.data?.responseMessage || error.message,
        error: error.response?.data
      };
    }
  }

  async verifyTransaction(transactionReference) {
    try {
      const token = await this.getAuthToken();
      
      const response = await axios.get(
        `${this.baseUrl}/api/v2/transactions/${encodeURIComponent(transactionReference)}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.responseBody) {
        return {
          success: true,
          data: response.data.responseBody,
          status: response.data.responseBody.paymentStatus,
          amountPaid: response.data.responseBody.amountPaid,
          settlementAmount: response.data.responseBody.settlementAmount
        };
      } else {
        throw new Error(response.data.responseMessage || 'Failed to verify transaction');
      }
    } catch (error) {
      console.error('Monnify Verify Error:', error.response?.data || error.message);
      return {
        success: false,
        message: error.response?.data?.responseMessage || error.message
      };
    }
  }
}

const monnify = new MonnifyService();

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

// ========== MONNIFY PAYMENT REDIRECT ==========
app.get('/monnify-pay/:plan', async (req, res) => {
  const { plan } = req.params;
  const mac = req.query.mac || 'unknown';
  const email = req.query.email || 'customer@dreamhatcher.com';
  
  // Plan configuration - SAME PRICES AS PAYSTACK
  const planConfig = {
    daily: { amount: 350, code: '24hr', description: '24 Hours WiFi Access' },
    weekly: { amount: 2400, code: '7d', description: '7 Days WiFi Access' },
    monthly: { amount: 7500, code: '30d', description: '30 Days WiFi Access' }
  };
  
  const selectedPlan = planConfig[plan];
  
  if (!selectedPlan) {
    return res.status(400).send(`
      <html>
        <body style="font-family: Arial; text-align: center; padding: 50px; background: #1a1a2e; color: white;">
          <h2>⚠️ Invalid Plan</h2>
          <p>Please select a valid plan.</p>
          <a href="javascript:history.back()" style="color: #00d4ff;">← Go Back</a>
        </body>
      </html>
    `);
  }
  
  try {
    const reference = `DHT${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
    
    const transactionData = {
      amount: selectedPlan.amount.toString(),
      customerEmail: email,
      customerName: `WiFi User ${mac.slice(-6)}`,
      description: selectedPlan.description,
      reference: reference,
      redirectUrl: 'https://dreamhatcher-backend.onrender.com/monnify-callback',
      currency: 'NGN'
    };

    // Add MAC address to metadata using custom fields
    transactionData.metadata = {
      mac_address: mac,
      plan: selectedPlan.code,
      reference: reference
    };

    console.log(`💳 Monnify Payment Init: ${plan} | MAC: ${mac} | Email: ${email} | Ref: ${reference}`);
    
    const result = await monnify.initializeTransaction(transactionData);
    
    if (result.success) {
      // Store in database pending transaction
      await pool.query(
        `INSERT INTO payment_queue 
        (transaction_id, customer_email, plan, mac_address, status, expires_at)
        VALUES ($1, $2, $3, $4, 'pending', NOW() + INTERVAL '10 minutes')`,
        [reference, email, selectedPlan.code, mac]
      );
      
      console.log(`✅ Monnify checkout URL: ${result.data.checkoutUrl}`);
      
      // Redirect to Monnify checkout
      res.redirect(result.data.checkoutUrl);
    } else {
      throw new Error(result.message || 'Failed to initialize Monnify transaction');
    }
    
  } catch (error) {
    console.error('Monnify payment redirect error:', error.message);
    res.send(`
      <html>
        <body style="font-family: Arial; text-align: center; padding: 50px; background: #1a1a2e; color: white;">
          <h2>⚠️ Payment Error</h2>
          <p>Could not initialize Monnify payment. Please try again.</p>
          <p><strong>Error:</strong> ${error.message}</p>
          <a href="javascript:history.back()" style="color: #00d4ff;">← Go Back</a>
          <p style="margin-top: 20px;">Support: 07037412314</p>
        </body>
      </html>
    `);
  }
});

// ========== MONNIFY WEBHOOK ==========
app.post('/api/monnify-webhook', async (req, res) => {
  console.log('📥 Monnify webhook received');
  
  try {
    const { eventType, eventData } = req.body;
    
    console.log(`🔔 Monnify Event: ${eventType}`);
    
    // Only process successful transactions
    if (eventType !== 'SUCCESS') {
      return res.status(200).json({ received: true });
    }
    
    const { paymentReference, amountPaid, customer, paymentMethod, paidOn } = eventData;
    const amountNaira = amountPaid;
    
    console.log(`💰 Payment Successful: ${paymentReference} | Amount: ${amountNaira}`);
    
    // Extract metadata
    const metadata = eventData.metaData || {};
    const macAddress = metadata.mac_address || 'unknown';
    const plan = metadata.plan;
    
    // Determine plan from amount if not in metadata
    let finalPlan = plan;
    if (!finalPlan) {
      if (amountNaira === 350) finalPlan = '24hr';
      else if (amountNaira === 2400) finalPlan = '7d';
      else if (amountNaira === 7500) finalPlan = '30d';
      else {
        console.error('❌ Invalid amount in webhook:', amountNaira);
        return res.status(400).json({ error: 'Invalid amount' });
      }
    }
    
    const username = `user_${Date.now().toString().slice(-6)}`;
    const password = generatePassword();
    
    // Calculate exact expiry timestamp based on plan
    let expiresAt;
    const now = new Date();
    if (finalPlan === '24hr') {
      expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    } else if (finalPlan === '7d') {
      expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    } else if (finalPlan === '30d') {
      expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    }
    
    // Update existing record or create new one
    await pool.query(
      `UPDATE payment_queue 
       SET status = 'processed',
           mikrotik_username = $1,
           mikrotik_password = $2,
           expires_at = $3,
           customer_email = COALESCE(customer_email, $4),
           updated_at = NOW()
       WHERE transaction_id = $5
       RETURNING id`,
      [username, password, expiresAt, customer.email, paymentReference]
    );
    
    // If no record was updated (shouldn't happen), insert new
    const check = await pool.query(
      `SELECT id FROM payment_queue WHERE transaction_id = $1`,
      [paymentReference]
    );
    
    if (check.rows.length === 0) {
      await pool.query(
        `INSERT INTO payment_queue
         (transaction_id, customer_email, customer_phone, plan,
          mikrotik_username, mikrotik_password, mac_address, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'processed', $8)`,
        [
          paymentReference,
          customer.email || 'unknown@example.com',
          customer.phoneNumber || '',
          finalPlan,
          username,
          password,
          macAddress,
          expiresAt
        ]
      );
    }
    
    console.log(`✅ Monnify user created: ${username} | Expires: ${expiresAt.toISOString()}`);
    
    return res.status(200).json({ received: true });
    
  } catch (error) {
    console.error('❌ Monnify webhook error:', error.message, error.stack);
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
          window.location.href = '/monnify-success?reference=' + encodeURIComponent('${ref || ''}');
        }
      }, 1000);
    </script>
  </body>
  </html>
  `;

  res.send(html.replace('${ref || \'\'}', ref));
});

// ========== MONNIFY SUCCESS PAGE ==========
app.get('/monnify-success', async (req, res) => {
  try {
    const { reference } = req.query;
    
    console.log('📄 Monnify success page accessed, ref:', reference);
    
    if (!reference) {
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
            <p style="font-size: 12px; margin-top: 10px;">Reference: ${reference}</p>
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
              Reference: <strong>${reference}</strong><br>
              Save this reference and contact support if needed.
            </p>
          </div>
        </div>
        
        <div class="support">
          Need help? Call: <strong>07037412314</strong>
        </div>
      </div>
      
      <script>
        const ref = '${reference}';
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
            element.style.color = '#10b981';
            setTimeout(function() { element.textContent = original; element.style.color = ''; }, 1000);
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
            const response = await fetch('/api/monnify-check-status?ref=' + encodeURIComponent(ref));
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
                statusText.textContent = 'Account queued, waiting for processing...';
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
    console.error('Monnify success page error:', error.message);
    res.status(500).send('Error loading page. Please contact support: 07037412314');
  }
});

// ========== MONNIFY STATUS CHECK ==========
app.get('/api/monnify-check-status', async (req, res) => {
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
    console.error('Monnify check status error:', error.message);
    return res.json({ 
      ready: false, 
      error: 'Server error',
      message: 'Temporary server issue. Please try again in 30 seconds.'
    });
  }
});

// ========== KEEP ALL EXISTING MIKROTIK ENDPOINTS (NO CHANGES NEEDED) ==========
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

// ========== REQUEST LOGGING ==========
app.use((req, res, next) => {
  const start = Date.now();
  
  if (!req.url.includes('/api/mikrotik-queue-text') && 
      !req.url.includes('/api/expired-users') &&
      !req.url.includes('/api/check-status') &&
      !req.url.includes('/health') &&
      !req.url.includes('/api/monnify-check-status')) {
    console.log(`📥 ${req.method} ${req.url}`);
  }
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (!req.url.includes('/api/mikrotik-queue-text') && 
        !req.url.includes('/api/expired-users') &&
        !req.url.includes('/api/check-status') &&
        !req.url.includes('/health') &&
        !req.url.includes('/api/monnify-check-status')) {
      console.log(`📤 ${req.method} ${req.url} ${res.statusCode} - ${duration}ms`);
    }
  });
  
  next();
});

// ========== MIKROTIK ENDPOINTS (EXACTLY SAME AS BEFORE) ==========
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

    const lines = result.rows.map(row => [
      row.mikrotik_username || 'unknown',
      row.mac_address || 'unknown',
      row.expires_at.toISOString(),
      row.id
    ].join('|'));

    const output = lines.join('\n');
    
    res.set('Content-Type', 'text/plain');
    res.send(output);

  } catch (error) {
    console.error('❌ Expired users query error:', error.message, error.stack);
    res.set('Content-Type', 'text/plain');
    res.send('');
  }
});

app.post('/api/mark-expired/:id', async (req, res) => {
  try {
    console.log(`🔄 Processing mark-expired for: ${req.params.id}`);
    let userId = req.params.id;
    
    if (userId.includes('|')) {
      const parts = userId.split('|');
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

// ========== ROOT PAGE (UPDATED WITH MONNIFY) ==========
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
      .payment-badges {
        display: flex;
        justify-content: center;
        gap: 10px;
        margin: 15px 0;
      }
      .payment-badge {
        background: rgba(0,201,255,0.1);
        border: 1px solid rgba(0,201,255,0.3);
        padding: 5px 10px;
        border-radius: 20px;
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="logo">🌐</div>
      <h1>Dream Hatcher Tech</h1>
      <p>High-Speed Business WiFi Solutions</p>
      
      <div class="status-badge">✅ SYSTEM OPERATIONAL</div>
      
      <div class="payment-badges">
        <span class="payment-badge">💳 Monnify Payments</span>
        <span class="payment-badge">🔒 Secure Processing</span>
      </div>
      
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
        <a href="http://192.168.88.1/hotspotlogin-monnify.html" class="btn">View WiFi Plans & Pricing</a>
        <p style="margin-top: 10px; font-size: 12px; color: #aaa;">
          Secure payments via Monnify
        </p>
      </div>
      
      <div class="option-card">
        <h3>✅ <span>Already Paid?</span></h3>
        <p>Check your payment status and get credentials:</p>
        <a href="/monnify-success" class="btn">Check Payment Status</a>
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

// ========== KEEP ALL EXISTING ADMIN ROUTES (NO CHANGES) ==========
// ============================================
// ADMIN DASHBOARD v2.0 - ENHANCED VERSION
// Add this to your index.js (replace old /admin route)
// ============================================

// Admin configuration
const ADMIN_PASSWORD = 'dreamhatcher2024'; // CHANGE THIS!
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes in milliseconds

// ========== ADMIN DASHBOARD ==========
app.get('/admin', async (req, res) => {
  const { pwd, action, userId, newPlan } = req.query;

  // Password check
  if (pwd !== ADMIN_PASSWORD) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Admin Login - Dream Hatcher</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Segoe UI', Arial; background: linear-gradient(135deg, #0a0e1a, #1a1a2e); color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
          .box { background: rgba(255,255,255,0.05); padding: 50px; border-radius: 24px; text-align: center; border: 1px solid rgba(255,255,255,0.1); max-width: 400px; width: 90%; }
          .logo { font-size: 48px; margin-bottom: 20px; }
          h2 { color: #00d4ff; margin-bottom: 30px; }
          input { padding: 16px; border-radius: 12px; border: 2px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05); color: white; font-size: 16px; width: 100%; margin: 10px 0; }
          input:focus { outline: none; border-color: #00d4ff; }
          button { padding: 16px 40px; background: linear-gradient(135deg, #00c9ff, #0066ff); border: none; border-radius: 12px; color: white; font-weight: bold; font-size: 16px; cursor: pointer; width: 100%; margin-top: 15px; }
          button:hover { opacity: 0.9; }
          .footer { margin-top: 30px; font-size: 12px; color: #64748b; }
        </style>
      </head>
      <body>
        <div class="box">
          <div class="logo">🔐</div>
          <h2>Admin Access</h2>
          <form method="GET">
            <input type="password" name="pwd" placeholder="Enter admin password" required autofocus>
            <button type="submit">Login →</button>
          </form>
          <div class="footer">Dream Hatcher Tech Admin Panel</div>
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

    // Get statistics
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
        COALESCE(SUM(CASE WHEN plan = '24hr' THEN 350 WHEN plan = '7d' THEN 2400 WHEN plan = '30d' THEN 7500 ELSE 0 END), 0) as total_revenue,
        COALESCE(SUM(CASE WHEN created_at >= CURRENT_DATE THEN (CASE WHEN plan = '24hr' THEN 350 WHEN plan = '7d' THEN 2400 WHEN plan = '30d' THEN 7500 ELSE 0 END) ELSE 0 END), 0) as today_revenue,
        COALESCE(SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' THEN (CASE WHEN plan = '24hr' THEN 350 WHEN plan = '7d' THEN 2400 WHEN plan = '30d' THEN 7500 ELSE 0 END) ELSE 0 END), 0) as week_revenue,
        COALESCE(SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN (CASE WHEN plan = '24hr' THEN 350 WHEN plan = '7d' THEN 2400 WHEN plan = '30d' THEN 7500 ELSE 0 END) ELSE 0 END), 0) as month_revenue
      FROM payment_queue WHERE status = 'processed'
    `);

    // Plan breakdown
    const plans = await pool.query(`
      SELECT plan, COUNT(*) as count FROM payment_queue WHERE status = 'processed' GROUP BY plan
    `);

    // Recent payments with expiry
    const recent = await pool.query(`
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
      LIMIT 50
    `);

    const s = stats.rows[0];
    const r = revenue.rows[0];
    const planData = {};
    plans.rows.forEach(p => { planData[p.plan] = parseInt(p.count); });

    // Count by status
    const activeCount = recent.rows.filter(r => r.real_status === 'active').length;
    const expiredCount = recent.rows.filter(r => r.real_status === 'expired').length;

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Admin Dashboard - Dream Hatcher</title>
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
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 15px 0 25px;
          border-bottom: 1px solid rgba(255,255,255,0.1);
          margin-bottom: 25px;
          flex-wrap: wrap;
          gap: 15px;
        }
        .header-left h1 { color: #00d4ff; font-size: 1.5rem; }
        .header-left p { color: #64748b; font-size: 0.85rem; margin-top: 3px; }
        .header-right { display: flex; gap: 10px; align-items: center; }
        .btn {
          padding: 10px 20px;
          border-radius: 8px;
          border: none;
          font-weight: 600;
          cursor: pointer;
          font-size: 0.85rem;
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .btn-primary { background: linear-gradient(135deg, #00c9ff, #0066ff); color: white; }
        .btn-danger { background: linear-gradient(135deg, #ef4444, #dc2626); color: white; }
        .btn-success { background: linear-gradient(135deg, #10b981, #059669); color: white; }
        .btn-secondary { background: rgba(255,255,255,0.1); color: white; border: 1px solid rgba(255,255,255,0.2); }
        .btn:hover { opacity: 0.9; transform: translateY(-1px); }
        .session-timer {
          background: rgba(245,158,11,0.2);
          color: #fbbf24;
          padding: 8px 15px;
          border-radius: 8px;
          font-size: 0.8rem;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 15px;
          margin-bottom: 25px;
        }
        .stat-card {
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 16px;
          padding: 20px;
          text-align: center;
          transition: transform 0.2s;
        }
        .stat-card:hover { transform: translateY(-3px); }
        .stat-card.highlight { background: linear-gradient(135deg, rgba(0,201,255,0.15), rgba(146,254,157,0.1)); border-color: rgba(0,201,255,0.3); }
        .stat-icon { font-size: 1.8rem; margin-bottom: 8px; }
        .stat-value { font-size: 1.8rem; font-weight: 800; color: #00d4ff; }
        .stat-value.money { color: #10b981; }
        .stat-label { color: #94a3b8; font-size: 0.8rem; margin-top: 5px; }
        .section {
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 16px;
          padding: 20px;
          margin-bottom: 20px;
        }
        .section h2 {
          color: #00d4ff;
          font-size: 1.1rem;
          margin-bottom: 15px;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .tools-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 15px;
        }
        .tool-card {
          background: rgba(0,0,0,0.2);
          border-radius: 12px;
          padding: 20px;
        }
        .tool-card h3 { color: #f8fafc; font-size: 1rem; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
        .tool-card p { color: #94a3b8; font-size: 0.85rem; margin-bottom: 15px; }
        .tool-card input, .tool-card select {
          width: 100%;
          padding: 10px 12px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.1);
          background: rgba(255,255,255,0.05);
          color: white;
          font-size: 0.9rem;
          margin-bottom: 10px;
        }
        .tool-card input:focus, .tool-card select:focus { outline: none; border-color: #00d4ff; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px 10px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 0.85rem; }
        th { color: #64748b; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; }
        tr:hover { background: rgba(255,255,255,0.02); }
        .badge { padding: 4px 10px; border-radius: 20px; font-size: 0.7rem; font-weight: 600; }
        .badge-active { background: rgba(16,185,129,0.2); color: #10b981; }
        .badge-expired { background: rgba(239,68,68,0.2); color: #ef4444; }
        .badge-pending { background: rgba(245,158,11,0.2); color: #f59e0b; }
        .badge-daily { background: rgba(59,130,246,0.2); color: #3b82f6; }
        .badge-weekly { background: rgba(139,92,246,0.2); color: #8b5cf6; }
        .badge-monthly { background: rgba(236,72,153,0.2); color: #ec4899; }
        .actions { display: flex; gap: 5px; }
        .action-btn {
          padding: 5px 10px;
          border-radius: 6px;
          border: none;
          font-size: 0.75rem;
          cursor: pointer;
          background: rgba(255,255,255,0.1);
          color: white;
        }
        .action-btn:hover { background: rgba(255,255,255,0.2); }
        .action-btn.delete { background: rgba(239,68,68,0.2); color: #ef4444; }
        .action-btn.extend { background: rgba(16,185,129,0.2); color: #10b981; }
        .mac { font-family: monospace; font-size: 0.75rem; color: #64748b; }
        .password { font-family: monospace; color: #fbbf24; cursor: pointer; }
        .time { color: #64748b; font-size: 0.8rem; }
        .alert {
          padding: 15px 20px;
          border-radius: 12px;
          margin-bottom: 20px;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .alert-success { background: rgba(16,185,129,0.2); border: 1px solid rgba(16,185,129,0.3); color: #10b981; }
        .alert-error { background: rgba(239,68,68,0.2); border: 1px solid rgba(239,68,68,0.3); color: #ef4444; }
        .search-box {
          display: flex;
          gap: 10px;
          margin-bottom: 15px;
        }
        .search-box input {
          flex: 1;
          padding: 10px 15px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.1);
          background: rgba(0,0,0,0.2);
          color: white;
          font-size: 0.9rem;
        }
        .modal {
          display: none;
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0,0,0,0.8);
          z-index: 1000;
          align-items: center;
          justify-content: center;
        }
        .modal.active { display: flex; }
        .modal-content {
          background: #1a1a2e;
          border-radius: 16px;
          padding: 30px;
          max-width: 400px;
          width: 90%;
          border: 1px solid rgba(255,255,255,0.1);
        }
        .modal-content h3 { margin-bottom: 20px; color: #00d4ff; }
        @media (max-width: 768px) {
          .stats-grid { grid-template-columns: 1fr 1fr; }
          .header { flex-direction: column; text-align: center; }
          th, td { padding: 8px 5px; font-size: 0.75rem; }
        }
        .logout-overlay {
          display: none;
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0,0,0,0.95);
          z-index: 2000;
          align-items: center;
          justify-content: center;
          flex-direction: column;
        }
        .logout-overlay.active { display: flex; }
        .logout-overlay h2 { color: #ef4444; margin-bottom: 20px; }
      </style>
    </head>
    <body>
      <!-- Session timeout overlay -->
      <div class="logout-overlay" id="logoutOverlay">
        <h2>⏰ Session Expired</h2>
        <p style="color: #94a3b8; margin-bottom: 20px;">You've been logged out due to inactivity.</p>
        <a href="/admin" class="btn btn-primary">🔐 Login Again</a>
      </div>

      <!-- Extend Plan Modal -->
      <div class="modal" id="extendModal">
        <div class="modal-content">
          <h3>⏰ Extend User Plan</h3>
          <p style="color: #94a3b8; margin-bottom: 20px;">Select new plan for <strong id="extendUsername"></strong></p>
          <form id="extendForm" method="GET">
            <input type="hidden" name="pwd" value="${pwd}">
            <input type="hidden" name="action" value="extend">
            <input type="hidden" name="userId" id="extendUserId">
            <select name="newPlan" style="width: 100%; padding: 12px; border-radius: 8px; margin-bottom: 15px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: white;">
              <option value="24hr">⚡ Daily (24 hours)</option>
              <option value="7d">🚀 Weekly (7 days)</option>
              <option value="30d">👑 Monthly (30 days)</option>
            </select>
            <div style="display: flex; gap: 10px;">
              <button type="button" class="btn btn-secondary" onclick="closeExtendModal()" style="flex: 1;">Cancel</button>
              <button type="submit" class="btn btn-success" style="flex: 1;">Extend Plan</button>
            </div>
          </form>
        </div>
      </div>

      <div class="header">
        <div class="header-left">
          <h1>🌐 Dream Hatcher Admin</h1>
          <p>WiFi Business Dashboard</p>
        </div>
        <div class="header-right">
          <div class="session-timer">
            <span>⏱️</span>
            <span id="sessionTimer">5:00</span>
          </div>
          <button class="btn btn-primary" onclick="location.reload()">🔄 Refresh</button>
          <a href="/admin" class="btn btn-danger">🚪 Logout</a>
        </div>
      </div>

      ${actionMessage ? `<div class="alert alert-success">${actionMessage}</div>` : ''}

      <!-- Revenue Stats -->
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

      <!-- User Stats -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">👥</div>
          <div class="stat-value">${s.total_payments}</div>
          <div class="stat-label">Total Users</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">✅</div>
          <div class="stat-value" style="color: #10b981;">${activeCount}</div>
          <div class="stat-label">Active Now</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">❌</div>
          <div class="stat-value" style="color: #ef4444;">${expiredCount}</div>
          <div class="stat-label">Expired</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">📈</div>
          <div class="stat-value">${s.today_count}</div>
          <div class="stat-label">Today's Signups</div>
        </div>
      </div>

      <!-- Admin Tools -->
      <div class="section">
        <h2>🛠️ Admin Tools</h2>
        <div class="tools-grid">
          <div class="tool-card">
            <h3>🔍 Search User</h3>
            <p>Find user by username or MAC address</p>
            <input type="text" id="searchInput" placeholder="Enter username or MAC..." onkeyup="searchTable()">
          </div>
          <div class="tool-card">
            <h3>📊 Export Data</h3>
            <p>Download payment records as CSV</p>
            <button class="btn btn-primary" onclick="exportCSV()" style="width: 100%;">📥 Download CSV</button>
          </div>
          <div class="tool-card">
            <h3>🧹 Cleanup Expired</h3>
            <p>Remove expired users from database</p>
            <a href="/admin?pwd=${pwd}&action=cleanup" class="btn btn-danger" style="width: 100%; justify-content: center;" onclick="return confirm('Delete all expired users?')">🗑️ Delete Expired</a>
          </div>
        </div>
      </div>

      <!-- Recent Payments Table -->
      <div class="section">
        <h2>📋 All Users (${recent.rows.length})</h2>
        <div style="overflow-x: auto;">
          <table id="usersTable">
            <thead>
              <tr>
                <th>Username</th>
                <th>Password</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Expires</th>
                <th>MAC</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${recent.rows.map(row => `
                <tr data-search="${row.mikrotik_username} ${row.mac_address || ''}">
                  <td><strong>${row.mikrotik_username}</strong></td>
                  <td><span class="password" onclick="copyText(this)" title="Click to copy">${row.mikrotik_password}</span></td>
                  <td>
                    <span class="badge badge-${row.plan === '24hr' ? 'daily' : row.plan === '7d' ? 'weekly' : 'monthly'}">
                      ${row.plan === '24hr' ? '⚡ Daily' : row.plan === '7d' ? '🚀 Weekly' : '👑 Monthly'}
                    </span>
                  </td>
                  <td>
                    <span class="badge ${row.real_status === 'active' ? 'badge-active' : row.real_status === 'expired' ? 'badge-expired' : 'badge-pending'}">
                      ${row.real_status === 'active' ? '✅ Active' : row.real_status === 'expired' ? '❌ Expired' : '⏳ Pending'}
                    </span>
                  </td>
                  <td class="time">${row.expires_at ? new Date(row.expires_at).toLocaleString('en-NG', { dateStyle: 'short', timeStyle: 'short' }) : 'N/A'}</td>
                  <td class="mac">${row.mac_address || 'N/A'}</td>
                  <td class="time">${new Date(row.created_at).toLocaleString('en-NG', { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td class="actions">
                    <button class="action-btn extend" onclick="openExtendModal('${row.id}', '${row.mikrotik_username}')" title="Extend Plan">⏰</button>
                    <a href="/admin?pwd=${pwd}&action=reset&userId=${row.id}" class="action-btn" onclick="return confirm('Reset this user to pending?')" title="Reset">🔄</a>
                    <a href="/admin?pwd=${pwd}&action=delete&userId=${row.id}" class="action-btn delete" onclick="return confirm('Delete this user permanently?')" title="Delete">🗑️</a>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div style="text-align: center; padding: 20px; color: #64748b; font-size: 0.8rem;">
        <p>Dream Hatcher Tech Admin Dashboard v2.0</p>
        <p>Last refreshed: ${new Date().toLocaleString('en-NG')}</p>
      </div>

      <script>
        // ============================================
        // SESSION TIMEOUT (5 minutes)
        // ============================================
        let sessionTime = 5 * 60; // 5 minutes in seconds
        let lastActivity = Date.now();

        function updateTimer() {
          const minutes = Math.floor(sessionTime / 60);
          const seconds = sessionTime % 60;
          document.getElementById('sessionTimer').textContent =
            minutes + ':' + (seconds < 10 ? '0' : '') + seconds;

          if (sessionTime <= 0) {
            document.getElementById('logoutOverlay').classList.add('active');
            return;
          }

          sessionTime--;
          setTimeout(updateTimer, 1000);
        }

        // Reset timer on activity
        document.addEventListener('mousemove', resetTimer);
        document.addEventListener('keypress', resetTimer);
        document.addEventListener('click', resetTimer);
        document.addEventListener('scroll', resetTimer);

        function resetTimer() {
          sessionTime = 5 * 60;
        }

        updateTimer();

        // ============================================
        // SEARCH FUNCTION
        // ============================================
        function searchTable() {
          const input = document.getElementById('searchInput').value.toLowerCase();
          const rows = document.querySelectorAll('#usersTable tbody tr');

          rows.forEach(row => {
            const searchData = row.getAttribute('data-search').toLowerCase();
            row.style.display = searchData.includes(input) ? '' : 'none';
          });
        }

        // ============================================
        // COPY TEXT
        // ============================================
        function copyText(element) {
          const text = element.textContent;
          navigator.clipboard.writeText(text).then(() => {
            const original = element.textContent;
            element.textContent = '✓ Copied!';
            element.style.color = '#10b981';
            setTimeout(() => {
              element.textContent = original;
              element.style.color = '';
            }, 1000);
          });
        }

        // ============================================
        // EXTEND MODAL
        // ============================================
        function openExtendModal(userId, username) {
          document.getElementById('extendUserId').value = userId;
          document.getElementById('extendUsername').textContent = username;
          document.getElementById('extendModal').classList.add('active');
        }

        function closeExtendModal() {
          document.getElementById('extendModal').classList.remove('active');
        }

        // Close modal on outside click
        document.getElementById('extendModal').addEventListener('click', function(e) {
          if (e.target === this) closeExtendModal();
        });

        // ============================================
        // EXPORT CSV
        // ============================================
        function exportCSV() {
          const rows = document.querySelectorAll('#usersTable tr');
          let csv = [];

          rows.forEach(row => {
            const cols = row.querySelectorAll('td, th');
            const rowData = [];
            cols.forEach((col, index) => {
              if (index < cols.length - 1) { // Skip actions column
                rowData.push('"' + col.textContent.trim().replace(/"/g, '""') + '"');
              }
            });
            csv.push(rowData.join(','));
          });

          const blob = new Blob([csv.join('\\n')], { type: 'text/csv' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'dreamhatcher_users_' + new Date().toISOString().slice(0,10) + '.csv';
          a.click();
        }
      </script>
    </body>
    </html>
    `;

    res.send(html);

  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send('Dashboard error: ' + error.message);
  }
});

// ========== CLEANUP EXPIRED USERS ==========
app.get('/admin', async (req, res, next) => {
  if (req.query.action === 'cleanup' && req.query.pwd === ADMIN_PASSWORD) {
    try {
      const result = await pool.query(`
        DELETE FROM payment_queue
        WHERE status = 'processed'
        AND (
          (plan = '24hr' AND created_at + INTERVAL '24 hours' < NOW())
          OR (plan = '7d' AND created_at + INTERVAL '7 days' < NOW())
          OR (plan = '30d' AND created_at + INTERVAL '30 days' < NOW())
        )
      `);
      // Redirect back with success message (handled by main route)
      return res.redirect('/admin?pwd=' + req.query.pwd + '&cleaned=' + result.rowCount);
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }
  next();
});

// ========== ERROR HANDLER ==========
app.use((err, req, res, next) => {
  console.error('💥 Uncaught error:', err.message);
  res.status(500).send('Server Error. Please contact support: 07037412314');
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Monnify Backend running on port ${PORT}`);
  console.log(`🌐 Monnify Pay: https://dreamhatcher-backend.onrender.com/monnify-pay/:plan`);
  console.log(`🔗 Monnify Callback: https://dreamhatcher-backend.onrender.com/monnify-callback`);
  console.log(`📨 Monnify Webhook: https://dreamhatcher-backend.onrender.com/api/monnify-webhook`);
  console.log(`👑 Admin: https://dreamhatcher-backend.onrender.com/admin?pwd=dreamhatcher2024`);
});

server.setTimeout(30000);
