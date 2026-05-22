// Script de migration au démarrage
const { PrismaClient } = require('./generated/prisma');

const prisma = new PrismaClient();

async function migrer() {
  console.log('[migrate] Vérification des migrations...');
  try {
    // Rendre email nullable
    await prisma.$executeRaw`ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL`;
    console.log('[migrate] email nullable OK');
  } catch { /* Déjà nullable ou autre */ }

  try {
    // Rendre telephone nullable
    await prisma.$executeRaw`ALTER TABLE "users" ALTER COLUMN "telephone" DROP NOT NULL`;
    console.log('[migrate] telephone nullable OK');
  } catch { /* Déjà nullable */ }

  try {
    // Rendre passwordHash nullable
    await prisma.$executeRaw`ALTER TABLE "users" ALTER COLUMN "passwordHash" DROP NOT NULL`;
    console.log('[migrate] passwordHash nullable OK');
  } catch { /* Déjà nullable */ }

  try {
    // Ajouter googleId
    await prisma.$executeRaw`ALTER TABLE "users" ADD COLUMN "googleId" TEXT`;
    await prisma.$executeRaw`CREATE UNIQUE INDEX "users_googleId_key" ON "users"("googleId")`;
    console.log('[migrate] googleId OK');
  } catch { /* Déjà existe */ }

  try {
    // Créer table otp_codes
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "otp_codes" (
        "id" TEXT NOT NULL,
        "telephone" TEXT NOT NULL,
        "code" TEXT NOT NULL,
        "expireAt" TIMESTAMP(3) NOT NULL,
        "utilise" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
      )
    `;
    console.log('[migrate] otp_codes OK');
  } catch (e) {
    console.error('[migrate] Erreur otp_codes:', e.message);
  }

  await prisma.$disconnect();
  console.log('[migrate] Terminé.');
}

migrer().catch((e) => {
  console.error('[migrate] Erreur fatale:', e);
  process.exit(0); // Ne pas bloquer le démarrage
});
