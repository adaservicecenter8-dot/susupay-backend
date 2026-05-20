const router = require('express').Router();
const { prisma } = require('../utils/prisma');
const { authentifier } = require('../middleware/auth');

// GET /api/notifications
router.get('/', authentifier, async (req, res) => {
  const { page = 1, limite = 30, nonLues } = req.query;
  const notifications = await prisma.notification.findMany({
    where: { userId: req.user.id, ...(nonLues === 'true' && { lu: false }) },
    orderBy: { createdAt: 'desc' },
    take: Number(limite),
    skip: (Number(page) - 1) * Number(limite),
  });

  const total = await prisma.notification.count({ where: { userId: req.user.id, lu: false } });
  res.json({ notifications, nonLues: total });
});

// PUT /api/notifications/:id/lue
router.put('/:id/lue', authentifier, async (req, res) => {
  await prisma.notification.update({ where: { id: req.params.id, userId: req.user.id }, data: { lu: true } });
  res.json({ ok: true });
});

// PUT /api/notifications/tout-lire
router.put('/tout-lire', authentifier, async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.user.id, lu: false }, data: { lu: true } });
  res.json({ ok: true });
});

module.exports = router;
