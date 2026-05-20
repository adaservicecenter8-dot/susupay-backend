const router = require('express').Router();
const { prisma } = require('../utils/prisma');
const { authentifier, autoriserRole, membreDeLaTontine } = require('../middleware/auth');

// GET /api/tontines/:tontineId/sessions
router.get('/:tontineId/sessions', authentifier, membreDeLaTontine, async (req, res) => {
  const sessions = await prisma.session.findMany({
    where: { cycle: { tontineId: req.params.tontineId } },
    include: {
      paiements: {
        where: { statut: 'VALIDE' },
        include: { payeur: { select: { id: true, nom: true, prenom: true } } },
      },
      cycle: { select: { numeroCycle: true } },
    },
    orderBy: [{ cycle: { numeroCycle: 'asc' } }, { numeroSession: 'asc' }],
  });

  // Enrichir avec info bénéficiaire
  const membresMap = await prisma.tontineMembre.findMany({
    where: { tontineId: req.params.tontineId },
    include: { membre: { select: { id: true, nom: true, prenom: true, avatarUrl: true } } },
  });
  const membreById = Object.fromEntries(membresMap.map((m) => [m.membreId, m.membre]));

  const sessionsEnrichies = sessions.map((s) => ({
    ...s,
    beneficiaire: s.beneficiaireId ? membreById[s.beneficiaireId] : null,
  }));

  res.json(sessionsEnrichies);
});

// GET /api/tontines/:tontineId/sessions/prochaine
router.get('/:tontineId/sessions/prochaine', authentifier, membreDeLaTontine, async (req, res) => {
  const session = await prisma.session.findFirst({
    where: {
      cycle: { tontineId: req.params.tontineId },
      statut: { in: ['PLANIFIEE', 'EN_COURS'] },
      datePlanifiee: { gte: new Date() },
    },
    orderBy: { datePlanifiee: 'asc' },
    include: {
      paiements: { include: { payeur: { select: { id: true, nom: true, prenom: true } } } },
      cycle: true,
    },
  });
  res.json(session);
});

// PUT /api/tontines/:tontineId/sessions/:sessionId
router.put('/:tontineId/sessions/:sessionId', authentifier, autoriserRole('ADMINISTRATEUR', 'TRESORIER'), async (req, res) => {
  const { datePlanifiee, statut } = req.body;
  const session = await prisma.session.update({
    where: { id: req.params.sessionId },
    data: {
      ...(datePlanifiee && { datePlanifiee: new Date(datePlanifiee) }),
      ...(statut && { statut }),
    },
  });
  res.json(session);
});

// GET /api/tontines/:tontineId/calendrier
router.get('/:tontineId/calendrier', authentifier, membreDeLaTontine, async (req, res) => {
  const sessions = await prisma.session.findMany({
    where: { cycle: { tontineId: req.params.tontineId } },
    orderBy: [{ cycle: { numeroCycle: 'asc' } }, { numeroSession: 'asc' }],
    include: { cycle: { select: { numeroCycle: true } } },
  });

  const membres = await prisma.tontineMembre.findMany({
    where: { tontineId: req.params.tontineId, statut: 'ACTIF' },
    include: { membre: { select: { id: true, nom: true, prenom: true } } },
    orderBy: { position: 'asc' },
  });

  const membreById = Object.fromEntries(membres.map((m) => [m.membreId, m.membre]));

  const calendrier = sessions.map((s) => ({
    id: s.id,
    numeroSession: s.numeroSession,
    numeroCycle: s.cycle.numeroCycle,
    datePlanifiee: s.datePlanifiee,
    dateEffective: s.dateEffective,
    statut: s.statut,
    beneficiaire: s.beneficiaireId ? membreById[s.beneficiaireId] : null,
    montantDistribue: s.montantDistribue,
    estMoi: s.beneficiaireId === req.user.id,
  }));

  res.json(calendrier);
});

module.exports = router;
