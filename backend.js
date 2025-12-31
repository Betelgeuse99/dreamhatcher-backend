// backend.js
const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Hotspot base URL (your browser will access this directly)
const HOTSPOT_BASE_URL = 'http://dreamhatcher.login'; // change if different

// Plan profiles (must match your MikroTik profiles)
const planProfiles = {
    daily: '24hr',
    weekly: '7d',
    monthly: '30d'
};

// Utility: generate a unique username
function generateUsername(name) {
    const clean = (name || 'guest').replace(/\s+/g, '').toLowerCase();
    const random = Math.floor(1000 + Math.random() * 9000);
    return `${clean}${random}`;
}

// Monnify redirect after successful payment
app.get('/payment-success', (req, res) => {
    try {
        const { plan, customerName } = req.query;

        if (!plan || !planProfiles[plan]) {
            return res.status(400).send('Invalid plan specified');
        }

        // Generate a unique username
        const username = generateUsername(customerName);

        // Construct MikroTik auto-login URL
        // The browser will use this URL to connect directly to your hotspot
        const hotspotLoginUrl = `${HOTSPOT_BASE_URL}?username=${encodeURIComponent(username)}&password=${encodeURIComponent(username)}&profile=${planProfiles[plan]}`;

        // Redirect user to hotspot login page
        return res.redirect(hotspotLoginUrl);

    } catch (err) {
        console.error('Error in payment-success:', err);
        return res.status(500).send('Internal server error');
    }
});

// Health check
app.get('/', (req, res) => {
    res.send('Dream Hatcher Backend ✅ Monnify ready');
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
