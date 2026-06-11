const router = require('express').Router();
const { prisma } = require('../utils/prisma');
const { authentifier, autoriserRole, membreDeLaTontine } = require('../middleware/auth');
const { journaliser } = require('../utils/audit');
const { envoyerNotification, notifierMembresTontine } = require('../utils/notifications');
const { valider, enregistrerPaiementSchema } = require('../services/validationSchemas');
const { verifierEtDistribuer, mettreAJourScore } = require('../services/paiementService');

// GET /api/tontines/:tontineId/paiements
router.get('/:tontineId/paiements', authentifier, membreDeLaTontine, async (req, res) => {
  const { sessionId, membreId, statut, page = 1 } = req.query;
  const limite = Math.min(Number(req.query.limite) || 50, 100); // max 100 par page
  const where = {
    session: { cycle: { tontineId: req.params.tontineId } },
    ...(sessionId && { sessionId }),
    ...(membreId && { payeurId: membreId }),
    ...(statut && { statut }),
  };
  const [paiements, total] = await Promise.all([
    prisma.paiement.findMany({
      where,
      include: {
        payeur: { select: { id: true, nom: true, prenom: true, avatarUrl: true } },
        session: { select: { id: true, numeroSession: true, datePlanifiee: true } },
      },
      orderBy: { enregistreLe: 'desc' },
      take: Number(limite),
      skip: (Number(page) - 1) * Number(limite),
    }),
    prisma.paiement.count({ where }),
  ]);
  res.json({ paiements, total, page: Number(page), totalPages: Math.ceil(total / Number(limite)) });
});

// POST /api/tontines/:tontineId/sessions/:sessionId/paiements — enregistrer un paiement
router.post('/:tontineId/sessions/:sessionId/paiements', authentifier, valider(enregistrerPaiementSchema), async (req, res) => {
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

    // KYC obligatoire pour les paiements >= 500 000 FCFA (Loi 2016-992 LCB-FT)
    const SEUIL_KYC = 500000;
    if (Number(montant) >= SEUIL_KYC) {
      const payeur = await prisma.user.findUnique({ where: { id: cibleId }, select: { kycStatut: true } });
      if (payeur?.kycStatut !== 'VALIDE') {
        return res.status(403).json({ erreur: 'Vérification d\'identité (KYC) requise pour les paiements ≥ 500 000 FCFA. Complétez votre KYC dans votre profil.', code: 'KYC_REQUIRED' });
      }
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
        lienAction: `/tontines/${tontineId}/paiements`,
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
    const appartient = await prisma.paiement.findFirst({
      where: { id: req.params.paiementId, session: { cycle: { tontineId: req.params.tontineId } } },
    });
    if (!appartient) return res.status(404).json({ erreur: 'Paiement introuvable dans cette tontine' });
    if (appartient.statut !== 'EN_ATTENTE') return res.status(400).json({ erreur: 'Ce paiement n\'est pas en attente de validation' });

    const paiement = await prisma.paiement.update({
      where: { id: req.params.paiementId },
      data: { statut: 'VALIDE', valideLe: new Date(), valideParId: req.user.id },
      include: {
        payeur: { select: { id: true, nom: true, prenom: true } },
        session: { include: { cycle: { include: { tontine: true } } } },
      },
    });

    const retard = paiement.montantPenalite > 0;
    await mettreAJourScore(paiement.payeurId, retard);

    // Notifier le payeur
    await envoyerNotification({
      userId: paiement.payeurId,
      titre: '✅ Paiement validé',
      corps: `Votre paiement de ${paiement.montant} FCFA a été validé`,
      type: 'PAIEMENT_RECU',
      lienAction: `/tontines/${req.params.tontineId}/paiements`,
      io: req.app.get('io'),
    });

    await verifierEtDistribuer(paiement.sessionId, req.app.get('io'));

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

// GET /api/tontines/:tontineId/export/csv
router.get('/:tontineId/export/csv', authentifier, membreDeLaTontine, async (req, res) => {
  try {
    const { sessionId } = req.query;
    const tontine = await prisma.tontine.findUnique({ where: { id: req.params.tontineId }, select: { nom: true } });

    const paiements = await prisma.paiement.findMany({
      where: {
        session: { cycle: { tontineId: req.params.tontineId } },
        ...(sessionId && { sessionId }),
      },
      include: {
        payeur: { select: { nom: true, prenom: true, telephone: true } },
        session: { select: { numeroSession: true, datePlanifiee: true } },
      },
      orderBy: [{ session: { numeroSession: 'asc' } }, { enregistreLe: 'asc' }],
    });

    const METHODES_FR = { ESPECES: 'Espèces', VIREMENT: 'Virement', ORANGE_MONEY: 'Orange Money', MTN_MONEY: 'MTN Money', WAVE: 'Wave', AUTRE: 'Autre' };
    const STATUTS_FR = { EN_ATTENTE: 'En attente', VALIDE: 'Validé', REJETE: 'Rejeté', REMBOURSE: 'Remboursé' };

    const lignes = [
      ['Membre', 'Téléphone', 'Session', 'Date prévue', 'Montant (FCFA)', 'Pénalité (FCFA)', 'Méthode', 'Statut', 'Date paiement'],
      ...paiements.map((p) => [
        `${p.payeur.prenom} ${p.payeur.nom}`,
        p.payeur.telephone || '',
        `Session ${p.session.numeroSession}`,
        new Date(p.session.datePlanifiee).toLocaleDateString('fr-FR'),
        Number(p.montant),
        Number(p.montantPenalite),
        METHODES_FR[p.methodePaiement] || p.methodePaiement,
        STATUTS_FR[p.statut] || p.statut,
        p.payeLe ? new Date(p.payeLe).toLocaleDateString('fr-FR') : '',
      ]),
    ];

    const csv = lignes.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
    const nomFichier = `paiements-${(tontine?.nom || 'tontine').replace(/[^a-z0-9]/gi, '_')}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nomFichier}"`);
    res.send('﻿' + csv);
  } catch {
    res.status(500).json({ erreur: 'Erreur export CSV' });
  }
});

// GET /api/tontines/:tontineId/historique
router.get('/:tontineId/historique', authentifier, membreDeLaTontine, async (req, res) => {
  try {
    const { page = 1, limite = 20 } = req.query;
    const paiements = await prisma.paiement.findMany({
      where: { session: { cycle: { tontineId: req.params.tontineId } } },
      include: {
        payeur: { select: { id: true, nom: true, prenom: true, avatarUrl: true } },
        session: { select: { numeroSession: true, datePlanifiee: true } },
      },
      orderBy: { enregistreLe: 'desc' },
      skip: (Number(page) - 1) * Number(limite),
      take: Number(limite),
    });
    const total = await prisma.paiement.count({ where: { session: { cycle: { tontineId: req.params.tontineId } } } });
    res.json({ paiements, total, page: Number(page), totalPages: Math.ceil(total / Number(limite)) });
  } catch {
    res.status(500).json({ erreur: 'Erreur historique' });
  }
});

module.exports = router;
