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
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/qris/:filename', (req, res) => {
    const filePath = path.join('/tmp', req.params.filename);
    res.sendFile(filePath, err => {
        if (err) {
            res.status(404).send('File not found');
        }
    });
});

const transaksi = {};
const usedAmounts = new Map();
const transactionIdCounters = new Map();
const userActiveTransactions = new Map();
const merchantId = 'OK2010179';
const apikey = '589503917347533522010179OKCT111616275EB7F8C048F9DD2483ACC75A';
const processedTransactions = new Set();
let lastApiResponse = null;
let lastApiFetchTime = 0;
const EXPIRY_DURATION = 10 * 60 * 1000;
const MAX_ACTIVE_TRANSACTIONS = 2; // Diubah menjadi 2 transaksi aktif per user

app.post('/api/topup', async (req, res) => {
    const { amount, username } = req.body;
    if (!amount || isNaN(amount) || amount <= 0 || !Number.isInteger(Number(amount))) {
        return res.status(400).json({ error: 'Invalid amount: must be a positive integer' });
    }
    if (!username) {
        return res.status(400).json({ error: 'Username is required' });
    }

    const activeTransactions = userActiveTransactions.get(username) || [];
    const now = Date.now();
    const validActiveTransactions = activeTransactions.filter(id => {
        const trx = transaksi[id];
        return trx && !trx.paid && now <= trx.expireTime;
    });
    
    if (validActiveTransactions.length >= MAX_ACTIVE_TRANSACTIONS) {
        const earliestExpiry = Math.min(...validActiveTransactions.map(id => transaksi[id].expireTime));
        const waitTime = Math.ceil((earliestExpiry - now) / 1000);
        return res.status(429).json({ 
            error: 'Too many active transactions. Please wait until existing transactions are paid or expired.',
            waitTime
        });
    }

    const originalAmount = parseInt(amount);
    let uniqueSuffix;
    let uniqueAmount;
    const maxAttempts = 999;
    let attempts = 0;

    const dayStart = now - (now % (24 * 60 * 60 * 1000));
    while (attempts < maxAttempts) {
        uniqueSuffix = Math.floor(1 + Math.random() * 999);
        uniqueAmount = originalAmount + uniqueSuffix;
        const existing = usedAmounts.get(uniqueAmount);
        if (!existing || existing.dayStart !== dayStart || now > existing.expireTime) {
            usedAmounts.set(uniqueAmount, { dayStart, createdAt: now, expireTime: now + EXPIRY_DURATION });
            break;
        }
        attempts++;
    }

    if (attempts >= maxAttempts) {
        return res.status(429).json({ error: 'No unique amount available. Try again later.' });
    }

    const dayKey = `TRX${dayStart}`;
    let counter = transactionIdCounters.get(dayKey) || 0;
    counter += 1;
    transactionIdCounters.set(dayKey, counter);
    const id = `${dayKey}${counter.toString().padStart(6, '0')}`;

    const startTime = now;
    const expireTime = startTime + EXPIRY_DURATION;

    try {
        const filename = `OK${Date.now()}`;
        const filepath = `/tmp/${filename}.jpg`;
        await qrisDinamis(uniqueAmount, filepath);
        
        transaksi[id] = { 
            originalAmount, 
            uniqueAmount,
            uniqueSuffix,
            startTime, 
            expireTime, 
            paid: false, 
            qris: filename,
            username
        };

        userActiveTransactions.set(username, [...validActiveTransactions, id]);

        const remainingSeconds = Math.floor((expireTime - now) / 1000);
        res.json({
            id,
            qris: `${req.protocol}://${req.get('host')}/qris/${filename}.jpg`,
            expireAt: expireTime,
            expiresIn: remainingSeconds,
            amount: originalAmount,            
            kodeunik: uniqueSuffix,
            total: uniqueAmount,
            note: `Mohon transfer tepat ${uniqueAmount} untuk verifikasi otomatis`,
            expiryStatus: remainingSeconds <= 600 ? 'expires_soon' : 'active'
        });
    } catch (err) {
        console.error('Error generating QRIS:', err);
        usedAmounts.delete(uniqueAmount);
        transactionIdCounters.set(dayKey, counter - 1);
        res.status(500).json({ error: 'Failed to generate QRIS' });
    }
});

app.get('/api/check-payment/:id', async (req, res) => {
    const { id } = req.params;
    const trx = transaksi[id];
    if (!trx) return res.status(404).json({ error: 'Transaction not found' });

    const qrisFile = path.join('/tmp', `${trx.qris}.jpg`);
    const now = Date.now();

    if (trx.paid) {
        try { fs.unlinkSync(qrisFile); } catch {}
        delete transaksi[id];
        usedAmounts.delete(trx.uniqueAmount);
        updateUserActiveTransactions(trx.username, id);
        return res.json({ status: 'paid', expiresIn: 0 });
    }

    if (now > trx.expireTime) {
        try { fs.unlinkSync(qrisFile); } catch {}
        delete transaksi[id];
        usedAmounts.delete(trx.uniqueAmount);
        updateUserActiveTransactions(trx.username, id);
        return res.json({ status: 'expired', expiresIn: 0 });
    }

    try {
        const cacheDuration = 30 * 1000;
        let txList;

        if (lastApiResponse && now - lastApiFetchTime < cacheDuration) {
            txList = lastApiResponse;
        } else {
            const response = await axios.get(`https://gateway.okeconnect.com/api/mutasi/qris/${merchantId}/${apikey}`);
            txList = response.data.data.slice(0, 10);
            lastApiResponse = txList;
            lastApiFetchTime = now;
        }
        
        const matchedTx = txList.find(tx => {
            const txTime = new Date(tx.date).getTime();
            const txId = tx.issuer_reff;
            return txTime >= trx.startTime && 
                   parseInt(tx.amount) === trx.uniqueAmount && 
                   !processedTransactions.has(txId);
        });

        const remainingSeconds = Math.floor((trx.expireTime - now) / 1000);

        if (matchedTx) {
            processedTransactions.add(matchedTx.issuer_reff);
            trx.paid = true;

            try { fs.unlinkSync(qrisFile); } catch {}
            delete transaksi[id];
            usedAmounts.delete(trx.uniqueAmount);
            updateUserActiveTransactions(trx.username, id);

            return res.json({ 
                status: 'paid',
                expiresIn: 0,
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

        return res.json({ 
            status: 'pending',
            expiresIn: remainingSeconds,
            expiryStatus: remainingSeconds <= 600 ? 'expires_soon' : 'active'
        });

    } catch (err) {
        console.error('Error checking payment:', err);
        res.status(500).json({ error: 'Failed to check payment status' });
    }
});

function updateUserActiveTransactions(username, transactionId) {
    const activeTransactions = userActiveTransactions.get(username) || [];
    const updatedTransactions = activeTransactions.filter(id => id !== transactionId);
    if (updatedTransactions.length > 0) {
        userActiveTransactions.set(username, updatedTransactions);
    } else {
        userActiveTransactions.delete(username);
    }
}

function cleanupExpiredData() {
    const now = Date.now();
    const dayStart = now - (now % (24 * 60 * 60 * 1000));

    Object.keys(transaksi).forEach(id => {
        const trx = transaksi[id];
        if (now > trx.expireTime) {
            const qrisFile = path.join('/tmp', `${trx.qris}.jpg`);
            try { fs.unlinkSync(qrisFile); } catch {}
            delete transaksi[id];
            usedAmounts.delete(trx.uniqueAmount);
            updateUserActiveTransactions(trx.username, id);
            console.log(`Cleaned expired transaction: ${id}`);
        }
    });

    for (const [amount, { expireTime }] of usedAmounts) {
        if (now > expireTime) {
            usedAmounts.delete(amount);
            console.log(`Cleaned expired amount: ${amount}`);
        }
    }

    for (const [dayKey] of transactionIdCounters) {
        const dayTimestamp = parseInt(dayKey.replace('TRX', ''));
        if (now - dayTimestamp > 24 * 60 * 60 * 1000) {
            transactionIdCounters.delete(dayKey);
            console.log(`Cleaned expired counter: ${dayKey}`);
        }
    }

    for (const [username, transactions] of userActiveTransactions) {
        const validTransactions = transactions.filter(id => {
            const trx = transaksi[id];
            return trx && !trx.paid && now <= trx.expireTime;
        });
        if (validTransactions.length > 0) {
            userActiveTransactions.set(username, validTransactions);
        } else {
            userActiveTransactions.delete(username);
        }
    }
}

setInterval(cleanupExpiredData, 2 * 60 * 1000);

function cleanupProcessedTransactions() {
    if (processedTransactions.size > 1000) {
        processedTransactions.clear();
        console.log('Cleared processed transactions');
    }
}

setInterval(cleanupProcessedTransactions, 60 * 60 * 1000);

app.get('/*', (req, res) => {
    res.status(404).json({ error: 'Halaman tidak ditemukan' });
});

if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server berjalan di http://localhost:${port}`);
    });
}

module.exports = app;
