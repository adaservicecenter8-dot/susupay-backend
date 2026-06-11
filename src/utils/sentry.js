/**
 * Configuration Sentry — Monitoring backend Node.js
 *
 * Pour activer : définir SENTRY_DSN dans les variables d'environnement Railway
 * Créer un compte gratuit sur https://sentry.io
 *
 * SENTRY_DSN=https://xxx@oXXX.ingest.sentry.io/XXXXX
 */
const Sentry = require('@sentry/node');

const DSN = process.env.SENTRY_DSN;

function initSentry(app) {
  if (!DSN) {
    // Pas de DSN → monitoring désactivé (OK en développement)
    return;
  }

  Sentry.init({
    dsn: DSN,
    environment: process.env.NODE_ENV || 'development',
    release: `susupay-api@${process.env.npm_package_version || '1.0.0'}`,
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

    // Ignorer les erreurs bénignes
    ignoreErrors: [
      'ECONNRESET',
      'ETIMEDOUT',
    ],
  });

  // Middleware de suivi des requêtes (doit être en premier)
  if (app) {
    app.use(Sentry.expressErrorHandler());
  }
}

/**
 * Capturer manuellement une exception avec contexte
 */
function capturerErreur(error, contexte = {}) {
  if (!DSN) {
    console.error('[Sentry désactivé] Erreur capturée:', error?.message || error, contexte);
    return;
  }
  Sentry.withScope((scope) => {
    Object.entries(contexte).forEach(([key, value]) => {
      scope.setExtra(key, value);
    });
    Sentry.captureException(error);
  });
}

/**
 * Capturer un message d'information / avertissement
 */
function capturerMessage(message, niveau = 'info') {
  if (!DSN) return;
  Sentry.captureMessage(message, niveau);
}

/**
 * Associer un utilisateur à la session Sentry courante (dans un middleware)
 * N'envoyer que l'ID, jamais données sensibles
 */
function setSentryUser(userId) {
  if (!DSN) return;
  Sentry.setUser({ id: userId });
}

module.exports = { initSentry, capturerErreur, capturerMessage, setSentryUser };
