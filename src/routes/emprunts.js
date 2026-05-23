const router = require('express').Router();
const { prisma } = require('../utils/prisma');
const { authentifier, autoriserRole, membreDeLaTontine } = require('../middleware/auth');
const { envoyerNotification, notifierMembresTontine } = require('../utils/notifications');
const { journaliser } = require('../utils/audit');

// GET /api/tontines/:tontineId/emprunts
router.get('/:tontineId/emprunts', authentifier, membreDeLaTontine, async (req, res) => {
  const emprunts = await prisma.emprunt.findMany({
    where: { tontineId: req.params.tontineId },
    include: {
      emprunteur: { select: { id: true, nom: true, prenom: true, avatarUrl: true } },
      remboursements: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  const empruntsEnrichis = emprunts.map((e) => {
    const totalRembourse = e.remboursements.reduce((s, r) => s + Number(r.montant), 0);
    return {
      ...e,
      totalRembourse,
      resteARembourser: Number(e.montantTotal) - totalRembourse,
      progression: (totalRembourse / Number(e.montantTotal)) * 100,
    };
  });

  res.json(empruntsEnrichis);
});

// POST /api/tontines/:tontineId/emprunts — demande d'emprunt
router.post('/:tontineId/emprunts', authentifier, membreDeLaTontine, async (req, res) => {
  try {
    const { montant, dureeRemboursement, motif } = req.body;
    const tontine = await prisma.tontine.findUnique({ where: { id: req.params.tontineId } });

    if (!tontine?.avecCredit) return res.status(400).json({ erreur: 'Cette tontine n\'autorise pas les emprunts' });
    if (!tontine.tauxInteretCredit) return res.status(400).json({ erreur: 'Taux d\'intérêt non configuré' });

    // Vérifier qu'il n'y a pas d'emprunt en cours
    const empruntActif = await prisma.emprunt.findFirst({
      where: { tontineId: req.params.tontineId, emprunteurId: req.user.id, statut: { in: ['APPROUVE', 'EN_COURS'] } },
    });
    if (empruntActif) return res.status(400).json({ erreur: 'Vous avez déjà un emprunt en cours' });

    const tauxInteret = Number(tontine.tauxInteretCredit);
    const montantNum = Number(montant);
    const interets = (montantNum * tauxInteret * Number(dureeRemboursement)) / 100;
    const montantTotal = montantNum + interets;

    const emprunt = await prisma.emprunt.create({
      data: {
        tontineId: req.params.tontineId,
        emprunteurId: req.user.id,
        montant: montantNum,
        tauxInteret,
        dureeRemboursement: Number(dureeRemboursement),
        montantTotal,
        motif,
        statut: 'EN_ATTENTE',
      },
      include: { emprunteur: { select: { nom: true, prenom: true } } },
    });

    // Notifier les admins
    const admins = await prisma.tontineMembre.findMany({
      where: { tontineId: req.params.tontineId, role: { in: ['ADMINISTRATEUR', 'TRESORIER'] }, statut: 'ACTIF' },
    });
    const io = req.app.get('io');
    for (const admin of admins) {
      await envoyerNotification({
        userId: admin.membreId,
        titre: '📋 Demande d\'emprunt',
        corps: `${emprunt.emprunteur.prenom} ${emprunt.emprunteur.nom} demande un emprunt de ${montantNum} FCFA`,
        type: 'SYSTEME',
        io,
      });
    }

    await journaliser({ acteurId: req.user.id, tontineId: req.params.tontineId, action: 'DEMANDE_EMPRUNT', entiteType: 'Emprunt', entiteId: emprunt.id, req });
    res.status(201).json(emprunt);
  } catch {
    res.status(500).json({ erreur: 'Erreur lors de la demande d\'emprunt' });
  }
});

// POST /api/tontines/:tontineId/emprunts/:empruntId/approuver
router.post('/:tontineId/emprunts/:empruntId/approuver', authentifier, autoriserRole('ADMINISTRATEUR', 'TRESORIER'), async (req, res) => {
  const empruntExistant = await prisma.emprunt.findFirst({
    where: { id: req.params.empruntId, tontineId: req.params.tontineId },
  });
  if (!empruntExistant) return res.status(404).json({ erreur: 'Emprunt introuvable' });
  if (empruntExistant.statut !== 'EN_ATTENTE') return res.status(400).json({ erreur: 'Cet emprunt n\'est plus en attente d\'approbation' });

  const emprunt = await prisma.emprunt.update({
    where: { id: req.params.empruntId },
    data: { statut: 'EN_COURS', dateApprobation: new Date() },
    include: { emprunteur: { select: { id: true, nom: true } } },
  });

  await envoyerNotification({
    userId: emprunt.emprunteurId,
    titre: '✅ Emprunt approuvé',
    corps: `Votre demande d\'emprunt de ${emprunt.montant} FCFA a été approuvée.`,
    type: 'SYSTEME',
    io: req.app.get('io'),
  });

  res.json(emprunt);
});

// POST /api/tontines/:tontineId/emprunts/:empruntId/remboursements
router.post('/:tontineId/emprunts/:empruntId/remboursements', authentifier, async (req, res) => {
  try {
    const { montant, note } = req.body;
    const emprunt = await prisma.emprunt.findUnique({
      where: { id: req.params.empruntId },
      include: { remboursements: true },
    });

    if (!emprunt || emprunt.tontineId !== req.params.tontineId) return res.status(404).json({ erreur: 'Emprunt introuvable' });
    if (emprunt.statut !== 'EN_COURS') return res.status(400).json({ erreur: 'Emprunt invalide ou non en cours' });

    const membreActeur = await prisma.tontineMembre.findUnique({
      where: { tontineId_membreId: { tontineId: req.params.tontineId, membreId: req.user.id } },
    });
    const estAdmin = ['ADMINISTRATEUR', 'TRESORIER'].includes(membreActeur?.role);
    if (!estAdmin && emprunt.emprunteurId !== req.user.id) {
      return res.status(403).json({ erreur: 'Vous ne pouvez pas enregistrer un remboursement pour un autre membre' });
    }

    const totalRembourse = emprunt.remboursements.reduce((s, r) => s + Number(r.montant), 0);
    const resteARembourser = Number(emprunt.montantTotal) - totalRembourse;

    if (Number(montant) > resteARembourser) {
      return res.status(400).json({ erreur: `Montant supérieur au reste à rembourser (${resteARembourser} FCFA)` });
    }

    const remboursement = await prisma.remboursement.create({
      data: { empruntId: emprunt.id, emprunteurId: req.user.id, montant: Number(montant), note },
    });

    // Vérifier si l'emprunt est totalement remboursé
    const nouveauTotal = totalRembourse + Number(montant);
    if (nouveauTotal >= Number(emprunt.montantTotal)) {
      await prisma.emprunt.update({ where: { id: emprunt.id }, data: { statut: 'REMBOURSE', dateFin: new Date() } });
    }

    await journaliser({ acteurId: req.user.id, tontineId: req.params.tontineId, action: 'REMBOURSEMENT', entiteType: 'Remboursement', entiteId: remboursement.id, nouvellesValeurs: { montant }, req });
    res.status(201).json(remboursement);
  } catch {
    res.status(500).json({ erreur: 'Erreur lors du remboursement' });
  }
});

module.exports = router;
