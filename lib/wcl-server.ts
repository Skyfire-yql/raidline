import { createWclClient, type WclClient } from "./wcl-client";

const DEFAULT_TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const DEFAULT_API_URL = "https://www.warcraftlogs.com/api/v2/client";

interface WclBindings {
  WCL_CLIENT_ID?: string;
  WCL_CLIENT_SECRET?: string;
  WCL_TOKEN_URL?: string;
  WCL_API_URL?: string;
}

export class WclConfigurationError extends Error {
  readonly code = "WCL_NOT_CONFIGURED";

  constructor() {
    super("服务端尚未配置 WCL API 凭据");
    this.name = "WclConfigurationError";
  }
}

let singleton: WclClient | null = null;

export function getWclClient() {
  if (singleton) return singleton;
  const local = process.env as WclBindings;
  const clientId = local.WCL_CLIENT_ID;
  const clientSecret = local.WCL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new WclConfigurationError();
  singleton = createWclClient({
    clientId,
    clientSecret,
    tokenUrl: local.WCL_TOKEN_URL ?? DEFAULT_TOKEN_URL,
    apiUrl: local.WCL_API_URL ?? DEFAULT_API_URL,
  });
  return singleton;
}
