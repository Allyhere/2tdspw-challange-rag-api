import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

import { config } from "./config.js";

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function firebaseAuth() {
  if (
    !config.firebase.projectId ||
    !config.firebase.clientEmail ||
    !config.firebase.privateKey
  ) {
    throw httpError(503, "Firebase Admin não configurado");
  }
  const app =
    getApps()[0] ??
    initializeApp({
      credential: cert({
        projectId: config.firebase.projectId,
        clientEmail: config.firebase.clientEmail,
        privateKey: config.firebase.privateKey,
      }),
    });
  return getAuth(app);
}

export function actorFromClaims(claims) {
  const provider = claims.firebase?.sign_in_provider;
  if (provider === "phone" && claims.phone_number) {
    return {
      uid: claims.uid,
      role: "owner",
      phone: claims.phone_number,
    };
  }
  if (claims.email && (provider === "password" || provider === "emailLink")) {
    return {
      uid: claims.uid,
      role: "vet",
      email: claims.email,
    };
  }
  throw httpError(403, "Método de autenticação não autorizado");
}

function bearerToken(header) {
  const match = String(header ?? "").match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

export function createFirebaseIdentityService({ auth } = {}) {
  const getFirebaseAuth = () => auth ?? firebaseAuth();

  return {
    async authenticateRequest(req) {
      const token = bearerToken(req.headers.authorization);
      if (!token) throw httpError(401, "Token Firebase obrigatório");
      try {
        const claims = await getFirebaseAuth().verifyIdToken(token, true);
        return actorFromClaims(claims);
      } catch (error) {
        if (error.status) throw error;
        throw httpError(401, "Token Firebase inválido ou expirado");
      }
    },

    async resolveOwnerByPhone(phone) {
      try {
        const user = await getFirebaseAuth().getUserByPhoneNumber(phone);
        if (!user.phoneNumber) {
          throw httpError(404, "Tutor não cadastrado no Firebase");
        }
        return {
          uid: user.uid,
          phone: user.phoneNumber,
          name: user.displayName || null,
        };
      } catch (error) {
        if (error.status) throw error;
        if (error.code === "auth/user-not-found") {
          throw httpError(404, "Tutor não cadastrado no Firebase");
        }
        throw httpError(502, "Falha ao consultar o tutor no Firebase");
      }
    },
  };
}

export function createAuthMiddleware(identityService) {
  return async function authenticate(req, res, next) {
    try {
      req.actor = await identityService.authenticateRequest(req);
      next();
    } catch (error) {
      res.status(error.status || 401).json({ message: error.message });
    }
  };
}
