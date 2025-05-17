const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { qrisDinamis } = require('./dinamis');

const app = express();
const port = 3002;

// Configuration
const config = {
  merchantId: 'OK2010179',
  apiKey: '642611917473311022010179OKCT01251A5A297AF4EEB7FC7CC7BFA2683C',
  expiryDuration: 10 * 60 * 1000, // 10 minutes
  maxActiveTransactionsPerUser: 1,
  maxGlobalActiveUsers: 5,
  userRequestDelay: 10 * 1000, // 10 seconds
  apiCacheDuration: 30 * 1000, // 30 seconds
  maxProcessedTransactions: 1000,
  cleanupInterval: 2 * 60 * 1000, // 2 minutes
  uniqueAmountMaxAttempts: 999,
  uniqueAmountRange: [1, 500] // Random suffix range for unique amounts
};

// Data structures
const transaksi = {};
const usedAmounts = new Map();
const transactionIdCounters = new Map();
const userActiveTransactions = new Map();
const globalActiveTransactions = new Set();
const processedTransactions = new Set();
const userLastRequestTime = new Map();
const requestQueue = [];
let lastApiResponse = null;
let lastApiFetchTime = 0;
let isProcessingQueue = false;

// Middleware
app.use(express.json());
app.use(cors());
app.set('trust proxy', true);
app.use(express.static(path.join(__dirname)));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/qris/:filename', (req, res) => {
  const filePath = path.join('/tmp', req.params.filename);
  res.sendFile(filePath, err => {
    if (err) {
      res.status(404).send('QR code not found');
    }
  });
});

app.post('/api/topup', (req, res) => {
  const { amount, username } = req.body;
  return new Promise((resolve, reject) => {
    requestQueue.push({ resolve, reject, request: { req, res, amount, username } });
    processQueue();
  });
});

app.get('/api/check-payment/:id', async (req, res) => {
  const { id } = req.params;
  const trx = transaksi[id];

  if (!trx) {
    return res.status(404).json({
      error: 'Transaction not found or already processed',
      status: 'invalid'
    });
  }

  const qrisFile = path.join('/tmp', `${trx.qris}.jpg`);
  const now = Date.now();

  if (trx.paid) {
    await cleanupTransaction(id, trx, qrisFile);
    return res.json({
      status: 'paid',
      expiresIn: 0,
      paymentDetails: trx.paymentDetails || {}
    });
  }

  if (now > trx.expireTime) {
    trx.status = 'expired';
    await cleanupTransaction(id, trx, qrisFile);
    return res.json({
      status: 'expired',
      expiresIn: 0
    });
  }

  try {
    const txList = await fetchTransactionList(now);
    const matchedTx = txList.find(tx => {
      const txTime = new Date(tx.date).getTime();
      const txId = tx.issuer_reff;
      return (
        txTime >= trx.startTime &&
        parseInt(tx.amount) === trx.uniqueAmount &&
        !processedTransactions.has(txId)
      );
    });

    const remainingSeconds = Math.floor((trx.expireTime - now) / 1000);

    if (matchedTx) {
      processedTransactions.add(matchedTx.issuer_reff);
      trx.paid = true;
      trx.status = 'paid';
      trx.paymentDetails = {
        paymentId: matchedTx.issuer_reff,
        paymentTime: matchedTx.date,
        paymentMethod: matchedTx.brand_name,
        amount: trx.originalAmount,
        uniqueAmount: trx.uniqueAmount,
        uniqueSuffix: trx.uniqueSuffix
      };

      await cleanupTransaction(id, trx, qrisFile);
      return res.json({
        status: 'paid',
        expiresIn: 0,
        paymentDetails: trx.paymentDetails
      });
    }

    return res.json({
      status: 'pending',
      expiresIn: remainingSeconds,
      expiryStatus: remainingSeconds <= 600 ? 'expires_soon' : 'active'
    });
  } catch (err) {
    console.error(`Error checking payment for transaction ${id}:`, err.message);
    return res.status(500).json({
      error: 'Failed to check payment status',
      status: trx.status
    });
  }
});

app.get('/*', (req, res) => {
  res.status(404).json({ error: 'Page not found' });
});

// Queue processing
async function processQueue() {
  if (isProcessingQueue || requestQueue.length === 0) return;

  isProcessingQueue = true;
  const { resolve, reject, request } = requestQueue.shift();
  const { username } = request;

  try {
    const now = Date.now();
    const lastRequestTime = userLastRequestTime.get(username) || 0;
    const timeSinceLastRequest = now - lastRequestTime;
    const delayNeeded = Math.max(0, config.userRequestDelay - timeSinceLastRequest);

    if (delayNeeded > 0) {
      setTimeout(() => {
        requestQueue.unshift({ resolve, reject, request });
        isProcessingQueue = false;
        processQueue();
      }, delayNeeded);
      return;
    }

    const result = await handleTopupRequest(request);
    userLastRequestTime.set(username, now);
    resolve(result);
  } catch (err) {
    console.error(`Error processing request for user ${username}:`, err.message);
    reject(err);
  }

  isProcessingQueue = false;
  processQueue();
}

// Request handling
async function handleTopupRequest({ req, res, amount, username }) {
  try {
    // Validate request
    const validationError = validateRequest({ amount, username });
    if (validationError) {
      return res.status(400).json(validationError);
    }

    const now = Date.now();
    cleanupExpiredData();

    // Check user and global transaction limits
    const userError = await checkTransactionLimits(username, now);
    if (userError) {
      return res.status(429).json(userError);
    }

    // Generate unique amount
    const { uniqueAmount, uniqueSuffix } = await generateUniqueAmount(amount, now);
    if (!uniqueAmount) {
      return res.status(429).json({
        error: 'System busy. No unique amount available. Please try again later.',
        retryAfter: 30
      });
    }

    // Create transaction
    const { id, filename, expireTime } = await createTransaction({
      amount,
      username,
      uniqueAmount,
      uniqueSuffix,
      req,
      now
    });

    const remainingSeconds = Math.floor((expireTime - now) / 1000);
    return res.json({
      id,
      qris: `${req.protocol}://${req.get('host')}/qris/${filename}.jpg`,
      expireAt: expireTime,
      expiresIn: remainingSeconds,
      amount,
      kodeunik: uniqueSuffix,
      total: uniqueAmount,
      note: `Please transfer exactly ${uniqueAmount} for automatic verification`,
      status: 'pending',
      expiryStatus: remainingSeconds <= 600 ? 'expires_soon' : 'active'
    });
  } catch (err) {
    console.error(`Error handling topup for user ${username}:`, err.message);
    return res.status(500).json({
      error: 'Failed to generate QRIS',
      details: err.message
    });
  }
}

// Validation
function validateRequest({ amount, username }) {
  if (!amount || isNaN(amount) || amount <= 0 || !Number.isInteger(Number(amount))) {
    return { error: 'Invalid amount: must be a positive integer' };
  }
  if (!username || typeof username !== 'string' || username.length > 50 || /[^a-zA-Z0-9_-]/.test(username)) {
    return { error: 'Invalid username: must be alphanumeric, max 50 characters' };
  }
  return null;
}

// Transaction limits
async function checkTransactionLimits(username, now) {
  const activeTransactions = userActiveTransactions.get(username) || [];
  const validActiveTransactions = activeTransactions.filter(id => {
    const trx = transaksi[id];
    return trx && !trx.paid && now <= trx.expireTime;
  });

  if (validActiveTransactions.length >= config.maxActiveTransactionsPerUser) {
    const earliestExpiry = Math.min(...validActiveTransactions.map(id => transaksi[id].expireTime));
    const waitTime = Math.ceil((earliestExpiry - now) / 1000);
    return {
      error: 'Only one active deposit request allowed per user. Please wait until the current request expires.',
      waitTime
    };
  }

  const activeUsers = new Set(
    Array.from(globalActiveTransactions)
      .filter(id => {
        const trx = transaksi[id];
        return trx && !trx.paid && now <= trx.expireTime;
      })
      .map(id => transaksi[id].username)
  );

  if (activeUsers.size >= config.maxGlobalActiveUsers && !activeUsers.has(username)) {
    const earliestGlobalExpiry = Math.min(
      ...Array.from(globalActiveTransactions)
        .filter(id => transaksi[id])
        .map(id => transaksi[id].expireTime)
    );
    const waitTime = Math.ceil((earliestGlobalExpiry - now) / 1000);
    return {
      error: 'System busy. Maximum 5 users can have active deposit requests. Please try again later.',
      waitTime
    };
  }

  return null;
}

// Unique amount generation
async function generateUniqueAmount(originalAmount, now) {
  const dayStart = now - (now % (24 * 60 * 60 * 1000));
  let attempts = 0;

  while (attempts < config.uniqueAmountMaxAttempts) {
    const uniqueSuffix = Math.floor(
      config.uniqueAmountRange[0] + Math.random() * (config.uniqueAmountRange[1] - config.uniqueAmountRange[0] + 1)
    );
    const uniqueAmount = originalAmount + uniqueSuffix;
    const existing = usedAmounts.get(uniqueAmount);

    if (!existing || existing.dayStart !== dayStart || now > existing.expireTime) {
      usedAmounts.set(uniqueAmount, {
        dayStart,
        createdAt: now,
        expireTime: now + config.expiryDuration,
        reservedUntil: dayStart + 24 * 60 * 60 * 1000 // Reserve for 24 hours
      });
      return { uniqueAmount, uniqueSuffix };
    }
    attempts++;
  }
  return {};
}

// Transaction creation
async function createTransaction({ amount, username, uniqueAmount, uniqueSuffix, req, now }) {
  const dayStart = now - (now % (24 * 60 * 60 * 1000));
  const dayKey = new Date(dayStart).toISOString().slice(0, 10).replace(/-/g, '');
  let counter = transactionIdCounters.get(dayKey) || 0;
  counter += 1;
  transactionIdCounters.set(dayKey, counter);
  const id = `${dayKey}${counter.toString().padStart(4, '0')}`;

  const filename = `XST${Date.now()}`;
  const filepath = `/tmp/${filename}.jpg`;
  await qrisDinamis(uniqueAmount, filepath);

  const expireTime = now + config.expiryDuration;
  transaksi[id] = {
    originalAmount: amount,
    uniqueAmount,
    uniqueSuffix,
    startTime: now,
    expireTime,
    paid: false,
    qris: filename,
    username,
    status: 'pending'
  };

  userActiveTransactions.set(username, [...(userActiveTransactions.get(username) || []), id]);
  globalActiveTransactions.add(id);

  return { id, filename, expireTime };
}

// API fetching with retry
async function fetchTransactionList(now) {
  if (lastApiResponse && now - lastApiFetchTime < config.apiCacheDuration) {
    return lastApiResponse;
  }

  const maxRetries = 3;
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const response = await axios.get(
        `https://gateway.okeconnect.com/api/mutasi/qris/${config.merchantId}/${config.apiKey}`,
        { timeout: 5000 }
      );
      lastApiResponse = response.data.data.slice(0, 10);
      lastApiFetchTime = now;
      return lastApiResponse;
    } catch (err) {
      attempt++;
      if (attempt === maxRetries) {
        throw new Error(`API call failed after ${maxRetries} attempts: ${err.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

// Cleanup functions
async function cleanupTransaction(id, trx, qrisFile) {
  try {
    await fs.unlink(qrisFile).catch(err => {
      if (err.code !== 'ENOENT') {
        console.error(`Error deleting QRIS file ${qrisFile}:`, err.message);
      }
    });
  } catch (err) {
    console.error(`Error during cleanup for transaction ${id}:`, err.message);
  }

  if (trx.paid || Date.now() > trx.expireTime) {
    delete transaksi[id];
    if (trx.paid) {
      usedAmounts.set(trx.uniqueAmount, {
        ...usedAmounts.get(trx.uniqueAmount),
        reservedUntil: usedAmounts.get(trx.uniqueAmount).dayStart + 24 * 60 * 60 * 1000
      });
    } else {
      usedAmounts.delete(trx.uniqueAmount);
    }
    updateUserActiveTransactions(trx.username, id);
    globalActiveTransactions.delete(id);
    console.log(`Cleaned transaction ${id}, status: ${trx.paid ? 'paid' : 'expired'}`);
  }
}

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
  const dayKey = new Date(dayStart).toISOString().slice(0, 10).replace(/-/g, '');

  // Clean transactions
  Object.keys(transaksi).forEach(async id => {
    const trx = transaksi[id];
    if (!trx) return;

    if (now > trx.expireTime || trx.paid) {
      const qrisFile = path.join('/tmp', `${trx.qris}.jpg`);
      trx.status = trx.paid ? 'paid' : 'expired';
      await cleanupTransaction(id, trx, qrisFile);
    }
  });

  // Clean used amounts
  for (const [amount, { expireTime, reservedUntil, dayStart: amountDayStart }] of usedAmounts) {
    if (now > reservedUntil || amountDayStart !== dayStart) {
      usedAmounts.delete(amount);
      console.log(`Cleaned reserved amount: ${amount}`);
    }
  }

  // Clean transaction counters
  for (const [key] of transactionIdCounters) {
    const keyDate = new Date(parseInt(key.slice(0, 4)), parseInt(key.slice(4, 6)) - 1, parseInt(key.slice(6, 8)));
    if (now - keyDate.getTime() > 24 * 60 * 60 * 1000) {
      transactionIdCounters.delete(key);
      console.log(`Cleaned expired counter: ${key}`);
    }
  }

  // Clean user active transactions
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

  // Clean global active transactions
  for (const id of globalActiveTransactions) {
    const trx = transaksi[id];
    if (!trx || trx.paid || now > trx.expireTime) {
      globalActiveTransactions.delete(id);
    }
  }

  // Clean user last request times
  for (const [username, lastTime] of userLastRequestTime) {
    if (now - lastTime > config.expiryDuration) {
      userLastRequestTime.delete(username);
    }
  }

  // Filter request queue
  const filteredQueue = requestQueue.filter(({ request }) => {
    const userActive = userActiveTransactions.get(request.username) || [];
    return userActive.some(id => {
      const trx = transaksi[id];
      return trx && !trx.paid && now <= trx.expireTime;
    });
  });

  requestQueue.length = 0;
  requestQueue.push(...filteredQueue);
}

function cleanupProcessedTransactions() {
  if (processedTransactions.size > config.maxProcessedTransactions) {
    processedTransactions.clear();
    console.log('Cleared processed transactions');
  }
}

// Periodic cleanup
setInterval(cleanupExpiredData, config.cleanupInterval);
setInterval(cleanupProcessedTransactions, 60 * 60 * 1000);

// Start server
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

module.exports = app;
