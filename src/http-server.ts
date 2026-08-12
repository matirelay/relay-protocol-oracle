import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, { FastifyInstance } from "fastify";

import { setupEndpoints } from "./api";
import { isValidApiKey } from "./common/api-key";
import { logger } from "./common/logger";
import { createFixedWindowRateLimiter } from "./common/rate-limit";
import { config } from "./config";
import { createEventAttestationMonitor } from "./services/attestation/event";
import { getSigningWallet } from "./signers";

const COMPONENT = "http-server";

// Setup swagger
const setupSwagger = async (httpServer: FastifyInstance) => {
  await httpServer.register(fastifySwagger, {
    mode: "dynamic",
    openapi: {
      info: {
        title: "Relay Protocol Oracle API",
        version: "v1",
      },
    },
  });
  await httpServer.register(fastifySwaggerUi, {
    routePrefix: "/documentation",
    uiConfig: {
      docExpansion: "full",
      deepLinking: false,
    },
    uiHooks: {
      onRequest: function (_request, _reply, next) {
        next();
      },
      preHandler: function (_request, _reply, next) {
        next();
      },
    },
    staticCSP: true,
    transformStaticCSP: (header) => header,
    transformSpecification: (swaggerObject, _request, _reply) => {
      return swaggerObject;
    },
    transformSpecificationClone: true,
  });
};

export const buildHttpServer = async () => {
  const httpServer = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  const unauthenticatedRateLimiter = createFixedWindowRateLimiter({
    max: config.unauthenticatedRateLimitMax,
    windowMs: config.unauthenticatedRateLimitWindowMs,
  });

  await setupSwagger(httpServer);

  // Setup unauthenticated rate limiting
  httpServer.addHook("preHandler", (req, reply, done) => {
    // Skip these routes
    if (
      req.url === "/" ||
      req.url.startsWith("/documentation") ||
      req.url.startsWith("/lives")
    ) {
      return done();
    }

    const apiKey = req.headers["x-api-key"];

    if (!isValidApiKey(apiKey)) {
      const rateLimit = unauthenticatedRateLimiter.check(req.ip);
      const retryAfterSeconds = Math.ceil(rateLimit.resetMs / 1000);

      reply
        .header("x-ratelimit-limit", rateLimit.limit)
        .header("x-ratelimit-remaining", rateLimit.remaining)
        .header("x-ratelimit-reset", retryAfterSeconds);

      if (!rateLimit.allowed) {
        return reply
          .code(429)
          .header("retry-after", retryAfterSeconds)
          .send({ error: "Rate limit exceeded" });
      }
    }

    return done();
  });

  // Setup endpoints
  setupEndpoints(httpServer);

  return httpServer;
};

export const validateLocalOracleSigner = (signerAddress: string): void => {
  const normalizedSignerAddress = signerAddress.toLowerCase();
  if (
    config.oracleSigners &&
    !config.oracleSigners.has(normalizedSignerAddress)
  ) {
    throw new Error(
      `Local oracle signer ${normalizedSignerAddress} is not included in ORACLE_SIGNERS`,
    );
  }
};

export const startHttpServer = async () => {
  const signer = await getSigningWallet();
  const signerAddress = signer.address.toLowerCase();
  validateLocalOracleSigner(signerAddress);

  const httpServer = await buildHttpServer();
  const eventAttestationMonitor = createEventAttestationMonitor();
  httpServer.addHook("onClose", async () => {
    await eventAttestationMonitor.stop();
  });
  await httpServer.listen({
    host: "0.0.0.0",
    port: config.httpPort,
  });

  logger.info(
    COMPONENT,
    JSON.stringify({
      msg: "Http server started",
      signer: signerAddress,
    }),
  );
  eventAttestationMonitor.start();

  return httpServer;
};
