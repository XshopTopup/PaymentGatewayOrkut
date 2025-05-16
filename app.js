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
const usedAmounts = new Map(); // Menyimpan uniqueAmount dan waktu pembuatannya
const transactionIdCounters = new Map(); // Menyimpan counter ID per hari
const merchantId = 'OK2010179';
const apikey = '642611917473311022010179OKCT01251A5A297AF4EEB7FC7CC7BFA2683C';
const processedTransactions = new Set();
let lastApiResponse = null; // Cache untuk respons API terakhir
let lastApiFetchTime = 0; // Waktu terakhir pengambilan API

app.post('/api/topup', async (req, res) => {
    const { amount, username } = req.body;
    if (!amount || isNaN(amount) || amount <= 0 || !Number.isInteger(Number(amount))) {
        return res.status(400).json({ error: 'Invalid amount: must be a positive integer' });
    }

    const originalAmount = parseInt(amount);
    let uniqueSuffix;
    let uniqueAmount;
    const maxAttempts = 999;
    let attempts = 0;

    // Cari suffix yang belum digunakan
    const now = Date.now();
    const dayStart = now - (now % (24 * 60 * 60 * 1000));
    while (attempts < maxAttempts) {
        uniqueSuffix = Math.floor(1 + Math.random() * 999);
        uniqueAmount = originalAmount + uniqueSuffix;
        if (!usedAmounts.has(uniqueAmount) || usedAmounts.get(uniqueAmount).dayStart !== dayStart) {
            usedAmounts.set(uniqueAmount, { dayStart, createdAt: now });
            break;
        }
        attempts++;
    }

    if (attempts >= maxAttempts) {
        return res.status(429).json({ error: 'No unique amount available. Try again later.' });
    }

    // Generate Transaction ID
    const dayKey = `TRX${dayStart}`;
    let counter = transactionIdCounters.get(dayKey) || 0;
    counter += 1;
    transactionIdCounters.set(dayKey, counter);
    const id = `${dayKey}${counter.toString().padStart(3, '0')}`; // Contoh: XST<timestamp>000001

    const startTime = Date.now();
    const expireTime = startTime + 10 * 60 * 1000;

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
        console.error('Error generating QRIS:', err);
        usedAmounts.delete(uniqueAmount);
        transactionIdCounters.set(dayKey, counter - 1); // Rollback counter
        res.status(500).json({ error: 'Failed to generate QRIS' });
    }
});

app.get('/api/check-payment/:id', async (req, res) => {
    const { id } = req.params;
    const trx = transaksi[id];
    if (!trx) return res.status(404).json({ error: 'Transaction not found' });

    const qrisFile = path.join('/tmp', `${trx.qris}.jpg`);

    if (trx.paid) {
        try { fs.unlinkSync(qrisFile); } catch {}
        delete transaksi[id];
        usedAmounts.delete(trx.uniqueAmount);
        return res.json({ status: 'paid' });
    }

    if (Date.now() > trx.expireTime) {
        try { fs.unlinkSync(qrisFile); } catch {}
        delete transaksi[id];
        usedAmounts.delete(trx.uniqueAmount);
        return res.json({ status: 'expired' });
    }

    try {
        const now = Date.now();
        const cacheDuration = 30 * 1000; // Cache selama 30 detik
        let txList;

        // Gunakan cache jika masih valid
        if (lastApiResponse && now - lastApiFetchTime < cacheDuration) {
            txList = lastApiResponse;
        } else {
            const response = await axios.get(`https://gateway.okeconnect.com/api/mutasi/qris/${merchantId}/${apikey}`);
            txList = response.data.data.slice(0, 10); // Kurangi jumlah transaksi yang diambil
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

        if (matchedTx) {
            processedTransactions.add(matchedTx.issuer_reff);
            trx.paid = true;

            try { fs.unlinkSync(qrisFile); } catch {}
            delete transaksi[id];
            usedAmounts.delete(trx.uniqueAmount);

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
        console.error('Error checking payment:', err);
        res.status(500).json({ error: 'Failed to check payment status' });
    }
});

function cleanupExpiredData() {
    const now = Date.now();
    const dayStart = now - (now % (24 * 60 * 60 * 1000));

    // Bersihkan transaksi kadaluarsa
    Object.keys(transaksi).forEach(id => {
        const trx = transaksi[id];
        if (now > trx.expireTime) {
            const qrisFile = path.join('/tmp', `${trx.qris}.jpg`);
            try { fs.unlinkSync(qrisFile); } catch {}
            delete transaksi[id];
            usedAmounts.delete(trx.uniqueAmount);
            console.log(`Cleaned expired transaction: ${id}`);
        }
    });

    // Bersihkan usedAmounts yang lebih lama dari 24 jam
    for (const [amount, { createdAt }] of usedAmounts) {
        if (now - createdAt > 24 * 60 * 60 * 1000) {
            usedAmounts.delete(amount);
            console.log(`Cleaned expired amount: ${amount}`);
        }
    }

    // Bersihkan transactionIdCounters yang lebih lama dari 24 jam
    for (const [dayKey] of transactionIdCounters) {
        const dayTimestamp = parseInt(dayKey.replace('XST', ''));
        if (now - dayTimestamp > 24 * 60 * 60 * 1000) {
            transactionIdCounters.delete(dayKey);
            console.log(`Cleaned expired counter: ${dayKey}`);
        }
    }
}

setInterval(cleanupExpiredData, 7 * 60 * 1000);

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
