const router = require('express').Router();
const { prisma } = require('../utils/prisma');
const { authentifier } = require('../middleware/auth');

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
router.put('/moi', authentifier, async (req, res) => {
  const { nom, prenom, telephone, avatarUrl } = req.body;
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { nom, prenom, telephone, avatarUrl },
    select: { id: true, nom: true, prenom: true, email: true, telephone: true, avatarUrl: true },
  });
  res.json(user);
});

// GET /api/users/moi/notifications — AVANT /:id pour éviter le conflit de route
router.get('/moi/notifications', authentifier, async (req, res) => {
  const { page = 1, limite = 20 } = req.query;
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
