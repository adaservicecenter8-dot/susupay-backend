const router = require('express').Router();
const { prisma } = require('../utils/prisma');
const { authentifier } = require('../middleware/auth');

// ── GET /api/objectifs ─────────────────────────────────────────────
router.get('/', authentifier, async (req, res) => {
  const objectifs = await prisma.objectifEpargne.findMany({
    where: { userId: req.user.id },
    include: {
      versements: {
        orderBy: { createdAt: 'desc' },
        take: 5,
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const totalEpargne = objectifs.reduce((s, o) => s + Number(o.montantActuel), 0);
  const totalCible   = objectifs.reduce((s, o) => s + Number(o.montantCible), 0);
  const actifs       = objectifs.filter((o) => !o.termine).length;
  const termines     = objectifs.filter((o) => o.termine).length;

  res.json({ objectifs, stats: { totalEpargne, totalCible, actifs, termines } });
});

// ── POST /api/objectifs ────────────────────────────────────────────
router.post('/', authentifier, async (req, res) => {
  const { nom, description, icone, couleur, montantCible, dateEcheance } = req.body;
  if (!nom?.trim()) return res.status(400).json({ erreur: 'Nom requis' });
  if (!montantCible || Number(montantCible) <= 0) return res.status(400).json({ erreur: 'Montant cible invalide' });

  const objectif = await prisma.objectifEpargne.create({
    data: {
      userId: req.user.id,
      nom: nom.trim(),
      description: description?.trim() || null,
      icone: icone || '🎯',
      couleur: couleur || 'blue',
      montantCible: Number(montantCible),
      dateEcheance: dateEcheance ? new Date(dateEcheance) : null,
    },
    include: { versements: true },
  });
  res.status(201).json(objectif);
});

// ── PUT /api/objectifs/:id ─────────────────────────────────────────
router.put('/:id', authentifier, async (req, res) => {
  const objectif = await prisma.objectifEpargne.findUnique({ where: { id: req.params.id } });
  if (!objectif || objectif.userId !== req.user.id) return res.status(404).json({ erreur: 'Objectif introuvable' });

  const { nom, description, icone, couleur, montantCible, dateEcheance, termine } = req.body;
  const updated = await prisma.objectifEpargne.update({
    where: { id: req.params.id },
    data: {
      ...(nom !== undefined        && { nom: nom.trim() }),
      ...(description !== undefined && { description: description?.trim() || null }),
      ...(icone !== undefined       && { icone }),
      ...(couleur !== undefined     && { couleur }),
      ...(montantCible !== undefined && { montantCible: Number(montantCible) }),
      ...(dateEcheance !== undefined && { dateEcheance: dateEcheance ? new Date(dateEcheance) : null }),
      ...(termine !== undefined     && { termine }),
    },
    include: { versements: { orderBy: { createdAt: 'desc' }, take: 5 } },
  });
  res.json(updated);
});

// ── DELETE /api/objectifs/:id ──────────────────────────────────────
router.delete('/:id', authentifier, async (req, res) => {
  const objectif = await prisma.objectifEpargne.findUnique({ where: { id: req.params.id } });
  if (!objectif || objectif.userId !== req.user.id) return res.status(404).json({ erreur: 'Objectif introuvable' });
  await prisma.objectifEpargne.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// ── POST /api/objectifs/:id/verser ────────────────────────────────
router.post('/:id/verser', authentifier, async (req, res) => {
  const objectif = await prisma.objectifEpargne.findUnique({ where: { id: req.params.id } });
  if (!objectif || objectif.userId !== req.user.id) return res.status(404).json({ erreur: 'Objectif introuvable' });
  if (objectif.termine) return res.status(400).json({ erreur: 'Cet objectif est déjà terminé' });

  const { montant, note } = req.body;
  if (!montant || Number(montant) <= 0) return res.status(400).json({ erreur: 'Montant invalide' });

  const nouveauMontant = Number(objectif.montantActuel) + Number(montant);
  const estTermine     = nouveauMontant >= Number(objectif.montantCible);

  const [versement, updated] = await prisma.$transaction([
    prisma.versementObjectif.create({
      data: { objectifId: req.params.id, montant: Number(montant), note: note?.trim() || null },
    }),
    prisma.objectifEpargne.update({
      where: { id: req.params.id },
      data: { montantActuel: nouveauMontant, termine: estTermine },
      include: { versements: { orderBy: { createdAt: 'desc' }, take: 5 } },
    }),
  ]);

  res.json({ versement, objectif: updated, termineAujourdhui: estTermine });
});

// ── GET /api/objectifs/:id/versements ────────────────────────────
router.get('/:id/versements', authentifier, async (req, res) => {
  const objectif = await prisma.objectifEpargne.findUnique({ where: { id: req.params.id } });
  if (!objectif || objectif.userId !== req.user.id) return res.status(404).json({ erreur: 'Objectif introuvable' });

  const versements = await prisma.versementObjectif.findMany({
    where: { objectifId: req.params.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json(versements);
});

module.exports = router;
