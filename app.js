const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { qrisDinamis } = require('./dinamis');

const app = express();
const port = process.env.PORT || 3001;

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

app.post('/api/topup', async (req, res) => {
    const { amount, username } = req.body;
    if (!amount || isNaN(amount)) return res.status(400).json({ error: 'Invalid amount' });

    const id = 'TX' + Date.now();
    const startTime = Date.now();
    const expireTime = startTime + 15 * 60 * 1000;

    try {
        const filename = `OK${Date.now()}`;
        const filepath = `/tmp/${filename}.jpg`;
        await qrisDinamis(amount, filepath);
        
        transaksi[id] = { 
            id,
            amount, 
            startTime, 
            expireTime, 
            paid: false, 
            qris: filename, 
            username,
            lastChecked: Date.now()
        };

        res.json({
            id,
            qris: `${req.protocol}://${req.get('host')}/qris/${filename}.jpg`,
            expireAt: expireTime
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
    try { fs.unlinkSync(qrisFile); } catch (e) { console.error('Error removing file:', e); }
    delete transaksi[id];
    return res.json({ status: 'payment successful' });
  }

  if (Date.now() > trx.expireTime) {
    try { fs.unlinkSync(qrisFile); } catch (e) { console.error('Error removing file:', e); }
    delete transaksi[id];
    return res.json({ status: 'expired' });
  }

  trx.lastChecked = Date.now();

  try {
    const response = await axios.get(`https://gateway.okeconnect.com/api/mutasi/qris/${merchantId}/${apikey}`);
    const txList = response.data.data.slice(0, 20);
    
    const matched = txList.find(tx => {
      const txTime = new Date(tx.date).getTime();
      
      return txTime >= trx.startTime && 
             txTime <= Date.now() && 
             parseInt(tx.amount) === parseInt(trx.amount);
             
    });

    if (matched) {
      console.log(`Payment confirmed for transaction ${id}: ${JSON.stringify(matched)}`);
      trx.paid = true;
      try { fs.unlinkSync(qrisFile); } catch (e) { console.error('Error removing file:', e); }
      delete transaksi[id];
      return res.json({ status: 'payment successful' });
    }

    return res.json({ status: 'pending' });
  } catch (err) {
    console.error(`Error checking payment for ${id}:`, err.message);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

setInterval(() => {
  const now = Date.now();
  Object.keys(transaksi).forEach(id => {
    const trx = transaksi[id];
    if (now > trx.expireTime) {
      const qrisFile = path.join('/tmp', `${trx.qris}.jpg`);
      try { fs.unlinkSync(qrisFile); } catch (e) {}
      delete transaksi[id];
      console.log(`Transaction ${id} expired and cleaned up`);
    }
  });
}, 60000);

app.get('/*', (req, res) => {
   res.status(404).json({ error: 'Error' });
});

if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server berjalan di http://localhost:${port}`);
    });
}

module.exports = app;
