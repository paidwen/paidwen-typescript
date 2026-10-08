import { readFile } from "node:fs/promises";
import { quiet } from "./context.ts";
import { PaidwenError, RequestError } from "./errors.ts";
import type { Problem, TokenError, TokenExchangeResponse } from "./types.ts";

export type IdentityToken = () => string | Promise<string>;

const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_TYPE = "urn:ietf:params:oauth:token-type:jwt";
const REFRESH_BEFORE_MS = 5 * 60 * 1000;
const EXPIRY_GUARD_MS = 30 * 1000;

export class Unavailable extends Error {
  override name = "Unavailable";
  readonly reason: string | undefined;

  constructor(message: string, reason?: string) {
    super(message);
    this.reason = reason;
  }
}

export interface Credentials {
  readonly federated: boolean;
  authorization(): Promise<string>;
  reject(authorization: string): void;
}

export class KeyCredentials implements Credentials {
  readonly federated = false;
  readonly #authorization: string;

  constructor(apiKey: string) {
    this.#authorization = `Bearer ${apiKey}`;
  }

  authorization(): Promise<string> {
    return Promise.resolve(this.#authorization);
  }

  reject(): void {}
}

export interface FederationOptions {
  identityToken: IdentityToken;
  base: string;
  fetch: typeof fetch;
  timeoutMs: number;
}

export class FederatedCredentials implements Credentials {
  readonly federated = true;
  readonly #options: FederationOptions;
  #token: string | undefined;
  #expiresAt = 0;
  #pending: Promise<void> | undefined;

  constructor(options: FederationOptions) {
    this.#options = options;
  }

  async authorization(): Promise<string> {
    const now = Date.now();
    if (this.#token !== undefined && this.#expiresAt - now > REFRESH_BEFORE_MS) {
      return `Bearer ${this.#token}`;
    }
    if (this.#token !== undefined && this.#expiresAt - now > EXPIRY_GUARD_MS) {
      try {
        await this.#refresh();
      } catch (error) {
        if (!(error instanceof Unavailable)) throw error;
      }
      return `Bearer ${this.#token}`;
    }
    await this.#refresh();
    return `Bearer ${this.#token}`;
  }

  reject(authorization: string): void {
    if (authorization === `Bearer ${this.#token}`) {
      this.#token = undefined;
      this.#expiresAt = 0;
    }
  }

  #refresh(): Promise<void> {
    if (!this.#pending) {
      this.#pending = this.#exchange().finally(() => {
        this.#pending = undefined;
      });
    }
    return this.#pending;
  }

  async #exchange(): Promise<void> {
    const subject = await this.#identityToken();
    const body = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE,
      subject_token: subject,
      subject_token_type: JWT_TYPE,
    });
    const started = Date.now();
    let response: Response;
    try {
      response = await quiet(() =>
        this.#options.fetch(`${this.#options.base}/v1/oauth/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: body.toString(),
          signal: AbortSignal.timeout(this.#options.timeoutMs),
        }),
      );
    } catch (cause) {
      throw new Unavailable("Paidwen did not answer the token exchange", messageOf(cause));
    }
    let answer: unknown;
    try {
      answer = await response.json();
    } catch (cause) {
      throw new Unavailable(
        `Paidwen answered the token exchange with HTTP ${response.status}`,
        messageOf(cause),
      );
    }
    if (response.status >= 500) {
      throw new Unavailable(
        `Paidwen answered the token exchange with HTTP ${response.status}`,
        descriptionOf(answer),
      );
    }
    if (!response.ok) {
      throw new RequestError(response.status, problemOf(response.status, answer));
    }
    const granted = answer as Partial<TokenExchangeResponse>;
    if (typeof granted.access_token !== "string" || typeof granted.expires_in !== "number") {
      throw new Unavailable("Paidwen answered the token exchange without a token");
    }
    this.#token = granted.access_token;
    this.#expiresAt = started + granted.expires_in * 1000;
  }

  async #identityToken(): Promise<string> {
    let value: unknown;
    try {
      value = await this.#options.identityToken();
    } catch (cause) {
      throw new PaidwenError(`Paidwen could not read the identity token: ${messageOf(cause)}`);
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new PaidwenError("The identity token is empty.");
    }
    return value.trim();
  }
}

export function identityTokenFile(path: string): IdentityToken {
  return () => readFile(path, "utf8");
}

function problemOf(status: number, answer: unknown): Problem {
  const error = answer as Partial<TokenError> | undefined;
  const problem: Problem = {
    type: "about:blank",
    title: typeof error?.error === "string" ? error.error : "invalid_request",
    status,
  };
  const description = descriptionOf(answer);
  if (description !== undefined) problem.detail = description;
  return problem;
}

function descriptionOf(answer: unknown): string | undefined {
  const description = (answer as Partial<TokenError> | undefined)?.error_description;
  return typeof description === "string" && description.length > 0 ? description : undefined;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
