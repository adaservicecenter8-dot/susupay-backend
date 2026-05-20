const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding de la base de données...');

  // Création des utilisateurs de test
  const motDePasse = await bcrypt.hash('password123', 12);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@tontine.app' },
    update: {},
    create: {
      nom: 'Koné', prenom: 'Aminata', email: 'admin@tontine.app',
      telephone: '+221771234567', passwordHash: motDePasse,
      isVerified: true, scoreFilabilite: 98,
    },
  });

  const membre1 = await prisma.user.upsert({
    where: { email: 'membre1@tontine.app' },
    update: {},
    create: {
      nom: 'Diallo', prenom: 'Mamadou', email: 'membre1@tontine.app',
      telephone: '+221772345678', passwordHash: motDePasse,
      isVerified: true, scoreFilabilite: 95,
    },
  });

  const membre2 = await prisma.user.upsert({
    where: { email: 'membre2@tontine.app' },
    update: {},
    create: {
      nom: 'Traoré', prenom: 'Fatoumata', email: 'membre2@tontine.app',
      telephone: '+221773456789', passwordHash: motDePasse,
      isVerified: true, scoreFilabilite: 92,
    },
  });

  // Création d'une tontine de démonstration
  const tontine = await prisma.tontine.upsert({
    where: { codeInvitation: 'DEMO2024' },
    update: {},
    create: {
      nom: 'Tontine Famille Koné',
      description: 'Tontine mensuelle de la famille pour les grands projets',
      montantCotisation: 50000,
      frequence: 'MENSUELLE',
      nombreMembres: 5,
      modeTirage: 'ALEATOIRE',
      typePenalite: 'POURCENTAGE',
      valeurPenalite: 5,
      delaiPenaliteJours: 3,
      avecCredit: true,
      tauxInteretCredit: 2.5,
      statut: 'EN_COURS',
      codeInvitation: 'DEMO2024',
      createurId: admin.id,
    },
  });

  // Ajouter les membres
  await prisma.tontineMembre.upsert({
    where: { tontineId_membreId: { tontineId: tontine.id, membreId: admin.id } },
    update: {},
    create: { tontineId: tontine.id, membreId: admin.id, role: 'ADMINISTRATEUR', statut: 'ACTIF', position: 1 },
  });

  await prisma.tontineMembre.upsert({
    where: { tontineId_membreId: { tontineId: tontine.id, membreId: membre1.id } },
    update: {},
    create: { tontineId: tontine.id, membreId: membre1.id, role: 'TRESORIER', statut: 'ACTIF', position: 2 },
  });

  await prisma.tontineMembre.upsert({
    where: { tontineId_membreId: { tontineId: tontine.id, membreId: membre2.id } },
    update: {},
    create: { tontineId: tontine.id, membreId: membre2.id, role: 'MEMBRE', statut: 'ACTIF', position: 3 },
  });

  // Règlement
  await prisma.reglement.upsert({
    where: { id: 'seed-reglement' },
    update: {},
    create: {
      id: 'seed-reglement',
      tontineId: tontine.id,
      contenu: 'Règlement intérieur de la Tontine Famille Koné — Cotisation mensuelle de 50 000 FCFA. Pénalité de 5% après 3 jours de retard.',
      version: 1,
    },
  });

  console.log('✅ Seed terminé !');
  console.log('📧 Comptes de test :');
  console.log('   - admin@tontine.app / password123 (Administrateur)');
  console.log('   - membre1@tontine.app / password123 (Trésorier)');
  console.log('   - membre2@tontine.app / password123 (Membre)');
  console.log('🔑 Code invitation tontine démo : DEMO2024');
}

main().catch(console.error).finally(() => prisma.$disconnect());
