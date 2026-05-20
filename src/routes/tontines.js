const router = require('express').Router();
const { prisma } = require('../utils/prisma');
const { authentifier, autoriserRole, membreDeLaTontine } = require('../middleware/auth');
const { journaliser } = require('../utils/audit');
const { notifierMembresTontine } = require('../utils/notifications');

// GET /api/tontines — mes tontines
router.get('/', authentifier, async (req, res) => {
  const tontines = await prisma.tontine.findMany({
    where: { membres: { some: { membreId: req.user.id, statut: 'ACTIF' } } },
    include: {
      _count: { select: { membres: { where: { statut: 'ACTIF' } } } },
      cycles: { orderBy: { numeroCycle: 'desc' }, take: 1 },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(tontines);
});

// POST /api/tontines — créer une tontine
router.post('/', authentifier, async (req, res) => {
  try {
    const {
      nom, description, montantCotisation, frequence, nombreMembres,
      modeTirage, typePenalite, valeurPenalite, delaiPenaliteJours,
      avecCredit, tauxInteretCredit,
    } = req.body;

    const tontine = await prisma.$transaction(async (tx) => {
      const t = await tx.tontine.create({
        data: {
          nom, description,
          montantCotisation: Number(montantCotisation),
          frequence, nombreMembres: Number(nombreMembres),
          modeTirage: modeTirage || 'ALEATOIRE',
          typePenalite: typePenalite || 'POURCENTAGE',
          valeurPenalite: Number(valeurPenalite) || 5,
          delaiPenaliteJours: Number(delaiPenaliteJours) || 3,
          avecCredit: Boolean(avecCredit),
          tauxInteretCredit: tauxInteretCredit ? Number(tauxInteretCredit) : null,
          createurId: req.user.id,
        },
      });

      // Le créateur devient automatiquement administrateur
      await tx.tontineMembre.create({
        data: {
          tontineId: t.id, membreId: req.user.id,
          role: 'ADMINISTRATEUR', statut: 'ACTIF',
        },
      });

      // Génération du règlement intérieur automatique
      const contenuReglement = genererReglement(t, req.user);
      await tx.reglement.create({
        data: { tontineId: t.id, contenu: contenuReglement, version: 1 },
      });

      return t;
    });

    await journaliser({ acteurId: req.user.id, tontineId: tontine.id, action: 'CREATION_TONTINE', entiteType: 'Tontine', entiteId: tontine.id, req });
    res.status(201).json(tontine);
  } catch (err) {
    res.status(500).json({ erreur: 'Erreur lors de la création de la tontine' });
  }
});

// GET /api/tontines/:tontineId
router.get('/:tontineId', authentifier, membreDeLaTontine, async (req, res) => {
  const tontine = await prisma.tontine.findUnique({
    where: { id: req.params.tontineId },
    include: {
      membres: {
        where: { statut: 'ACTIF' },
        include: { membre: { select: { id: true, nom: true, prenom: true, avatarUrl: true, scoreFilabilite: true } } },
        orderBy: { position: 'asc' },
      },
      cycles: {
        orderBy: { numeroCycle: 'desc' }, take: 1,
        include: {
          sessions: {
            orderBy: { numeroSession: 'asc' },
            include: { paiements: true },
          },
        },
      },
      reglements: { where: { actif: true }, include: { signatures: true } },
    },
  });
  if (!tontine) return res.status(404).json({ erreur: 'Tontine introuvable' });
  res.json(tontine);
});

// PUT /api/tontines/:tontineId — modifier
router.put('/:tontineId', authentifier, autoriserRole('ADMINISTRATEUR'), async (req, res) => {
  const { nom, description } = req.body;
  const tontine = await prisma.tontine.update({
    where: { id: req.params.tontineId },
    data: { nom, description },
  });
  res.json(tontine);
});

// POST /api/tontines/:tontineId/demarrer — démarrer le cycle
router.post('/:tontineId/demarrer', authentifier, autoriserRole('ADMINISTRATEUR'), async (req, res) => {
  try {
    const tontine = await prisma.tontine.findUnique({
      where: { id: req.params.tontineId },
      include: {
        membres: { where: { statut: 'ACTIF' } },
        reglements: { where: { actif: true }, include: { signatures: true } },
      },
    });

    if (!tontine) return res.status(404).json({ erreur: 'Tontine introuvable' });
    if (tontine.statut !== 'OUVERTE') return res.status(400).json({ erreur: 'La tontine n\'est pas ouverte' });
    if (tontine.membres.length < 2) return res.status(400).json({ erreur: 'Minimum 2 membres requis' });

    const reglement = tontine.reglements[0];
    const signataires = reglement?.signatures.map((s) => s.membreId) || [];
    const nonSignataires = tontine.membres.filter((m) => !signataires.includes(m.membreId));
    if (nonSignataires.length > 0) {
      return res.status(400).json({ erreur: 'Tous les membres doivent signer le règlement avant de démarrer', nonSignataires });
    }

    // Créer le premier cycle et les sessions
    const cycle = await prisma.$transaction(async (tx) => {
      const c = await tx.cycle.create({
        data: { tontineId: tontine.id, numeroCycle: 1, dateDebut: new Date() },
      });

      const membres = tontine.membres.sort((a, b) => (a.position || 0) - (b.position || 0));
      const frequenceJours = { HEBDOMADAIRE: 7, BIMENSUELLE: 14, MENSUELLE: 30, TRIMESTRIELLE: 90 };
      const jours = frequenceJours[tontine.frequence] || 30;

      for (let i = 0; i < membres.length; i++) {
        const datePlanifiee = new Date();
        datePlanifiee.setDate(datePlanifiee.getDate() + jours * (i + 1));
        await tx.session.create({
          data: {
            cycleId: c.id,
            numeroSession: i + 1,
            datePlanifiee,
            beneficiaireId: membres[i].membreId,
          },
        });
      }

      await tx.tontine.update({ where: { id: tontine.id }, data: { statut: 'EN_COURS' } });
      return c;
    });

    await notifierMembresTontine({
      tontineId: tontine.id,
      titre: '🚀 Tontine démarrée !',
      corps: `La tontine "${tontine.nom}" a démarré. Consultez le calendrier des sessions.`,
      type: 'SYSTEME',
      io: req.app.get('io'),
    });

    await journaliser({ acteurId: req.user.id, tontineId: tontine.id, action: 'DEMARRAGE_TONTINE', entiteType: 'Cycle', entiteId: cycle.id, req });
    res.json({ message: 'Tontine démarrée avec succès', cycle });
  } catch (err) {
    res.status(500).json({ erreur: 'Erreur lors du démarrage' });
  }
});

// POST /api/tontines/:tontineId/ouvrir
router.post('/:tontineId/ouvrir', authentifier, autoriserRole('ADMINISTRATEUR'), async (req, res) => {
  const tontine = await prisma.tontine.update({
    where: { id: req.params.tontineId, statut: 'BROUILLON' },
    data: { statut: 'OUVERTE' },
  });
  res.json(tontine);
});

// GET /api/tontines/:tontineId/statistiques
router.get('/:tontineId/statistiques', authentifier, membreDeLaTontine, async (req, res) => {
  const tontineId = req.params.tontineId;

  const [totalCollecte, totalDistribue, paiementsEnRetard, membresActifs] = await Promise.all([
    prisma.paiement.aggregate({
      where: { session: { cycle: { tontineId } }, statut: 'VALIDE' },
      _sum: { montant: true, montantPenalite: true },
    }),
    prisma.session.aggregate({
      where: { cycle: { tontineId }, statut: 'DISTRIBUEE' },
      _sum: { montantDistribue: true },
    }),
    prisma.paiement.count({
      where: { session: { cycle: { tontineId } }, statut: 'EN_ATTENTE', payeLe: null },
    }),
    prisma.tontineMembre.count({ where: { tontineId, statut: 'ACTIF' } }),
  ]);

  res.json({
    totalCollecte: totalCollecte._sum.montant || 0,
    totalPenalites: totalCollecte._sum.montantPenalite || 0,
    totalDistribue: totalDistribue._sum.montantDistribue || 0,
    paiementsEnRetard,
    membresActifs,
  });
});

// GET /api/tontines/:tontineId/audit
router.get('/:tontineId/audit', authentifier, autoriserRole('ADMINISTRATEUR', 'TRESORIER'), async (req, res) => {
  const logs = await prisma.auditLog.findMany({
    where: { tontineId: req.params.tontineId },
    include: { acteur: { select: { id: true, nom: true, prenom: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json(logs);
});

// Génération automatique du règlement
function genererReglement(tontine, createur) {
  const freq = { HEBDOMADAIRE: 'hebdomadaire', BIMENSUELLE: 'bimensuelle', MENSUELLE: 'mensuelle', TRIMESTRIELLE: 'trimestrielle' };
  return `RÈGLEMENT INTÉRIEUR DE LA TONTINE "${tontine.nom.toUpperCase()}"

Créée le ${new Date().toLocaleDateString('fr-FR')} par ${createur.prenom} ${createur.nom}.

ARTICLE 1 - COTISATION
Chaque membre verse ${tontine.montantCotisation} FCFA de façon ${freq[tontine.frequence] || tontine.frequence}.

ARTICLE 2 - PÉNALITÉS
Tout retard de paiement dépassant ${tontine.delaiPenaliteJours} jours entraîne une pénalité de ${tontine.valeurPenalite}${tontine.typePenalite === 'POURCENTAGE' ? '%' : ' FCFA'}.

ARTICLE 3 - ORDRE DE PASSAGE
L'ordre de bénéficiaires est déterminé par tirage ${tontine.modeTirage === 'ALEATOIRE' ? 'aléatoire transparent' : tontine.modeTirage === 'ENCHERES' ? 'au meilleur enchérisseur' : 'manuel validé collectivement'}.

ARTICLE 4 - RÉSOLUTION DES LITIGES
Tout différend est soumis à un vote majoritaire des membres actifs.

ARTICLE 5 - EXCLUSION
Un membre peut être exclu par vote majoritaire (>50%) en cas de manquements répétés.

ARTICLE 6 - SORTIE VOLONTAIRE
Un membre souhaitant quitter doit en informer l'administrateur. Il reste redevable de ses cotisations jusqu'à la fin du cycle.

En signant ce règlement, je m'engage à respecter l'ensemble des dispositions ci-dessus.`;
}

module.exports = router;
