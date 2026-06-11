/**
 * Tests API — Routes Assistant IA + Objectifs Épargne
 */
process.env.JWT_SECRET = 'secret_test_pour_jest_minimum_32_caracteres_ok';
process.env.JWT_REFRESH_SECRET = 'refresh_secret_test_jest_32_caracteres_ok__';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const { app } = require('../app');
const jwt = require('jsonwebtoken');

// ─── Mock Prisma ────────────────────────────────────────────────────────────
const mockUser = {
  id: 'user-uuid-123',
  nom: 'Koné',
  prenom: 'Aminata',
  email: 'admin@susupay.com',
  scoreFilabilite: 90,
  twoFaActive: false,
  isActive: true,
  isVerified: true,
};

const mockObjectif = {
  id: 'obj-uuid-1',
  userId: 'user-uuid-123',
  nom: 'Achat voiture',
  icone: '🚗',
  couleur: 'blue',
  montantCible: 2000000,
  montantActuel: 500000,
  termine: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  versements: [],
};

jest.mock('../utils/prisma', () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'user-uuid-123', nom: 'Koné', prenom: 'Aminata',
        email: 'admin@susupay.com', scoreFilabilite: 90,
        twoFaActive: false, isActive: true, isVerified: true,
      }),
    },
    tontine: { findMany: jest.fn().mockResolvedValue([]) },
    objectifEpargne: {
      create: jest.fn().mockResolvedValue({
        id: 'obj-uuid-1', userId: 'user-uuid-123', nom: 'Achat voiture',
        icone: '🚗', couleur: 'blue', montantCible: 2000000,
        montantActuel: 500000, termine: false,
        createdAt: new Date(), updatedAt: new Date(), versements: [],
      }),
      findMany: jest.fn().mockResolvedValue([{
        id: 'obj-uuid-1', userId: 'user-uuid-123', nom: 'Achat voiture',
        montantCible: 2000000, montantActuel: 500000,
        termine: false, createdAt: new Date(), versements: [],
      }]),
      findUnique: jest.fn().mockResolvedValue({
        id: 'obj-uuid-1', userId: 'user-uuid-123', nom: 'Achat voiture',
        montantCible: 2000000, montantActuel: 500000, termine: false,
      }),
      findFirst: jest.fn().mockResolvedValue({
        id: 'obj-uuid-1', userId: 'user-uuid-123', nom: 'Achat voiture',
        montantCible: 2000000, montantActuel: 500000, termine: false,
      }),
      update: jest.fn().mockResolvedValue({ id: 'obj-uuid-1', montantActuel: 600000, versements: [] }),
      delete: jest.fn().mockResolvedValue({ id: 'obj-uuid-1' }),
      aggregate: jest.fn().mockResolvedValue({
        _sum: { montantActuel: 500000, montantCible: 2000000 }, _count: { id: 1 },
      }),
    },
    versementObjectif: {
      create: jest.fn().mockResolvedValue({
        id: 'v-1', objectifId: 'obj-uuid-1', montant: 100000, createdAt: new Date(),
      }),
    },
    $transaction: jest.fn().mockResolvedValue([
      { id: 'v-1', objectifId: 'obj-uuid-1', montant: 100000, createdAt: new Date() },
      { id: 'obj-uuid-1', montantActuel: 600000, versements: [] },
    ]),
    $executeRawUnsafe: jest.fn().mockResolvedValue(null),
  },
}));

// Token JWT valide pour les tests
const token = jwt.sign({ userId: 'user-uuid-123' }, process.env.JWT_SECRET, { expiresIn: '1h' });

// ─── Tests Assistant ─────────────────────────────────────────────────────────
describe('POST /api/assistant/chat', () => {
  it('retourne une réponse fallback si ANTHROPIC_API_KEY absente', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await request(app)
      .post('/api/assistant/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ messages: [{ role: 'user', content: 'bonjour' }] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('content');
    expect(res.body.model).toBe('fallback');
  });

  it('retourne 400 si messages absent', async () => {
    const res = await request(app)
      .post('/api/assistant/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.erreur).toMatch(/messages/i);
  });

  it('retourne 400 si messages vide', async () => {
    const res = await request(app)
      .post('/api/assistant/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ messages: [] });

    expect(res.status).toBe(400);
  });

  it('retourne 401 sans token', async () => {
    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: 'bonjour' }] });

    expect(res.status).toBe(401);
  });
});

describe('GET /api/assistant/suggestions', () => {
  it('retourne 4 suggestions au maximum', async () => {
    const res = await request(app)
      .get('/api/assistant/suggestions')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('suggestions');
    expect(Array.isArray(res.body.suggestions)).toBe(true);
    expect(res.body.suggestions.length).toBeLessThanOrEqual(4);
  });

  it('retourne 401 sans token', async () => {
    const res = await request(app).get('/api/assistant/suggestions');
    expect(res.status).toBe(401);
  });
});

// ─── Tests Objectifs Épargne ─────────────────────────────────────────────────
describe('GET /api/objectifs', () => {
  it('retourne la liste des objectifs avec stats', async () => {
    const res = await request(app)
      .get('/api/objectifs')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('objectifs');
    expect(res.body).toHaveProperty('stats');
    expect(res.body.stats).toHaveProperty('totalEpargne');
    expect(res.body.stats).toHaveProperty('totalCible');
  });

  it('retourne 401 sans token', async () => {
    const res = await request(app).get('/api/objectifs');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/objectifs', () => {
  it('crée un objectif avec les champs requis', async () => {
    const res = await request(app)
      .post('/api/objectifs')
      .set('Authorization', `Bearer ${token}`)
      .send({ nom: 'Achat voiture', montantCible: 2000000 });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('nom', 'Achat voiture');
  });

  it('retourne 400 si nom manquant', async () => {
    const res = await request(app)
      .post('/api/objectifs')
      .set('Authorization', `Bearer ${token}`)
      .send({ montantCible: 2000000 });

    expect(res.status).toBe(400);
  });

  it('retourne 400 si montantCible manquant', async () => {
    const res = await request(app)
      .post('/api/objectifs')
      .set('Authorization', `Bearer ${token}`)
      .send({ nom: 'Achat voiture' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/objectifs/:id/verser', () => {
  it('ajoute un versement à un objectif', async () => {
    const res = await request(app)
      .post('/api/objectifs/obj-uuid-1/verser')
      .set('Authorization', `Bearer ${token}`)
      .send({ montant: 100000 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('versement');
  });

  it('retourne 400 si montant manquant', async () => {
    const res = await request(app)
      .post('/api/objectifs/obj-uuid-1/verser')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });
});
