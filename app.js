const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const { qrisDinamis } = require('./dinamis');

const app = express();
const port = process.env.PORT || 3002;

app.use(express.json());
app.use(cors());
app.set('trust proxy', true);

app.get('/qris/:filename', (req, res) => {
    const filePath = path.join('/tmp', req.params.filename);
    res.sendFile(filePath, err => {
        if (err) {
            res.status(404).send('File not found');
        }
    });
});

const transaksi = {};
const merchantId = 'OK2010179';
const apikey = '589503917347533522010179OKCT111616275EB7F8C048F9DD2483ACC75A';
const processedTransactions = new Set();

app.post('/api/topup', async (req, res) => {
    const { amount, username } = req.body;
    if (!amount || isNaN(amount)) return res.status(400).json({ error: 'Invalid amount' });

    const uniqueSuffix = Math.floor(1 + Math.random() * 999);
    const originalAmount = parseInt(amount);
    const uniqueAmount = originalAmount + uniqueSuffix;
    
    const id = 'XST' + Date.now();
    const startTime = Date.now();
    const expireTime = startTime + 10 * 60 * 1000;

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
        const response = await axios.get(`https://gateway.okeconnect.com/api/mutasi/qris/${merchantId}/${apikey}`);
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

function cleanupProcessedTransactions() {
    if (processedTransactions.size > 1000) {
        processedTransactions.clear();
    }
}

setInterval(cleanupProcessedTransactions, 60 * 60 * 1000);
                
app.get('/*', (req, res) => {
   res.status(404).json({ error: 'Error' });
});

if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server berjalan di http://localhost:${port}`);
    });
}

module.exports = app;
