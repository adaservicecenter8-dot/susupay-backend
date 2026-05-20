const jwt = require('jsonwebtoken');
const { prisma } = require('../utils/prisma');

// Vérifie le token JWT
async function authentifier(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ erreur: 'Token manquant ou invalide' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, nom: true, prenom: true, email: true, isActive: true, isVerified: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ erreur: 'Compte inactif ou introuvable' });
    }

    req.user = user;
    next();
  } catch {
    return res.status(401).json({ erreur: 'Token expiré ou invalide' });
  }
}

// Vérifie le rôle d'un membre dans une tontine
function autoriserRole(...roles) {
  return async (req, res, next) => {
    const tontineId = req.params.tontineId;
    if (!tontineId) return next();

    const membre = await prisma.tontineMembre.findUnique({
      where: { tontineId_membreId: { tontineId, membreId: req.user.id } },
    });

    if (!membre || !roles.includes(membre.role) || membre.statut !== 'ACTIF') {
      return res.status(403).json({ erreur: 'Permissions insuffisantes' });
    }

    req.membreRole = membre.role;
    next();
  };
}

// Vérifie qu'un membre appartient à la tontine
async function membreDeLaTontine(req, res, next) {
  const tontineId = req.params.tontineId;
  const membre = await prisma.tontineMembre.findUnique({
    where: { tontineId_membreId: { tontineId, membreId: req.user.id } },
  });

  if (!membre || membre.statut !== 'ACTIF') {
    return res.status(403).json({ erreur: 'Vous n\'êtes pas membre de cette tontine' });
  }

  req.membre = membre;
  next();
}

module.exports = { authentifier, autoriserRole, membreDeLaTontine };
