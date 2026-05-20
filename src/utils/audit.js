const { prisma } = require('./prisma');

async function journaliser({ acteurId, tontineId, action, entiteType, entiteId, anciennesValeurs, nouvellesValeurs, req }) {
  await prisma.auditLog.create({
    data: {
      acteurId,
      tontineId,
      action,
      entiteType,
      entiteId,
      anciennesValeurs,
      nouvellesValeurs,
      adresseIp: req?.ip,
      userAgent: req?.headers?.['user-agent'],
    },
  });
}

module.exports = { journaliser };
