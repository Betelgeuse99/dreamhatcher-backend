const express = require('express');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Plans mapping (for validation only)
const plans = ['daily', 'weekly', 'monthly'];

// REQUIRED webhook for Monnify
app.post('/monnify-webhook', (req, res) => {
    console.log('Monnify webhook received');
    res.status(200).send('OK');
});

// Redirect after payment
app.get('/payment-success', (req, res) => {
    const { plan, username } = req.query;

    if (!plan || !plans.includes(plan)) {
        return res.status(400).send('Invalid plan');
    }

    if (!username) {
        return res.status(400).send('Username missing');
    }

    // MikroTik hotspot auto-login (LOCAL)
    const hotspotLoginUrl =
        `http://dreamhatcher.login/login?username=${encodeURIComponent(username)}&password=${encodeURIComponent(username)}`;

    return res.redirect(hotspotLoginUrl);
});

// Health check
app.get('/', (req, res) => {
    res.send('Dream Hatcher backend running ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
