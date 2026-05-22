const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { totp } = require('otplib');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { prisma } = require('../utils/prisma');
const { journaliser } = require('../utils/audit');

// ─── SMS via Africa's Talking ──────────────────────────────
async function envoyerSMS(telephone, message) {
  if (process.env.AT_API_KEY && process.env.AT_USERNAME) {
    const AfricasTalking = require('africastalking');
    const at = AfricasTalking({ username: process.env.AT_USERNAME, apiKey: process.env.AT_API_KEY });
    await at.SMS.send({ to: [telephone], message, from: process.env.AT_SENDER_ID || 'SusuPay' });
  } else {
    // Mode développement : afficher dans la console
    console.log(`[OTP SMS → ${telephone}] ${message}`);
  }
}

const genererTokens = (userId) => ({
  accessToken: jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRE || '15m' }),
  refreshToken: jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRE || '7d' }),
});

// POST /api/auth/inscription
router.post('/inscription', async (req, res) => {
  try {
    const { nom, prenom, email, telephone, motDePasse } = req.body;

    if (!nom || !prenom || !email || !telephone || !motDePasse) {
      return res.status(400).json({ erreur: 'Tous les champs sont requis' });
    }
    if (motDePasse.length < 8) {
      return res.status(400).json({ erreur: 'Le mot de passe doit faire au moins 8 caractères' });
    }

    const existant = await prisma.user.findFirst({ where: { OR: [{ email }, { telephone }] } });
    if (existant) return res.status(409).json({ erreur: 'Email ou téléphone déjà utilisé' });

    const passwordHash = await bcrypt.hash(motDePasse, 12);
    const user = await prisma.user.create({
      data: { nom, prenom, email: email.toLowerCase(), telephone, passwordHash },
      select: { id: true, nom: true, prenom: true, email: true, telephone: true },
    });

    await journaliser({ acteurId: user.id, action: 'INSCRIPTION', entiteType: 'User', entiteId: user.id, req });
    const tokens = genererTokens(user.id);
    res.status(201).json({ message: 'Compte créé avec succès', user, ...tokens });
  } catch (err) {
    res.status(500).json({ erreur: 'Erreur lors de l\'inscription' });
  }
});

// POST /api/auth/connexion
router.post('/connexion', async (req, res) => {
  try {
    const { email, motDePasse, codeOtp } = req.body;

    const user = await prisma.user.findUnique({ where: { email: email?.toLowerCase() } });
    if (!user || !user.isActive || !user.passwordHash) return res.status(401).json({ erreur: 'Identifiants incorrects' });

    const valide = await bcrypt.compare(motDePasse, user.passwordHash);
    if (!valide) return res.status(401).json({ erreur: 'Identifiants incorrects' });

    // Vérification 2FA si activé
    if (user.twoFaActive) {
      if (!codeOtp) return res.status(200).json({ requiert2FA: true });
      const otpValide = totp.check(codeOtp, user.twoFaSecret);
      if (!otpValide) return res.status(401).json({ erreur: 'Code OTP invalide' });
    }

    await journaliser({ acteurId: user.id, action: 'CONNEXION', entiteType: 'User', entiteId: user.id, req });

    const tokens = genererTokens(user.id);
    const { passwordHash, twoFaSecret, ...userSafe } = user;
    res.json({ user: userSafe, ...tokens });
  } catch {
    res.status(500).json({ erreur: 'Erreur lors de la connexion' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(401).json({ erreur: 'Token manquant' });

    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const tokens = genererTokens(payload.userId);
    res.json(tokens);
  } catch {
    res.status(401).json({ erreur: 'Refresh token invalide ou expiré' });
  }
});

// POST /api/auth/2fa/activer
router.post('/2fa/activer', async (req, res) => {
  try {
    const { userId } = req.body;
    const secret = totp.generateSecret();
    await prisma.user.update({ where: { id: userId }, data: { twoFaSecret: secret } });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    const otpauthUrl = totp.keyuri(user.email, process.env.APP_NAME || 'TontineApp', secret);
    const qrCode = await QRCode.toDataURL(otpauthUrl);

    res.json({ secret, qrCode });
  } catch {
    res.status(500).json({ erreur: 'Erreur activation 2FA' });
  }
});

// POST /api/auth/2fa/confirmer
router.post('/2fa/confirmer', async (req, res) => {
  try {
    const { userId, code } = req.body;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.twoFaSecret) return res.status(400).json({ erreur: 'Secret 2FA non initialisé' });

    const valide = totp.check(code, user.twoFaSecret);
    if (!valide) return res.status(400).json({ erreur: 'Code invalide' });

    await prisma.user.update({ where: { id: userId }, data: { twoFaActive: true } });
    res.json({ message: '2FA activé avec succès' });
  } catch {
    res.status(500).json({ erreur: 'Erreur confirmation 2FA' });
  }
});

// POST /api/auth/google — Connexion / inscription via Google OAuth
router.post('/google', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ erreur: 'Token Google manquant' });

    // Récupérer les infos utilisateur via l'access_token (implicit flow)
    const userInfoResp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!userInfoResp.ok) return res.status(401).json({ erreur: 'Token Google invalide' });
    const { sub: googleId, email, name, picture, given_name, family_name } = await userInfoResp.json();

    await assurerTableOtp();

    // Chercher l'utilisateur existant (raw SQL pour compatibilité avec l'ancien client Prisma)
    let users = email
      ? await prisma.$queryRaw`SELECT * FROM "users" WHERE "googleId" = ${googleId} OR "email" = ${email} LIMIT 1`
      : await prisma.$queryRaw`SELECT * FROM "users" WHERE "googleId" = ${googleId} LIMIT 1`;
    let user = users?.[0] || null;

    if (user) {
      // Mettre à jour le googleId si pas encore lié
      if (!user.googleId) {
        await prisma.$executeRaw`UPDATE "users" SET "googleId" = ${googleId}, "avatarUrl" = COALESCE(${picture || null}, "avatarUrl"), "updatedAt" = NOW() WHERE "id" = ${user.id}`;
        user.googleId = googleId;
      }
    } else {
      // Créer un nouveau compte
      const newId = uuidv4();
      const nom = family_name || (name ? name.split(' ').slice(-1)[0] : 'Utilisateur');
      const prenom = given_name || (name ? name.split(' ')[0] : 'Nouveau');
      await prisma.$executeRaw`
        INSERT INTO "users" ("id", "nom", "prenom", "email", "googleId", "avatarUrl", "scoreFilabilite", "twoFaActive", "isVerified", "isActive", "createdAt", "updatedAt")
        VALUES (${newId}, ${nom}, ${prenom}, ${email || null}, ${googleId}, ${picture || null}, 100.0, false, true, true, NOW(), NOW())
      `;
      const newUsers = await prisma.$queryRaw`SELECT * FROM "users" WHERE "id" = ${newId}`;
      user = newUsers[0];
      await journaliser({ acteurId: user.id, action: 'INSCRIPTION_GOOGLE', entiteType: 'User', entiteId: user.id, req });
    }

    if (!user.isActive) return res.status(403).json({ erreur: 'Compte désactivé' });

    await journaliser({ acteurId: user.id, action: 'CONNEXION_GOOGLE', entiteType: 'User', entiteId: user.id, req });
    const tokens = genererTokens(user.id);
    const { passwordHash, twoFaSecret, googleId: gId, ...userSafe } = user;
    res.json({ user: userSafe, ...tokens });
  } catch (err) {
    console.error('Erreur Google auth:', err.message);
    res.status(401).json({ erreur: 'Token Google invalide' });
  }
});

// Migrations SQL appliquées au premier appel
let migrationsOk = false;
async function assurerTableOtp() {
  if (migrationsOk) return;
  try {
    // Rendre les colonnes nullable (idempotent en PostgreSQL)
    await prisma.$executeRawUnsafe(`ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL`).catch(() => {});
    await prisma.$executeRawUnsafe(`ALTER TABLE "users" ALTER COLUMN "telephone" DROP NOT NULL`).catch(() => {});
    await prisma.$executeRawUnsafe(`ALTER TABLE "users" ALTER COLUMN "passwordHash" DROP NOT NULL`).catch(() => {});
    await prisma.$executeRawUnsafe(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "googleId" TEXT`).catch(() => {});
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "users_googleId_key" ON "users"("googleId")`).catch(() => {});
    // Créer la table otp_codes
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "otp_codes" (
        "id" TEXT NOT NULL,
        "telephone" TEXT NOT NULL,
        "code" TEXT NOT NULL,
        "expireAt" TIMESTAMP(3) NOT NULL,
        "utilise" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
      )
    `;
    migrationsOk = true;
  } catch (e) {
    console.error('[migration] Erreur:', e.message);
  }
}

// POST /api/auth/otp/envoyer — Envoyer un code OTP par SMS
router.post('/otp/envoyer', async (req, res) => {
  try {
    const { telephone } = req.body;
    if (!telephone) return res.status(400).json({ erreur: 'Numéro de téléphone requis' });

    // Nettoyer le numéro (garder + et chiffres)
    const tel = telephone.replace(/[^\d+]/g, '');
    if (tel.length < 8) return res.status(400).json({ erreur: 'Numéro invalide' });

    // S'assurer que la table existe
    await assurerTableOtp();

    // Générer code 6 chiffres
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expireAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    // Invalider les anciens codes non utilisés
    await prisma.$executeRaw`UPDATE "otp_codes" SET "utilise" = true WHERE "telephone" = ${tel} AND "utilise" = false`;

    // Sauvegarder le nouveau code
    await prisma.$executeRaw`
      INSERT INTO "otp_codes" ("id", "telephone", "code", "expireAt", "utilise", "createdAt")
      VALUES (${uuidv4()}, ${tel}, ${code}, ${expireAt}, false, NOW())
    `;

    // Envoyer le SMS
    await envoyerSMS(tel, `Votre code SusuPay : ${code}. Valable 5 minutes. Ne le partagez pas.`);

    // En mode dev, renvoyer le code dans la réponse
    const modeTest = !process.env.AT_API_KEY;
    res.json({
      message: `Code envoyé au ${tel}`,
      ...(modeTest && { codeTest: code, note: 'Mode test : code visible car SMS non configuré' }),
    });
  } catch (err) {
    console.error('Erreur envoi OTP:', err.message);
    res.status(500).json({ erreur: 'Erreur lors de l\'envoi du code' });
  }
});

// POST /api/auth/otp/verifier — Vérifier le code OTP et connecter
router.post('/otp/verifier', async (req, res) => {
  try {
    const { telephone, code, nom, prenom } = req.body;
    if (!telephone || !code) return res.status(400).json({ erreur: 'Téléphone et code requis' });

    const tel = telephone.replace(/[^\d+]/g, '');

    await assurerTableOtp();

    // Vérifier le code
    const now = new Date();
    const otps = await prisma.$queryRaw`
      SELECT "id" FROM "otp_codes"
      WHERE "telephone" = ${tel} AND "code" = ${code} AND "utilise" = false AND "expireAt" > ${now}
      ORDER BY "createdAt" DESC LIMIT 1
    `;
    if (!otps || otps.length === 0) return res.status(401).json({ erreur: 'Code incorrect ou expiré' });

    // Marquer comme utilisé
    await prisma.$executeRaw`UPDATE "otp_codes" SET "utilise" = true WHERE "id" = ${otps[0].id}`;

    // Chercher ou créer l'utilisateur
    let user = await prisma.user.findUnique({ where: { telephone: tel } });
    const estNouvelUtilisateur = !user;

    if (!user) {
      if (!nom || !prenom) {
        return res.status(200).json({ nouveauCompte: true, telephone: tel });
      }
      user = await prisma.user.create({
        data: { telephone: tel, nom, prenom, isVerified: true },
      });
      await journaliser({ acteurId: user.id, action: 'INSCRIPTION_TELEPHONE', entiteType: 'User', entiteId: user.id, req });
    }

    if (!user.isActive) return res.status(403).json({ erreur: 'Compte désactivé' });

    await journaliser({ acteurId: user.id, action: 'CONNEXION_TELEPHONE', entiteType: 'User', entiteId: user.id, req });
    const tokens = genererTokens(user.id);
    const { passwordHash, twoFaSecret, googleId, ...userSafe } = user;
    res.json({ user: userSafe, ...tokens, estNouvelUtilisateur });
  } catch (err) {
    console.error('Erreur vérif OTP:', err.message);
    res.status(500).json({ erreur: 'Erreur lors de la vérification' });
  }
});

module.exports = router;
