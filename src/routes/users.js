const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { prisma } = require('../utils/prisma');
const { authentifier } = require('../middleware/auth');
const { valider, mettreAJourProfilSchema } = require('../services/validationSchemas');
const { journaliser } = require('../utils/audit');

// GET /api/users/moi
router.get('/moi', authentifier, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true, nom: true, prenom: true, email: true, telephone: true,
      avatarUrl: true, scoreFilabilite: true, twoFaActive: true,
      isVerified: true, createdAt: true,
      tontinesMembres: {
        where: { statut: 'ACTIF' },
        include: { tontine: { select: { id: true, nom: true, statut: true, montantCotisation: true } } },
      },
    },
  });
  res.json(user);
});

// PUT /api/users/moi
router.put('/moi', authentifier, valider(mettreAJourProfilSchema), async (req, res) => {
  const { nom, prenom, telephone, avatarUrl } = req.body;
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { nom, prenom, telephone, avatarUrl },
    select: { id: true, nom: true, prenom: true, email: true, telephone: true, avatarUrl: true },
  });
  res.json(user);
});

// PUT /api/users/moi/motdepasse
router.put('/moi/motdepasse', authentifier, async (req, res) => {
  const { motDePasseActuel, nouveauMotDePasse } = req.body;
  if (!motDePasseActuel || !nouveauMotDePasse) {
    return res.status(400).json({ erreur: 'Mot de passe actuel et nouveau requis' });
  }
  if (nouveauMotDePasse.length < 8) {
    return res.status(400).json({ erreur: 'Le nouveau mot de passe doit faire au moins 8 caractères' });
  }
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { passwordHash: true } });
  if (!user?.passwordHash) {
    return res.status(400).json({ erreur: 'Aucun mot de passe défini sur ce compte (connexion via Google ou téléphone)' });
  }
  const valide = await bcrypt.compare(motDePasseActuel, user.passwordHash);
  if (!valide) return res.status(401).json({ erreur: 'Mot de passe actuel incorrect' });

  const hash = await bcrypt.hash(nouveauMotDePasse, 12);
  await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash: hash } });
  res.json({ message: 'Mot de passe modifié avec succès' });
});

// GET /api/users/moi/notifications — AVANT /:id pour éviter le conflit de route
router.get('/moi/notifications', authentifier, async (req, res) => {
  const { page = 1 } = req.query;
  const limite = Math.min(Number(req.query.limite) || 20, 100);
  const notifications = await prisma.notification.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    take: Number(limite),
    skip: (Number(page) - 1) * Number(limite),
  });
  res.json(notifications);
});

// PUT /api/users/moi/notifications/lues — AVANT /:id
router.put('/moi/notifications/lues', authentifier, async (req, res) => {
  await prisma.notification.updateMany({
    where: { userId: req.user.id, lu: false },
    data: { lu: true },
  });
  res.json({ message: 'Notifications marquées comme lues' });
});

// DELETE /api/users/moi — effacement compte (anonymisation conforme Loi 2013-450)
router.delete('/moi', authentifier, async (req, res) => {
  try {
    const [tontinesAdmin, empruntActif] = await Promise.all([
      prisma.tontineMembre.findFirst({
        where: { membreId: req.user.id, role: 'ADMINISTRATEUR', tontine: { statut: { in: ['OUVERTE', 'EN_COURS'] } } },
        include: { tontine: { select: { nom: true } } },
      }),
      prisma.emprunt.findFirst({
        where: { emprunteurId: req.user.id, statut: { in: ['APPROUVE', 'EN_COURS'] } },
      }),
    ]);

    if (tontinesAdmin) {
      return res.status(400).json({
        erreur: `Vous êtes administrateur de "${tontinesAdmin.tontine.nom}" (active). Nommez un autre administrateur avant de supprimer votre compte.`,
      });
    }
    if (empruntActif) {
      return res.status(400).json({ erreur: 'Remboursez votre emprunt actif avant de supprimer votre compte.' });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        nom: '[Supprimé]', prenom: '[Supprimé]',
        email: null, telephone: null, avatarUrl: null,
        passwordHash: null, googleId: null,
        twoFaSecret: null, twoFaActive: false, isActive: false,
        kycPiece: null, kycNumero: null,
      },
    });

    await journaliser({ acteurId: req.user.id, action: 'SUPPRESSION_COMPTE', entiteType: 'User', entiteId: req.user.id, req });
    res.json({ message: 'Compte supprimé. Vos données financières sont conservées 10 ans (obligation légale).' });
  } catch (err) {
    console.error('[DELETE /moi]', err);
    res.status(500).json({ erreur: 'Erreur lors de la suppression du compte' });
  }
});

// GET /api/users/moi/kyc
router.get('/moi/kyc', authentifier, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { kycStatut: true, kycPiece: true, kycDateValidation: true },
  });
  res.json(user);
});

// PUT /api/users/moi/kyc
router.put('/moi/kyc', authentifier, async (req, res) => {
  const { kycPiece, kycNumero } = req.body;
  if (!kycPiece || !kycNumero) {
    return res.status(400).json({ erreur: 'Type et numéro de pièce requis' });
  }
  if (!['CNI', 'PASSEPORT', 'TITRE_SEJOUR'].includes(kycPiece)) {
    return res.status(400).json({ erreur: 'Type de pièce invalide (CNI, PASSEPORT, TITRE_SEJOUR)' });
  }
  if (kycNumero.trim().length < 4) {
    return res.status(400).json({ erreur: 'Numéro de pièce invalide' });
  }

  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { kycStatut: 'VALIDE', kycPiece, kycNumero: kycNumero.trim().toUpperCase(), kycDateValidation: new Date() },
    select: { kycStatut: true, kycPiece: true, kycDateValidation: true },
  });
  await journaliser({ acteurId: req.user.id, action: 'KYC_SOUMIS', entiteType: 'User', entiteId: req.user.id, req });
  res.json(user);
});

// GET /api/users/:id — profil public (DOIT être en dernier)
router.get('/:id', authentifier, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: {
      id: true, nom: true, prenom: true, avatarUrl: true, scoreFilabilite: true, createdAt: true,
    },
  });
  if (!user) return res.status(404).json({ erreur: 'Utilisateur introuvable' });
  res.json(user);
});

module.exports = router;
