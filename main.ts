import OGIAddon, {
  ConfigurationBuilder,
  type BasicLibraryInfo,
  type CatalogCarouselItem,
} from "ogi-addon";
import { join } from "path";
import fs from "fs";
import axios from "axios";
import {
  type GameData,
  type SteamAppInfo,
  type SteamAppInfoResponse,
} from "./lib/types";
import {
  fetchSteamLibraryCapsules,
  resolveSteamAssets,
} from "./lib/steam-assets";
import { searchSteamLibrary } from "./lib/steam-search";
import {
  selectAppDetailsEntry,
  type SteamAppDetailsResponse,
} from "./lib/steam-appdetails";

const addon = new OGIAddon({
  name: "Steam Catalog",
  version: "1.0.0",
  id: "steam-integration",
  author: "OGI Team",
  description: "An addon to integrate Steam store links into OpenGameInstaller",
  repository: "https://github.com/Nat3z/steam-integration",
  storefronts: ["steam"],
});

const CACHE_DIR = join(__dirname, ".cache");
const UPDATE_CACHE_FILE = join(CACHE_DIR, "update-cache.json");
const STEAM_APP_INFO_CACHE_FILE = join(CACHE_DIR, "steam-app-info.json");
const REAL_GAME_CACHE_FILE = join(CACHE_DIR, "real-game.json");
const CATALOG_CACHE_FILE = join(CACHE_DIR, "catalog.json");
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 1 day in milliseconds
/** Per-app Steam update checks: short TTL so new builds are noticed without waiting a day. */
const UPDATE_CACHE_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const CATALOG_CACHE_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours in milliseconds
const CATALOG_CACHE_VERSION = "assets-v2";

const RESTART_APP_FOR_FRESH_DATA =
  "Fully quit and restart OpenGameInstaller to re-check for any game updates or new catalog data.";
let UPDATE_COOLDOWN_MS = 1500; // 1.5 seconds cooldown per game

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Queue system for update checks: appID -> queue of pending requests
type UpdateCheckRequest = {
  appID: number;
  currentVersion: string;
  resolve: (result: { version: string; available: boolean }) => void;
  reject: (error: string) => void;
};

const updateQueues = new Map<number, UpdateCheckRequest[]>();
const queueProcessors = new Map<number, boolean>(); // Track if a queue is being processed

type UpdateCacheEntry = {
  version: string;
  timestamp: number;
};

type UpdateCache = {
  [appID: string]: UpdateCacheEntry;
};

type CacheEntry<T> = {
  data: T;
  timestamp: number;
};

type GenericCache<T> = {
  [key: string]: CacheEntry<T>;
};

function readUpdateCache(): UpdateCache {
  try {
    if (fs.existsSync(UPDATE_CACHE_FILE)) {
      const cacheData = fs.readFileSync(UPDATE_CACHE_FILE, "utf-8");
      return JSON.parse(cacheData);
    }
  } catch (e) {
    console.error("Error reading update cache:", e);
  }
  return {};
}

function writeUpdateCache(cache: UpdateCache): void {
  try {
    fs.writeFileSync(UPDATE_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error("Error writing update cache:", e);
  }
}

function readGenericCache<T>(cacheFile: string): GenericCache<T> {
  try {
    if (fs.existsSync(cacheFile)) {
      const cacheData = fs.readFileSync(cacheFile, "utf-8");
      return JSON.parse(cacheData);
    }
  } catch (e) {
    console.error(`Error reading cache file ${cacheFile}:`, e);
  }
  return {};
}

function writeGenericCache<T>(cacheFile: string, cache: GenericCache<T>): void {
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error(`Error writing cache file ${cacheFile}:`, e);
  }
}

function getCachedData<T>(
  cacheFile: string,
  key: string,
  cacheDuration: number = CACHE_DURATION_MS,
): T | null {
  const cache = readGenericCache<T>(cacheFile);
  const entry = cache[key];

  if (!entry) {
    return null;
  }

  const age = Date.now() - entry.timestamp;
  if (age >= cacheDuration) {
    // Cache expired, remove it
    delete cache[key];
    writeGenericCache(cacheFile, cache);
    return null;
  }

  return entry.data;
}

function setCachedData<T>(cacheFile: string, key: string, data: T): void {
  const cache = readGenericCache<T>(cacheFile);
  cache[key] = {
    data,
    timestamp: Date.now(),
  };
  writeGenericCache(cacheFile, cache);
}

/**
 * Clean up expired entries from a generic cache file
 */
function cleanupGenericCache<T>(
  cacheFile: string,
  cacheDuration: number = CACHE_DURATION_MS,
): number {
  try {
    if (!fs.existsSync(cacheFile)) {
      return 0;
    }

    const cache = readGenericCache<T>(cacheFile);
    const now = Date.now();
    let removedCount = 0;

    // Filter out expired entries
    const cleanedCache: GenericCache<T> = {};
    for (const [key, entry] of Object.entries(cache)) {
      const age = now - entry.timestamp;
      if (age < cacheDuration) {
        cleanedCache[key] = entry;
      } else {
        removedCount++;
      }
    }

    // Only write if something changed
    if (removedCount > 0) {
      writeGenericCache(cacheFile, cleanedCache);
      console.log(
        `Cleaned up ${removedCount} expired entries from ${cacheFile}`,
      );
    }

    return removedCount;
  } catch (e) {
    console.error(`Error cleaning up cache file ${cacheFile}:`, e);
    return 0;
  }
}

/**
 * Clean up expired entries from update cache
 */
function cleanupUpdateCache(): number {
  try {
    if (!fs.existsSync(UPDATE_CACHE_FILE)) {
      return 0;
    }

    const cache = readUpdateCache();
    const now = Date.now();
    let removedCount = 0;

    // Filter out expired entries
    const cleanedCache: UpdateCache = {};
    for (const [appID, entry] of Object.entries(cache)) {
      const age = now - entry.timestamp;
      if (age < UPDATE_CACHE_DURATION_MS) {
        cleanedCache[appID] = entry;
      } else {
        removedCount++;
      }
    }

    // Only write if something changed
    if (removedCount > 0) {
      writeUpdateCache(cleanedCache);
      console.log(
        `Cleaned up ${removedCount} expired entries from update cache`,
      );
    }

    return removedCount;
  } catch (e) {
    console.error("Error cleaning up update cache:", e);
    return 0;
  }
}

/**
 * Clean up all expired cache entries across all cache files
 */
function cleanupAllCaches(): void {
  console.log("Starting cache cleanup...");

  let totalRemoved = 0;

  // Clean up update cache (short TTL — see UPDATE_CACHE_DURATION_MS)
  totalRemoved += cleanupUpdateCache();

  // Clean up Steam app info cache (24 hour expiration)
  totalRemoved += cleanupGenericCache(
    STEAM_APP_INFO_CACHE_FILE,
    CACHE_DURATION_MS,
  );

  // Clean up real game cache (24 hour expiration)
  totalRemoved += cleanupGenericCache(REAL_GAME_CACHE_FILE, CACHE_DURATION_MS);

  // Clean up catalog cache (6 hour expiration)
  totalRemoved += cleanupGenericCache<CatalogSection>(
    CATALOG_CACHE_FILE,
    CATALOG_CACHE_DURATION_MS,
  );

  if (totalRemoved > 0) {
    console.log(
      `Cache cleanup complete: removed ${totalRemoved} expired entries total`,
    );
  } else {
    console.log("Cache cleanup complete: no expired entries found");
  }
}

function getCachedUpdate(appID: number): UpdateCacheEntry | null {
  const cache = readUpdateCache();
  const entry = cache[appID.toString()];

  if (!entry) {
    return null;
  }

  const age = Date.now() - entry.timestamp;
  if (age >= UPDATE_CACHE_DURATION_MS) {
    // Cache expired, remove it
    delete cache[appID.toString()];
    writeUpdateCache(cache);
    return null;
  }

  return entry;
}

function removeCachedUpdate(appID: number): void {
  const cache = readUpdateCache();
  if (!cache[appID.toString()]) {
    return;
  }
  delete cache[appID.toString()];
  writeUpdateCache(cache);
}

function removeCachedGenericKey<T>(cacheFile: string, key: string): void {
  const cache = readGenericCache<T>(cacheFile);
  if (!cache[key]) {
    return;
  }
  delete cache[key];
  writeGenericCache(cacheFile, cache);
}

function setCachedUpdate(appID: number, version: string): void {
  const cache = readUpdateCache();
  cache[appID.toString()] = {
    version,
    timestamp: Date.now(),
  };
  writeUpdateCache(cache);
}

let lastApiCallTime = new Map<number, number>();

async function processUpdateCheck(request: UpdateCheckRequest): Promise<void> {
  const { appID, currentVersion, resolve, reject } = request;

  // Cache check is done in queue processor, so we only get here if cache miss
  // Check if we need to wait for cooldown
  const lastCall = lastApiCallTime.get(appID);
  if (lastCall) {
    const timeSinceLastCall = Date.now() - lastCall;
    if (timeSinceLastCall < UPDATE_COOLDOWN_MS) {
      const waitTime = UPDATE_COOLDOWN_MS - timeSinceLastCall;
      console.log(`Cooldown active for appID ${appID}, waiting ${waitTime}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  // Make API call
  lastApiCallTime.set(appID, Date.now());
  const steamAppInfo = await getSteamAppInfo(appID);

  if (!steamAppInfo) {
    reject("Steam app info not found");
    return;
  }

  const version =
    steamAppInfo.data[appID].common.public_only === undefined
      ? steamAppInfo?.data[appID].depots.branches!["public"].buildid!
      : "1.0";

  // Cache the result
  setCachedUpdate(appID, version);

  resolve({
    version,
    available: version !== currentVersion,
  });
}

async function processUpdateQueue(appID: number): Promise<void> {
  // Mark this queue as being processed
  if (queueProcessors.get(appID)) {
    return; // Already processing
  }

  queueProcessors.set(appID, true);

  try {
    while (true) {
      const queue = updateQueues.get(appID);
      if (!queue || queue.length === 0) {
        break; // Queue is empty, we're done
      }

      // Process the first request in the queue
      const request = queue.shift()!;
      let madeApiCall = false;

      try {
        // Check cache first - if cached, serve immediately without API call
        const cachedUpdate = getCachedUpdate(appID);
        if (cachedUpdate) {
          console.log(
            `Using cached update info for ${appID} (version: ${cachedUpdate.version})`,
          );
          console.log(`Request current version: ${request.currentVersion}`);
          console.log(
            `Request available: ${cachedUpdate.version !== request.currentVersion}`,
          );
          request.resolve({
            version: cachedUpdate.version,
            available: cachedUpdate.version !== request.currentVersion,
          });
          // No API call made, continue to next item immediately
          continue;
        }

        // Cache miss - need to make API call
        madeApiCall = true;
        await processUpdateCheck(request);
      } catch (error) {
        request.reject(typeof error === "string" ? error : "Unknown error");
      }

      // Only wait for cooldown if we made an API call and there are more requests
      if (madeApiCall && queue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, UPDATE_COOLDOWN_MS));
      }
    }
  } finally {
    // Clean up
    queueProcessors.delete(appID);
    updateQueues.delete(appID);
  }
}

function queueUpdateCheck(
  appID: number,
  currentVersion: string,
): Promise<{ version: string; available: boolean }> {
  return new Promise((resolve, reject) => {
    // Add request to queue
    if (!updateQueues.has(appID)) {
      updateQueues.set(appID, []);
    }

    updateQueues.get(appID)!.push({
      appID,
      currentVersion,
      resolve,
      reject,
    });

    // Start processing if not already processing
    processUpdateQueue(appID).catch((error) => {
      console.error(`Error processing update queue for ${appID}:`, error);
    });
  });
}

// store it in filesystem cache if cached is true
async function getSteamAppInfo(
  appID: number,
  cached?: boolean,
): Promise<SteamAppInfoResponse | undefined> {
  try {
    if (cached) {
      const cachedData = getCachedData<SteamAppInfoResponse>(
        STEAM_APP_INFO_CACHE_FILE,
        appID.toString(),
      );
      if (cachedData) {
        console.log(`Using cached Steam app info for ${appID}`);
        return cachedData;
      }
    }
    const response = await axios<SteamAppInfoResponse>({
      url: `https://api.steamcmd.net/v1/info/${appID}`,
      headers: {
        "User-Agent": "OGI Steam-Integration/1.0.0",
      },
    });
    if (cached) {
      setCachedData(STEAM_APP_INFO_CACHE_FILE, appID.toString(), response.data);
      console.log(`Cached Steam app info for ${appID}`);
    }
    return response.data;
  } catch (e) {
    console.error(e);
    return undefined;
  }
}

async function getRealGame(
  titleId: number,
  cached?: boolean,
): Promise<GameData | undefined> {
  if (cached) {
    const cachedData = getCachedData<GameData>(
      REAL_GAME_CACHE_FILE,
      titleId.toString(),
    );
    if (cachedData) {
      console.log(`Using cached game data for ${titleId}`);
      return cachedData;
    }
  }
  // Add delay to prevent rate limiting
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    const response = await axios<SteamAppDetailsResponse>({
      method: "GET",
      url: `https://store.steampowered.com/api/appdetails?appids=${titleId}&cc=us`,
    });
    const entry = selectAppDetailsEntry(response.data, titleId);
    if (!entry?.success || !entry.data) {
      return undefined;
    }
    if (entry.data.type === "game") {
      if (cached) {
        setCachedData(REAL_GAME_CACHE_FILE, titleId.toString(), entry.data);
        console.log(`Cached game data for ${titleId}`);
      }
      return entry.data;
    }

    return undefined;
  } catch (e) {
    console.error(e);
    return undefined;
  }
}

addon.onTask("forceNewUpdate", async (task, data) => {
  // check os version to know where ogi is located
  const os = process.platform;
  let ogiPath = "";
  if (os === "win32") {
    ogiPath = join(
      process.env.LOCALAPPDATA!,
      "Programs",
      "ogi-updater",
      "update",
    );
  } else if (os === "linux") {
    ogiPath = join(process.env.HOME!, ".local", "share", "OpenGameInstaller");
  }

  if (ogiPath === "") {
    task.fail("Failed to find OGI updater");
    return;
  }

  const libraryPath = join(
    ogiPath,
    "library",
    data.libraryInfo.appID + ".json",
  );
  if (!fs.existsSync(libraryPath)) {
    task.fail("Library file not found");
    return;
  }
  const library = JSON.parse(fs.readFileSync(libraryPath, "utf8"));
  // set the library version to a known won't work version
  library.version = "9999.9999.9999";
  fs.writeFileSync(libraryPath, JSON.stringify(library, null, 2));

  const steamAppID = data.libraryInfo.appID;
  task.log(`Clearing cached update and store data for app ${steamAppID}`);
  clearCachesForSteamApp(steamAppID);

  await task.askForInput(
    "Force new update",
    `Library entry was bumped and caches for this game were cleared. ${RESTART_APP_FOR_FRESH_DATA}`,
    new ConfigurationBuilder(),
  );
  task.complete();
});

addon.on("search", ({ storefront, appID, for: forType }, event) => {
  if (forType !== "task") {
    event.resolve([]);
    return;
  }

  // return a task that forces a check for update
  event.resolve([
    {
      taskName: "forceNewUpdate",
      name: "Force New Update",
      downloadType: "task" as const,
    },
  ]);
});

addon.on("configure", (config) =>
  config
    .addNumberOption((option) =>
      option
        .setName("steam-limit")
        .setDisplayName("Steam Search Limit")
        .setDescription(
          "The amount of steam apps that can be searched for at once. More results means more time to search.",
        )
        .setMin(1)
        .setMax(100)
        .setDefaultValue(5)
        .setInputType("range"),
    )
    .addNumberOption((option) =>
      option
        .setName("update-cooldown")
        .setDisplayName("Update Cooldown")
        .setDescription(
          "The amount of time in seconds to wait between game checks.",
        )
        .setMin(1)
        .setMax(10)
        .setDefaultValue(1)
        .setInputType("range"),
    )
    .addActionOption((action) =>
      action
        .setName("checkForUpdates")
        .setDisplayName("Delete Cached Checks for Updates")
        .setDescription("Clears all cached checks for updates.")
        .setTaskName("checkForUpdates"),
    )
    .addActionOption((action) =>
      action
        .setName("clearAllCaches")
        .setDisplayName("Clear All Caches")
        .setDescription(
          "Clears all cached data (updates, games, app info, catalog).",
        )
        .setTaskName("clearAllCaches"),
    )
    .addActionOption((action) =>
      action
        .setName("cleanupExpiredCaches")
        .setDisplayName("Clean Up Expired Caches")
        .setDescription(
          "Removes only expired cache entries based on their expiration time.",
        )
        .setTaskName("cleanupExpiredCaches"),
    ),
);

addon.onTask("checkForUpdates", async (task) => {
  task.log("Checking for game updates");
  updateQueues.clear();
  lastApiCallTime.clear();

  // clear the update cache
  fs.writeFileSync(UPDATE_CACHE_FILE, JSON.stringify({}, null, 2));
  await task.askForInput(
    "All Cached Updates Cleared",
    `All checks for updates have been cleared. ${RESTART_APP_FOR_FRESH_DATA}`,
    new ConfigurationBuilder(),
  );
  task.complete();
});

addon.onTask("clearAllCaches", async (task) => {
  task.log("Clearing all caches");
  updateQueues.clear();
  lastApiCallTime.clear();

  // Clear all cache files
  const cacheFiles = [
    UPDATE_CACHE_FILE,
    STEAM_APP_INFO_CACHE_FILE,
    REAL_GAME_CACHE_FILE,
    CATALOG_CACHE_FILE,
    RESOLVED_10_FILE_VERSIONS_FILE,
  ];

  for (const cacheFile of cacheFiles) {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify({}, null, 2));
      task.log(`Cleared ${cacheFile}`);
    } catch (e) {
      task.log(`Failed to clear ${cacheFile}: ${e}`);
    }
  }

  // Clear the in-memory resolved versions cache as well
  resolved10FileVersions = {};

  await task.askForInput(
    "All Caches Cleared",
    `All cached data has been cleared. ${RESTART_APP_FOR_FRESH_DATA}`,
    new ConfigurationBuilder(),
  );
  task.complete();
});

addon.onTask("cleanupExpiredCaches", async (task) => {
  task.log("Cleaning up expired cache entries");

  // Run the cleanup
  cleanupAllCaches();

  await task.askForInput(
    "Expired Caches Cleaned",
    "All expired cache entries have been removed. Valid cache entries are still preserved.",
    new ConfigurationBuilder(),
  );
  task.complete();
});

// Cache cleanup interval (runs every hour)
const CACHE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let cacheCleanupInterval: NodeJS.Timeout | null = null;

addon.on("connect", async () => {
  console.log("Steam integration connected");

  // run a network check
  void new Promise(async (res, rej) => {
    axios.get("https://google.com", { timeout: 2000 }).catch(rej).then(res);
  }).catch(() => {
    console.error("failed network check");
    addon.notify({
      id: "steam-integration-failed",
      message: "steam-integration: Network check failed, stopping addon.",
      type: "error",
    });
    process.exit(1);
  });

  UPDATE_COOLDOWN_MS = addon.config.getNumberValue("update-cooldown") * 1000;
  console.log("Update cooldown set to " + UPDATE_COOLDOWN_MS + "ms");

  // Run initial cache cleanup on startup
  cleanupAllCaches();

  // Set up periodic cache cleanup (runs every hour)
  if (cacheCleanupInterval) {
    clearInterval(cacheCleanupInterval);
  }
  cacheCleanupInterval = setInterval(() => {
    cleanupAllCaches();
  }, CACHE_CLEANUP_INTERVAL_MS);
  console.log(
    `Cache cleanup scheduled to run every ${CACHE_CLEANUP_INTERVAL_MS / 1000 / 60} minutes`,
  );
});

addon.on("library-search", (query, event) => {
  event.defer(async () => {
    try {
      event.resolve(await searchSteamLibrary(query));
    } catch (e) {
      event.fail("Failed to search Steam");
      return;
    }
  });
});

addon.on("game-details", ({ appID, storefront }, event) => {
  event.defer(async () => {
    const realGame = await getRealGame(appID);
    if (realGame) {
      const steamAppInfo = await getSteamAppInfo(realGame.steam_appid);
      if (!steamAppInfo) {
        event.fail("Steam app info not found");
        console.error("Steam app info not found for " + realGame.steam_appid);
        return;
      }
      if (!steamAppInfo.data[realGame.steam_appid]) {
        event.fail("Steam app info not found");
        console.error("Steam app info not found for " + realGame.steam_appid);
        return;
      }

      const steamAssets = resolveSteamAssets(
        realGame.steam_appid,
        steamAppInfo.data[realGame.steam_appid].common,
      );
      const capsuleImage =
        steamAssets.capsuleImage ??
        realGame.capsule_imagev5 ??
        realGame.capsule_image ??
        realGame.header_image;
      const headerImage = steamAssets.headerImage ?? realGame.header_image;
      const coverImage = steamAssets.heroImage ?? headerImage;
      console.log(
        appID,
        "is public only?",
        steamAppInfo.data[realGame.steam_appid].common.public_only === "1"
          ? "yes"
          : "no",
      );

      event.resolve({
        appID: realGame.steam_appid,
        name: realGame.name,
        capsuleImage,
        headerImage,
        publishers: realGame.publishers,
        developers: realGame.developers,
        releaseDate: realGame.release_date.date,
        coverImage,
        basicDescription: realGame.short_description,
        description: realGame.detailed_description,
        latestVersion:
          steamAppInfo.data[realGame.steam_appid].depots !== undefined
            ? steamAppInfo?.data[realGame.steam_appid].depots.branches![
                "public"
              ].buildid!
            : "1.0",
      });
      return;
    }
    event.fail("Game not found");
  });
});

function extractApps(
  items: { name: string; logo: string }[],
): BasicLibraryInfo[] {
  return items
    .map((item) => {
      const match = item.logo.match(/apps\/(\d+)/);
      if (!match) {
        return null;
      }
      const appID = parseInt(match[1]);
      return {
        name: item.name,
        capsuleImage: item.logo,
        appID: appID,
        storefront: "steam",
      };
    })
    .filter((app) => app !== null);
}

type SteamResult = {
  desc: string;
  items: {
    name: string;
    logo: string;
  }[];
};

type CatalogSection = {
  key: string;
  name: string;
  description: string;
  listings: BasicLibraryInfo[];
};

async function fetchSteamCatalogByTag(
  tag: number,
  key: string,
  name: string,
  description: string,
): Promise<CatalogSection> {
  const cacheKey = `${CATALOG_CACHE_VERSION}:${key}`;
  // Check cache first
  const cachedSection = getCachedData<CatalogSection>(
    CATALOG_CACHE_FILE,
    cacheKey,
    CATALOG_CACHE_DURATION_MS,
  );
  if (cachedSection) {
    console.log(`Using cached catalog section: ${key}`);
    return cachedSection;
  }

  const response = await axios<SteamResult>(
    `https://store.steampowered.com/search/results/?filter=globaltopsellers&ignore_preferences=1&json=1&hidef2p=1&category1=998&tags=${tag}`,
    {
      headers: {
        "User-Agent": "OGI Steam-Integration/1.0.0",
      },
    },
  );
  const section: CatalogSection = {
    key,
    name,
    description,
    listings: extractApps(response.data.items),
  };

  // Cache the result
  setCachedData(CATALOG_CACHE_FILE, cacheKey, section);
  console.log(`Cached catalog section: ${key}`);

  return section;
}

async function fetchSteamCatalogByCategory(
  category: number,
  key: string,
  name: string,
  description: string,
): Promise<CatalogSection> {
  const cacheKey = `${CATALOG_CACHE_VERSION}:${key}`;
  // Check cache first
  const cachedSection = getCachedData<CatalogSection>(
    CATALOG_CACHE_FILE,
    cacheKey,
    CATALOG_CACHE_DURATION_MS,
  );
  if (cachedSection) {
    console.log(`Using cached catalog section: ${key}`);
    return cachedSection;
  }

  const response = await axios<SteamResult>(
    `https://store.steampowered.com/search/results/?filter=globaltopsellers&ignore_preferences=1&json=1&hidef2p=1&category1=998&category2=${category}`,
    {
      headers: {
        "User-Agent": "OGI Steam-Integration/1.0.0",
      },
    },
  );
  const section: CatalogSection = {
    key,
    name,
    description,
    listings: extractApps(response.data.items),
  };

  // Cache the result
  setCachedData(CATALOG_CACHE_FILE, cacheKey, section);
  console.log(`Cached catalog section: ${key}`);

  return section;
}

async function fetchSteamCatalog(
  filters: string,
  key: string,
  name: string,
  description: string,
): Promise<CatalogSection> {
  const cacheKey = `${CATALOG_CACHE_VERSION}:${key}`;
  // Check cache first
  const cachedSection = getCachedData<CatalogSection>(
    CATALOG_CACHE_FILE,
    cacheKey,
    CATALOG_CACHE_DURATION_MS,
  );
  if (cachedSection) {
    console.log(`Using cached catalog section: ${key}`);
    return cachedSection;
  }

  const response = await axios<SteamResult>(
    `https://store.steampowered.com/search/results/?filter=globaltopsellers&ignore_preferences=1&json=1&hidef2p=1&category1=998&${filters}`,
    {
      headers: {
        "User-Agent": "OGI Steam-Integration/1.0.0",
      },
    },
  );
  const section: CatalogSection = {
    key,
    name,
    description,
    listings: extractApps(response.data.items),
  };

  // Cache the result
  setCachedData(CATALOG_CACHE_FILE, cacheKey, section);
  console.log(`Cached catalog section: ${key}`);

  return section;
}

addon.on("catalog", (event) => {
  event.defer(async () => {
    const promises = await Promise.allSettled([
      // -- Top Sellers --
      fetchSteamCatalog(
        "",
        "top-sellers",
        "Top Sellers",
        "The best selling games on Steam",
      ),
      // -- Roguelike --
      fetchSteamCatalogByTag(
        1716,
        "roguelike",
        "Roguelike",
        "Top Roguelike games on Steam",
      ),
      // -- JRPGs --
      fetchSteamCatalogByTag(4434, "jrpg", "JRPG", "Top JRPG games on Steam"),
      // -- Multiplayer --
      fetchSteamCatalogByCategory(
        1,
        "multiplayer",
        "Multiplayer",
        "Top multiplayer games on Steam",
      ),
      // -- Co-op --
      fetchSteamCatalogByCategory(
        9,
        "coop",
        "Co-op",
        "Top co-op games on Steam",
      ),
      // -- Single-player --
      fetchSteamCatalogByCategory(
        2,
        "singleplayer",
        "Single-player",
        "Top single-player games on Steam",
      ),
      // -- VR Support --
      fetchSteamCatalogByCategory(
        31,
        "vr",
        "VR Support",
        "Top VR games on Steam",
      ),
      // -- Full Controller Support --
      fetchSteamCatalogByCategory(
        28,
        "controller",
        "Full Controller Support",
        "Top games with full controller support",
      ),
      // -- PvP --
      fetchSteamCatalogByCategory(49, "pvp", "PvP", "Top PvP games on Steam"),
      // -- Remote Play Together --
      fetchSteamCatalogByCategory(
        44,
        "remote-play",
        "Remote Play Together",
        "Games that support Remote Play Together",
      ),
    ]);

    // Filter out rejected promises and extract successful results
    const sections = promises
      .filter(
        (promise): promise is PromiseFulfilledResult<CatalogSection> =>
          promise.status === "fulfilled",
      )
      .map((promise) => promise.value);

    const libraryCapsules = await fetchSteamLibraryCapsules(
      sections.flatMap((section): number[] =>
        section.listings.map((listing): number => listing.appID),
      ),
    );
    for (const section of sections) {
      section.listings = section.listings.map(
        (listing): BasicLibraryInfo => ({
          ...listing,
          capsuleImage:
            libraryCapsules.get(listing.appID) ?? listing.capsuleImage,
        }),
      );
    }

    // Build catalog results
    const catalogResults: Parameters<typeof event.resolve>[0]["sections"] = {};
    for (const section of sections) {
      catalogResults[section.key] = {
        name: section.name,
        description: section.description,
        listings: section.listings,
      };
    }

    // Build featured carousel from top 2 of each section
    const carouselItems: Record<string, CatalogCarouselItem> = {};
    for (const section of sections) {
      for (const listing of section.listings.slice(0, 2)) {
        const realGame = await getRealGame(listing.appID, true);
        if (!realGame) {
          continue;
        }
        // get the steam api info for the game
        const steamAppInfo = await getSteamAppInfo(listing.appID, true);
        if (!steamAppInfo || !steamAppInfo.data[listing.appID]) {
          continue;
        }
        const steamAssets = resolveSteamAssets(
          listing.appID,
          steamAppInfo.data[listing.appID].common,
        );
        const carouselImage =
          steamAssets.headerImage ??
          realGame.header_image ??
          listing.capsuleImage;
        carouselItems[listing.appID] = {
          ...listing,
          description: realGame.short_description,
          carouselImage,
          fullBannerImage: steamAssets.heroImage ?? carouselImage,
        };
      }
    }

    event.resolve({
      sections: catalogResults,
      carousel: carouselItems,
    });
  });
});

let req = 0;
addon.on(
  "check-for-updates",
  ({ appID, storefront, currentVersion }, event) => {
    req++;
    console.log("Checking for updates for " + appID + " (" + req + ")");
    event.defer(async () => {
      // Check cache first - return immediately if cached
      // handle resolving 1.0 file versions with auto resolution
      if (currentVersion === "1.0" || currentVersion === "1.0.0") {
        // assume that the current version is the latest version as stored by the resolver
        currentVersion = await resolve10FileVersion(appID);
        console.log(
          "Resolved 1.0 file version for " +
            appID +
            " to " +
            currentVersion +
            " (" +
            req +
            ")",
        );
      }

      // if the update is already cached, return the result immediately
      const cachedUpdate = getCachedUpdate(appID);
      if (cachedUpdate) {
        event.resolve({
          version: cachedUpdate.version,
          available: cachedUpdate.version !== currentVersion,
        });
        return;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, UPDATE_COOLDOWN_MS * req),
      );

      // Cache miss - queue the request for API call and return the result
      const result = await queueUpdateCheck(appID, currentVersion);
      event.resolve(result);
    });
  },
);

addon.on("disconnect", () => {
  // Clean up the cache cleanup interval
  if (cacheCleanupInterval) {
    clearInterval(cacheCleanupInterval);
    cacheCleanupInterval = null;
  }
  process.exit(0);
});

// 1.0 file version auto resolution
type Resolved10FileVersions = {
  [appID: number]: string;
};

const RESOLVED_10_FILE_VERSIONS_FILE = join(
  CACHE_DIR,
  "resolved10FileVersions.json",
);
let resolved10FileVersions: Resolved10FileVersions = {};
if (fs.existsSync(RESOLVED_10_FILE_VERSIONS_FILE)) {
  resolved10FileVersions = JSON.parse(
    fs.readFileSync(RESOLVED_10_FILE_VERSIONS_FILE, "utf-8"),
  );
}

function clearCachesForSteamApp(appID: number): void {
  removeCachedUpdate(appID);
  removeCachedGenericKey<SteamAppInfoResponse>(
    STEAM_APP_INFO_CACHE_FILE,
    appID.toString(),
  );
  removeCachedGenericKey<GameData>(REAL_GAME_CACHE_FILE, appID.toString());
  if (resolved10FileVersions[appID]) {
    delete resolved10FileVersions[appID];
    fs.writeFileSync(
      RESOLVED_10_FILE_VERSIONS_FILE,
      JSON.stringify(resolved10FileVersions, null, 2),
    );
  }
  lastApiCallTime.delete(appID);
}

async function resolve10FileVersion(appID: number) {
  if (resolved10FileVersions[appID]) {
    return resolved10FileVersions[appID];
  }
  const steamAppInfo = await getSteamAppInfo(appID);
  if (!steamAppInfo) {
    return "1.0";
  }

  // get the current version and assume that our version is the latest as to prevent issues where all games are outdated.
  // this functionality will be removed in the future.
  const version =
    steamAppInfo.data[appID].common.public_only === undefined
      ? steamAppInfo?.data[appID].depots.branches!["public"].buildid!
      : "1.0";
  resolved10FileVersions[appID] = version;
  fs.writeFileSync(
    RESOLVED_10_FILE_VERSIONS_FILE,
    JSON.stringify(resolved10FileVersions, null, 2),
  );
  return version;
}
