// File: index.js
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

function getPlanColor(planCode) {
  switch(planCode) {
    case '24hr': return '#ff6600';
    case '7d': return '#00aa00';
    case '30d': return '#0072ff';
    default: return '#666';
  }
}

function verifyMonnifySignature(req) {
  const secret = process.env.MONNIFY_SECRET_KEY;
  const signature = req.headers['monnify-signature'];

  if (!signature || !secret) return false;

  const body = JSON.stringify(req.body);
  const computedHash = crypto
    .createHmac('sha512', secret)
    .update(body)
    .digest('hex');

  return computedHash === signature;
}

// MONNIFY WEBHOOK ENDPOINT
app.post('/api/monnify-webhook', async (req, res) => {
  if (!verifyMonnifySignature(req)) {
    console.log('❌ Invalid Monnify signature');
    return res.status(401).json({ error: 'Unauthorized webhook' });
  }

  console.log('📥 Monnify webhook received:', JSON.stringify(req.body, null, 2));

  try {
    const { eventType, eventData } = req.body;

    if (eventType !== 'SUCCESSFUL_TRANSACTION') {
      return res.status(200).json({ received: true });
    }

    const customer = eventData.customer;
    const amount = parseFloat(eventData.amountPaid || eventData.amount);

    console.log(`💰 Payment amount: ${amount} for ${customer.email || customer.customerEmail}`);

    // Strict amount validation
    let plan;
    if (amount >= 7500) plan = '30d';
    else if (amount >= 2400) plan = '7d';
    else if (amount >= 350) plan = '24hr';
    else {
      console.error(`❌ Invalid amount ₦${amount}`);
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Generate credentials
    const base = customer.email || 'user';
    const username = `${base}_${crypto.randomBytes(3).toString('hex')}`;
    const password = generatePassword();

    // Insert into payment queue
    const result = await pool.query(
      `INSERT INTO payment_queue 
       (transaction_id, customer_email, customer_phone, plan, mikrotik_username, mikrotik_password) 
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        eventData.transactionReference,
        customer.email || customer.customerEmail,
        customer.phoneNumber || customer.phone,
        plan,
        username,
        password
      ]
    );

    // Generate token
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `UPDATE payment_queue SET one_time_token=$1 WHERE id=$2`,
      [token, result.rows[0].id]
    );

    console.log(`🔑 One-time token generated: ${token}`);

    const backendUrl = process.env.BACKEND_URL || 'https://dreamhatcher-backend.onrender.com';

    return res.status(200).json({
      success: true,
      plan,
      amount,
      redirectUrl: `${backendUrl}/success?token=${token}`
    });

  } catch (error) {
    console.error('❌ Webhook error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// MIKROTIK QUEUE ENDPOINT (JSON)
app.get('/api/mikrotik-queue', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey !== process.env.MIKROTIK_API_KEY) {
    console.log('❌ Invalid API key');
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
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

// MIKROTIK QUEUE (PLAIN TEXT)
app.get('/api/mikrotik-queue-text', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey !== process.env.MIKROTIK_API_KEY) {
    console.log('❌ Invalid API key (text endpoint)');
    return res.status(403).send('FORBIDDEN');
  }

  try {
    const result = await pool.query(`
      SELECT id, mikrotik_username, mikrotik_password, plan
      FROM payment_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 5
    `);

    console.log(`📤 Sending ${result.rows.length} users to MikroTik (TEXT)`);

    if (result.rows.length === 0) return res.send('');

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

// MARK AS PROCESSED
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

// STATUS CHECK
app.get('/api/queue-status', async (req, res) => {
  const result = await pool.query(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) as processed
    FROM payment_queue
  `);
  res.json(result.rows[0]);
});

// TOKEN VALIDATION ENDPOINT
app.get('/api/validate-token/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const result = await pool.query(
      `SELECT mikrotik_username, plan
       FROM payment_queue
       WHERE one_time_token = $1
         AND status IN ('pending', 'processed')`,
      [token]
    );

    if (result.rows.length === 0)
      return res.status(400).json({ success: false, message: 'Invalid or expired token' });

    // Invalidate token after first use
    await pool.query(
      `UPDATE payment_queue SET one_time_token=NULL WHERE one_time_token=$1`,
      [token]
    );

    res.json({
      success: true,
      username: result.rows[0].mikrotik_username,
      plan: result.rows[0].plan
    });
  } catch (err) {
    console.error('❌ Token validation error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ✅ SUCCESS PAGE (SHOWS CREDENTIALS) - FIXED VERSION
app.get('/success', async (req, res) => {
  const { token } = req.query;
  
  if (!token) {
    return res.status(400).send(`
      <h2>Missing Token</h2>
      <p>Invalid access. Please contact support.</p>
    `);
  }
  
  try {
    // ✅ FIXED: Proper SQL query with parameter
    const result = await pool.query(
      `SELECT mikrotik_username, mikrotik_password, plan 
       FROM payment_queue 
       WHERE one_time_token=$1 AND status IN ('pending', 'processed')`,
      [token]
    );
    
    if (result.rows.length === 0) {
      return res.status(400).send(`
        <h2>Invalid Token</h2>
        <p>Token expired or already used. Please contact support.</p>
      `);
    }
    
    const { mikrotik_username, mikrotik_password, plan } = result.rows[0];
    const planDuration = getPlanDuration(plan);
    
    // Generate HTML success page
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Payment Successful - Dream Hatcher Tech</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body {
          font-family: 'Segoe UI', Arial, sans-serif;
          background: linear-gradient(135deg, #0f2027, #203a43, #2c5364);
          min-height: 100vh;
          display: flex;
          justify-content: center;
          align-items: center;
          padding: 20px;
          margin: 0;
        }
        .success-box {
          background: linear-gradient(135deg, #e6f7ff, #f0f8ff);
          padding: 40px;
          border-radius: 20px;
          box-shadow: 0 15px 35px rgba(0,0,0,0.25);
          max-width: 500px;
          width: 100%;
          text-align: center;
          border-top: 5px solid #00c6ff;
        }
        h2 { 
          color: #0072ff; 
          margin-bottom: 20px;
          font-size: 1.8rem;
        }
        .plan-badge {
          background: ${getPlanColor(plan)};
          color: white;
          padding: 8px 20px;
          border-radius: 20px;
          font-weight: bold;
          display: inline-block;
          margin: 10px 0;
        }
        .logo {
          color: #0072ff;
          font-size: 1.5rem;
          font-weight: bold;
          margin-bottom: 20px;
        }
        .credentials {
          background: white;
          padding: 20px;
          border-radius: 10px;
          margin: 25px 0;
          text-align: left;
          border: 2px solid #e6e6e6;
        }
        .cred-row {
          margin: 15px 0;
          padding: 12px;
          background: #f8f9fa;
          border-radius: 8px;
          font-size: 1rem;
        }
        .cred-label {
          font-weight: bold;
          color: #0072ff;
          display: inline-block;
          width: 100px;
        }
        .btn {
          background: linear-gradient(90deg, #00c6ff, #0072ff);
          color: white;
          border: none;
          padding: 18px 40px;
          border-radius: 10px;
          font-size: 1.2rem;
          font-weight: 700;
          cursor: pointer;
          text-decoration: none;
          display: inline-block;
          margin-top: 20px;
          box-shadow: 0 5px 15px rgba(0, 114, 255, 0.3);
          transition: all 0.3s;
        }
        .btn:hover {
          transform: translateY(-3px);
          box-shadow: 0 8px 20px rgba(0, 114, 255, 0.4);
        }
        .note {
          margin-top: 25px;
          color: #666;
          font-size: 14px;
          padding: 15px;
          background: #f0f8ff;
          border-radius: 8px;
        }
      </style>
    </head>
    <body>
      <div class="success-box">
        <div class="logo">Dream Hatcher Tech</div>
        <h2>✅ Payment Successful!</h2>
        <div class="plan-badge">${planDuration.toUpperCase()} PLAN</div>
        <p>Your WiFi access has been activated for ${planDuration}</p>
        
        <div class="credentials">
          <div class="cred-row">
            <span class="cred-label">Username:</span> ${mikrotik_username}
          </div>
          <div class="cred-row">
            <span class="cred-label">Password:</span> ${mikrotik_password}
          </div>
          <div class="cred-row">
            <span class="cred-label">Plan:</span> ${planDuration}
          </div>
        </div>
        
        <p>Click below to go to the WiFi login page:</p>
        <a href="http://dreamhatcher.login?username=${encodeURIComponent(mikrotik_username)}&password=${encodeURIComponent(mikrotik_password)}" class="btn">
          Go to WiFi Login
        </a>
        
        <div class="note">
          <strong>Note:</strong> Your credentials will be auto-filled on the login page.
          Just click "Connect to WiFi" after going to the login page.
        </div>
      </div>
    </body>
    </html>
    `;
    
    // Invalidate token after use
    await pool.query(
      `UPDATE payment_queue SET one_time_token=NULL WHERE one_time_token=$1`,
      [token]
    );
    
    console.log(`✅ Success page shown for user: ${mikrotik_username} (${planDuration})`);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
    
  } catch (error) {
    console.error('❌ Success page error:', error.message);
    res.status(500).send(`
      <h2>Server Error</h2>
      <p>Please contact support with your transaction ID.</p>
    `);
  }
});

// TEST ENDPOINT
app.get('/test', (req, res) => {
  res.json({ 
    status: 'OK', 
    backend: 'running',
    database: process.env.DATABASE_URL ? 'Connected' : 'Missing'
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});
