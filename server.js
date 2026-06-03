const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

let sock = null;
let qrCode = null;
let status = 'DISCONNECTED';

async function initWhatsApp() {
  try {
    status = 'INITIALIZING';
    const { state, saveCreds } = await useMultiFileAuthState('./whatsapp-auth');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCode = await QRCode.toDataURL(qr);
        status = 'QR_READY';
      }

      if (connection === 'close') {
        qrCode = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log('WhatsApp connection closed.', {
            reason: statusCode,
            error: lastDisconnect?.error?.message,
            shouldReconnect
        });
        
        if (shouldReconnect) {
          initWhatsApp();
        } else {
          console.log('Logged out from WhatsApp. Clearing auth state and restarting...');
          status = 'DISCONNECTED';
          sock = null;
          
          // Clear the auth folder to get a fresh QR code
          const fs = require('fs');
          if (fs.existsSync('./whatsapp-auth')) {
             fs.rmSync('./whatsapp-auth', { recursive: true, force: true });
          }
          
          // Re-initialize to get a new QR code
          initWhatsApp();
        }
      } else if (connection === 'open') {
        console.log('WhatsApp connection opened');
        status = 'CONNECTED';
        qrCode = null;
      }
    });
  } catch (error) {
    console.error('Failed to initialize WhatsApp:', error);
    status = 'ERROR';
  }
}

// Start connection
initWhatsApp();

// API Endpoints
app.get('/api/whatsapp/status', (req, res) => {
  res.json({ status, qr: qrCode });
});

app.post('/api/whatsapp/logout', async (req, res) => {
    if (sock) {
        await sock.logout();
        sock = null;
        status = 'DISCONNECTED';
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'Not connected' });
    }
});

app.post('/api/whatsapp/send', async (req, res) => {
  const { to, text } = req.body;
  if (status !== 'CONNECTED' || !sock) {
    return res.status(400).json({ error: 'WhatsApp is not connected' });
  }

  let formattedNumber = to.replace(/\D/g, '');
  if (formattedNumber.length === 10) formattedNumber = `91${formattedNumber}`;
  const jid = `${formattedNumber}@s.whatsapp.net`;

  try {
    const [result] = await sock.onWhatsApp(jid);
    if (!result?.exists) {
      return res.status(400).json({ error: `Number ${formattedNumber} is not on WhatsApp.` });
    }
    await sock.sendMessage(jid, { text });
    res.json({ success: true, jid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/notify-chat', async (req, res) => {
  const { event, data } = req.body;
  if (status !== 'CONNECTED' || !sock) {
    return res.status(400).json({ error: 'WhatsApp is not connected' });
  }

  try {
    // Basic implementation: Since we only receive the notification payload here,
    // we would ideally receive a list of phone numbers to notify.
    // For now, we will simulate the behavior and log it.
    // In production, the main Next.js backend should pass an array of phone numbers.
    const { toNumbers, senderName, content } = data;
    
    if (toNumbers && Array.isArray(toNumbers)) {
      for (const number of toNumbers) {
        let formattedNumber = number.replace(/\D/g, '');
        if (formattedNumber.length === 10) formattedNumber = `91${formattedNumber}`;
        const jid = `${formattedNumber}@s.whatsapp.net`;
        
        const [result] = await sock.onWhatsApp(jid);
        if (result?.exists) {
          await sock.sendMessage(jid, { 
            text: `*Tuition App Notification*\nYou have a new message from *${senderName}*.\n\nMessage preview: _${content}_\n\nOpen your app to reply.` 
          });
        }
      }
    } else {
      console.log('No recipient numbers provided for notification.', data);
    }
    
    res.json({ success: true, message: 'Notifications sent' });
  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`WhatsApp Microservice running on port ${PORT}`));
