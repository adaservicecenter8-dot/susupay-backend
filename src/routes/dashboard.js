const router = require('express').Router();
const { prisma } = require('../utils/prisma');
const { authentifier } = require('../middleware/auth');

// GET /api/dashboard
router.get('/', authentifier, async (req, res) => {
  try {
    const [tontines, notifs] = await Promise.all([
      prisma.tontine.findMany({
        where: { membres: { some: { membreId: req.user.id, statut: 'ACTIF' } } },
        include: {
          _count: { select: { membres: { where: { statut: 'ACTIF' } } } },
          membres: { where: { membreId: req.user.id } },
          cycles: {
            orderBy: { numeroCycle: 'desc' }, take: 1,
            include: {
              sessions: {
                where: { statut: { in: ['EN_COURS', 'PLANIFIEE'] } },
                orderBy: { datePlanifiee: 'asc' }, take: 1,
                include: { paiements: { where: { statut: { in: ['VALIDE', 'EN_ATTENTE'] } } } },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.notification.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);

    const prochainesEcheances = [];
    for (const t of tontines) {
      const session = t.cycles[0]?.sessions[0];
      if (!session) continue;
      const dejaPayé = session.paiements.some((p) => p.payeurId === req.user.id);
      if (!dejaPayé) {
        prochainesEcheances.push({
          tontineId: t.id,
          tontineNom: t.nom,
          sessionId: session.id,
          datePlanifiee: session.datePlanifiee,
          montant: t.montantCotisation,
        });
      }
    }
    prochainesEcheances.sort((a, b) => new Date(a.datePlanifiee) - new Date(b.datePlanifiee));

    const totalCotisationsValidees = await prisma.paiement.aggregate({
      where: { payeurId: req.user.id, statut: 'VALIDE' },
      _sum: { montant: true },
    });

    res.json({
      stats: {
        total: tontines.length,
        actives: tontines.filter((t) => t.statut === 'EN_COURS').length,
        ouvertes: tontines.filter((t) => t.statut === 'OUVERTE').length,
        score: req.user.scoreFilabilite,
        totalEpargne: totalCotisationsValidees._sum.montant || 0,
      },
      prochainesEcheances: prochainesEcheances.slice(0, 3),
      tontines,
      activiteRecente: notifs,
    });
  } catch (err) {
    res.status(500).json({ erreur: 'Erreur dashboard' });
  }
});

module.exports = router;
