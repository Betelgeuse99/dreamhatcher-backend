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

// 1. MONNIFY WEBHOOK ENDPOINT
app.post('/api/monnify-webhook', async (req, res) => {
  console.log('📥 Monnify webhook received');
  
  try {
    const { eventType, eventData } = req.body;
    
    if (eventType === 'SUCCESSFUL_TRANSACTION') {
      const customer = eventData.customer;
      
      // Generate credentials
      const username = customer.email || `user_${Date.now()}`;
      const password = generatePassword();
      
      // Determine plan
      let plan = '1day';
       if (amount >= 350) plan = '1day';    // Example: ₦350 = daily
      if (amount >= 2400) plan = '1week';    // Example: ₦2400 = weekly
      if (amount >= 7500) plan = '1month';   // Example: ₦7500 = monthly
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
      
      console.log(`✅ Payment queued: ID=${result.rows[0].id}`);
      
      return res.status(200).json({ 
        success: true, 
        message: 'Payment queued for activation'
      });
    }
    
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
