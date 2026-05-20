const router = require('express').Router();
const { prisma } = require('../utils/prisma');
const { authentifier, autoriserRole, membreDeLaTontine } = require('../middleware/auth');

// GET /api/tontines/:tontineId/messages
router.get('/:tontineId/messages', authentifier, membreDeLaTontine, async (req, res) => {
  const { page = 1, limite = 50 } = req.query;
  const messages = await prisma.message.findMany({
    where: { tontineId: req.params.tontineId },
    include: {
      expediteur: { select: { id: true, nom: true, prenom: true, avatarUrl: true } },
      lectures: { where: { membreId: req.user.id } },
    },
    orderBy: { createdAt: 'desc' },
    take: Number(limite),
    skip: (Number(page) - 1) * Number(limite),
  });

  // Marquer les messages comme lus
  const nonLus = messages.filter((m) => m.lectures.length === 0 && m.expediteurId !== req.user.id);
  if (nonLus.length > 0) {
    await prisma.lectureMessage.createMany({
      data: nonLus.map((m) => ({ messageId: m.id, membreId: req.user.id })),
      skipDuplicates: true,
    });
  }

  res.json(messages.reverse());
});

// POST /api/tontines/:tontineId/messages
router.post('/:tontineId/messages', authentifier, membreDeLaTontine, async (req, res) => {
  const { contenu, estAnnonce } = req.body;
  if (!contenu?.trim()) return res.status(400).json({ erreur: 'Contenu requis' });

  // Seul admin peut créer des annonces
  if (estAnnonce && req.membre?.role !== 'ADMINISTRATEUR') {
    return res.status(403).json({ erreur: 'Seul l\'administrateur peut créer des annonces' });
  }

  const message = await prisma.message.create({
    data: {
      tontineId: req.params.tontineId,
      expediteurId: req.user.id,
      contenu: contenu.trim(),
      estAnnonce: Boolean(estAnnonce),
    },
    include: { expediteur: { select: { id: true, nom: true, prenom: true, avatarUrl: true } } },
  });

  // Diffuser en temps réel
  req.app.get('io')?.to(`tontine_${req.params.tontineId}`).emit('nouveau_message', message);

  res.status(201).json(message);
});

// GET /api/tontines/:tontineId/annonces
router.get('/:tontineId/annonces', authentifier, membreDeLaTontine, async (req, res) => {
  const annonces = await prisma.message.findMany({
    where: { tontineId: req.params.tontineId, estAnnonce: true },
    include: {
      expediteur: { select: { id: true, nom: true, prenom: true } },
      _count: { select: { lectures: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(annonces);
});

module.exports = router;
