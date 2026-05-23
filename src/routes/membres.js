const router = require('express').Router();
const { prisma } = require('../utils/prisma');
const { authentifier, autoriserRole, membreDeLaTontine } = require('../middleware/auth');
const { journaliser } = require('../utils/audit');
const { envoyerNotification, notifierMembresTontine } = require('../utils/notifications');

// GET /api/tontines/:tontineId/membres
router.get('/:tontineId/membres', authentifier, membreDeLaTontine, async (req, res) => {
  const membres = await prisma.tontineMembre.findMany({
    where: { tontineId: req.params.tontineId },
    include: {
      membre: { select: { id: true, nom: true, prenom: true, avatarUrl: true, telephone: true, scoreFilabilite: true } },
    },
    orderBy: { position: 'asc' },
  });
  res.json(membres);
});

// POST /api/tontines/:tontineId/rejoindre — rejoindre via code d'invitation
router.post('/:tontineId/rejoindre', authentifier, async (req, res) => {
  try {
    const { codeInvitation } = req.body;
    const tontine = await prisma.tontine.findFirst({
      where: { id: req.params.tontineId, codeInvitation: { equals: codeInvitation, mode: 'insensitive' } },
      include: { membres: { where: { statut: 'ACTIF' } } },
    });

    if (!tontine) return res.status(404).json({ erreur: 'Tontine introuvable ou code invalide' });
    if (tontine.statut !== 'OUVERTE') return res.status(400).json({ erreur: 'Cette tontine n\'accepte plus de membres' });
    if (tontine.membres.length >= tontine.nombreMembres) return res.status(400).json({ erreur: 'La tontine est complète' });

    const dejaMembre = await prisma.tontineMembre.findUnique({
      where: { tontineId_membreId: { tontineId: tontine.id, membreId: req.user.id } },
    });
    if (dejaMembre) return res.status(400).json({ erreur: 'Vous êtes déjà membre de cette tontine' });

    // Transaction pour éviter la race condition sur la limite de membres
    let membre;
    try {
      membre = await prisma.$transaction(async (tx) => {
        const nbActuels = await tx.tontineMembre.count({ where: { tontineId: tontine.id, statut: 'ACTIF' } });
        if (nbActuels >= tontine.nombreMembres) throw new Error('COMPLET');
        return tx.tontineMembre.create({
          data: { tontineId: tontine.id, membreId: req.user.id, role: 'MEMBRE', statut: 'ACTIF' },
          include: { membre: { select: { nom: true, prenom: true } } },
        });
      });
    } catch (txErr) {
      if (txErr.message === 'COMPLET') return res.status(400).json({ erreur: 'La tontine est complète' });
      throw txErr;
    }

    await notifierMembresTontine({
      tontineId: tontine.id,
      titre: '👤 Nouveau membre',
      corps: `${req.user.prenom} ${req.user.nom} a rejoint la tontine "${tontine.nom}"`,
      type: 'SYSTEME',
      io: req.app.get('io'),
      exclureId: req.user.id,
    });

    await journaliser({ acteurId: req.user.id, tontineId: tontine.id, action: 'REJOINT_TONTINE', entiteType: 'TontineMembre', entiteId: membre.id, req });
    res.status(201).json(membre);
  } catch {
    res.status(500).json({ erreur: 'Erreur lors de la jonction' });
  }
});

// POST /api/tontines/:tontineId/membres/:membreId/role
router.put('/:tontineId/membres/:membreId/role', authentifier, autoriserRole('ADMINISTRATEUR'), async (req, res) => {
  const { role } = req.body;
  const roles = ['ADMINISTRATEUR', 'TRESORIER', 'MEMBRE'];
  if (!roles.includes(role)) return res.status(400).json({ erreur: 'Rôle invalide' });

  const membre = await prisma.tontineMembre.update({
    where: { tontineId_membreId: { tontineId: req.params.tontineId, membreId: req.params.membreId } },
    data: { role },
  });

  await journaliser({ acteurId: req.user.id, tontineId: req.params.tontineId, action: 'CHANGEMENT_ROLE', entiteType: 'TontineMembre', entiteId: membre.id, nouvellesValeurs: { role }, req });
  res.json(membre);
});

// DELETE /api/tontines/:tontineId/membres/:membreId/exclure
router.post('/:tontineId/membres/:membreId/exclure', authentifier, autoriserRole('ADMINISTRATEUR'), async (req, res) => {
  const { raison } = req.body;

  const membre = await prisma.tontineMembre.update({
    where: { tontineId_membreId: { tontineId: req.params.tontineId, membreId: req.params.membreId } },
    data: { statut: 'EXCLU', sortLe: new Date() },
    include: { membre: { select: { nom: true, prenom: true } }, tontine: { select: { nom: true } } },
  });

  // Réduire le score de fiabilité du membre exclu (borné à 0 minimum)
  await prisma.$executeRaw`
    UPDATE "users" SET "scoreFilabilite" = GREATEST(0, "scoreFilabilite" - 20)
    WHERE "id" = ${req.params.membreId}
  `;

  await envoyerNotification({
    userId: req.params.membreId,
    titre: 'Exclusion de tontine',
    corps: `Vous avez été exclu(e) de la tontine "${membre.tontine.nom}". Raison : ${raison || 'Non précisée'}`,
    type: 'SYSTEME',
    io: req.app.get('io'),
  });

  await journaliser({ acteurId: req.user.id, tontineId: req.params.tontineId, action: 'EXCLUSION_MEMBRE', entiteType: 'TontineMembre', entiteId: membre.id, nouvellesValeurs: { raison }, req });
  res.json({ message: 'Membre exclu avec succès' });
});

// GET /api/tontines/inviter/:code — trouver tontine par code
router.get('/inviter/:code', authentifier, async (req, res) => {
  const tontine = await prisma.tontine.findFirst({
    where: { codeInvitation: { equals: req.params.code, mode: 'insensitive' } },
    select: {
      id: true, nom: true, description: true, montantCotisation: true,
      frequence: true, nombreMembres: true, statut: true,
      _count: { select: { membres: { where: { statut: 'ACTIF' } } } },
    },
  });
  if (!tontine) return res.status(404).json({ erreur: 'Code d\'invitation invalide' });
  res.json(tontine);
});

// POST /api/tontines/:tontineId/membres/:membreId/position
router.put('/:tontineId/membres/:membreId/position', authentifier, autoriserRole('ADMINISTRATEUR'), async (req, res) => {
  const { position } = req.body;

  // Vérifier que la tontine n'est pas encore démarrée
  const tontine = await prisma.tontine.findUnique({ where: { id: req.params.tontineId } });
  if (tontine?.statut === 'EN_COURS') return res.status(400).json({ erreur: 'Impossible de modifier les positions en cours de cycle' });

  const membre = await prisma.tontineMembre.update({
    where: { tontineId_membreId: { tontineId: req.params.tontineId, membreId: req.params.membreId } },
    data: { position: Number(position) },
  });
  res.json(membre);
});

// POST /api/tontines/:tontineId/tirage-aleatoire
router.post('/:tontineId/tirage-aleatoire', authentifier, autoriserRole('ADMINISTRATEUR'), async (req, res) => {
  const membres = await prisma.tontineMembre.findMany({
    where: { tontineId: req.params.tontineId, statut: 'ACTIF' },
  });

  // Mélange Fisher-Yates
  const positions = membres.map((_, i) => i + 1);
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }

  await Promise.all(
    membres.map((m, i) =>
      prisma.tontineMembre.update({
        where: { tontineId_membreId: { tontineId: req.params.tontineId, membreId: m.membreId } },
        data: { position: positions[i] },
      })
    )
  );

  await notifierMembresTontine({
    tontineId: req.params.tontineId,
    titre: '🎲 Tirage effectué !',
    corps: 'L\'ordre de passage a été tiré au sort. Consultez votre position.',
    type: 'SYSTEME',
    io: req.app.get('io'),
  });

  const membresAvecPositions = await prisma.tontineMembre.findMany({
    where: { tontineId: req.params.tontineId, statut: 'ACTIF' },
    include: { membre: { select: { nom: true, prenom: true } } },
    orderBy: { position: 'asc' },
  });

  await journaliser({ acteurId: req.user.id, tontineId: req.params.tontineId, action: 'TIRAGE_ALEATOIRE', entiteType: 'Tontine', entiteId: req.params.tontineId, req });
  res.json(membresAvecPositions);
});

// POST /api/tontines/:tontineId/reglement/signer
router.post('/:tontineId/reglement/signer', authentifier, membreDeLaTontine, async (req, res) => {
  const reglement = await prisma.reglement.findFirst({
    where: { tontineId: req.params.tontineId, actif: true },
  });
  if (!reglement) return res.status(404).json({ erreur: 'Règlement introuvable' });

  const signature = await prisma.signatureReglement.upsert({
    where: { reglementId_membreId: { reglementId: reglement.id, membreId: req.user.id } },
    create: { reglementId: reglement.id, membreId: req.user.id, adresseIp: req.ip, userAgent: req.headers['user-agent'] },
    update: { signeLe: new Date() },
  });

  await journaliser({ acteurId: req.user.id, tontineId: req.params.tontineId, action: 'SIGNATURE_REGLEMENT', entiteType: 'SignatureReglement', entiteId: signature.id, req });
  res.json({ message: 'Règlement signé avec succès', signature });
});

// POST /api/tontines/:tontineId/quitter
router.post('/:tontineId/quitter', authentifier, async (req, res) => {
  try {
    const { tontineId } = req.params;
    const membre = await prisma.tontineMembre.findUnique({
      where: { tontineId_membreId: { tontineId, membreId: req.user.id } },
      include: { tontine: { select: { nom: true, statut: true, createurId: true } } },
    });
    if (!membre) return res.status(404).json({ erreur: 'Vous n\'êtes pas membre de cette tontine' });
    if (membre.tontine.createurId === req.user.id) return res.status(400).json({ erreur: 'Le créateur ne peut pas quitter sa propre tontine' });
    if (membre.tontine.statut === 'EN_COURS') return res.status(400).json({ erreur: 'Impossible de quitter une tontine en cours de cycle' });

    await prisma.tontineMembre.update({
      where: { tontineId_membreId: { tontineId, membreId: req.user.id } },
      data: { statut: 'SORTI', sortLe: new Date() },
    });

    await journaliser({ acteurId: req.user.id, tontineId, action: 'SORTIE_TONTINE', entiteType: 'TontineMembre', entiteId: membre.id, req });
    res.json({ message: `Vous avez quitté la tontine "${membre.tontine.nom}"` });
  } catch {
    res.status(500).json({ erreur: 'Erreur lors de la sortie' });
  }
});

module.exports = router;
