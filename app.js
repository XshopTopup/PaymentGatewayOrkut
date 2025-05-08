const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const moment = require('moment-timezone');
const { qrisDinamis } = require('./dinamis');

// Set default timezone to Asia/Jakarta with Indonesian locale
moment.tz.setDefault('Asia/Jakarta').locale('id');

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

const requestQueue = [];

// Transaction storage
const transaksi = {};
const merchantId = 'OK2010179';
const apikey = '589503917347533522010179OKCT111616275EB7F8C048F9DD2483ACC75A';
const processedTransactions = new Set();
const activeDeposits = {};

/**
 * Makes a rate-limited request to the API
 */
async function rateLimitedRequest(url, options = {}) {
  // Clean up the queue - remove requests older than our window
  const now = Date.now();
  while (requestQueue.length > 0 && now - requestQueue[0] > RATE_LIMIT.windowMs) {
    requestQueue.shift();
  }

  if (requestQueue.length >= RATE_LIMIT.maxRequests) {
    const oldestRequest = requestQueue[0];
    const timeToWait = RATE_LIMIT.windowMs - (now - oldestRequest) + 100; // Add 100ms buffer
    
    console.log(`Rate limit reached. Waiting ${timeToWait}ms before retrying...`);
    await new Promise(resolve => setTimeout(resolve, timeToWait));
    
    return rateLimitedRequest(url, options);
  }
  requestQueue.push(Date.now());

  try {
    return await axios({
      url,
      ...options
    });
  } catch (error) {
    if (error.response && error.response.status === 429) {
      const retryAfter = parseInt(error.response.headers['retry-after'] || '10', 10);
      const waitTime = retryAfter * 1000;
      
      console.log(`Received 429 error. Waiting ${waitTime}ms before retrying...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      requestQueue.pop();
      return rateLimitedRequest(url, options);
    }
    throw error;
  }
}

/**
 * Generates a unique transaction ID
 */
function generateTransactionId(length) {
    const characters = '0123456789';
    let result = 'DEPO';
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

/**
 * Converts time string to milliseconds
 */
function toMs(str) {
    const parts = str.match(/(\d+)([smh])/);
    if (!parts) return 0;
    const num = parseInt(parts[1]);
    const type = parts[2];
    switch (type) {
        case 's': return num * 1000;
        case 'm': return num * 60 * 1000;
        case 'h': return num * 60 * 60 * 1000;
        default: return 0;
    }
}

/**
 * Generates a unique digit for the deposit amount
 */
function generateUniqueDigit(existingDeposits) {
    const min = 30;
    const max = 100; 
    const usedDigits = Object.values(existingDeposits).map(d => d.uniqueSuffix);

    let kodeUnik;
    let attempts = 0;
    const maxAttempts = (max - min + 1);

    do {
        kodeUnik = Math.floor(Math.random() * (max - min + 1)) + min;
        attempts++;
        if (attempts > maxAttempts) return null; 
    } while (usedDigits.includes(kodeUnik));

    return kodeUnik;
}

/**
 * Checks payment status via API
 */
async function checkPaymentStatus(amount, startTime, expireTime) {
    try {
        const now = Date.now();
        if (now > expireTime) {
            console.log("❌ QRIS expired, skip checking payment status.");
            return false;
        }

        const response = await rateLimitedRequest(
            `https://gateway.okeconnect.com/api/mutasi/qris/${merchantId}/${apikey}`
        );

        const transactions = response.data.data.slice(0, 20);

        return transactions.find(tx => {
            if (!tx || !tx.amount || !tx.date) return false;
            const txTime = new Date(tx.date).getTime();
            const txId = tx.issuer_reff;
            
            if (txTime >= startTime && 
                parseInt(tx.amount) === parseInt(amount) && 
                !processedTransactions.has(txId)) {
                
                processedTransactions.add(txId);
                return true;
            }
            return false;
        });

    } catch (error) {
        console.error("Error checking payment status:", error);
        return false;
    }
}

/**
 * Cleans up expired deposits
 */
function cleanupExpiredTransactions() {
    const now = Date.now();
    
    // Clean up expired transactions
    Object.keys(transaksi).forEach(id => {
        const trx = transaksi[id];
        if (now > trx.expireTime) {
            const qrisFile = path.join('/tmp', `${trx.qris}.jpg`);
            try { fs.unlinkSync(qrisFile); } catch {}
            delete transaksi[id];
            console.log(`⏰ Transaction ${id} automatically removed after expiration.`);
        }
    });
    
    // Clean up completed deposits after 10 minutes
    Object.keys(activeDeposits).forEach(transactionId => {
        const deposit = activeDeposits[transactionId];
        if (deposit.status === 'success' && deposit.successTime) {
            const elapsed = now - deposit.successTime;
            if (elapsed >= 10 * 60 * 1000) {
                delete activeDeposits[transactionId];
                console.log(`⏰ Deposit ${transactionId} automatically removed after 10 minutes.`);
            }
        }
    });
}

// Serve QRIS images
app.get('/qris/:filename', (req, res) => {
    const filePath = path.join('/tmp', req.params.filename);
    res.sendFile(filePath, err => {
        if (err) {
            res.status(404).send('File not found');
        }
    });
});

// Deposit endpoint
app.post('/api/deposit', async (req, res) => {
    const { amount, userId, username } = req.body;
    
    // Validate request
    if (!amount || isNaN(amount) || !userId) {
        return res.status(400).json({ 
            success: false, 
            error: 'Invalid parameters. Required: amount (number), userId (string)' 
        });
    }
    
    // Check deposit amount limits
    const nominal = parseInt(amount);
    if (isNaN(nominal) || nominal < 10000 || nominal > 499000) {
        return res.status(400).json({
            success: false,
            error: "Invalid amount. Minimum 10000, Maximum 499000."
        });
    }
    
    // Check if user has active transaction
    let hasActiveTransaction = false;
    Object.values(activeDeposits).forEach(deposit => {
        if (deposit.userId === userId && 
            (deposit.status === "pending" || deposit.status === "awaiting_payment")) {
            hasActiveTransaction = true;
        }
    });

    if (hasActiveTransaction) {
        return res.status(400).json({
            success: false,
            error: "User already has an active deposit in progress."
        });
    }

    // Generate unique code
    const kodeUnik = generateUniqueDigit(transaksi);
    if (kodeUnik === null) {
        return res.status(503).json({
            success: false,
            error: "Too many active transactions. Please try again later."
        });
    }

    // Create transaction
    const total = nominal + kodeUnik;
    const transactionId = generateTransactionId(12);
    const startTime = Date.now();
    const expireTime = startTime + toMs("10m");
    
    try {
        // Generate QRIS file
        const filename = `QRIS_${transactionId}`;
        const filepath = `/tmp/${filename}.jpg`;
        await qrisDinamis(total, filepath);
        
        // Store transaction data
        transaksi[transactionId] = { 
            originalAmount: nominal, 
            uniqueAmount: total,
            uniqueSuffix: kodeUnik,
            startTime, 
            expireTime, 
            paid: false, 
            qris: filename,
            userId,
            username
        };
        
        // Store in active deposits
        activeDeposits[transactionId] = {
            ID: transactionId,
            userId: userId,
            username: username,
            status: "awaiting_payment",
            date: moment().format('DD MMMM YYYY'),
            amount: nominal,
            kodeUnik: kodeUnik,
            total: total,
            startTime: startTime,
            expireTime: expireTime
        };
        
        res.json({
            success: true,
            data: {
                id: transactionId,
                qris: `${req.protocol}://${req.get('host')}/qris/${filename}.jpg`,
                expireAt: expireTime,
                amount: nominal,            
                kodeUnik: kodeUnik,
                total: total,
                note: `Please transfer exactly ${total} for automatic verification`
            }
        });
    } catch (err) {
        console.error("Error creating deposit:", err);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to generate QRIS' 
        });
    }
});

// Check payment status endpoint
app.get('/api/check-payment/:id', async (req, res) => {
    const { id } = req.params;
    const trx = transaksi[id];
    const deposit = activeDeposits[id];
    
    if (!trx || !deposit) {
        return res.status(404).json({ 
            success: false, 
            error: 'Transaction not found' 
        });
    }

    // Check if already paid
    if (trx.paid || deposit.status === 'success') {
        try { 
            const qrisFile = path.join('/tmp', `${trx.qris}.jpg`);
            fs.unlinkSync(qrisFile); 
        } catch {}
        
        return res.json({ 
            success: true,
            status: 'paid',
            data: {
                transactionId: id,
                amount: trx.originalAmount,
                uniqueAmount: trx.uniqueAmount,
                uniqueSuffix: trx.uniqueSuffix,
                userId: trx.userId,
                username: trx.username,
                paidAt: deposit.paidAt || Date.now()
            }
        });
    }

    // Check if expired
    if (Date.now() > trx.expireTime) {
        try { 
            const qrisFile = path.join('/tmp', `${trx.qris}.jpg`);
            fs.unlinkSync(qrisFile); 
        } catch {}
        
        delete transaksi[id];
        delete activeDeposits[id];
        
        return res.json({ 
            success: true,
            status: 'expired' 
        });
    }

    try {
        // Check payment status
        const paymentResult = await checkPaymentStatus(
            trx.uniqueAmount, 
            trx.startTime, 
            trx.expireTime
        );
        
        if (paymentResult) {
            // Mark as paid
            trx.paid = true;
            deposit.status = 'success';
            deposit.successTime = Date.now();
            deposit.paidAt = paymentResult.date;
            deposit.paymentMethod = paymentResult.brand_name;
            deposit.paymentId = paymentResult.issuer_reff;
            
            // Delete QRIS file
            try { 
                const qrisFile = path.join('/tmp', `${trx.qris}.jpg`);
                fs.unlinkSync(qrisFile); 
            } catch {}
            
            delete transaksi[id];

            return res.json({ 
                success: true,
                status: 'paid',
                data: {
                    transactionId: id,
                    amount: trx.originalAmount,
                    uniqueAmount: trx.uniqueAmount,
                    uniqueSuffix: trx.uniqueSuffix,
                    userId: trx.userId,
                    username: trx.username,
                    paymentId: paymentResult.issuer_reff,
                    paymentTime: paymentResult.date,
                    paymentMethod: paymentResult.brand_name
                }
            });
        }

        return res.json({ 
            success: true,
            status: 'pending' 
        });

    } catch (err) {
        console.error("Error checking payment status:", err);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to check payment status' 
        });
    }
});

// Run cleanup tasks
setInterval(cleanupExpiredTransactions, 60 * 1000); // Every minute

// Clean up the processedTransactions set periodically
setInterval(() => {
    if (processedTransactions.size > 1000) {
        processedTransactions.clear();
        console.log("Cleared processed transactions history");
    }
}, 60 * 60 * 1000); // Every hour

// Catch-all route
app.get('/*', (req, res) => {
   res.status(404).json({ success: false, error: 'Endpoint not found' });
});

if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server running on http://localhost:${port}`);
    });
}

module.exports = app;
