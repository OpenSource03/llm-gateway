import Logger from "../../config/logger";

import { expectJson, fetchWithTimeout, isRecord } from "./shared";

/**
 * Newest Codex release whose wire contract this adapter was checked against.
 * Raise it after reviewing a Codex release; it is also the fallback version.
 */
export const REVIEWED_CODEX_CLIENT_VERSION = "0.157.0";

// OpenAI filters the Codex model catalog by the client version, so a stale
// version hides new models. The npm "latest" tag is the newest stable release.
const LATEST_RELEASE_URL = "https://registry.npmjs.org/@openai/codex/latest";
const REFRESH_MS = 6 * 60 * 60_000;
const RETRY_MS = 15 * 60_000;
const LOOKUP_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const SEMVER = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

export interface CodexClientVersionSource {
  /**
   * The version for a provider request. Waits only for this process's first
   * lookup; afterwards returns at once and refreshes in the background when
   * due, so every process follows new releases.
   */
  forRequest(): Promise<string>;
  /** Looks up the newest release when due, then returns the current version. */
  refresh(): Promise<string>;
  /**
   * Adopt a version another process already used, for example the one that
   * discovered the requested model. Follows the same rules as a lookup.
   */
  observe(version: string): void;
}

const parseVersion = (value: string): [number, number, number] | null => {
  const match = SEMVER.exec(value);

  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

/**
 * Follow a newer release of the reviewed major version. A lower, malformed or
 * new-major candidate keeps the current version: a major release may change
 * the wire contract this adapter reconstructs, and going back could hide
 * models already published for the newer client.
 */
export const acceptedCodexClientVersion = (
  reviewed: string,
  current: string,
  candidate: string,
): string => {
  const major = parseVersion(reviewed)?.[0];
  const active = parseVersion(current);
  const latest = parseVersion(candidate);

  if (major === undefined || !active || !latest || latest[0] !== major) {
    return current;
  }
  const newer =
    latest[0] > active[0] ||
    (latest[0] === active[0] &&
      (latest[1] > active[1] ||
        (latest[1] === active[1] && latest[2] > active[2])));

  return newer ? candidate : current;
};

export const fixedCodexClientVersion = (
  version: string,
): CodexClientVersionSource => ({
  forRequest: async () => version,
  refresh: async () => version,
  observe: () => undefined,
});

/**
 * `setting` is "auto" to follow the newest stable Codex release, or an exact
 * version to pin one.
 */
export const createCodexClientVersionSource = (options: {
  fetch: typeof fetch;
  now: () => number;
  setting: string;
  reviewed?: string;
}): CodexClientVersionSource => {
  const reviewed = options.reviewed ?? REVIEWED_CODEX_CLIENT_VERSION;

  if (options.setting !== "auto") {
    return fixedCodexClientVersion(options.setting);
  }
  let version = reviewed;
  let lookedUp = false;
  let nextLookupAt = 0;
  let inFlight: Promise<string> | null = null;

  const adopt = (candidate: string): void => {
    const next = acceptedCodexClientVersion(reviewed, version, candidate);

    if (next !== version) {
      Logger.info("Codex client version updated", { from: version, to: next });
    }
    version = next;
  };

  const lookup = async (): Promise<string> => {
    try {
      // No caller signal: one caller's cancellation must not fail the shared lookup.
      const response = await fetchWithTimeout(
        options.fetch,
        LATEST_RELEASE_URL,
        { method: "GET", headers: { Accept: "application/json" } },
        LOOKUP_TIMEOUT_MS,
      );
      const payload = await expectJson(
        response,
        "Codex release lookup",
        MAX_RESPONSE_BYTES,
      );
      const latest =
        isRecord(payload) && typeof payload.version === "string"
          ? payload.version
          : "";

      if (!parseVersion(latest)) throw new Error("Malformed Codex release");
      adopt(latest);
      nextLookupAt = options.now() + REFRESH_MS;
    } catch {
      Logger.warn("Codex release lookup failed", { keeping: version });
      nextLookupAt = options.now() + RETRY_MS;
    }
    lookedUp = true;

    return version;
  };

  const refresh = (): Promise<string> => {
    if (options.now() < nextLookupAt) return Promise.resolve(version);
    inFlight ??= lookup().finally(() => {
      inFlight = null;
    });

    return inFlight;
  };

  return {
    forRequest() {
      if (!lookedUp) return refresh();
      // lookup() never rejects, so the background refresh cannot go unhandled.
      void refresh();

      return Promise.resolve(version);
    },
    refresh,
    observe(candidate) {
      if (parseVersion(candidate)) adopt(candidate);
    },
  };
};
