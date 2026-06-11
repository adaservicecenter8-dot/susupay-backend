require('dotenv').config();

// Sentry doit être initialisé EN PREMIER avant tout require d'autres modules
const { initSentry, capturerErreur } = require('./utils/sentry');

// Les secrets JWT sont obligatoires — le serveur refuse de démarrer sans eux
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('[FATAL] JWT_SECRET manquant ou trop court (min 32 caractères). Définissez-le dans les variables d\'environnement.');
  process.exit(1);
}
if (!process.env.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET.length < 32) {
  console.error('[FATAL] JWT_REFRESH_SECRET manquant ou trop court (min 32 caractères). Définissez-le dans les variables d\'environnement.');
  process.exit(1);
}

const express = require('express');
require('express-async-errors'); // capture automatique des erreurs async dans toutes les routes
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { logger } = require('./utils/logger');

const app = express();
app.set('trust proxy', 1);
const httpServer = createServer(app);

// Initialiser Sentry (no-op si SENTRY_DSN non défini)
initSentry(app);

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
// Origines autorisées — toujours permissif pour les apps mobiles Capacitor
// (les requêtes natives Capacitor passent par capacitor://localhost ou https://localhost)
const originesAutorisees = process.env.CLIENT_URL && process.env.CLIENT_URL !== '*'
  ? (origin, cb) => {
      const liste = process.env.CLIENT_URL.split(',').map((o) => o.trim());
      // Toujours autoriser Capacitor, localhost et les origines configurées
      const autorise = !origin || liste.includes(origin)
        || origin.startsWith('capacitor://')
        || origin.startsWith('ionic://')
        || origin.includes('localhost')
        || origin.includes('railway.app');
      cb(null, autorise);
    }
  : true; // pas de CLIENT_URL → tout autoriser (API publique mobile)
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
app.use('/api/objectifs', require('./routes/objectifs'));
app.use('/api/assistant', require('./routes/assistant'));

// Santé de l'API
app.get('/api/health', (_req, res) => res.json({ statut: 'ok', heure: new Date().toISOString() }));

// ─── Live Update ──────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
app.use('/updates', express.static(path.join(__dirname, '../updates')));
app.get('/api/updates/check', (req, res) => {
  const infoPath = path.join(__dirname, '../updates/latest.json');
  if (!fs.existsSync(infoPath)) return res.json({ version: '0' });
  try {
    // Supprimer le BOM UTF-8 si présent (0xEF 0xBB 0xBF)
    const raw = fs.readFileSync(infoPath, 'utf8').replace(/^﻿/, '');
    res.json(JSON.parse(raw));
  } catch {
    res.json({ version: '0' });
  }
});

// Seed des comptes démo (protégé par clé secrète)
app.post('/api/seed-demo', async (req, res) => {
  if (!process.env.SEED_KEY || req.headers['x-seed-key'] !== process.env.SEED_KEY) return res.status(403).json({ erreur: 'Interdit' });
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

// Gestion des erreurs globales (y compris les rejets async grâce à express-async-errors)
app.use((err, _req, res, _next) => {
  logger.error(err.message, { stack: err.stack });
  // Signaler les erreurs 5xx à Sentry (les 4xx sont des erreurs client, pas des bugs)
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    capturerErreur(err, { statusCode: status });
  }
  if (res.headersSent) return;
  res.status(status).json({ erreur: err.message || 'Erreur serveur interne' });
});

// ─── Socket.IO ────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');

// Middleware d'authentification Socket.IO — rejette les connexions sans token valide
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
  if (!token) return next(new Error('Token manquant'));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = payload.userId;
    next();
  } catch {
    next(new Error('Token invalide'));
  }
});

io.on('connection', (socket) => {
  // Vérifie que l'utilisateur est bien membre avant de rejoindre la room
  socket.on('rejoindre_tontine', async (tontineId) => {
    try {
      const { prisma: p } = require('./utils/prisma');
      const membre = await p.tontineMembre.findUnique({
        where: { tontineId_membreId: { tontineId, membreId: socket.userId } },
      });
      if (membre && membre.statut === 'ACTIF') {
        socket.join(`tontine_${tontineId}`);
      }
    } catch { /* ignore */ }
  });
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

// ─── Démarrage ─────────────────────────────────────────────────
// Ne pas démarrer le serveur HTTP si on est en mode test (Jest/Supertest)
const PORT = process.env.PORT || 3001;
if (process.env.NODE_ENV !== 'test') httpServer.listen(PORT, async () => {
  logger.info(`Serveur démarré sur le port ${PORT}`);

  // ── Migrations idempotentes au démarrage ─────────────────────────────────
  try {
    const { prisma: pm } = require('./utils/prisma');
    await pm.$executeRawUnsafe(`DO $$ BEGIN CREATE TYPE "KycStatut" AS ENUM ('NONE','EN_COURS','VALIDE','REJETE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await pm.$executeRawUnsafe(`ALTER TABLE "users" ADD COLUMN "kycStatut" "KycStatut" NOT NULL DEFAULT 'NONE'`).catch(() => {});
    await pm.$executeRawUnsafe(`ALTER TABLE "users" ADD COLUMN "kycPiece" TEXT`).catch(() => {});
    await pm.$executeRawUnsafe(`ALTER TABLE "users" ADD COLUMN "kycNumero" TEXT`).catch(() => {});
    await pm.$executeRawUnsafe(`ALTER TABLE "users" ADD COLUMN "kycDateValidation" TIMESTAMP`).catch(() => {});
    await pm.$executeRawUnsafe(`ALTER TABLE "users" ADD COLUMN "consentementCGU" BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
    await pm.$executeRawUnsafe(`ALTER TABLE "users" ADD COLUMN "consentementDate" TIMESTAMP`).catch(() => {});
    await pm.$executeRawUnsafe(`ALTER TABLE "signatures_reglement" ADD COLUMN "nomSaisi" TEXT`).catch(() => {});
    logger.info('Migrations KYC/consentement appliquées');

    // ── Tables Épargne individuelle ──────────────────────────────────────────
    await pm.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "objectifs_epargne" (
        "id"            TEXT NOT NULL,
        "userId"        TEXT NOT NULL,
        "nom"           TEXT NOT NULL,
        "description"   TEXT,
        "icone"         TEXT NOT NULL DEFAULT '🎯',
        "couleur"       TEXT NOT NULL DEFAULT 'blue',
        "montantCible"  DECIMAL(15,2) NOT NULL,
        "montantActuel" DECIMAL(15,2) NOT NULL DEFAULT 0,
        "dateEcheance"  TIMESTAMP,
        "termine"       BOOLEAN NOT NULL DEFAULT FALSE,
        "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "objectifs_epargne_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "objectifs_epargne_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `).catch(() => {});
    await pm.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "objectifs_epargne_userId_idx" ON "objectifs_epargne"("userId")`).catch(() => {});

    await pm.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "versements_objectif" (
        "id"         TEXT NOT NULL,
        "objectifId" TEXT NOT NULL,
        "montant"    DECIMAL(15,2) NOT NULL,
        "note"       TEXT,
        "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "versements_objectif_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "versements_objectif_objectifId_fkey" FOREIGN KEY ("objectifId") REFERENCES "objectifs_epargne"("id") ON DELETE CASCADE
      )
    `).catch(() => {});
    await pm.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "versements_objectif_objectifId_idx" ON "versements_objectif"("objectifId")`).catch(() => {});
    logger.info('Tables épargne vérifiées/créées');
  } catch (e) { logger.warn('Migration startup warning: ' + e.message); }

  // Auto-créer les comptes et tontines démo si absents (utile après un reset de la DB Railway)
  try {
    const bcrypt = require('bcryptjs');
    const { prisma: p } = require('./utils/prisma');
    const hash = await bcrypt.hash('demo', 12);

    // ── Utilisateurs démo ────────────────────────────────────────
    const comptes = [
      { email: 'admin@tontine.app', nom: 'Koné', prenom: 'Aminata', telephone: '+221771234567' },
      { email: 'tresorier@tontine.app', nom: 'Diallo', prenom: 'Mamadou', telephone: '+221772345678' },
      { email: 'marie@tontine.app', nom: 'Traoré', prenom: 'Marie', telephone: '+221773456789' },
    ];
    const users = {};
    for (const u of comptes) {
      const user = await p.user.upsert({
        where: { email: u.email },
        update: {},
        create: { ...u, passwordHash: hash, isVerified: true, scoreFilabilite: 95 },
      });
      users[u.email] = user;
    }
    const admin = users['admin@tontine.app'];
    const tresorier = users['tresorier@tontine.app'];
    const marie = users['marie@tontine.app'];

    // ── Tontine 1 : Famille Koné (EN_COURS) ─────────────────────
    let t1 = await p.tontine.findFirst({ where: { codeInvitation: 'FAM2024D' } });
    if (!t1) {
      t1 = await p.tontine.create({
        data: {
          nom: 'Tontine Famille Koné',
          description: 'Épargne mensuelle pour les grands projets de la famille',
          montantCotisation: 50000, frequence: 'MENSUELLE', nombreMembres: 3,
          modeTirage: 'ALEATOIRE', typePenalite: 'POURCENTAGE', valeurPenalite: 5,
          delaiPenaliteJours: 3, avecCredit: true, tauxInteretCredit: 2.5,
          statut: 'EN_COURS', codeInvitation: 'FAM2024D', createurId: admin.id,
        },
      });
      await p.tontineMembre.createMany({
        data: [
          { tontineId: t1.id, membreId: admin.id, role: 'ADMINISTRATEUR', statut: 'ACTIF', position: 1 },
          { tontineId: t1.id, membreId: tresorier.id, role: 'TRESORIER', statut: 'ACTIF', position: 2 },
          { tontineId: t1.id, membreId: marie.id, role: 'MEMBRE', statut: 'ACTIF', position: 3 },
        ],
        skipDuplicates: true,
      });
      const cycle1 = await p.cycle.create({
        data: { tontineId: t1.id, numeroCycle: 1, dateDebut: new Date('2024-02-01') },
      });
      const membres1 = [admin.id, tresorier.id, marie.id];
      for (let i = 0; i < membres1.length; i++) {
        const datePlanifiee = new Date('2024-02-01');
        datePlanifiee.setDate(datePlanifiee.getDate() + 30 * (i + 1));
        await p.session.create({
          data: {
            cycleId: cycle1.id, numeroSession: i + 1, datePlanifiee,
            beneficiaireId: membres1[i],
            statut: i === 0 ? 'DISTRIBUEE' : i === 1 ? 'EN_COURS' : 'PLANIFIEE',
          },
        });
      }
    }

    // ── Tontine 2 : Collègues Bureau (OUVERTE) ──────────────────
    let t2 = await p.tontine.findFirst({ where: { codeInvitation: 'BUR24D' } });
    if (!t2) {
      t2 = await p.tontine.create({
        data: {
          nom: 'Tontine Collègues Bureau',
          description: 'Cotisation hebdomadaire entre collègues',
          montantCotisation: 10000, frequence: 'HEBDOMADAIRE', nombreMembres: 2,
          modeTirage: 'MANUEL', typePenalite: 'FIXE', valeurPenalite: 2000,
          delaiPenaliteJours: 2, avecCredit: false,
          statut: 'OUVERTE', codeInvitation: 'BUR24D', createurId: admin.id,
        },
      });
      await p.tontineMembre.createMany({
        data: [
          { tontineId: t2.id, membreId: admin.id, role: 'ADMINISTRATEUR', statut: 'ACTIF', position: 1 },
          { tontineId: t2.id, membreId: tresorier.id, role: 'MEMBRE', statut: 'ACTIF', position: 2 },
        ],
        skipDuplicates: true,
      });
    }

    logger.info('Comptes et tontines démo vérifiés/créés');

    // ── Table blacklist des tokens ───────────────────────────────
    await p.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "token_blacklist" (
        "id" TEXT NOT NULL,
        "token_hash" TEXT NOT NULL UNIQUE,
        "expires_at" TIMESTAMPTZ NOT NULL,
        CONSTRAINT "token_blacklist_pkey" PRIMARY KEY ("id")
      )
    `).catch(() => {});
    await p.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "token_blacklist_expires_at_idx" ON "token_blacklist"("expires_at")`
    ).catch(() => {});
    logger.info('Table token_blacklist vérifiée');
  } catch (e) {
    logger.warn('Auto-seed ignoré : ' + e.message);
  }
});

module.exports = { app, io };
