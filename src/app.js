require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { logger } = require('./utils/logger');

const app = express();
app.set('trust proxy', 1);
const httpServer = createServer(app);

// Socket.IO pour les notifications temps réel
const io = new Server(httpServer, {
  cors: { origin: process.env.CLIENT_URL, methods: ['GET', 'POST'] }
});
app.set('io', io);

// ─── Middleware globaux ────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://accounts.google.com', 'https://apis.google.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
      connectSrc: ["'self'", 'https://accounts.google.com', 'https://www.googleapis.com', 'wss:', 'ws:'],
      frameSrc: ["'self'", 'https://accounts.google.com'],
      frameAncestors: ["'self'"],
      objectSrc: ["'none'"],
    },
  },
}));
const originesAutorisees = (!process.env.CLIENT_URL || process.env.CLIENT_URL === '*')
  ? true
  : process.env.CLIENT_URL.split(',').map((o) => o.trim());
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
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/exports', require('./routes/exports'));

// Santé de l'API
app.get('/api/health', (_req, res) => res.json({ statut: 'ok', heure: new Date().toISOString() }));

// ─── Live Update ──────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
app.use('/updates', express.static(path.join(__dirname, '../updates')));
app.get('/api/updates/check', (req, res) => {
  const infoPath = path.join(__dirname, '../updates/latest.json');
  if (!fs.existsSync(infoPath)) return res.json({ version: '0' });
  res.json(JSON.parse(fs.readFileSync(infoPath, 'utf8')));
});

// Seed des comptes démo (protégé par clé secrète)
app.post('/api/seed-demo', async (req, res) => {
  if (req.headers['x-seed-key'] !== 'susupay-seed-2024') return res.status(403).json({ erreur: 'Interdit' });
  try {
    const bcrypt = require('bcryptjs');
    const { prisma } = require('./utils/prisma');
    const hash = await bcrypt.hash('demo', 12);
    const users = [
      { email: 'admin@tontine.app', nom: 'Koné', prenom: 'Aminata', telephone: '+221771234567' },
      { email: 'tresorier@tontine.app', nom: 'Diallo', prenom: 'Mamadou', telephone: '+221772345678' },
      { email: 'marie@tontine.app', nom: 'Traoré', prenom: 'Marie', telephone: '+221773456789' },
    ];
    const created = [];
    for (const u of users) {
      const user = await prisma.user.upsert({
        where: { email: u.email },
        update: { passwordHash: hash },
        create: { ...u, passwordHash: hash, isVerified: true, scoreFilabilite: 95 },
      });
      created.push(user.email);
    }
    res.json({ message: 'Comptes démo créés', comptes: created });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

// ─── Frontend (SPA web) ───────────────────────────────────────────
const publicDir = path.join(__dirname, '../public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/updates')) {
      return res.status(404).json({ erreur: 'Ressource introuvable' });
    }
    res.sendFile(path.join(publicDir, 'index.html'));
  });
} else {
  // Gestion des erreurs 404
  app.use((_req, res) => res.status(404).json({ erreur: 'Ressource introuvable' }));
}

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

// ─── Rappels automatiques (cron) ─────────────────────────────────
const cron = require('node-cron');
const { prisma: prismaInstance } = require('./utils/prisma');
const { envoyerNotification: envoyerNotifCron } = require('./utils/notifications');

cron.schedule('0 8 * * *', async () => {
  try {
    const dans3Jours = new Date(); dans3Jours.setDate(dans3Jours.getDate() + 3);
    const hier = new Date(); hier.setDate(hier.getDate() - 1);
    const sessions = await prismaInstance.session.findMany({
      where: { statut: { in: ['EN_COURS', 'PLANIFIEE'] }, datePlanifiee: { gte: hier, lte: dans3Jours } },
      include: {
        paiements: { where: { statut: { in: ['VALIDE', 'EN_ATTENTE'] } } },
        cycle: { include: { tontine: { include: { membres: { where: { statut: 'ACTIF' } } } } } },
      },
    });
    for (const session of sessions) {
      const tontine = session.cycle.tontine;
      const ayantPaye = new Set(session.paiements.map((p) => p.payeurId));
      const nonPayes = tontine.membres.filter((m) => !ayantPaye.has(m.membreId));
      const joursRestants = Math.max(1, Math.ceil((new Date(session.datePlanifiee) - new Date()) / 86400000));
      for (const m of nonPayes) {
        await envoyerNotifCron({
          userId: m.membreId,
          titre: '⏰ Rappel cotisation',
          corps: `Cotisation de ${tontine.montantCotisation} FCFA pour "${tontine.nom}" due dans ${joursRestants} jour${joursRestants > 1 ? 's' : ''}.`,
          type: 'SYSTEME',
          lienAction: `/tontines/${tontine.id}/paiements`,
          io,
        });
      }
    }
    logger.info(`Rappels cron : ${sessions.length} session(s) traitée(s)`);
  } catch (err) { logger.error('Erreur cron rappels:', err.message); }
});

// ─── Démarrage ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => logger.info(`Serveur démarré sur le port ${PORT}`));

module.exports = { app, io };
