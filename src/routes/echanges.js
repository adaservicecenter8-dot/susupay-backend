const router = require('express').Router();
const { prisma } = require('../utils/prisma');
const { authentifier, membreDeLaTontine } = require('../middleware/auth');
const { envoyerNotification } = require('../utils/notifications');
const { journaliser } = require('../utils/audit');

// GET /api/tontines/:tontineId/echanges
router.get('/:tontineId/echanges', authentifier, membreDeLaTontine, async (req, res) => {
  const echanges = await prisma.echangePosition.findMany({
    where: { tontineId: req.params.tontineId },
    include: {
      demandeur: { select: { id: true, nom: true, prenom: true } },
      cible: { select: { id: true, nom: true, prenom: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(echanges);
});

// POST /api/tontines/:tontineId/echanges — proposer un échange
router.post('/:tontineId/echanges', authentifier, membreDeLaTontine, async (req, res) => {
  try {
    const { cibleId, message } = req.body;
    const tontineId = req.params.tontineId;

    const [demandeur, cible] = await Promise.all([
      prisma.tontineMembre.findUnique({ where: { tontineId_membreId: { tontineId, membreId: req.user.id } } }),
      prisma.tontineMembre.findUnique({ where: { tontineId_membreId: { tontineId, membreId: cibleId } } }),
    ]);

    if (!demandeur?.position || !cible?.position) return res.status(400).json({ erreur: 'Positions non définies' });

    const echange = await prisma.echangePosition.create({
      data: {
        tontineId,
        demandeurId: req.user.id,
        cibleId,
        positionDemandeur: demandeur.position,
        positionCible: cible.position,
        message,
        statut: 'EN_ATTENTE',
      },
    });

    await envoyerNotification({
      userId: cibleId,
      titre: '🔄 Demande d\'échange de position',
      corps: `${req.user.prenom} ${req.user.nom} vous propose d'échanger vos positions (${demandeur.position} ↔ ${cible.position})`,
      type: 'SYSTEME',
      io: req.app.get('io'),
    });

    res.status(201).json(echange);
  } catch {
    res.status(500).json({ erreur: 'Erreur lors de la demande d\'échange' });
  }
});

// POST /api/tontines/:tontineId/echanges/:echangeId/accepter
router.post('/:tontineId/echanges/:echangeId/accepter', authentifier, async (req, res) => {
  try {
    const echange = await prisma.echangePosition.findUnique({ where: { id: req.params.echangeId } });
    if (!echange || echange.cibleId !== req.user.id) return res.status(403).json({ erreur: 'Non autorisé' });
    if (echange.statut !== 'EN_ATTENTE') return res.status(400).json({ erreur: 'Demande déjà traitée' });

    await prisma.$transaction([
      prisma.echangePosition.update({ where: { id: echange.id }, data: { statut: 'ACCEPTE', resolvedAt: new Date() } }),
      prisma.tontineMembre.update({
        where: { tontineId_membreId: { tontineId: echange.tontineId, membreId: echange.demandeurId } },
        data: { position: echange.positionCible },
      }),
      prisma.tontineMembre.update({
        where: { tontineId_membreId: { tontineId: echange.tontineId, membreId: echange.cibleId } },
        data: { position: echange.positionDemandeur },
      }),
    ]);

    await envoyerNotification({
      userId: echange.demandeurId,
      titre: '✅ Échange accepté',
      corps: `Votre demande d\'échange de position a été acceptée.`,
      type: 'SYSTEME',
      io: req.app.get('io'),
    });

    await journaliser({ acteurId: req.user.id, tontineId: echange.tontineId, action: 'ECHANGE_POSITION', entiteType: 'EchangePosition', entiteId: echange.id, req });
    res.json({ message: 'Échange effectué avec succès' });
  } catch {
    res.status(500).json({ erreur: 'Erreur lors de l\'échange' });
  }
});

// POST /api/tontines/:tontineId/echanges/:echangeId/refuser
router.post('/:tontineId/echanges/:echangeId/refuser', authentifier, async (req, res) => {
  const echange = await prisma.echangePosition.findUnique({ where: { id: req.params.echangeId } });
  if (!echange || echange.cibleId !== req.user.id) return res.status(403).json({ erreur: 'Non autorisé' });

  await prisma.echangePosition.update({ where: { id: echange.id }, data: { statut: 'REFUSE', resolvedAt: new Date() } });
  await envoyerNotification({
    userId: echange.demandeurId,
    titre: '❌ Échange refusé',
    corps: 'Votre demande d\'échange de position a été refusée.',
    type: 'SYSTEME',
    io: req.app.get('io'),
  });

  res.json({ message: 'Demande refusée' });
});

module.exports = router;
