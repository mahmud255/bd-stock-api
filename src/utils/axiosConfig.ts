import axios from "axios";
import axiosRetry from "axios-retry";
import { ApiConfig, config } from "../env";
export function createUpstreamClient(settings: ApiConfig = config) {
  const client = axios.create({
    baseURL: settings.dseBaseUrl, timeout: settings.timeoutMs, maxRedirects: 0,
    maxContentLength: 4 * 1024 * 1024,
    headers: { Accept: "application/json, text/html", "User-Agent": "BD-Stock-API/1.1" },
  });
  axiosRetry(client, {
    retries: 1, shouldResetTimeout: true, retryDelay: () => 250,
    retryCondition: error => ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET"].includes(error.code || "") ||
      (!!error.response && [429, 502, 503, 504].includes(error.response.status)),
  });
  return client;
}
