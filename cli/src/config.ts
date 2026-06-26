// Public Firebase web config (same values used by the app frontend)
export const FIREBASE_WEB_API_KEY = 'AIzaSyA2PBi9b1fyxYnFXPiHl0Bl31ZHyBnhGpA'
export const FIREBASE_PROJECT_ID = 'simular-note'

// Google OAuth Desktop client — registered in GCP project simular-note.
// redirect_uri is http://127.0.0.1:{port}/callback (loopback).
export const GOOGLE_CLIENT_ID =
  '149671192594-1f72q63a82l2q8fmc15glqh9m6vl295h.apps.googleusercontent.com'
// Non-confidential for Desktop (installed app) clients — distributed with the binary.
export const GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_DESKTOP_CLIENT_SECRET ?? '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'

// Cloud API base URL — override via SAPI_API_URL env var
export const CLOUD_API_URL =
  process.env.SAPI_API_URL ?? 'https://simular-cloud-api-staging-149671192594.us-central1.run.app'

// Hosted web app origin — used as the OAuth redirect_uri base.
// Must match what is registered in the Google OAuth client.
// Override via SAPI_APP_ORIGIN if pointing at a custom web build.
export const APP_ORIGIN = process.env.SAPI_APP_ORIGIN ?? 'https://staging.sai.simular.cloud'

export const DEFAULT_SESSION_TIMEOUT_MS = 72 * 60 * 60 * 1000 // 72 hours
// How much to extend the session when auto-refreshing the Firebase ID token
export const REFRESH_EXTENSION_MS = 24 * 60 * 60 * 1000 // 24 hours
export const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
