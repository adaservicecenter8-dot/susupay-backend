/**
 * Route POST /api/assistant/chat
 * Intègre Claude (Anthropic) pour l'assistant IA de SusuPay.
 * Supporte le streaming SSE et la réponse complète JSON.
 */
const express = require('express');
const router = express.Router();
const { authentifier: verifierToken } = require('../middleware/auth');
const { prisma } = require('../utils/prisma');
const { logger } = require('../utils/logger');

// Anthropic SDK (facultatif — graceful degradation si absent)
let Anthropic;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch {
  logger.warn('[Assistant] @anthropic-ai/sdk non installé — mode dégradé actif');
}

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 1024;

// ── Prompt système ────────────────────────────────────────────────────────────
const buildSystemPrompt = (user, tontines) => {
  const tontineResume = tontines.length > 0
    ? tontines.map(t =>
        `- ${t.nom} (${t.statut}) : ${t.montantCotisation.toLocaleString('fr')} FCFA/${t.frequence.toLowerCase()}, ${t._count?.membres || 0} membres`
      ).join('\n')
    : '- Aucune tontine pour le moment';

  return `Tu es SusuBot, l'assistant IA de SusuPay — une app d'épargne collective (tontines) pour l'Afrique de l'Ouest.
Tu parles UNIQUEMENT en français. Sois chaleureux, concis et utile.

CONTEXTE UTILISATEUR :
- Nom : ${user.prenom} ${user.nom}
- Score de fiabilité : ${user.scoreFilabilite}/100
- Mes tontines :
${tontineResume}

TES SPÉCIALITÉS :
1. 🏦 CRÉER UNE TONTINE : Guide pas-à-pas (nom, montant, fréquence, membres, règles)
2. 📊 SIMULER UNE ÉPARGNE : Calcule montants, durées, intérêts, projections
3. ⚠️  DÉTECTER LES RISQUES : Analyse les membres, retards, pénalités potentielles

RÈGLES :
- Réponds en 2-4 phrases maximum (sauf si simulation numérique demandée)
- Pour les simulations, présente les chiffres en tableau markdown
- Utilise des emojis avec parcimonie
- Si l'utilisateur veut créer une tontine, propose de le guider étape par étape
- Les montants sont toujours en FCFA (Franc CFA)
- Ne parle pas d'autres sujets que la finance et les tontines

EXEMPLES D'USAGE :
- "Combien vais-je épargner en 12 mois à 25 000 FCFA/mois ?" → calcul + projection
- "Je veux créer une tontine de 5 personnes" → guide interactif
- "Est-ce risqué d'inviter quelqu'un qui a 65/100 de fiabilité ?" → analyse risque`;
};

// ── Réponses dégradées (pas d'API Anthropic) ─────────────────────────────────
const FALLBACK_RESPONSES = [
  "Je suis temporairement indisponible. Réessayez dans quelques instants ! 🙏",
  "Mon cerveau est en pause momentanée. Revenez bientôt !",
  "Service momentanément indisponible. En attendant, explorez l'app !",
];

// ── POST /api/assistant/chat ──────────────────────────────────────────────────
router.post('/chat', verifierToken, async (req, res) => {
  const { messages, stream = false } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ erreur: 'messages[] requis' });
  }

  // Limiter l'historique à 10 échanges pour économiser les tokens
  const messagesLimites = messages.slice(-20).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content).slice(0, 2000), // max 2000 chars par message
  }));

  // Récupérer les données utilisateur pour le contexte
  let user, tontines;
  try {
    user = await prisma.user.findUnique({ where: { id: req.userId } });
    tontines = await prisma.tontine.findMany({
      where: { membres: { some: { membreId: req.userId, statut: 'ACTIF' } } },
      include: { _count: { select: { membres: true } } },
      take: 10,
    });
  } catch (err) {
    logger.error('[Assistant] Erreur récupération contexte:', err.message);
    user = { prenom: 'Utilisateur', nom: '', scoreFilabilite: 80 };
    tontines = [];
  }

  // Mode dégradé sans API Anthropic
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    logger.warn('[Assistant] ANTHROPIC_API_KEY manquante — réponse de fallback');
    const fallback = FALLBACK_RESPONSES[Math.floor(Math.random() * FALLBACK_RESPONSES.length)];
    return res.json({ content: fallback, model: 'fallback' });
  }

  const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
  const systemPrompt = buildSystemPrompt(user, tontines);

  // ── Mode streaming SSE ─────────────────────────────────────────────────────
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
      const streamResponse = await client.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: messagesLimites,
      });

      for await (const chunk of streamResponse) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ delta: chunk.delta.text })}\n\n`);
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      logger.error('[Assistant] Erreur streaming:', err.message);
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
    return;
  }

  // ── Mode réponse complète JSON ─────────────────────────────────────────────
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: messagesLimites,
    });

    const content = response.content?.[0]?.text || 'Je n\'ai pas pu générer de réponse.';
    res.json({
      content,
      model: response.model,
      usage: response.usage,
    });
  } catch (err) {
    logger.error('[Assistant] Erreur API Anthropic:', err.message);
    res.status(500).json({ erreur: 'Erreur lors de la génération de la réponse' });
  }
});

// ── GET /api/assistant/suggestions ───────────────────────────────────────────
// Renvoie des suggestions contextuelles basées sur l'état du compte
router.get('/suggestions', verifierToken, async (req, res) => {
  try {
    const tontines = await prisma.tontine.findMany({
      where: { membres: { some: { membreId: req.userId, statut: 'ACTIF' } } },
      include: {
        sessions: { where: { statut: 'EN_COURS' }, take: 1 },
        _count: { select: { membres: true } },
      },
      take: 5,
    });

    const suggestions = [];

    // Suggestions contextuelles
    if (tontines.length === 0) {
      suggestions.push({ id: 'creer', emoji: '🏦', texte: 'Créer ma première tontine', prompt: 'Je veux créer ma première tontine, guide-moi étape par étape.' });
    }

    const aCotisationEnCours = tontines.some(t => t.sessions.length > 0);
    if (aCotisationEnCours) {
      suggestions.push({ id: 'risque', emoji: '⚠️', texte: 'Analyser mes risques', prompt: 'Analyse les risques de mes tontines actuelles.' });
    }

    suggestions.push({ id: 'epargne', emoji: '📊', texte: 'Simuler une épargne', prompt: 'Aide-moi à simuler combien j\'épargnerai en cotisant 25 000 FCFA par mois pendant 12 mois.' });
    suggestions.push({ id: 'conseil', emoji: '💡', texte: 'Conseils pour ma tontine', prompt: 'Donne-moi des conseils pour bien gérer ma tontine et éviter les conflits.' });
    suggestions.push({ id: 'regles', emoji: '📋', texte: 'Créer un règlement', prompt: 'Aide-moi à rédiger un règlement intérieur clair pour ma tontine.' });

    res.json({ suggestions: suggestions.slice(0, 4) });
  } catch (err) {
    logger.error('[Assistant] Erreur suggestions:', err.message);
    res.json({ suggestions: [] });
  }
});

module.exports = router;
