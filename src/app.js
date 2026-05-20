require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { logger } = require('./utils/logger');

const app = express();
const httpServer = createServer(app);

// Socket.IO pour les notifications temps réel
const io = new Server(httpServer, {
  cors: { origin: process.env.CLIENT_URL, methods: ['GET', 'POST'] }
});
app.set('io', io);

// ─── Middleware globaux ────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));
const originesAutorisees = process.env.CLIENT_URL
  ? process.env.CLIENT_URL.split(',').map((o) => o.trim())
  : true;
app.use(cors({ origin: originesAutorisees, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Trop de tentatives, réessayez dans 15 minutes.' }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 200 }));

// Logger des requêtes
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`, { ip: req.ip });
  next();
});

// ─── Routes ───────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/tontines', require('./routes/tontines'));
app.use('/api/tontines', require('./routes/membres'));
app.use('/api/tontines', require('./routes/sessions'));
app.use('/api/tontines', require('./routes/paiements'));
app.use('/api/tontines', require('./routes/emprunts'));
app.use('/api/tontines', require('./routes/litiges'));
app.use('/api/tontines', require('./routes/messages'));
app.use('/api/tontines', require('./routes/echanges'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/exports', require('./routes/exports'));

// Santé de l'API
app.get('/api/health', (_req, res) => res.json({ statut: 'ok', heure: new Date().toISOString() }));

// Gestion des erreurs 404
app.use((_req, res) => res.status(404).json({ erreur: 'Ressource introuvable' }));

// Gestion des erreurs globales
app.use((err, _req, res, _next) => {
  logger.error(err.stack);
  const status = err.status || 500;
  res.status(status).json({ erreur: err.message || 'Erreur serveur interne' });
});

// ─── Socket.IO ────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('rejoindre_tontine', (tontineId) => socket.join(`tontine_${tontineId}`));
  socket.on('quitter_tontine', (tontineId) => socket.leave(`tontine_${tontineId}`));
});

// ─── Démarrage ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => logger.info(`Serveur démarré sur le port ${PORT}`));

module.exports = { app, io };
