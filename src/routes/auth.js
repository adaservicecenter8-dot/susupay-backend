const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { totp } = require('otplib');
const QRCode = require('qrcode');
const { prisma } = require('../utils/prisma');
const { journaliser } = require('../utils/audit');

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
    if (!user || !user.isActive) return res.status(401).json({ erreur: 'Identifiants incorrects' });

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

module.exports = router;
