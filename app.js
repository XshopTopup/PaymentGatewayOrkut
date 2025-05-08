const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { qrisDinamis } = require('./dinamis');

const app = express();
const port = process.env.PORT || 3002;

app.use(express.json());
app.use(cors());
app.set('trust proxy', true);

// Rate limiting configuration
const RATE_LIMIT = {
  maxRequests: 2,     // Maximum 2 requests
  windowMs: 10000,    // Within 10 seconds (10,000 ms)
};

// Queue to track API requests
const requestQueue = [];

/**
 * Makes API requests while respecting rate limits
 * @param {string} url - The API endpoint URL
 * @param {Object} options - Axios request options
 * @returns {Promise} - API response
 */
async function rateLimitedRequest(url, options = {}) {
  // Clean up the queue - remove requests older than our window
  const now = Date.now();
  while (requestQueue.length > 0 && now - requestQueue[0] > RATE_LIMIT.windowMs) {
    requestQueue.shift();
  }

  // Check if we've hit the rate limit
  if (requestQueue.length >= RATE_LIMIT.maxRequests) {
    const oldestRequest = requestQueue[0];
    const timeToWait = RATE_LIMIT.windowMs - (now - oldestRequest) + 100; // Add 100ms buffer
    
    console.log(`Rate limit reached. Waiting ${timeToWait}ms before retrying...`);
    await new Promise(resolve => setTimeout(resolve, timeToWait));
    
    // Recursive call after waiting
    return rateLimitedRequest(url, options);
  }

  // Add current request timestamp to the queue
  requestQueue.push(Date.now());

  try {
    return await axios({
      url,
      ...options
    });
  } catch (error) {
    if (error.response && error.response.status === 429) {
      // Extract retry-after header or default to 10 seconds
      const retryAfter = parseInt(error.response.headers['retry-after'] || '10', 10);
      const waitTime = retryAfter * 1000;
      
      console.log(`Received 429 error. Waiting ${waitTime}ms before retrying...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      
      // Remove the failed request from queue
      requestQueue.pop();
      
      // Retry the request
      return rateLimitedRequest(url, options);
    }
    
    // Re-throw other errors
    throw error;
  }
}

// Storage for transactions
const transaksi = {};
const merchantId = 'OK2010179';
const apikey = '589503917347533522010179OKCT111616275EB7F8C048F9DD2483ACC75A';
const processedTransactions = new Set();

// Serve QRIS images
app.get('/qris/:filename', (req, res) => {
    const filePath = path.join('/tmp', req.params.filename);
    res.sendFile(filePath, err => {
        if (err) {
            res.status(404).send('File not found');
        }
    });
});

// Create a new QRIS transaction
app.post('/api/topup', async (req, res) => {
    const { amount, username } = req.body;
    if (!amount || isNaN(amount)) return res.status(400).json({ error: 'Invalid amount' });

    const uniqueSuffix = Math.floor(1 + Math.random() * 999);
    const originalAmount = parseInt(amount);
    const uniqueAmount = originalAmount + uniqueSuffix;
    
    const id = 'XST' + Date.now();
    const startTime = Date.now();
    const expireTime = startTime + 15 * 60 * 1000;

    try {
        const filename = `OK${Date.now()}`;
        const filepath = `/tmp/${filename}.jpg`;
        await qrisDinamis(uniqueAmount, filepath);
        
        transaksi[id] = { 
            originalAmount: originalAmount, 
            uniqueAmount: uniqueAmount,
            uniqueSuffix: uniqueSuffix,
            startTime, 
            expireTime, 
            paid: false, 
            qris: filename,
            username
        };

        res.json({
            id,
            qris: `${req.protocol}://${req.get('host')}/qris/${filename}.jpg`,
            expireAt: expireTime,
            amount: originalAmount,            
            kodeunik: uniqueSuffix,
            total: uniqueAmount,
            note: `Mohon transfer tepat ${uniqueAmount} untuk verifikasi otomatis`
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to generate QRIS' });
    }
});

// Check payment status
app.get('/api/check-payment/:id', async (req, res) => {
    const { id } = req.params;
    const trx = transaksi[id];
    if (!trx) return res.status(404).json({ error: 'Transaction not found' });

    const qrisFile = path.join('/tmp', `${trx.qris}.jpg`);

    if (trx.paid) {
        try { fs.unlinkSync(qrisFile); } catch {}
        delete transaksi[id];
        return res.json({ status: 'paid' });
    }

    if (Date.now() > trx.expireTime) {
        try { fs.unlinkSync(qrisFile); } catch {}
        delete transaksi[id];
        return res.json({ status: 'expired' });
    }

    try {
        // Use rate limited request instead of direct axios call
        const response = await rateLimitedRequest(
            `https://gateway.okeconnect.com/api/mutasi/qris/${merchantId}/${apikey}`
        );
        
        const txList = response.data.data.slice(0, 20);
        
        const matchedTx = txList.find(tx => {
            const txTime = new Date(tx.date).getTime();
            const txId = tx.issuer_reff;
            
            return txTime >= trx.startTime && 
                   parseInt(tx.amount) === trx.uniqueAmount && 
                   !processedTransactions.has(txId);
        });

        if (matchedTx) {
            processedTransactions.add(matchedTx.issuer_reff);
            
            trx.paid = true;

            try { fs.unlinkSync(qrisFile); } catch {}
            delete transaksi[id];

            return res.json({ 
                status: 'paid',
                paymentDetails: {
                    paymentId: matchedTx.issuer_reff,
                    paymentTime: matchedTx.date,
                    paymentMethod: matchedTx.brand_name,
                    amount: trx.originalAmount,
                    uniqueAmount: trx.uniqueAmount,
                    uniqueSuffix: trx.uniqueSuffix
                }
            });
        }

        return res.json({ status: 'pending' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to check payment status' });
    }
});

// Cleanup expired transactions
function cleanupExpiredTransactions() {
    const now = Date.now();
    Object.keys(transaksi).forEach(id => {
        const trx = transaksi[id];
        if (now > trx.expireTime) {
            const qrisFile = path.join('/tmp', `${trx.qris}.jpg`);
            try { fs.unlinkSync(qrisFile); } catch {}
            delete transaksi[id];
        }
    });
}

setInterval(cleanupExpiredTransactions, 5 * 60 * 1000);

// Cleanup processed transactions to prevent memory leaks
function cleanupProcessedTransactions() {
    if (processedTransactions.size > 1000) {
        processedTransactions.clear();
    }
}

setInterval(cleanupProcessedTransactions, 60 * 60 * 1000);

// Catch-all route
app.get('/*', (req, res) => {
   res.status(404).json({ error: 'Error' });
});

// Start server if this is the main module
if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server berjalan di http://localhost:${port}`);
    });
}

module.exports = app;
