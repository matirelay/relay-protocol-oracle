import { config } from "../config";

export const isValidApiKey = (apiKey: unknown): apiKey is string =>
  typeof apiKey === "string" &&
  Boolean(
    config.apiKeys &&
      Object.prototype.hasOwnProperty.call(config.apiKeys, apiKey) &&
      config.apiKeys[apiKey],
  );
