const express = require('express');
const { RouterOSClient } = require('routeros-client');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Load sensitive info from environment variables
const MIKROTIK_HOST = process.env.MIKROTIK_HOST;
const MIKROTIK_USER = process.env.MIKROTIK_USER;
const MIKROTIK_PASS = process.env.MIKROTIK_PASS;

// Plan profiles (must match MikroTik profiles)
const planProfiles = {
    daily: 'daily-profile',
    weekly: 'weekly-profile',
    monthly: 'monthly-profile'
};

// Utility: generate a unique username
function generateUsername(name) {
    const clean = name.replace(/\s+/g, '').toLowerCase();
    const random = Math.floor(1000 + Math.random() * 9000);
    return `${clean}${random}`;
}

// Create a hotspot user on MikroTik
async function addHotspotUser(username, profile) {
    const client = new RouterOSClient({
        host: MIKROTIK_HOST,
        user: MIKROTIK_USER,
        password: MIKROTIK_PASS
    });

    await client.connect();
    const api = client.menu('/ip/hotspot/user');

    await api.add({
        name: username,
        password: username,
        profile: profile
    });

    await client.close();
}

// Webhook / Redirect handler
app.get('/payment-success', async (req, res) => {
    try {
        const { plan, customerName } = req.query;

        if (!plan || !planProfiles[plan]) {
            return res.status(400).send('Invalid plan specified');
        }

        // Generate a unique username
        const username = generateUsername(customerName || 'guest');

        // Create user on MikroTik
        await addHotspotUser(username, planProfiles[plan]);

        // Now redirect user to hotspot login via client browser
        // Example local hotspot login URL
        const hotspotLoginUrl = `http://dreamhatcher.login/
username=${encodeURIComponent(username)}&password=${encodeURIComponent(username)}`;

        return res.redirect(hotspotLoginUrl);

    } catch (err) {
        console.error('Error in payment-success:', err);
        return res.status(500).send('Internal server error');
    }
});

// Health check
app.get('/', (req, res) => {
    res.send('Dream Hatcher Backend with MikroTik API ready 🚀');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));