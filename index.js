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

// Generate random password
function generatePassword(length = 8) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

// MONNIFY WEBHOOK ENDPOINT - WITH CORRECT PLAN LOGIC
app.post('/api/monnify-webhook', async (req, res) => {
  console.log('📥 Monnify webhook received:', JSON.stringify(req.body, null, 2));
  
  try {
    const { eventType, eventData } = req.body;
    
    if (eventType === 'SUCCESSFUL_TRANSACTION') {
      const customer = eventData.customer;
      const amount = parseFloat(eventData.amountPaid || eventData.amount);
      
      console.log(`💰 Payment amount: ${amount} for ${customer.email || customer.customerEmail}`);
      
      // VALIDATE AMOUNT AND ASSIGN PLAN
      let plan = '';
      if (amount >= 7500) {
        plan = '30d';
      } else if (amount >= 2400) {
        plan = '7d';
      } else if (amount >= 350) {
        plan = '24hr';
      } else {
        // Amount too low - reject
        console.error(`❌ Amount ${amount} too low for any plan`);
        return res.status(400).json({ 
          error: 'Insufficient payment',
          message: `Payment of ₦${amount} is below minimum plan price (₦350)`
        });
      }
      
      console.log(`📝 Assigned plan: ${plan} for ₦${amount}`);
      
      // Generate credentials
      const username = customer.email || customer.customerEmail || `user_${Date.now()}`;
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
      
      console.log(`✅ Payment queued: ID=${result.rows[0].id}, Plan=${plan}, Amount=₦${amount}`);
      
      return res.status(200).json({ 
        success: true, 
        message: `Payment queued for ${plan} plan`,
        plan: plan,
        amount: amount
      });
    }
    
    // For other event types
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. MIKROTIK QUEUE ENDPOINT (Mikrotik polls this)
app.get('/api/mikrotik-queue', async (req, res) => {
  // Verify API key
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey !== process.env.MIKROTIK_API_KEY) {
    console.log('❌ Invalid API key');
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  try {
    // Get pending payments
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

// 2b. MIKROTIK QUEUE (PLAIN TEXT - ROS SAFE)
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

    if (result.rows.length === 0) {
      return res.send('');
    }

    // Build plain-text response
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

// 3. MARK AS PROCESSED
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

// 4. STATUS CHECK
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

// 5. TEST ENDPOINT
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
