import { describe, expect, test } from "bun:test";
import type { GameData } from "./types";
import {
  selectAppDetailsEntry,
  type SteamAppDetailsResponse,
} from "./steam-appdetails";

function game(steamAppID: number, name: string): GameData {
  return { type: "game", name, steam_appid: steamAppID } as GameData;
}

describe("Steam appdetails entry selection", () => {
  test("matches steam_appid when Steam keys the response by another id", () => {
    const response: SteamAppDetailsResponse = {
      "2855530": { success: true, data: game(1245620, "ELDEN RING") },
    };

    expect(selectAppDetailsEntry(response, 1245620)?.data?.name).toBe(
      "ELDEN RING",
    );
  });

  test("keeps working when the response is keyed by the requested appid", () => {
    const response: SteamAppDetailsResponse = {
      "570": { success: true, data: game(570, "Dota 2") },
    };

    expect(selectAppDetailsEntry(response, 570)?.data?.name).toBe("Dota 2");
  });

  test("prefers the steam_appid match over a key that equals the request", () => {
    const response: SteamAppDetailsResponse = {
      "620": { success: true, data: game(323180, "Other") },
      "999": { success: true, data: game(620, "Portal 2") },
    };

    expect(selectAppDetailsEntry(response, 620)?.data?.name).toBe("Portal 2");
  });

  test("returns the unsuccessful entry for an unknown appid", () => {
    const response: SteamAppDetailsResponse = { "3": { success: false } };

    expect(selectAppDetailsEntry(response, 3)).toEqual({ success: false });
  });

  test("returns undefined for an empty or malformed response", () => {
    expect(selectAppDetailsEntry({}, 570)).toBeUndefined();
    expect(selectAppDetailsEntry(null, 570)).toBeUndefined();
    expect(
      selectAppDetailsEntry(
        {
          "1": { success: true, data: game(1, "A") },
          "2": { success: true, data: game(2, "B") },
        },
        570,
      ),
    ).toBeUndefined();
  });
});
