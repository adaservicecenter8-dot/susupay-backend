const router = require('express').Router();
const PDFDocument = require('pdfkit');
const { prisma } = require('../utils/prisma');
const { authentifier, membreDeLaTontine } = require('../middleware/auth');

// GET /api/exports/:tontineId/pdf — rapport PDF complet
router.get('/:tontineId/pdf', authentifier, async (req, res) => {
  try {
    const tontineId = req.params.tontineId;

    // Vérifier l'accès
    const membre = await prisma.tontineMembre.findUnique({
      where: { tontineId_membreId: { tontineId, membreId: req.user.id } },
    });
    if (!membre) return res.status(403).json({ erreur: 'Accès refusé' });

    const tontine = await prisma.tontine.findUnique({
      where: { id: tontineId },
      include: {
        membres: {
          where: { statut: 'ACTIF' },
          include: { membre: { select: { nom: true, prenom: true, telephone: true } } },
        },
        cycles: {
          include: {
            sessions: {
              include: {
                paiements: {
                  where: { statut: 'VALIDE' },
                  include: { payeur: { select: { nom: true, prenom: true } } },
                },
              },
            },
          },
        },
      },
    });

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="tontine_${tontine.nom.replace(/\s/g, '_')}.pdf"`);
    doc.pipe(res);

    // En-tête
    doc.fontSize(22).font('Helvetica-Bold').text(`Rapport de Tontine`, { align: 'center' });
    doc.fontSize(16).font('Helvetica').text(tontine.nom, { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Généré le ${new Date().toLocaleDateString('fr-FR')} à ${new Date().toLocaleTimeString('fr-FR')}`, { align: 'right' });
    doc.moveDown();

    // Informations générales
    doc.fontSize(14).font('Helvetica-Bold').text('Informations générales');
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica');
    doc.text(`Cotisation : ${tontine.montantCotisation} FCFA / ${tontine.frequence.toLowerCase()}`);
    doc.text(`Statut : ${tontine.statut}`);
    doc.text(`Membres actifs : ${tontine.membres.length} / ${tontine.nombreMembres}`);
    doc.text(`Mode tirage : ${tontine.modeTirage}`);
    doc.text(`Pénalité : ${tontine.valeurPenalite}${tontine.typePenalite === 'POURCENTAGE' ? '%' : ' FCFA'} après ${tontine.delaiPenaliteJours} jours`);
    doc.moveDown();

    // Liste des membres
    doc.fontSize(14).font('Helvetica-Bold').text('Liste des membres');
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);
    tontine.membres.forEach((m, i) => {
      doc.fontSize(10).font('Helvetica').text(`${i + 1}. ${m.membre.prenom} ${m.membre.nom} (${m.role}) - Position: ${m.position || 'Non définie'}`);
    });
    doc.moveDown();

    // Historique des sessions
    doc.fontSize(14).font('Helvetica-Bold').text('Historique des sessions');
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    for (const cycle of tontine.cycles) {
      doc.fontSize(12).font('Helvetica-Bold').text(`Cycle ${cycle.numeroCycle}`);
      for (const session of cycle.sessions) {
        doc.fontSize(10).font('Helvetica');
        doc.text(`  Session ${session.numeroSession} — ${new Date(session.datePlanifiee).toLocaleDateString('fr-FR')} — ${session.statut}`);
        doc.text(`  Paiements validés : ${session.paiements.length}`);
        if (session.montantDistribue) doc.text(`  Montant distribué : ${session.montantDistribue} FCFA`);
      }
    }

    doc.end();
  } catch (err) {
    res.status(500).json({ erreur: 'Erreur lors de la génération du PDF' });
  }
});

// GET /api/exports/:tontineId/reglement-pdf — règlement signé
router.get('/:tontineId/reglement-pdf', authentifier, async (req, res) => {
  const tontineId = req.params.tontineId;
  const reglement = await prisma.reglement.findFirst({
    where: { tontineId, actif: true },
    include: {
      signatures: {
        include: { membre: { select: { nom: true, prenom: true } } },
      },
      tontine: { select: { nom: true } },
    },
  });

  if (!reglement) return res.status(404).json({ erreur: 'Règlement introuvable' });

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="reglement_${reglement.tontine.nom.replace(/\s/g, '_')}.pdf"`);
  doc.pipe(res);

  doc.fontSize(18).font('Helvetica-Bold').text('RÈGLEMENT INTÉRIEUR', { align: 'center' });
  doc.moveDown();
  doc.fontSize(11).font('Helvetica').text(reglement.contenu);
  doc.moveDown(2);

  doc.fontSize(14).font('Helvetica-Bold').text('SIGNATURES ÉLECTRONIQUES');
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.5);

  reglement.signatures.forEach((s) => {
    doc.fontSize(10).font('Helvetica').text(`✓ ${s.membre.prenom} ${s.membre.nom} — Signé le ${new Date(s.signeLe).toLocaleString('fr-FR')}`);
  });

  doc.end();
});

module.exports = router;
