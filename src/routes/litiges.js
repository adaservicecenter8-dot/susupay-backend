const router = require('express').Router();
const { prisma } = require('../utils/prisma');
const { authentifier, autoriserRole, membreDeLaTontine } = require('../middleware/auth');
const { notifierMembresTontine } = require('../utils/notifications');
const { journaliser } = require('../utils/audit');

// GET /api/tontines/:tontineId/litiges
router.get('/:tontineId/litiges', authentifier, membreDeLaTontine, async (req, res) => {
  const litiges = await prisma.litige.findMany({
    where: { tontineId: req.params.tontineId },
    include: {
      rapporteur: { select: { id: true, nom: true, prenom: true, avatarUrl: true } },
      votes: { include: { votant: { select: { id: true, nom: true, prenom: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const litgesEnrichis = litiges.map((l) => ({
    ...l,
    votePour: l.votes.filter((v) => v.vote).length,
    voteContre: l.votes.filter((v) => !v.vote).length,
    monVote: l.votes.find((v) => v.votantId === req.user.id)?.vote ?? null,
  }));

  res.json(litgesEnrichis);
});

// POST /api/tontines/:tontineId/litiges — signaler un litige
router.post('/:tontineId/litiges', authentifier, membreDeLaTontine, async (req, res) => {
  try {
    const { type, description } = req.body;
    if (!description) return res.status(400).json({ erreur: 'Description requise' });

    const litige = await prisma.litige.create({
      data: {
        tontineId: req.params.tontineId,
        rapporteurId: req.user.id,
        type: type || 'AUTRE',
        description,
        statut: 'OUVERT',
      },
      include: { rapporteur: { select: { nom: true, prenom: true } } },
    });

    await notifierMembresTontine({
      tontineId: req.params.tontineId,
      titre: '⚠️ Nouveau litige signalé',
      corps: `${litige.rapporteur.prenom} ${litige.rapporteur.nom} a signalé un litige. Consultez-le pour voter.`,
      type: 'LITIGE',
      io: req.app.get('io'),
      exclureId: req.user.id,
    });

    await journaliser({ acteurId: req.user.id, tontineId: req.params.tontineId, action: 'SIGNALEMENT_LITIGE', entiteType: 'Litige', entiteId: litige.id, req });
    res.status(201).json(litige);
  } catch {
    res.status(500).json({ erreur: 'Erreur lors du signalement' });
  }
});

// POST /api/tontines/:tontineId/litiges/:litigeId/voter
router.post('/:tontineId/litiges/:litigeId/voter', authentifier, membreDeLaTontine, async (req, res) => {
  try {
    const { vote, commentaire } = req.body;
    const litige = await prisma.litige.findFirst({
      where: { id: req.params.litigeId, tontineId: req.params.tontineId },
      include: { votes: true },
    });

    if (!litige) return res.status(404).json({ erreur: 'Litige introuvable' });
    if (litige.statut === 'RESOLU' || litige.statut === 'FERME') return res.status(400).json({ erreur: 'Ce litige est clôturé' });

    const voteRecord = await prisma.voteLitige.upsert({
      where: { litigeId_votantId: { litigeId: litige.id, votantId: req.user.id } },
      create: { litigeId: litige.id, votantId: req.user.id, vote: Boolean(vote), commentaire },
      update: { vote: Boolean(vote), commentaire },
    });

    // Mettre à jour le statut en EN_VOTE si premier vote
    if (litige.statut === 'OUVERT') {
      await prisma.litige.update({ where: { id: litige.id }, data: { statut: 'EN_VOTE' } });
    }

    // Vérifier si majorité atteinte
    const nombreMembres = await prisma.tontineMembre.count({ where: { tontineId: req.params.tontineId, statut: 'ACTIF' } });
    const votes = await prisma.voteLitige.findMany({ where: { litigeId: litige.id } });
    const votePour = votes.filter((v) => v.vote).length;
    const voteContre = votes.filter((v) => !v.vote).length;
    const majorite = Math.floor(nombreMembres / 2) + 1;

    if (votePour >= majorite || voteContre >= majorite) {
      const resolution = votePour >= majorite ? 'RÉSOLU EN FAVEUR DU PLAIGNANT' : 'REJETÉ PAR MAJORITÉ';
      await prisma.litige.update({
        where: { id: litige.id },
        data: { statut: 'RESOLU', resolution, resolvedAt: new Date() },
      });

      await notifierMembresTontine({
        tontineId: req.params.tontineId,
        titre: '⚖️ Litige résolu',
        corps: `Le litige a été résolu : ${resolution}`,
        type: 'LITIGE',
        io: req.app.get('io'),
      });
    }

    res.json(voteRecord);
  } catch {
    res.status(500).json({ erreur: 'Erreur lors du vote' });
  }
});

// POST /api/tontines/:tontineId/litiges/:litigeId/fermer
router.post('/:tontineId/litiges/:litigeId/fermer', authentifier, autoriserRole('ADMINISTRATEUR'), async (req, res) => {
  const { resolution } = req.body;
  const litige = await prisma.litige.update({
    where: { id: req.params.litigeId },
    data: { statut: 'FERME', resolution, resolvedAt: new Date() },
  });
  res.json(litige);
});

module.exports = router;
