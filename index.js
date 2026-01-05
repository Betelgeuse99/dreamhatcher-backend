+   1 // File: index.js - PRODUCTION READY v2.0
+   2 // Fixes: Timing issues, MAC binding, aggressive keep-alive
+   3 require('dotenv').config();
+   4 const express = require('express');
+   5 const { Pool } = require('pg');
+   6 const crypto = require('crypto');
+   7 const https = require('https');
+   8 const http = require('http');
+   9 
+  10 const app = express();
+  11 app.use(express.json());
+  12 
+  13 // Database connection to Supabase
+  14 const pool = new Pool({
+  15   connectionString: process.env.DATABASE_URL,
+  16   ssl: { rejectUnauthorized: false }
+  17 });
+  18 
+  19 // ========== AGGRESSIVE KEEP ALIVE (prevents Render sleep) ==========
+  20 const BACKEND_URL = 'https://dreamhatcher-backend.onrender.com';
+  21 
+  22 function keepAlive() {
+  23   https.get(`${BACKEND_URL}/health`, (res) => {
+  24     console.log('🏓 Keep-alive ping, status:', res.statusCode);
+  25   }).on('error', (err) => {
+  26     console.log('🏓 Keep-alive error:', err.message);
+  27   });
+  28 }
+  29 
+  30 // Ping every 5 minutes (more aggressive than 14 min)
+  31 setInterval(keepAlive, 5 * 60 * 1000);
+  32 
+  33 // Also ping on startup
+  34 setTimeout(keepAlive, 10000);
+  35 
+  36 // Test database connection
+  37 pool.query('SELECT NOW()', (err, res) => {
+  38   if (err) console.error('❌ Database connection failed:', err);
+  39   else console.log('✅ Connected to Supabase at', res.rows[0].now);
+  40 });
+  41 
+  42 // Helper functions
+  43 function generatePassword(length = 8) {
+  44   return crypto.randomBytes(length).toString('hex').slice(0, length);
+  45 }
+  46 
+  47 function generateUsername() {
+  48   return 'dht_' + Date.now().toString().slice(-6) + Math.random().toString(36).slice(-2);
+  49 }
+  50 
+  51 // ========== PAYSTACK WEBHOOK ==========
+  52 app.post('/api/paystack-webhook', async (req, res) => {
+  53   console.log('📥 Paystack webhook received at', new Date().toISOString());
+  54 
+  55   try {
+  56     const { event, data } = req.body;
+  57 
+  58     if (event !== 'charge.success') {
+  59       console.log('ℹ️ Non-payment event:', event);
+  60       return res.status(200).json({ received: true });
+  61     }
+  62 
+  63     const { reference, amount, customer, metadata } = data;
+  64     const amountNaira = amount / 100;
+  65 
+  66     // Extract MAC address from metadata (CRITICAL for MAC binding)
+  67     const macAddress = metadata?.mac_address || 
+  68                        metadata?.custom_fields?.find(f => f.variable_name === 'mac_address')?.value ||
+  69                        'unknown';
+  70     const clientIP = metadata?.client_ip || 'unknown';
+  71 
+  72     console.log(`💰 Payment: ₦${amountNaira} | Ref: ${reference} | MAC: ${macAddress}`);
+  73 
+  74     // Determine plan by amount
+  75     let plan;
+  76     if (amountNaira === 350) plan = '24hr';
+  77     else if (amountNaira === 2400) plan = '7d';
+  78     else if (amountNaira === 7500) plan = '30d';
+  79     else {
+  80       console.error('❌ Invalid amount:', amountNaira);
+  81       return res.status(400).json({ error: 'Invalid amount' });
+  82     }
+  83 
+  84     const username = generateUsername();
+  85     const password = generatePassword();
+  86 
+  87     // Insert with MAC address
+  88     await pool.query(
+  89       `INSERT INTO payment_queue
+  90        (transaction_id, customer_email, customer_phone, plan,
+  91         mikrotik_username, mikrotik_password, mac_address, client_ip, status, created_at)
+  92        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())
+  93        ON CONFLICT (transaction_id) DO UPDATE SET
+  94          mac_address = EXCLUDED.mac_address,
+  95          client_ip = EXCLUDED.client_ip`,
+  96       [
+  97         reference,
+  98         customer?.email || 'unknown@example.com',
+  99         customer?.phone || '',
+ 100         plan,
+ 101         username,
+ 102         password,
+ 103         macAddress,
+ 104         clientIP
+ 105       ]
+ 106     );
+ 107 
+ 108     console.log(`✅ Queued: ${username} | Plan: ${plan} | MAC: ${macAddress}`);
+ 109 
+ 110     return res.status(200).json({ received: true });
+ 111 
+ 112   } catch (error) {
+ 113     console.error('❌ Webhook error:', error.message);
+ 114     return res.status(500).json({ error: 'Webhook error' });
+ 115   }
+ 116 });
+ 117 
+ 118 // ========== PAYSTACK CALLBACK - SMART POLLING VERSION ==========
+ 119 app.get('/paystack-callback', (req, res) => {
+ 120   const ref = req.query.reference || req.query.trxref || req.query.transaction_id || '';
+ 121   const mac = req.query.mac || '';
+ 122   
+ 123   console.log('🔗 Callback accessed:', { ref, mac, time: new Date().toISOString() });
+ 124   
+ 125   // Send a page that polls the backend instead of fixed timer
+ 126   const html = `
+ 127 <!DOCTYPE html>
+ 128 <html>
+ 129 <head>
+ 130   <meta charset="UTF-8">
+ 131   <meta name="viewport" content="width=device-width, initial-scale=1.0">
+ 132   <title>Processing Payment - Dream Hatcher</title>
+ 133   <style>
+ 134     * { margin: 0; padding: 0; box-sizing: border-box; }
+ 135     body {
+ 136       font-family: 'Segoe UI', Arial, sans-serif;
+ 137       background: linear-gradient(135deg, #0a0e1a 0%, #1a1a2e 50%, #16213e 100%);
+ 138       min-height: 100vh;
+ 139       display: flex;
+ 140       align-items: center;
+ 141       justify-content: center;
+ 142       padding: 20px;
+ 143       color: white;
+ 144     }
+ 145     .container {
+ 146       background: rgba(255,255,255,0.05);
+ 147       backdrop-filter: blur(10px);
+ 148       padding: 40px;
+ 149       border-radius: 24px;
+ 150       max-width: 440px;
+ 151       width: 100%;
+ 152       text-align: center;
+ 153       border: 1px solid rgba(255,255,255,0.1);
+ 154       box-shadow: 0 25px 50px rgba(0,0,0,0.5);
+ 155     }
+ 156     .success-badge {
+ 157       background: linear-gradient(135deg, #00c9ff 0%, #92fe9d 100%);
+ 158       color: #000;
+ 159       padding: 12px 30px;
+ 160       border-radius: 50px;
+ 161       font-weight: bold;
+ 162       display: inline-block;
+ 163       margin-bottom: 25px;
+ 164       font-size: 14px;
+ 165       letter-spacing: 0.5px;
+ 166     }
+ 167     h2 { 
+ 168       color: #00d4ff; 
+ 169       margin-bottom: 10px;
+ 170       font-size: 1.5rem;
+ 171     }
+ 172     .subtitle {
+ 173       color: #94a3b8;
+ 174       margin-bottom: 30px;
+ 175       font-size: 0.95rem;
+ 176     }
+ 177     .spinner-container {
+ 178       position: relative;
+ 179       width: 100px;
+ 180       height: 100px;
+ 181       margin: 25px auto;
+ 182     }
+ 183     .spinner {
+ 184       border: 4px solid rgba(255,255,255,0.1);
+ 185       border-top: 4px solid #00d4ff;
+ 186       border-radius: 50%;
+ 187       width: 100px;
+ 188       height: 100px;
+ 189       animation: spin 1s linear infinite;
+ 190     }
+ 191     .spinner-icon {
+ 192       position: absolute;
+ 193       top: 50%;
+ 194       left: 50%;
+ 195       transform: translate(-50%, -50%);
+ 196       font-size: 32px;
+ 197     }
+ 198     @keyframes spin {
+ 199       0% { transform: rotate(0deg); }
+ 200       100% { transform: rotate(360deg); }
+ 201     }
+ 202     .status-box {
+ 203       background: rgba(0,0,0,0.3);
+ 204       border-radius: 16px;
+ 205       padding: 20px;
+ 206       margin: 25px 0;
+ 207     }
+ 208     .status-text {
+ 209       font-size: 1rem;
+ 210       margin-bottom: 10px;
+ 211       min-height: 24px;
+ 212     }
+ 213     .status-detail {
+ 214       font-size: 0.85rem;
+ 215       color: #64748b;
+ 216     }
+ 217     .steps {
+ 218       text-align: left;
+ 219       background: rgba(0,0,0,0.2);
+ 220       padding: 20px;
+ 221       border-radius: 12px;
+ 222       margin: 20px 0;
+ 223     }
+ 224     .step {
+ 225       padding: 10px 0;
+ 226       display: flex;
+ 227       align-items: center;
+ 228       gap: 12px;
+ 229       font-size: 0.9rem;
+ 230     }
+ 231     .step-icon {
+ 232       width: 28px;
+ 233       height: 28px;
+ 234       border-radius: 50%;
+ 235       display: flex;
+ 236       align-items: center;
+ 237       justify-content: center;
+ 238       font-size: 12px;
+ 239       flex-shrink: 0;
+ 240       font-weight: bold;
+ 241     }
+ 242     .step-waiting { background: rgba(255,255,255,0.1); color: #64748b; }
+ 243     .step-active { background: #00d4ff; color: #000; animation: pulse 1.5s infinite; }
+ 244     .step-done { background: #10b981; color: #fff; }
+ 245     .step-error { background: #ef4444; color: #fff; }
+ 246     @keyframes pulse {
+ 247       0%, 100% { opacity: 1; transform: scale(1); }
+ 248       50% { opacity: 0.7; transform: scale(0.95); }
+ 249     }
+ 250     .ref-box {
+ 251       background: rgba(0,0,0,0.3);
+ 252       padding: 12px 16px;
+ 253       border-radius: 8px;
+ 254       font-size: 11px;
+ 255       margin-top: 20px;
+ 256       word-break: break-all;
+ 257       color: #64748b;
+ 258     }
+ 259     .warning {
+ 260       background: rgba(245,158,11,0.15);
+ 261       border: 1px solid rgba(245,158,11,0.3);
+ 262       padding: 15px;
+ 263       border-radius: 12px;
+ 264       margin-top: 20px;
+ 265       font-size: 0.85rem;
+ 266       color: #fbbf24;
+ 267     }
+ 268     .error-box {
+ 269       background: rgba(239,68,68,0.15);
+ 270       border: 1px solid rgba(239,68,68,0.3);
+ 271       padding: 20px;
+ 272       border-radius: 12px;
+ 273       margin-top: 20px;
+ 274       display: none;
+ 275     }
+ 276     .error-box h3 { color: #ef4444; margin-bottom: 10px; }
+ 277     .error-box p { font-size: 0.9rem; color: #fca5a5; }
+ 278     .retry-btn {
+ 279       background: linear-gradient(135deg, #00c9ff, #0066ff);
+ 280       color: white;
+ 281       border: none;
+ 282       padding: 12px 30px;
+ 283       border-radius: 8px;
+ 284       font-size: 1rem;
+ 285       font-weight: 600;
+ 286       cursor: pointer;
+ 287       margin-top: 15px;
+ 288     }
+ 289     .retry-btn:hover { opacity: 0.9; }
+ 290     .credentials-box {
+ 291       background: linear-gradient(135deg, #10b981, #059669);
+ 292       padding: 25px;
+ 293       border-radius: 16px;
+ 294       margin: 20px 0;
+ 295       display: none;
+ 296     }
+ 297     .credentials-box h3 { margin-bottom: 15px; color: white; }
+ 298     .credential {
+ 299       background: rgba(255,255,255,0.95);
+ 300       color: #000;
+ 301       padding: 12px 16px;
+ 302       border-radius: 8px;
+ 303       margin: 8px 0;
+ 304       font-family: 'Courier New', monospace;
+ 305       font-size: 1.1rem;
+ 306       font-weight: bold;
+ 307       cursor: pointer;
+ 308       transition: transform 0.2s;
+ 309     }
+ 310     .credential:hover { transform: scale(1.02); }
+ 311     .credential-label {
+ 312       font-size: 0.75rem;
+ 313       color: rgba(255,255,255,0.8);
+ 314       margin-bottom: 4px;
+ 315       text-transform: uppercase;
+ 316       letter-spacing: 1px;
+ 317     }
+ 318     .connect-instructions {
+ 319       background: rgba(0,0,0,0.3);
+ 320       padding: 20px;
+ 321       border-radius: 12px;
+ 322       margin-top: 20px;
+ 323       text-align: left;
+ 324       display: none;
+ 325     }
+ 326     .connect-instructions h4 { margin-bottom: 15px; color: #00d4ff; }
+ 327     .connect-instructions ol { padding-left: 20px; }
+ 328     .connect-instructions li { margin: 8px 0; font-size: 0.9rem; }
+ 329   </style>
+ 330 </head>
+ 331 <body>
+ 332   <div class="container">
+ 333     <div class="success-badge" id="badge">✓ PAYMENT RECEIVED</div>
+ 334     
+ 335     <h2 id="title">Creating Your Account</h2>
+ 336     <p class="subtitle" id="subtitle">Please wait while we set up your WiFi access...</p>
+ 337     
+ 338     <div class="spinner-container" id="spinnerContainer">
+ 339       <div class="spinner"></div>
+ 340       <div class="spinner-icon">⚡</div>
+ 341     </div>
+ 342     
+ 343     <div class="status-box">
+ 344       <p class="status-text" id="statusText">Connecting to server...</p>
+ 345       <p class="status-detail" id="statusDetail">Attempt 1 of 40</p>
+ 346     </div>
+ 347     
+ 348     <div class="steps" id="stepsContainer">
+ 349       <div class="step">
+ 350         <div class="step-icon step-active" id="step1">1</div>
+ 351         <span id="step1text">Waiting for payment confirmation...</span>
+ 352       </div>
+ 353       <div class="step">
+ 354         <div class="step-icon step-waiting" id="step2">2</div>
+ 355         <span id="step2text">Creating WiFi credentials...</span>
+ 356       </div>
+ 357       <div class="step">
+ 358         <div class="step-icon step-waiting" id="step3">3</div>
+ 359         <span id="step3text">Activating on router...</span>
+ 360       </div>
+ 361       <div class="step">
+ 362         <div class="step-icon step-waiting" id="step4">4</div>
+ 363         <span id="step4text">Ready to connect!</span>
+ 364       </div>
+ 365     </div>
+ 366     
+ 367     <div class="credentials-box" id="credentialsBox">
+ 368       <h3>🎉 Your WiFi Login</h3>
+ 369       <div class="credential-label">Username</div>
+ 370       <div class="credential" id="usernameDisplay" onclick="copyToClipboard(this)">---</div>
+ 371       <div class="credential-label">Password</div>
+ 372       <div class="credential" id="passwordDisplay" onclick="copyToClipboard(this)">---</div>
+ 373       <div class="credential-label">Plan</div>
+ 374       <div class="credential" id="planDisplay" style="font-size: 0.9rem;">---</div>
+ 375     </div>
+ 376     
+ 377     <div class="connect-instructions" id="instructions">
+ 378       <h4>📶 How to Connect</h4>
+ 379       <ol>
+ 380         <li>Disconnect from current WiFi</li>
+ 381         <li>Connect to <strong>Dream Hatcher WiFi</strong></li>
+ 382         <li>Login page will open automatically</li>
+ 383         <li>Enter your username and password</li>
+ 384         <li>Enjoy high-speed internet!</li>
+ 385       </ol>
+ 386     </div>
+ 387     
+ 388     <div class="warning" id="warningBox">
+ 389       ⚠️ <strong>Please don't close this page!</strong><br>
+ 390       Your account is being created. This may take up to 2 minutes.
+ 391     </div>
+ 392     
+ 393     <div class="error-box" id="errorBox">
+ 394       <h3>⏳ Taking Longer Than Expected</h3>
+ 395       <p id="errorText">Your payment was received but account creation is delayed. Please try again or contact support.</p>
+ 396       <button class="retry-btn" onclick="startPolling()">🔄 Try Again</button>
+ 397     </div>
+ 398     
+ 399     <div class="ref-box">
+ 400       Reference: <strong id="refDisplay">${ref || 'Loading...'}</strong>
+ 401     </div>
+ 402   </div>
+ 403   
+ 404   <script>
+ 405     const reference = '${ref}';
+ 406     const API_BASE = '';  // Same origin
+ 407     let pollCount = 0;
+ 408     const maxPolls = 40;  // 40 attempts x 3 seconds = 2 minutes max
+ 409     let isPolling = false;
+ 410     let credentials = null;
+ 411     
+ 412     function updateStep(num, state, text) {
+ 413       const icon = document.getElementById('step' + num);
+ 414       const textEl = document.getElementById('step' + num + 'text');
+ 415       icon.className = 'step-icon step-' + state;
+ 416       if (state === 'done') icon.textContent = '✓';
+ 417       if (text) textEl.textContent = text;
+ 418     }
+ 419     
+ 420     function showCredentials(data) {
+ 421       credentials = data;
+ 422       
+ 423       // Update UI
+ 424       document.getElementById('spinnerContainer').style.display = 'none';
+ 425       document.getElementById('stepsContainer').style.display = 'none';
+ 426       document.getElementById('warningBox').style.display = 'none';
+ 427       document.getElementById('badge').textContent = '🎉 ACCOUNT READY';
+ 428       document.getElementById('badge').style.background = 'linear-gradient(135deg, #10b981, #059669)';
+ 429       document.getElementById('title').textContent = 'You\\'re All Set!';
+ 430       document.getElementById('subtitle').textContent = 'Your WiFi credentials are ready';
+ 431       document.getElementById('statusText').textContent = 'Account activated successfully!';
+ 432       document.getElementById('statusDetail').textContent = 'You can now connect to WiFi';
+ 433       
+ 434       // Show credentials
+ 435       document.getElementById('usernameDisplay').textContent = data.username;
+ 436       document.getElementById('passwordDisplay').textContent = data.password;
+ 437       document.getElementById('planDisplay').textContent = formatPlan(data.plan);
+ 438       document.getElementById('credentialsBox').style.display = 'block';
+ 439       document.getElementById('instructions').style.display = 'block';
+ 440     }
+ 441     
+ 442     function formatPlan(plan) {
+ 443       const plans = { '24hr': '24 Hours Access', '7d': '7 Days Access', '30d': '30 Days Access' };
+ 444       return plans[plan] || plan;
+ 445     }
+ 446     
+ 447     function showError(message) {
+ 448       document.getElementById('spinnerContainer').style.display = 'none';
+ 449       document.getElementById('warningBox').style.display = 'none';
+ 450       document.getElementById('errorText').textContent = message;
+ 451       document.getElementById('errorBox').style.display = 'block';
+ 452     }
+ 453     
+ 454     function copyToClipboard(element) {
+ 455       const text = element.textContent;
+ 456       navigator.clipboard.writeText(text).then(() => {
+ 457         const original = element.textContent;
+ 458         element.textContent = '✓ Copied!';
+ 459         element.style.background = '#10b981';
+ 460         element.style.color = 'white';
+ 461         setTimeout(() => {
+ 462           element.textContent = original;
+ 463           element.style.background = '';
+ 464           element.style.color = '';
+ 465         }, 1500);
+ 466       });
+ 467     }
+ 468     
+ 469     async function checkStatus() {
+ 470       if (!reference) {
+ 471         showError('No payment reference found. Please contact support with your payment receipt.');
+ 472         return;
+ 473       }
+ 474       
+ 475       pollCount++;
+ 476       const statusText = document.getElementById('statusText');
+ 477       const statusDetail = document.getElementById('statusDetail');
+ 478       
+ 479       statusDetail.textContent = 'Attempt ' + pollCount + ' of ' + maxPolls;
+ 480       
+ 481       try {
+ 482         const response = awaitfetch('/api/check-status?ref=' + encodeURIComponent(reference));
+ 483         const data = await response.json();
+ 484         
+ 485         console.log('Poll #' + pollCount + ':', data);
+ 486         
+ 487         if (data.ready && data.username && data.password) {
+ 488           // SUCCESS! Credentials ready
+ 489           updateStep(1, 'done', 'Payment confirmed ✓');
+ 490           updateStep(2, 'done', 'Credentials created ✓');
+ 491           updateStep(3, 'done', 'Router activated ✓');
+ 492           updateStep(4, 'done', 'Ready to connect! ✓');
+ 493           
+ 494           setTimeout(() => showCredentials(data), 500);
+ 495           return; // Stop polling
+ 496           
+ 497         } else if (data.found) {
+ 498           // Record exists but not processed yet
+ 499           if (data.status === 'pending') {
+ 500             statusText.textContent = 'Waiting for MikroTik to create your account...';
+ 501             updateStep(1, 'done', 'Payment confirmed ✓');
+ 502             updateStep(2, 'done', 'Credentials generated ✓');
+ 503             updateStep(3, 'active', 'Activating on router...');
+ 504           } else if (data.status === 'processed') {
+ 505             statusText.textContent = 'Account created! Loading credentials...';
+ 506             updateStep(1, 'done');
+ 507             updateStep(2, 'done');
+ 508             updateStep(3, 'done');
+ 509             updateStep(4, 'active');
+ 510           }
+ 511         } else {
+ 512           // No record yet - webhook hasn't arrived
+ 513           statusText.textContent = 'Waiting for payment confirmation from Paystack...';
+ 514           updateStep(1, 'active', 'Confirming payment...');
+ 515         }
+ 516         
+ 517         // Continue polling if not at max
+ 518         if (pollCount < maxPolls) {
+ 519           setTimeout(checkStatus, 3000);
+ 520         } else {
+ 521           showError('Account creation is taking longer than expected. Your payment was received - please wait a few minutes and reconnect to WiFi, or contact support: 07037412314');
+ 522         }
+ 523         
+ 524       } catch (error) {
+ 525         console.error('Poll error:', error);
+ 526         statusText.textContent = 'Connection issue, retrying...';
+ 527         
+ 528         if (pollCount < maxPolls) {
+ 529           setTimeout(checkStatus, 3000);
+ 530         } else {
+ 531           showError('Connection issues detected. Please check your network and try again, or contact support: 07037412314');
+ 532         }
+ 533       }
+ 534     }
+ 535     
+ 536     function startPolling() {
+ 537       pollCount = 0;
+ 538       document.getElementById('errorBox').style.display = 'none';
+ 539       document.getElementById('spinnerContainer').style.display = 'block';
+ 540       document.getElementById('warningBox').style.display = 'block';
+ 541       document.getElementById('stepsContainer').style.display = 'block';
+ 542       
+ 543       // Reset steps
+ 544       for (let i = 1; i <= 4; i++) {
+ 545         updateStep(i, i === 1 ? 'active' : 'waiting');
+ 546       }
+ 547       
+ 548       checkStatus();
+ 549     }
+ 550     
+ 551     // Start polling immediately
+ 552     startPolling();
+ 553   </script>
+ 554 </body>
+ 555 </html>
+ 556   `;
+ 557   
+ 558   res.send(html);
+ 559 });
+ 560 
+ 561 // ========== CHECK STATUS API ==========
+ 562 app.get('/api/check-status', async (req, res) => {
+ 563   try {
+ 564     const ref = req.query.ref || req.query.reference;
+ 565     
+ 566     if (!ref) {
+ 567       return res.json({ ready: false, found: false, message: 'No reference provided' });
+ 568     }
+ 569     
+ 570     const result = await pool.query(
+ 571       `SELECT mikrotik_username, mikrotik_password, plan, status, mac_address
+ 572        FROM payment_queue 
+ 573        WHERE transaction_id = $1 
+ 574        LIMIT 1`,
+ 575       [ref]
+ 576     );
+ 577     
+ 578     if (result.rows.length > 0) {
+ 579       const user = result.rows[0];
+ 580       
+ 581       if (user.status === 'processed') {
+ 582         return res.json({
+ 583           ready: true,
+ 584           found: true,
+ 585           username: user.mikrotik_username,
+ 586           password: user.mikrotik_password,
+ 587           plan: user.plan,
+ 588           mac: user.mac_address,
+ 589           status: 'processed'
+ 590         });
+ 591       } else {
+ 592         return res.json({
+ 593           ready: false,
+ 594           found: true,
+ 595           status: user.status,
+ 596           message: 'Account pending activation'
+ 597         });
+ 598       }
+ 599     } else {
+ 600       return res.json({ 
+ 601         ready: false,
+ 602         found: false,
+ 603         message: 'Payment not yet confirmed'
+ 604       });
+ 605     }
+ 606     
+ 607   } catch (error) {
+ 608     console.error('Check status error:', error.message);
+ 609     return res.json({ 
+ 610       ready: false, 
+ 611       found: false,
+ 612       error: 'Server error'
+ 613     });
+ 614   }
+ 615 });
+ 616 
+ 617 // ========== MIKROTIK QUEUE - WITH MAC ADDRESS ==========
+ 618 app.get('/api/mikrotik-queue-text', async (req, res) => {
+ 619   try {
+ 620     const apiKey = req.headers['x-api-key'] || req.query.api_key;
+ 621     if (apiKey !== process.env.MIKROTIK_API_KEY) {
+ 622       console.log('❌ Invalid API key');
+ 623       return res.status(403).send('FORBIDDEN');
+ 624     }
+ 625 
+ 626     const result = await pool.query(`
+ 627       SELECT id, mikrotik_username, mikrotik_password, plan, mac_address
+ 628       FROM payment_queue
+ 629       WHERE status = 'pending'
+ 630       ORDER BY created_at ASC
+ 631       LIMIT 5
+ 632     `);
+ 633 
+ 634     if (result.rows.length === 0) {
+ 635       return res.send('');
+ 636     }
+ 637 
+ 638     console.log(`📤 Sending ${result.rows.length} users to MikroTik`);
+ 639     
+ 640     // Format: username|password|plan|id|mac_address
+ 641     const lines = result.rows.map(row =>
+ 642       `${row.mikrotik_username}|${row.mikrotik_password}|${row.plan}|${row.id}|${row.mac_address || 'none'}`
+ 643     );
+ 644 
+ 645     res.set('Content-Type', 'text/plain');
+ 646     res.send(lines.join('\n'));
+ 647     
+ 648   } catch (error) {
+ 649     console.error('❌ Queue error:', error.message);
+ 650     res.status(500).send('ERROR');
+ 651   }
+ 652 });
+ 653 
+ 654 // ========== MARK PROCESSED ==========
+ 655 app.post('/api/mark-processed/:id', async (req, res) => {
+ 656   try {
+ 657     await pool.query(
+ 658       `UPDATE payment_queue SET status = 'processed', processed_at = NOW() WHERE id = $1`,
+ 659       [req.params.id]
+ 660     );
+ 661     console.log(`✅ Marked ${req.params.id} as processed`);
+ 662     res.json({ success: true });
+ 663   } catch (error) {
+ 664     console.error('❌ Update error:', error.message);
+ 665     res.status(500).json({ error: 'Update failed' });
+ 666   }
+ 667 });
+ 668 
+ 669 // ========== HEALTH CHECK ==========
+ 670 app.get('/health', async (req, res) => {
+ 671   try {
+ 672     const dbResult = await pool.query('SELECT NOW()');
+ 673     const queueResult = await pool.query(`
+ 674       SELECT 
+ 675         COUNT(*) FILTER (WHERE status = 'pending') as pending,
+ 676         COUNT(*) FILTER (WHERE status = 'processed') as processed,
+ 677         COUNT(*) as total
+ 678       FROM payment_queue
+ 679     `);
+ 680     
+ 681     res.json({ 
+ 682       status: 'OK', 
+ 683       timestamp: new Date().toISOString(),
+ 684       database: 'connected',
+ 685       db_time: dbResult.rows[0].now,
+ 686       queue: queueResult.rows[0],
+ 687       uptime_seconds: Math.floor(process.uptime())
+ 688     });
+ 689   } catch (error) {
+ 690     res.status(500).json({ 
+ 691       status: 'ERROR', 
+ 692       error: error.message 
+ 693     });
+ 694   }
+ 695 });
+ 696 
+ 697 // ========== ROOT PAGE ==========
+ 698 app.get('/', (req, res) => {
+ 699   res.send(`
+ 700     <!DOCTYPE html>
+ 701     <html>
+ 702     <head>
+ 703       <title>Dream Hatcher Tech Backend</title>
+ 704       <meta name="viewport" content="width=device-width, initial-scale=1.0">
+ 705       <style>
+ 706         body { font-family: 'Segoe UI', Arial; padding: 20px; background: #0a0e1a; color: white; }
+ 707         .card { background: rgba(255,255,255,0.05); padding: 20px; border-radius: 12px; margin: 15px 0; border: 1px solid rgba(255,255,255,0.1); }
+ 708         h1 { color: #00d4ff; }
+ 709         .btn { display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #00c9ff, #0066ff); color: white; text-decoration: none; border-radius: 8px; margin: 5px; font-weight: bold; }
+ 710         code { background: rgba(0,0,0,0.3); padding: 3px 8px; border-radius: 4px; }
+ 711         ul { line-height: 2; }
+ 712       </style>
+ 713     </head>
+ 714     <body>
+ 715       <h1>🌐 Dream Hatcher Tech Backend</h1>
+ 716       <div class="card">
+ 717         <h3>✅ Server Status: Running</h3>
+ 718         <p>Uptime: ${Math.floor(process.uptime())} seconds</p>
+ 719         <a href="/health" class="btn">Health Check</a>
+ 720       </div>
+ 721       <div class="card">
+ 722         <h3>📊 API Endpoints</h3>
+ 723         <ul>
+ 724           <li><code>POST</code> /api/paystack-webhook - Paystack webhook (receives MAC in metadata)</li>
+ 725           <li><code>GET</code> /paystack-callback - Payment callback page (smart polling)</li>
+ 726           <li><code>GET</code> /api/check-status - Check payment/account status</li>
+ 727           <li><code>GET</code> /api/mikrotik-queue-text - MikroTik queue (includes MAC)</li>
+ 728           <li><code>POST</code> /api/mark-processed/:id - Mark user as processed</li>
+ 729         </ul>
+ 730       </div>
+ 731       <div class="card">
+ 732         <h3>📞 Support</h3>
+ 733         <p>07037412314</p>
+ 734       </div>
+ 735     </body>
+ 736     </html>
+ 737   `);
+ 738 });
+ 739 
+ 740 // ========== ERROR HANDLER ==========
+ 741 app.use((err, req, res, next) => {
+ 742   console.error('💥 Uncaught error:', err.message);
+ 743   res.status(500).send('Server Error. Please contact support: 07037412314');
+ 744 });
+ 745 
+ 746 // ========== START SERVER ==========
+ 747 const PORT = process.env.PORT || 10000;
+ 748 const server = app.listen(PORT, () => {
+ 749   console.log(`🚀 Backend v2.0 running on port ${PORT}`);
+ 750   console.log(`🌐 URL: ${BACKEND_URL}`);
+ 751   console.log(`✅ Ready to receive payments!`);
+ 752 });
+ 753 
+ 754 server.setTimeout(120000); // 2 min timeout
+ 755 server.keepAliveTimeout = 120000;
