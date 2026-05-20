const router = require('express').Router();
const { prisma } = require('../utils/prisma');
const { authentifier, autoriserRole, membreDeLaTontine } = require('../middleware/auth');
const { journaliser } = require('../utils/audit');
const { envoyerNotification, notifierMembresTontine } = require('../utils/notifications');

// GET /api/tontines/:tontineId/paiements
router.get('/:tontineId/paiements', authentifier, membreDeLaTontine, async (req, res) => {
  const { sessionId, membreId, statut } = req.query;
  const paiements = await prisma.paiement.findMany({
    where: {
      session: { cycle: { tontineId: req.params.tontineId } },
      ...(sessionId && { sessionId }),
      ...(membreId && { payeurId: membreId }),
      ...(statut && { statut }),
    },
    include: {
      payeur: { select: { id: true, nom: true, prenom: true, avatarUrl: true } },
      session: { select: { id: true, numeroSession: true, datePlanifiee: true } },
    },
    orderBy: { enregistreLe: 'desc' },
  });
  res.json(paiements);
});

// POST /api/tontines/:tontineId/sessions/:sessionId/paiements — enregistrer un paiement
router.post('/:tontineId/sessions/:sessionId/paiements', authentifier, async (req, res) => {
  try {
    const { montant, methodePaiement, reference, note, payeurId } = req.body;
    const { tontineId, sessionId } = req.params;

    // Vérifier accès : trésorier/admin peut enregistrer pour n'importe qui, sinon pour soi
    const membreActeur = await prisma.tontineMembre.findUnique({
      where: { tontineId_membreId: { tontineId, membreId: req.user.id } },
    });
    const cibleId = (['ADMINISTRATEUR', 'TRESORIER'].includes(membreActeur?.role) && payeurId) ? payeurId : req.user.id;

    const session = await prisma.session.findFirst({
      where: { id: sessionId, cycle: { tontineId } },
      include: { cycle: { include: { tontine: true } } },
    });
    if (!session) return res.status(404).json({ erreur: 'Session introuvable' });
    if (session.statut === 'DISTRIBUEE' || session.statut === 'ANNULEE') {
      return res.status(400).json({ erreur: 'Cette session est clôturée' });
    }

    // Vérifier si déjà payé
    const dejaPayé = await prisma.paiement.findFirst({ where: { sessionId, payeurId: cibleId, statut: 'VALIDE' } });
    if (dejaPayé) return res.status(400).json({ erreur: 'Ce membre a déjà payé pour cette session' });

    // Calcul des pénalités
    const tontine = session.cycle.tontine;
    const maintenant = new Date();
    const dateLimite = new Date(session.datePlanifiee);
    dateLimite.setDate(dateLimite.getDate() + tontine.delaiPenaliteJours);
    let montantPenalite = 0;

    if (maintenant > dateLimite) {
      montantPenalite = tontine.typePenalite === 'POURCENTAGE'
        ? (Number(montant) * Number(tontine.valeurPenalite)) / 100
        : Number(tontine.valeurPenalite);
    }

    const paiement = await prisma.paiement.create({
      data: {
        sessionId,
        payeurId: cibleId,
        montant: Number(montant),
        montantPenalite,
        methodePaiement: methodePaiement || 'ESPECES',
        reference,
        note,
        payeLe: new Date(),
        statut: 'EN_ATTENTE',
      },
      include: { payeur: { select: { nom: true, prenom: true } }, session: true },
    });

    // Notifier le trésorier/admin
    const admins = await prisma.tontineMembre.findMany({
      where: { tontineId, role: { in: ['ADMINISTRATEUR', 'TRESORIER'] }, statut: 'ACTIF' },
    });
    const io = req.app.get('io');
    for (const admin of admins) {
      await envoyerNotification({
        userId: admin.membreId,
        titre: '💰 Paiement à valider',
        corps: `${paiement.payeur.prenom} ${paiement.payeur.nom} a enregistré un paiement de ${montant} FCFA`,
        type: 'PAIEMENT_RECU',
        io,
      });
    }

    await journaliser({ acteurId: req.user.id, tontineId, action: 'ENREGISTREMENT_PAIEMENT', entiteType: 'Paiement', entiteId: paiement.id, nouvellesValeurs: { montant, montantPenalite }, req });
    res.status(201).json(paiement);
  } catch {
    res.status(500).json({ erreur: 'Erreur lors de l\'enregistrement du paiement' });
  }
});

// POST /api/tontines/:tontineId/paiements/:paiementId/valider
router.post('/:tontineId/paiements/:paiementId/valider', authentifier, autoriserRole('ADMINISTRATEUR', 'TRESORIER'), async (req, res) => {
  try {
    const paiement = await prisma.paiement.update({
      where: { id: req.params.paiementId },
      data: { statut: 'VALIDE', valideLe: new Date(), valideParId: req.user.id },
      include: {
        payeur: { select: { id: true, nom: true, prenom: true } },
        session: { include: { cycle: { include: { tontine: true } } } },
      },
    });

    // Améliorer le score de fiabilité si payé à temps
    const retard = paiement.montantPenalite > 0;
    await prisma.user.update({
      where: { id: paiement.payeurId },
      data: { scoreFilabilite: { increment: retard ? -5 : 2 } },
    });

    // Notifier le payeur
    await envoyerNotification({
      userId: paiement.payeurId,
      titre: '✅ Paiement validé',
      corps: `Votre paiement de ${paiement.montant} FCFA a été validé. Reçu N° ${paiement.numerRecu}`,
      type: 'PAIEMENT_RECU',
      io: req.app.get('io'),
    });

    // Vérifier si tous les membres ont payé → distribuer automatiquement
    await verifierEtDistribuer(paiement.session, req);

    await journaliser({ acteurId: req.user.id, tontineId: req.params.tontineId, action: 'VALIDATION_PAIEMENT', entiteType: 'Paiement', entiteId: paiement.id, req });
    res.json(paiement);
  } catch {
    res.status(500).json({ erreur: 'Erreur lors de la validation' });
  }
});

// POST /api/tontines/:tontineId/paiements/:paiementId/rejeter
router.post('/:tontineId/paiements/:paiementId/rejeter', authentifier, autoriserRole('ADMINISTRATEUR', 'TRESORIER'), async (req, res) => {
  const { raison } = req.body;
  const paiement = await prisma.paiement.update({
    where: { id: req.params.paiementId },
    data: { statut: 'REJETE', note: raison },
    include: { payeur: { select: { id: true } } },
  });

  await envoyerNotification({
    userId: paiement.payeurId,
    titre: '❌ Paiement rejeté',
    corps: `Votre paiement a été rejeté. Raison : ${raison || 'Non précisée'}`,
    type: 'SYSTEME',
    io: req.app.get('io'),
  });

  res.json(paiement);
});

// GET /api/tontines/:tontineId/sessions/:sessionId/tableau
router.get('/:tontineId/sessions/:sessionId/tableau', authentifier, membreDeLaTontine, async (req, res) => {
  const session = await prisma.session.findFirst({
    where: { id: req.params.sessionId, cycle: { tontineId: req.params.tontineId } },
    include: {
      paiements: {
        include: { payeur: { select: { id: true, nom: true, prenom: true, avatarUrl: true } } },
      },
      cycle: { include: { tontine: { include: { membres: { where: { statut: 'ACTIF' }, include: { membre: { select: { id: true, nom: true, prenom: true } } } } } } } },
    },
  });
  if (!session) return res.status(404).json({ erreur: 'Session introuvable' });

  const paiementsValides = session.paiements.filter((p) => p.statut === 'VALIDE');
  const membresAyantPaye = new Set(paiementsValides.map((p) => p.payeurId));

  const tableau = session.cycle.tontine.membres.map((m) => ({
    membre: m.membre,
    aPayé: membresAyantPaye.has(m.membreId),
    paiement: session.paiements.find((p) => p.payeurId === m.membreId) || null,
  }));

  res.json({ session, tableau, totalCollecte: paiementsValides.reduce((s, p) => s + Number(p.montant), 0) });
});

// Logique de distribution automatique
async function verifierEtDistribuer(session, req) {
  const tontine = session.cycle.tontine;
  const membres = await prisma.tontineMembre.findMany({ where: { tontineId: tontine.id, statut: 'ACTIF' } });
  const paiementsValides = await prisma.paiement.count({ where: { sessionId: session.id, statut: 'VALIDE' } });

  if (paiementsValides >= membres.length && session.beneficiaireId) {
    const montantTotal = membres.length * Number(tontine.montantCotisation);
    await prisma.session.update({
      where: { id: session.id },
      data: { statut: 'DISTRIBUEE', dateEffective: new Date(), montantDistribue: montantTotal },
    });

    await envoyerNotification({
      userId: session.beneficiaireId,
      titre: '🎉 Distribution reçue !',
      corps: `Vous avez reçu ${montantTotal} FCFA de la tontine "${tontine.nom}"`,
      type: 'DISTRIBUTION',
      io: req.app.get('io'),
    });
  }
}

module.exports = router;
