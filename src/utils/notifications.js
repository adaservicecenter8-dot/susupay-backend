const { prisma } = require('./prisma');

async function envoyerNotification({ userId, titre, corps, type, lienAction, io }) {
  const notif = await prisma.notification.create({
    data: { userId, titre, corps, type, lienAction },
  });

  // Émettre en temps réel via Socket.IO
  if (io) {
    io.to(`user_${userId}`).emit('nouvelle_notification', notif);
  }

  return notif;
}

async function notifierMembresTontine({ tontineId, titre, corps, type, io, exclureId }) {
  const membres = await prisma.tontineMembre.findMany({
    where: { tontineId, statut: 'ACTIF' },
    select: { membreId: true },
  });

  const notifications = membres
    .filter((m) => m.membreId !== exclureId)
    .map((m) => ({ userId: m.membreId, titre, corps, type }));

  await prisma.notification.createMany({ data: notifications });

  if (io) {
    membres.forEach((m) => {
      if (m.membreId !== exclureId) {
        io.to(`user_${m.membreId}`).emit('nouvelle_notification', { titre, corps, type });
      }
    });
  }
}

module.exports = { envoyerNotification, notifierMembresTontine };
