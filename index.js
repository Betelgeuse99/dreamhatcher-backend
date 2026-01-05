<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dream Hatcher - Payment Verified</title>
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
            max-width: 450px;
            width: 100%;
            text-align: center;
            border: 1px solid rgba(255,255,255,0.1);
            box-shadow: 0 25px 50px rgba(0,0,0,0.5);
        }
        .success-badge {
            background: linear-gradient(135deg, #00c9ff 0%, #92fe9d 100%);
            color: #000;
            padding: 12px 30px;
            border-radius: 50px;
            font-weight: 800;
            display: inline-block;
            margin-bottom: 25px;
            font-size: 14px;
            letter-spacing: 0.5px;
        }
        .spinner {
            border: 4px solid rgba(255,255,255,0.1);
            border-top: 4px solid #00c9ff;
            border-radius: 50%;
            width: 80px;
            height: 80px;
            animation: spin 1.5s linear infinite;
            margin: 30px auto;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        h1 {
            font-size: 28px;
            margin-bottom: 15px;
            color: #00c9ff;
        }
        .message {
            font-size: 16px;
            line-height: 1.6;
            margin: 20px 0;
            color: #aaa;
        }
        .ref-box {
            background: rgba(0,0,0,0.3);
            padding: 15px;
            border-radius: 12px;
            margin: 25px 0;
            font-size: 14px;
            word-break: break-all;
            border: 1px solid rgba(0,201,255,0.3);
        }
        .instructions {
            text-align: left;
            background: rgba(0,0,0,0.2);
            padding: 20px;
            border-radius: 12px;
            margin: 25px 0;
            font-size: 14px;
        }
        .instructions ol {
            padding-left: 20px;
            margin: 10px 0;
        }
        .instructions li {
            margin: 8px 0;
            line-height: 1.5;
        }
        .support-box {
            background: rgba(255,200,0,0.1);
            border: 1px solid rgba(255,200,0,0.3);
            padding: 15px;
            border-radius: 12px;
            margin: 20px 0;
            font-size: 14px;
        }
        .timer {
            font-size: 36px;
            font-weight: 800;
            color: #00c9ff;
            margin: 20px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="success-badge">✅ PAYMENT VERIFIED</div>
        
        <h1>Processing Your WiFi Account</h1>
        
        <div class="spinner"></div>
        
        <div class="timer" id="timer">30</div>
        
        <p class="message" id="status-message">
            Please wait while we create your WiFi account.<br>
            This takes about <strong>30-45 seconds</strong>.
        </p>
        
        <div class="ref-box">
            <strong>Reference:</strong><br>
            <span id="ref-display">Loading...</span>
        </div>
        
        <div class="instructions">
            <h3>📋 What's happening:</h3>
            <ol>
                <li>✅ Payment received from Paystack</li>
                <li>🔄 Creating your unique WiFi credentials</li>
                <li>📡 Activating on MikroTik router</li>
                <li>🔗 Redirecting you to WiFi login</li>
            </ol>
        </div>
        
        <div class="support-box">
            <strong>⚠️ IMPORTANT:</strong><br>
            Do NOT close this page!<br>
            If it takes more than 60 seconds, contact:<br>
            <strong style="color: #00c9ff;">📞 07037412314</strong>
        </div>
    </div>

    <script>
        // Get payment reference from URL
        const urlParams = new URLSearchParams(window.location.search);
        const reference = urlParams.get('reference') || urlParams.get('trxref') || urlParams.get('transaction_id');
        const ref = reference || '';
        
        // Display reference
        if (ref) {
            document.getElementById('ref-display').textContent = ref;
        }
        
        // Timer countdown from 30
        let seconds = 30;
        const timerEl = document.getElementById('timer');
        const messageEl = document.getElementById('status-message');
        
        const countdown = setInterval(() => {
            seconds--;
            timerEl.textContent = seconds;
            
            // Update messages based on time
            if (seconds === 25) {
                messageEl.innerHTML = 'Waiting for backend server to wake up...<br><small>(This happens on first request)</small>';
            } else if (seconds === 20) {
                messageEl.innerHTML = 'Backend is starting up...<br><small>Render.com free tier takes 30-45s to cold start</small>';
            } else if (seconds === 15) {
                messageEl.innerHTML = 'Almost there! Creating your account...';
            } else if (seconds === 10) {
                messageEl.innerHTML = 'Finalizing credentials...<br><small>This is the last step</small>';
            } else if (seconds === 5) {
                messageEl.innerHTML = 'Ready! Redirecting in 5 seconds...';
            }
            
            // When timer reaches 0, redirect to Render
            if (seconds <= 0) {
                clearInterval(countdown);
                
                // Redirect to Render backend (should be awake by now)
                if (ref) {
                    window.location.href = `https://dreamhatcher-backend.onrender.com/success?reference=${encodeURIComponent(ref)}`;
                } else {
                    window.location.href = 'https://dreamhatcher-backend.onrender.com/success';
                }
            }
        }, 1000);
        
        // ALTERNATIVE: Try to ping Render backend early
        setTimeout(() => {
            // Try to wake up Render with a ping
            fetch('https://dreamhatcher-backend.onrender.com/health', {
                mode: 'no-cors',
                cache: 'no-store'
            }).catch(() => {
                // Silent fail - just trying to wake it up
            });
        }, 5000);
        
        // Backup redirect after 45 seconds regardless
        setTimeout(() => {
            if (ref) {
                window.location.href = `https://dreamhatcher-backend.onrender.com/success?reference=${encodeURIComponent(ref)}`;
            }
        }, 45000);
    </script>
</body>
</html>
