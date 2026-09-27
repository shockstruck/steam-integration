import type { GameData } from "./types";

export type SteamAppDetailsEntry = {
  success: boolean;
  data?: GameData;
};

export type SteamAppDetailsResponse = Record<string, SteamAppDetailsEntry>;

/**
 * Steam's appdetails endpoint no longer reliably keys its response by the
 * requested appid, so match on `data.steam_appid` first. Unknown appids still
 * come back keyed by the request with `success: false`.
 */
export function selectAppDetailsEntry(
  response: SteamAppDetailsResponse | null | undefined,
  appID: number | string,
): SteamAppDetailsEntry | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }

  const requested = Number(appID);
  const entries = Object.values(response);
  const matched = entries.find(
    (entry) => entry?.data?.steam_appid === requested,
  );
  if (matched) {
    return matched;
  }

  const keyed = response[String(appID)];
  if (keyed) {
    return keyed;
  }

  return entries.length === 1 ? entries[0] : undefined;
}
